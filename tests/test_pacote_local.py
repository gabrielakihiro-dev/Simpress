"""Pacote local (Configuração local): exportar, prévia, restaurar e desfazer.

Só dados sintéticos numa pasta temporária: o ``data/``, o ``config/`` e o ``.transactions`` reais nunca são lidos nem
gravados. Os serviços do app (transação, carga da base, guardas) entram por injeção.
"""

import contextlib
import dataclasses
import fnmatch
import hashlib
import io
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from openpyxl import Workbook

import core.config
from core.config import BASE_DIR, MAX_UPLOAD_BYTES, STATE_DIR
from core.integrity import AtomicFileTransaction
from domains import inventory_inbox, pacote_local, sebrae_finalizacao, ticket_inbox
from domains.history_annotations import build_history_annotation_record, history_annotation_record_path
from domains.pacote_local import ALLOWLIST, FORA, PASTAS, PacoteLocalServices
from routers.pacote_local import create_pacote_local_router

SEGREDO = "conteudo-sigiloso-omega"
LOCAL = ("127.0.0.1", 1234)
LEMBRETES = "data/state/lembretes.json"
OBSERVACOES = "data/state/os_observacoes.json"
CHAMADOS = "data/state/historico_chamados.json"
NOME = "pacote-local-20260101-000000.zip"
ANEXOS = "data/state/sebrae_anexos"
ANEXO = f"{ANEXOS}/UTIC-2026-1/{'a' * 32}/teste.pdf"
NOTA_PASTA = "data/state/anotacoes_historico_pendentes"
_NOTA = {"event_id": "evento-sintetico", "item_id": "linha-1", "revision_id": "c" * 32}
NOTA = f"{NOTA_PASTA}/{history_annotation_record_path(Path('.'), *_NOTA.values()).name}"
NOTA_BYTES = json.dumps(build_history_annotation_record(
    **_NOTA, event_time="2026-01-01T00:00:00+00:00", serie="SINT001", computador="PC-SINT", motivo="teste",
    anotacao="nota sintética", updated_at="2026-01-01T00:00:00+00:00",
), ensure_ascii=False).encode("utf-8")
PDF = b"%PDF-1.4 sintetico\n%%EOF"


def cliente_rel() -> str:
    return core.config.CLIENT_CONFIG_FILE.relative_to(BASE_DIR).as_posix()


def planilha() -> bytes:
    livro = Workbook()
    livro.active.append(["Serie", "Modelo"])
    livro.active.append(["SINT001", "Modelo sintético"])
    saida = io.BytesIO()
    livro.save(saida)
    return saida.getvalue()


def montar_zip(arquivos: dict, manifesto=None, extras=(), versao="1.3.0", tipo="exportacao", ausentes=(),
               invalidos=()) -> bytes:
    """Zip de teste; ``manifesto`` None monta um coerente, False omite, dict usa o dado."""
    if manifesto is None:
        manifesto = {
            "formato": 1, "tipo": tipo, "versao_app": versao, "criado_em": "2026-01-01T00:00:00-03:00",
            "arquivos": [
                {"caminho": nome, "tamanho_bytes": len(dados), "sha256": hashlib.sha256(dados).hexdigest()}
                for nome, dados in arquivos.items()
            ],
            "ausentes": list(ausentes),
            "invalidos": list(invalidos),
        }
    saida = io.BytesIO()
    with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as pacote:
        if manifesto is not False:
            pacote.writestr("manifesto.json", json.dumps(manifesto))
        for nome, dados in arquivos.items():
            pacote.writestr(nome, dados)
        for info, dados in extras:
            pacote.writestr(info, dados)
    return saida.getvalue()


def remendar(zip_bytes: bytes, nome: str, deslocamentos: tuple, valor: bytes) -> bytes:
    """Troca um campo do cabeçalho local e do central da entrada (o zipfile não grava cabeçalhos mentirosos)."""
    dados = bytearray(zip_bytes)
    local = zipfile.ZipFile(io.BytesIO(zip_bytes)).getinfo(nome).header_offset
    central = dados.rindex(nome.encode()) - 46  # o nome vem logo depois do cabeçalho central (46 bytes)
    assert (dados[local:local + 4], dados[central:central + 4]) == (b"PK\x03\x04", b"PK\x01\x02")
    for inicio, deslocamento in zip((local, central), deslocamentos):
        dados[inicio + deslocamento:inicio + deslocamento + len(valor)] = valor
    return bytes(dados)


class PacoteLocalBase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve() / "app"
        self.base.mkdir()
        self.automacao = False
        self.admissao = threading.BoundedSemaphore(1)
        self.publicados = []
        self.carregar = mock.Mock(return_value={"equipamentos_cache": {}})
        self.estado_vazio = {"equipamentos_cache": {}, "vazio": True}
        self.services = PacoteLocalServices(
            base_dir=lambda: self.base,
            arquivo_config=lambda: self.base / "config" / "pacote_local.json",
            app_version="1.3.0",
            max_upload_bytes=MAX_UPLOAD_BYTES,
            inventory_state_transaction=lambda alvos: AtomicFileTransaction(self.base, alvos),
            load_database=self.carregar,
            publish_database_state=self.publicados.append,
            validate_uploaded_workbook=lambda dados, papel: {},
            automacao_em_andamento=lambda: self.automacao,
            upload_admission=lambda: self.admissao,
            travas_importacao=lambda: [
                inventory_inbox.try_worker_lock(self.base / "inbox" / ".importador.lock"),
                ticket_inbox.try_worker_lock(self.base / "chamados" / ".importador.lock"),
            ],
            transacao_pendente=lambda: False,
            estado_vazio=lambda: self.estado_vazio,
            # A regra real sobre arquivos sintéticos da base temporária (Dashboard importado, novos e finalização).
            chamados_sebrae_abertos=lambda: sebrae_finalizacao.abertos_nao_finalizados(self.base / "data" / "state"),
        )
        self.montar()
        self.pasta = self.base / "data" / "pacotes_locais"

    def montar(self, **trocas) -> None:
        self.services = dataclasses.replace(self.services, **trocas)
        app = FastAPI()
        app.include_router(create_pacote_local_router(self.services))
        self.client = TestClient(app, client=LOCAL)

    def gravar(self, rel: str, dados) -> None:
        alvo = self.base / rel
        alvo.parent.mkdir(parents=True, exist_ok=True)
        alvo.write_bytes(dados if isinstance(dados, bytes) else json.dumps(dados).encode("utf-8"))

    def estado(self) -> dict:
        return {rel: (self.base / rel).read_bytes() for rel in ALLOWLIST if (self.base / rel).is_file()}

    def colocar(self, dados: bytes, nome: str = NOME) -> str:
        self.pasta.mkdir(parents=True, exist_ok=True)
        (self.pasta / nome).write_bytes(dados)
        return nome

    def previa(self, nome: str):
        return self.client.get(f"/api/pacote-local/{nome}/previa")

    def restaurar(self, nome: str, token: str, confirmado=True):
        return self.client.post(f"/api/pacote-local/{nome}/restaurar", json={"preview_token": token, "confirmado": confirmado})


