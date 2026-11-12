"""Dossiê do equipamento (Home F1): ``GET /api/equipamento/{serial}/dossie``, só leitura, dados sintéticos."""

from contextlib import redirect_stdout
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI

with (
    patch("core.integrity.recover_pending_transactions", return_value=None),
    patch("openpyxl.load_workbook", side_effect=RuntimeError("operational data blocked")),
    redirect_stdout(io.StringIO()),
):
    import main
from domains import inventory_state
from domains.regras_negocio import normalize_reference_value
from domains.ticket_reporting import TICKET_TIMELINE_STATE_FIELDS, _stable_serial
from routers.operations import create_operations_router

HTTP_TEST_AVAILABLE = importlib.util.find_spec("httpx") is not None
if HTTP_TEST_AVAILABLE:
    from fastapi.testclient import TestClient

SECRET = "Texto sigiloso da descrição da OS"
USER = "Fulano de Tal"
EMAIL = "fulano.de.tal@exemplo.test"
PHONE = "+55 41 99999-0000"
SERIE = "SN-1"
HEADER = {"serie": "SN1", "modelo": "Modelo Teste"}
EXPECTED_ORDER_KEYS = {"fonte", "serie", "os", "status", "fila", "dias_aberta", "utic"}
HISTORY_LABELS = {label for _field, label in TICKET_TIMELINE_STATE_FIELDS}


def oracle_item(order, *, status="Em atendimento", sub_status="Aguardando peça", queue="Fila Campo",
                created="2026-11-05"):
    return {
        "solicitacao": f"SOL-{order}", "ordem_servico": order, "status": status, "sub_status": sub_status,
        "fila": queue, "data_criacao": created, "data_conclusao": "", "descricao": SECRET, "usuario": USER,
        "email": EMAIL, "telefone": PHONE, "nome_solicitante": USER,
        "ultima_atualizacao": "2026-11-09", "cidade": "Curitiba", "nome_filial": "Simpress",
    }


def ticket(serie=SERIE, *, simpress_os=(), simpress_status=(), oracle=()):
    return {
        "serie": serie,
        "simpress": {"serie": serie, "pedidos": [], "ordens_servico": list(simpress_os), "status": list(simpress_status)},
        "oracle": list(oracle),
    }


def snapshot(number, chamados, day=None):
    day = day or number
    return {
        "id": f"imp-{number}", "atualizado_em": f"2026-11-{day:02d}T09:00:00",
        "fontes": {}, "resumo": {}, "chamados": chamados,
    }


def report(*snapshots):
    last = snapshots[-1]
    return {
        **{field: last[field] for field in ("atualizado_em", "fontes", "resumo", "chamados")},
        "snapshot_id": last["id"], "historico": list(snapshots),
    }


def link_key(source, serie, order):
    return json.dumps([source, serie, order], separators=(",", ":"))


def manual_link(source, serie, order, number, year=2026):
    return link_key(source, normalize_reference_value(serie), order), {
        "fonte": source, "serie": serie, "os": order, "ano": year, "numero": str(number),
        "chamado": f"UTIC-{year}-{number}",
    }


