"""Pontos de integração dos nomes do Entra: rotas, histórico, exportação e salvamento manual."""

import io
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
import openpyxl

with patch("openpyxl.load_workbook", side_effect=RuntimeError("testes não acessam planilhas locais")):
    with patch("sys.stdout", new_callable=io.StringIO):
        import main

from domains import alias_changes, entra_users
from domains.history_export import _export_change_user, _export_user
from routers.entra_users import EntraUserServices, create_entra_users_router
from routers.transfer_history import TransferHistoryServices, create_transfer_history_router

DIRECTORY = {"users": {"ana.lima": "Ana Lima"}}


class TransferHistoryPersonNameTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.file = self.root / "historico_transferencias.json"
        self.stored = [
            {"id": "a", "serial": "AAA111", "entrega_cidade": "Londrina"},
            {"id": "b", "serial": "BBB222", "entrega_cidade": "Maringá"},
        ]
        self.file.write_text(json.dumps(self.stored), encoding="utf-8")

    def client(self, person_names):
        router, _ = create_transfer_history_router(TransferHistoryServices(
            history_file=lambda: self.file, transaction_root=lambda: self.root, person_names=person_names,
        ))
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        self.addCleanup(client.close)
        return client

    def test_listing_adds_name_by_serial_without_touching_stored_file(self):
        before = self.file.read_text(encoding="utf-8")
        calls = []

        def person_names(series):
            calls.append(series)
            return {"AAA111": "Ana Lima", "BBB222": ""}

        items = self.client(person_names).get("/api/historico-transferencias").json()["itens"]
        by_serial = {item["serial"]: item for item in items}
        self.assertEqual(by_serial["AAA111"]["nome_pessoa"], "Ana Lima")
        self.assertNotIn("nome_pessoa", by_serial["BBB222"])
        self.assertEqual(calls, [["AAA111", "BBB222"]])
        self.assertEqual(self.file.read_text(encoding="utf-8"), before)

    def test_failing_name_lookup_does_not_break_listing(self):
        def person_names(series):
            raise RuntimeError("falha simulada")

        response = self.client(person_names).get("/api/historico-transferencias")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total"], 2)
        self.assertTrue(all("nome_pessoa" not in item for item in response.json()["itens"]))


class AliasHistoryPersonNameTests(unittest.TestCase):
    def services(self, history, index=None, fail=False):
        def read_index():
            if fail:
                raise RuntimeError("índice indisponível")
            return index if index is not None else {"entra_directory": DIRECTORY}

        return SimpleNamespace(load_alias_history=lambda: history, read_endpoint_alias_index=read_index)

    def test_user_events_get_names_on_copies_only(self):
        history = [
            {"id": "1", "tipo": "apelido", "serial": "AAA111"},
            {"id": "2", "tipo": "usuario", "usuario_anterior": "ana.lima", "usuario_novo": "sem.cadastro"},
        ]
        snapshot = deepcopy(history)
        listing = alias_changes.alias_history_listing(self.services(history))
        self.assertEqual(listing["total"], 2)
        user_event, alias_event = listing["eventos"]
        self.assertEqual(user_event["nome_pessoa_anterior"], "Ana Lima")
        self.assertEqual(user_event["nome_pessoa_novo"], "")
        self.assertNotIn("nome_pessoa_anterior", alias_event)
        self.assertEqual(history, snapshot)

    def test_unreadable_index_returns_events_unchanged(self):
        history = [{"id": "2", "tipo": "usuario", "usuario_anterior": "ana.lima", "usuario_novo": ""}]
        listing = alias_changes.alias_history_listing(self.services(history, fail=True))
        self.assertEqual(listing["eventos"], history)


class HistoryExportPersonNameTests(unittest.TestCase):
    def test_change_user_appends_name_only_when_there_is_user_and_name(self):
        self.assertEqual(_export_change_user("ana.lima", "endpoint", "Ana Lima"), "ana.lima — Ana Lima")
        self.assertEqual(_export_change_user("ana.lima", "manual", "Ana Lima"), "ana.lima (M) — Ana Lima")
        self.assertEqual(_export_change_user("ana.lima", "endpoint", ""), "ana.lima")
        self.assertEqual(_export_change_user("", "endpoint", "Ana Lima"), "")

    def test_series_user_appends_name_and_keeps_origin(self):
        users = {
            "AAA111": {"usuario": "ana.lima", "nome_pessoa": "Ana Lima", "origem": "endpoint"},
            "BBB222": {"usuario": "bia", "origem": "manual"},
        }
        self.assertEqual(_export_user(users, "AAA111"), ("ana.lima — Ana Lima", "Endpoint"))
        self.assertEqual(_export_user(users, "BBB222"), ("bia", "Manual"))
        self.assertEqual(_export_user(users, "CCC333"), ("", ""))