class AllowlistTests(unittest.TestCase):
    def test_toda_constante_de_estado_ou_config_esta_na_allowlist_ou_fora(self):
        config_dir = BASE_DIR / "config"
        faltando = []
        for nome, valor in vars(core.config).items():
            if not nome.endswith(("_FILE", "_DIR")) or not isinstance(valor, Path):
                continue
            if not (valor.is_relative_to(STATE_DIR) or valor.is_relative_to(config_dir)) or valor == STATE_DIR:
                continue
            rel = valor.relative_to(BASE_DIR).as_posix()
            if rel not in ALLOWLIST and rel not in FORA and rel not in PASTAS:
                faltando.append(nome)
        self.assertEqual(faltando, [])

    def test_arquivos_persistentes_sem_constante_estao_na_allowlist_ou_fora(self):
        """Nomes literais em main.py (STATE_DIR / "x") e os conhecidos sem constante; nunca varre o data/ real."""
        literais = re.findall(r'STATE_DIR / "([^"]+)"', (BASE_DIR / "main.py").read_text(encoding="utf-8"))
        conhecidos = [
            "data/planilhas_entrada/_modelos/transferencia.xlsx", "data/state/usuarios_manuais/usuarios_pendencias.json",
            "data/state/dashboard_agendamento.json", "data/state/inventory_update_idempotency.json",
            "data/state/assinatura_tecnico.svg", "data/state/sebrae_historico.json", "data/state/sebrae_os_recusadas.json",
            "data/state/sebrae_excel_diario.json", "data/state/sebrae_categoria_indice.json",
        ]
        faltando = [
            rel for rel in [f"data/state/{nome}" for nome in literais] + conhecidos
            if rel not in ALLOWLIST and not any(fnmatch.fnmatchcase(rel, padrao) for padrao in FORA)
        ]
        self.assertGreater(len(literais), 5)
        self.assertEqual(faltando, [])
        self.assertIn("data/planilhas_entrada/_modelos/transferencia.xlsx", ALLOWLIST)
        self.assertIn("data/state/usuarios_manuais/usuarios_pendencias.json", ALLOWLIST)

    def test_allowlist_so_json_e_xlsx_e_sem_sobreposicao_com_fora(self):
        self.assertTrue(all(rel.endswith((".json", ".xlsx")) for rel in ALLOWLIST))
        self.assertEqual(len(set(ALLOWLIST)), len(ALLOWLIST))
        self.assertEqual([rel for rel in ALLOWLIST if any(fnmatch.fnmatchcase(rel, padrao) for padrao in FORA)], [])
        for sensivel in (".env", "data/state/config_backups", "data/state/sebrae_credenciais.json", "config/pacote_local.json"):
            self.assertIn(sensivel, FORA)
        self.assertIn(CHAMADOS, ALLOWLIST)
        self.assertEqual(PASTAS, (ANEXOS, "data/state/anotacoes_historico_pendentes"))
        self.assertEqual([pasta for pasta in PASTAS if pasta in FORA or pasta in ALLOWLIST], [])
        self.assertIn("anotacoes_historico", FORA)  # a pasta compartilhada (OneDrive) nunca entra


class ExportarTests(PacoteLocalBase):
    def test_exporta_so_a_allowlist(self):
        self.gravar(LEMBRETES, {"lembretes": [SEGREDO]})
        self.gravar(cliente_rel(), {"contrato": "123", "cnpj_faturamento": ""})
        self.gravar(".env", b"OPENROUTER_API_KEY=" + SEGREDO.encode())
        self.gravar("data/state/config_backups/contas_automacao.json.20260101-000000.bak", b"{}")
        self.gravar("data/state/sebrae_credenciais.json", {"x": SEGREDO})
        self.gravar("config/pacote_local.json", {"pasta": ""})
        resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        corpo = resposta.json()
        self.assertRegex(corpo["arquivo"], pacote_local.NOME_PACOTE)
        self.assertEqual(corpo["arquivos"], 2)
        self.assertEqual(corpo["ausentes"], len(ALLOWLIST) - 2)
        with zipfile.ZipFile(self.pasta / corpo["arquivo"]) as pacote:
            nomes = set(pacote.namelist())
            manifesto = json.loads(pacote.read("manifesto.json"))
        self.assertEqual(nomes, {"manifesto.json", LEMBRETES, cliente_rel()})
        self.assertEqual(manifesto["tipo"], "exportacao")
        self.assertEqual(manifesto["versao_app"], "1.3.0")
        lista = self.client.get("/api/pacote-local").json()
        self.assertTrue(lista["pasta_padrao"])
        self.assertIsNone(lista["erro_pasta"])
        self.assertEqual([item["arquivo"] for item in lista["pacotes"]], [corpo["arquivo"]])
        self.assertEqual(lista["pacotes"][0]["tipo"], "exportacao")
        self.assertEqual([p.name for p in self.pasta.iterdir()], [corpo["arquivo"]])  # sem temporário

    def test_json_repetitivo_exporta_e_abre_na_previa(self):
        historico = [{"serie": "S1", "campo": "usuario", "antes": "", "depois": "", "origem": "manual"}] * 5000
        self.gravar("data/state/historico_alteracoes.json", json.dumps(historico, indent=2).encode())
        resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        info = zipfile.ZipFile(self.pasta / resposta.json()["arquivo"]).getinfo("data/state/historico_alteracoes.json")
        self.assertGreater(info.file_size / info.compress_size, 100)  # a razão não é limite
        self.assertEqual(self.previa(resposta.json()["arquivo"]).status_code, 200)

    def test_exportacao_que_nao_passa_na_conferencia_nao_fica_na_pasta(self):
        self.gravar(cliente_rel(), {"contrato": "123", "cnpj_faturamento": "11.111.111/1111-11"})
        resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (422, f"Pacote recusado: conteúdo inválido em {Path(cliente_rel()).name}"))
        self.assertEqual(list(self.pasta.iterdir()), [])

    def test_nunca_sobrescreve_pacote_com_o_mesmo_nome(self):
        self.gravar(LEMBRETES, {"a": 1})
        with mock.patch.object(pacote_local, "datetime", wraps=pacote_local.datetime) as relogio:
            relogio.now.return_value = pacote_local.datetime(2026, 1, 1, 0, 0, 0)
            self.assertEqual(self.client.post("/api/pacote-local/exportar").status_code, 200)
            antes = (self.pasta / NOME).read_bytes()
            self.gravar(LEMBRETES, {"a": 2})
            resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 409)
        self.assertEqual((self.pasta / NOME).read_bytes(), antes)


