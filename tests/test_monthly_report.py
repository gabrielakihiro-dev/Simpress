"""Monthly contract report: content rules (docs/operacao/relatorio-mensal.md), workbook and route.

Every serial, hostname and OS below is fictitious, except the Sebrae-owned serial that
AGENTS.md lists by name.
"""

import json
import tempfile
import unittest
from datetime import date, datetime
from io import BytesIO
from pathlib import Path

import openpyxl
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from core.errors import DomainError
from domains.inventory_comparison import comparison_history_for_display
from domains.monthly_report import (
    CLOSED,
    OPENED,
    PENDING,
    SECTION_ENDPOINT,
    SECTION_LOCATION,
    SECTION_SIMPRESS,
    InvalidReportMonthError,
    build_monthly_report,
    build_monthly_report_workbook,
    comparison_section,
    inventory_section,
    parse_report_month,
    summary_rows,
    tickets_section,
    usage_section,
)
from routers.monthly_report import MonthlyReportServices, create_monthly_report_router

TODAY = date(2026, 10, 17)
OCTOBER = parse_report_month("2026-10", TODAY)
SEPTEMBER = parse_report_month("2026-09", TODAY)


def equipment(serial, tipo, city, address):
    return {"serial": serial, "tipo": tipo, "retirada_cidade": city, "endereco_instalacao": address}


EQUIPMENT = [
    equipment("SN-FIC-001", "Notebook", "Curitiba", "R Caeté, 150 - SEDE - Prado Velho"),
    equipment("SN-FIC-002", "Notebook", "Curitiba", "R Caeté, 150 - SEDE - Prado Velho"),
    equipment("SN-FIC-003", "Monitor", "Londrina", "Av Ficticia, 10"),
    equipment("SN-FIC-004", "", "Maringá", "Rua Exemplo, 20"),
]
STATS = {
    "arquivo_origem": "EquipamentosDetalhes_atual.xlsx",
    "ultima_atualizacao": "17/10/2026 08:00",
    "linhas_sem_serie": 2,
    "series_duplicadas": {"SNFIC001": 2},
}


def update_event(event_id, moment, comparison):
    return {"id": event_id, "horario": moment, "tipo": "atualizacao", "comparacao": comparison, "resumo": {}}


def october_comparison():
    return {
        "ausentes_no_endpoint": [
            {"computador": "", "serie": "BRJFIC0001", "local_previsto": "Curitiba"},
        ],
        "ausentes_em_detalhes": [
            {"computador": "PRMACFIC01", "serie": "CFICMAC001", "local_previsto": "Curitiba"},
            # Sebrae-owned notebook: never counted as missing in the Simpress base.
            {"computador": "PRMACFIC02", "serie": "BRJ135P5XS", "local_previsto": "Curitiba"},
        ],
        "divergencias_local": [
            {"computador": "PRNOTEMARFIC1", "serie": "SN-FIC-010", "local_previsto": "Maringá", "local_detalhes": "Londrina"},
            # Installed in Curitiba although the base says São José dos Pinhais.
            {"computador": "PRNOTESJPFIC1", "serie": "SN-FIC-011", "local_previsto": "São José dos Pinhais", "local_detalhes": "Curitiba"},
            {"computador": "PRNOTERLFIC1", "serie": "SN-FIC-012", "local_previsto": "Rio Negro", "local_detalhes": "Curitiba"},
            {"computador": "PRNOTEARCFIC1", "serie": "SN-FIC-013", "local_previsto": "Araucária", "local_detalhes": "Curitiba"},
        ],
    }


HISTORY = [
    update_event("evt-setembro", "2026-09-10T10:00:00-03:00", {
        "ausentes_no_endpoint": [], "ausentes_em_detalhes": [], "divergencias_local": [],
    }),
    update_event("evt-outubro-1", "2026-10-02T09:00:00-03:00", {
        "ausentes_no_endpoint": [], "ausentes_em_detalhes": [], "divergencias_local": [],
    }),
    update_event("evt-outubro-2", "2026-10-15T09:00:00-03:00", october_comparison()),
    {"id": "evt-restauracao", "horario": "2026-10-20T09:00:00-03:00", "tipo": "restauracao", "comparacao": {}},
    update_event("evt-novembro", "2026-11-03T09:00:00-03:00", {
        "ausentes_no_endpoint": [{"computador": "", "serie": "BRJFIC0099"}], "ausentes_em_detalhes": [], "divergencias_local": [],
    }),
]


