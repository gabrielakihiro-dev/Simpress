import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import main
from routers import dashboard


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


class NewDivergencesCacheTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(dashboard, "_NEW_DIVERGENCES_CACHE", None)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.displayed = 0
        self.signature = ("historico", 1)
        self.history = [
            {"id": "a", "horario": "2026-10-16T10:00:00-03:00", "comparacao": {"divergencias_local": []}},
            {"id": "b", "horario": "2026-10-17T10:00:00-03:00",
             "comparacao": {"divergencias_local": [{"serie": "S1", "hostname": "H1"}]}},
        ]

        def display(event):
            self.displayed += 1
            return main.comparison_history_for_display(event)

        self.services = dashboard.DashboardServices(
            get_equipment=lambda: [],
            get_stats=lambda: {},
            get_comparison_events=lambda: [],
            categories=[],
            categorize=lambda *_args: "",
            get_comparison_history=lambda: self.history,
            display_comparison=display,
            get_comparison_history_signature=lambda: self.signature,
        )

    def test_unchanged_history_reuses_the_alert_until_the_signature_changes(self):
        first = dashboard.build_dashboard(self.services)["divergencias_novas"]
        first["total"] = 99
        second = dashboard.build_dashboard(self.services)["divergencias_novas"]
        self.assertEqual(self.displayed, 2)
        self.assertEqual(second["total"], 1, "callers do not share the cached result")

        self.history[1]["comparacao"]["divergencias_local"].append({"serie": "S2", "hostname": "H2"})
        self.signature = ("historico", 2)
        self.assertEqual(dashboard.build_dashboard(self.services)["divergencias_novas"]["total"], 2)
        self.assertEqual(self.displayed, 4)

    def test_without_signature_the_alert_is_always_recomputed(self):
        self.services = replace(self.services, get_comparison_history_signature=None)
        dashboard.build_dashboard(self.services)
        dashboard.build_dashboard(self.services)
        self.assertEqual(self.displayed, 4)
        self.assertIsNone(dashboard._NEW_DIVERGENCES_CACHE)


class PrimaryEquipmentFileCacheTests(unittest.TestCase):
    def test_details_sheet_is_checked_once_per_file_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            details = Path(directory) / "EquipamentosDetalhes_atual.xlsx"
            details.write_bytes(b"fixture")
            checks = []
            sheet = {"name": "EquipamentosDetalhes"}

            def find(path):
                checks.append(path)
                return sheet["name"]

            with patch.object(main, "DETAILS_UPLOAD_FILE", details), \
                    patch.object(main, "find_details_sheet", find), \
                    patch.object(main, "_PRIMARY_SHEET_CACHE", None):
                self.assertEqual(main.get_primary_equipment_file(), details)
                self.assertEqual(main.get_primary_equipment_file(), details)
                self.assertEqual(len(checks), 1)

                sheet["name"] = None
                details.write_bytes(b"fixture-changed")
                self.assertIsNone(main.get_primary_equipment_file())
                self.assertEqual(len(checks), 2)


if __name__ == "__main__":
    unittest.main()
