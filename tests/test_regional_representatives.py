"""Regional representatives: per-city overrides in a git-ignored local file; defaults stay in the front end."""

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core import config as app_config
from domains import local_setup
from domains.local_setup import REGIONAL_REPRESENTATIVE_CITIES, load_regional_representatives
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

    def test_missing_file_means_no_changes(self):
        self.assertEqual(self.client.get(URL).json(), {"alteracoes": {}, "arquivo_invalido": False})

    def test_corrupted_or_non_object_file_is_reported_without_breaking(self):
        self.path.parent.mkdir(parents=True)
        for content in ("{não é json", "[1, 2]"):
            self.path.write_text(content, encoding="utf-8")
            with self.assertLogs("domains.local_setup", level="WARNING"):
                response = self.client.get(URL)
            self.assertEqual(response.json(), {"alteracoes": {}, "arquivo_invalido": True})

    def test_unknown_cities_and_non_object_entries_in_the_file_are_ignored(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"Londrina": VALID, "Atlântida": VALID, "Cascavel": 5}), encoding="utf-8")
        self.assertEqual(load_regional_representatives(self.path), ({"Londrina": VALID}, False))

    def test_save_is_returned_by_get_keeps_other_cities_and_restore_removes_it(self):
        self.assertEqual(self.client.put(f"{URL}/Maringá", json=VALID).status_code, 200)
        other = {**VALID, "nome": "  Outra Pessoa  ", "email": "", "telefone": "", "almoco": "Escritório não fecha", "pausaDuracao": ""}
        response = self.client.put(f"{URL}/Foz do Igua%C3%A7u", json=other)
        self.assertEqual(response.status_code, 200, response.text)
        expected = {"Maringá": VALID, "Foz do Iguaçu": {**other, "nome": "Outra Pessoa"}}
        self.assertEqual(self.client.get(URL).json(), {"alteracoes": expected, "arquivo_invalido": False})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), expected)

        response = self.client.delete(f"{URL}/Maring%C3%A1")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(list(response.json()["alteracoes"]), ["Foz do Iguaçu"])
        self.assertEqual(self.client.delete(f"{URL}/Maringá").status_code, 404)

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

    def test_disk_failure_is_500_with_message_and_no_personal_data_in_logs(self):
        with patch.object(local_setup, "atomic_write_json", side_effect=OSError("disco cheio")):
            with self.assertLogs("routers.local_setup", level="WARNING") as logs:
                response = self.client.put(f"{URL}/Londrina", json=VALID)
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Não foi possível gravar o representante regional.")
        for private in (VALID["nome"], VALID["email"], VALID["telefone"]):
            self.assertNotIn(private, "\n".join(logs.output))

    def test_local_file_is_git_ignored_and_city_list_mirrors_the_front_end(self):
        self.assertEqual(app_config.REGIONAL_REPRESENTATIVES_FILE, app_config.BASE_DIR / "config" / "representantes_regionais.json")
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", "config/representantes_regionais.json"],
            cwd=app_config.BASE_DIR, check=False,
        )
        self.assertEqual(ignored.returncode, 0)
        source = (app_config.BASE_DIR / "static" / "js" / "features" / "regional-contacts.js").read_text(encoding="utf-8")
        block = source.split("const REPRESENTANTES_REGIONAIS_PR = [", 1)[1].split("];", 1)[0]
        self.assertEqual(tuple(re.findall(r'\{ cidade: "([^"]+)"', block)), REGIONAL_REPRESENTATIVE_CITIES)


if __name__ == "__main__":
    unittest.main()
