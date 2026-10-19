"""Stale tickets and new divergences alerts on the Home panel (docs/operacao/alertas-os-divergencias.md)."""

import copy
import unittest
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.history_insights import PINNED_BASELINE_ID
from domains.inventory_comparison import comparison_history_for_display
from routers.dashboard import DashboardServices, create_dashboard_router, new_divergences_status, stale_tickets_status

TZ = timezone(timedelta(hours=-3))
NOW = datetime(2026, 10, 19, 12, 0, tzinfo=TZ)
TODAY = NOW.date()


def ticket(serial, *oracle):
    return {"serie": serial, "simpress": {}, "oracle": list(oracle)}


def oracle(status, updated):
    return {"status": status, "sub_status": "", "ultima_atualizacao": updated}


def days_ago(days):
    return (TODAY - timedelta(days=days)).isoformat()


def update(event_id, moment, **comparison):
    return {"id": event_id, "horario": moment.isoformat(), "resumo": {}, "comparacao": comparison}


def identity(event):
    return event


class StaleTicketsStatusTests(unittest.TestCase):
    def test_counts_open_tickets_from_the_limit_and_reports_the_oldest(self):
        report = {"atualizado_em": "2026-10-18T09:00:00-03:00", "chamados": [
            ticket("A", oracle("Aberto", days_ago(7))),
            ticket("B", oracle("Em andamento", days_ago(21))),
            ticket("C", oracle("Aberto", days_ago(6))),
        ]}
        result = stale_tickets_status(report, TODAY)
        self.assertEqual(result["estado"], "paradas")
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["maior_dias_sem_atualizacao"], 21)
        self.assertEqual(result["importado_em"], "2026-10-18T09:00:00-03:00")

    def test_closed_undated_and_simpress_only_tickets_are_not_counted(self):
        report = {"chamados": [
            ticket("A", oracle("Concluído", days_ago(30))),
            ticket("B", oracle("Cancelado", days_ago(30))),
            ticket("C", oracle("Aberto", "")),
            {"serie": "D", "simpress": {"status": ["Em separação"]}, "oracle": []},
        ]}
        result = stale_tickets_status(report, TODAY)
        self.assertEqual((result["estado"], result["total"]), ("em_dia", 0))

    def test_newest_open_update_wins_for_a_series(self):
        report = {"chamados": [ticket("A", oracle("Aberto", days_ago(20)), oracle("Aberto", days_ago(2)))]}
        self.assertEqual(stale_tickets_status(report, TODAY)["estado"], "em_dia")

    def test_limit_is_configurable(self):
        report = {"chamados": [ticket("A", oracle("Aberto", days_ago(3)))]}
        result = stale_tickets_status(report, TODAY, limit_days=3)
        self.assertEqual((result["estado"], result["limite_dias"]), ("paradas", 3))

    def test_without_import_there_is_no_data(self):
        self.assertEqual(stale_tickets_status(None, TODAY)["estado"], "sem_dados")
        self.assertEqual(stale_tickets_status({"chamados": []}, TODAY)["estado"], "sem_dados")