def oracle(os_number, created, concluded="", status="Gestão da Mesa de Operações", sub_status="Execução Pendente"):
    return {
        "solicitacao": f"SOL-{os_number}", "ordem_servico": os_number, "status": status, "sub_status": sub_status,
        "data_criacao": created, "data_conclusao": concluded, "ultima_atualizacao": created, "serie": "",
    }


def ticket(serial, oracle_items=(), simpress=None):
    return {"serie": serial, "relacao": "somente_oracle", "oracle": list(oracle_items), "simpress": simpress or {}}


SEPTEMBER_SNAPSHOT = {
    "id": "snap-1",
    "atualizado_em": "2026-09-25T10:00:00-03:00",
    "fontes": {},
    "resumo": {},
    "chamados": [ticket("SN-FIC-100", [oracle("9100", "20/09/2026 10:00")])],
}
OCTOBER_TICKETS = [
    ticket("SN-FIC-100", [oracle("9100", "20/09/2026 10:00", "05/10/2026 16:00", sub_status="Concluído")]),
    ticket("SN-FIC-101", [oracle("9101", "10/10/2026 08:30")]),
    # Closed without a conclusion date: neither pending nor concluded in the month.
    ticket("SN-FIC-102", [oracle("9102", "01/08/2026 09:00", status="Encerrado", sub_status="Cancelado")]),
    ticket("SN-FIC-103", simpress={
        "pedidos": ["P-FIC-1"], "datas_pedido": ["03/10/2026"], "status": ["Pedido em separação"],
    }),
    ticket("SN-FIC-104", simpress={
        "pedidos": ["P-FIC-2"], "datas_pedido": ["15/09/2026"], "status": ["Pedido entregue"],
        "etapas_pedido": [
            {"chave": "data_pedido", "rotulo": "Data do pedido", "data": "15/09/2026"},
            {"chave": "entregue", "rotulo": "Pedido entregue", "data": "02/10/2026"},
        ],
    }),
]
TICKET_REPORT = {
    "snapshot_id": "snap-2",
    "atualizado_em": "2026-10-12T18:00:00-03:00",
    "fontes": {},
    "resumo": {},
    "chamados": OCTOBER_TICKETS,
    "historico": [SEPTEMBER_SNAPSHOT],
}
USAGE = {
    "versao": 1,
    "dias": {
        "2026-09-30": {"transferencias": 5},
        "2026-10-01": {"transferencias": 2, "buscas": 3},
        "2026-10-31": {"exportacoes": 1},
        "2026-11-01": {"comparacoes": 4},
    },
    "tempos_minutos": {"transferencias": 15},
}


def build(month=OCTOBER, display=comparison_history_for_display, **overrides):
    arguments = {
        "equipment": EQUIPMENT, "stats": STATS, "comparison_history": HISTORY,
        "comparison_display": display, "ticket_report": TICKET_REPORT, "usage_store": USAGE,
        "generated_at": datetime(2026, 10, 17, 9, 30),
    }
    arguments.update(overrides)
    return build_monthly_report(month, **arguments)


class ReportMonthTests(unittest.TestCase):
    def test_accepts_current_and_past_months(self):
        self.assertEqual((OCTOBER.start, OCTOBER.end), (date(2026, 10, 1), date(2026, 10, 31)))
        self.assertEqual(parse_report_month("2024-02", TODAY).end, date(2024, 2, 29))
        self.assertEqual(OCTOBER.label, "outubro de 2026")

    def test_rejects_invalid_or_future_months(self):
        for value in ("2026-11", "2027-01", "2026-13", "2026-00", "26-10", "2026/10", "", None, "1999-12"):
            with self.subTest(value=value), self.assertRaises(InvalidReportMonthError) as raised:
                parse_report_month(value, TODAY)
            self.assertEqual(raised.exception.status_code, 422)


