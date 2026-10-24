"""Usuário logado manual, busca por usuário e avisos de dados que somem do Endpoint."""

import copy
import io
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import openpyxl

import main
from core.errors import DomainBusyError, DomainError
from domains import inventory_state
from domains.effective_alias import (
    apply_effective_alias,
    build_endpoint_alias_index,
    endpoint_loss_warnings,
)
from domains.equipment_search import build_search_index, search_index
from domains.user_changes import (
    archived_manual_users,
    build_endpoint_warning_entries,
    logged_user_changes,
    manual_user_dates_by_serial,
    manual_users_overridden_by_endpoint,
)
import test_integrity_workflows as base
from test_integrity_workflows import _details_bytes, make_details, make_model


def endpoint_index(*rows):
    """rows: (serial, hostname, usuario)"""
    return build_endpoint_alias_index([
        {"ROTULODESERVICONUMERODESERIE": serial, "NOMEDOCOMPUTADOR": host, "USUARIOSLOGADOS": user}
        for serial, host, user in rows
    ])


def make_endpoint_with_users(path: Path, rows):
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = "InvAllComputersSummary"
    headers = ["ROTULODESERVICONUMERODESERIE", "NOMEDOCOMPUTADOR", "USUARIOSLOGADOS"]
    if any(len(row) > 3 for row in rows):
        headers.append("USUARIODOULTIMOLOGON")
    worksheet.append(headers)
    for row in rows:
        values = list(row[:3])
        if len(headers) > 3:
            values.append(row[3] if len(row) > 3 else "")
        worksheet.append(values)
    workbook.save(path)
    workbook.close()


