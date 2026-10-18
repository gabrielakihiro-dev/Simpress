"""Stale base alert on the Home panel (docs/operacao/alerta-base-desatualizada.md)."""

import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.dashboard import DashboardServices, base_date_from_history, create_dashboard_router, stale_base_status

TZ = timezone(timedelta(hours=-3))
NOW = datetime(2026, 10, 17, 12, 0, tzinfo=TZ)


def update(event_id, moment):
    return {"id": event_id, "horario": moment.isoformat(), "comparacao": {}}


def restoration(event_id, moment, source_id):
    return {
        "id": event_id, "tipo": "restauracao", "horario": moment.isoformat(),
        "restauracao_de": {"evento_id": source_id}, "comparacao": {"restauracao_de": {"evento_id": source_id}},
    }


class StaleBaseStatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.details = Path(self.tmp.name) / "EquipamentosDetalhes_atual.xlsx"
        self.details.write_bytes(b"xlsx")

    def tearDown(self):
        self.tmp.cleanup()

    def set_file_time(self, moment):
        os.utime(self.details, (moment.timestamp(), moment.timestamp()))

    def test_missing_base_reports_sem_base(self):
        result = stale_base_status([update("a", NOW)], Path(self.tmp.name) / "ausente.xlsx", NOW)
        self.assertEqual(result["estado"], "sem_base")
        self.assertIsNone(result["dias_sem_atualizacao"])
        self.assertEqual(stale_base_status([], None, NOW)["estado"], "sem_base")

    def test_history_date_wins_over_older_file_time(self):
        updated = NOW - timedelta(days=9, hours=2)
        self.set_file_time(updated - timedelta(minutes=5))
        result = stale_base_status([update("a", updated)], self.details, NOW)
        self.assertEqual(result["estado"], "desatualizada")
        self.assertEqual(result["dias_sem_atualizacao"], 9)
        self.assertEqual(result["origem_data"], "historico")
        self.assertEqual(result["ultima_atualizacao"], updated.astimezone().isoformat(timespec="seconds"))
        self.assertEqual(result["limite_dias"], 7)

    def test_limit_is_strictly_more_than_seven_days(self):
        self.set_file_time(NOW - timedelta(days=30))
        exactly = stale_base_status([update("a", NOW - timedelta(days=7))], self.details, NOW)
        self.assertEqual(exactly["estado"], "atualizada")
        past = stale_base_status([update("a", NOW - timedelta(days=7, minutes=1))], self.details, NOW)
        self.assertEqual(past["estado"], "desatualizada")
        self.assertEqual(past["dias_sem_atualizacao"], 7)

    def test_configurable_limit(self):
        self.set_file_time(NOW - timedelta(days=30))
        history = [update("a", NOW - timedelta(days=4))]
        self.assertEqual(stale_base_status(history, self.details, NOW, limit_days=3)["estado"], "desatualizada")
        self.assertEqual(stale_base_status(history, self.details, NOW, limit_days=3)["limite_dias"], 3)

    def test_newest_update_counts_regardless_of_order(self):
        self.set_file_time(NOW - timedelta(days=30))
        history = [update("b", NOW - timedelta(days=2)), update("a", NOW - timedelta(days=20))]
        self.assertEqual(stale_base_status(history, self.details, NOW)["estado"], "atualizada")

    def test_without_history_uses_file_time(self):
        self.set_file_time(NOW - timedelta(days=10))
        result = stale_base_status([], self.details, NOW)
        self.assertEqual((result["estado"], result["origem_data"]), ("desatualizada", "arquivo"))

    def test_file_replaced_outside_the_flow_uses_file_time(self):
        self.set_file_time(NOW - timedelta(days=1))
        result = stale_base_status([update("a", NOW - timedelta(days=12))], self.details, NOW)
        self.assertEqual((result["estado"], result["origem_data"]), ("atualizada", "arquivo"))

    def test_restoration_keeps_the_restored_base_date(self):
        first, second = NOW - timedelta(days=20), NOW - timedelta(days=10)
        restored_at = NOW - timedelta(minutes=1)
        self.set_file_time(restored_at)
        # Restoring "b" brings back the base that was active before it, i.e. the one from "a".
        history = [update("a", first), update("b", second), restoration("r", restored_at, "b")]
        result = stale_base_status(history, self.details, NOW)
        self.assertEqual((result["estado"], result["origem_data"]), ("desatualizada", "historico"))
        self.assertEqual(result["dias_sem_atualizacao"], 20)

    def test_undoing_a_restoration_returns_the_newer_base(self):
        moments = [NOW - timedelta(days=20), NOW - timedelta(days=2), NOW - timedelta(days=1), NOW - timedelta(hours=1)]
        history = [update("a", moments[0]), update("b", moments[1]),
                   restoration("r", moments[2], "b"), restoration("u", moments[3], "r")]
        base_date, newest = base_date_from_history(history)
        self.assertEqual(base_date, moments[1])
        self.assertEqual(newest, moments[3])

    def test_restoring_the_first_known_event_uses_its_time_as_bound(self):
        history = [update("a", NOW - timedelta(days=3)), restoration("r", NOW - timedelta(hours=1), "a")]
        self.assertEqual(base_date_from_history(history)[0], NOW - timedelta(days=3))

    def test_invalid_history_entries_are_ignored(self):
        history = ["x", {"id": "a", "horario": "ontem"}, {"id": "b"}]
        self.assertEqual(base_date_from_history(history), (None, None))


class StaleBaseRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.details = Path(self.tmp.name) / "EquipamentosDetalhes_atual.xlsx"

    def tearDown(self):
        self.tmp.cleanup()

    def client(self, history, **overrides):
        options = {
            "get_comparison_history": history if callable(history) else (lambda: history),
            "get_details_file": lambda: self.details,
            "now": lambda: NOW,
        }
        options.update(overrides)
        router, _ = create_dashboard_router(DashboardServices(
            get_equipment=lambda: [], get_stats=lambda: {}, get_comparison_events=lambda: [],
            categories=(), categorize=lambda *_: "", **options,
        ))
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def test_panel_reports_stale_base(self):
        self.details.write_bytes(b"xlsx")
        os.utime(self.details, ((NOW - timedelta(days=30)).timestamp(),) * 2)
        data = self.client([update("a", NOW - timedelta(days=9))]).get("/api/painel").json()
        self.assertEqual(data["base_desatualizada"]["estado"], "desatualizada")
        self.assertEqual(data["base_desatualizada"]["dias_sem_atualizacao"], 9)

    def test_missing_base_does_not_break_the_panel(self):
        response = self.client([]).get("/api/painel")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["base_desatualizada"]["estado"], "sem_base")
        self.assertFalse(response.json()["base_importada"])

    def test_unreadable_history_falls_back_to_file_time(self):
        self.details.write_bytes(b"xlsx")
        os.utime(self.details, ((NOW - timedelta(days=8)).timestamp(),) * 2)

        def broken():
            raise RuntimeError("histórico corrompido")

        data = self.client(broken).get("/api/painel").json()["base_desatualizada"]
        self.assertEqual((data["estado"], data["origem_data"]), ("desatualizada", "arquivo"))

    def test_unexpected_error_hides_alert_but_keeps_panel(self):
        def broken_file():
            raise OSError("disco indisponível")

        response = self.client([], get_details_file=broken_file).get("/api/painel")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["base_desatualizada"]["estado"], "indisponivel")

    def test_panel_without_service_returns_null(self):
        router, _ = create_dashboard_router(DashboardServices(
            get_equipment=lambda: [], get_stats=lambda: {}, get_comparison_events=lambda: [],
            categories=(), categorize=lambda *_: "",
        ))
        app = FastAPI()
        app.include_router(router)
        self.assertIsNone(TestClient(app).get("/api/painel").json()["base_desatualizada"])


if __name__ == "__main__":
    unittest.main()