class ValidacaoTests(PacoteLocalBase):
    def recusa(self, dados: bytes, motivo: str) -> None:
        resposta = self.previa(self.colocar(dados))
        self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertEqual(resposta.json()["detail"], f"Pacote recusado: {motivo}")

    def test_hash_errado(self):
        manifesto = json.loads(zipfile.ZipFile(io.BytesIO(montar_zip({LEMBRETES: b"{}"}))).read("manifesto.json"))
        manifesto["arquivos"][0]["sha256"] = "0" * 64
        self.recusa(montar_zip({LEMBRETES: b"{}"}, manifesto), "arquivo não confere com o manifesto")

    def test_caminho_com_pontos_ou_absoluto(self):
        self.recusa(montar_zip({}, extras=[("data/../config/x.json", b"{}")]), "caminho inválido no pacote")
        self.recusa(montar_zip({}, extras=[("/etc/x.json", b"{}")]), "caminho inválido no pacote")

    def test_arquivo_que_sobra_fora_do_manifesto(self):
        self.recusa(montar_zip({LEMBRETES: b"{}"}, extras=[(OBSERVACOES, b"{}")]), "arquivo não confere com o manifesto")

    def test_entrada_fora_da_allowlist_mesmo_no_manifesto(self):
        self.recusa(montar_zip({"data/state/sebrae_credenciais.json": b"{}"}), "arquivo fora da lista permitida")
        self.recusa(montar_zip({".env": b"X=1"}), "arquivo fora da lista permitida")

    def test_symlink_no_zip(self):
        info = zipfile.ZipInfo(LEMBRETES)
        info.external_attr = 0o120777 << 16
        self.recusa(montar_zip({}, extras=[(info, b"/etc/passwd")]), "caminho inválido no pacote")

    def test_sem_manifesto(self):
        self.recusa(montar_zip({LEMBRETES: b"{}"}, manifesto=False), "manifesto ausente ou inválido")
        self.recusa(b"nao e zip", "manifesto ausente ou inválido")

    def test_versao_mais_nova(self):
        self.recusa(montar_zip({LEMBRETES: b"{}"}, versao="1.4.0"), "pacote de uma versão mais nova do app")

    def test_limites_de_tamanho(self):
        self.montar(max_upload_bytes=10)
        self.recusa(montar_zip({LEMBRETES: b'{"a": "' + b"x" * 20 + b'"}'}), "pacote grande demais (limite 10 bytes)")
        with mock.patch.object(pacote_local, "LIMITE_ZIP", 50):
            self.recusa(montar_zip({LEMBRETES: b"{}"}), "pacote grande demais (limite 50 bytes)")

    def test_conteudo_invalido(self):
        self.recusa(montar_zip({cliente_rel(): b'{"cnpj_faturamento": "11.111.111/1111-11"}'}),
                    f"conteúdo inválido em {Path(cliente_rel()).name}")  # só o nome, nunca o caminho
        self.recusa(montar_zip({CHAMADOS: b'{"chamados": {}}'}), "conteúdo inválido em historico_chamados.json")
        self.recusa(montar_zip({"data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx": b"PK nada"}),
                    "conteúdo inválido em EquipamentosDetalhes_atual.xlsx")

    def test_entradas_estruturais_recusadas(self):
        cifrada = remendar(montar_zip({LEMBRETES: b"{}"}), LEMBRETES, (6, 8), (1).to_bytes(2, "little"))
        self.assertTrue(zipfile.ZipFile(io.BytesIO(cifrada)).getinfo(LEMBRETES).flag_bits & 1)
        self.recusa(cifrada, "caminho inválido no pacote")
        self.recusa(montar_zip({}, extras=[(zipfile.ZipInfo("data/state/"), b"")]), "caminho inválido no pacote")
        decomposto = "data/state/le\u0301mbretes.json"  # NFC igual a "lémbretes"
        self.recusa(montar_zip({}, extras=[("data/state/l\u00e9mbretes.json", b"{}"), (decomposto, b"{}")]),
                    "caminho inválido no pacote")
        self.recusa(montar_zip({}, extras=[(LEMBRETES, b"{}"), (LEMBRETES.upper(), b"{}")]), "caminho inválido no pacote")

    def test_cabecalho_que_mente_o_tamanho(self):
        dados = remendar(montar_zip({LEMBRETES: b'{"lembretes": ["um", "dois", "tres"]}'}), LEMBRETES, (22, 24),
                         (5).to_bytes(4, "little"))  # tamanho descompactado declarado = 5 bytes
        self.assertEqual(zipfile.ZipFile(io.BytesIO(dados)).getinfo(LEMBRETES).file_size, 5)
        self.recusa(dados, "arquivo não confere com o manifesto")

    def test_total_acima_do_limite(self):
        with mock.patch.object(pacote_local, "LIMITE_TOTAL", 3):
            self.recusa(montar_zip({LEMBRETES: b"{}", OBSERVACOES: b"{}"}), "pacote grande demais (limite 3 bytes)")

    def test_tipo_do_manifesto_bate_com_o_nome(self):
        self.recusa(montar_zip({LEMBRETES: b"{}"}, tipo="desfazer"), "manifesto ausente ou inválido")
        resposta = self.previa(self.colocar(montar_zip({LEMBRETES: b"{}"}), "desfazer-20260101-000000.zip"))
        self.assertEqual(resposta.json()["detail"], "Pacote recusado: manifesto ausente ou inválido")

    def test_planilha_com_macro(self):
        livro = io.BytesIO(planilha())
        with zipfile.ZipFile(livro, "a") as arquivo:
            arquivo.writestr("xl/vbaProject.bin", b"macro")
        self.recusa(montar_zip({"data/planilhas_entrada/_modelos/transferencia.xlsx": livro.getvalue()}),
                    "conteúdo inválido em transferencia.xlsx")

    def test_404_para_nome_fora_do_padrao(self):
        self.colocar(montar_zip({LEMBRETES: b"{}"}), "outro.zip")
        self.assertEqual(self.previa("outro.zip").status_code, 404)
        self.assertEqual(self.previa("pacote-local-20990101-000000.zip").status_code, 404)