class EntraRoutesTests(unittest.TestCase):
    def setUp(self):
        self.imported: list[bytes] = []
        self.saved: list[tuple[str, str, str]] = []
        self.export: bytes | None = b"xlsx"

        def import_csv(content):
            self.imported.append(content)
            if content == b"invalido":
                raise entra_users.EntraImportError("CSV inválido de teste.")
            return {"users": 1}

        def export_xlsx():
            if self.export is None:
                raise ValueError("Importe um CSV do Entra primeiro.")
            return self.export

        def save_manual_name(serial, login, nome):
            self.saved.append((serial, login, nome))
            return {"equipamento": {"serial": serial, "nome_pessoa": nome}}

        app = FastAPI()
        app.include_router(create_entra_users_router(EntraUserServices(
            import_csv=import_csv,
            status=lambda: {"users": 1, "updated_at": "2026-01-01"},
            export_xlsx=export_xlsx,
            save_manual_name=save_manual_name,
        )))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def upload(self, filename, content):
        return self.client.post("/api/usuarios-entra/importar", files={"file": (filename, content, "text/csv")})

    def test_status_returns_service_payload(self):
        response = self.client.get("/api/usuarios-entra/estado")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"users": 1, "updated_at": "2026-01-01"})

    def test_import_accepts_csv_and_passes_bytes(self):
        response = self.upload("Entra.CSV", b"a,b")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"users": 1})
        self.assertEqual(self.imported, [b"a,b"])

    def test_import_rejects_non_csv_before_calling_service(self):
        response = self.upload("entra.xlsx", b"a,b")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.imported, [])

    def test_import_maps_invalid_content_to_422(self):
        response = self.upload("entra.csv", b"invalido")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "CSV inválido de teste.")

    def test_export_returns_xlsx_attachment_or_404(self):
        response = self.client.get("/api/usuarios-entra/exportar")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"xlsx")
        self.assertIn("spreadsheetml.sheet", response.headers["content-type"])
        self.assertIn("Nomes_Entra_PR.xlsx", response.headers["content-disposition"])
        self.export = None
        self.assertEqual(self.client.get("/api/usuarios-entra/exportar").status_code, 404)

    def test_manual_name_passes_payload_and_validates_size(self):
        body = {"serial": "AAA111", "login_atual": "ana.lima", "nome": "Ana Lima"}
        response = self.client.post("/api/equipamento/nome-pessoa", json=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.saved, [("AAA111", "ana.lima", "Ana Lima")])
        too_long = {**body, "nome": "x" * (entra_users.MAX_NAME_LENGTH + 1)}
        self.assertEqual(self.client.post("/api/equipamento/nome-pessoa", json=too_long).status_code, 422)
        self.assertEqual(len(self.saved), 1)

    def test_real_export_service_generates_readable_workbook(self):
        data = entra_users.export_xlsx({"users": {"ana.lima": "=Ana"}})
        sheet = openpyxl.load_workbook(io.BytesIO(data)).active
        self.assertEqual([cell.value for cell in sheet[2]], ["ana.lima", "=Ana"])
        self.assertEqual(sheet["B2"].data_type, "s")


