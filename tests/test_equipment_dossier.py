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
from domains.equipment_dossier import DossierSources, TIMELINE_LIMIT
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
        self.assertEqual(set(body), {"serie", "modelo", "os", "linha_do_tempo"})
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


def alias_event(when, before="A", after="B", serial="SN1", **extra):
    return {"tipo": "apelido", "serial": serial, "apelido_anterior": before, "apelido_novo": after, "horario": when, **extra}


def mov(**fields):
    return {"serie": "SN1", "origem_cidade": "Curitiba", "destino_cidade": "Maringá", "estado": "preparada",
            "criada_em": "2026-11-07T09:00:00", "recebimento": None, "fechado_em": None, **fields}


@unittest.skipUnless(HTTP_TEST_AVAILABLE, "Optional httpx test dependency is not installed")
class DossierTimelineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=tempfile.gettempdir())
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def get(self, sources=None, *, links=None, derived=None, data=None):
        (self.root / "tickets.json").write_text(json.dumps(data or report(snapshot(1, [ticket("OUTRA")]))), encoding="utf-8")
        if links is not None:
            (self.root / "vinculos.json").write_text(json.dumps({"version": 1, "vinculos": links}), encoding="utf-8")
        router = create_operations_router(
            load_comparison_history=lambda: [], comparison_history_for_display=lambda event: event,
            ticket_report_path=lambda: self.root / "tickets.json", transaction_root=lambda: self.root,
            ticket_os_links_file=lambda: self.root / "vinculos.json", dashboard_vinculos=derived,
            equipment_header=lambda serial: dict(HEADER), dossier_sources=sources,
        )
        app = FastAPI()
        app.include_router(router)
        response = TestClient(app).get("/api/equipamento/SN1/dossie")
        self.assertEqual(response.status_code, 200, response.text)
        return response

    def timeline(self, *args, **kwargs):
        return self.get(*args, **kwargs).json()["linha_do_tempo"]

    def test_events_are_ordered_by_datetime_across_sources_zones_and_date_only(self):
        cover = ({"demandas": {"d1": {"cidade": "Londrina"}}, "reservas": {"r1": {
            "serie": "SN 1", "demanda_id": "d1", "criada_em": "2026-11-08T09:00:00"}}, "movimentacoes": {
            "m1": mov(recebimento={"data": "2026-11-11", "recebido_por": "Fulano"}, criada_em="2026-11-07T09:00:00"),
            "m2": mov(estado="cancelada", fechado_em="2026-11-09", criada_em="2026-11-06T09:00:00"),
        }}, {})
        sources = DossierSources(
            apelidos=lambda: [alias_event("2026-11-10T12:00:00-03:00", "", "Novo")],
            transferencias=lambda: [{"serial": "SN1", "criado_em": "2026-11-10T14:00:00+00:00", "retirada_cidade": "", "entrega_cidade": "Maringá"}],
            cobertura=lambda: cover,
        )
        events = self.timeline(sources)["eventos"]
        self.assertEqual([e["titulo"] for e in events], [
            "Movimentação recebida", "Apelido alterado", "Transferência registrada", "Movimentação cancelada",
            "Reservada na Cobertura", "Movimentação preparada", "Movimentação preparada"])
        self.assertEqual([e["so_data"] for e in events[:4]], [True, False, False, True])
        self.assertEqual(events[1]["detalhes"], ["(vazio) → Novo"])
        self.assertEqual(events[2]["detalhes"], ["— → Maringá"])
        self.assertEqual(events[4]["detalhes"], ["Necessidade em Londrina"])
        self.assertEqual(events[0]["detalhes"], ["Maringá"])

    def test_a_failing_source_is_unavailable_and_does_not_stop_the_others_nor_the_os_section(self):
        def broken():
            raise RuntimeError("segredo no erro")

        sources = DossierSources(apelidos=lambda: [alias_event("2026-11-10T12:00:00-03:00")], transferencias=broken, cobertura=broken)
        with self.assertLogs("routers.operations", level="WARNING") as logs:
            body = self.get(sources, data=report(snapshot(1, [ticket(oracle=[oracle_item("200")])]))).json()
        self.assertEqual(body["linha_do_tempo"]["indisponiveis"], ["transferencia", "cobertura"])
        self.assertEqual({e["tipo"] for e in body["linha_do_tempo"]["eventos"]}, {"apelido_usuario", "os"})
        self.assertEqual(body["os"]["estado"], "ok")
        self.assertEqual(logs.output, [
            "WARNING:routers.operations:Dossiê do equipamento: fonte transferencia indisponível (RuntimeError).",
            "WARNING:routers.operations:Dossiê do equipamento: fonte cobertura indisponível (RuntimeError)."])

    def test_unreadable_os_and_links_mark_os_and_sebrae_unavailable(self):
        (self.root / "tickets.json").write_text("{ não é json", encoding="utf-8")
        (self.root / "vinculos.json").write_text("{ não é json", encoding="utf-8")
        router = create_operations_router(
            load_comparison_history=lambda: [], comparison_history_for_display=lambda event: event,
            ticket_report_path=lambda: self.root / "tickets.json", transaction_root=lambda: self.root,
            ticket_os_links_file=lambda: self.root / "vinculos.json", equipment_header=lambda serial: dict(HEADER),
        )
        app = FastAPI()
        app.include_router(router)
        timeline = TestClient(app).get("/api/equipamento/SN1/dossie").json()["linha_do_tempo"]
        self.assertEqual(timeline["indisponiveis"], ["os", "sebrae"])

    def test_no_sensitive_field_leaves(self):
        marker = "VALOR-SENSIVEL"
        sensitive = {key: marker for key in ("entrega_contato", "entrega_obs", "nome_pessoa", "recebido_por", "comprovante", "senha", "descricao")}
        cover = ({"movimentacoes": {"m": mov(recebimento={"data": "2026-11-11", "recebido_por": marker, "comprovante": marker},
                                             divergencia={"descricao": marker}, **sensitive)}}, {})
        sources = DossierSources(
            apelidos=lambda: [alias_event("2026-11-10T12:00:00-03:00", **sensitive)],
            transferencias=lambda: [{"serial": "SN1", "criado_em": "2026-11-10T14:00:00+00:00", "payload": sensitive, **sensitive}],
            cobertura=lambda: cover, sebrae_encerrados=lambda: {"itens": {}},
        )
        text = json.dumps(self.timeline(sources), ensure_ascii=False)
        self.assertNotIn(marker, text)
        self.assertEqual({key for e in json.loads(text)["eventos"] for key in e}, {"quando", "so_data", "tipo", "titulo", "detalhes"})

    def test_cut_keeps_the_newest_200_and_the_real_total(self):
        history = [alias_event(f"2026-10-{1 + n // 24:02d}T{n % 24:02d}:00:00+00:00", str(n), str(n + 1)) for n in range(205)]
        timeline = self.timeline(DossierSources(apelidos=lambda: history))
        self.assertEqual((len(timeline["eventos"]), timeline["total"], timeline["limite"]), (TIMELINE_LIMIT, 205, 200))
        self.assertEqual(timeline["eventos"][0]["detalhes"], ["204 → 205"])
        self.assertEqual(timeline["eventos"][-1]["detalhes"], ["5 → 6"])

    def test_unreadable_dates_and_other_series_are_left_out(self):
        history = [alias_event("ontem"), alias_event(""), alias_event("2026-11-10T12:00:00", serial="OUTRA"),
                   {"tipo": "endereco", "serial": "SN1", "horario": "2026-11-10T12:00:00"}]
        self.assertEqual(self.timeline(DossierSources(apelidos=lambda: history))["total"], 0)

    def test_out_of_range_and_compact_dates_are_dropped_and_the_route_stays_200(self):
        history = [alias_event("9999-12-31T23:59:59-12:00"), alias_event("20261126"),
                   alias_event("2026-11-10T12:00:00-03:00", "", "Novo")]
        body = self.get(DossierSources(apelidos=lambda: history)).json()
        self.assertEqual(body["linha_do_tempo"]["total"], 1)
        self.assertIn("os", body)

    def test_empty_tipo_follows_the_alias_rule_of_alias_changes(self):
        history = [alias_event("2026-11-10T12:00:00-03:00", "A", "B", tipo=""),
                   {"tipo": "usuario", "serial": "SN1", "horario": "2026-11-09T12:00:00-03:00",
                    "usuario_anterior": "x", "usuario_novo": "y"}]
        titles = [e["titulo"] for e in self.timeline(DossierSources(apelidos=lambda: history))["eventos"]]
        self.assertEqual(titles, ["Usuário alterado"])

    def test_sebrae_events_come_from_dated_links_and_the_archive_only(self):
        manual = dict([manual_link("oracle", "SN-1", "200", 812)])
        next(iter(manual.values()))["salvo_em"] = "2026-11-02T10:00:00+00:00"
        undated = dict([manual_link("simpress", "SN-1", "300", 900)])
        derived = lambda _report: [{"fonte": "oracle", "serie": "SN-1", "os": "250", "chamado": "UTIC-2026-700", "origem": "dashboard"}]
        archive = {"itens": {
            "UTIC-2026-812": {"numero": "UTIC-2026-812", "senha": "x", "ciclos": [
                {"saida_em": "2026-11-05T10:00:00+00:00", "motivo": "finalizado", "status": "FINALIZADO"},
                {"saida_em": "2026-11-06T10:00:00+00:00", "motivo": "saiu_do_dashboard"}]},
            "UTIC-2026-700": {"numero": "UTIC-2026-700", "ciclos": [{"saida_em": "2026-11-07T10:00:00+00:00", "motivo": "finalizado", "status": ""}]},
            "UTIC-2026-999": {"numero": "UTIC-2026-999", "ciclos": [{"saida_em": "2026-11-08T10:00:00+00:00", "motivo": "finalizado"}]},
        }}
        timeline = self.timeline(DossierSources(sebrae_encerrados=lambda: archive), links={**manual, **undated}, derived=derived)
        self.assertEqual([(e["titulo"], e["detalhes"]) for e in timeline["eventos"]], [
            ("Chamado encerrado no Dashboard", ["UTIC-2026-700"]),
            ("Chamado saiu do Dashboard", ["UTIC-2026-812"]),
            ("Chamado encerrado no Dashboard", ["UTIC-2026-812 · FINALIZADO"]),
            ("Chamado vinculado à OS", ["UTIC-2026-812 · OS 200"]),
        ])

    def test_the_route_still_writes_nothing_with_every_source_wired(self):
        self.get(DossierSources(apelidos=lambda: [], transferencias=lambda: [], cobertura=lambda: ({}, {}), sebrae_encerrados=lambda: {}))
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["tickets.json"])

    def test_without_wired_sources_the_timeline_is_empty_and_nothing_is_unavailable(self):
        self.assertEqual(self.timeline(), {"eventos": [], "total": 0, "limite": 200, "indisponiveis": []})


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
