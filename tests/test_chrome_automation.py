"""Automação routes and runner with a mocked subprocess; no real routine or Chrome is started."""

import importlib.util
import io
import json
import os
import subprocess
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

with (
    patch("core.integrity.recover_pending_transactions", return_value=None),
    patch("openpyxl.load_workbook", side_effect=RuntimeError("operational data blocked")),
    redirect_stdout(io.StringIO()),
):
    import main

from core.errors import DomainConflictError, DomainError
from domains import chrome_automation
from domains.chrome_automation import ChromeAutomationRunner, ScriptContract, read_log_chunk

HTTP_TEST_AVAILABLE = importlib.util.find_spec("httpx") is not None
if HTTP_TEST_AVAILABLE:
    from fastapi.testclient import TestClient


class FakeProcess:
    def __init__(self, pid=4321):
        self.pid = pid
        self.returncode = None
        self.terminated = False
        self.exited = threading.Event()

    def poll(self):
        return self.returncode

    def wait(self):
        self.exited.wait(5)
        return self.returncode

    def exit(self, code):
        self.returncode = code
        self.exited.set()

    def terminate(self):
        self.terminated = True
        self.exit(1)


class RunnerHarness:
    """A runner over a temporary folder; Popen writes the given output into the log file."""

    def __init__(self, root: Path, *, help_text="usage: --rotina", alive_pids=(), output=b""):
        self.root = root
        self.script = root / "scripts" / "automacao_rotinas_chrome.py"
        self.script.parent.mkdir(parents=True)
        self.script.write_text("# fake script\n", encoding="utf-8")
        self.contract = ScriptContract(
            script=self.script,
            python=root / ".venv" / "Scripts" / "python.exe",
            working_dir=root,
            lock_file=root / "data" / "state" / "automacao_chrome.lock",
            cancel_signal_file=root / "data" / "state" / "automacao_chrome.cancelar",
            log_dir=root / "data" / "logs" / "automacao_chrome",
        )
        self.popen_calls = []
        self.run_calls = []
        self.processes = []
        self.help_text = help_text
        self.alive_pids = set(alive_pids)
        self.output = output
        self.clock = datetime(2026, 10, 20, 8, 0, 0)
        self.runner = self.build()

    def build(self, **kwargs):
        return ChromeAutomationRunner(
            self.contract, popen=self.popen, run=self.run, is_alive=lambda pid: pid in self.alive_pids,
            now=lambda: self.clock, **kwargs,
        )

    def popen(self, args, **kwargs):
        self.popen_calls.append((args, kwargs))
        kwargs["stdout"].write(self.output)
        process = FakeProcess(pid=4321 + len(self.processes))
        self.processes.append(process)
        return process

    def run(self, args, **kwargs):
        self.run_calls.append((args, kwargs))
        if args[-1] == "--help":
            return SimpleNamespace(returncode=0, stdout=self.help_text, stderr="")
        return SimpleNamespace(returncode=0, stdout="Pedido de cancelamento registrado.", stderr="")

    def append_log(self, text):
        log = next(self.contract.log_dir.glob("*.site.log"))
        with log.open("ab") as handle:
            handle.write(text.encode("utf-8"))

    def finish(self, code):
        process = self.processes[-1]
        process.exit(code)
        for _ in range(200):
            if self.runner.state()["estado"] == "livre":
                return
            threading.Event().wait(0.01)
        raise AssertionError("A execução não terminou.")


class ChromeAutomationRunnerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_stored_log_path_cannot_leave_log_dir(self):
        harness = self.harness()
        harness.runner.start("os")
        record = next(harness.contract.log_dir.glob("*.site.json"))
        data = json.loads(record.read_text(encoding="utf-8"))
        data["log"] = "../../segredo.txt"
        record.write_text(json.dumps(data), encoding="utf-8")

        harness.alive_pids.add(data["pid"])
        adopted = harness.build(watch=False)
        self.assertEqual(adopted._current.log_path.parent, harness.contract.log_dir)
        harness.finish(0)

    def harness(self, **kwargs):
        return RunnerHarness(self.root, **kwargs)

    def test_only_whitelisted_routines_start(self):
        harness = self.harness()
        for rotina in ("rm -rf", "os; calc", "", "OS"):
            with self.subTest(rotina=rotina), self.assertRaises(DomainError) as raised:
                harness.runner.start(rotina)
            self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(harness.popen_calls, [])

    def test_start_uses_argument_list_venv_python_utf8_and_no_window(self):
        harness = self.harness()
        state = harness.runner.start("os")

        args, kwargs = harness.popen_calls[0]
        self.assertEqual(args, [str(harness.contract.python), str(harness.script), "--rotina", "os"])
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], subprocess.STDOUT)
        self.assertEqual(kwargs["cwd"], str(self.root))
        self.assertEqual(kwargs["env"]["PYTHONUTF8"], "1")
        self.assertEqual(kwargs["env"]["PYTHONIOENCODING"], "utf-8")
        if os.name == "nt":
            self.assertEqual(kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)
        self.assertEqual(state["estado"], "em_andamento")
        self.assertEqual(state["rotina"], "os")
        self.assertEqual(state["origem"], "site")
        self.assertTrue(state["log"]["arquivo"].endswith("_os.site.log"))
        harness.finish(0)

    def test_project_python_prefers_the_venv(self):
        venv_python = self.root / ".venv" / "Scripts" / "python.exe"
        venv_python.parent.mkdir(parents=True)
        venv_python.write_bytes(b"")
        self.assertEqual(chrome_automation.project_python(self.root), venv_python)

    def test_second_start_is_refused_while_running(self):
        harness = self.harness()
        harness.runner.start("inventarios")
        with self.assertRaises(DomainError) as raised:
            harness.runner.start("os")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("Já há uma rotina em andamento: Inventários desde", raised.exception.detail)
        self.assertEqual(len(harness.popen_calls), 1)
        harness.finish(0)

    def test_live_lock_from_outside_the_site_blocks_start(self):
        harness = self.harness(alive_pids={999})
        harness.contract.lock_file.parent.mkdir(parents=True)
        harness.contract.lock_file.write_text(
            json.dumps({"pid": 999, "rotina": "ambas", "inicio": "2026-10-20T07:30:00-03:00"}), encoding="utf-8")
        state = harness.runner.state()
        self.assertEqual((state["estado"], state["origem"], state["rotina"]), ("em_andamento", "externo", "ambas"))
        with self.assertRaises(DomainError) as raised:
            harness.runner.start("login")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("Ambas as rotinas desde 07:30", raised.exception.detail)
        self.assertEqual(harness.popen_calls, [])

    def test_stale_lock_with_dead_pid_does_not_block(self):
        harness = self.harness()
        harness.contract.lock_file.parent.mkdir(parents=True)
        harness.contract.lock_file.write_text(json.dumps({"pid": 999, "rotina": "os", "inicio": ""}), encoding="utf-8")
        harness.runner.start("login")
        self.assertEqual(len(harness.popen_calls), 1)
        harness.finish(0)

    def test_state_returns_only_new_lines_and_detects_login_wait(self):
        harness = self.harness(output="[08:00:01] [Chrome] Reaproveitando o Chrome.\n".encode("utf-8"))
        first = harness.runner.start("os")
        self.assertEqual(first["log"]["linhas"], ["[08:00:01] [Chrome] Reaproveitando o Chrome."])
        self.assertFalse(first["aguardando_login"])

        harness.append_log("[08:00:20] [Oracle] AÇÃO NECESSÁRIA: faça o login na janela do Chrome de automação.\n[08:00:21] parcial")
        waiting = harness.runner.state(first["log"]["offset"], first["log"]["arquivo"])
        self.assertEqual(len(waiting["log"]["linhas"]), 1)
        self.assertTrue(waiting["aguardando_login"])
        self.assertEqual(waiting["login_origem"], "Oracle")

        harness.append_log("\n[08:01:00] [Oracle] Login detectado; continuando.\n")
        done = harness.runner.state(waiting["log"]["offset"], waiting["log"]["arquivo"])
        self.assertEqual(done["log"]["linhas"], ["[08:00:21] parcial", "[08:01:00] [Oracle] Login detectado; continuando."])
        self.assertFalse(done["aguardando_login"])

        other_file = harness.runner.state(done["log"]["offset"], "outro.site.log")
        self.assertTrue(other_file["log"]["reiniciado"])
        self.assertEqual(len(other_file["log"]["linhas"]), 4)
        harness.finish(0)

    def test_finished_run_records_status_batches_and_captures(self):
        harness = self.harness()
        harness.runner.start("os")
        capture = harness.contract.log_dir / "20261020_080500_Oracle.png"
        capture.write_bytes(b"\x89PNG")
        harness.append_log(
            "[08:05:00] [Oracle] Captura da tela no erro: " + str(capture) + "\n"
            "[08:06:00] [Importação] Lote lote-123 em pendentes\n"
            "[08:06:30] [Importação] status=concluido | ok\n"
            "\n[FALHA] Login não concluído em 10 minutos.\n"
        )
        harness.finish(1)
        history = harness.runner.history()
        self.assertEqual(len(history), 1)
        entry = history[0]
        self.assertEqual((entry["status"], entry["codigo"], entry["origem"]), ("falha", 1, "site"))
        self.assertEqual(entry["lotes"], [{"id": "lote-123", "status": "concluido"}])
        self.assertEqual(entry["capturas"], [{"nome": capture.name, "url": f"/api/automacao/capturas/{capture.name}"}])
        self.assertEqual(entry["mensagem"], "Login não concluído em 10 minutos.")
        self.assertEqual(harness.runner.state()["ultima"]["id"], entry["id"])

    def test_exit_codes_map_to_statuses(self):
        harness = self.harness()
        for code, status in ((0, "concluido"), (130, "cancelado"), (2, "ocupada"), (1, "falha")):
            harness.clock = harness.clock.replace(minute=harness.clock.minute + 1)
            harness.runner.start("login")
            harness.finish(code)
            with self.subTest(code=code):
                self.assertEqual(harness.runner.history(1)[0]["status"], status)

    def test_cancel_uses_script_flag_when_available(self):
        harness = self.harness(help_text="usage: [--rotina ...] [--cancelar]")
        harness.runner.start("inventarios")
        result = harness.runner.cancel()
        self.assertEqual(result["metodo"], "sinal")
        self.assertEqual(harness.run_calls[-1][0], [str(harness.contract.python), str(harness.script), "--cancelar"])
        self.assertFalse(harness.processes[-1].terminated)
        self.assertTrue(result["estado"]["cancelamento_pedido"])
        harness.finish(130)
        self.assertEqual(harness.runner.history(1)[0]["status"], "cancelado")

    def test_cancel_without_flag_terminates_only_the_child(self):
        harness = self.harness(help_text="usage: [--rotina {os,inventarios,ambas,login}]")
        harness.runner.start("os")
        result = harness.runner.cancel()
        self.assertEqual(result["metodo"], "processo")
        self.assertTrue(harness.processes[-1].terminated)
        self.assertEqual([call[0][-1] for call in harness.run_calls], ["--help"])
        harness.finish(1)
        self.assertEqual(harness.runner.history(1)[0]["status"], "cancelado")

    def test_cancel_refuses_when_idle_or_external_without_flag(self):
        harness = self.harness(alive_pids={999})
        with self.assertRaises(DomainError) as idle:
            harness.runner.cancel()
        self.assertEqual(idle.exception.status_code, 409)

        harness.contract.lock_file.parent.mkdir(parents=True)
        harness.contract.lock_file.write_text(json.dumps({"pid": 999, "rotina": "os", "inicio": ""}), encoding="utf-8")
        with self.assertRaises(DomainError) as external:
            harness.runner.cancel()
        self.assertEqual(external.exception.status_code, 409)
        self.assertIn("fora do site", external.exception.detail)

    def test_history_merges_the_script_summary_of_the_same_run(self):
        harness = self.harness()
        harness.runner.start("os")
        harness.finish(0)
        site = harness.runner.history()[0]
        (harness.contract.log_dir / "20261020_080000_os.json").write_text(json.dumps({
            "rotina": "os", "inicio": site["inicio"], "fim": site["fim"], "status": "concluido", "codigo": 0,
            "lotes": ["lote-script"], "capturas": [], "log": "C:/x/20261020_080000_os.log",
        }), encoding="utf-8")
        (harness.contract.log_dir / "20261019_170000_ambas.json").write_text(json.dumps({
            "rotina": "ambas", "inicio": "2026-10-19T17:00:00-03:00", "status": "falha", "codigo": 1,
            "lotes": [{"lote_id": "lote-bat", "status": "falha"}],
        }), encoding="utf-8")
        history = harness.runner.history()
        self.assertEqual([(entry["rotina"], entry["origem"]) for entry in history], [("os", "site"), ("ambas", "externo")])
        self.assertEqual(history[0]["lotes"], [{"id": "lote-script", "status": ""}])
        self.assertEqual(history[1]["lotes"], [{"id": "lote-bat", "status": "falha"}])

    def test_restart_adopts_live_run_and_closes_dead_one(self):
        harness = self.harness()
        harness.runner.start("os")
        record = next(harness.contract.log_dir.glob("*.site.json"))
        pid = json.loads(record.read_text(encoding="utf-8"))["pid"]

        harness.alive_pids.add(pid)
        adopted = harness.build(watch=False)
        self.assertEqual(adopted.state()["estado"], "em_andamento")
        harness.alive_pids.clear()
        self.assertEqual(adopted.state()["estado"], "livre")
        self.assertEqual(adopted.history(1)[0]["status"], "interrompido")
        harness.finish(0)

    def test_capture_path_rejects_traversal_and_other_files(self):
        harness = self.harness()
        harness.contract.log_dir.mkdir(parents=True)
        (harness.contract.log_dir / "ok.png").write_bytes(b"\x89PNG")
        (harness.contract.log_dir / "x.log").write_text("", encoding="utf-8")
        self.assertIsNotNone(harness.runner.capture_path("ok.png"))
        for name in ("../ok.png", "..\\ok.png", "x.log", "faltando.png", "C:ok.png"):
            with self.subTest(name=name):
                self.assertIsNone(harness.runner.capture_path(name))

    def test_read_log_chunk_restarts_when_file_shrinks(self):
        log = self.root / "a.log"
        log.write_bytes("linha 1\r\nlinha 2\n".encode("utf-8"))
        self.assertEqual(read_log_chunk(log, 0)["linhas"], ["linha 1", "linha 2"])
        restarted = read_log_chunk(log, 500)
        self.assertTrue(restarted["reiniciado"])
        self.assertEqual(restarted["linhas"], ["linha 1", "linha 2"])

    def _history_fixture(self, harness):
        harness.contract.log_dir.mkdir(parents=True, exist_ok=True)
        for day in (18, 19, 20):
            stem = f"202610{day}_080000_os"
            (harness.contract.log_dir / f"{stem}.json").write_text(json.dumps({
                "rotina": "os", "inicio": f"2026-10-{day}T08:00:00-03:00", "status": "concluido",
                "log": f"{stem}.log",
            }), encoding="utf-8")
            (harness.contract.log_dir / f"{stem}.log").write_text("primeira\nsegunda\nterceira\n", encoding="utf-8")

    def test_history_filters_inclusive_dates_before_paging_and_clamps_pages(self):
        harness = self.harness()
        self._history_fixture(harness)
        result = harness.runner.history_page(1, 2, start=date(2026, 10, 19), end=date(2026, 10, 20), routine="os", status="concluido")
        self.assertEqual((result["total"], result["pagina"], result["paginas"]), (2, 2, 2))
        self.assertEqual(result["execucoes"][0]["id"], "20261019_080000_os")
        self.assertEqual(harness.runner.history_page(5, 30, status="falha")["pagina"], 1)
        self.assertEqual(harness.runner.history_page(5, routine="login")["total"], 0)
        with self.assertRaises(DomainError):
            harness.runner.history_page(start=date(2026, 10, 20), end=date(2026, 10, 19))

    def test_execution_log_reads_only_selected_record_and_limits_lines(self):
        harness = self.harness()
        self._history_fixture(harness)
        result = harness.runner.execution_log("20261019_080000_os", 2)
        self.assertEqual(result["linhas"], ["segunda", "terceira"])
        self.assertTrue(result["limitado"])
        self.assertEqual(result["execucao"]["id"], "20261019_080000_os")
        for identifier in ("missing", "../secret", "C:secret"):
            with self.assertRaises(DomainError):
                harness.runner.execution_log(identifier)
        record = harness.contract.log_dir / "20261019_080000_os.json"
        data = json.loads(record.read_text(encoding="utf-8"))
        # Script records are normalized to a basename, but cannot choose files
        # outside the log directory or non-log files.
        data["log"] = "secret.json"
        record.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(DomainError):
            harness.runner.execution_log("20261019_080000_os")

    def test_execution_log_rejects_external_symlink(self):
        harness = self.harness()
        self._history_fixture(harness)
        log = harness.contract.log_dir / "20261019_080000_os.log"
        outside = self.root / "secret.log"
        outside.write_text("outside", encoding="utf-8")
        log.unlink()
        try:
            log.symlink_to(outside)
        except OSError:
            self.skipTest("Creating symlinks is unavailable on this host")
        with self.assertRaises(DomainError):
            harness.runner.execution_log("20261019_080000_os")


