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
            patch.object(automacao, "iniciar_log_execucao"),
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
            patch.object(automacao, "iniciar_log_execucao"),
            patch("builtins.print") as impresso,
        ):
            self.assertEqual(automacao.main(), 2)
        self.assertIn("Já existe uma rotina em andamento (rotina os, PID 4242", impresso.call_args[0][0])

    def test_pid_vivo_detects_current_and_missing_processes(self):
        self.assertTrue(automacao.pid_vivo(automacao.os.getpid()))
        self.assertFalse(automacao.pid_vivo(0))
        self.assertFalse(automacao.pid_vivo(2_000_000_000))

class ExecutionLogTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".automacao-chrome-log-test-")
        self.pasta = Path(self.temp_context.name) / "automacao_chrome"
        self.patcher = patch.object(automacao, "ERROS_DIR", self.pasta)
        self.patcher.start()

    def tearDown(self):
        automacao.finalizar_log_execucao(1)  # garante sys.stdout restaurado se um teste falhar no meio
        self.patcher.stop()
        self.temp_context.cleanup()

    def _executar(self, codigo: int, corpo=None) -> tuple[str, Path, dict]:
        console = io.StringIO()
        with redirect_stdout(console):
            caminho = automacao.iniciar_log_execucao("os")
            self.assertEqual(automacao.caminho_log_atual(), caminho)
            automacao.log("Oracle", "Pesquisando…")
            if corpo:
                corpo()
            self.assertEqual(automacao.finalizar_log_execucao(codigo), codigo)
        self.assertIsNone(automacao.caminho_log_atual())
        resumo = json.loads(caminho.with_suffix(".json").read_text(encoding="utf-8"))
        return console.getvalue(), caminho, resumo

    def test_log_mirrors_console_in_utf8_and_summarizes_success(self):
        def corpo():
            print("\n=== ROTINA DE OS SIMPRESS ===", flush=True)
            automacao.registrar_lote("OS_20261020")
            automacao.registrar_captura(self.pasta / "x_Oracle.png")
            self.assertEqual(
                json.loads(automacao.caminho_log_atual().with_suffix(".json").read_text(encoding="utf-8"))["status"],
                "em_andamento",
            )

        console, caminho, resumo = self._executar(0, corpo)
        self.assertRegex(caminho.name, r"^\d{8}_\d{6}_os\.log$")
        self.assertEqual(caminho.parent, self.pasta)
        texto = caminho.read_text(encoding="utf-8")
        self.assertTrue(texto.startswith(console))
        self.assertNotIn("Status:", console)
        self.assertIn("[Oracle] Pesquisando…", texto)
        self.assertIn("[Execução] Status: concluído (código 0)", texto)
        self.assertEqual(resumo["rotina"], "os")
        self.assertEqual((resumo["status"], resumo["codigo"]), ("concluido", 0))
        self.assertEqual(resumo["lotes"], ["OS_20261020"])
        self.assertEqual(resumo["capturas"], [str(self.pasta / "x_Oracle.png")])
        self.assertTrue(resumo["inicio"] and resumo["fim"])

    def test_summary_reports_failure_message(self):
        _, caminho, resumo = self._executar(1, lambda: print("\n[FALHA] Login não concluído em 10 minutos.", flush=True))
        self.assertEqual((resumo["status"], resumo["codigo"]), ("falha", 1))
        self.assertEqual(resumo["mensagem"], "Login não concluído em 10 minutos.")
        self.assertIn("Status: falha (código 1): Login não concluído em 10 minutos.", caminho.read_text(encoding="utf-8"))

    def test_summary_reports_cancellation(self):
        _, caminho, resumo = self._executar(130, lambda: print("\n[CANCELADO] Rotina interrompida.", flush=True))
        self.assertEqual((resumo["status"], resumo["codigo"]), ("cancelado", 130))
        self.assertIn("Status: cancelado (código 130)", caminho.read_text(encoding="utf-8"))

    def test_processar_fila_output_reaches_the_log(self):
        class ProcessoFalso:
            returncode = 0
            stdout = ["Lote OS_1 processado\r\n", "Histórico atualizado\n"]

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def corpo():
            with patch.object(automacao.subprocess, "Popen", lambda *a, **k: ProcessoFalso()):
                automacao.processar_fila("process_ticket_inbox.py")

        console, caminho, _ = self._executar(0, corpo)
        self.assertIn("Lote OS_1 processado\nHistórico atualizado\n", console)
        self.assertIn("Lote OS_1 processado\nHistórico atualizado\n", caminho.read_text(encoding="utf-8"))

    def test_retention_keeps_most_recent_logs_and_screenshots(self):
        self.pasta.mkdir(parents=True)
        for indice in range(5):
            base = self.pasta / f"2026010{indice}_120000_os"
            base.with_suffix(".log").write_text("x", encoding="utf-8")
            base.with_suffix(".json").write_text("{}", encoding="utf-8")
            base.with_suffix(".png").write_bytes(b"png")
        automacao.limpar_logs_antigos(self.pasta, manter=3)
        self.assertEqual(
            sorted(p.name for p in self.pasta.glob("*.log")),
            ["20260102_120000_os.log", "20260103_120000_os.log", "20260104_120000_os.log"],
        )
        self.assertEqual(len(list(self.pasta.glob("*.json"))), 3)
        self.assertEqual(len(list(self.pasta.glob("*.png"))), 5)

    def test_retention_leaves_site_logs_alone(self):
        self.pasta.mkdir(parents=True)
        site = self.pasta / "20250101_120000_os.site.log"
        site.write_text("x", encoding="utf-8")
        for indice in range(3):
            (self.pasta / f"2026010{indice}_120000_os.log").write_text("x", encoding="utf-8")
        automacao.limpar_logs_antigos(self.pasta, manter=3)
        self.assertTrue(site.exists())
        self.assertEqual(len(list(self.pasta.glob("*.log"))), 4)

    def test_start_applies_retention_of_100_logs(self):
        self.pasta.mkdir(parents=True)
        for indice in range(105):
            (self.pasta / f"2025{indice:04d}_000000_os.log").write_text("x", encoding="utf-8")
        _, caminho, _ = self._executar(0)
        logs = sorted(p.name for p in self.pasta.glob("*.log"))
        self.assertEqual(len(logs), automacao.LOGS_MANTIDOS)
        self.assertIn(caminho.name, logs)


class PlaywrightAusenteTests(unittest.TestCase):
    def test_mensagem_traz_o_comando_exato_de_instalacao(self):
        mensagem = automacao.mensagem_playwright_ausente()
        self.assertIn("playwright", mensagem)
        self.assertIn(r".venv\Scripts\python.exe -m pip install -r requirements.txt", mensagem)

    def test_main_sai_com_codigo_3_sem_traceback_quando_falta_o_pacote(self):
        saida = io.StringIO()
        with patch.object(sys, "argv", ["automacao_rotinas_chrome.py", "--rotina", "login"]),                 patch.object(automacao, "iniciar_log_execucao"),                 patch.object(automacao, "playwright_instalado", return_value=False),                 patch.object(automacao, "executar") as executar,                 redirect_stdout(saida):
            codigo = automacao.main()
        self.assertEqual(codigo, 3)
        executar.assert_not_called()
        self.assertIn("[ERRO]", saida.getvalue())
        self.assertIn("pip install -r requirements.txt", saida.getvalue())
        self.assertNotIn("Traceback", saida.getvalue())


if __name__ == "__main__":
    unittest.main()