class UserPrecedenceTests(unittest.TestCase):
    def test_manual_user_only_fills_the_gap(self):
        index = endpoint_index(("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "ana"))
        index["manual_users"] = {"SN1": "joao", "SN2": "pedro"}
        vazio, preenchido = {"serial": "SN-1"}, {"serial": "SN-2"}
        apply_effective_alias(vazio, index)
        apply_effective_alias(preenchido, index)
        self.assertEqual((vazio["usuarios_logados"], vazio["usuarios_logados_origem"]), ("joao", "manual"))
        self.assertEqual((preenchido["usuarios_logados"], preenchido["usuarios_logados_origem"]), ("ana", "endpoint"))

    def test_without_any_user_origin_is_empty(self):
        equipment = {"serial": "SN-3"}
        apply_effective_alias(equipment, endpoint_index(("SN-3", "HOST-3", "N/A")))
        self.assertEqual((equipment["usuarios_logados"], equipment["usuarios_logados_origem"]), ("", ""))

    def test_macbook_with_leading_s_gets_the_endpoint_user_of_its_serial(self):
        index = endpoint_index(("CXC9F072K1", "PRMACUMC005", "DDrodrigues"), ("CXC9F072K2", "PRNOTE01", "ana"))
        mac, notebook = {"serial": "SCXC9F072K1"}, {"serial": "SCXC9F072K2"}
        apply_effective_alias(mac, index)
        apply_effective_alias(notebook, index)
        self.assertEqual((mac["usuarios_logados"], mac["usuarios_logados_origem"]), ("DDrodrigues", "endpoint"))
        # Only PRMAC hostnames take the "S" equivalence.
        self.assertEqual(notebook["usuarios_logados"], "")

    def test_macbook_equivalence_is_skipped_when_the_simpress_base_has_both_serials(self):
        index = endpoint_index(("CXC9F072K1", "PRMACUMC005", "DDrodrigues"))
        index["details_serials"] = {"SCXC9F072K1", "CXC9F072K1"}
        equipment = {"serial": "SCXC9F072K1"}
        apply_effective_alias(equipment, index)
        self.assertEqual(equipment["usuarios_logados"], "")

    def test_manual_user_carries_the_date_it_was_informed(self):
        index = endpoint_index(("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "ana"))
        index["manual_users"] = {"SN1": "joao", "SN2": "pedro"}
        index["manual_user_dates"] = {"SN1": "2026-10-20T09:15:00-03:00", "SN2": "2026-10-19T08:00:00-03:00"}
        manual, endpoint = {"serial": "SN-1"}, {"serial": "SN-2"}
        apply_effective_alias(manual, index)
        apply_effective_alias(endpoint, index)
        self.assertEqual(manual["usuarios_logados_informado_em"], "2026-10-20T09:15:00-03:00")
        # The Endpoint user wins, so the manual date is not shown.
        self.assertEqual(endpoint["usuarios_logados_informado_em"], "")

    def test_dates_count_only_for_the_same_current_user(self):
        stored = {
            "SN-1": {"usuario": "joao", "informado_em": "2026-10-20T09:15:00-03:00"},
            "SN-2": {"usuario": "antigo", "informado_em": "2026-10-01T09:15:00-03:00"},
            "SN-3": {"usuario": "ana", "informado_em": "2026-10-02T09:15:00-03:00"},
            "SN-4": "texto solto",
        }
        users = {"SN1": "joao", "SN2": "novo", "SN4": "bia"}
        self.assertEqual(manual_user_dates_by_serial(users, stored), {"SN1": "2026-10-20T09:15:00-03:00"})

    def test_duplicated_endpoint_serial_lists_candidates_without_choosing_one(self):
        index = endpoint_index(
            ("SN-1", "HOST-A", "joao"), ("SN-1", "HOST-B", "maria"), ("SN-1", "HOST-C", "JOAO"),
            ("SN-2", "HOST-2", "ana"), ("SN-3", "HOST-3", ""), ("SN-3", "HOST-4", "N/A"),
        )
        self.assertEqual(index["ambiguous_users"], {"SN1": ["joao", "maria"]})
        ambiguous, unique, blank = {"serial": "SN-1"}, {"serial": "SN-2"}, {"serial": "SN-3"}
        for equipment in (ambiguous, unique, blank):
            apply_effective_alias(equipment, index)
        self.assertEqual((ambiguous["usuarios_logados"], ambiguous["usuarios_logados_origem"]), ("", ""))
        self.assertEqual(ambiguous["usuarios_logados_candidatos"], ["joao", "maria"])
        self.assertEqual(unique["usuarios_logados_candidatos"], [])
        self.assertEqual(blank["usuarios_logados_candidatos"], [])

    def test_manual_user_fills_an_ambiguous_serial_and_keeps_the_candidates(self):
        index = endpoint_index(("SN-1", "HOST-A", "joao"), ("SN-1", "HOST-B", "maria"))
        index["manual_users"] = {"SN1": "pedro"}
        equipment = {"serial": "SN-1"}
        apply_effective_alias(equipment, index)
        self.assertEqual((equipment["usuarios_logados"], equipment["usuarios_logados_origem"]), ("pedro", "manual"))
        self.assertEqual(equipment["usuarios_logados_candidatos"], ["joao", "maria"])


class UserSearchTests(unittest.TestCase):
    def test_search_finds_equipment_by_logged_user_after_serial_and_alias_matches(self):
        cache = {
            "SN-A": {"serial": "SN-A", "modelo": "X", "tipo": "Notebook", "apelido": "H1", "usuarios_logados": "FVALMEIDA"},
            "SN-B": {"serial": "SN-B", "modelo": "Y", "tipo": "Notebook", "apelido": "H2", "usuarios_logados": ""},
        }
        index = build_search_index(cache)
        self.assertEqual([r["serial"] for r in search_index(index, "valmeida")], ["SN-A"])
        self.assertEqual([r["serial"] for r in search_index(index, "fvalmeida")], ["SN-A"])
        self.assertEqual(search_index(index, "ninguem"), [])

    def test_ambiguous_endpoint_candidates_are_searchable_and_public(self):
        cache = {"SN-A": {"serial": "SN-A", "modelo": "X", "tipo": "Notebook", "apelido": "H1",
                          "usuarios_logados": "", "usuarios_logados_candidatos": ["joao", "maria"]}}
        found = search_index(build_search_index(cache), "maria")
        self.assertEqual([r["serial"] for r in found], ["SN-A"])
        self.assertEqual(found[0]["usuarios_logados_candidatos"], ["joao", "maria"])


class EndpointLossWarningTests(unittest.TestCase):
    def test_reports_removed_user_and_hostname_only(self):
        before = endpoint_index(("SN-1", "HOST-1", "ana"), ("SN-2", "HOST-2", "bia"), ("SN-3", "HOST-3", "cris"))
        after = endpoint_index(("SN-1", "HOST-1", ""), ("SN-3", "HOST-3", "cris"))
        found = {(w["serial_key"], w["motivo"]): w["valor_anterior"] for w in endpoint_loss_warnings(before, after)}
        self.assertEqual(found, {
            ("SN1", "usuario_removido"): "ana",
            ("SN2", "usuario_removido"): "bia",
            ("SN2", "hostname_removido"): "HOST-2",
        })

    def test_duplicated_or_unavailable_sources_do_not_warn(self):
        before = endpoint_index(("SN-1", "HOST-1", "ana"))
        duplicated = endpoint_index(("SN-1", "HOST-1", ""), ("SN-1", "HOST-9", ""))
        self.assertEqual(endpoint_loss_warnings(before, duplicated), [])
        self.assertEqual(endpoint_loss_warnings({"available": False}, before), [])
        self.assertEqual(endpoint_loss_warnings(before, {"available": False}), [])

    def test_same_file_does_not_repeat_a_warning(self):
        warnings = [{"serial_key": "SN1", "motivo": "usuario_removido", "valor_anterior": "ana"}]
        first = build_endpoint_warning_entries(warnings, {"SN1": {"serial": "SN-1", "modelo": "M"}}, [], "abc")
        self.assertEqual(len(first), 1)
        self.assertEqual(first[0]["tipo"], "aviso_endpoint")
        self.assertEqual(build_endpoint_warning_entries(warnings, {}, first, "abc"), [])
        self.assertEqual(len(build_endpoint_warning_entries(warnings, {}, first, "outro")), 1)


def equipment(serial, user="", origin="", alias=""):
    return {"serial": serial, "apelido": alias, "usuarios_logados": user, "usuarios_logados_origem": origin if user else ""}


class UserChangeSummaryTests(unittest.TestCase):
    def test_lists_new_changed_removed_and_returning_manual_users(self):
        before = {
            "SN-1": equipment("SN-1", "joao", "manual"),
            "SN-2": equipment("SN-2", "ana", "endpoint"),
            "SN-3": equipment("SN-3", "bia", "endpoint"),
            "SN-4": equipment("SN-4", "cris", "endpoint"),
            "SN-5": equipment("SN-5", "duda", "endpoint"),
        }
        after = {
            "SN-1": equipment("SN-1", "carla", "endpoint", "HOST-1"),
            "SN-2": equipment("SN-2", "ana2", "endpoint"),
            "SN-3": equipment("SN-3"),
            "SN-4": equipment("SN-4", "velho", "manual"),
            "SN-5": equipment("SN-5", "duda", "endpoint"),
            "SN-6": equipment("SN-6", "nova", "endpoint"),
        }
        overridden = {"SN1": {"usuario_manual": "joao"}}
        rows = logged_user_changes(before, after, {"duplicates": {}}, overridden, {"SN3": "manual-antigo"})
        self.assertEqual([(r["tipo"], r["serie"]) for r in rows], [
            ("novo_endpoint", "SN-1"), ("alterado_endpoint", "SN-2"),
            ("removido_endpoint", "SN-3"), ("manual_voltou", "SN-4"),
        ])
        novo, alterado, removido, voltou = rows
        self.assertEqual((novo["usuario_anterior"], novo["origem_anterior"], novo["usuario_novo"]), ("joao", "manual", "carla"))
        self.assertEqual(novo["usuario_manual_arquivado"], "joao")
        self.assertIn("arquivado", novo["motivo"])
        self.assertEqual((alterado["usuario_anterior"], alterado["usuario_novo"]), ("ana", "ana2"))
        self.assertEqual((removido["usuario_novo"], removido["usuario_manual_arquivado"]), ("", "manual-antigo"))
        self.assertEqual((voltou["usuario_novo"], voltou["origem_nova"]), ("velho", "manual"))
        self.assertNotIn("usuario_manual_arquivado", voltou)

    def test_removal_without_manual_and_duplicated_endpoint_serial(self):
        before = {"SN-1": equipment("SN-1", "ana", "endpoint")}
        rows = logged_user_changes(before, {"SN-1": equipment("SN-1")}, {"duplicates": {"SN1": []}}, {}, {})
        self.assertEqual(len(rows), 1)
        self.assertNotIn("usuario_manual_arquivado", rows[0])
        self.assertIn("duplicada no Endpoint", rows[0]["motivo"])

    def test_only_manual_users_hidden_by_the_endpoint_are_archived(self):
        cache = {
            "SN-1": equipment("SN-1", "carla", "endpoint"),
            "SN-2": equipment("SN-2", "joao", "manual"),
            "SCXC9F072K1": equipment("SCXC9F072K1", "DDrodrigues", "endpoint"),
        }
        found = manual_users_overridden_by_endpoint(cache, {"SN1": "joao", "SN2": "joao", "SCXC9F072K1": "mac"})
        self.assertEqual(set(found), {"SN1", "SCXC9F072K1"})
        self.assertEqual(found["SCXC9F072K1"]["usuario_endpoint"], "DDrodrigues")

    def test_archived_manual_user_is_forgotten_after_a_later_user_change(self):
        history = [
            {"tipo": "usuario", "serial": "SN-1", "acao": "arquivado_endpoint", "usuario_anterior": "joao"},
            {"tipo": "usuario", "serial": "SN-2", "acao": "arquivado_endpoint", "usuario_anterior": "bia"},
            {"tipo": "usuario", "serial": "SN-2", "acao": "alteracao", "usuario_anterior": "", "usuario_novo": "x"},
            {"tipo": "aviso_endpoint", "serial": "SN-1", "acao": "aviso"},
        ]
        self.assertEqual(archived_manual_users(history), {"SN1": "joao"})


class UserDecisionFileReadTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix="simpress-decision-files-")
        self.root = Path(self.temp_context.name)
        self.users_file = self.root / "usuarios_manuais.json"

    def tearDown(self):
        self.temp_context.cleanup()

    def assert_unavailable(self, callback):
        with self.assertRaises(DomainBusyError) as raised:
            callback()
        self.assertEqual(raised.exception.status_code, 503)

    def test_manual_user_file_distinguishes_absent_from_valid_empty_and_zero_length(self):
        from domains.user_changes import read_manual_users

        self.assertIsNone(read_manual_users(self.users_file))
        self.users_file.write_text("{}", encoding="utf-8")
        self.assertEqual(read_manual_users(self.users_file), {})
        self.users_file.write_text("", encoding="utf-8")
        self.assert_unavailable(lambda: read_manual_users(self.users_file))

    def test_manual_user_file_rejects_corrupt_json_invalid_shape_and_permission_error(self):
        from domains.user_changes import read_manual_users

        self.users_file.write_text("{", encoding="utf-8")
        self.assert_unavailable(lambda: read_manual_users(self.users_file))
        self.users_file.write_text("[]", encoding="utf-8")
        self.assert_unavailable(lambda: read_manual_users(self.users_file))
        with patch.object(Path, "read_text", side_effect=PermissionError("synthetic denied")):
            self.assert_unavailable(lambda: read_manual_users(self.users_file))

    def test_hold_file_distinguishes_absent_and_rejects_empty_corrupt_and_permission_error(self):
        from domains.user_holds import holds_file, read_holds

        path = holds_file(self.users_file)
        self.assertEqual(read_holds(self.users_file), {})
        path.write_text("", encoding="utf-8")
        self.assert_unavailable(lambda: read_holds(self.users_file))
        path.write_text("{", encoding="utf-8")
        self.assert_unavailable(lambda: read_holds(self.users_file))
        with patch.object(Path, "read_text", side_effect=PermissionError("synthetic denied")):
            self.assert_unavailable(lambda: read_holds(self.users_file))

    def test_valid_refused_hold_is_retained_as_trusted_user_state(self):
        from domains.user_holds import HOLD_REPLACE_MANUAL, manual_users_from_holds, read_holds, holds_file

        hold = {
            "id": "synthetic-hold-id", "tipo": HOLD_REPLACE_MANUAL, "estado": "recusada",
            "serial": "SN-1", "usuario_atual": "joao", "usuario_endpoint": "carla",
            "equipamento": "Notebook", "computador": "HOST-1", "criado_em": "2026-10-20T10:00:00-03:00",
        }
        holds_file(self.users_file).write_text(json.dumps({"SN-1": hold}), encoding="utf-8")
        loaded = read_holds(self.users_file)
        self.assertEqual(loaded["SN1"]["estado"], "recusada")
        self.assertEqual(manual_users_from_holds(loaded), {"SN1": "joao"})
        holds_file(self.users_file).write_text(json.dumps({"SN-1": {"tipo": HOLD_REPLACE_MANUAL}}), encoding="utf-8")
        self.assert_unavailable(lambda: read_holds(self.users_file))


def no_name(editable):
    """Entra fields of a lookup entry when no Entra or manual name is known."""
    return {"nome_pessoa": "", "nome_pessoa_origem": "", "nome_pessoa_editavel": editable}


class ManualUserWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".manual-user-test-", dir=tempfile.gettempdir())
        self.root = Path(self.temp_context.name)
        self.input_dir = self.root / "planilhas_entrada"
        self.input_dir.mkdir()
        self.state_dir = self.root / "state"
        self.state_dir.mkdir()
        self.details = self.input_dir / "EquipamentosDetalhes_atual.xlsx"
        self.endpoint = self.input_dir / "InvAllComputersSummary_atual.xlsx"
        self.model = self.input_dir / "modelo-ficticio.xlsx"
        self.overrides = self.root / "apelidos_modificados.json"
        self.manual_users = self.root / "usuarios_manuais.json"
        self.manual_dates = self.root / "usuarios_manuais_datas.json"
        self.history = self.root / "historico_alteracoes.json"
        self.comparison_history = self.root / "historico_comparacoes.json"
        self.stack = ExitStack()
        for name, value in (
            ("BASE_DIR", self.root), ("STATE_DIR", self.state_dir), ("INPUT_DIR", self.input_dir),
            ("DETAILS_UPLOAD_FILE", self.details), ("ENDPOINT_UPLOAD_FILE", self.endpoint),
            ("EXPORT_MODEL_FILE", self.model), ("UPLOAD_BACKUPS_DIR", self.input_dir / "_backups"),
            ("MODIFIED_APELIDOS_FILE", self.overrides), ("MANUAL_USERS_FILE", self.manual_users),
            ("ALIAS_HISTORY_FILE", self.history), ("COMPARISON_HISTORY_FILE", self.comparison_history),
            ("HISTORY_ANNOTATIONS_DIR", self.root / "shared"),
            ("LOCAL_HISTORY_ANNOTATION_OUTBOX_DIR", self.root / "pending"),
            ("CUSTOM_UNIDADES_FILE", self.root / "unidades_custom.json"), ("TRANSACTION_ROOT", self.root),
            ("ENTRA_USERS_FILE", self.state_dir / "usuarios_entra_pr.json"),
            ("MANUAL_PERSON_NAMES_FILE", self.state_dir / "nomes_pessoas_manuais.json"),
        ):
            self.stack.enter_context(patch.object(main, name, value))
        self.old_state = (
            copy.deepcopy(inventory_state.equipamentos_cache),
            copy.deepcopy(inventory_state.unidades_cache),
            copy.deepcopy(inventory_state.stats_cache),
        )
        inventory_state.equipamentos_cache = {}
        inventory_state.unidades_cache = []
        inventory_state.stats_cache = {}
        self.overrides.write_text("{}", encoding="utf-8")
        (self.root / "unidades_custom.json").write_text("[]", encoding="utf-8")
        self.history.write_text("[]", encoding="utf-8")
        self.comparison_history.write_text("[]", encoding="utf-8")
        make_details(self.details, [
            ("SN-1", "ALIAS-1", "Modelo A", "Maringá", "Notebook", "87000000"),
            ("SN-2", "ALIAS-2", "Modelo B", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint_with_users(self.endpoint, [("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "ana")])
        make_model(self.model)
        self.assertTrue(main.load_database())

    def tearDown(self):
        inventory_state.equipamentos_cache, inventory_state.unidades_cache, inventory_state.stats_cache = self.old_state
        self.stack.close()
        self.temp_context.cleanup()

    def _save(self, serial, usuario):
        return main.atualizar_usuario(main.UsuarioUpdatePayload(serial=serial, usuario=usuario))

    def test_manual_user_is_saved_searchable_logged_and_undoable(self):
        saved = self._save("SN-1", "  joao  ")
        self.assertEqual(saved["equipamento"]["usuarios_logados"], "joao")
        self.assertEqual(saved["equipamento"]["usuarios_logados_origem"], "manual")
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {"SN-1": "joao"})
        informed_at = saved["equipamento"]["usuarios_logados_informado_em"]
        self.assertRegex(informed_at, r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(json.loads(self.manual_dates.read_text(encoding="utf-8")),
                         {"SN-1": {"usuario": "joao", "informado_em": informed_at}})
        event = json.loads(self.history.read_text(encoding="utf-8"))[-1]
        self.assertEqual((event["tipo"], event["usuario_anterior"], event["usuario_novo"]), ("usuario", "", "joao"))

        # Sobrevive a uma nova carga da base e entra na busca.
        self.assertTrue(main.load_database())
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["usuarios_logados"], "joao")
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["usuarios_logados_informado_em"], informed_at)
        self.assertEqual([r["serial"] for r in search_index(inventory_state.equipment_search_index, "JOAO")], ["SN-1"])

        undone = main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=event["id"]))
        self.assertEqual(undone["equipamento"]["usuarios_logados"], "")
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {})
        self.assertEqual(json.loads(self.manual_dates.read_text(encoding="utf-8")), {})
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8"))[-1]["acao"], "desfazer")

    def test_lookup_for_comparison_rows_follows_the_home_rule(self):
        from routers.aliases import UsuariosConsultaPayload

        def lookup():
            return main.consultar_usuarios_logados(UsuariosConsultaPayload(series=["SN-1", "sn2", "SN-9", ""]))["usuarios"]

        empty = {"informado_em": "", "candidatos": [], "hostname_ambiguo": False, "hostname_candidatos": []}
        self.assertEqual(lookup(), {
            "SN-1": {"usuario": "", "origem": "", "serial_cadastro": "SN-1", "hostname": "HOST-1", **empty, **no_name(False)},
            "sn2": {"usuario": "ana", "origem": "endpoint", "serial_cadastro": "SN-2", "hostname": "HOST-2", **empty, **no_name(True)},
            "SN-9": {"usuario": "", "origem": "", "serial_cadastro": None, "hostname": "", **empty, **no_name(False)},
        })
        saved = self._save("SN-1", "joao")
        informed_at = saved["equipamento"]["usuarios_logados_informado_em"]
        self.assertEqual(lookup()["SN-1"], {
            "usuario": "joao", "origem": "manual", "serial_cadastro": "SN-1", "informado_em": informed_at, "candidatos": [],
            "hostname": "HOST-1", "hostname_ambiguo": False, "hostname_candidatos": [], **no_name(True),
        })

    def test_legacy_manual_user_without_date_still_applies(self):
        self.manual_users.write_text(json.dumps({"SN-1": "legado"}), encoding="utf-8")
        self.assertTrue(main.load_database())
        equipment = inventory_state.equipamentos_cache["SN-1"]
        self.assertEqual((equipment["usuarios_logados"], equipment["usuarios_logados_origem"]), ("legado", "manual"))
        self.assertEqual(equipment["usuarios_logados_informado_em"], "")

    def test_saving_the_same_user_again_keeps_the_first_date(self):
        self._save("SN-1", "joao")
        stored = json.loads(self.manual_dates.read_text(encoding="utf-8"))
        stored["SN-1"]["informado_em"] = "2026-01-02T03:04:05-03:00"
        self.manual_dates.write_text(json.dumps(stored), encoding="utf-8")
        again = self._save("SN-1", "joao")
        self.assertEqual(again["equipamento"]["usuarios_logados_informado_em"], "2026-01-02T03:04:05-03:00")
        changed = self._save("SN-1", "maria")
        self.assertNotEqual(changed["equipamento"]["usuarios_logados_informado_em"], "2026-01-02T03:04:05-03:00")

    def test_duplicated_endpoint_serial_shows_candidates_and_accepts_a_manual_user(self):
        from routers.aliases import UsuariosConsultaPayload

        make_endpoint_with_users(self.endpoint, [
            ("SN-1", "HOST-1", "joao"), ("SN-1", "HOST-1B", "maria"), ("SN-2", "HOST-2", "ana"),
            ("SN-8", "HOST-8", "carla"), ("SN-8", "HOST-8B", "davi"),
        ])
        self.assertTrue(main.load_database())
        found = main.consultar_usuarios_logados(UsuariosConsultaPayload(series=["SN-1", "SN-8"]))["usuarios"]
        self.assertEqual(found["SN-1"], {
            "usuario": "", "origem": "", "serial_cadastro": "SN-1", "informado_em": "", "candidatos": ["joao", "maria"],
            "hostname": "", "hostname_ambiguo": True, "hostname_candidatos": ["HOST-1", "HOST-1B"], **no_name(False),
        })
        # Outside the Simpress base the candidates still come from the Endpoint, with no manual field.
        self.assertEqual(found["SN-8"]["candidatos"], ["carla", "davi"])
        self.assertIsNone(found["SN-8"]["serial_cadastro"])
        self.assertTrue(found["SN-8"]["hostname_ambiguo"])
        self.assertEqual(found["SN-8"]["hostname_candidatos"], ["HOST-8", "HOST-8B"])

        saved = self._save("SN-1", "pedro")
        self.assertEqual(saved["equipamento"]["usuarios_logados"], "pedro")
        self.assertEqual(saved["equipamento"]["usuarios_logados_candidatos"], ["joao", "maria"])

    def test_macbook_user_is_found_by_either_serial_and_cannot_be_replaced(self):
        from routers.aliases import UsuariosConsultaPayload

        make_details(self.details, [
            ("SN-1", "ALIAS-1", "Modelo A", "Maringá", "Notebook", "87000000"),
            ("SCXC9F072K1", "PRMACUMC005", "MacBook Air", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint_with_users(self.endpoint, [("SN-1", "HOST-1", ""), ("CXC9F072K1", "PRMACUMC005", "DDrodrigues")])
        self.assertTrue(main.load_database())
        self.assertEqual(inventory_state.equipamentos_cache["SCXC9F072K1"]["usuarios_logados"], "DDrodrigues")
        found = main.consultar_usuarios_logados(UsuariosConsultaPayload(series=["SCXC9F072K1", "CXC9F072K1"]))["usuarios"]
        expected = {
            "usuario": "DDrodrigues", "origem": "endpoint", "serial_cadastro": "SCXC9F072K1", "informado_em": "", "candidatos": [],
            "hostname": "PRMACUMC005", "hostname_ambiguo": False, "hostname_candidatos": [], **no_name(True),
        }
        self.assertEqual(found, {"SCXC9F072K1": expected, "CXC9F072K1": expected})
        with self.assertRaises(DomainError) as raised:
            self._save("SCXC9F072K1", "outro")
        self.assertEqual(raised.exception.status_code, 409)

        make_endpoint_with_users(self.endpoint, [
            ("SN-1", "HOST-1", ""),
            ("CXC9F072K1", "PRMACUMC005", "DDrodrigues"),
            ("CXC9F072K1", "PRMACUMC006", "maria"),
        ])
        self.assertTrue(main.load_database())
        ambiguous = main.consultar_usuarios_logados(UsuariosConsultaPayload(series=["SCXC9F072K1"]))["usuarios"]["SCXC9F072K1"]
        self.assertEqual(ambiguous["usuario"], "")
        self.assertEqual(ambiguous["candidatos"], ["DDrodrigues", "maria"])
        self.assertTrue(ambiguous["hostname_ambiguo"])
        self.assertEqual(ambiguous["hostname_candidatos"], ["PRMACUMC005", "PRMACUMC006"])

    def test_clearing_records_history_and_endpoint_user_is_protected(self):
        self._save("SN-1", "joao")
        cleared = self._save("SN-1", "")
        self.assertEqual(cleared["equipamento"]["usuarios_logados"], "")
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {})
        self.assertEqual(len(json.loads(self.history.read_text(encoding="utf-8"))), 2)
        with self.assertRaises(DomainError) as raised:
            self._save("SN-2", "outro")
        self.assertEqual(raised.exception.status_code, 409)

    def test_delete_restores_previous_user_and_removes_event(self):
        self._save("SN-1", "joao")
        self._save("SN-1", "maria")
        latest = json.loads(self.history.read_text(encoding="utf-8"))[-1]
        result = main.excluir_evento_historico_apelido(latest["id"])
        self.assertEqual(result["tipo"], "usuario")
        self.assertEqual(result["equipamento"]["usuarios_logados"], "joao")
        self.assertEqual(len(json.loads(self.history.read_text(encoding="utf-8"))), 1)

    def test_user_events_do_not_block_alias_undo(self):
        main.atualizar_apelido(main.ApelidoUpdatePayload(serial="SN-1", apelido="NOVO"))
        alias_event = json.loads(self.history.read_text(encoding="utf-8"))[-1]
        self._save("SN-1", "joao")
        undone = main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=alias_event["id"]))
        self.assertEqual(undone["equipamento"]["usuarios_logados"], "joao")

    def _submit(self, endpoint_rows, details_rows=None):
        from starlette.datastructures import UploadFile
        import asyncio
        import uuid

        path = self.endpoint.with_name(f"novo-{uuid.uuid4().hex}.xlsx")
        make_endpoint_with_users(path, endpoint_rows)
        details_bytes = _details_bytes(details_rows or [
            ("SN-1", "ALIAS-1", "Modelo A", "Maringá", "Notebook", "87000000"),
            ("SN-2", "ALIAS-2", "Modelo B", "Maringá", "Notebook", "87000000"),
        ])
        return asyncio.run(main.update_inventory_files(
            UploadFile(filename="InvAll.xlsx", file=io.BytesIO(path.read_bytes())),
            UploadFile(filename="Detalhes.xlsx", file=io.BytesIO(details_bytes)),
            services=main._inventory_update_services,
            idempotency_key=uuid.uuid4().hex,
        ))["comparacao"]

    def _user_events(self):
        return [e for e in json.loads(self.history.read_text(encoding="utf-8")) if e["tipo"] == "usuario"]

    def _resolve(self, row, decision):
        from domains import user_holds
        return user_holds.resolve_hold(main._alias_change_services, row["pendencia_id"], decision)

    def test_endpoint_user_over_manual_waits_for_a_decision_before_archiving_it(self):
        self._save("SN-1", "joao")
        result = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])
        # Nada muda sozinho: o manual continua valendo e fica no arquivo.
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {"SN-1": "joao"})
        self.assertEqual(self._user_events()[-1]["acao"], "alteracao")
        cached = inventory_state.equipamentos_cache["SN-1"]
        self.assertEqual((cached["usuarios_logados"], cached["usuarios_logados_origem"], cached["usuarios_logados_pendencia"]),
                         ("joao", "manual", "substituicao_pendente"))
        [row] = result["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["serie"], row["usuario_anterior"], row["usuario_novo"]),
                         ("substituicao_pendente", "SN-1", "joao", "carla"))
        self.assertTrue(row["anotacao_id"])
        saved = json.loads(self.comparison_history.read_text(encoding="utf-8"))[-1]
        self.assertEqual(saved["resumo"]["mudancas_usuarios"], 1)
        # O mesmo Endpoint de novo não pergunta outra vez.
        self.assertEqual(self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])["mudancas_usuarios"], [])

        # Permitir: o usuário manual é arquivado e o do Endpoint passa a valer.
        resolved = self._resolve(row, "permitir")
        self.assertEqual((resolved["equipamento"]["usuarios_logados"], resolved["equipamento"]["usuarios_logados_origem"]), ("carla", "endpoint"))
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {})
        archived = self._user_events()[-1]
        self.assertEqual(
            (archived["acao"], archived["usuario_anterior"], archived["usuario_novo"], archived["usuario_endpoint"]),
            ("arquivado_endpoint", "joao", "", "carla"),
        )
        with self.assertRaises(DomainError):
            self._resolve(row, "permitir")

        # Endpoint esvazia: o usuário atual continua valendo até a confirmação.
        result = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "ana")])
        [gone] = result["mudancas_usuarios"]
        self.assertEqual((gone["tipo"], gone["usuario_anterior"], gone["usuario_novo"]), ("ausente_pendente", "carla", ""))
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["usuarios_logados"], "carla")
        self.assertEqual(self._resolve(gone, "remover")["equipamento"]["usuarios_logados"], "")

        # Desfazer o arquivamento no histórico de alterações devolve o manual.
        undone = main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=archived["id"]))
        self.assertEqual((undone["equipamento"]["usuarios_logados"], undone["equipamento"]["usuarios_logados_origem"]), ("joao", "manual"))

    def test_refusing_the_replacement_keeps_the_manual_user_and_remembers_the_endpoint_user(self):
        self._save("SN-1", "joao")
        [row] = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])["mudancas_usuarios"]
        refused = self._resolve(row, "recusar")
        self.assertEqual((refused["equipamento"]["usuarios_logados"], refused["equipamento"]["usuarios_logados_pendencia"]), ("joao", ""))
        with self.assertRaises(DomainError):
            self._resolve(row, "recusar")
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {"SN-1": "joao"})
        # O mesmo usuário do Endpoint não é perguntado de novo, mas outro usuário volta a perguntar.
        self.assertEqual(self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])["mudancas_usuarios"], [])
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["usuarios_logados"], "joao")
        [again] = self._submit([("SN-1", "HOST-1", "davi"), ("SN-2", "HOST-2", "ana")])["mudancas_usuarios"]
        self.assertEqual((again["tipo"], again["usuario_novo"]), ("substituicao_pendente", "davi"))

    def test_decision_rechecks_the_hold_after_acquiring_transaction_locks(self):
        from domains.user_holds import holds_file

        self._save("SN-1", "joao")
        [row] = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])["mudancas_usuarios"]
        pending = holds_file(self.manual_users)
        original_holds = json.loads(pending.read_text(encoding="utf-8"))
        [key] = original_holds
        original_transaction = main.AtomicFileTransaction
        before = {path: path.read_bytes() for path in (self.manual_users, self.manual_dates, self.history)}
        cache_before = copy.deepcopy(inventory_state.equipamentos_cache)

        for change in ("removed", "decided", "replaced", "changed_same_id"):
            with self.subTest(change=change):
                pending.write_text(json.dumps(original_holds), encoding="utf-8")
                concurrent = copy.deepcopy(original_holds)
                if change == "removed":
                    concurrent.clear()
                elif change == "decided":
                    concurrent[key]["estado"] = "recusada"
                elif change == "replaced":
                    concurrent[key]["id"] = "new-pending-decision"
                else:
                    concurrent[key]["usuario_endpoint"] = "davi"

                def interleaved_transaction(root, targets):
                    pending.write_text(json.dumps(concurrent), encoding="utf-8")
                    return original_transaction(root, targets)

                with patch.object(main, "AtomicFileTransaction", side_effect=interleaved_transaction):
                    with self.assertRaises(DomainError) as raised:
                        self._resolve(row, "permitir")
                self.assertEqual(raised.exception.status_code, 409)
                self.assertEqual(json.loads(pending.read_text(encoding="utf-8")), concurrent)
                self.assertEqual({path: path.read_bytes() for path in before}, before)
                self.assertEqual(inventory_state.equipamentos_cache, cache_before)

    def test_decision_rejects_changed_users_even_if_the_hold_id_is_unchanged(self):
        self._save("SN-1", "joao")
        [row] = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])["mudancas_usuarios"]
        for source in ("manual", "endpoint"):
            with self.subTest(source=source):
                self.manual_users.write_text(json.dumps({"SN-1": "maria" if source == "manual" else "joao"}), encoding="utf-8")
                make_endpoint_with_users(self.endpoint, [
                    ("SN-1", "HOST-1", "davi" if source == "endpoint" else "carla"), ("SN-2", "HOST-2", "ana"),
                ])
                before = {path: path.read_bytes() for path in (self.manual_users, self.manual_dates, self.history)}
                with self.assertRaises(DomainError) as raised:
                    self._resolve(row, "permitir")
                self.assertEqual(raised.exception.status_code, 409)
                self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_refused_replacement_survives_missing_manual_file_and_same_endpoint_update(self):
        from domains.user_holds import holds_file

        self._save("SN-1", "joao")
        [row] = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])["mudancas_usuarios"]
        self._resolve(row, "recusar")
        self.manual_users.unlink()

        self.assertTrue(main.load_database())
        cached = inventory_state.equipamentos_cache["SN-1"]
        self.assertEqual((cached["usuarios_logados"], cached["usuarios_logados_origem"]), ("joao", "manual"))
        result = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])
        self.assertEqual(result["mudancas_usuarios"], [])
        cached = inventory_state.equipamentos_cache["SN-1"]
        self.assertEqual((cached["usuarios_logados"], cached["usuarios_logados_origem"]), ("joao", "manual"))
        self.assertFalse(self.manual_users.exists())
        [saved_hold] = json.loads(holds_file(self.manual_users).read_text(encoding="utf-8")).values()
        self.assertEqual(saved_hold["estado"], "recusada")

    def test_corrupt_manual_user_file_aborts_update_and_restores_synthetic_inputs(self):
        original_endpoint = self.endpoint.read_bytes()
        original_details = self.details.read_bytes()
        self.manual_users.write_text("{", encoding="utf-8")

        with self.assertRaises(DomainBusyError) as raised:
            self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "bia")])

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(self.endpoint.read_bytes(), original_endpoint)
        self.assertEqual(self.details.read_bytes(), original_details)
        self.assertEqual(self.manual_users.read_text(encoding="utf-8"), "{")

    def test_missing_manual_file_blocks_removing_the_endpoint_user_of_a_pending_hold(self):
        from domains.user_holds import holds_file

        self._save("SN-1", "joao")
        [row] = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])["mudancas_usuarios"]
        self.manual_users.unlink()
        self.assertTrue(main.load_database())
        original_endpoint = self.endpoint.read_bytes()
        original_details = self.details.read_bytes()

        with self.assertRaises(DomainBusyError) as raised:
            self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "ana")])

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(self.endpoint.read_bytes(), original_endpoint)
        self.assertEqual(self.details.read_bytes(), original_details)
        self.assertFalse(self.manual_users.exists())
        [saved_hold] = json.loads(holds_file(self.manual_users).read_text(encoding="utf-8")).values()
        self.assertEqual(saved_hold["estado"], "pendente")
        self.assertEqual(row["pendencia_id"], saved_hold["id"])

    def test_resolving_one_missing_file_hold_preserves_other_manual_holds(self):
        make_endpoint_with_users(self.endpoint, [("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "")])
        self.assertTrue(main.load_database())
        self._save("SN-1", "joao")
        self._save("SN-2", "maria")
        rows = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "davi")])["mudancas_usuarios"]
        first = next(row for row in rows if row["serie"] == "SN-1")
        self.manual_users.unlink()

        self._resolve(first, "permitir")
        self.assertFalse(self.manual_users.exists())
        self.assertTrue(main.load_database())
        first_equipment = inventory_state.equipamentos_cache["SN-1"]
        second_equipment = inventory_state.equipamentos_cache["SN-2"]
        self.assertEqual((first_equipment["usuarios_logados"], first_equipment["usuarios_logados_origem"]), ("carla", "endpoint"))
        self.assertEqual((second_equipment["usuarios_logados"], second_equipment["usuarios_logados_origem"],
                          second_equipment["usuarios_logados_pendencia"]), ("maria", "manual", "substituicao_pendente"))

    def test_user_missing_from_the_endpoint_can_be_kept_and_is_not_asked_again(self):
        [row] = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "")])["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["usuario_anterior"]), ("ausente_pendente", "ana"))
        kept = self._resolve(row, "manter")
        self.assertEqual((kept["equipamento"]["usuarios_logados"], kept["equipamento"]["usuarios_logados_pendencia"]), ("ana", ""))
        self.assertEqual(self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "")])["mudancas_usuarios"], [])
        self.assertEqual(inventory_state.equipamentos_cache["SN-2"]["usuarios_logados"], "ana")
        # Quando o Endpoint volta a informar um usuário, ele vale normalmente.
        [changed] = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "bia")])["mudancas_usuarios"]
        self.assertEqual((changed["tipo"], changed["usuario_anterior"], changed["usuario_novo"]), ("alterado_endpoint", "ana", "bia"))

    def test_undoing_the_archive_is_refused_while_the_endpoint_has_a_user(self):
        self._save("SN-1", "joao")
        [row] = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])["mudancas_usuarios"]
        self._resolve(row, "permitir")
        with self.assertRaises(DomainError) as raised:
            main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=self._user_events()[-1]["id"]))
        self.assertEqual(raised.exception.status_code, 409)

    def test_summary_lists_changed_endpoint_users_and_holds_the_removed_ones(self):
        result = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "bia")])
        self.assertEqual([(r["tipo"], r["usuario_anterior"], r["usuario_novo"]) for r in result["mudancas_usuarios"]], [
            ("alterado_endpoint", "ana", "bia"),
        ])
        result = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "")])
        [row] = result["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["serie"], row["usuario_anterior"]), ("ausente_pendente", "SN-2", "bia"))
        self.assertNotIn("usuario_manual_arquivado", row)
        self.assertEqual(inventory_state.equipamentos_cache["SN-2"]["usuarios_logados"], "bia")
        self.assertEqual(self._user_events(), [])
        # O mesmo arquivo de novo não gera mudanças nem repete a pergunta.
        self.assertEqual(self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "")])["mudancas_usuarios"], [])

    def test_last_logon_is_shared_by_the_application_and_user_change_comparison(self):
        result = self._submit([
            ("SN-1", "HOST-1", "usuario.grade", "usuario.ultimo_logon"),
            ("SN-2", "HOST-2", "ana", ""),
        ])

        [change] = [row for row in result["mudancas_usuarios"] if row["serie"] == "SN-1"]
        self.assertEqual(change["usuario_novo"], "usuario.ultimo_logon")
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["usuarios_logados"], "usuario.ultimo_logon")

    def test_manual_legacy_workbook_without_last_logon_still_uses_logged_users(self):
        result = self._submit([
            ("SN-1", "HOST-1", "usuario.legado"),
            ("SN-2", "HOST-2", "ana"),
        ])

        [change] = [row for row in result["mudancas_usuarios"] if row["serie"] == "SN-1"]
        self.assertEqual(change["usuario_novo"], "usuario.legado")
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["usuarios_logados"], "usuario.legado")

    def test_hidden_legacy_manual_user_comes_back_only_after_the_removal_is_confirmed(self):
        # Manual gravado antes do arquivamento existir, escondido pelo usuário do Endpoint.
        self.manual_users.write_text(json.dumps({"SN-2": "velho"}), encoding="utf-8")
        self.assertTrue(main.load_database())
        [row] = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "")])["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["usuario_anterior"]), ("ausente_pendente", "ana"))
        self.assertEqual(inventory_state.equipamentos_cache["SN-2"]["usuarios_logados"], "ana")
        back = self._resolve(row, "remover")["equipamento"]
        self.assertEqual((back["usuarios_logados"], back["usuarios_logados_origem"]), ("velho", "manual"))

    def test_macbook_manual_user_waits_for_a_decision_when_the_endpoint_serial_without_s_gets_a_user(self):
        details = [
            ("SN-1", "ALIAS-1", "Modelo A", "Maringá", "Notebook", "87000000"),
            ("SCXC9F072K1", "PRMACUMC005", "MacBook Air", "Maringá", "Notebook", "87000000"),
        ]
        make_details(self.details, details)
        make_endpoint_with_users(self.endpoint, [("SN-1", "HOST-1", ""), ("CXC9F072K1", "PRMACUMC005", "")])
        self.assertTrue(main.load_database())
        self._save("SCXC9F072K1", "mac-manual")
        result = self._submit([("SN-1", "HOST-1", ""), ("CXC9F072K1", "PRMACUMC005", "DDrodrigues")], details)
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {"SCXC9F072K1": "mac-manual"})
        [row] = result["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["serie"], row["usuario_novo"]), ("substituicao_pendente", "SCXC9F072K1", "DDrodrigues"))
        self._resolve(row, "permitir")
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {})
        self.assertEqual(self._user_events()[-1]["serial"], "SCXC9F072K1")

    def test_new_endpoint_file_without_user_or_host_leaves_a_warning_once(self):
        new_endpoint = io.BytesIO()
        make_endpoint_with_users(self.endpoint.with_name("novo.xlsx"), [("SN-1", "HOST-1", "")])
        new_bytes = self.endpoint.with_name("novo.xlsx").read_bytes()
        details_bytes = _details_bytes([
            ("SN-1", "ALIAS-1", "Modelo A", "Maringá", "Notebook", "87000000"),
            ("SN-2", "ALIAS-2", "Modelo B", "Maringá", "Notebook", "87000000"),
        ])
        del new_endpoint
        from starlette.datastructures import UploadFile
        import asyncio

        def submit(key):
            return asyncio.run(main.update_inventory_files(
                UploadFile(filename="InvAll.xlsx", file=io.BytesIO(new_bytes)),
                UploadFile(filename="Detalhes.xlsx", file=io.BytesIO(details_bytes)),
                services=main._inventory_update_services,
                idempotency_key=key,
            ))

        submit("aviso-1")
        warnings = [e for e in json.loads(self.history.read_text(encoding="utf-8")) if e["tipo"] == "aviso_endpoint"]
        self.assertEqual({(w["serial"], w["motivo"]) for w in warnings}, {("SN-2", "usuario_removido"), ("SN-2", "hostname_removido")})
        self.assertEqual({w["valor_anterior"] for w in warnings}, {"ana", "HOST-2"})

        # Reprocessar o mesmo arquivo não duplica avisos (o antigo já não existe no Endpoint ativo).
        submit("aviso-2")
        again = [e for e in json.loads(self.history.read_text(encoding="utf-8")) if e["tipo"] == "aviso_endpoint"]
        self.assertEqual(len(again), len(warnings))

        dismissed = main.excluir_evento_historico_apelido(warnings[0]["id"])
        self.assertEqual(dismissed["tipo"], "aviso_endpoint")
        left = [e for e in json.loads(self.history.read_text(encoding="utf-8")) if e["tipo"] == "aviso_endpoint"]
        self.assertEqual(len(left), len(warnings) - 1)


if __name__ == "__main__":
    unittest.main()