class SavePersonNameTests(unittest.TestCase):
    """`main._save_person_name` through the real router, with an in-memory inventory."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.names_file = Path(temp.name) / "nomes_manuais.json"
        self.cache = {
            "AAA111": {"serial": "AAA111", "usuarios_logados": "ana.lima", "nome_pessoa_editavel": True},
            "BBB222": {"serial": "BBB222", "usuarios_logados": "bia", "nome_pessoa_editavel": False},
        }
        self.refreshed: list[bool] = []

        def refresh(*args, **kwargs):
            self.refreshed.append(True)
            entry = entra_users.read_manual_names(self.names_file).get("AAA111")
            if entry:
                self.cache["AAA111"]["nome_pessoa"] = entry["nome"]
            return True

        for target in (
            patch.object(main, "MANUAL_PERSON_NAMES_FILE", self.names_file),
            patch.object(main.inventory_state, "equipamentos_cache", self.cache),
            patch.object(main, "load_database", refresh),
        ):
            target.start()
            self.addCleanup(target.stop)
        app = FastAPI()
        app.include_router(create_entra_users_router(EntraUserServices(
            import_csv=lambda content: {}, status=lambda: {}, export_xlsx=lambda: b"",
            save_manual_name=main._save_person_name,
        )))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def save(self, serial="AAA111", login="ana.lima", nome="Ana Lima"):
        return self.client.post("/api/equipamento/nome-pessoa", json={"serial": serial, "login_atual": login, "nome": nome})

    def test_success_saves_name_refreshes_base_and_returns_equipment(self):
        response = self.save(serial="aaa-111")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["equipamento"]["nome_pessoa"], "Ana Lima")
        self.assertEqual(entra_users.read_manual_names(self.names_file)["AAA111"],
                         {"login": "ana.lima", "nome": "Ana Lima"})
        self.assertEqual(self.refreshed, [True])
        self.assertIs(response.json()["base_atualizada"], True)

    def test_failed_refresh_still_returns_saved_name_and_flags_stale_base(self):
        for outcome in (RuntimeError("falha simulada"), False):
            with self.subTest(outcome=outcome):
                def refresh(*args, **kwargs):
                    if isinstance(outcome, Exception):
                        raise outcome
                    return outcome

                with patch.object(main, "load_database", refresh):
                    response = self.save(nome="Ana Lima")
                self.assertEqual(response.status_code, 200)
                body = response.json()
                self.assertIs(body["base_atualizada"], False)
                self.assertEqual(body["equipamento"]["nome_pessoa"], "Ana Lima")
                self.assertEqual(body["equipamento"]["nome_pessoa_origem"], "manual")
                self.assertTrue(body["equipamento"]["nome_pessoa_editavel"])
                self.assertEqual(entra_users.read_manual_names(self.names_file)["AAA111"],
                                 {"login": "ana.lima", "nome": "Ana Lima"})

    def test_failed_refresh_on_removal_returns_empty_name(self):
        entra_users.save_manual_name(self.names_file, "AAA111", "ana.lima", "Ana Lima")
        self.cache["AAA111"].update(nome_pessoa="Ana Lima", nome_pessoa_origem="manual")
        with patch.object(main, "load_database", side_effect=RuntimeError("falha simulada")):
            response = self.save(nome="")
        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertIs(body["base_atualizada"], False)
        self.assertEqual((body["equipamento"]["nome_pessoa"], body["equipamento"]["nome_pessoa_origem"]), ("", ""))
        self.assertNotIn("AAA111", entra_users.read_manual_names(self.names_file))

    def test_unknown_serial_is_404(self):
        self.assertEqual(self.save(serial="ZZZ999").status_code, 404)
        self.assertFalse(self.names_file.exists())

    def test_entra_or_non_editable_name_is_409(self):
        response = self.save(serial="BBB222", login="bia")
        self.assertEqual(response.status_code, 409)
        self.assertFalse(self.names_file.exists())

    def test_changed_login_is_409(self):
        response = self.save(login="outra.pessoa")
        self.assertEqual(response.status_code, 409)
        self.assertFalse(self.names_file.exists())

    def test_equipment_without_valid_login_is_409(self):
        self.cache["AAA111"]["usuarios_logados"] = ""
        self.assertEqual(self.save(login="").status_code, 409)
        self.assertFalse(self.names_file.exists())
        self.assertEqual(self.refreshed, [])

    def test_invalid_name_is_422(self):
        self.assertEqual(self.save(nome="Ana\x01Lima").status_code, 422)
        self.assertEqual(self.save(nome="x" * (entra_users.MAX_NAME_LENGTH + 1)).status_code, 422)
        self.assertFalse(self.names_file.exists())
        self.assertEqual(self.refreshed, [])


if __name__ == "__main__":
    unittest.main()
