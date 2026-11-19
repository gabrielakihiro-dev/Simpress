"""Caches that keep the home load fast: the 60-day alert and the notes read by the history list."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from domains.history_annotations import load_history_annotations, save_history_annotation
from routers import dashboard
from routers.inventory_history import create_inventory_history_router


class LongUnusedCacheTests(unittest.TestCase):
    def setUp(self):
        self.calls = 0
        self.signature = ("historico", 1)
        self.series = frozenset({"S1"})
        self.history = []
        original = dashboard.long_unused_status

        def counting(history, *args, **kwargs):
            # The "unavailable" fallback also calls it with a fresh empty list; count only the real history.
            self.calls += history is self.history
            return original(history, *args, **kwargs)

        for patcher in (
            patch.object(dashboard, "_LONG_UNUSED_CACHE", None),
            patch.object(dashboard, "_NEW_DIVERGENCES_CACHE", None),
            patch.object(dashboard, "long_unused_status", counting),
            patch.object(dashboard, "series_sebrae", lambda: self.series),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.services = dashboard.DashboardServices(
            get_equipment=lambda: [], get_stats=lambda: {}, get_comparison_events=lambda: [],
            categories=[], categorize=lambda *_args: "",
            get_comparison_history=lambda: self.history,
            get_comparison_history_signature=lambda: self.signature,
        )

    def alert(self):
        return dashboard.build_dashboard(self.services)["sem_acesso_60_dias"]

    def test_alert_is_reused_until_history_or_sebrae_series_change(self):
        first = self.alert()
        first["estado"] = "alterado"
        self.assertNotEqual(self.alert()["estado"], "alterado", "callers do not share the cached result")
        self.assertEqual(self.calls, 1)

        self.signature = ("historico", 2)
        self.alert()
        self.assertEqual(self.calls, 2)

        self.series = frozenset({"S1", "S2"})
        self.alert()
        self.assertEqual(self.calls, 3)

    def test_without_signature_the_alert_is_always_recomputed(self):
        self.services = dashboard.DashboardServices(**{**self.services.__dict__, "get_comparison_history_signature": None})
        self.alert()
        self.alert()
        self.assertEqual(self.calls, 2)
        self.assertIsNone(dashboard._LONG_UNUSED_CACHE)


class HistoryListAnnotationCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".painel-cache-test-")
        self.addCleanup(temporary.cleanup)
        self.shared = Path(temporary.name) / "shared"
        self.outbox = Path(temporary.name) / "outbox"
        self.loads = 0

        def counting_load(*args, **kwargs):
            self.loads += 1
            return load_history_annotations(*args, **kwargs)

        services = SimpleNamespace(
            history_annotations_directory=lambda: self.shared,
            local_annotation_outbox_directory=lambda: self.outbox,
            load_history_annotations=counting_load,
            load_comparison_history=lambda: [],
        )
        router = create_inventory_history_router(services)[0]
        self.listing = next(route.endpoint for route in router.routes if route.path == "/api/historico-comparacoes")

    def save(self, event_id, note):
        return save_history_annotation(self.shared, event_id=event_id, item_id="row", event_time="2026-10-11T10:00:00",
                                       serie="S1", computador="HOST", motivo="Motivo", anotacao=note)

    def event_ids(self):
        return [evento["id"] for evento in self.listing()["eventos"]]

    def test_unchanged_note_folders_are_read_once(self):
        self.save("evento-1", "Nota")
        self.assertEqual(self.event_ids(), ["evento-1"])
        loads = self.loads
        self.assertEqual(self.event_ids(), ["evento-1"])
        self.assertEqual(self.loads, loads)

    def test_new_note_file_is_listed(self):
        self.save("evento-1", "Nota")
        self.event_ids()
        self.save("evento-2", "Outra nota")
        self.assertEqual(sorted(self.event_ids()), ["evento-1", "evento-2"])

    def test_changed_note_file_is_read_again(self):
        self.save("evento-1", "Nota")
        self.assertEqual(self.event_ids(), ["evento-1"])
        path = next(self.shared.glob("*.json"))
        record = json.loads(path.read_text(encoding="utf-8"))
        record["anotacao"] = ""
        stat = path.stat()
        path.write_text(json.dumps(record), encoding="utf-8")
        # Bump the mtime explicitly so the test does not depend on the file system's clock resolution.
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        self.assertEqual(self.event_ids(), [], "an event whose only note was cleared leaves the list")


if __name__ == "__main__":
    unittest.main()
