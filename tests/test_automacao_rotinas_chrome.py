import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from scripts import automacao_rotinas_chrome as automacao


class ChromeAutomationHelpersTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".automacao-chrome-test-")
        self.root = Path(self.temp_context.name)
        self.sinal = self.root / "automacao_chrome.cancelar"
        patcher = patch.object(automacao, "CANCELAR_ARQUIVO", self.sinal)
        patcher.start()
        self.addCleanup(patcher.stop)

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

    def test_aguardar_login_stops_when_cancel_signal_appears(self):
        page, relogio = self._pagina_falsa()

        def logado(_page):
            if relogio["agora"] >= 30:  # o usuário pede o cancelamento enquanto a rotina espera o login
                automacao.pedir_cancelamento()
            return False

        with (
            patch.object(automacao.time, "time", lambda: relogio["agora"]),
            patch.object(automacao, "log", lambda origem, msg: None),
            patch.object(automacao, "_inicio_execucao", 0.0),
            self.assertRaises(automacao.RotinaCancelada),
        ):
            automacao.aguardar_login(page, "Oracle", logado)
        self.assertLess(relogio["agora"], 40)

    def test_stale_cancel_signal_does_not_cancel_new_run(self):
        automacao.pedir_cancelamento()
        antigo = time.time() - 3600
        os.utime(self.sinal, (antigo, antigo))
        with patch.object(automacao, "_inicio_execucao", time.time()):
            self.assertFalse(automacao.cancelamento_pedido())
            automacao.verificar_cancelamento()
        with patch.object(automacao, "_inicio_execucao", 0.0):
            automacao.iniciar_controle_cancelamento()
            self.assertFalse(self.sinal.exists())
            self.assertFalse(automacao.cancelamento_pedido())

    def test_main_returns_130_and_clears_signal_when_cancelled(self):
        def executar(_rotina):
            automacao.pedir_cancelamento()
            automacao.verificar_cancelamento()

        saida = io.StringIO()
        with (
            patch.object(automacao, "executar", executar),
            patch.object(sys, "argv", ["automacao", "--rotina", "login"]),
            patch.object(automacao, "_inicio_execucao", 0.0),
            redirect_stdout(saida),
        ):
            self.assertEqual(automacao.main(), 130)
        self.assertIn("Rotina cancelada pelo usuário.", saida.getvalue())
        self.assertFalse(self.sinal.exists())

    def test_main_cancelar_only_creates_signal(self):
        with (
            patch.object(automacao, "executar") as executar,
            patch.object(sys, "argv", ["automacao", "--cancelar"]),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(automacao.main(), 0)
        executar.assert_not_called()
        self.assertTrue(self.sinal.exists())

    def test_confirmar_lote_cancel_reports_batch_already_published(self):
        automacao.pedir_cancelamento()
        with (
            patch.object(automacao, "_inicio_execucao", 0.0),
            patch.object(automacao.time, "sleep"),
            self.assertRaises(automacao.RotinaCancelada) as contexto,
        ):
            automacao.confirmar_lote(self.root, "OS_9", timeout_s=5)
        self.assertIn("pendentes", str(contexto.exception))

    def test_descrever_erro_keeps_only_first_line_of_playwright_errors(self):
        erro = TimeoutError("Locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator")
        self.assertEqual(automacao.descrever_erro(erro), "TimeoutError: Locator.click: Timeout 30000ms exceeded.")
        self.assertEqual(automacao.descrever_erro(automacao.RotinaErro("Login não concluído")), "Login não concluído")


if __name__ == "__main__":
    unittest.main()
