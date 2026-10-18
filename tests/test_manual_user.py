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
from domains.user_changes import build_endpoint_warning_entries
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
