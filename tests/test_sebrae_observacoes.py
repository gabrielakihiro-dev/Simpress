import json
import tempfile
import unittest
from pathlib import Path

from core.errors import DomainBusyError, DomainValidationError
from domains import sebrae_observacoes as obs


class SebraeObservacoesTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_validar_numero_observacao_utic_e_linha(self):
        self.assertEqual(obs.validar_numero_observacao("UTIC-2024-1234"), "UTIC-2024-1234")
        self.assertEqual(obs.validar_numero_observacao("utic-2025-9999"), "UTIC-2025-9999")
        self.assertEqual(obs.validar_numero_observacao("linha:1"), "linha:1")
        self.assertEqual(obs.validar_numero_observacao("linha:42"), "linha:42")

    def test_validar_numero_observacao_invalido(self):
        invalidos = [
            "",
            "   ",
            "LINHA:1",
            "linha:",
            "linha:abc",
            "UTIC-24-1",
            "UTIC-2024",
            "12345",
            None,
            "CHAMADO-1",
        ]
        for inv in invalidos:
            with self.subTest(numero=inv):
                with self.assertRaises(DomainValidationError) as ctx:
                    obs.validar_numero_observacao(inv)
                self.assertEqual(ctx.exception.status_code, 422)

    def test_validar_observacao_limpa_controles_e_formula(self):
        texto = "  Observação inicial\x00\x08 com quebra\r\ne mais texto.  "
        self.assertEqual(
            obs.validar_observacao(texto),
            "Observação inicial com quebra\ne mais texto.",
        )

        formulas = ["=SOMA(1,2)", "+12345", "-12345", "@ALGUMA_COISA"]
        for f in formulas:
            with self.subTest(formula=f):
                self.assertTrue(obs.validar_observacao(f).startswith("'"))

    def test_validar_observacao_mascara_cpfs_e_credenciais(self):
        texto = "Atendimento do CPF 123.456.789-00 com senha 123456."
        res = obs.validar_observacao(texto)
        self.assertNotIn("123.456.789-00", res)
        self.assertIn("***.***.***-**", res)

    def test_validar_observacao_limite_tamanho(self):
        obs.validar_observacao("a" * 4000)
        with self.assertRaises(DomainValidationError) as ctx:
            obs.validar_observacao("a" * 4001)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_ler_observacoes_vazio_ou_inexistente(self):
        self.assertEqual(obs.ler_observacoes(self.state_dir), {})

    def test_ler_observacoes_arquivo_corrompido(self):
        arquivo = obs.caminho_observacoes(self.state_dir)
        arquivo.write_text("corrompido...", encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            obs.ler_observacoes(self.state_dir)

    def test_ler_observacoes_estrutura_invalida(self):
        arquivo = obs.caminho_observacoes(self.state_dir)
        arquivo.write_text(json.dumps(["não", "um", "objeto"]), encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            obs.ler_observacoes(self.state_dir)

        arquivo.write_text(json.dumps({"UTIC-2024-0001": "texto_direto"}), encoding="utf-8")
        with self.assertRaises(DomainBusyError):
            obs.ler_observacoes(self.state_dir)

    def test_salvar_e_ler_observacao(self):
        res1 = obs.salvar_observacao(self.state_dir, "UTIC-2024-0001", "Aguardando peça.")
        self.assertEqual(res1["numero"], "UTIC-2024-0001")
        self.assertEqual(res1["observacao"], "Aguardando peça.")
        self.assertTrue(res1["atualizado_em"])

        res2 = obs.salvar_observacao(self.state_dir, "linha:15", "Chamado legado sem UTIC.")
        self.assertEqual(res2["numero"], "linha:15")
        self.assertEqual(res2["observacao"], "Chamado legado sem UTIC.")

        lidas = obs.ler_observacoes(self.state_dir)
        self.assertEqual(lidas["UTIC-2024-0001"]["observacao"], "Aguardando peça.")
        self.assertEqual(lidas["linha:15"]["observacao"], "Chamado legado sem UTIC.")

    def test_salvar_observacao_vazia_remove_registro(self):
        obs.salvar_observacao(self.state_dir, "UTIC-2024-0001", "Texto temporário.")
        self.assertIn("UTIC-2024-0001", obs.ler_observacoes(self.state_dir))

        res = obs.salvar_observacao(self.state_dir, "UTIC-2024-0001", "")
        self.assertEqual(res["observacao"], "")
        self.assertNotIn("UTIC-2024-0001", obs.ler_observacoes(self.state_dir))

        # Salvar vazio em chave inexistente não falha
        res_novo_vazio = obs.salvar_observacao(self.state_dir, "linha:99", "   ")
        self.assertEqual(res_novo_vazio["observacao"], "")
        self.assertNotIn("linha:99", obs.ler_observacoes(self.state_dir))


if __name__ == "__main__":
    unittest.main()
