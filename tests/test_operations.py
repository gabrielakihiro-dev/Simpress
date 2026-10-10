"""Tests for the operational history and ticket workflows."""

from io import BytesIO
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from openpyxl import Workbook
from starlette.datastructures import UploadFile

from domains.history_insights import compare_updates, equipment_timeline, latest_update, pending_rows
from routers.operations import create_operations_router

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def route_handler(router, path, method):
    return next(
        route.endpoint for route in router.routes
        if getattr(route, "path", None) == path and method in getattr(route, "methods", set())
    )


class HistoryInsightTests(unittest.TestCase):
    def test_pending_center_uses_latest_update_and_keeps_annotation_identity(self):
        old = {"id": "old", "horario": "2026-01-01", "comparacao": {"sem_acesso_14_dias": []}}
        current = {
            "id": "current", "horario": "2026-02-01", "comparacao": {
                "sem_acesso_14_dias": [{"serie": "ABC-1", "anotacao_id": "row-1", "anotacao": "Ver chamado"}],
                "divergencias_local": [{"serie": "XYZ-2"}],
            },
        }
        restoration = {"id": "restore", "horario": "2026-03-01", "tipo": "restauracao", "comparacao": {}}

        self.assertEqual(latest_update([old, current, restoration]), current)
        rows = pending_rows(current)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["item"]["anotacao_id"], "row-1")
        self.assertEqual(rows[0]["item"]["anotacao"], "Ver chamado")

    def test_equipment_timeline_matches_normalized_serial_and_manual_alias_events(self):
        comparisons = [{
            "id": "event-1", "horario": "2026-01-01", "comparacao": {
                "sem_acesso_14_dias": [{"serie": "ABC-123", "computador": "PRNOTE1", "anotacao_id": "n1"}],
                "ausentes_no_endpoint": [{"serie": "ZZZ"}],
            },
        }]
        aliases = [{"id": "alias-1", "serial": "abc123", "horario": "2026-02-01", "apelido_novo": "PRNOTE1"}]

        rows = equipment_timeline(comparisons, aliases, "abc 123")
        self.assertEqual([row["evento_id"] for row in rows], ["alias-1", "event-1"])
        self.assertEqual(rows[1]["item"]["anotacao_id"], "n1")
        hostname_rows = equipment_timeline(comparisons, aliases, "PRNOTE1")
        self.assertEqual({row["evento_id"] for row in hostname_rows}, {"alias-1", "event-1"})

    def test_update_evolution_labels_new_continued_and_resolved_rows(self):
        previous = {"id": "before", "horario": "2026-01-01", "comparacao": {
            "divergencias_local": [{"serie": "A-1"}, {"serie": "B-2"}],
        }}
        current = {"id": "after", "horario": "2026-02-01", "comparacao": {
            "divergencias_local": [{"serie": "A1"}, {"serie": "C-3"}],
        }}

        result = compare_updates(previous, current)
        self.assertEqual(result["contagens"], {"novos": 1, "continuam": 1, "resolvidos": 1})
        self.assertEqual(result["mudancas"]["novos"][0]["evento_id"], "after")
        self.assertEqual(result["mudancas"]["resolvidos"][0]["evento_id"], "before")

    def test_operational_read_routes_serve_pending_timeline_and_evolution_views(self):
        history = [
            {"id": "before", "horario": "2026-01-01", "comparacao": {"divergencias_local": [{"serie": "A-1"}]}},
            {"id": "after", "horario": "2026-02-01", "comparacao": {
                "divergencias_local": [{"serie": "A1", "anotacao_id": "note-1"}],
                "sem_acesso_14_dias": [{"serie": "B-2", "computador": "PRNOTE2", "anotacao_id": "note-2"}],
            }},
            {"id": "restore", "horario": "2026-03-01", "tipo": "restauracao", "comparacao": {}},
        ]
        router = create_operations_router(
            load_comparison_history=lambda: history,
            comparison_history_for_display=lambda event: event,
            load_alias_history=lambda: [{"id": "alias", "serial": "B2", "horario": "2026-04-01"}],
            ticket_report_path=lambda: Path(tempfile.gettempdir()) / "simpress-unused-tickets.json",
            transaction_root=lambda: Path(tempfile.gettempdir()),
        )

        pending = route_handler(router, "/api/operacoes/pendencias", "GET")()
        timeline = route_handler(router, "/api/operacoes/equipamento/{identificador}", "GET")("B-2")
        evolution = route_handler(router, "/api/operacoes/evolucao", "GET")(anterior="before", atual="after")

        self.assertEqual(pending["evento"]["id"], "after")
        self.assertEqual(len(pending["pendencias"]), 2)
        self.assertEqual({row["categoria"] for row in timeline["eventos"]}, {"sem_acesso_14_dias", "alteracao_manual"})
        self.assertEqual(evolution["contagens"], {"novos": 1, "continuam": 1, "resolvidos": 0})


