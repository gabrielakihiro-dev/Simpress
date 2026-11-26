import importlib.util
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "select_server_port.py"
spec = importlib.util.spec_from_file_location("select_server_port", SCRIPT)
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)


class SelectServerPortTests(unittest.TestCase):
    def run_main(self, result):
        with mock.patch.object(selector, "_is_port_available", side_effect=lambda p: p != 8000), \
             mock.patch.object(selector, "_probe_simpress", side_effect=lambda p: result if p == 8000 else None), \
             mock.patch.object(selector, "_listening_pid", return_value="4321"), \
             mock.patch("builtins.print") as printed:
            code = selector.main()
        return code, printed.call_args_list

    def test_outdated_server_is_reported_with_port_and_pid(self):
        code, calls = self.run_main({"outdated": True})
        self.assertEqual(code, 0)
        self.assertEqual(calls[-1].args[0], "OUTDATED:8000")
        warning = calls[0].args[0]
        self.assertIn("porta 8000 (PID 4321)", warning)
        self.assertIn("desatualizado", warning)

    def test_current_server_is_reused(self):
        code, calls = self.run_main({"outdated": False})
        self.assertEqual(code, 0)
        self.assertEqual(calls[-1].args[0], "RUNNING:8000")

    def test_foreign_program_on_port_warns_and_picks_next_port(self):
        code, calls = self.run_main(None)
        self.assertEqual(code, 0)
        self.assertIn("porta 8000 (PID 4321)", calls[0].args[0])
        self.assertEqual(calls[-1].args[0], "PORT:8001")


class ProbeAgainstRealServerTests(unittest.TestCase):
    """Real uvicorn servers on a free port; synthetic session secret in a temp LOCALAPPDATA."""

    def setUp(self):
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict("os.environ", {"LOCALAPPDATA": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _free_port(self):
        import socket

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def _write_secret(self, port, secret):
        path = Path(self.tmp.name) / "Simpress" / f"sessao_{port}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secret, encoding="ascii")

    def test_real_app_without_docs_is_recognized(self):
        import main

        self.assertFalse(main.API_DOCS_ENABLED)
        port = self._free_port()
        with mock.patch.object(main, "SERVER_PORT", port), \
             mock.patch.object(main, "_ALLOWED_LOCAL_AUTHORITIES", main.allowed_local_authorities(port)):
            self._serve_on(main.app, port)
            self._write_secret(port, main.sessao_local.SEGREDO)
            self.assertEqual(selector._probe_simpress(port), {"outdated": False})

    def _serve_on(self, app, port):
        import threading
        import time

        import uvicorn

        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        self.assertTrue(server.started)
        self.addCleanup(lambda: (setattr(server, "should_exit", True), thread.join(5)))
        return port

    def test_real_app_with_wrong_secret_is_not_accepted(self):
        import main

        port = self._free_port()
        with mock.patch.object(main, "SERVER_PORT", port), \
             mock.patch.object(main, "_ALLOWED_LOCAL_AUTHORITIES", main.allowed_local_authorities(port)):
            self._serve_on(main.app, port)
            self._write_secret(port, "segredo-sintetico-errado")
            self.assertIsNone(selector._probe_simpress(port))

    def test_missing_secret_file_is_not_accepted(self):
        import main

        port = self._free_port()
        with mock.patch.object(main, "SERVER_PORT", port), \
             mock.patch.object(main, "_ALLOWED_LOCAL_AUTHORITIES", main.allowed_local_authorities(port)):
            self._serve_on(main.app, port)
            self.assertIsNone(selector._probe_simpress(port))

    def test_slow_or_failing_version_check_after_identity_is_still_running(self):
        from fastapi import FastAPI
        from fastapi.responses import JSONResponse, RedirectResponse
        import time

        for mode in ("slow", "error"):
            fake = FastAPI()
            secret = "segredo-sintetico"
            port = self._free_port()
            cookie_name = f"simpress_sessao_{port}"

            @fake.get("/bootstrap")
            def bootstrap(t: str = ""):
                resposta = RedirectResponse("/", status_code=303)
                resposta.set_cookie(cookie_name, t)
                return resposta

            @fake.get("/api/automacao/estado")
            def estado(mode=mode):
                if mode == "slow":
                    time.sleep(selector.HTTP_PROBE_TIMEOUT + 0.5)
                    return {}
                return JSONResponse({}, status_code=500)

            self._serve_on(fake, port)
            self._write_secret(port, secret)
            with self.subTest(mode=mode):
                self.assertEqual(selector._probe_simpress(port), {"outdated": False})

    def test_impostor_with_same_title_openapi_is_not_accepted(self):
        from fastapi import FastAPI

        fake = FastAPI(title="Simpress Transferência de Equipamentos - SEBRAE/PR")

        @fake.get("/api/prontidao")
        def prontidao():
            return {}

        @fake.get("/api/stats")
        def stats():
            return {}

        port = self._free_port()
        self._serve_on(fake, port)
        self._write_secret(port, "segredo-sintetico")
        self.assertIsNone(selector._probe_simpress(port))


if __name__ == "__main__":
    unittest.main()