class FakeRunner:
    def __init__(self):
        self.started = []
        self.cancelled = 0

    def start(self, rotina):
        self.started.append(rotina)
        return {"estado": "em_andamento", "rotina": rotina}

    def cancel(self):
        self.cancelled += 1
        return {"metodo": "processo", "mensagem": "ok", "estado": {}}

    def state(self, offset=0, arquivo=""):
        return {"estado": "livre", "offset": offset, "arquivo": arquivo}

    def history(self, limit=15):
        return [{"limite": limit}]

    def history_page(self, limit, page, **filters):
        return {"execucoes": self.history(limit), "pagina": page, "paginas": 1, "total": 1, "limite": limit}

    def execution_log(self, identifier, lines):
        return {"arquivo": "a.log", "linhas": [identifier], "limite": lines}

    def capture_path(self, name):
        return None


@unittest.skipUnless(HTTP_TEST_AVAILABLE, "Optional httpx test dependency is not installed")
class AutomationRouteTests(unittest.TestCase):
    def setUp(self):
        self.runner = FakeRunner()
        patcher = patch.object(main, "_chrome_automation_runner", self.runner)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.origin = f"http://127.0.0.1:{main.SERVER_PORT}"
        self.client = TestClient(main.app, base_url=self.origin, client=("127.0.0.1", 1234))
        self.addCleanup(self.client.close)

    def test_start_accepts_only_the_whitelist(self):
        for rotina in ("os", "inventarios", "usuarios", "ambas", "login", "sebrae", "dashboard", "enviar"):
            response = self.client.post("/api/automacao/executar", json={"rotina": rotina}, headers={"Origin": self.origin})
            self.assertEqual(response.status_code, 202, rotina)
        for body in ({"rotina": "rm -rf"}, {"rotina": "os", "extra": 1}, {}, {"rotina": ["os"]}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post("/api/automacao/executar", json=body).status_code, 422)
        self.assertEqual(self.runner.started, ["os", "inventarios", "usuarios", "ambas", "login", "sebrae", "dashboard", "enviar"])

    def test_conflict_is_returned_as_409_with_message(self):
        message = "Já há uma rotina em andamento: Rotina de OS desde 08:00. Aguarde terminar ou cancele."

        def busy(rotina):
            raise DomainConflictError(message)

        self.runner.start = busy
        response = self.client.post("/api/automacao/executar", json={"rotina": "os"})
        self.assertEqual((response.status_code, response.json()["detail"]), (409, message))

    def test_state_history_cancel_and_capture_routes(self):
        state = self.client.get("/api/automacao/estado", params={"offset": 12, "arquivo": "a.site.log"})
        self.assertEqual(state.json(), {"estado": "livre", "offset": 12, "arquivo": "a.site.log"})
        self.assertEqual(state.headers["cache-control"], "no-store")
        self.assertEqual(self.client.get("/api/automacao/estado", params={"offset": -1}).status_code, 422)
        history = self.client.get("/api/automacao/historico", params={"limite": 5})
        self.assertEqual(history.json()["execucoes"], [{"limite": 5}])
        self.assertEqual(history.headers["cache-control"], "no-store")
        self.assertEqual(self.client.get("/api/automacao/historico", params={"limite": 51}).status_code, 422)
        for params in ({"pagina": 0}, {"data_inicio": "wrong"}, {"rotina": "other"}, {"status": "other"}):
            self.assertEqual(self.client.get("/api/automacao/historico", params=params).status_code, 422)
        self.assertEqual(self.client.get("/api/automacao/execucoes/demo/log?linhas=2").json()["linhas"], ["demo"])
        self.assertEqual(self.client.get("/api/automacao/execucoes/demo/log?linhas=501").status_code, 422)
        self.assertEqual(self.client.post("/api/automacao/cancelar").status_code, 202)
        self.assertEqual(self.runner.cancelled, 1)
        self.assertEqual(self.client.get("/api/automacao/capturas/x.png").status_code, 404)

    def test_cross_site_requests_are_refused_before_the_runner(self):
        evil = {"Origin": "http://evil.example"}
        self.assertEqual(self.client.post("/api/automacao/executar", json={"rotina": "os"}, headers=evil).status_code, 403)
        self.assertEqual(self.client.post("/api/automacao/cancelar", headers=evil).status_code, 403)
        cross_site = {"Sec-Fetch-Site": "cross-site"}
        for path in ("/api/automacao/estado", "/api/automacao/historico", "/api/automacao/capturas/x.png", "/api/automacao/execucoes/demo/log"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path, headers=cross_site).status_code, 403)
        remote = TestClient(main.app, base_url=self.origin, client=("192.0.2.10", 1234))
        self.addCleanup(remote.close)
        self.assertEqual(remote.post("/api/automacao/executar", json={"rotina": "os"}).status_code, 403)
        foreign_host = TestClient(main.app, base_url=f"http://simpress.example:{main.SERVER_PORT}", client=("127.0.0.1", 1234))
        self.addCleanup(foreign_host.close)
        self.assertEqual(foreign_host.post("/api/automacao/executar", json={"rotina": "os"}).status_code, 403)
        self.assertEqual(self.runner.started, [])
        self.assertEqual(self.runner.cancelled, 0)


if __name__ == "__main__":
    unittest.main()