class RestaurarTests(PacoteLocalBase):
    def preparar(self):
        """Exporta {lembretes, cliente, planilha}; depois muda lembretes, apaga cliente e cria observações."""
        self.gravar(LEMBRETES, {"lembretes": ["original", SEGREDO]})
        self.gravar(cliente_rel(), {"contrato": "123", "cnpj_faturamento": ""})
        self.gravar("data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx", planilha())
        exportado = self.client.post("/api/pacote-local/exportar").json()["arquivo"]
        self.original = self.estado()
        self.gravar(LEMBRETES, {"lembretes": ["alterado"]})
        (self.base / cliente_rel()).unlink()
        self.gravar(OBSERVACOES, {"observacoes": {}})
        self.alterado = self.estado()
        return exportado

    def test_sem_confirmado_nao_faz_nada(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        for corpo in ({"preview_token": token}, {"preview_token": token, "confirmado": False}):
            self.assertEqual(self.client.post(f"/api/pacote-local/{nome}/restaurar", json=corpo).status_code, 422)
        self.assertEqual(self.client.post(f"/api/pacote-local/{nome}/restaurar",
                                          json={"preview_token": token, "confirmado": "true"}).status_code, 422)
        self.assertEqual(self.estado(), self.alterado)
        self.assertEqual(len(list(self.pasta.iterdir())), 1)

    def test_token_velho(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        self.gravar(LEMBRETES, {"lembretes": ["mudou depois da previa"]})
        resposta = self.restaurar(nome, token)
        self.assertEqual(resposta.status_code, 409)
        self.assertEqual(resposta.json()["detail"], "Restauração recusada: o estado mudou desde a prévia; abra a prévia de novo")

    def test_guardas(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        self.automacao = True
        self.assertEqual(self.restaurar(nome, token).json()["detail"], "Restauração recusada: uma automação está em execução")
        self.automacao = False
        self.admissao.acquire()
        resposta = self.restaurar(nome, token)
        self.admissao.release()
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (409, "Restauração recusada: uma importação está em andamento"))
        with inventory_inbox.try_worker_lock(self.base / "inbox" / ".importador.lock") as livre:
            self.assertTrue(livre)
            resposta = self.restaurar(nome, token)
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (409, "Restauração recusada: uma importação está em andamento"))
        with ticket_inbox.try_worker_lock(self.base / "chamados" / ".importador.lock") as livre:
            self.assertTrue(livre)
            resposta = self.restaurar(nome, token)
        self.assertEqual(resposta.json()["detail"], "Restauração recusada: uma importação está em andamento")
        self.montar(transacao_pendente=lambda: True)
        self.assertEqual((self.restaurar(nome, token).status_code, self.restaurar(nome, token).json()["detail"]),
                         (409, "Restauração recusada: há uma gravação pendente para conferir em .transactions"))
        self.assertEqual(self.estado(), self.alterado)
        self.assertTrue(self.admissao.acquire(blocking=False))  # a guarda foi liberada
        self.admissao.release()
        self.assertFalse(pacote_local.RESTAURANDO.is_set())

    def test_arquivos_ocupados(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        self.montar(inventory_state_transaction=mock.Mock(side_effect=pacote_local.FileBusyError("ocupado")))
        resposta = self.restaurar(nome, token)
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (409, "Restauração recusada: arquivos ocupados; tente de novo em instantes"))
        self.assertEqual(self.estado(), self.alterado)

    def test_automacao_que_comeca_durante_a_restauracao(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        vistas = []

        def automacao():
            vistas.append(pacote_local.RESTAURANDO.is_set())
            return len(vistas) > 1  # livre na guarda, ocupada logo antes de gravar

        self.montar(automacao_em_andamento=automacao)
        resposta = self.restaurar(nome, token)
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (409, "Restauração recusada: uma automação está em execução"))
        self.assertEqual(vistas, [True, True])  # a trava das rotinas já estava ligada nas duas checagens
        self.assertEqual(self.estado(), self.alterado)
        self.assertEqual([p.name for p in self.pasta.iterdir()], [nome])  # desfazer sem uso apagado
        self.assertFalse(pacote_local.RESTAURANDO.is_set())

    def test_rotina_do_chrome_recusada_durante_a_restauracao(self):
        from core.errors import DomainConflictError
        from tests.test_chrome_automation import RunnerHarness

        harness = RunnerHarness(self.base / "chrome")
        harness.runner = harness.build(bloqueado=pacote_local.RESTAURANDO.is_set)
        pacote_local.RESTAURANDO.set()
        try:
            with self.assertRaises(DomainConflictError):
                harness.runner.start("os")
        finally:
            pacote_local.RESTAURANDO.clear()
        self.assertEqual(harness.popen_calls, [])
        harness.runner.start("os")
        self.assertEqual(len(harness.popen_calls), 1)

    def test_ida_e_volta_com_desfazer(self):
        nome = self.preparar()
        previa = self.previa(nome).json()
        acoes = {item["caminho"]: item["acao"] for item in previa["itens"]}
        self.assertEqual(acoes[LEMBRETES], "substituir")
        self.assertEqual(acoes[cliente_rel()], "criar")
        self.assertEqual(acoes["data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx"], "igual")
        self.assertEqual(acoes[OBSERVACOES], "manter")
        self.assertTrue(previa["muda_links"])
        self.assertEqual(previa["totais"], {"substituir": 1, "criar": 1, "igual": 1, "manter": 1, "apagar": 0})

        with self.assertLogs("domains.pacote_local", level=logging.INFO) as logs:
            resposta = self.restaurar(nome, previa["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        corpo = resposta.json()
        self.assertEqual({k: corpo[k] for k in ("substituidos", "criados", "apagados", "mantidos")},
                         {"substituidos": 1, "criados": 1, "apagados": 0, "mantidos": 1})
        self.assertEqual(self.estado(), {**self.original, OBSERVACOES: self.alterado[OBSERVACOES]})  # mantido
        self.assertEqual(len(self.publicados), 1)
        self.assertNotIn(SEGREDO, "\n".join(logs.output))
        self.assertNotIn(str(self.base), "\n".join(logs.output))

        desfazer = corpo["pacote_desfazer"]
        previa_desfazer = self.previa(desfazer).json()
        self.assertEqual(previa_desfazer["tipo"], "desfazer")
        self.assertIn({"caminho": cliente_rel(), "acao": "apagar"}, previa_desfazer["itens"])
        resposta = self.restaurar(desfazer, previa_desfazer["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["apagados"], 1)
        self.assertEqual(self.estado(), self.alterado)  # volta exato, inclusive apagar o que não existia

    def test_desfazer_que_apaga_o_cadastro_publica_estado_vazio(self):
        detalhes = "data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx"
        self.gravar(LEMBRETES, {"a": 1})
        self.gravar(detalhes, planilha())
        nome = self.client.post("/api/pacote-local/exportar").json()["arquivo"]
        (self.base / detalhes).unlink()
        desfazer = self.restaurar(nome, self.previa(nome).json()["preview_token"]).json()["pacote_desfazer"]
        self.assertTrue((self.base / detalhes).is_file())
        self.carregar.return_value = False  # sem cadastro, load_database devolve False
        resposta = self.restaurar(desfazer, self.previa(desfazer).json()["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertFalse((self.base / detalhes).exists())
        self.assertIs(self.publicados[-1], self.estado_vazio)

    def test_muda_links_com_instrucoes_do_assistente(self):
        instrucoes = "data/state/assistente_instrucoes.json"
        nome = self.colocar(montar_zip({instrucoes: b'{"instrucoes": []}'}))
        self.assertTrue(self.previa(nome).json()["muda_links"])

    def test_token_que_nao_e_hex(self):
        nome = self.preparar()
        self.assertEqual(self.restaurar(nome, "Z" * 64).status_code, 422)

    def test_ja_corresponde(self):
        self.gravar(LEMBRETES, {"a": 1})
        nome = self.client.post("/api/pacote-local/exportar").json()["arquivo"]
        resposta = self.restaurar(nome, self.previa(nome).json()["preview_token"])
        self.assertEqual((resposta.status_code, resposta.json()["detail"]), (409, "Este pacote já corresponde ao estado atual."))

    def test_desfazer_criado_antes_de_gravar_e_falha_aborta(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        gravar_original = pacote_local._gravar_pacote
        vistos = []

        def espiar(services, pasta, tipo, *resto):
            vistos.append((tipo, (self.base / LEMBRETES).read_bytes()))
            return gravar_original(services, pasta, tipo, *resto)

        with mock.patch.object(pacote_local, "_gravar_pacote", side_effect=espiar):
            self.assertEqual(self.restaurar(nome, token).status_code, 200)
        self.assertEqual(vistos, [("desfazer", self.alterado[LEMBRETES])])

        self.setUp()
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        falha = pacote_local.DomainError("disco cheio", status_code=422)
        with mock.patch.object(pacote_local, "_gravar_pacote", side_effect=falha):
            resposta = self.restaurar(nome, token)
        self.assertEqual(resposta.status_code, 422)
        self.assertEqual(self.estado(), self.alterado)

    def registro(self) -> dict:
        arquivo = self.base / "config" / "pacote_local.json"
        return json.loads(arquivo.read_text(encoding="utf-8")) if arquivo.exists() else {}

    def test_estado_atual_invalido_restaura_e_o_desfazer_devolve_os_bytes_brutos(self):
        nome = self.preparar()
        bruto = b'{"contrato": "123",   "cnpj_faturamento": "11.111.111/1111-11"}\n'  # CNPJ inválido, formato próprio
        self.gravar(cliente_rel(), bruto)
        self.alterado = self.estado()
        resposta = self.restaurar(nome, self.previa(nome).json()["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        desfazer = resposta.json()["pacote_desfazer"]
        with zipfile.ZipFile(self.pasta / desfazer) as pacote:
            self.assertEqual(json.loads(pacote.read("manifesto.json"))["invalidos"], [cliente_rel()])
            self.assertEqual(pacote.read(cliente_rel()), bruto)
        sha = hashlib.sha256((self.pasta / desfazer).read_bytes()).hexdigest()
        self.assertEqual(self.registro(), {"pasta": "", "desfazer_conhecidos": [sha]})

        previa = self.previa(desfazer).json()
        self.assertEqual(previa["invalidos"], [Path(cliente_rel()).name])
        resposta = self.restaurar(desfazer, previa["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual((self.base / cliente_rel()).read_bytes(), bruto)
        self.assertEqual(self.estado(), self.alterado)

    def test_desfazer_com_outro_arquivo_invalido_que_nao_carrega_volta_atras(self):
        nome = self.preparar()
        bruto = b'{"contrato": "123", "cnpj_faturamento": "11.111.111/1111-11"}'
        self.gravar(cliente_rel(), bruto)
        desfazer = self.restaurar(nome, self.previa(nome).json()["preview_token"]).json()["pacote_desfazer"]
        depois = self.estado()
        self.carregar.return_value = False  # o estado vazio vale só para cadastro ou InvAll inválidos
        resposta = self.restaurar(desfazer, self.previa(desfazer).json()["preview_token"])
        self.assertEqual((resposta.status_code, resposta.json()["detail"]), (500, pacote_local.MSG_FALHA))
        self.assertEqual(self.estado(), depois)
        self.assertNotIn(self.estado_vazio, self.publicados)

    def test_desfazer_e_conferido_pelos_bytes_gravados_sem_reler_a_pasta(self):
        nome = self.preparar()
        self.gravar(cliente_rel(), b'{"cnpj_faturamento": "11.111.111/1111-11"}')
        token = self.previa(nome).json()["preview_token"]
        with mock.patch.object(pacote_local, "validar_pacote", wraps=pacote_local.validar_pacote) as lidos:
            desfazer = self.restaurar(nome, token).json()["pacote_desfazer"]
        self.assertEqual([chamada.args[1].name for chamada in lidos.call_args_list], [nome])  # só o pacote escolhido
        sha = hashlib.sha256((self.pasta / desfazer).read_bytes()).hexdigest()
        self.assertEqual(self.registro()["desfazer_conhecidos"], [sha])

    def test_zip_lido_uma_vez_so(self):
        """Hash e validação usam a mesma leitura: trocar o arquivo depois do hash não troca o que é validado."""
        ruim = b'{"cnpj_faturamento": "11.111.111/1111-11"}'
        conhecido = montar_zip({cliente_rel(): ruim}, tipo="desfazer", invalidos=[cliente_rel()])
        forjado = montar_zip({cliente_rel(): ruim + b" "}, tipo="desfazer", invalidos=[cliente_rel()])
        nome = self.colocar(conhecido, "desfazer-20260101-000000.zip")
        self.gravar("config/pacote_local.json", {"pasta": "", "desfazer_conhecidos": [hashlib.sha256(conhecido).hexdigest()]})
        abrir = Path.open
        leituras = []

        class Trocavel(io.BytesIO):
            """Devolve o zip conhecido na 1ª leitura e o forjado em qualquer leitura seguinte."""

            def read(self, *args):
                leituras.append(args)
                return conhecido if len(leituras) == 1 else forjado

        def abrir_trocando(caminho, *args, **kwargs):
            return Trocavel() if caminho.name == nome else abrir(caminho, *args, **kwargs)

        with mock.patch.object(Path, "open", abrir_trocando):
            resultado = pacote_local.validar_pacote(self.services, self.pasta / nome)
        self.assertEqual(leituras, [(pacote_local.LIMITE_ZIP + 1,)])
        self.assertEqual(resultado["conteudo"][cliente_rel()], ruim)
        self.assertEqual(resultado["sha256"], hashlib.sha256(conhecido).hexdigest())

    def test_link_que_esconde_o_site_real(self):
        from domains import configuracao_local

        enganoso = "https://evil.com\\@ux.legitimo.com/sites/x"
        self.assertEqual(pacote_local._host(enganoso), "evil.com")
        for valor in (enganoso, "https://usuario@ux.legitimo.com/x", "https://ux.legitimo.com\\x"):
            with self.subTest(valor=valor):
                self.assertIsNotNone(configuracao_local.validar_valor("link", valor))
                with self.assertRaises(ValueError):  # o PUT da Configuração local usa gravar_contas
                    configuracao_local.gravar_contas(
                        self.base / "config" / "contas_automacao.json", self.base / "bk", {},
                        {"dashboard_pasta_url": valor}, {}, ambiente={},
                    )
        self.assertIsNone(configuracao_local.validar_valor("link", "https://ux.legitimo.com/sites/x"))
        self.assertFalse((self.base / "config" / "contas_automacao.json").exists())
        nome = self.colocar(montar_zip({"config/contas_automacao.json": json.dumps({"dashboard_pasta_url": enganoso}).encode()}))
        self.assertEqual(self.previa(nome).json()["detail"], "Pacote recusado: conteúdo inválido em contas_automacao.json")

    def test_desfazer_com_cadastro_invalido_publica_estado_vazio(self):
        detalhes = "data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx"
        nome = self.preparar()
        self.gravar(detalhes, b"PK planilha corrompida")
        resposta = self.restaurar(nome, self.previa(nome).json()["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        desfazer = resposta.json()["pacote_desfazer"]
        self.carregar.return_value = False  # o cadastro devolvido não carrega
        resposta = self.restaurar(desfazer, self.previa(desfazer).json()["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual((self.base / detalhes).read_bytes(), b"PK planilha corrompida")
        self.assertIs(self.publicados[-1], self.estado_vazio)

    def test_invalidos_so_em_desfazer_criado_por_este_app(self):
        ruim = b'{"cnpj_faturamento": "11.111.111/1111-11"}'
        forjado = montar_zip({cliente_rel(): ruim}, tipo="desfazer", invalidos=[cliente_rel()])
        nome = self.colocar(forjado, "desfazer-20260101-000000.zip")
        self.assertEqual(self.previa(nome).json()["detail"], "Pacote recusado: manifesto ausente ou inválido")
        self.gravar("config/pacote_local.json", {"pasta": "", "desfazer_conhecidos": [hashlib.sha256(forjado).hexdigest()]})
        self.assertEqual(self.previa(nome).status_code, 200)  # o registro local é a única chave
        casos = (
            montar_zip({LEMBRETES: b"{}"}, invalidos=[LEMBRETES]),  # exportação nunca tem invalidos
            montar_zip({LEMBRETES: b"{}"}, tipo="desfazer", invalidos=[".env"]),  # fora dos arquivos
            montar_zip({".env": b"X=1"}, tipo="desfazer", invalidos=[".env"]),  # fora da allowlist
        )
        for indice, dados in enumerate(casos):
            with self.subTest(indice=indice):
                nome = self.colocar(dados, f"{'pacote-local' if indice == 0 else 'desfazer'}-2026010{indice + 2}-000000.zip")
                resposta = self.previa(nome)
                self.assertEqual(resposta.status_code, 422)
                self.assertIn(resposta.json()["detail"], ("Pacote recusado: manifesto ausente ou inválido",
                                                          "Pacote recusado: arquivo fora da lista permitida"))

    def test_links_alterados_sem_valor_pessoal(self):
        contas = "config/contas_automacao.json"
        self.gravar(contas, {"dashboard_pasta_url": "https://antigo.example.com/sites/a", "dashboard_email": "velho@exemplo.com"})
        self.gravar(cliente_rel(), {"contrato": "123", "cnpj_faturamento": ""})
        novo_contas = json.dumps({
            "dashboard_pasta_url": "https://novo.example.com:8443/sites/b?token=xyz#segredo",  # userinfo é recusado
            "endpoint_url": "https://endpoint.example.com/webclient",
            "dashboard_email": "pessoa@exemplo.com",
        }).encode()
        nome = self.colocar(montar_zip({
            contas: novo_contas,
            cliente_rel(): b'{"contrato": "456", "cnpj_faturamento": ""}',
            "config/representantes_regionais.json": b"{}",
            "data/state/assistente_instrucoes.json": b"{}",
            LEMBRETES: b"{}",
        }))
        resposta = self.previa(nome)
        rotulos = {link["chave"]: link["rotulo"] for link in pacote_local.LINKS}
        conta = next(item["rotulo"] for item in pacote_local.CONTAS if item["id"] == "conta_simpress")
        self.assertEqual(resposta.json()["links_alterados"], [
            {"rotulo": "Contrato", "antes": None, "depois": None},
            {"rotulo": rotulos["dashboard_pasta_url"], "antes": "antigo.example.com", "depois": "novo.example.com"},
            {"rotulo": rotulos["endpoint_url"], "antes": None, "depois": "endpoint.example.com"},
            {"rotulo": conta, "antes": None, "depois": None},
            {"rotulo": "Representantes regionais", "antes": None, "depois": None},
            {"rotulo": "Instruções do Assistente", "antes": None, "depois": None},
        ])
        for valor in ("segredo", "token", "xyz", "8443", "pessoa@", "velho@", "456", "/sites"):
            self.assertNotIn(valor, json.dumps(resposta.json()["links_alterados"]))
        self.assertEqual(self.previa(self.colocar(montar_zip({LEMBRETES: b"{}"}), "pacote-local-20260102-000000.zip"))
                         .json()["links_alterados"], [])

    def test_falha_depois_de_gravar_volta_os_arquivos(self):
        nome = self.preparar()
        token = self.previa(nome).json()["preview_token"]
        self.carregar.side_effect = RuntimeError(SEGREDO)
        resposta = self.restaurar(nome, token)
        self.assertEqual((resposta.status_code, resposta.json()["detail"]), (500, pacote_local.MSG_FALHA))
        self.assertEqual(self.estado(), self.alterado)
        self.assertEqual(self.publicados, [])
        self.assertEqual([p.name for p in self.pasta.iterdir()], [nome])  # o desfazer sem uso foi apagado
        self.assertEqual(self.registro().get("desfazer_conhecidos", []), [])  # o registro volta junto


class PastasDoPacoteTests(PacoteLocalBase):
    """Pastas inteiras (anexos do Sebrae e anotações pendentes): só nomes sintéticos."""

    def setUp(self):
        super().setUp()
        self.abrir(["UTIC-2026-1", "UTIC-2026-2", "UTIC-2026-3", "UTIC-2026-9"])

    def abrir(self, antigos, novos=(), outros_no_dashboard=()) -> None:
        """Dashboard importado com ``antigos`` EM ABERTO e a última busca do SoftExpert com ``novos``."""
        self.gravar("data/state/sebrae_dashboard_existentes.json", {
            "numeros": [*antigos, *outros_no_dashboard], "abertos": [{"numero": numero} for numero in antigos],
        })
        self.gravar("data/state/sebrae_novos.json", {"chamados": [{"numero": numero} for numero in novos]})

    def exportar(self):
        resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        with zipfile.ZipFile(self.pasta / resposta.json()["arquivo"]) as pacote:
            manifesto = json.loads(pacote.read("manifesto.json"))
            return resposta.json()["arquivo"], set(pacote.namelist()) - {"manifesto.json"}, manifesto

    def acoes(self, nome: str) -> dict:
        resposta = self.previa(nome)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return {item["caminho"]: item["acao"] for item in resposta.json()["itens"]}

    def juncao(self, alvo: Path, link: Path) -> None:
        if sys.platform == "win32":
            import _winapi

            _winapi.CreateJunction(str(alvo), str(link))
            self.assertTrue(link.is_junction())
        else:
            link.symlink_to(alvo, target_is_directory=True)

    def test_exporta_anexo_e_anotacao_sem_lock_nem_oculto(self):
        self.gravar(ANEXO, PDF)
        self.gravar(NOTA, NOTA_BYTES)
        pasta_anexo = (self.base / ANEXO).parent
        (pasta_anexo / ".teste.pdf.lock").write_bytes(b"\0")
        (pasta_anexo / ".oculto").write_bytes(b"x")
        (pasta_anexo / "leia.txt").write_bytes(b"x")  # fora da extensão da pasta
        self.gravar(f"{ANEXOS}/.oculta/escondido.pdf", PDF)
        (self.base / NOTA).with_name(f".{Path(NOTA).name}.lock").write_bytes(b"\0")
        primeiro, nomes, manifesto = self.exportar()
        self.assertEqual(nomes, {ANEXO, NOTA})
        self.assertEqual({item["caminho"] for item in manifesto["arquivos"]}, {ANEXO, NOTA})
        self.assertEqual([rel for rel in manifesto["ausentes"] if rel.startswith(PASTAS)], [])
        segundo, nomes, _ = self.exportar()
        self.assertNotEqual(primeiro, segundo)
        self.assertEqual(nomes, {ANEXO, NOTA})

    def test_link_e_juncao_dentro_da_pasta_ignorados(self):
        self.gravar(ANEXO, PDF)
        fora = self.base.parent / "fora"
        (fora / "sub").mkdir(parents=True)
        (fora / "segredo.pdf").write_bytes(PDF)
        (fora / "sub" / "outro.pdf").write_bytes(PDF)
        raiz = self.base / ANEXOS
        (raiz / "link.pdf").symlink_to(fora / "segredo.pdf")
        (raiz / "UTIC-2026-2").symlink_to(fora / "sub", target_is_directory=True)
        self.juncao(fora / "sub", raiz / "UTIC-2026-3")
        _, nomes, _ = self.exportar()
        self.assertEqual(nomes, {ANEXO})

    def test_raiz_da_pasta_como_link_recusada(self):
        fora = self.base.parent / "fora"
        fora.mkdir()
        (fora / "Pessoa Sintetica.pdf").write_bytes(PDF)
        (self.base / ANEXOS).symlink_to(fora, target_is_directory=True)
        resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual((resposta.status_code, resposta.json()["detail"]), (422, "Arquivo do app é um atalho: anexo do Sebrae"))
        self.assertFalse(self.pasta.exists() and any(self.pasta.iterdir()))

    def test_juncao_no_caminho_do_pacote_recusada_na_previa(self):
        fora = self.base.parent / "fora"
        fora.mkdir()
        (self.base / ANEXOS).mkdir(parents=True)
        self.juncao(fora, self.base / ANEXOS / "UTIC-2026-3")
        nome = self.colocar(montar_zip({f"{ANEXOS}/UTIC-2026-3/x.pdf": PDF}))
        resposta = self.previa(nome)
        self.assertEqual((resposta.status_code, resposta.json()["detail"]), (422, "Arquivo do app é um atalho: anexo do Sebrae"))
        self.assertEqual(list(fora.iterdir()), [])

    def test_restaura_o_que_falta_com_os_mesmos_bytes(self):
        self.gravar(ANEXO, PDF)
        self.gravar(NOTA, NOTA_BYTES)
        nome, _, _ = self.exportar()
        shutil.rmtree(self.base / ANEXOS)
        (self.base / NOTA).unlink()
        acoes = self.acoes(nome)
        self.assertEqual((acoes[ANEXO], acoes[NOTA]), ("criar", "criar"))
        with self.assertLogs("domains.pacote_local", level=logging.INFO) as logs:
            resposta = self.restaurar(nome, self.previa(nome).json()["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["criados"], 2)
        self.assertEqual(((self.base / ANEXO).read_bytes(), (self.base / NOTA).read_bytes()), (PDF, NOTA_BYTES))
        for nome_de_arquivo in ("teste.pdf", "UTIC", Path(NOTA).stem):  # LGPD: o log nunca leva nome nem caminho
            self.assertNotIn(nome_de_arquivo, "\n".join(logs.output))

    def test_ida_e_volta_com_desfazer_nunca_troca_nem_apaga_na_pasta(self):
        novo = f"{ANEXOS}/UTIC-2026-9/{'d' * 32}/outro.pdf"
        self.gravar(ANEXO, PDF)
        self.gravar(NOTA, NOTA_BYTES)
        self.gravar(LEMBRETES, {"lembretes": ["atual"]})
        lembretes = (self.base / LEMBRETES).read_bytes()
        nome = self.colocar(montar_zip({ANEXO: PDF + b" outra versao", novo: PDF, LEMBRETES: b'{"lembretes": []}'}))
        acoes = self.acoes(nome)
        self.assertEqual((acoes[ANEXO], acoes[novo], acoes[LEMBRETES]), ("manter", "criar", "substituir"))
        self.assertNotIn(NOTA, acoes)  # arquivo de pasta fora do pacote não aparece
        resposta = self.restaurar(nome, self.previa(nome).json()["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(((self.base / ANEXO).read_bytes(), (self.base / novo).read_bytes()), (PDF, PDF))

        desfazer = resposta.json()["pacote_desfazer"]
        with zipfile.ZipFile(self.pasta / desfazer) as pacote:
            self.assertEqual([rel for rel in pacote.namelist() if rel.startswith(PASTAS)], [])
        acoes = self.acoes(desfazer)
        self.assertEqual([rel for rel in acoes if rel.startswith(PASTAS)], [])
        resposta = self.restaurar(desfazer, self.previa(desfazer).json()["preview_token"])
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual((self.base / LEMBRETES).read_bytes(), lembretes)
        self.assertEqual(
            ((self.base / ANEXO).read_bytes(), (self.base / NOTA).read_bytes(), (self.base / novo).read_bytes()),
            (PDF, NOTA_BYTES, PDF),
        )

    def test_arquivo_novo_fora_do_pacote_nao_muda_o_token(self):
        self.gravar(LEMBRETES, {"lembretes": ["atual"]})
        nome = self.colocar(montar_zip({LEMBRETES: b'{"lembretes": []}'}))
        token = self.previa(nome).json()["preview_token"]
        self.gravar(ANEXO, PDF)  # chegou depois da prévia, fora do pacote
        resposta = self.restaurar(nome, token)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual((self.base / ANEXO).read_bytes(), PDF)

    def test_arquivo_que_aparece_no_caminho_a_criar_recusa(self):
        nome = self.colocar(montar_zip({ANEXO: PDF}))
        token = self.previa(nome).json()["preview_token"]
        self.gravar(ANEXO, PDF + b" baixado agora")
        resposta = self.restaurar(nome, token)
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (409, "Restauração recusada: o estado mudou desde a prévia; abra a prévia de novo"))
        self.assertEqual((self.base / ANEXO).read_bytes(), PDF + b" baixado agora")
        self.assertEqual([p.name for p in self.pasta.iterdir()], [nome])

    def test_caminho_de_pasta_em_ausentes_recusado(self):
        fora = "Pacote recusado: arquivo fora da lista permitida"
        resposta = self.previa(self.colocar(montar_zip({LEMBRETES: b"{}"}, ausentes=[ANEXO])))
        self.assertEqual((resposta.status_code, resposta.json()["detail"]), (422, fora))
        forjado = montar_zip({LEMBRETES: b"{}"}, tipo="desfazer", ausentes=[NOTA])
        self.gravar("config/pacote_local.json", {"pasta": "", "desfazer_conhecidos": [hashlib.sha256(forjado).hexdigest()]})
        resposta = self.previa(self.colocar(forjado, "desfazer-20260101-000000.zip"))
        self.assertEqual((resposta.status_code, resposta.json()["detail"]), (422, fora))

    def test_entradas_de_pasta_invalidas(self):
        casos = {
            f"{ANEXOS}/../x.pdf": "caminho inválido no pacote",
            f"{ANEXOS}/./x.pdf": "caminho inválido no pacote",
            f"{ANEXOS}/.oculta/x.pdf": "arquivo fora da lista permitida",
            f"{ANEXOS}/.x.pdf.lock": "arquivo fora da lista permitida",
            f"{ANEXOS}/x.txt": "arquivo fora da lista permitida",
            "data/state/anotacoes_historico_pendentes/x.pdf": "arquivo fora da lista permitida",
            ANEXOS: "arquivo fora da lista permitida",
            "data/state/SEBRAE_ANEXOS/x.pdf": "arquivo fora da lista permitida",
            "data/state/sebrae_anexos_outra/x.pdf": "arquivo fora da lista permitida",
        }
        for indice, (rel, motivo) in enumerate(casos.items()):
            with self.subTest(rel=rel):
                resposta = self.previa(self.colocar(montar_zip({rel: PDF}), f"pacote-local-2026010{indice + 1}-000000.zip"))
                self.assertEqual((resposta.status_code, resposta.json()["detail"]), (422, f"Pacote recusado: {motivo}"))

    def test_conteudo_de_pasta_validado_com_rotulo(self):
        self.assertEqual(self.acoes(self.colocar(montar_zip({ANEXO: PDF, NOTA: NOTA_BYTES}))), {ANEXO: "criar", NOTA: "criar"})
        registro = json.loads(NOTA_BYTES)
        casos = (
            ({ANEXO: b"nao e pdf"}, "anexo do Sebrae"),
            ({ANEXO: b""}, "anexo do Sebrae"),
            ({f"{ANEXOS}/UTIC-2026-1/Fulano + Sintetico.pdf": PDF}, "anexo do Sebrae"),  # nome que o app não gera
            ({NOTA: b"nao json"}, "anotação do histórico"),
            ({NOTA: json.dumps({**registro, "versao": 3}).encode()}, "anotação do histórico"),
        )
        for indice, (arquivos, rotulo) in enumerate(casos):
            with self.subTest(indice=indice):
                resposta = self.previa(self.colocar(montar_zip(arquivos), f"pacote-local-2026020{indice + 1}-000000.zip"))
                self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                                 (422, f"Pacote recusado: conteúdo inválido em {rotulo}"))
                self.assertNotIn("Fulano", resposta.text)
        self.gravar(f"{ANEXOS}/UTIC-2026-1/Fulano Sintetico.pdf", b"nao e pdf")  # arquivo atual inválido bloqueia exportar
        antes = set(self.pasta.iterdir())
        resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (422, "Pacote recusado: conteúdo inválido em anexo do Sebrae"))
        self.assertEqual(set(self.pasta.iterdir()), antes)

    def test_pdf_que_some_no_meio_da_exportacao_e_pulado(self):
        sumido = f"{ANEXOS}/UTIC-2026-2/sumido.pdf"
        self.gravar(ANEXO, PDF)
        self.gravar(sumido, PDF)
        ler = Path.read_bytes

        def ler_sumindo(caminho):
            if caminho.name == "sumido.pdf":
                raise FileNotFoundError(2, "sumiu", str(caminho))
            return ler(caminho)

        with mock.patch.object(Path, "read_bytes", ler_sumindo):
            resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        with zipfile.ZipFile(self.pasta / resposta.json()["arquivo"]) as pacote:
            self.assertEqual({rel for rel in pacote.namelist() if rel.startswith(PASTAS)}, {ANEXO})
            self.assertNotIn(sumido, json.loads(pacote.read("manifesto.json"))["ausentes"])

    def test_nomes_iguais_em_nfc_exporta_um_so(self):
        pasta = self.base / NOTA_PASTA
        pasta.mkdir(parents=True)
        (pasta / "café.json").write_bytes(NOTA_BYTES)
        (pasta / "café.json").write_bytes(NOTA_BYTES)
        if len(list(pasta.iterdir())) != 2:
            self.skipTest("o sistema de arquivos normaliza os nomes")
        _, nomes, _ = self.exportar()
        self.assertEqual(len([rel for rel in nomes if rel.startswith(NOTA_PASTA)]), 1)

    def anexos_exportados(self) -> set:
        _, nomes, _ = self.exportar()
        return {rel.split("/")[3] for rel in nomes if rel.startswith(ANEXOS + "/")}

    def test_so_anexos_de_chamado_aberto_e_nao_finalizado(self):
        self.abrir(["UTIC-2026-1", "UTIC-2026-5", "UTIC-2026-6"], novos=["UTIC-2026-2"], outros_no_dashboard=["UTIC-2026-7"])
        for pasta in ("UTIC-2026-1", "UTIC-2026-2", "UTIC-2026-5", "UTIC-2026-6", "UTIC-2026-7", "UTIC-2026-8",
                      "pasta-invalida", "UTIC-2026-1-copia"):
            self.gravar(f"{ANEXOS}/{pasta}/{'e' * 32}/teste.pdf", PDF)
        self.gravar(f"{ANEXOS}/teste.pdf", PDF)  # fora de pasta de chamado
        # Sem sebrae_finalizacao.json: nenhum chamado conta como finalizado.
        self.assertEqual(self.anexos_exportados(), {"UTIC-2026-1", "UTIC-2026-2", "UTIC-2026-5", "UTIC-2026-6"})
        self.gravar("data/state/sebrae_finalizacao.json", {
            "UTIC-2026-5": {"finalizacao": {"status": "ok"}},
            "UTIC-2026-6": {"finalizacao": {"status": "finalizado_outro_tecnico"}},
            "UTIC-2026-1": {"finalizacao": {"status": "incerto"}},  # não confirmado: segue aberto
        })
        self.assertEqual(self.anexos_exportados(), {"UTIC-2026-1", "UTIC-2026-2"})
        (self.base / "data" / "state" / "sebrae_dashboard_existentes.json").unlink()  # sem Dashboard importado
        self.assertEqual(self.anexos_exportados(), set())

    def test_historico_de_finalizacao_ilegivel_deixa_so_os_anexos_fora(self):
        self.gravar(ANEXO, PDF)
        self.gravar(NOTA, NOTA_BYTES)
        self.gravar(LEMBRETES, {"lembretes": []})
        self.gravar("data/state/sebrae_finalizacao.json", b'{"UTIC-2026-1": ')
        with self.assertLogs("domains.pacote_local", level=logging.WARNING) as logs:
            resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(set(resposta.json()), {"arquivo", "tamanho_bytes", "arquivos", "ausentes", "criado_em"})
        with zipfile.ZipFile(self.pasta / resposta.json()["arquivo"]) as pacote:
            self.assertEqual(set(pacote.namelist()), {"manifesto.json", NOTA, LEMBRETES})
        self.assertIn("pacote_local: anexos do Sebrae fora (histórico de finalização ilegível)", "\n".join(logs.output))
        self.assertNotIn("UTIC", "\n".join(logs.output))

    def test_falha_inesperada_ao_ler_chamados_deixa_so_os_anexos_fora(self):
        self.gravar(ANEXO, PDF)
        self.gravar(LEMBRETES, {"lembretes": []})
        with mock.patch.object(sebrae_finalizacao, "abertos_nao_finalizados", side_effect=ValueError("UTIC-2026-1")):
            with self.assertLogs("domains.pacote_local", level=logging.WARNING) as logs:
                resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        with zipfile.ZipFile(self.pasta / resposta.json()["arquivo"]) as pacote:
            self.assertEqual(set(pacote.namelist()), {"manifesto.json", LEMBRETES})
        self.assertIn("pacote_local: anexos do Sebrae fora (ValueError)", "\n".join(logs.output))
        self.assertNotIn("UTIC", "\n".join(logs.output))

    def test_anexo_grande_demais_sem_o_nome_na_mensagem(self):
        self.gravar(f"{ANEXOS}/UTIC-2026-1/Fulano Sintetico.pdf", PDF)
        self.montar(max_upload_bytes=10)
        resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual(resposta.status_code, 422)
        self.assertEqual(resposta.json()["detail"], "anexo do Sebrae passa do limite de 10 bytes.")
        self.assertNotIn("Fulano", resposta.text)
        self.assertNotIn("UTIC", resposta.text)

    def test_arquivos_demais_recusados_sem_nome(self):
        self.gravar(ANEXO, PDF)
        with mock.patch.object(pacote_local, "LIMITE_ENTRADAS", len(ALLOWLIST) + 1):
            resposta = self.client.post("/api/pacote-local/exportar")
        self.assertEqual((resposta.status_code, resposta.json()["detail"]),
                         (422, f"Arquivos demais para o pacote (limite {len(ALLOWLIST) + 1})."))


class PastaTests(PacoteLocalBase):
    def salvar(self, texto: str):
        return self.client.put("/api/pacote-local/pasta", json={"pasta": texto})

    def test_pastas_recusadas(self):
        (self.base / "static").mkdir()
        sincronizada = self.base / "OneDrive - Empresa" / "pacotes"
        sincronizada.mkdir(parents=True)
        outra = self.base / "Dropbox" / "x"
        outra.mkdir(parents=True)
        real = self.base / "real"
        real.mkdir()
        (self.base / "atalho").symlink_to(real, target_is_directory=True)
        rede = "Use uma pasta deste computador (sem OneDrive, rede ou unidade removível)."
        casos = {
            "\\\\servidor\\pasta": rede,
            "//servidor/pasta": rede,
            str(sincronizada): rede,
            str(outra): rede,
            str(self.base / "nao-existe"): "A pasta não existe ou não aceita escrita.",
            "relativa/pasta": "A pasta não existe ou não aceita escrita.",
            str(self.base / "static"): "Pasta não permitida.",
            str(self.base / "atalho"): "Pasta não permitida.",
        }
        (self.base / "data" / "outra").mkdir(parents=True)
        fora = self.base.parent / "fora"
        fora.mkdir()
        casos.update({
            str(self.base): "Pasta não permitida.",
            str(self.base / "data" / "outra"): "Pasta não permitida.",  # zip com dado pessoal iria ao Git
            f"{fora}/../app/data/outra": "Pasta não permitida.",
            f"{fora}\x00": "Pasta não permitida.",
            f"{fora}\nx": "Pasta não permitida.",
        })
        for texto, mensagem in casos.items():
            with self.subTest(texto=texto):
                resposta = self.salvar(texto)
                self.assertEqual((resposta.status_code, resposta.json()["detail"]), (422, mensagem))
        nuvem = self.base.parent / "nuvem"
        (nuvem / "p").mkdir(parents=True)
        with mock.patch.dict(os.environ, {"OneDrive": str(nuvem)}):
            self.assertEqual(self.salvar(str(nuvem / "p")).json()["detail"], rede)
            self.assertEqual(self.salvar(f"{fora}/../nuvem/p").json()["detail"], rede)  # .. não contorna
        with mock.patch.dict(os.environ, {"OneDriveCommercial": f"{fora}/../nuvem"}):
            self.assertEqual(self.salvar(str(nuvem / "p")).json()["detail"], rede)
        self.assertFalse((self.base / "config" / "pacote_local.json").exists())

    def test_salva_pasta_valida_e_volta_ao_padrao(self):
        escolhida = self.base.parent / "pacotes"
        escolhida.mkdir()
        resposta = self.salvar(str(escolhida))
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual((resposta.json()["pasta"], resposta.json()["pasta_padrao"]), (str(escolhida), False))
        self.gravar(LEMBRETES, {"a": 1})
        arquivo = self.client.post("/api/pacote-local/exportar").json()["arquivo"]
        self.assertTrue((escolhida / arquivo).is_file())
        self.assertTrue(self.salvar("").json()["pasta_padrao"])

    def test_salvar_pasta_preserva_o_registro_de_desfazer(self):
        conhecidos = ["a" * 64, "b" * 64]
        self.gravar("config/pacote_local.json", {"pasta": "", "desfazer_conhecidos": conhecidos})
        escolhida = self.base.parent / "pacotes"
        escolhida.mkdir()
        self.assertEqual(self.salvar(str(escolhida)).status_code, 200)
        gravado = json.loads((self.base / "config" / "pacote_local.json").read_text(encoding="utf-8"))
        self.assertEqual(gravado, {"pasta": str(escolhida), "desfazer_conhecidos": conhecidos})

    def test_hd_usb_e_cartao_recusados_no_windows(self):
        escolhida = self.base.parent / "pacotes"
        escolhida.mkdir()
        rede = "Use uma pasta deste computador (sem OneDrive, rede ou unidade removível)."
        casos = ((3, 7, 422), (3, 4, 422), (3, 9, 422), (3, 12, 422), (3, 13, 422), (3, None, 422), (2, 11, 422),
                 (3, 11, 200), (3, 17, 200))  # USB, 1394, iSCSI, SD, MMC, consulta falhou, removível; SATA e NVMe passam
        for unidade, barramento, status in casos:
            with self.subTest(unidade=unidade, barramento=barramento), \
                    mock.patch.object(pacote_local, "_WINDOWS", True), \
                    mock.patch.object(pacote_local, "_tipo_de_unidade", return_value=unidade), \
                    mock.patch.object(pacote_local, "_tipo_de_barramento", return_value=barramento):
                resposta = self.salvar(str(escolhida))
                self.assertEqual(resposta.status_code, status, resposta.text)
                if status == 422:
                    self.assertEqual(resposta.json()["detail"], rede)

    def test_pasta_configurada_que_sumiu(self):
        self.gravar("config/pacote_local.json", {"pasta": str(self.base / "sumiu")})
        lista = self.client.get("/api/pacote-local").json()
        self.assertEqual((lista["pacotes"], lista["erro_pasta"]), ([], "A pasta não existe ou não aceita escrita."))


class AssistenteTests(unittest.TestCase):
    def test_prompt_diz_que_o_assistente_nao_mexe_no_pacote(self):
        from domains.assistant_chat import SYSTEM_PROMPT

        self.assertIn("Pacote local (fim da Configuração local)", SYSTEM_PROMPT)
        self.assertIn("Você não exporta, não lista e não restaura pacotes.", SYSTEM_PROMPT)


class AcessoTests(PacoteLocalBase):
    def test_so_neste_computador_mesmo_com_rede_ligada(self):
        rede = TestClient(self.client.app, client=("192.168.0.20", 1234))
        with mock.patch.dict(os.environ, {"SIMPRESS_ACESSO_REDE": "1", "SIMPRESS_ACESSO_TAILSCALE": "1"}):
            chamadas = (
                rede.get("/api/pacote-local"),
                rede.get(f"/api/pacote-local/{NOME}/previa"),
                rede.put("/api/pacote-local/pasta", json={"pasta": ""}),
                rede.post("/api/pacote-local/exportar"),
                rede.post(f"/api/pacote-local/{NOME}/restaurar", json={"preview_token": "0" * 64, "confirmado": True}),
                TestClient(self.client.app, client=("100.100.1.1", 1234)).post("/api/pacote-local/exportar"),
            )
        for resposta in chamadas:
            self.assertEqual((resposta.status_code, resposta.json()["detail"]), (403, "Disponível só neste computador."))
        self.assertFalse(self.pasta.exists() and any(self.pasta.iterdir()))

    def test_rota_sem_cookie_401(self):
        import main

        client = TestClient(main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}", client=LOCAL)
        for metodo, caminho in (("get", "/api/pacote-local"), ("post", "/api/pacote-local/exportar"),
                                ("get", f"/api/pacote-local/{NOME}/previa")):
            self.assertEqual(getattr(client, metodo)(caminho).status_code, 401)
        self.assertEqual(client.put("/api/pacote-local/pasta", json={"pasta": ""}).status_code, 401)
        restaurar = client.post(f"/api/pacote-local/{NOME}/restaurar", json={"preview_token": "0" * 64, "confirmado": True})
        self.assertEqual(restaurar.status_code, 401)


if __name__ == "__main__":
    unittest.main()

