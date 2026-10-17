import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import main


def write_history(path: Path, absences):
    event = {"id": "evento-1", "horario": "17/10/2026 10:00", "comparacao": {"ausentes_no_endpoint": absences}}
    path.write_text(json.dumps([event]), encoding="utf-8")


class DashboardHistoryCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.history = Path(self.temp.name) / "historico_comparacoes.json"
        write_history(self.history, [{"serial": "A1"}])
        self.reads = 0
        original_read = main._read_json_history

        def counting_read(path, label):
            self.reads += 1
            return original_read(path, label)

        for patcher in (
            patch.object(main, "COMPARISON_HISTORY_FILE", self.history),
            patch.object(main, "_read_json_history", counting_read),
            patch.object(main, "_DASHBOARD_DETAILS_CACHE", None),
            patch.object(main, "get_historico_comparacoes", lambda: {"eventos": [{"id": "evento-1", "resumo": {}}]}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_unchanged_history_is_parsed_once(self):
        first = main._dashboard_comparison_events()
        second = main._dashboard_comparison_events()
        self.assertEqual(self.reads, 1)
        self.assertEqual(first, second)
        self.assertEqual(second[0]["comparacao"]["ausentes_no_endpoint"], [{"serial": "A1"}])

    def test_cached_details_are_not_shared_with_callers(self):
        main._dashboard_comparison_events()[0]["comparacao"]["ausentes_no_endpoint"].append({"serial": "X"})
        self.assertEqual(main._dashboard_comparison_events()[0]["comparacao"]["ausentes_no_endpoint"], [{"serial": "A1"}])

    def test_changed_history_is_read_again(self):
        main._dashboard_comparison_events()
        write_history(self.history, [{"serial": "A1"}, {"serial": "B2"}])
        stat = self.history.stat()
        os.utime(self.history, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        events = main._dashboard_comparison_events()
        self.assertEqual(self.reads, 2)
        self.assertEqual(len(events[0]["comparacao"]["ausentes_no_endpoint"]), 2)

    def test_missing_history_is_not_cached(self):
        self.history.unlink()
        self.assertEqual(main._dashboard_comparison_events(), [{"id": "evento-1", "resumo": {}}])
        self.assertIsNone(main._DASHBOARD_DETAILS_CACHE)


if __name__ == "__main__":
    unittest.main()
