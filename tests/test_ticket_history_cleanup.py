"""Tests for removing old service ticket imports while retaining the latest."""

import json
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from routers.operations import create_operations_router


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def route_handler(router, path, method):
    return next(
        route.endpoint for route in router.routes
        if getattr(route, "path", None) == path and method in getattr(route, "methods", set())
    )


class TicketHistoryCleanupTests(unittest.TestCase):
    def test_deletes_all_old_imports_and_keeps_the_latest_active_snapshot(self):
        with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as directory:
            path = Path(directory) / "tickets.json"
            snapshots = [
                {
                    "id": "older-1", "atualizado_em": "2026-10-08T12:00:00",
                    "fontes": {}, "resumo": {"series_total": 1}, "chamados": [{"serie": "OLD-1"}],
                },
                {
                    "id": "older-2", "atualizado_em": "2026-10-09T12:00:00",
                    "fontes": {}, "resumo": {"series_total": 1}, "chamados": [{"serie": "OLD-2"}],
                },
                {
                    "id": "latest", "atualizado_em": "2026-10-10T12:00:00",
                    "fontes": {}, "resumo": {"series_total": 1}, "chamados": [{"serie": "CURRENT"}],
                },
            ]
            latest = snapshots[-1]
            path.write_text(json.dumps({
                **latest,
                "snapshot_id": latest["id"],
                "historico": snapshots,
            }), encoding="utf-8")
            router = create_operations_router(
                load_comparison_history=lambda: [],
                comparison_history_for_display=lambda event: event,
                ticket_report_path=lambda: path,
                transaction_root=lambda: Path(directory),
            )

            delete_old = route_handler(router, "/api/operacoes/chamados/historico/antigas", "DELETE")
            result = delete_old()

            self.assertEqual(result["removidas"], 2)
            self.assertEqual(result["total"], 1)
            self.assertEqual(result["mantida"]["id"], "latest")
            stored = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(stored["snapshot_id"], "latest")
            self.assertEqual([item["id"] for item in stored["historico"]], ["latest"])
            self.assertEqual(stored["chamados"][0]["serie"], "CURRENT")

            history = route_handler(router, "/api/operacoes/chamados/historico", "GET")()
            self.assertEqual(history["total"], 1)
            self.assertEqual(history["eventos"][0]["id"], "latest")
            snapshot = route_handler(router, "/api/operacoes/chamados/snapshot/{snapshot_id}", "GET")("latest")
            self.assertEqual(snapshot["chamados"][0]["serie"], "CURRENT")
            with self.assertRaises(HTTPException) as deleted_snapshot:
                route_handler(router, "/api/operacoes/chamados/snapshot/{snapshot_id}", "GET")("older-1")
            self.assertEqual(deleted_snapshot.exception.status_code, 404)
            self.assertEqual(delete_old()["removidas"], 0)

    def test_does_not_delete_the_only_import(self):
        with tempfile.TemporaryDirectory(dir=tempfile.gettempdir()) as directory:
            path = Path(directory) / "tickets.json"
            latest = {
                "id": "only", "snapshot_id": "only", "atualizado_em": "2026-10-10T12:00:00",
                "fontes": {}, "resumo": {}, "chamados": [{"serie": "CURRENT"}], "historico": [],
            }
            path.write_text(json.dumps(latest), encoding="utf-8")
            router = create_operations_router(
                load_comparison_history=lambda: [],
                comparison_history_for_display=lambda event: event,
                ticket_report_path=lambda: path,
                transaction_root=lambda: Path(directory),
            )

            result = route_handler(router, "/api/operacoes/chamados/historico/antigas", "DELETE")()

            self.assertEqual(result["removidas"], 0)
            self.assertEqual(result["mantida"]["id"], "only")
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["snapshot_id"], "only")


if __name__ == "__main__":
    unittest.main()