class NewDivergencesStatusTests(unittest.TestCase):
    def test_counts_rows_missing_from_the_previous_update_by_section(self):
        previous = update("a", NOW - timedelta(days=7), divergencias_local=[
            {"computador": "PRNOTE001", "serie": "S1", "local_previsto": "Londrina", "local_detalhes": "Maringá"},
        ])
        current = update("b", NOW, divergencias_local=[
            {"computador": "PRNOTE001", "serie": "S1", "local_previsto": "Londrina", "local_detalhes": "Maringá"},
            {"computador": "PRNOTE002", "serie": "S2", "local_previsto": "Londrina", "local_detalhes": "Maringá"},
        ], series_sem_mapeamento=[{"serie": "S3"}, {"serie": "S4"}])
        result = new_divergences_status([current, previous], identity)
        self.assertEqual(result["estado"], "novas")
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["por_secao"], [
            {"secao": "Localidade divergente", "total": 1},
            {"secao": "Séries sem local definido", "total": 2},
        ])
        self.assertEqual((result["anterior"]["id"], result["atual"]["id"]), ("a", "b"))

    def test_sebrae_series_and_curitiba_prnote_hosts_never_count(self):
        previous = update("a", NOW - timedelta(days=7))
        current = update("b", NOW, ausentes_em_detalhes=[
            {"computador": "NOTE-SEBRAE", "serie": "BRJ135P5XS"},
        ], ausentes_no_endpoint=[
            {"computador": "", "serie": "BRJ149SCJG"},
        ], divergencias_local=[
            {"computador": "PRNOTESJP01", "serie": "S9", "local_previsto": "Curitiba", "local_detalhes": "São José dos Pinhais"},
            {"computador": "PRNOTEARC77", "serie": "S8", "local_previsto": "Curitiba", "local_detalhes": "Araucária"},
        ])
        for display in (identity, comparison_history_for_display):
            with self.subTest(display=display.__name__):
                result = new_divergences_status([previous, current], display)
                self.assertEqual((result["estado"], result["total"]), ("sem_novas", 0))

    def test_restorations_and_pinned_baseline_are_skipped(self):
        older = update("a", NOW - timedelta(days=14), series_sem_mapeamento=[{"serie": "S1"}])
        newer = update("b", NOW - timedelta(days=7), series_sem_mapeamento=[{"serie": "S1"}, {"serie": "S2"}])
        restoration = {"id": "r", "tipo": "restauracao", "horario": NOW.isoformat(), "comparacao": {}}
        pinned = update(PINNED_BASELINE_ID, NOW + timedelta(minutes=1))
        result = new_divergences_status([pinned, restoration, newer, older], identity)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["atual"]["id"], "b")

    def test_less_than_two_updates_has_no_comparison(self):
        self.assertEqual(new_divergences_status([update("a", NOW)], identity)["estado"], "sem_comparacao")

    def test_history_is_not_modified(self):
        history = [
            update("a", NOW - timedelta(days=7)),
            update("b", NOW, divergencias_local=[{"computador": "PRNOTESJP01", "serie": "S9"}]),
        ]
        snapshot = copy.deepcopy(history)
        new_divergences_status(history, comparison_history_for_display)
        self.assertEqual(history, snapshot)


class PanelAlertsTests(unittest.TestCase):
    def client(self, **options):
        router, _ = create_dashboard_router(DashboardServices(
            get_equipment=lambda: [], get_stats=lambda: {}, get_comparison_events=lambda: [],
            categories=(), categorize=lambda *_: "", now=lambda: NOW, **options,
        ))
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def test_panel_reports_both_alerts(self):
        history = [
            update("a", NOW - timedelta(days=7)),
            update("b", NOW, series_sem_mapeamento=[{"serie": "S1"}]),
        ]
        report = {"chamados": [ticket("A", oracle("Aberto", days_ago(9)))]}
        data = self.client(
            get_comparison_history=lambda: history,
            display_comparison=comparison_history_for_display,
            get_ticket_report=lambda: report,
        ).get("/api/painel").json()
        self.assertEqual((data["os_paradas"]["estado"], data["os_paradas"]["total"]), ("paradas", 1))
        self.assertEqual((data["divergencias_novas"]["estado"], data["divergencias_novas"]["total"]), ("novas", 1))

    def test_unreadable_sources_keep_the_panel(self):
        def broken():
            raise RuntimeError("arquivo ilegível")

        response = self.client(
            get_comparison_history=broken, display_comparison=identity, get_ticket_report=broken,
        ).get("/api/painel")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["os_paradas"]["estado"], "indisponivel")
        self.assertEqual(response.json()["divergencias_novas"]["estado"], "indisponivel")

    def test_panel_without_services_returns_null(self):
        data = self.client().get("/api/painel").json()
        self.assertIsNone(data["os_paradas"])
        self.assertIsNone(data["divergencias_novas"])


if __name__ == "__main__":
    unittest.main()
