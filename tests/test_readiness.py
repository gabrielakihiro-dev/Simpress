import io
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from domains import readiness

with patch("openpyxl.load_workbook", side_effect=RuntimeError("testes não acessam planilhas locais")):
    with redirect_stdout(io.StringIO()):
        import main
from core.integrity import lock_paths


class ReadinessReportCacheTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.cache = readiness.ReadinessReportCache(ttl_seconds=2.0, clock=lambda: self.now)
        self.calls = 0

    def compute(self):
        self.calls += 1
        return {"files": {"x": {"available": True}}, "calls": self.calls}

    def test_same_signature_reuses_report_within_ttl(self):
        first = self.cache.get_or_compute("sig", self.compute)
        first["files"]["x"]["available"] = False
        self.now += 1.9
        second = self.cache.get_or_compute("sig", self.compute)
        self.assertEqual(self.calls, 1)
        self.assertTrue(second["files"]["x"]["available"], "callers must not mutate the cached report")

    def test_signature_change_or_expiry_recomputes(self):
        self.cache.get_or_compute("sig", self.compute)
        self.cache.get_or_compute("other", self.compute)
        self.assertEqual(self.calls, 2)
        self.now += 2.0
        self.cache.get_or_compute("other", self.compute)
        self.assertEqual(self.calls, 3)

    def test_file_signature_changes_when_file_is_replaced_or_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            missing = readiness.file_signature([path, None])
            path.write_text("{}", encoding="utf-8")
            created = readiness.file_signature([path, None])
            path.write_text('{"a": 1}', encoding="utf-8")
            replaced = readiness.file_signature([path, None])
        self.assertEqual(len({missing, created, replaced}), 3)


class ReadinessWithoutGlobalLockTests(unittest.TestCase):
    def test_readiness_does_not_wait_for_the_global_transaction_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            holding = threading.Event()
            release = threading.Event()

            def hold_global_lock():
                with lock_paths([root / ".atomic-transactions"]):
                    holding.set()
                    release.wait(10)

            holder = threading.Thread(target=hold_global_lock)
            holder.start()
            try:
                self.assertTrue(holding.wait(10))
                with (
                    patch.object(main, "TRANSACTION_ROOT", root),
                    patch.object(main, "INPUT_DIR", root / "entrada"),
                    patch.object(main, "TEMPLATE_FILE", root / "template.xlsx"),
                    patch.object(main, "DETAILS_UPLOAD_FILE", root / "detalhes.xlsx"),
                    patch.object(main, "ENDPOINT_UPLOAD_FILE", root / "endpoint.xlsx"),
                    patch.object(main, "EXPORT_MODEL_FILE", root / "export.xlsx"),
                    patch.object(main, "TICKET_REPORT_FILE", root / "chamados.json"),
                    patch.object(main, "MODIFIED_APELIDOS_FILE", root / "apelidos.json"),
                    patch.object(main, "CUSTOM_UNIDADES_FILE", root / "unidades.json"),
                    patch.object(main, "ALIAS_HISTORY_FILE", root / "aliases.json"),
                    patch.object(main, "COMPARISON_HISTORY_FILE", root / "comparison.json"),
                    patch.object(main, "lock_paths", side_effect=AssertionError("readiness must not lock")),
                ):
                    report = main.get_startup_readiness()
            finally:
                release.set()
                holder.join(10)
        self.assertEqual(report["backend"], "files")
        self.assertFalse(report["functions"]["consulta_equipamentos"]["available"])


if __name__ == "__main__":
    unittest.main()