class InventorySectionTests(unittest.TestCase):
    def test_counts_unique_serials_of_the_official_base_and_flags_gaps(self):
        section = inventory_section(EQUIPMENT, STATS)
        self.assertEqual(section["total"], 4)
        self.assertEqual(section["por_tipo"], [("Notebook", 2), ("Monitor", 1), ("Sem tipo", 1)])
        self.assertEqual(section["por_unidade"][0], ("Curitiba", "R Caeté, 150 - SEDE - Prado Velho", 2))
        self.assertEqual(section["unidades"], 3)
        self.assertEqual(section["linhas_sem_serie"], 2)
        self.assertEqual(section["series_duplicadas"], ["SNFIC001"])

    def test_breakdowns_add_up_to_the_total(self):
        section = inventory_section(EQUIPMENT, STATS)
        self.assertEqual(sum(count for _tipo, count in section["por_tipo"]), section["total"])
        self.assertEqual(sum(count for *_unit, count in section["por_unidade"]), section["total"])

    def test_missing_flags_default_to_zero(self):
        section = inventory_section([], {})
        self.assertEqual((section["total"], section["linhas_sem_serie"], section["series_duplicadas"]), (0, 0, []))


class ComparisonSectionTests(unittest.TestCase):
    def test_uses_latest_update_until_month_end_with_current_rules(self):
        section = comparison_section(HISTORY, OCTOBER, comparison_history_for_display)
        self.assertEqual(section["horario"].date(), date(2026, 10, 15))
        self.assertEqual(section["atualizacoes_no_mes"], 2)
        self.assertEqual(section["contagens"], {SECTION_ENDPOINT: 1, SECTION_SIMPRESS: 1, SECTION_LOCATION: 1})
        serials = {line["serie"] for line in section["linhas"]}
        self.assertNotIn("BRJ135P5XS", serials)
        self.assertFalse({"SN-FIC-011", "SN-FIC-012", "SN-FIC-013"} & serials)
        self.assertNotIn("BRJFIC0099", serials)

    def test_report_applies_sebrae_and_curitiba_rules_even_without_display_filters(self):
        section = comparison_section(HISTORY, OCTOBER, lambda event: event)
        self.assertEqual(section["contagens"][SECTION_SIMPRESS], 1)
        self.assertEqual(section["contagens"][SECTION_LOCATION], 1)

    def test_older_month_uses_its_own_last_update(self):
        section = comparison_section(HISTORY, SEPTEMBER, comparison_history_for_display)
        self.assertEqual(section["horario"].date(), date(2026, 9, 10))
        self.assertEqual(section["atualizacoes_no_mes"], 1)
        self.assertEqual(section["linhas"], [])

    def test_month_before_any_update_has_no_comparison(self):
        section = comparison_section(HISTORY, parse_report_month("2026-08", TODAY), comparison_history_for_display)
        self.assertIsNone(section["horario"])
        self.assertEqual(sum(section["contagens"].values()), 0)


class TicketSectionTests(unittest.TestCase):
    def test_october_counts_opened_concluded_and_pending(self):
        section = tickets_section(TICKET_REPORT, OCTOBER)
        self.assertEqual(section["oracle"], {"abertas": 1, "concluidas": 1, "pendentes": 1, "encerradas_sem_data": 1})
        self.assertEqual(section["simpress"], {"abertas": 1, "concluidas": 1, "pendentes": 1, "encerradas_sem_data": 0})
        self.assertEqual(section["importacoes"], 2)
        situations = {line["identificador"]: line["situacao"] for line in section["linhas"]}
        self.assertEqual(situations, {
            "9100": [CLOSED], "9101": [OPENED, PENDING],
            "P-FIC-1": [OPENED, PENDING], "P-FIC-2": [CLOSED],
        })

    def test_september_sees_tickets_still_open_at_month_end(self):
        section = tickets_section(TICKET_REPORT, SEPTEMBER)
        self.assertEqual(section["oracle"], {"abertas": 1, "concluidas": 0, "pendentes": 1, "encerradas_sem_data": 1})
        self.assertEqual(section["simpress"], {"abertas": 1, "concluidas": 0, "pendentes": 1, "encerradas_sem_data": 0})

    def test_os_repeated_across_imports_counts_once_with_newest_data(self):
        section = tickets_section(TICKET_REPORT, OCTOBER)
        rows = [line for line in section["linhas"] if line["identificador"] == "9100"]
        self.assertEqual(len(rows), 1)
        self.assertIn("Concluído", rows[0]["status"])

    def test_empty_ticket_history_reports_zeros(self):
        section = tickets_section({}, OCTOBER)
        self.assertEqual(section["oracle"], {"abertas": 0, "concluidas": 0, "pendentes": 0, "encerradas_sem_data": 0})
        self.assertEqual((section["linhas"], section["importacoes"]), ([], 0))


