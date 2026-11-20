"""Senha do chamado no F5 (exceção de LGPD autorizada em 19/11/2026): só dados sintéticos."""

import json
import tempfile
import unittest
from pathlib import Path

from domains import sebrae_credenciais, sebrae_novos
from domains.sebrae_chamados import ChamadoSoftExpert
from tests import test_sebrae_fechar as fechar
from tests import test_sebrae_leitura as leitura
from tests.test_sebrae_dashboard_router import RotasBase

DESCRICAO = "Usuário criado\nSenha: Abc12345\nCPF 123.456.789-09"


class ExtrairTest(unittest.TestCase):
    def test_devolve_o_que_a_mascara_esconde(self):
        self.assertEqual(sebrae_credenciais.extrair(DESCRICAO), ["Abc12345"])
        self.assertEqual(sebrae_credenciais.extrair("a senha temporária foi Xyz98765"), ["Xyz98765"])
        self.assertEqual(sebrae_credenciais.extrair("login\nfulano@exemplo.com\nQwerty123"), ["Qwerty123"])
        self.assertEqual(sebrae_credenciais.extrair("Use Sebrae@2026 no acesso", "Senha: Sebrae@2026"), ["Sebrae@2026"])

    def test_texto_sem_senha_nao_devolve_nada(self):
        self.assertEqual(sebrae_credenciais.extrair("Teclado com defeito", "", None), [])


class GuardarTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_guarda_so_os_valores_le_e_remove(self):
        self.assertTrue(sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Teclado", DESCRICAO))
        bruto = (self.dir / sebrae_credenciais.ARQUIVO).read_text(encoding="utf-8")
        self.assertEqual(json.loads(bruto), {"UTIC-2026-0002": ["Abc12345"]})
        self.assertNotIn("123.456", bruto)  # nunca a descrição inteira
        self.assertEqual(sebrae_credenciais.numeros(self.dir), {"UTIC-2026-0002"})
        sebrae_credenciais.remover(self.dir, "UTIC-2026-0002")
        self.assertEqual(sebrae_credenciais.ler(self.dir, "UTIC-2026-0002"), [])

    def test_sem_senha_nao_cria_arquivo(self):
        self.assertFalse(sebrae_credenciais.guardar(self.dir, "UTIC-2026-0002", "Teclado"))
        self.assertFalse((self.dir / sebrae_credenciais.ARQUIVO).exists())


class LeituraGuardaSenhaTest(unittest.TestCase):
    setUp, rodar = leitura.LeituraTest.setUp, leitura.LeituraTest.rodar  # só o preparo, sem herdar os testes de lá

    def test_leitura_guarda_a_senha_a_parte_e_o_json_da_tela_continua_mascarado(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "d.xlsx")
        leituras = {"UTIC-2026-0002": ChamadoSoftExpert("UTIC-2026-0002", titulo="Acesso", descricao=DESCRICAO)}
        self.rodar([leitura.item("UTIC-2026-0002", "Acesso")], leituras)
        self.assertNotIn("Abc12345", self.caminhos.novos.read_text(encoding="utf-8"))
        self.assertEqual(sebrae_credenciais.ler(self.dir, "UTIC-2026-0002"), ["Abc12345"])
        self.assertFalse(any("Abc12345" in texto for texto in self.rotinas.logs))


class FinalizarApagaSenhaTest(fechar.FecharBase):
    def test_finalizado_no_softexpert_apaga_a_senha_guardada(self):
        sebrae_credenciais.guardar(self.dir, fechar.B, DESCRICAO)
        sebrae_credenciais.guardar(self.dir, fechar.C, DESCRICAO)
        self.descrever(fechar.B)
        self.rodar({fechar.B: fechar.ok()}, [fechar.B])
        self.assertEqual(sebrae_credenciais.numeros(self.dir), {fechar.C})


class RotaCredenciaisTest(RotasBase):
    def test_lista_so_traz_o_sinal_e_a_rota_traz_o_valor_sem_cache(self):
        self.importar()
        chamado = ChamadoSoftExpert("UTIC-2026-1378", titulo="Acesso", descricao=DESCRICAO)
        sebrae_novos.salvar_novos(self.caminhos.novos, [chamado], [], 0, {})
        sebrae_credenciais.guardar(self.caminhos.existentes.parent, chamado.numero, DESCRICAO)
        lista = self.cliente.get("/api/sebrae/novos")
        self.assertNotIn("Abc12345", lista.text)
        self.assertTrue(lista.json()["novos"]["formulario"][0]["tem_credencial"])
        resposta = self.cliente.get("/api/sebrae/chamados/utic-2026-1378/credenciais")
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json(), {"numero": "UTIC-2026-1378", "credenciais": ["Abc12345"]})
        self.assertEqual(resposta.headers["cache-control"], "no-store")
        self.assertEqual(self.cliente.get("/api/sebrae/chamados/x/credenciais").status_code, 422)

if __name__ == "__main__":
    unittest.main()
