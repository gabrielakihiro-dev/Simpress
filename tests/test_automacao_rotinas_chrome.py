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

    def test_descrever_erro_keeps_only_first_line_of_playwright_errors(self):
        erro = TimeoutError("Locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator")
        self.assertEqual(automacao.descrever_erro(erro), "TimeoutError: Locator.click: Timeout 30000ms exceeded.")
        self.assertEqual(automacao.descrever_erro(automacao.RotinaErro("Login não concluído")), "Login não concluído")


class ExecucaoUnicaTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".automacao-trava-test-")
        self.trava = Path(self.temp_context.name) / "state" / "automacao_chrome.lock"
        patcher = patch.object(automacao, "TRAVA_PATH", self.trava)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.temp_context.cleanup()

    def _gravar(self, pid: int, rotina: str = "os", inicio: str = "2026-10-20T09:05:00-03:00") -> None:
        self.trava.parent.mkdir(parents=True, exist_ok=True)
        self.trava.write_text(json.dumps({"pid": pid, "rotina": rotina, "inicio": inicio}), encoding="utf-8")

    def test_trava_livre_is_acquired_and_released(self):
        self.assertIsNone(automacao.ler_trava())
        with automacao.trava_execucao("login"):
            estado = automacao.ler_trava()
            self.assertEqual(estado["pid"], automacao.os.getpid())
            self.assertEqual(estado["rotina"], "login")
        self.assertFalse(self.trava.exists())
        self.assertIsNone(automacao.ler_trava())

    def test_trava_ocupada_by_live_pid_blocks_with_clear_message(self):
        self._gravar(4242, rotina="inventarios")
        with patch.object(automacao, "pid_vivo", lambda pid: True):
            self.assertEqual(automacao.ler_trava()["rotina"], "inventarios")
            with self.assertRaises(automacao.TravaOcupada) as ctx:
                automacao.adquirir_trava("os")
        self.assertEqual(
            str(ctx.exception), "Já existe uma rotina em andamento (rotina inventarios, PID 4242, desde 09:05)"
        )
        self.assertEqual(json.loads(self.trava.read_text(encoding="utf-8"))["pid"], 4242)

    def test_trava_orfa_is_taken_over(self):
        self._gravar(4242)
        with patch.object(automacao, "pid_vivo", lambda pid: pid == automacao.os.getpid()):
            self.assertIsNone(automacao.ler_trava())
            automacao.adquirir_trava("ambas")
            self.assertEqual(automacao.ler_trava()["rotina"], "ambas")
        automacao.liberar_trava()
        self.assertFalse(self.trava.exists())

    def test_trava_is_released_on_exception_and_ctrl_c(self):
        for erro in (RuntimeError("falhou"), KeyboardInterrupt()):
            with self.assertRaises(type(erro)), automacao.trava_execucao("os"):
                self.assertTrue(self.trava.exists())
                raise erro
            self.assertFalse(self.trava.exists())

    def test_liberar_trava_keeps_lock_of_other_process(self):
        self._gravar(4242)
        automacao.liberar_trava()
        self.assertTrue(self.trava.exists())

    def test_main_returns_2_when_another_run_is_alive(self):
        self._gravar(4242, rotina="os")
        with (
            patch.object(automacao, "pid_vivo", lambda pid: True),
            patch.object(automacao.sys, "argv", ["automacao", "--rotina", "login"]),
            patch("builtins.print") as impresso,
        ):
            self.assertEqual(automacao.main(), 2)
        self.assertIn("Já existe uma rotina em andamento (rotina os, PID 4242", impresso.call_args[0][0])

    def test_pid_vivo_detects_current_and_missing_processes(self):
        self.assertTrue(automacao.pid_vivo(automacao.os.getpid()))
        self.assertFalse(automacao.pid_vivo(0))
        self.assertFalse(automacao.pid_vivo(2_000_000_000))


if __name__ == "__main__":
    unittest.main()
