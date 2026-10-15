import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.dashboard import DashboardServices, create_dashboard_router

CATEGORIES = ({"value": "notebook", "label": "Notebooks"}, {"value": "monitor", "label": "Monitores"})


def categorize(tipo, modelo):
    text = f"{tipo} {modelo}".upper()
    if "MONITOR" in text:
        return "monitor"
    if "NOTEBOOK" in text:
        return "notebook"
    return ""


def make_client(equipment, events, stats=None):
    router, _ = create_dashboard_router(DashboardServices(
        get_equipment=lambda: equipment,
        get_stats=lambda: stats if stats is not None else {"total_unidades": 4, "ultima_atualizacao": "01/01/2026 10:00"},
        get_comparison_events=events if callable(events) else (lambda: events),
        categories=CATEGORIES,
        categorize=categorize,
    ))
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class DashboardRouteTests(unittest.TestCase):
    def test_empty_base(self):
        data = make_client([], []).get("/api/painel").json()
        self.assertFalse(data["base_importada"])
        self.assertEqual(data["total_equipamentos"], 0)
        self.assertIsNone(data["ultima_comparacao"])
        self.assertEqual([c["total"] for c in data["por_categoria"]], [0, 0])

    def test_counts_cities_and_categories(self):
        equipment = [
            {"tipo": "Notebook", "modelo": "A", "retirada_cidade": "Curitiba"},
            {"tipo": "Notebook", "modelo": "B", "retirada_cidade": "Curitiba"},
            {"tipo": "Monitor", "modelo": "C", "retirada_cidade": "Londrina"},
            {"tipo": "Mouse", "modelo": "D", "retirada_cidade": ""},
        ]
        data = make_client(equipment, []).get("/api/painel").json()
        self.assertEqual(data["total_equipamentos"], 4)
        self.assertEqual({c["value"]: c["total"] for c in data["por_categoria"]}, {"notebook": 2, "monitor": 1})
        self.assertEqual(data["sem_categoria"], 1)
        self.assertEqual(data["sem_cidade"], 1)
        self.assertEqual(data["total_cidades"], 2)
        self.assertEqual(data["cidades_principais"][0], {"cidade": "Curitiba", "total": 2})
        self.assertEqual(data["total_unidades"], 4)

    def test_latest_comparison_lists_only_attention_items(self):
        events = [{"id": "e1", "horario": "2026-01-01T10:00:00", "tipo": "atualizacao",
                   "resumo": {"divergencias_local": 3, "sem_acesso_7_dias": 0, "ausentes_no_endpoint": "2"},
                   "comparacao": {"ausentes_no_endpoint": [{"serie": "N-1"}, {"serie": "N-2"}]}}]
        equipment = [{"serial": "N-1", "tipo": "Notebook"}, {"serial": "N-2", "tipo": "Notebook"}]
        latest = make_client(equipment, events).get("/api/painel").json()["ultima_comparacao"]
        self.assertEqual(latest["id"], "e1")
        self.assertEqual([(i["campo"], i["total"]) for i in latest["atencao"]],
                         [("divergencias_local", 3), ("ausentes_no_endpoint", 2)])

    def test_endpoint_absences_count_only_notebooks_and_macbooks(self):
        equipment = [
            {"serial": "N-1", "tipo": "Notebook", "modelo": "A"},
            {"serial": "M-1", "tipo": "Notebook", "modelo": "MacBook Air"},
            {"serial": "MON-1", "tipo": "Monitor", "modelo": "C"},
        ]
        events = [{"id": "e1", "horario": "2026-01-01T10:00:00", "tipo": "atualizacao",
                   "resumo": {"ausentes_no_endpoint": 4},
                   "comparacao": {"ausentes_no_endpoint": [
                       {"serie": "N-1"}, {"serie": "M-1 / X-9"}, {"serie": "MON-1"}, {"serie": ""}]}}]
        latest = make_client(equipment, events).get("/api/painel").json()["ultima_comparacao"]
        self.assertEqual([(i["campo"], i["total"]) for i in latest["atencao"]], [("ausentes_no_endpoint", 2)])
        self.assertIn("somente Notebooks e MacBooks", latest["atencao"][0]["rotulo"])

    def test_history_failure_does_not_break_panel(self):
        def broken():
            raise RuntimeError("boom")
        response = make_client([{"tipo": "Notebook"}], broken).get("/api/painel")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["ultima_comparacao"])


if __name__ == "__main__":
    unittest.main()
