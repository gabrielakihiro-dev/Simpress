"""Download vazio, aviso de download perdido e janela pequena, sem navegador nem dados operacionais."""

import io
import json
import os
import shutil
import tempfile
import time
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from scripts import automacao_rotinas_chrome as automacao
from scripts import prepare_inventory_downloads, prepare_ticket_downloads


def bytes_zip() -> bytes:
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w") as arquivo:
        arquivo.writestr("conteudo.txt", "ok")
    return saida.getvalue()


def bytes_xlsx() -> bytes:
    from openpyxl import Workbook

    saida = io.BytesIO()
    Workbook().save(saida)
    return saida.getvalue()


def bytes_zip_com_xlsx() -> bytes:
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w") as arquivo:
        arquivo.writestr("EquipamentosDetalhes.xlsx", bytes_xlsx())
    return saida.getvalue()


class DownloadFalso:
    def __init__(self, nome: str, conteudo: bytes) -> None:
        self.suggested_filename = nome
        self.conteudo = conteudo

    def failure(self):
        return None

    def save_as(self, destino) -> None:
        Path(destino).write_bytes(self.conteudo)


class PastasDeDownload(unittest.TestCase):
    def setUp(self):
        self.raiz = Path(tempfile.mkdtemp(prefix=".download-vazio-"))
        self.addCleanup(shutil.rmtree, self.raiz, ignore_errors=True)
        self.downloads = self.raiz / "Downloads"
        self.chrome = self.raiz / "pasta_do_chrome"
        perfil = self.raiz / "perfil"
        for pasta in (self.downloads, self.chrome, perfil / "Default"):
            pasta.mkdir(parents=True)
        (perfil / "Default" / "Preferences").write_text(
            json.dumps({"download": {"default_directory": str(self.chrome)}}), encoding="utf-8"
        )
        self.mensagens: list[str] = []
        for alvo, valor in (
            ("DOWNLOADS_DIR", self.downloads),
            ("CHROME_PROFILE_DIR", perfil),
            ("COPIA_CHROME_S", 0),
            ("log", lambda _origem, msg: self.mensagens.append(msg)),
            ("verificar_cancelamento", Mock()),
        ):
            patcher = patch.object(automacao, alvo, valor)
            patcher.start()
            self.addCleanup(patcher.stop)


class SalvarDownloadTests(PastasDeDownload):
    def test_download_valido_e_gravado_em_downloads(self):
        arquivo = automacao.salvar_download(DownloadFalso("InvAllComputersSummary.xlsx", bytes_zip()), "Endpoint", time.time())
        self.assertEqual(arquivo, self.downloads / "InvAllComputersSummary.xlsx")
        self.assertTrue(automacao.arquivo_valido(arquivo))

    def test_download_vazio_usa_a_copia_do_chrome_na_mesma_pasta(self):
        # Falha real: o Chrome gravou 'X.zip' e o Playwright criou 'X (1).zip' com 0 bytes.
        desde = time.time()
        (self.downloads / "EquipamentosDetalhes_1.zip").write_bytes(bytes_zip())
        arquivo = automacao.salvar_download(DownloadFalso("EquipamentosDetalhes_1.zip", b""), "UX", desde)
        self.assertEqual(arquivo, self.downloads / "EquipamentosDetalhes_1.zip")
        self.assertEqual(sorted(p.name for p in self.downloads.iterdir()), ["EquipamentosDetalhes_1.zip"])
        self.assertTrue(any("cópia do Chrome" in m for m in self.mensagens))

    def test_download_vazio_traz_a_copia_da_pasta_do_chrome(self):
        desde = time.time()
        (self.chrome / "InvAllComputersSummary.xlsx").write_bytes(bytes_zip())
        arquivo = automacao.salvar_download(DownloadFalso("InvAllComputersSummary.xlsx", b""), "Endpoint", desde)
        self.assertEqual(arquivo.parent, self.downloads)
        self.assertTrue(automacao.arquivo_valido(arquivo))
        self.assertEqual([p.name for p in self.downloads.iterdir()], ["InvAllComputersSummary.xlsx"])

    def test_copia_anterior_a_exportacao_nao_e_usada(self):
        antigo = self.chrome / "InvAllComputersSummary.xlsx"
        antigo.write_bytes(bytes_zip())
        os.utime(antigo, (time.time() - 3600, time.time() - 3600))
        with self.assertRaisesRegex(automacao.RotinaErro, "chegou vazio"):
            automacao.salvar_download(DownloadFalso("InvAllComputersSummary.xlsx", b""), "Endpoint", time.time())
        self.assertEqual(list(self.downloads.iterdir()), [], "o arquivo vazio não pode ficar para a importação")

    def test_conteudo_invalido_nao_vazio_e_preservado_com_outro_nome(self):
        with self.assertRaises(automacao.RotinaErro):
            automacao.salvar_download(DownloadFalso("InvAllComputersSummary.xlsx", b"<html>erro</html>"), "Endpoint", time.time())
        self.assertEqual([p.name for p in self.downloads.iterdir()], ["InvAllComputersSummary.xlsx.invalido"])


