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
from core.errors import DomainError
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
    worksheet.append(["ROTULODESERVICONUMERODESERIE", "NOMEDOCOMPUTADOR", "USUARIOSLOGADOS"])
    for row in rows:
        worksheet.append(list(row))
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


class ManualUserWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".manual-user-test-", dir=base.PROJECT_ROOT)
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
        event = json.loads(self.history.read_text(encoding="utf-8"))[-1]
        self.assertEqual((event["tipo"], event["usuario_anterior"], event["usuario_novo"]), ("usuario", "", "joao"))

        # Sobrevive a uma nova carga da base e entra na busca.
        self.assertTrue(main.load_database())
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["usuarios_logados"], "joao")
        self.assertEqual([r["serial"] for r in search_index(inventory_state.equipment_search_index, "JOAO")], ["SN-1"])

        undone = main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=event["id"]))
        self.assertEqual(undone["equipamento"]["usuarios_logados"], "")
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {})
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8"))[-1]["acao"], "desfazer")

    def test_lookup_for_comparison_rows_follows_the_home_rule(self):
        from routers.aliases import UsuariosConsultaPayload

        def lookup():
            return main.consultar_usuarios_logados(UsuariosConsultaPayload(series=["SN-1", "sn2", "SN-9", ""]))["usuarios"]

        self.assertEqual(lookup(), {
            "SN-1": {"usuario": "", "origem": "", "serial_cadastro": "SN-1"},
            "sn2": {"usuario": "ana", "origem": "endpoint", "serial_cadastro": "SN-2"},
            "SN-9": {"usuario": "", "origem": "", "serial_cadastro": None},
        })
        self._save("SN-1", "joao")
        self.assertEqual(lookup()["SN-1"], {"usuario": "joao", "origem": "manual", "serial_cadastro": "SN-1"})

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
        expected = {"usuario": "DDrodrigues", "origem": "endpoint", "serial_cadastro": "SCXC9F072K1"}
        self.assertEqual(found, {"SCXC9F072K1": expected, "CXC9F072K1": expected})
        with self.assertRaises(DomainError) as raised:
            self._save("SCXC9F072K1", "outro")
        self.assertEqual(raised.exception.status_code, 409)

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

    def test_endpoint_user_archives_the_manual_one_and_it_does_not_come_back_alone(self):
        self._save("SN-1", "joao")
        result = self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {})
        archived = self._user_events()[-1]
        self.assertEqual(
            (archived["acao"], archived["usuario_anterior"], archived["usuario_novo"], archived["usuario_endpoint"]),
            ("arquivado_endpoint", "joao", "", "carla"),
        )
        [row] = result["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["serie"], row["usuario_anterior"], row["usuario_novo"]), ("novo_endpoint", "SN-1", "joao", "carla"))
        self.assertEqual(row["usuario_manual_arquivado"], "joao")
        self.assertTrue(row["anotacao_id"])
        saved = json.loads(self.comparison_history.read_text(encoding="utf-8"))[-1]
        self.assertEqual(saved["resumo"]["mudancas_usuarios"], 1)
        self.assertEqual(saved["comparacao"]["mudancas_usuarios"][0]["tipo"], "novo_endpoint")

        # Endpoint esvazia: o manual antigo não reaparece sozinho, só é sugerido para restauração.
        result = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "ana")])
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["usuarios_logados"], "")
        [row] = result["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["usuario_anterior"], row["usuario_novo"]), ("removido_endpoint", "carla", ""))
        self.assertEqual(row["usuario_manual_arquivado"], "joao")

        # Desfazer o arquivamento no histórico de alterações devolve o manual.
        undone = main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=archived["id"]))
        self.assertEqual((undone["equipamento"]["usuarios_logados"], undone["equipamento"]["usuarios_logados_origem"]), ("joao", "manual"))

    def test_undoing_the_archive_is_refused_while_the_endpoint_has_a_user(self):
        self._save("SN-1", "joao")
        self._submit([("SN-1", "HOST-1", "carla"), ("SN-2", "HOST-2", "ana")])
        with self.assertRaises(DomainError) as raised:
            main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=self._user_events()[-1]["id"]))
        self.assertEqual(raised.exception.status_code, 409)

    def test_summary_lists_changed_and_removed_endpoint_users_without_manual(self):
        result = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "bia")])
        self.assertEqual([(r["tipo"], r["usuario_anterior"], r["usuario_novo"]) for r in result["mudancas_usuarios"]], [
            ("alterado_endpoint", "ana", "bia"),
        ])
        result = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "")])
        [row] = result["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["serie"], row["usuario_anterior"]), ("removido_endpoint", "SN-2", "bia"))
        self.assertNotIn("usuario_manual_arquivado", row)
        self.assertEqual(self._user_events(), [])
        # O mesmo arquivo de novo não gera mudanças.
        self.assertEqual(self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "")])["mudancas_usuarios"], [])

    def test_hidden_legacy_manual_user_is_flagged_when_it_comes_back(self):
        # Manual gravado antes do arquivamento existir, escondido pelo usuário do Endpoint.
        self.manual_users.write_text(json.dumps({"SN-2": "velho"}), encoding="utf-8")
        self.assertTrue(main.load_database())
        result = self._submit([("SN-1", "HOST-1", ""), ("SN-2", "HOST-2", "")])
        [row] = result["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["usuario_novo"], row["origem_nova"]), ("manual_voltou", "velho", "manual"))

    def test_macbook_manual_user_is_archived_when_the_endpoint_serial_without_s_gets_a_user(self):
        details = [
            ("SN-1", "ALIAS-1", "Modelo A", "Maringá", "Notebook", "87000000"),
            ("SCXC9F072K1", "PRMACUMC005", "MacBook Air", "Maringá", "Notebook", "87000000"),
        ]
        make_details(self.details, details)
        make_endpoint_with_users(self.endpoint, [("SN-1", "HOST-1", ""), ("CXC9F072K1", "PRMACUMC005", "")])
        self.assertTrue(main.load_database())
        self._save("SCXC9F072K1", "mac-manual")
        result = self._submit([("SN-1", "HOST-1", ""), ("CXC9F072K1", "PRMACUMC005", "DDrodrigues")], details)
        self.assertEqual(json.loads(self.manual_users.read_text(encoding="utf-8")), {})
        [row] = result["mudancas_usuarios"]
        self.assertEqual((row["tipo"], row["serie"], row["usuario_novo"], row["usuario_manual_arquivado"]),
                         ("novo_endpoint", "SCXC9F072K1", "DDrodrigues", "mac-manual"))
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
