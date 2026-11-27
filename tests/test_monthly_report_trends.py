"""Tendências do Relatório mensal (F8): agregados somente leitura, só dados sintéticos."""

import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from core.errors import DomainError
from domains.history_insights import PINNED_BASELINE_ID
from domains.inventory_comparison import comparison_history_for_display
from domains.monthly_report import build_trends
from routers.monthly_report import MonthlyReportServices, create_monthly_report_router

TODAY = date(2026, 11, 26)  # janela 30: 28/10 a 26/11; anterior: 28/09 a 27/10
SECRET_SERIAL = "SN-SECRETA-777"
SECRET_HOST = "HOST-SECRETO-01"


def oracle(number, created, concluded="", sub_status="Concluído", status="Gestão da Mesa de Operações"):
    return {
        "solicitacao": f"SOL-{number}", "ordem_servico": number, "status": status, "sub_status": sub_status,
        "data_criacao": created, "data_conclusao": concluded, "serie": SECRET_SERIAL,
    }


def report(*items):
    return {"snapshot_id": "snap-2", "atualizado_em": "2026-11-20T10:00:00", "chamados": [
        {"serie": SECRET_SERIAL, "oracle": [item]} for item in items
    ], "historico": [{"id": "snap-1", "atualizado_em": "2026-11-01T10:00:00", "chamados": [
        {"serie": SECRET_SERIAL, "oracle": [oracle("C", "01/11/2026 08:00", "05/11/2026 08:00")]},
    ]}]}


TICKETS = report(
    oracle("A", "01/11/2026 08:00", "11/11/2026 08:00"),  # 10 dias
    oracle("B", "01/09/2026 08:00", "12/10/2026 08:00"),  # 41 dias, concluída há 45 dias
    oracle("C", "01/11/2026 08:00", "21/11/2026 08:00"),  # 20 dias; a importação nova vence a de 4 dias
    oracle("D", "20/11/2026 08:00", "10/11/2026 08:00"),  # duração negativa
    oracle("E", "05/11/2026 08:00", "", sub_status="Cancelado"),  # encerrada sem data de conclusão
)


def event(event_id, moment, resumo=None, comparacao=None, **extra):
    return {"id": event_id, "horario": moment, "tipo": "atualizacao", "resumo": resumo or {},
            "comparacao": comparacao or {}, **extra}


HISTORY = [
    event("old", "2026-09-01T08:00:00", {"sem_acesso_7_dias": 7}),
    event("e2", "2026-11-10T08:00:00", {}, {"sem_acesso_7_dias": [
        {"computador": SECRET_HOST, "serie": SECRET_SERIAL}, {"serie": "X"}, {"serie": "Y"},
        {"serie": "ADM", "usuario_administrador": True}, {"serie": "BKP", "computador": "Backup Cascavel"}]}),
    event("e1", "2026-11-01T08:00:00", {"sem_acesso_7_dias": 41}),
    event("gap", "2026-11-12T08:00:00"),
    event("rest", "2026-11-13T08:00:00", {"sem_acesso_7_dias": 9}, tipo="restauracao"),
    event(PINNED_BASELINE_ID, "2026-11-14T08:00:00", {"sem_acesso_7_dias": 99}),
]


def trends(dias, history=HISTORY, tickets=TICKETS):
    return build_trends(dias=dias, today=TODAY, comparison_history=history, ticket_report=tickets)