class AvisoDeDownloadPerdidoTests(PastasDeDownload):
    def test_usa_o_arquivo_do_chrome_quando_o_evento_nao_chega(self):
        class PaginaSemEvento:
            def __init__(self, pasta: Path) -> None:
                self.pasta = pasta
                self.esperas = 0

            def once(self, *_args):
                pass

            def remove_listener(self, *_args):
                pass

            def wait_for_timeout(self, _ms):
                self.esperas += 1
                if self.esperas == 2:  # o Chrome termina o download sem avisar o Playwright
                    (self.pasta / "EquipamentosDetalhes_20261020_0923_83685.zip").write_bytes(bytes_zip())

        pagina = PaginaSemEvento(self.chrome)
        clicar = Mock()
        with patch.object(automacao, "garantir_tela_minima"):
            arquivo = automacao.exportar_com_download(pagina, "UX", clicar, "EquipamentosDetalhes")
        clicar.assert_called_once_with()
        self.assertEqual(arquivo, self.downloads / "EquipamentosDetalhes_20261020_0923_83685.zip")
        self.assertTrue(any("não chegou ao Playwright" in m for m in self.mensagens))

    def test_prefixo_nao_aceita_outro_relatorio(self):
        padrao = automacao.padrao_do_prefixo(r"Gest[ãa]o de Solicita[çc][õo]es")
        self.assertTrue(padrao.fullmatch("Gestão de Solicitações (5).xlsx"))
        self.assertFalse(padrao.fullmatch("InvAllComputersSummary.xlsx"))
        self.assertFalse(padrao.fullmatch("Gestão de Solicitações.xlsx.crdownload"))


