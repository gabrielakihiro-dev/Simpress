"""Tests for ticket filters, attention, snapshots, and spreadsheet export."""

from datetime import date
from io import BytesIO
import unittest

import openpyxl

from domains.ticket_reporting import (
    build_ticket_workbook,
    compare_ticket_snapshots,
    filter_ticket_records,
    ticket_attention,
    ticket_report_snapshots,
)


def _ticket(
    serial="SN-1",
    *,
    relation="conferida",
    status="Em execução",
    queue="Fila A",
    last_update="2026-10-01",
    order="OS-1",
):
    oracle = [] if status is None else [{
        "solicitacao": "REQ-1", "ordem_servico": order, "status": status,
        "sub_status": "Pendente", "fila": queue, "fase_atendimento": "Execução",
        "ultima_atualizacao": last_update, "status_entregas": "", "status_atividades": "",
        "assunto": "Atendimento",
    }]
    return {
        "serie": serial,
        "relacao": relation,
        "ordens_servico_conferidas": [order] if relation == "conferida" else [],
        "simpress": {"pedidos": ["PED-1"], "ordens_servico": [order], "chamados_cliente": [], "status": ["Em atendimento"]},
        "oracle": oracle,
    }


class TicketReportingTests(unittest.TestCase):
    def test_filters_match_relation_status_queue_search_and_age(self):
        tickets = [
            _ticket(),
            _ticket("SN-2", relation="divergente", queue="Fila B", last_update="2026-10-09"),
            _ticket("SN-3", relation="somente_simpress", status=None),
        ]
        result = filter_ticket_records(
            tickets, relation="conferida", status="Em execução", queue="Fila A",
            search="sn-1", age_filter="7", today=date(2026, 10, 10),
        )
        self.assertEqual([row["serie"] for row in result], ["SN-1"])

        split_match = _ticket("SN-4")
        split_match["oracle"].append({"status": "Aguardando", "fila": "Fila B"})
        self.assertEqual(
            filter_ticket_records([split_match], status="Em execução", queue="Fila B", today=date(2026, 10, 10)),
            [],
        )

    def test_attention_queue_prioritizes_divergence_and_ignores_old_closed_tickets(self):
        divergent = _ticket("SN-2", relation="divergente", last_update="2026-10-09")
        stale = _ticket("SN-1", last_update="2026-09-20")
        closed = _ticket("SN-3", status="Concluído", last_update="2026-01-01")

        rows = filter_ticket_records(
            [closed, stale, divergent], attention_only=True, stale_days=7, today=date(2026, 10, 10)
        )
        self.assertEqual([row["serie"] for row in rows], ["SN-2", "SN-1"])
        self.assertFalse(ticket_attention(closed, stale_days=7, today=date(2026, 10, 10))["em_atencao"])
        self.assertIn("Sem atualização há 20 dias", ticket_attention(stale, today=date(2026, 10, 10))["motivo"])

    def test_missing_active_update_is_a_filterable_attention_item(self):
        missing = _ticket("SN-4", last_update="")
        attention = ticket_attention(missing, today=date(2026, 10, 10))
        self.assertTrue(attention["em_atencao"])
        self.assertIsNone(attention["dias_sem_atualizacao"])
        self.assertEqual(
            [row["serie"] for row in filter_ticket_records([missing], age_filter="sem_data", today=date(2026, 10, 10))],
            ["SN-4"],
        )

    def test_snapshot_comparison_reports_changes_new_and_absent_without_calling_absent_resolved(self):
        previous = {"id": "old", "atualizado_em": "2026-10-01", "fontes": {}, "resumo": {}, "chamados": [
            _ticket("ABC-1", order="100"), _ticket("OLD-2", status=None, relation="somente_simpress"),
        ]}
        current = {"id": "new", "atualizado_em": "2026-10-10", "fontes": {}, "resumo": {}, "chamados": [
            _ticket("abc1", order="200"), _ticket("NEW-3", status=None, relation="somente_simpress"),
        ]}

        result = compare_ticket_snapshots(previous, current)
        self.assertEqual(result["contagens"], {"novos": 1, "alterados": 1, "iguais": 0, "ausentes_arquivo": 1})
        self.assertEqual(result["mudancas"]["ausentes_arquivo"], ["OLD-2"])
        self.assertNotIn("resolvidos", result["contagens"])
        self.assertIn("não confirma", result["aviso_ausentes"])

    def test_legacy_report_gets_a_stable_snapshot_id_and_export_is_a_valid_filtered_xlsx(self):
        legacy = {"atualizado_em": "2026-10-09", "fontes": {}, "resumo": {}, "chamados": [_ticket()]}
        first = ticket_report_snapshots(legacy)
        second = ticket_report_snapshots(legacy)
        self.assertEqual(first[0]["id"], second[0]["id"])

        filtered = filter_ticket_records(legacy["chamados"], relation="conferida")
        content = build_ticket_workbook(first[0], filtered, {"relation": "conferida"})
        workbook = openpyxl.load_workbook(BytesIO(content), data_only=True)
        self.assertEqual(workbook.sheetnames, ["Resumo", "Chamados"])
        sheet = workbook["Chamados"]
        self.assertEqual(sheet.max_row, 2)
        self.assertEqual(sheet.cell(2, 1).value, "SN-1")
        self.assertEqual(sheet.cell(1, 1).value, "Série")

        unsafe = _ticket("=1+1")
        unsafe_content = build_ticket_workbook(first[0], [unsafe], {})
        unsafe_workbook = openpyxl.load_workbook(BytesIO(unsafe_content), data_only=False)
        self.assertEqual(unsafe_workbook["Chamados"].cell(2, 1).value, "'=1+1")
        self.assertEqual(unsafe_workbook["Chamados"].cell(2, 1).data_type, "s")

    def test_snapshot_retention_keeps_only_the_50_most_recent_versions(self):
        history = [
            {"id": f"version-{index}", "atualizado_em": f"2026-10-{(index % 28) + 1:02d}", "chamados": []}
            for index in range(60)
        ]
        report = {**history[-1], "snapshot_id": history[-1]["id"], "historico": history}
        snapshots = ticket_report_snapshots(report)
        self.assertEqual(len(snapshots), 50)
        self.assertEqual(snapshots[0]["id"], "version-10")
        self.assertEqual(snapshots[-1]["id"], "version-59")


if __name__ == "__main__":
    unittest.main()