@unittest.skipUnless(HTTP_TEST_AVAILABLE, "Optional httpx test dependency is not installed")
class DossierRouteTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=tempfile.gettempdir())
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.header_calls = []

    def header(self, serial):
        self.header_calls.append(serial)
        return dict(HEADER) if serial.strip().upper() == "SN1" else None

    def get(self, serial="SN1", *, data=None, raw=None, links=None, raw_links=None, derived=None):
        if data is not None:
            (self.root / "tickets.json").write_text(json.dumps(data), encoding="utf-8")
        if raw is not None:
            (self.root / "tickets.json").write_text(raw, encoding="utf-8")
        if links is not None:
            (self.root / "vinculos.json").write_text(json.dumps({"version": 1, "vinculos": links}), encoding="utf-8")
        if raw_links is not None:
            (self.root / "vinculos.json").write_text(raw_links, encoding="utf-8")
        router = create_operations_router(
            load_comparison_history=lambda: [], comparison_history_for_display=lambda event: event,
            ticket_report_path=lambda: self.root / "tickets.json", transaction_root=lambda: self.root,
            ticket_os_links_file=lambda: self.root / "vinculos.json",
            dashboard_vinculos=derived, equipment_header=self.header,
        )
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)
        return self.client.get(f"/api/equipamento/{serial}/dossie")

    def os_section(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual({key: body[key] for key in ("serie", "modelo")}, HEADER)
        self.assertEqual(set(body), {"serie", "modelo", "os"})
        return body["os"]

    def test_series_with_simpress_and_oracle_orders_shows_the_latest_import_only(self):
        older = snapshot(1, [ticket(simpress_os=["100"], simpress_status=["Pedido aberto"], oracle=[oracle_item("200")])])
        latest = snapshot(2, [
            ticket(simpress_os=["100"], simpress_status=["Pedido entregue", "Nota emitida"], oracle=[oracle_item("200")]),
            ticket("OUTRA", oracle=[oracle_item("999")]),
        ], day=10)
        response = self.get("sn1", data=report(older, latest))
        section = self.os_section(response)

        self.assertEqual((section["estado"], section["mensagem"]), ("ok", ""))
        self.assertEqual((section["total_importacoes"], section["ultima_importacao_em"]), (2, "2026-11-10T09:00:00"))
        self.assertEqual((section["presente_na_ultima"], section["ultima_vez_observada_em"]), (True, None))
        self.assertEqual(section["ordens"], [
            {"fonte": "simpress", "serie": SERIE, "os": "100", "status": "Pedido entregue · Nota emitida", "fila": "",
             "dias_aberta": None, "utic": None},
            {"fonte": "oracle", "serie": SERIE, "os": "200", "status": "Em atendimento · Aguardando peça", "fila": "Fila Campo",
             "dias_aberta": 5, "utic": None},
        ])
        # Only the whitelist leaves: no description, user or other series.
        for order in section["ordens"]:
            self.assertEqual(set(order), EXPECTED_ORDER_KEYS)
        # The history carries only the approved timeline labels, never free text from the rows.
        events = section["historico"]["eventos"]
        changes = [change for event in events for change in event["mudancas"]]
        self.assertTrue(changes)
        self.assertLessEqual({change["campo"] for change in changes}, HISTORY_LABELS)
        for change in changes:
            self.assertEqual(set(change), {"campo", "anterior", "atual"})
        # `ensure_ascii=False`: the default would escape "ç" and "ã" and make the accented secret pass by accident.
        everything = json.dumps(response.json(), ensure_ascii=False)
        for secret in (SECRET, USER, EMAIL, PHONE, "@", "descricao", "usuario", "email", "telefone", "nome_solicitante",
                       "999", "OUTRA", "solicitacao"):
            self.assertNotIn(secret, everything)
            self.assertNotIn(secret, response.text)
        self.assertEqual(self.header_calls, ["sn1"])

    def test_duplicate_series_in_one_import_joins_the_orders_and_history_follows_the_first_row(self):
        older = snapshot(1, [ticket(oracle=[oracle_item("200", status="Aberto", sub_status="")])])
        latest = snapshot(2, [
            ticket(oracle=[oracle_item("200", status="Em atendimento", sub_status="")]),
            ticket("sn 1", simpress_os=["100"], simpress_status=["Pedido entregue"],
                   oracle=[oracle_item("200"), oracle_item("300", created="2026-11-01")]),
        ], day=10)
        section = self.os_section(self.get(data=report(older, latest)))

        self.assertEqual([(o["fonte"], o["os"], o["dias_aberta"]) for o in section["ordens"]], [
            ("simpress", "100", None), ("oracle", "200", 5), ("oracle", "300", 9),
        ])
        # OS 200 appears in both rows: one entry, with the most days and both distinct statuses.
        self.assertEqual(section["ordens"][1]["status"], "Em atendimento / Em atendimento · Aguardando peça")
        history = section["historico"]
        self.assertEqual(history["total"], 2)
        latest_event = history["eventos"][0]
        self.assertEqual(latest_event["tipo"], "Dados alterados")
        self.assertEqual(latest_event["mudancas"], [{"campo": "Status Oracle", "anterior": ["Aberto"], "atual": ["Em atendimento"]}])
        self.assertNotIn("300", json.dumps(history))

    def test_series_missing_from_the_latest_import_reports_the_last_time_it_was_seen(self):
        first = snapshot(1, [ticket(oracle=[oracle_item("200")])])
        second = snapshot(2, [ticket(oracle=[oracle_item("200", status="Concluído", sub_status="")])], day=4)
        latest = snapshot(3, [ticket("OUTRA", oracle=[oracle_item("999")])], day=9)
        response = self.get(data=report(first, second, latest))
        section = self.os_section(response)

        self.assertEqual((section["estado"], section["ordens"], section["presente_na_ultima"]), ("ok", [], False))
        self.assertEqual(section["ultima_vez_observada_em"], "2026-11-04T09:00:00")
        self.assertEqual((section["total_importacoes"], section["ultima_importacao_em"]), (3, "2026-11-09T09:00:00"))
        self.assertEqual([e["tipo"] for e in section["historico"]["eventos"]], ["Dados alterados", "Importação inicial"])
        self.assertNotIn("encerrad", response.text.lower())

    def test_history_with_a_single_version_has_only_the_initial_import(self):
        section = self.os_section(self.get(data=report(snapshot(1, [ticket(oracle=[oracle_item("200")])]))))

        events = section["historico"]["eventos"]
        self.assertEqual((section["historico"]["titulo"], section["historico"]["total"], len(events)),
                         ("Mudanças da série nas importações de OS", 1, 1))
        self.assertEqual((events[0]["tipo"], events[0]["atualizado_em"]), ("Importação inicial", "2026-11-01T09:00:00"))
        self.assertTrue(events[0]["mudancas"])
        for change in events[0]["mudancas"]:
            self.assertEqual((set(change), change["anterior"]), ({"campo", "anterior", "atual"}, []))

    def test_history_skips_unchanged_imports_lists_newest_first_and_keeps_30(self):
        statuses = [f"Etapa {number}" for number in range(35)]
        statuses[5] = statuses[4]  # an import with no change is not an event
        snapshots = [snapshot(number + 1, [ticket(oracle=[oracle_item("200", status=status, sub_status="")])], day=number % 28 + 1)
                     for number, status in enumerate(statuses)]
        section = self.os_section(self.get(data=report(*snapshots)))

        history = section["historico"]
        self.assertEqual((history["total"], len(history["eventos"])), (34, 30))
        self.assertNotIn("Sem mudanças", [event["tipo"] for event in history["eventos"]])
        self.assertEqual(history["eventos"][0]["mudancas"][0]["atual"], ["Etapa 34"])
        # 35 imports, one unchanged: 34 events, newest first; the 30th shown is the change of import 5 ("Etapa 4").
        self.assertEqual(history["eventos"][-1]["mudancas"][0]["atual"], ["Etapa 4"])
        self.assertEqual(section["total_importacoes"], 35)

    def test_manual_link_wins_over_the_derived_one_and_a_derived_one_alone_is_dashboard(self):
        data = report(snapshot(2, [ticket(simpress_os=["100"], simpress_status=["Pedido entregue"], oracle=[oracle_item("200")])]))
        key, link = manual_link("oracle", SERIE, "200", 5)

        def derived(_report):
            return [
                {"fonte": "oracle", "serie": SERIE, "os": "200", "ano": 2026, "numero": "9", "chamado": "UTIC-2026-9", "origem": "dashboard"},
                {"fonte": "simpress", "serie": SERIE, "os": "100", "ano": 2026, "numero": "8", "chamado": "UTIC-2026-8", "origem": "dashboard"},
            ]

        by_source = {order["fonte"]: order["utic"] for order in self.os_section(
            self.get("SN1", data=data, links={key: link}, derived=derived))["ordens"]}
        self.assertEqual(by_source["oracle"], {"chamado": "UTIC-2026-5", "origem": "Manual"})
        self.assertEqual(by_source["simpress"], {"chamado": "UTIC-2026-8", "origem": "Dashboard"})

    def test_link_key_and_order_series_follow_the_report_row_not_the_url(self):
        row_serie = "SN\u00df1"  # the sharp s: `_stable_serial` drops it, `normalize_reference_value` makes it "SS"
        self.assertEqual((_stable_serial("SN1"), _stable_serial(row_serie)), ("SN1", "SN1"))
        self.assertNotEqual(normalize_reference_value("SN1"), normalize_reference_value(row_serie))
        data = report(snapshot(2, [ticket(row_serie, oracle=[oracle_item("200")])]))

        key, link = manual_link("oracle", row_serie, "200", 5)
        orders = self.os_section(self.get("SN1", data=data, links={key: link}))["ordens"]
        self.assertEqual([(o["serie"], o["os"], o["utic"]) for o in orders],
                         [(row_serie, "200", {"chamado": "UTIC-2026-5", "origem": "Manual"})])

        # A link written under the URL spelling is not found: the key follows the row of the report.
        url_key, url_link = manual_link("oracle", "SN1", "200", 6)
        orders = self.os_section(self.get("SN1", links={url_key: url_link}))["ordens"]
        self.assertEqual([(o["serie"], o["utic"]) for o in orders], [(row_serie, None)])

    def test_links_are_not_shared_between_sources_or_orders(self):
        data = report(snapshot(2, [ticket(simpress_os=["100"], simpress_status=["Pedido entregue"], oracle=[oracle_item("100")])]))
        key, link = manual_link("simpress", SERIE, "100", 5)
        orders = self.os_section(self.get(data=data, links={key: link}))["ordens"]
        self.assertEqual([(o["fonte"], o["utic"] and o["utic"]["origem"]) for o in orders],
                         [("simpress", "Manual"), ("oracle", None)])

    def test_serial_without_letters_or_digits_is_422_before_anything_else(self):
        response = self.get("---", raw="{ não é json")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.header_calls, [])

    def test_serial_outside_the_registry_is_404_even_with_an_unreadable_report(self):
        response = self.get("NAO-CADASTRADA", raw="{ não é json")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.header_calls, ["NAO-CADASTRADA"])

    def test_without_an_imported_report_the_state_is_sem_base(self):
        section = self.os_section(self.get())
        self.assertEqual((section["estado"], section["mensagem"]), ("sem_base", "Sem base importada"))
        self.assertEqual((section["total_importacoes"], section["ordens"], section["historico"]["eventos"]), (0, [], []))

    def test_series_in_no_import_is_sem_registros_and_keeps_the_totals(self):
        section = self.os_section(self.get(data=report(snapshot(1, [ticket("OUTRA")]), snapshot(2, [ticket("OUTRA")]))))
        self.assertEqual((section["estado"], section["mensagem"]), ("sem_registros", "Sem registros para esta série"))
        self.assertEqual((section["total_importacoes"], section["ultima_importacao_em"]), (2, "2026-11-02T09:00:00"))
        self.assertEqual((section["presente_na_ultima"], section["ultima_vez_observada_em"], section["ordens"]), (False, None, []))

    def test_unreadable_report_keeps_the_header_and_marks_the_source_unavailable(self):
        with self.assertLogs("routers.operations", level="WARNING") as logs:
            section = self.os_section(self.get(raw="{ não é json"))
        self.assertEqual((section["estado"], section["mensagem"]), ("indisponivel", "Fonte indisponível"))
        self.assertEqual((section["ordens"], section["historico"]["eventos"]), ([], []))
        self.assertEqual(logs.output, ["WARNING:routers.operations:Dossiê do equipamento: fonte de OS indisponível (HTTP 503)."])

    def test_unreadable_links_mark_the_source_unavailable_too(self):
        data = report(snapshot(1, [ticket(oracle=[oracle_item("200")])]))
        section = self.os_section(self.get(data=data, raw_links="{ não é json"))
        self.assertEqual((section["estado"], section["mensagem"]), ("indisponivel", "Fonte indisponível"))

    def test_a_failing_dashboard_derivation_does_not_break_the_dossier(self):
        def broken(_report):
            raise RuntimeError("boom")

        data = report(snapshot(1, [ticket(oracle=[oracle_item("200")])]))
        section = self.os_section(self.get(data=data, derived=broken))
        self.assertEqual((section["estado"], section["ordens"][0]["utic"]), ("ok", None))

    def test_the_route_never_writes_local_state(self):
        data = report(snapshot(1, [ticket(oracle=[oracle_item("200")])]))
        self.get(data=data)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["tickets.json"])


class DossierWiringTests(unittest.TestCase):
    def test_header_gives_only_series_and_model_and_none_outside_the_registry(self):
        cadastro = {"SN1": {"modelo": "Modelo Teste", "tipo": "Notebook", "usuarios_logados": USER, "id_cliente": "123"}}
        with patch.dict(inventory_state.equipamentos_cache, cadastro, clear=True):
            self.assertEqual(main._equipment_dossier_header(" sn1 "), {"serie": "SN1", "modelo": "Modelo Teste"})
            self.assertIsNone(main._equipment_dossier_header("SN2"))

    @unittest.skipUnless(HTTP_TEST_AVAILABLE, "Optional httpx test dependency is not installed")
    def test_dossier_route_requires_the_local_session_cookie(self):
        client = TestClient(main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}", client=("127.0.0.1", 1234))
        self.addCleanup(client.close)
        response = client.get("/api/equipamento/X/dossie")
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("modelo", response.text)


if __name__ == "__main__":
    unittest.main()