class BuildTrendsTests(unittest.TestCase):
    def test_window_30_excludes_old_conclusion_and_previous_window_gets_it(self):
        result = trends(30)
        self.assertEqual((result["dias"], result["inicio"], result["data_corte"]), (30, "2026-10-28", "2026-11-26"))
        self.assertEqual(result["tempo_medio_os"], {
            "media_dias": 15.0, "encerradas": 2, "encerradas_sem_data": 1,
            "media_dias_anterior": 41.0, "encerradas_anterior": 1,
        })

    def test_window_90_includes_it(self):
        result = trends(90)["tempo_medio_os"]
        self.assertEqual((result["media_dias"], result["encerradas"]), (23.7, 3))
        self.assertEqual((result["media_dias_anterior"], result["encerradas_anterior"]), (None, 0))

    def test_no_access_points_fallback_gap_and_exclusions(self):
        result = trends(30)["sem_acesso_7_dias"]
        self.assertEqual([(p["data"], p["total"]) for p in result["pontos"]], [("2026-11-01", 41), ("2026-11-10", 3)])
        self.assertEqual(result["pontos"][0]["horario"], "2026-11-01T08:00:00")
        self.assertEqual(result["historico_desde"], "2026-09-01")
        self.assertEqual(len(trends(90)["sem_acesso_7_dias"]["pontos"]), 3)

    def test_administrator_and_backup_items_are_not_counted(self):
        history = [event("a", "2026-11-10T08:00:00", {"sem_acesso_7_dias": 50}, {"sem_acesso_7_dias": [
            {"serie": "X"}, {"serie": "ADM", "usuario_administrador": True}, {"serie": "BKP", "computador": "Backup Cascavel"}]})]
        self.assertEqual(trends(30, history=history)["sem_acesso_7_dias"]["pontos"][0]["total"], 1)

    def test_day_edges_of_the_ticket_windows(self):
        tickets = report(
            oracle("A", "01/10/2026 08:00", "28/10/2026 08:00"),  # no inicio: entra, 27 dias
            oracle("B", "01/10/2026 08:00", "27/10/2026 08:00"),  # dia anterior ao inicio: janela anterior, 26 dias
            oracle("C", "20/11/2026 08:00", "26/11/2026 08:00"),  # hoje: entra, 6 dias
        )
        result = trends(30, tickets=tickets)["tempo_medio_os"]
        self.assertEqual((result["encerradas"], result["media_dias"]), (2, 16.5))
        self.assertEqual((result["encerradas_anterior"], result["media_dias_anterior"]), (1, 26.0))

    def test_day_edges_of_the_no_access_series(self):
        history = [
            event("in", "2026-10-28T08:00:00", {"sem_acesso_7_dias": 5}),
            event("out", "2026-10-27T23:00:00", {"sem_acesso_7_dias": 6}),
            event("today", "2026-11-26T08:00:00", {"sem_acesso_7_dias": 7}),
        ]
        result = trends(30, history=history)["sem_acesso_7_dias"]
        self.assertEqual([p["data"] for p in result["pontos"]], ["2026-10-28", "2026-11-26"])
        self.assertEqual(result["historico_desde"], "2026-10-27")

    def test_empty_inputs(self):
        result = trends(30, history=[], tickets={})
        self.assertEqual(result["sem_acesso_7_dias"], {"pontos": [], "historico_desde": None})
        self.assertIsNone(result["tempo_medio_os"]["media_dias"])


class TrendsRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "historico_chamados.json"
        self.path.write_text(json.dumps(TICKETS), encoding="utf-8")
        app = FastAPI()

        @app.exception_handler(DomainError)
        async def handler(_request, error):
            return JSONResponse({"detail": error.detail}, status_code=error.status_code)

        self.router = create_monthly_report_router(MonthlyReportServices(
            inventory_snapshot=lambda: ([], {}),
            load_comparison_history=lambda: HISTORY,
            comparison_history_for_display=comparison_history_for_display,
            ticket_report_path=lambda: self.path,
            today=lambda: TODAY,
            now=lambda: datetime(2026, 11, 26, 9, 0),
        ))
        app.include_router(self.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.tmp.cleanup()

    def test_returns_only_aggregates(self):
        response = self.client.get("/api/relatorio-mensal/tendencias", params={"dias": 30})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["tempo_medio_os"]["media_dias"], 15.0)
        for secret in (SECRET_SERIAL, SECRET_HOST):
            self.assertNotIn(secret, response.text)

    def test_rejects_other_windows(self):
        for params in ({"dias": 45}, {}):
            with self.subTest(params=params):
                self.assertEqual(self.client.get("/api/relatorio-mensal/tendencias", params=params).status_code, 422)

    def test_requires_the_local_session_like_every_api_route(self):
        import main
        from security import sessao_local
        app = FastAPI()
        app.add_middleware(main.LocalRequestSafetyMiddleware)
        app.include_router(self.router)
        url = "/api/relatorio-mensal/tendencias?dias=30"
        kwargs = {"base_url": f"http://127.0.0.1:{main.SERVER_PORT}", "client": ("127.0.0.1", 1234)}
        with TestClient(app, **kwargs) as anonymous:
            self.assertEqual(anonymous.get(url).status_code, 401)
        with TestClient(app, headers=sessao_local.cabecalhos_sessao(main.SERVER_PORT), **kwargs) as session:
            self.assertEqual(session.get(url).status_code, 200)


if __name__ == "__main__":
    unittest.main()
