import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from domains.usage_metrics import (
    METRICS,
    InvalidManualMinutesError,
    SearchSessionTracker,
    UsageMetricsCorruptionError,
    UsageMetricsMiddleware,
    UsageMetricsStore,
    summarize,
    validate_manual_minutes,
)
from routers.dashboard import DashboardServices, create_dashboard_router


class Clock:
    def __init__(self, today):
        self.today = today

    def __call__(self):
        return self.today


class UsageMetricsStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / "state" / "metricas_uso.json"
        self.clock = Clock(date(2026, 10, 17))
        self.store = UsageMetricsStore(lambda: self.path, lambda: self.root, today=self.clock)

    def tearDown(self):
        self.tmp.cleanup()

    def stored(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def test_increment_adds_to_today_and_creates_the_file(self):
        self.store.increment("transferencias")
        self.store.increment("transferencias")
        self.store.increment("os_conciliadas", 12)
        self.assertEqual(self.stored()["dias"], {"2026-10-17": {"transferencias": 2, "os_conciliadas": 12}})
        self.assertFalse(any((self.root / ".transactions").glob("*/manifest.json")))

    def test_file_holds_only_dates_counts_and_minutes(self):
        self.store.increment("buscas")
        self.store.set_manual_minutes({"transferencias": 15})
        data = self.stored()
        self.assertEqual(set(data), {"versao", "dias", "tempos_minutos"})
        for day, counts in data["dias"].items():
            date.fromisoformat(day)
            self.assertTrue(set(counts) <= set(METRICS))
            self.assertTrue(all(isinstance(value, int) for value in counts.values()))

    def test_unknown_metric_is_rejected(self):
        with self.assertRaises(ValueError):
            self.store.increment("senhas")

    def test_new_day_starts_a_new_counter_and_old_days_are_pruned(self):
        self.clock.today = date(2024, 1, 1)
        self.store.increment("exportacoes")
        self.clock.today = date(2026, 10, 16)
        self.store.increment("exportacoes")
        self.clock.today = date(2026, 10, 17)
        self.store.increment("exportacoes", 3)
        self.assertEqual(self.stored()["dias"], {
            "2026-10-16": {"exportacoes": 1},
            "2026-10-17": {"exportacoes": 3},
        })

    def test_corrupt_file_is_preserved_and_record_never_raises(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{ não é json", encoding="utf-8")
        self.assertFalse(self.store.record("transferencias"))
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{ não é json")
        summary = self.store.summary()
        self.assertFalse(summary["disponivel"])
        self.assertEqual(summary["totais"]["transferencias"], 0)

    def test_invalid_structure_is_preserved(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("[]", encoding="utf-8")
        with self.assertRaises(UsageMetricsCorruptionError):
            self.store.increment("buscas")
        self.assertEqual(self.path.read_text(encoding="utf-8"), "[]")

    def test_comparison_replay_counts_once(self):
        result = {"comparacao": {"evento_id": "evt-1"}}
        self.assertTrue(self.store.record_comparison(result))
        self.assertFalse(self.store.record_comparison(result))
        self.assertTrue(self.store.record_comparison({"comparacao": {"evento_id": "evt-2"}}))
        self.assertEqual(self.stored()["dias"]["2026-10-17"], {"comparacoes": 2})

    def test_ticket_reconciliation_adds_reconciled_series(self):
        self.store.record_ticket_reconciliation({"resumo": {"series_total": 40}, "chamados": [{"serie": "S-1"}]})
        self.store.record_ticket_reconciliation({"resumo": {"series_total": 0}})
        self.assertEqual(self.stored()["dias"]["2026-10-17"], {"os_conciliadas": 40})
        self.assertNotIn("S-1", self.path.read_text(encoding="utf-8"))


class SummaryTests(unittest.TestCase):
    def test_thirty_day_window_includes_today_and_excludes_older_days(self):
        today = date(2026, 10, 17)
        store = {"dias": {
            "2026-09-17": {"transferencias": 100},  # 31 days ago: outside
            "2026-09-18": {"transferencias": 2, "buscas": 5},  # first day of the window
            "2026-10-17": {"transferencias": 1, "os_conciliadas": 7},
            "2026-10-18": {"transferencias": 50},  # future (clock change): outside
        }}
        summary = summarize(store, today)
        self.assertEqual(summary["periodo"], {"inicio": "2026-09-18", "fim": "2026-10-17", "dias": 30})
        self.assertEqual(summary["totais"], {
            "transferencias": 3, "comparacoes": 0, "exportacoes": 0, "os_conciliadas": 7, "buscas": 5,
        })
        self.assertEqual(len(summary["por_dia"]), 30)
        self.assertEqual(summary["por_dia"][0]["data"], "2026-09-18")
        self.assertEqual(summary["por_dia"][-1], {
            "data": "2026-10-17", "transferencias": 1, "comparacoes": 0, "exportacoes": 0, "os_conciliadas": 7, "buscas": 0,
        })
        self.assertEqual(sum(day["transferencias"] for day in summary["por_dia"]), summary["totais"]["transferencias"])
        self.assertEqual(summary["registro_desde"], "2026-09-17")

    def test_saved_hours_use_configured_minutes_only(self):
        today = date(2026, 10, 17)
        store = {
            "dias": {(today - timedelta(days=1)).isoformat(): {"transferencias": 4, "buscas": 30, "exportacoes": 2}},
            "tempos_minutos": {"transferencias": 15, "buscas": 1, "exportacoes": None},
        }
        summary = summarize(store, today)
        self.assertTrue(summary["tempos_configurados"])
        self.assertEqual(summary["minutos_economizados"], 90)
        self.assertEqual(summary["horas_economizadas"], 1.5)

    def test_without_minutes_there_is_no_estimate(self):
        summary = summarize({"dias": {"2026-10-17": {"buscas": 3}}}, date(2026, 10, 17))
        self.assertFalse(summary["tempos_configurados"])
        self.assertEqual(summary["horas_economizadas"], 0)

    def test_manual_minutes_validation(self):
        self.assertEqual(validate_manual_minutes({"transferencias": 12.25, "buscas": None})["transferencias"], 12.2)
        for invalid in ({"transferencias": -1}, {"transferencias": 481}, {"transferencias": "10"},
                        {"transferencias": True}, {"outra": 1}, None, []):
            with self.subTest(invalid=invalid), self.assertRaises(InvalidManualMinutesError):
                validate_manual_minutes(invalid)


class SearchSessionTests(unittest.TestCase):
    def test_typing_and_filters_fold_into_one_search(self):
        now = [0.0]
        tracker = SearchSessionTracker(window_seconds=30, clock=lambda: now[0])
        self.assertTrue(tracker.is_new_search("BR"))
        now[0] = 1
        self.assertFalse(tracker.is_new_search("BRJ1"))
        now[0] = 2
        self.assertFalse(tracker.is_new_search("brj1 "))
        now[0] = 3
        self.assertTrue(tracker.is_new_search("Curitiba"))
        now[0] = 40
        self.assertTrue(tracker.is_new_search("Curitiba"))
        self.assertFalse(tracker.is_new_search("   "))


class MiddlewareTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.path = root / "metricas_uso.json"
        self.store = UsageMetricsStore(lambda: self.path, lambda: root, today=lambda: date(2026, 10, 17))
        app = FastAPI()

        @app.post("/api/gerar-planilha")
        def generate():
            return {"ok": True}

        @app.get("/api/exportar-equipamentos")
        def export():
            return JSONResponse({"detail": "indisponível"}, status_code=409)

        @app.get("/api/buscar-expandida")
        def search(q: str, offset: int = 0):
            return {"items": []}

        @app.get("/api/stats")
        def stats():
            return {}

        app.add_middleware(UsageMetricsMiddleware, store=self.store)
        self.client = TestClient(app)

    def tearDown(self):
        self.tmp.cleanup()

    def counts(self):
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))["dias"].get("2026-10-17", {})

    def test_counts_successful_tasks_only(self):
        self.client.post("/api/gerar-planilha")
        self.client.get("/api/exportar-equipamentos")
        self.client.get("/api/stats")
        self.assertEqual(self.counts(), {"transferencias": 1})

    def test_search_pagination_and_continued_typing_do_not_add(self):
        self.client.get("/api/buscar-expandida", params={"q": "BRJ"})
        self.client.get("/api/buscar-expandida", params={"q": "BRJ1", "offset": 0})
        self.client.get("/api/buscar-expandida", params={"q": "BRJ1", "offset": 50})
        self.client.get("/api/buscar-expandida", params={"q": "Curitiba"})
        self.assertEqual(self.counts(), {"buscas": 2})
        self.assertNotIn("BRJ", self.path.read_text(encoding="utf-8"))


class DashboardUsageRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = UsageMetricsStore(lambda: root / "m.json", lambda: root, today=lambda: date(2026, 10, 17))
        router, _ = create_dashboard_router(DashboardServices(
            get_equipment=lambda: [], get_stats=lambda: {}, get_comparison_events=lambda: [],
            categories=(), categorize=lambda *_: "",
            get_usage_summary=self.store.summary, set_manual_minutes=self.store.set_manual_minutes,
        ))
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)

    def tearDown(self):
        self.tmp.cleanup()

    def test_panel_includes_usage_and_minutes_update_hours(self):
        self.store.increment("transferencias", 6)
        usage = self.client.get("/api/painel").json()["uso_30_dias"]
        self.assertEqual(usage["totais"]["transferencias"], 6)
        self.assertFalse(usage["tempos_configurados"])
        response = self.client.put("/api/painel/tempos-manuais", json={"tempos_minutos": {"transferencias": 20}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["horas_economizadas"], 2.0)
        self.assertEqual(self.client.get("/api/painel").json()["uso_30_dias"]["tempos_minutos"]["transferencias"], 20)

    def test_invalid_minutes_return_422(self):
        response = self.client.put("/api/painel/tempos-manuais", json={"tempos_minutos": {"transferencias": 900}})
        self.assertEqual(response.status_code, 422)

    def test_panel_without_usage_service_keeps_working(self):
        router, _ = create_dashboard_router(DashboardServices(
            get_equipment=lambda: [], get_stats=lambda: {}, get_comparison_events=lambda: [],
            categories=(), categorize=lambda *_: "",
        ))
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        self.assertIsNone(client.get("/api/painel").json()["uso_30_dias"])
        self.assertEqual(client.put("/api/painel/tempos-manuais", json={}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
