"""Arquivo JSON ilegível nunca é regravado sem preservar o original (dados sintéticos, diretório temporário)."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core import integrity
from domains import local_setup, sebrae_credenciais, sebrae_finalizacao as fin
from domains.assistant_conversas import ConversasStore
from domains.assistant_notas import NotasStore
from tests.test_sebrae_dashboard_gravacao import montar
from tests.test_sebrae_dashboard_router import RotasBase

LIXO = b'{"conversas": [ {"id": "a", "mensagens": ['  # JSON truncado
SENHAS = b'{"UTIC-2026-0001": ["Abc12345"'  # truncado, com senha sintética
RAIZ = Path(__file__).resolve().parents[1]


def quarentenas(arquivo: Path):
    return sorted(arquivo.parent.glob(f"{arquivo.stem}.corrompido-*{arquivo.suffix}"))


def pasta_temporaria(teste: unittest.TestCase) -> Path:
    tmp = tempfile.TemporaryDirectory()
    teste.addCleanup(tmp.cleanup)
    return Path(tmp.name)


def nomes(pasta: Path):
    return sorted(p.name for p in pasta.iterdir() if not p.name.endswith(".lock") and not p.name.startswith("."))


class CredenciaisIlegiveisTest(unittest.TestCase):
    def setUp(self):
        self.dir = pasta_temporaria(self)
        self.arquivo = sebrae_credenciais.caminho(self.dir)
        self.arquivo.write_bytes(SENHAS)

    def test_guardar_recusa_sem_tocar_e_sem_copia(self):
        with self.assertRaises(sebrae_credenciais.CredenciaisIlegiveisError) as erro:
            sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Senha: Xyz98765")
        texto = str(erro.exception)
        self.assertNotIn("Abc12345", texto)
        self.assertNotIn("Xyz98765", texto)
        self.assertNotIn("apague", texto.lower())  # o arquivo pode só estar travado
        self.assertEqual(self.arquivo.read_bytes(), SENHAS)
        self.assertEqual(nomes(self.dir), [self.arquivo.name])

    def test_remover_recusa_sem_tocar(self):
        with self.assertRaises(sebrae_credenciais.CredenciaisIlegiveisError):
            sebrae_credenciais.remover(self.dir, "UTIC-2026-0001")
        self.assertEqual(self.arquivo.read_bytes(), SENHAS)

    def test_leitura_da_tela_devolve_vazio_sem_regravar_e_avisa_so_o_tipo(self):
        with self.assertLogs(sebrae_credenciais.__name__, level="WARNING") as logs:
            self.assertEqual(sebrae_credenciais.numeros(self.dir), frozenset())
            self.assertEqual(sebrae_credenciais.ler(self.dir, "UTIC-2026-0001"), [])
        self.assertEqual(self.arquivo.read_bytes(), SENHAS)
        saida = "\n".join(logs.output)
        self.assertIn("JSONDecodeError", saida)
        self.assertNotIn("Abc12345", saida)
        self.assertNotIn("UTIC-2026-0001", saida)

    def test_estrutura_errada_tambem_recusa(self):
        self.arquivo.write_text('["lista"]', encoding="utf-8")
        with self.assertRaises(sebrae_credenciais.CredenciaisIlegiveisError):
            sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Senha: Xyz98765")
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), '["lista"]')

    def test_erro_de_leitura_nao_json_recusa_sem_gravar_e_sem_copia(self):
        self.arquivo.write_text('{"UTIC-2026-0001": ["Abc12345"]}', encoding="utf-8")
        with patch.object(Path, "read_text", side_effect=PermissionError("travado")):
            with self.assertRaises(sebrae_credenciais.CredenciaisIlegiveisError):
                sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Senha: Xyz98765")
        self.assertEqual(json.loads(self.arquivo.read_text(encoding="utf-8")), {"UTIC-2026-0001": ["Abc12345"]})
        self.assertEqual(nomes(self.dir), [self.arquivo.name])

    def test_remover_encerrados_nao_levanta_e_nao_regrava(self):
        sebrae_credenciais.remover_encerrados(self.dir, {"UTIC-2026-0001": {"status": "FINALIZADO"}}, [])
        self.assertEqual(self.arquivo.read_bytes(), SENHAS)

    def test_arquivo_ausente_continua_funcionando(self):
        self.arquivo.unlink()
        self.assertEqual(sebrae_credenciais.numeros(self.dir), frozenset())
        sebrae_credenciais.remover(self.dir, "UTIC-2026-0001")
        self.assertTrue(sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Senha: Xyz98765"))
        self.assertEqual(sebrae_credenciais.ler(self.dir, "UTIC-2026-0002"), ["Xyz98765"])


class ImportacaoComSenhasIlegiveisTest(RotasBase):
    def test_importacao_segue_e_arquivo_de_senhas_fica_intacto(self):
        pasta = self.caminhos.existentes.parent
        arquivo = sebrae_credenciais.caminho(pasta)
        arquivo.write_bytes(SENHAS)
        with self.assertLogs(level="WARNING") as logs:
            resposta = self.importar(montar())  # 0002 FINALIZADO: tentaria apagar a senha
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(arquivo.read_bytes(), SENHAS)
        saida = "\n".join(logs.output)
        self.assertIn("JSONDecodeError", saida)
        self.assertNotIn("Abc12345", saida)


class ConversasCorrompidasTest(unittest.TestCase):
    def setUp(self):
        self.arquivo = pasta_temporaria(self) / "conversas.json"

    def test_registrar_poe_o_original_em_quarentena_e_segue(self):
        self.arquivo.write_bytes(LIXO)
        store = ConversasStore(self.arquivo)
        self.assertEqual(store.listar(), [])  # leitura não mexe
        self.assertEqual(quarentenas(self.arquivo), [])
        store.registrar("x", "usuario", "olá")
        copias = quarentenas(self.arquivo)
        self.assertEqual(len(copias), 1)
        self.assertEqual(copias[0].read_bytes(), LIXO)
        self.assertEqual([c["id"] for c in store.listar()], ["x"])

    def test_apagar_de_id_inexistente_nao_copia_nem_grava(self):
        self.arquivo.write_bytes(LIXO)
        for _ in range(3):
            self.assertFalse(ConversasStore(self.arquivo).apagar("x"))
        self.assertEqual(quarentenas(self.arquivo), [])
        self.assertEqual(self.arquivo.read_bytes(), LIXO)

    def test_texto_nao_utf8_conta_como_corrompido(self):
        self.arquivo.write_bytes(b'{"conversas": "\xff\xfe"}')
        ConversasStore(self.arquivo).registrar("x", "usuario", "olá")
        self.assertEqual(quarentenas(self.arquivo)[0].read_bytes(), b'{"conversas": "\xff\xfe"}')

    def test_erro_de_leitura_nao_json_nao_grava_nem_copia(self):
        self.arquivo.write_text('{"conversas": []}', encoding="utf-8")
        with patch.object(Path, "read_text", side_effect=PermissionError("travado")):
            with self.assertRaises(PermissionError):
                ConversasStore(self.arquivo).registrar("x", "usuario", "olá")
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), '{"conversas": []}')
        self.assertEqual(quarentenas(self.arquivo), [])

    def test_falha_da_copia_nao_grava_e_preserva_o_original(self):
        self.arquivo.write_bytes(LIXO)
        with patch.object(integrity.shutil, "copyfileobj", side_effect=OSError("disco cheio")):
            with self.assertRaises(OSError):
                ConversasStore(self.arquivo).registrar("x", "usuario", "olá")
        self.assertEqual(self.arquivo.read_bytes(), LIXO)

    def test_arquivo_ausente_nao_cria_quarentena(self):
        store = ConversasStore(self.arquivo)
        store.registrar("x", "usuario", "olá")
        self.assertEqual(quarentenas(self.arquivo), [])
        self.assertEqual(len(store.listar()), 1)


class NotasCorrompidasTest(unittest.TestCase):
    def setUp(self):
        self.arquivo = pasta_temporaria(self) / "notas.json"

    def test_criar_poe_o_original_em_quarentena_e_segue(self):
        self.arquivo.write_bytes(b'{"notas": [ {"id": ')
        store = NotasStore(self.arquivo)
        self.assertEqual(store.listar(), [])
        self.assertEqual(quarentenas(self.arquivo), [])
        store.criar("Comprar toner")
        copias = quarentenas(self.arquivo)
        self.assertEqual([c.read_bytes() for c in copias], [b'{"notas": [ {"id": '])
        self.assertEqual([n["texto"] for n in store.listar()], ["Comprar toner"])

    def test_marcar_e_apagar_de_id_inexistente_e_criar_invalido_nao_copiam(self):
        self.arquivo.write_bytes(b"nao e json")
        store = NotasStore(self.arquivo)
        self.assertIsNone(store.marcar("x"))
        self.assertFalse(store.apagar("x"))
        with self.assertRaises(ValueError):
            store.criar("")
        self.assertEqual(quarentenas(self.arquivo), [])
        self.assertEqual(self.arquivo.read_bytes(), b"nao e json")

    def test_erro_de_leitura_nao_json_nao_grava_nem_copia(self):
        self.arquivo.write_text('{"notas": []}', encoding="utf-8")
        with patch.object(Path, "read_text", side_effect=PermissionError("travado")):
            with self.assertRaises(PermissionError):
                NotasStore(self.arquivo).criar("Comprar toner")
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), '{"notas": []}')
        self.assertEqual(quarentenas(self.arquivo), [])

    def test_falha_da_copia_nao_grava_e_preserva_o_original(self):
        self.arquivo.write_bytes(b"nao e json")
        with patch.object(integrity.shutil, "copyfileobj", side_effect=OSError("disco cheio")):
            with self.assertRaises(OSError):
                NotasStore(self.arquivo).criar("Comprar toner")
        self.assertEqual(self.arquivo.read_bytes(), b"nao e json")

    def test_arquivo_ausente_nao_cria_quarentena(self):
        NotasStore(self.arquivo).criar("Lembrete")
        self.assertEqual(quarentenas(self.arquivo), [])


class ConfigLocalCorrompidaTest(unittest.TestCase):
    def setUp(self):
        self.dir = pasta_temporaria(self)

    def test_representantes_regionais_preserva_o_original(self):
        arquivo = self.dir / "representantes_regionais.json"
        arquivo.write_bytes(b'{"Cascavel": {"nome"')
        local_setup.save_regional_representative(arquivo, "Cascavel", {"horario": "09:00"}, self.dir / "padroes.json")
        copias = quarentenas(arquivo)
        self.assertEqual([c.read_bytes() for c in copias], [b'{"Cascavel": {"nome"'])
        self.assertIsInstance(json.loads(arquivo.read_text(encoding="utf-8")), dict)

    def test_representantes_regionais_ausente_nao_cria_quarentena(self):
        arquivo = self.dir / "representantes_regionais.json"
        local_setup.save_regional_representative(arquivo, "Cascavel", {"horario": "09:00"}, self.dir / "padroes.json")
        self.assertEqual(quarentenas(arquivo), [])

    def test_representantes_regionais_erro_de_leitura_nao_json_nao_grava_nem_copia(self):
        arquivo = self.dir / "representantes_regionais.json"
        arquivo.write_text("{}", encoding="utf-8")
        with patch.object(Path, "read_text", side_effect=PermissionError("travado")):
            with self.assertRaises(PermissionError):
                local_setup.save_regional_representative(arquivo, "Cascavel", {"horario": "09:00"}, self.dir / "padroes.json")
        self.assertEqual(arquivo.read_text(encoding="utf-8"), "{}")
        self.assertEqual(quarentenas(arquivo), [])

    def test_cliente_preserva_o_original(self):
        arquivo = self.dir / "cliente.json"
        arquivo.write_bytes(b'{"contrato": "X"')
        local_setup.save_client_config(arquivo, "Contrato 1", "00.000.000/0000-00", [])
        self.assertEqual([c.read_bytes() for c in quarentenas(arquivo)], [b'{"contrato": "X"'])
        self.assertEqual(json.loads(arquivo.read_text(encoding="utf-8"))["contrato"], "Contrato 1")

    def test_cliente_falha_da_copia_nao_grava(self):
        arquivo = self.dir / "cliente.json"
        arquivo.write_bytes(b'{"contrato": "X"')
        with patch.object(integrity.shutil, "copyfileobj", side_effect=OSError("disco cheio")):
            with self.assertRaises(OSError):
                local_setup.save_client_config(arquivo, "Contrato 1", "00.000.000/0000-00", [])
        self.assertEqual(arquivo.read_bytes(), b'{"contrato": "X"')

    def test_cliente_erro_de_leitura_nao_json_nao_grava_nem_copia(self):
        arquivo = self.dir / "cliente.json"
        arquivo.write_text('{"contrato": "X"}', encoding="utf-8")
        with patch.object(Path, "read_text", side_effect=PermissionError("travado")):
            with self.assertRaises(PermissionError):
                local_setup.save_client_config(arquivo, "Contrato 1", "00.000.000/0000-00", [])
        self.assertEqual(arquivo.read_text(encoding="utf-8"), '{"contrato": "X"}')
        self.assertEqual(quarentenas(arquivo), [])

    def test_cliente_ausente_nao_cria_quarentena(self):
        arquivo = self.dir / "cliente.json"
        local_setup.save_client_config(arquivo, "Contrato 1", "00.000.000/0000-00", [])
        self.assertEqual(quarentenas(arquivo), [])


class ConflitosCorrompidosTest(unittest.TestCase):
    def setUp(self):
        self.dir = pasta_temporaria(self)
        self.arquivo = fin.caminho_conflitos(self.dir)

    def gravar(self):
        fin.gravar_conflitos(self.dir, base_sha256="a", sharepoint_sha256="b", gerado_sha256="c", conflitos=[])

    def test_gravar_conflitos_preserva_o_original(self):
        self.arquivo.write_bytes(b'{"escolhas": {"A1"')
        self.gravar()
        self.assertEqual([c.read_bytes() for c in quarentenas(self.arquivo)], [b'{"escolhas": {"A1"'])
        self.assertEqual(fin.escolhas_dos_conflitos(self.dir), {})

    def test_concluir_conflitos_preserva_o_original(self):
        self.arquivo.write_bytes(b"lixo")
        fin.concluir_conflitos(self.dir)
        self.assertEqual([c.read_bytes() for c in quarentenas(self.arquivo)], [b"lixo"])

    def test_falha_da_copia_nao_grava_nem_apaga(self):
        self.arquivo.write_bytes(b"lixo")
        with patch.object(integrity.shutil, "copyfileobj", side_effect=OSError("disco cheio")):
            with self.assertRaises(OSError):
                self.gravar()
            with self.assertRaises(OSError):
                fin.concluir_conflitos(self.dir)
        self.assertEqual(self.arquivo.read_bytes(), b"lixo")

    def test_erro_de_leitura_nao_json_nao_grava_nem_copia(self):
        self.arquivo.write_text('{"escolhas": {"A1": "site"}}', encoding="utf-8")
        with patch.object(Path, "read_text", side_effect=PermissionError("travado")):
            with self.assertRaises(PermissionError):
                self.gravar()
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), '{"escolhas": {"A1": "site"}}')
        self.assertEqual(quarentenas(self.arquivo), [])

    def test_escolhas_validas_sao_mantidas_sem_quarentena(self):
        self.arquivo.write_text('{"escolhas": {"A1": "site"}}', encoding="utf-8")
        self.gravar()
        self.assertEqual(fin.escolhas_dos_conflitos(self.dir), {"A1": "site"})
        self.assertEqual(quarentenas(self.arquivo), [])

    def test_arquivo_ausente_nao_cria_quarentena(self):
        self.gravar()
        self.assertEqual(quarentenas(self.arquivo), [])


class QuarentenaTest(unittest.TestCase):
    def test_arquivo_que_sumiu_nao_tem_o_que_preservar(self):
        self.assertIsNone(integrity.quarantine_corrupt_file(pasta_temporaria(self) / "sumiu.json"))

    def test_copias_do_mesmo_segundo_nao_se_sobrescrevem(self):
        arquivo = pasta_temporaria(self) / "a.json"
        arquivo.write_bytes(b"um")
        primeira = integrity.quarantine_corrupt_file(arquivo)
        arquivo.write_bytes(b"dois")
        segunda = integrity.quarantine_corrupt_file(arquivo)
        self.assertNotEqual(primeira, segunda)
        self.assertEqual((primeira.read_bytes(), segunda.read_bytes()), (b"um", b"dois"))


@unittest.skipUnless(shutil.which("git"), "git indisponível")
class GitignoreDaQuarentenaTest(unittest.TestCase):
    def test_copias_de_quarentena_sao_ignoradas_em_qualquer_pasta(self):
        caminhos = [
            "config/cliente.corrompido-20261126-101500.json",
            "config/representantes_regionais.corrompido-20261126-101500-1.json",
            "data/state/assistente_conversas.corrompido-20261126-101500.json",
            "data/state/sebrae_dashboard_conflitos.corrompido-20261126-101500.json",
            "outra_pasta/qualquer.corrompido-20261126-101500.json",
        ]
        resultado = subprocess.run(
            ["git", "check-ignore", "--no-index", *caminhos], cwd=RAIZ, capture_output=True, text=True, check=False
        )
        self.assertEqual(sorted(resultado.stdout.split()), sorted(caminhos), resultado.stderr)


if __name__ == "__main__":
    unittest.main()
