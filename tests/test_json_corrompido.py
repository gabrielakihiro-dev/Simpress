"""Arquivo JSON ilegível nunca é regravado sem preservar o original (dados sintéticos, diretório temporário)."""

import json
import tempfile
import unittest
from pathlib import Path

from domains import local_setup, sebrae_credenciais, sebrae_finalizacao as fin
from domains.assistant_conversas import ConversasStore
from domains.assistant_notas import NotasStore

LIXO = b'{"conversas": [ {"id": "a", "mensagens": ['  # JSON truncado
SENHAS = b'{"UTIC-2026-0001": ["Abc12345"'  # truncado, com senha sintética


def quarentenas(arquivo: Path):
    return sorted(arquivo.parent.glob(f"{arquivo.stem}.corrompido-*{arquivo.suffix}"))


class CredenciaisIlegiveisTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.arquivo = sebrae_credenciais.caminho(self.dir)
        self.arquivo.write_bytes(SENHAS)

    def test_guardar_recusa_sem_tocar_e_sem_copia(self):
        with self.assertRaises(sebrae_credenciais.CredenciaisIlegiveisError) as erro:
            sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Senha: Xyz98765")
        self.assertNotIn("Abc12345", str(erro.exception))
        self.assertNotIn("Xyz98765", str(erro.exception))
        self.assertEqual(self.arquivo.read_bytes(), SENHAS)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir() if p.suffix == ".json"), [self.arquivo.name])

    def test_remover_recusa_sem_tocar(self):
        with self.assertRaises(sebrae_credenciais.CredenciaisIlegiveisError):
            sebrae_credenciais.remover(self.dir, "UTIC-2026-0001")
        self.assertEqual(self.arquivo.read_bytes(), SENHAS)

    def test_leitura_da_tela_devolve_vazio_sem_regravar(self):
        self.assertEqual(sebrae_credenciais.numeros(self.dir), frozenset())
        self.assertEqual(sebrae_credenciais.ler(self.dir, "UTIC-2026-0001"), [])
        self.assertEqual(self.arquivo.read_bytes(), SENHAS)

    def test_estrutura_errada_tambem_recusa(self):
        self.arquivo.write_text('["lista"]', encoding="utf-8")
        with self.assertRaises(sebrae_credenciais.CredenciaisIlegiveisError):
            sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Senha: Xyz98765")
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), '["lista"]')

    def test_remover_encerrados_na_importacao_nao_levanta(self):
        sebrae_credenciais.remover_encerrados(self.dir, {"UTIC-2026-0001": {"status": "FINALIZADO"}}, [])
        self.assertEqual(self.arquivo.read_bytes(), SENHAS)

    def test_arquivo_ausente_continua_funcionando(self):
        self.arquivo.unlink()
        self.assertEqual(sebrae_credenciais.numeros(self.dir), frozenset())
        sebrae_credenciais.remover(self.dir, "UTIC-2026-0001")
        self.assertTrue(sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Senha: Xyz98765"))
        self.assertEqual(sebrae_credenciais.ler(self.dir, "UTIC-2026-0002"), ["Xyz98765"])


class ConversasCorrompidasTest(unittest.TestCase):
    def setUp(self):
        self.arquivo = Path(tempfile.mkdtemp()) / "conversas.json"

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

    def test_apagar_tambem_preserva(self):
        self.arquivo.write_bytes(LIXO)
        self.assertFalse(ConversasStore(self.arquivo).apagar("x"))
        self.assertEqual(quarentenas(self.arquivo)[0].read_bytes(), LIXO)

    def test_arquivo_ausente_nao_cria_quarentena(self):
        store = ConversasStore(self.arquivo)
        store.registrar("x", "usuario", "olá")
        self.assertEqual(quarentenas(self.arquivo), [])
        self.assertEqual(len(store.listar()), 1)


class NotasCorrompidasTest(unittest.TestCase):
    def setUp(self):
        self.arquivo = Path(tempfile.mkdtemp()) / "notas.json"

    def test_criar_poe_o_original_em_quarentena_e_segue(self):
        self.arquivo.write_bytes(b'{"notas": [ {"id": ')
        store = NotasStore(self.arquivo)
        self.assertEqual(store.listar(), [])
        self.assertEqual(quarentenas(self.arquivo), [])
        store.criar("Comprar toner")
        copias = quarentenas(self.arquivo)
        self.assertEqual([c.read_bytes() for c in copias], [b'{"notas": [ {"id": '])
        self.assertEqual([n["texto"] for n in store.listar()], ["Comprar toner"])

    def test_marcar_e_apagar_preservam(self):
        self.arquivo.write_bytes(b"nao e json")
        store = NotasStore(self.arquivo)
        self.assertIsNone(store.marcar("x"))
        self.assertFalse(store.apagar("x"))
        self.assertEqual(quarentenas(self.arquivo)[0].read_bytes(), b"nao e json")

    def test_arquivo_ausente_nao_cria_quarentena(self):
        NotasStore(self.arquivo).criar("Lembrete")
        self.assertEqual(quarentenas(self.arquivo), [])


class ConfigLocalCorrompidaTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

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

    def test_cliente_preserva_o_original(self):
        arquivo = self.dir / "cliente.json"
        arquivo.write_bytes(b'{"contrato": "X"')
        local_setup.save_client_config(arquivo, "Contrato 1", "00.000.000/0000-00", [])
        self.assertEqual([c.read_bytes() for c in quarentenas(arquivo)], [b'{"contrato": "X"'])
        self.assertEqual(json.loads(arquivo.read_text(encoding="utf-8"))["contrato"], "Contrato 1")

    def test_cliente_ausente_nao_cria_quarentena(self):
        arquivo = self.dir / "cliente.json"
        local_setup.save_client_config(arquivo, "Contrato 1", "00.000.000/0000-00", [])
        self.assertEqual(quarentenas(arquivo), [])


class ConflitosCorrompidosTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.arquivo = fin.caminho_conflitos(self.dir)

    def test_gravar_conflitos_preserva_o_original(self):
        self.arquivo.write_bytes(b'{"escolhas": {"A1"')
        fin.gravar_conflitos(self.dir, base_sha256="a", sharepoint_sha256="b", gerado_sha256="c", conflitos=[])
        self.assertEqual([c.read_bytes() for c in quarentenas(self.arquivo)], [b'{"escolhas": {"A1"'])
        self.assertEqual(fin.escolhas_dos_conflitos(self.dir), {})

    def test_concluir_conflitos_preserva_o_original(self):
        self.arquivo.write_bytes(b"lixo")
        fin.concluir_conflitos(self.dir)
        self.assertEqual([c.read_bytes() for c in quarentenas(self.arquivo)], [b"lixo"])

    def test_arquivo_ausente_nao_cria_quarentena(self):
        fin.gravar_conflitos(self.dir, base_sha256="a", sharepoint_sha256="b", gerado_sha256="c", conflitos=[])
        self.assertEqual(quarentenas(self.arquivo), [])


if __name__ == "__main__":
    unittest.main()
