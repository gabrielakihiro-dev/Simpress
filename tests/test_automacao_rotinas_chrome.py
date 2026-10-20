import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import automacao_rotinas_chrome as automacao


class ChromeAutomationHelpersTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".automacao-chrome-test-")
        self.root = Path(self.temp_context.name)
        avisos = patch.object(automacao, "avisar")  # nenhum toast real nos testes
        self.avisar = avisos.start()
        self.addCleanup(avisos.stop)

    def tearDown(self):
        self.temp_context.cleanup()

    def test_nome_livre_follows_chrome_numbering_without_overwriting(self):
        self.assertEqual(automacao.nome_livre(self.root, "Gestão de Solicitações.xlsx").name, "Gestão de Solicitações.xlsx")
        (self.root / "Gestão de Solicitações.xlsx").write_bytes(b"a")
        (self.root / "Gestão de Solicitações (1).xlsx").write_bytes(b"b")
        self.assertEqual(
            automacao.nome_livre(self.root, "Gestão de Solicitações.xlsx").name,
            "Gestão de Solicitações (2).xlsx",
        )

    def _resultado(self, estado: str, pasta: str, status: str) -> None:
        destino = self.root / estado / pasta
        destino.mkdir(parents=True)
        (destino / "_resultado.json").write_text(
            json.dumps({"lote_id": "OS_1", "status": status, "detalhe": "ok"}), encoding="utf-8"
        )

    def test_confirmar_lote_reads_processed_and_renamed_batches(self):
        self._resultado("processadas", "OS_1--a1b2c3d4", "concluido")
        self._resultado("processadas", "OS_10", "concluido")
        resultado = automacao.confirmar_lote(self.root, "OS_1", timeout_s=1)
        self.assertEqual(resultado["status"], "concluido")
        self.assertTrue(resultado["pasta"].endswith("OS_1--a1b2c3d4"))

    def test_confirmar_lote_reports_failures_and_times_out(self):
        self._resultado("falhas", "OS_2", "falha")
        self.assertEqual(automacao.confirmar_lote(self.root, "OS_2", timeout_s=1)["status"], "falha")
        with patch.object(automacao.time, "sleep"), self.assertRaises(automacao.RotinaErro):
            automacao.confirmar_lote(self.root, "OS_3", timeout_s=0)

    def _pagina_falsa(self):
        relogio = {"agora": 0.0}

        class PaginaFalsa:
            def wait_for_timeout(self, ms):
                relogio["agora"] += ms / 1000

            def bring_to_front(self):
                pass

        return PaginaFalsa(), relogio

    def test_aguardar_login_tries_sso_once_then_asks_user(self):
        page, relogio = self._pagina_falsa()
        cliques = []
        mensagens = []

        def entrar(_page):
            cliques.append(relogio["agora"])
            return True

        with (
            patch.object(automacao.time, "time", lambda: relogio["agora"]),
            patch.object(automacao, "log", lambda origem, msg: mensagens.append(msg)),
            patch.object(automacao, "LOGIN_TIMEOUT_S", 60),
            self.assertRaises(automacao.RotinaErro),
        ):
            automacao.aguardar_login(page, "UX Simpress", lambda _p: False, entrar=entrar)
        self.assertEqual(len(cliques), 1)
        self.assertTrue(any("conta conectada não concluiu" in m for m in mensagens))
        self.assertTrue(any("AÇÃO NECESSÁRIA" in m for m in mensagens))
        self.avisar.assert_called_once()
        self.assertIn("UX Simpress", self.avisar.call_args.args[0])

    def test_aguardar_login_returns_when_sso_logs_in(self):
        page, relogio = self._pagina_falsa()
        estado = {"logado": False}

        def entrar(_page):
            estado["logado"] = True
            return True

        with (
            patch.object(automacao.time, "time", lambda: relogio["agora"]),
            patch.object(automacao, "log", lambda origem, msg: None),
        ):
            automacao.aguardar_login(page, "UX Simpress", lambda _p: estado["logado"], entrar=entrar)
        self.assertTrue(estado["logado"])

    def test_descrever_erro_keeps_only_first_line_of_playwright_errors(self):
        erro = TimeoutError("Locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator")
        self.assertEqual(automacao.descrever_erro(erro), "TimeoutError: Locator.click: Timeout 30000ms exceeded.")
        self.assertEqual(automacao.descrever_erro(automacao.RotinaErro("Login não concluído")), "Login não concluído")


if __name__ == "__main__":
    unittest.main()
