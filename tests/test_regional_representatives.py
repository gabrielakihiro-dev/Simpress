"""Regional representatives: per-city overrides in a git-ignored local file; the defaults live only in the backend."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core import config as app_config
from domains import local_setup
from domains.local_setup import REGIONAL_REPRESENTATIVE_CITIES, REGIONAL_REPRESENTATIVE_FIELDS, load_regional_representatives
from routers.local_setup import create_local_setup_router


VALID = {
    "nome": "Representante Fictício", "email": "ficticio@exemplo.invalid", "telefone": "(41) 90000-0001",
    "horario": "08:00:00 às 18:00:00", "almoco": "12:00:00", "pausaDuracao": "1h30",
}
URL = "/api/config/representantes-regionais"


class RegionalRepresentativesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.path = root / "config" / "representantes_regionais.json"
        router, _ = create_local_setup_router(
            model_path=lambda _kind: root / "modelo.xlsx",
            transaction_root=lambda: root,
            backups_directory=lambda: root / "backups",
            max_upload_bytes=lambda: 1024,
            parser_admission=lambda: None,
            export_dependency_paths=lambda: [],
            validate_export=lambda: None,
            regional_representatives_file=lambda: self.path,
        )
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)

    def get_state(self):
        """GET without `padroes` (checked on its own below), so the tests of the saved changes stay focused."""
        body = self.client.get(URL).json()
        body.pop("padroes")
        return body

    def test_missing_file_means_no_changes(self):
        self.assertEqual(self.get_state(), {"alteracoes": {}, "arquivo_invalido": False})

    def test_get_returns_the_22_defaults_with_their_six_fields_in_display_order(self):
        padroes = self.client.get(URL).json()["padroes"]
        self.assertEqual(len(padroes), 22)
        self.assertEqual(tuple(item["cidade"] for item in padroes), REGIONAL_REPRESENTATIVE_CITIES)
        for item in padroes:
            self.assertTrue(set(REGIONAL_REPRESENTATIVE_FIELDS) <= set(item), item["cidade"])
            self.assertTrue(set(item) - {"cidade", *REGIONAL_REPRESENTATIVE_FIELDS} <= {"nomeOpcao"}, item["cidade"])
        londrina = next(item for item in padroes if item["cidade"] == "Londrina")
        self.assertEqual(londrina["nome"], "Renata Custodio de Oliveira Varasquim")
        self.assertEqual(londrina["telefone"], "(43) 99643-8754")
        arapongas = next(item for item in padroes if item["cidade"] == "Arapongas")
        self.assertEqual((arapongas["nome"], arapongas["nomeOpcao"]), ("", "Não definido ainda"))
        # A saved change never alters the defaults; PUT/DELETE answer with the changes only.
        response = self.client.put(f"{URL}/Londrina", json=VALID)
        self.assertNotIn("padroes", response.json())
        self.assertEqual(self.client.get(URL).json()["padroes"], padroes)

    def test_corrupted_or_non_object_file_is_reported_without_breaking(self):
        self.path.parent.mkdir(parents=True)
        for content in ("{não é json", "[1, 2]"):
            self.path.write_text(content, encoding="utf-8")
            with self.assertLogs("domains.local_setup", level="WARNING"):
                response = self.client.get(URL)
            self.assertEqual(response.json()["alteracoes"], {})
            self.assertTrue(response.json()["arquivo_invalido"])
            self.assertEqual(len(response.json()["padroes"]), 22)

    def test_unknown_cities_and_non_object_entries_in_the_file_are_ignored(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"Londrina": VALID, "Atlântida": VALID, "Cascavel": 5}), encoding="utf-8")
        self.assertEqual(load_regional_representatives(self.path), ({"Londrina": VALID}, False))

    def test_save_is_returned_by_get_keeps_other_cities_and_restore_removes_it(self):
        self.assertEqual(self.client.put(f"{URL}/Maringá", json=VALID).status_code, 200)
        other = {**VALID, "nome": "  Outra Pessoa  ", "email": "", "telefone": "", "almoco": "Escritório não fecha", "pausaDuracao": ""}
        response = self.client.put(f"{URL}/Foz do Igua%C3%A7u", json=other)
        self.assertEqual(response.status_code, 200, response.text)
        expected = {
            "Maringá": {k: VALID[k] for k in ("nome", "email", "telefone", "almoco", "pausaDuracao")},  # horario equals the default
            "Foz do Iguaçu": {"nome": "Outra Pessoa", "email": "", "horario": "08:00:00 às 18:00:00", "almoco": "Escritório não fecha", "pausaDuracao": ""},
        }
        self.assertEqual(self.get_state(), {"alteracoes": expected, "arquivo_invalido": False})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), expected)

        response = self.client.delete(f"{URL}/Maring%C3%A1")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(list(response.json()["alteracoes"]), ["Foz do Iguaçu"])
        self.assertEqual(self.client.delete(f"{URL}/Maringá").status_code, 404)

    def test_only_fields_that_differ_from_the_default_are_saved_and_equal_to_default_removes_the_city(self):
        londrina = local_setup.REGIONAL_REPRESENTATIVE_DEFAULTS["Londrina"]
        # Equal to the default and nothing saved: no file is created, the route still answers like before.
        response = self.client.put(f"{URL}/Londrina", json=londrina)
        self.assertEqual((response.status_code, response.json()), (200, {"alteracoes": {}, "arquivo_invalido": False}))
        self.assertFalse(self.path.exists())

        response = self.client.put(f"{URL}/Londrina", json={**londrina, "nome": "Pessoa Fictícia", "telefone": ""})
        self.assertEqual(response.json()["alteracoes"], {"Londrina": {"nome": "Pessoa Fictícia", "telefone": ""}})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), {"Londrina": {"nome": "Pessoa Fictícia", "telefone": ""}})
        self.client.put(f"{URL}/Maringá", json=VALID)

        # Changing a field back to the default drops only that field; changing all of them drops the city.
        response = self.client.put(f"{URL}/Londrina", json={**londrina, "telefone": ""})
        self.assertEqual(response.json()["alteracoes"]["Londrina"], {"telefone": ""})
        response = self.client.put(f"{URL}/Londrina", json=londrina)
        self.assertEqual(list(response.json()["alteracoes"]), ["Maringá"])
        self.assertEqual(list(json.loads(self.path.read_text(encoding="utf-8"))), ["Maringá"])
        self.assertEqual(self.client.delete(f"{URL}/Londrina").status_code, 404)  # nothing left to restore
        self.assertNotIn(b"\r", self.path.read_bytes())  # LF only

    def test_delete_without_saved_change_is_404_and_writes_nothing(self):
        self.assertEqual(self.client.delete(f"{URL}/Londrina").status_code, 404)
        self.assertFalse(self.path.exists())

    def test_unknown_city_is_404_for_put_and_delete(self):
        self.assertEqual(self.client.put(f"{URL}/Atlântida", json=VALID).status_code, 404)
        self.assertEqual(self.client.delete(f"{URL}/Atlântida").status_code, 404)
        self.assertFalse(self.path.exists())

    def test_invalid_values_are_rejected_in_portuguese_without_writing(self):
        invalid = {
            "email": "sem-arroba", "telefone": "123", "horario": "8h às 18h",
            "almoco": "meio-dia", "pausaDuracao": "uma hora", "nome": "x" * 161,
        }
        for field, value in invalid.items():
            with self.subTest(field=field):
                response = self.client.put(f"{URL}/Londrina", json={**VALID, field: value})
                self.assertEqual(response.status_code, 422, response.text)
        message = self.client.put(f"{URL}/Londrina", json={**VALID, "horario": "8h"}).json()["detail"][0]["msg"]
        self.assertIn("Informe o expediente", message)
        self.assertFalse(self.path.exists())

    def test_impossible_times_are_rejected_in_portuguese_without_writing(self):
        invalid = {
            "horario": ("99:99:99 às 99:99:99", "08:00:00 às 25:00:00", "08:60:00 às 18:00:00", "08:00:00 às 18:00:60"),
            "almoco": ("99:99:99", "24:00:00", "12:60:00"),
            "pausaDuracao": ("1h99", "1h60"),
        }
        for field, values in invalid.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    response = self.client.put(f"{URL}/Londrina", json={**VALID, field: value})
                    self.assertEqual(response.status_code, 422, response.text)
        message = self.client.put(f"{URL}/Londrina", json={**VALID, "horario": "99:99:99 às 99:99:99"}).json()["detail"][0]["msg"]
        self.assertIn("Informe o expediente no formato 08:00:00 às 18:00:00.", message)
        self.assertFalse(self.path.exists())
        for field, value in {"horario": "00:00:00 às 23:59:59", "almoco": "23:59:59", "pausaDuracao": "0h59"}.items():
            self.assertEqual(self.client.put(f"{URL}/Londrina", json={**VALID, field: value}).status_code, 200, field)

    def test_schedule_must_start_before_it_ends(self):
        for value in ("20:00:00 às 08:00:00", "18:00:00 às 18:00:00", "00:00:00 às 00:00:00", "08:00:01 às 08:00:00"):
            with self.subTest(value=value):
                response = self.client.put(f"{URL}/Londrina", json={**VALID, "horario": value})
                self.assertEqual(response.status_code, 422, response.text)
                self.assertIn("começar antes de terminar", response.json()["detail"][0]["msg"])
        self.assertFalse(self.path.exists())
        for value in ("08:00:00 às 18:00:00", "08:00:00 às 08:00:01", "00:00:00 às 23:59:59"):
            with self.subTest(value=value):
                self.assertEqual(self.client.put(f"{URL}/Londrina", json={**VALID, "horario": value}).status_code, 200)
        saved = self.path.read_text(encoding="utf-8")
        self.assertEqual(self.client.put(f"{URL}/Londrina", json={**VALID, "horario": "20:00:00 às 08:00:00"}).status_code, 422)
        self.assertEqual(self.path.read_text(encoding="utf-8"), saved)

    def test_disk_failure_is_500_with_message_and_no_personal_data_in_logs(self):
        with patch.object(local_setup, "atomic_write_json", side_effect=OSError("disco cheio")):
            with self.assertLogs("routers.local_setup", level="WARNING") as logs:
                response = self.client.put(f"{URL}/Londrina", json=VALID)
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Não foi possível gravar o representante regional.")
        for private in (VALID["nome"], VALID["email"], VALID["telefone"]):
            self.assertNotIn(private, "\n".join(logs.output))

    def test_local_file_is_git_ignored(self):
        self.assertEqual(app_config.REGIONAL_REPRESENTATIVES_FILE, app_config.BASE_DIR / "config" / "representantes_regionais.json")
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", "config/representantes_regionais.json"],
            cwd=app_config.BASE_DIR, check=False,
        )
        self.assertEqual(ignored.returncode, 0)


if __name__ == "__main__":
    unittest.main()
