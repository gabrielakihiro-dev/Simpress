import importlib.util
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "select_server_port.py"
spec = importlib.util.spec_from_file_location("select_server_port", SCRIPT)
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)


class SelectServerPortTests(unittest.TestCase):
    def run_main(self, document):
        with mock.patch.object(selector, "_is_port_available", side_effect=lambda p: p != 8000), \
             mock.patch.object(selector, "_probe_simpress", side_effect=lambda p: document if p == 8000 else None), \
             mock.patch.object(selector, "_listening_pid", return_value="4321"), \
             mock.patch("builtins.print") as printed:
            code = selector.main()
        return code, printed.call_args_list

    def test_outdated_server_is_reported_with_port_and_pid(self):
        document = {"paths": {"/api/prontidao": {}, "/api/stats": {}}}
        code, calls = self.run_main(document)
        self.assertEqual(code, 0)
        self.assertEqual(calls[-1].args[0], "OUTDATED:8000")
        warning = calls[0].args[0]
        self.assertIn("porta 8000 (PID 4321)", warning)
        self.assertIn("desatualizado", warning)

    def test_current_server_is_reused(self):
        paths = dict.fromkeys(selector.EXPECTED_PATHS | selector.CURRENT_PATHS, {})
        code, calls = self.run_main({"paths": paths})
        self.assertEqual(code, 0)
        self.assertEqual(calls[-1].args[0], "RUNNING:8000")

    def test_foreign_program_on_port_warns_and_picks_next_port(self):
        code, calls = self.run_main(None)
        self.assertEqual(code, 0)
        self.assertIn("porta 8000 (PID 4321)", calls[0].args[0])
        self.assertEqual(calls[-1].args[0], "PORT:8001")

    def test_probe_accepts_401_from_stats_without_session_cookie(self):
        import io
        import json
        from urllib.error import HTTPError

        paths = dict.fromkeys(selector.EXPECTED_PATHS | selector.CURRENT_PATHS, {})
        document = {"info": {"title": selector.EXPECTED_TITLE}, "paths": paths}

        class Opener:
            def open(self, url, timeout):
                if url.endswith("/openapi.json"):
                    return io.BytesIO(json.dumps(document).encode())
                raise HTTPError(url, 401, "Unauthorized", {}, io.BytesIO(b"{}"))

        connection = mock.MagicMock()
        connection.__enter__.return_value.connect_ex.return_value = 0
        with mock.patch.object(selector.socket, "socket", return_value=connection),              mock.patch.object(selector, "build_opener", return_value=Opener()):
            self.assertEqual(selector._probe_simpress(8000), document)


if __name__ == "__main__":
    unittest.main()