class TelaMinimaTests(unittest.TestCase):
    def test_tamanho_emulado_so_quando_a_janela_e_pequena(self):
        largura, altura = automacao.TELA_MINIMA
        self.assertIsNone(automacao.tamanho_emulado(1536, 730 if altura <= 730 else altura))
        self.assertIsNone(automacao.tamanho_emulado(2560, 1440))
        self.assertEqual(automacao.tamanho_emulado(622, 384), (largura, altura))
        self.assertEqual(automacao.tamanho_emulado(782, 1300), (largura, 1300))
        self.assertEqual(automacao.tamanho_emulado(1900, 500), (1900, altura))

    def pagina(self, largura: int, altura: int):
        pagina = Mock()
        pagina.is_closed.return_value = False
        pagina.evaluate.return_value = [largura, altura]
        return pagina

    def test_janela_pequena_desenha_a_pagina_no_tamanho_minimo_e_libera_depois(self):
        pagina = self.pagina(622, 384)
        with patch.object(automacao, "log"):
            automacao.garantir_tela_minima(pagina, "UX")
            automacao.garantir_tela_minima(pagina, "UX")  # segunda chamada não cria outra sessão
        sessao = pagina.context.new_cdp_session.return_value
        pagina.context.new_cdp_session.assert_called_once_with(pagina)
        metodo, parametros = sessao.send.call_args.args
        self.assertEqual(metodo, "Emulation.setDeviceMetricsOverride")
        self.assertEqual((parametros["width"], parametros["height"]), automacao.TELA_MINIMA)
        self.assertFalse(parametros["mobile"])
        automacao.liberar_tela_minima(pagina)
        sessao.send.assert_called_with("Emulation.clearDeviceMetricsOverride")
        sessao.detach.assert_called_once_with()
        self.assertNotIn(pagina, automacao._telas_ajustadas)

    def test_janela_grande_nao_e_alterada(self):
        pagina = self.pagina(1920, 1080)
        automacao.garantir_tela_minima(pagina, "UX")
        pagina.context.new_cdp_session.assert_not_called()

    def test_falha_no_ajuste_nao_interrompe_a_rotina(self):
        pagina = self.pagina(622, 384)
        pagina.context.new_cdp_session.side_effect = RuntimeError("CDP indisponível")
        mensagens = []
        with patch.object(automacao, "log", lambda _o, msg: mensagens.append(msg)):
            automacao.garantir_tela_minima(pagina, "UX")
        self.assertTrue(any("Não foi possível ajustar" in m for m in mensagens))


class UxLogadoTests(unittest.TestCase):
    def pagina(self, url: str, saudacoes: int):
        pagina = Mock()
        pagina.url = url
        pagina.get_by_text.return_value.count.return_value = saudacoes
        pagina.get_by_text.return_value.filter.return_value.count.return_value = 0  # oculta
        return pagina

    def test_saudacao_oculta_em_janela_estreita_conta_como_logado(self):
        self.assertTrue(automacao.ux_logado(self.pagina("https://ux.simpress.com.br/MeusEquipamentos/Index", 1)))

    def test_tela_de_login_nao_conta_como_logado(self):
        self.assertFalse(automacao.ux_logado(self.pagina("https://ux.simpress.com.br/ng/autenticacao/login", 1)))
        self.assertFalse(automacao.ux_logado(self.pagina("https://ux.simpress.com.br/MeusEquipamentos/Index", 0)))


class ImportacaoIgnoraDownloadVazioTests(unittest.TestCase):
    def setUp(self):
        self.pasta = Path(tempfile.mkdtemp(prefix=".download-vazio-importacao-"))
        self.addCleanup(shutil.rmtree, self.pasta, ignore_errors=True)
        self.desde = datetime.now(timezone.utc) - timedelta(minutes=5)

    def criar(self, nome: str, conteudo: bytes, atraso: float) -> Path:
        arquivo = self.pasta / nome
        arquivo.write_bytes(conteudo)
        momento = time.time() + atraso
        os.utime(arquivo, (momento, momento))
        return arquivo

    def test_inventarios_escolhem_o_valido_mesmo_com_vazio_mais_novo(self):
        valido = self.criar("EquipamentosDetalhes_1.zip", bytes_zip_com_xlsx(), 0)
        self.criar("EquipamentosDetalhes_1 (1).zip", b"", 1)
        resultado = prepare_inventory_downloads.recent_workbook(self.pasta, "EquipamentosDetalhes", self.desde)
        self.assertIn(valido.name, str(resultado))

    def test_chamados_escolhem_o_valido_mesmo_com_vazio_mais_novo(self):
        valido = self.criar("Gestão de Solicitações (5).xlsx", bytes_xlsx(), 0)
        self.criar("Gestão de Solicitações (6).xlsx", b"", 1)
        resultado = prepare_ticket_downloads.recent_workbook(self.pasta, ["Gestão de Solicitações"], self.desde)
        self.assertIn(valido.name, str(resultado))


if __name__ == "__main__":
    unittest.main()