class TicketImportRouteTests(unittest.TestCase):
    @staticmethod
    def workbook_bytes(rows):
        workbook = Workbook()
        worksheet = workbook.active
        for row in rows:
            worksheet.append(row)
        output = BytesIO()
        workbook.save(output)
        return output.getvalue()

    def test_import_reconciles_sources_and_persists_latest_report(self):
        with tempfile.TemporaryDirectory(dir=PROJECT_ROOT) as directory:
            path = Path(directory) / "state" / "tickets.json"
            router = create_operations_router(
                load_comparison_history=lambda: [],
                comparison_history_for_display=lambda event: event,
                load_alias_history=lambda: [],
                ticket_report_path=lambda: path,
                transaction_root=lambda: Path(directory),
            )
            simpress = self.workbook_bytes([
                ["NumeroPedido", "NumeroSerie", "OrdemServico", "NumeroChamadoCliente", "StatusAtual"],
                ["PED-1", "SN-1", 1001, "INC-1", "Em atendimento"],
                ["PED-1", "SN-1", 1001, "INC-1", "Em atendimento"],
                ["PED-2", "SN-2", 1002, None, "Aguardando"],
                ["PED-3", "SN-3", 1003, None, "Aguardando"],
            ])
            oracle = self.workbook_bytes([
                ["Gestão de Solicitações"],
                ["Solicitação", "ID OS Corporate", "Número de Série", "Fila", "Status", "Sub-status"],
                ["REQ-1", 1001, "sn 1", "Fila A", "Em execução", "Pendente"],
                ["REQ-2", 2002, "SN-2", "Fila B", "Aguardando", ""],
                ["REQ-4", 9004, "SN-4", "Fila C", "Aberto", ""],
            ])

            endpoint = route_handler(router, "/api/operacoes/chamados/importar", "POST")
            report = endpoint(
                simpress_file=UploadFile(filename="pedidos.xlsx", file=BytesIO(simpress)),
                oracle_file=UploadFile(filename="solicitacoes.xlsx", file=BytesIO(oracle)),
            )
            by_serial = {ticket["serie"]: ticket for ticket in report["chamados"]}
            self.assertEqual(report["resumo"], {
                "series_total": 4, "conferidas": 1, "divergentes": 1,
                "sem_os": 0, "somente_simpress": 1, "somente_oracle": 1,
            })
            self.assertEqual(by_serial["SN-1"]["simpress"]["ordens_servico"], ["1001"])
            self.assertEqual(by_serial["SN-1"]["oracle"][0]["solicitacao"], "REQ-1")
            self.assertEqual(by_serial["SN-1"]["relacao"], "conferida")
            self.assertEqual(by_serial["SN-2"]["relacao"], "divergente")
            self.assertEqual(report["fontes"]["simpress"]["linhas"], 4)
            persisted = route_handler(router, "/api/operacoes/chamados", "GET")()
            self.assertEqual(persisted["chamados"], report["chamados"])
            self.assertEqual(persisted["atualizado_em"], report["atualizado_em"])

    def test_import_rejects_non_xlsx_and_missing_source_columns(self):
        with tempfile.TemporaryDirectory(dir=PROJECT_ROOT) as directory:
            router = create_operations_router(
                load_comparison_history=lambda: [],
                comparison_history_for_display=lambda event: event,
                load_alias_history=lambda: [],
                ticket_report_path=lambda: Path(directory) / "tickets.json",
                transaction_root=lambda: Path(directory),
            )
            endpoint = route_handler(router, "/api/operacoes/chamados/importar", "POST")
            simpress = self.workbook_bytes([["NumeroPedido", "NumeroSerie", "OrdemServico"], ["1", "A1", "100"]])
            with self.assertRaises(HTTPException) as invalid_extension:
                endpoint(
                    simpress_file=UploadFile(filename="pedidos.csv", file=BytesIO(simpress)),
                    oracle_file=UploadFile(filename="oracle.xlsx", file=BytesIO(simpress)),
                )
            self.assertEqual(invalid_extension.exception.status_code, 400)

            oracle = self.workbook_bytes([
                ["Solicitação", "Número de Série"],
                ["REQ-1", "A1"],
            ])
            with self.assertRaises(HTTPException) as missing_columns:
                endpoint(
                    simpress_file=UploadFile(filename="pedidos.xlsx", file=BytesIO(simpress)),
                    oracle_file=UploadFile(filename="oracle.xlsx", file=BytesIO(oracle)),
                )
            self.assertEqual(missing_columns.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