class UsageSectionTests(unittest.TestCase):
    def test_sums_exactly_the_days_of_the_month(self):
        section = usage_section(USAGE, OCTOBER)
        self.assertEqual(section["totais"], {
            "transferencias": 2, "comparacoes": 0, "exportacoes": 1, "os_conciliadas": 0, "buscas": 3,
        })
        self.assertEqual(len(section["por_dia"]), 31)
        self.assertEqual(section["por_dia"][0]["data"], "2026-10-01")
        self.assertEqual(section["horas_economizadas"], 0.5)
        self.assertEqual(section["registro_desde"], "2026-09-30")

    def test_missing_metrics_file_reports_zeros(self):
        section = usage_section({}, OCTOBER)
        self.assertEqual(sum(section["totais"].values()), 0)
        self.assertFalse(section["tempos_configurados"])


class WorkbookTests(unittest.TestCase):
    def workbook(self, report):
        output, filename = build_monthly_report_workbook(report)
        return openpyxl.load_workbook(BytesIO(output.getvalue())), filename

    def summary_values(self, workbook):
        return {row[0]: row[1] for row in workbook["Resumo"].iter_rows(values_only=True) if row and row[0]}

    def test_sheets_and_summary_values(self):
        workbook, filename = self.workbook(build())
        self.assertEqual(filename, "Relatorio-mensal-2026-10.xlsx")
        self.assertEqual(workbook.sheetnames, [
            "Resumo", "Inventário por tipo", "Inventário por unidade", "Comparação", "OS do mês", "Uso por dia",
        ])
        values = self.summary_values(workbook)
        self.assertEqual(values["Relatório mensal — outubro de 2026"], None)
        self.assertEqual(values["Equipamentos na base"], 4)
        self.assertEqual(values["Linhas sem número de série"], 2)
        self.assertEqual(values["Séries duplicadas"], 1)
        # The report shows the event in the server's local time zone, so CI (UTC) and Curitiba differ.
        local_time = datetime.fromisoformat("2026-10-15T09:00:00-03:00").astimezone()
        self.assertEqual(values["Data da comparação"], local_time.strftime("%d/%m/%Y %H:%M"))
        self.assertEqual(values[SECTION_ENDPOINT], 1)
        self.assertEqual(values[SECTION_SIMPRESS], 1)
        self.assertEqual(values[SECTION_LOCATION], 1)
        self.assertEqual(values["OS Oracle abertas no mês"], 1)
        self.assertEqual(values["OS Oracle pendentes no fim do mês"], 1)
        self.assertEqual(values["Pedidos Simpress entregues no mês"], 1)
        self.assertEqual(values["Transferências geradas"], 2)
        self.assertEqual(values["Horas economizadas (estimativa)"], 0.5)
        self.assertTrue(any("16467" in str(cell.value) for cell in workbook["Resumo"]["A"]))

    def test_approved_source_labels_and_no_raw_source_names(self):
        workbook, _ = self.workbook(build())
        text = "\n".join(
            str(cell) for sheet in workbook for row in sheet.iter_rows(values_only=True) for cell in row if cell
        )
        self.assertIn("Sem correspondência — no endpoint", text)
        self.assertIn("Sem correspondência — na Simpress", text)
        self.assertNotIn("InvAll", text)
        self.assertNotIn("BRJ135P5XS", text)

    def test_detail_sheets_match_summary(self):
        workbook, _ = self.workbook(build())
        by_type = list(workbook["Inventário por tipo"].iter_rows(min_row=2, values_only=True))
        self.assertEqual(sum(row[1] for row in by_type), 4)
        sections = [row[0] for row in workbook["Comparação"].iter_rows(min_row=2, values_only=True)]
        self.assertEqual(sections, [SECTION_ENDPOINT, SECTION_SIMPRESS, SECTION_LOCATION])
        usage_rows = list(workbook["Uso por dia"].iter_rows(min_row=2, values_only=True))
        self.assertEqual((len(usage_rows), usage_rows[0][0]), (31, "01/10/2026"))

    def test_spreadsheet_text_never_becomes_a_formula(self):
        hostile = [equipment("SN-FIC-900", "=HYPERLINK(\"x\")", "Curitiba", "+cmd")]
        workbook, _ = self.workbook(build(equipment=hostile))
        values = [cell for row in workbook["Inventário por tipo"].iter_rows(values_only=True) for cell in row]
        self.assertIn("'=HYPERLINK(\"x\")", values)

    def test_empty_month_still_generates_with_zeros(self):
        report = build(
            month=parse_report_month("2026-08", TODAY), comparison_history=[], ticket_report={}, usage_store={},
        )
        rows = summary_rows(report)
        self.assertIn(("Última comparação", "Data da comparação", "Sem registros no mês",
                       "Atualização de inventário mais recente até o fim do mês."), rows)
        workbook, _ = self.workbook(report)
        self.assertEqual(workbook["OS do mês"]["A2"].value, "Sem registros no mês")


class MonthlyReportRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ticket_path = Path(self.tmp.name) / "historico_chamados.json"
        self.ticket_path.write_text(json.dumps(TICKET_REPORT), encoding="utf-8")
        self.equipment = list(EQUIPMENT)

    def tearDown(self):
        self.tmp.cleanup()

    def client(self, usage_reader=lambda: USAGE):
        app = FastAPI()

        @app.exception_handler(DomainError)
        async def domain_error_handler(_request, error):
            return JSONResponse({"detail": error.detail}, status_code=error.status_code)

        app.include_router(create_monthly_report_router(MonthlyReportServices(
            inventory_snapshot=lambda: (self.equipment, dict(STATS)),
            load_comparison_history=lambda: HISTORY,
            comparison_history_for_display=comparison_history_for_display,
            ticket_report_path=lambda: self.ticket_path,
            read_usage_metrics=usage_reader,
            today=lambda: TODAY,
            now=lambda: datetime(2026, 10, 17, 9, 30),
        )))
        return TestClient(app)

    def test_downloads_the_workbook_for_the_selected_month(self):
        response = self.client().get("/api/relatorio-mensal", params={"mes": "2026-10"})
        self.assertEqual(response.status_code, 200)
        self.assertIn('filename="Relatorio-mensal-2026-10.xlsx"', response.headers["content-disposition"])
        workbook = openpyxl.load_workbook(BytesIO(response.content))
        self.assertEqual(workbook["Resumo"]["A1"].value, "Relatório mensal — outubro de 2026")

    def test_invalid_or_future_month_is_rejected(self):
        client = self.client()
        for value in ("2026-11", "2026-13", "outubro"):
            with self.subTest(value=value):
                self.assertEqual(client.get("/api/relatorio-mensal", params={"mes": value}).status_code, 422)
        self.assertEqual(client.get("/api/relatorio-mensal").status_code, 422)

    def test_unloaded_base_answers_503(self):
        self.equipment = []
        response = self.client().get("/api/relatorio-mensal", params={"mes": "2026-10"})
        self.assertEqual(response.status_code, 503)
        self.assertIn("EquipamentosDetalhes", response.json()["detail"])

    def test_unreadable_ticket_history_answers_503(self):
        self.ticket_path.write_text("{", encoding="utf-8")
        self.assertEqual(self.client().get("/api/relatorio-mensal", params={"mes": "2026-10"}).status_code, 503)

    def test_missing_ticket_history_and_unreadable_metrics_still_generate(self):
        self.ticket_path.unlink()

        def broken_metrics():
            raise ValueError("arquivo inválido")

        with self.assertLogs("routers.monthly_report", level="WARNING"):
            response = self.client(broken_metrics).get("/api/relatorio-mensal", params={"mes": "2026-10"})
        self.assertEqual(response.status_code, 200)


if __name__ == "__main__":
    unittest.main()
