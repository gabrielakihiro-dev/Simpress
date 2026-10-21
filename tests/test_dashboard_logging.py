"""Falhas dos alertas opcionais do painel são registradas sem derrubar a resposta."""

import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.dashboard import DashboardServices, create_dashboard_router

CATEGORIES = ({"value": "notebook", "label": "Notebooks"},)


def _boom(*_args, **_kwargs):
    raise RuntimeError("falha simulada")


def _client(**overrides):
    router, _ = create_dashboard_router(DashboardServices(
        get_equipment=lambda: [{"tipo": "Notebook", "modelo": "A", "retirada_cidade": "Curitiba"}],
        get_stats=lambda: {"total_unidades": 1},
        get_comparison_events=lambda: [],
        categories=CATEGORIES,
        categorize=lambda tipo, modelo: "notebook",
        **overrides,
    ))
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class DashboardFailureLoggingTests(unittest.TestCase):
    def assert_logged_and_ok(self, client, fragment):
        with self.assertLogs("routers.dashboard", level="WARNING") as captured:
            response = client.get("/api/painel")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total_equipamentos"], 1)
        self.assertTrue(any(fragment in record.getMessage() and record.exc_info for record in captured.records))
        return response.json()

    def test_comparison_events_failure_is_logged(self):
        router, _ = create_dashboard_router(DashboardServices(
            get_equipment=lambda: [{"tipo": "Notebook"}],
            get_stats=lambda: {},
            get_comparison_events=_boom,
            categories=CATEGORIES,
            categorize=lambda tipo, modelo: "notebook",
        ))
        app = FastAPI()
        app.include_router(router)
        data = self.assert_logged_and_ok(TestClient(app), "eventos de comparação")
        self.assertIsNone(data["ultima_comparacao"])

    def test_history_failure_is_logged(self):
        data = self.assert_logged_and_ok(_client(get_comparison_history=_boom, display_comparison=lambda e: e), "histórico")
        self.assertEqual(data["divergencias_novas"]["estado"], "indisponivel")

    def test_stale_base_failure_is_logged(self):
        data = self.assert_logged_and_ok(_client(get_details_file=_boom), "base desatualizada")
        self.assertEqual(data["base_desatualizada"]["estado"], "indisponivel")

    def test_stale_tickets_failure_is_logged(self):
        data = self.assert_logged_and_ok(_client(get_ticket_report=_boom), "OS paradas")
        self.assertEqual(data["os_paradas"]["estado"], "indisponivel")

    def test_new_divergences_failure_is_logged(self):
        data = self.assert_logged_and_ok(
            _client(get_comparison_history=lambda: [
                {"id": "a", "horario": "2026-01-01T10:00:00+00:00"},
                {"id": "b", "horario": "2026-01-02T10:00:00+00:00"},
            ], display_comparison=_boom), "divergências novas"
        )
        self.assertIsNotNone(data["divergencias_novas"])


if __name__ == "__main__":
    unittest.main()
