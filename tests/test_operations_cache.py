"""The ticket report is read once and re-read only when its file changes."""

import json
import os
import tempfile
import unittest
from pathlib import Path

from routers.operations import create_operations_router


def route_handler(router, path, method="GET"):
    return next(
        route.endpoint for route in router.routes
        if getattr(route, "path", None) == path and method in getattr(route, "methods", set())
    )


def write_report(path: Path, serial: str, mtime_ns: int) -> None:
    path.write_text(json.dumps({
        "snapshot_id": "atual", "atualizado_em": "2026-11-18T10:00:00", "fontes": {}, "resumo": {},
        "chamados": [{"serie": serial}], "historico": [],
    }), encoding="utf-8")
    os.utime(path, ns=(mtime_ns, mtime_ns))


class TicketReportCacheTests(unittest.TestCase):
    def test_report_cache_is_invalidated_when_the_file_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tickets.json"
            write_report(path, "SERIE-A", 1_700_000_000_000_000_000)
            router = create_operations_router(
                load_comparison_history=lambda: [],
                comparison_history_for_display=lambda event: event,
                ticket_report_path=lambda: path,
                transaction_root=lambda: Path(directory),
            )
            report = route_handler(router, "/api/operacoes/chamados")
            history = route_handler(router, "/api/operacoes/chamados/historico")

            self.assertEqual(report()["chamados"][0]["serie"], "SERIE-A")
            self.assertEqual(report()["chamados"][0]["serie"], "SERIE-A")

            # Same size, new content and mtime: the next GET must read the new file.
            write_report(path, "SERIE-B", 1_700_000_001_000_000_000)
            self.assertEqual(report()["chamados"][0]["serie"], "SERIE-B")
            self.assertEqual(history()["total"], 1)

            # A file that disappears falls back to the empty report, not to the cached one.
            path.unlink()
            self.assertEqual(report()["chamados"], [])


if __name__ == "__main__":
    unittest.main()
