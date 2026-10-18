"""Transfer origin contact: environment, then the git-ignored local file, then empty."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from core import config as app_config
from domains.local_setup import load_origin_contact, save_origin_contact
from routers.local_setup import create_local_setup_router


FIELDS = ("retirada_contato", "retirada_email", "retirada_telefone")
FILE_CONTACT = {"contato": "Contato Arquivo", "email": "arquivo@exemplo.invalid", "telefone": "(41) 90000-0001"}


class OriginContactResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "config" / "contato_origem.json"

    def write(self, value):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def test_without_environment_or_file_every_field_is_empty(self):
        result = load_origin_contact(self.path, environment={})
        self.assertEqual([result[field] for field in FIELDS], ["", "", ""])
        self.assertFalse(result["contato_origem_configurado"])
        self.assertFalse(result["contato_origem_arquivo_invalido"])

    def test_file_fills_fields_and_environment_wins_per_field(self):
        self.write(FILE_CONTACT)
        result = load_origin_contact(self.path, environment={"SIMPRESS_TRANSFER_ORIGIN_EMAIL": " env@exemplo.invalid "})
        self.assertEqual(result["retirada_contato"], "Contato Arquivo")
        self.assertEqual(result["retirada_email"], "env@exemplo.invalid")
        self.assertEqual(result["retirada_telefone"], "(41) 90000-0001")
        self.assertEqual(result["contato_origem_fontes"], {
            "retirada_contato": "arquivo", "retirada_email": "ambiente", "retirada_telefone": "arquivo",
        })
        self.assertTrue(result["contato_origem_configurado"])

    def test_partial_or_unreadable_file_leaves_missing_fields_empty(self):
        self.write({"contato": "Só Nome", "email": 42})
        partial = load_origin_contact(self.path, environment={})
        self.assertEqual(partial["retirada_contato"], "Só Nome")
        self.assertEqual(partial["retirada_email"], "")
        self.assertFalse(partial["contato_origem_configurado"])

        self.path.write_text("{não é json", encoding="utf-8")
        with self.assertLogs("domains.local_setup", level="WARNING"):
            broken = load_origin_contact(self.path, environment={})
        self.assertTrue(broken["contato_origem_arquivo_invalido"])
        self.assertEqual([broken[field] for field in FIELDS], ["", "", ""])

    def test_save_round_trips_through_the_loader(self):
        save_origin_contact(self.path, "Novo Contato", "novo@exemplo.invalid", "(41) 90000-0002")
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(stored, {"contato": "Novo Contato", "email": "novo@exemplo.invalid", "telefone": "(41) 90000-0002"})
        self.assertTrue(load_origin_contact(self.path, environment={})["contato_origem_configurado"])

    def test_versioned_example_is_fictitious_and_local_file_is_ignored(self):
        example = json.loads((app_config.BASE_DIR / "config" / "contato_origem.exemplo.json").read_text(encoding="utf-8"))
        self.assertEqual(set(example), {"contato", "email", "telefone"})
        self.assertTrue(example["email"].endswith(".invalid"))
        self.assertEqual(app_config.TRANSFER_ORIGIN_CONTACT_FILE, app_config.BASE_DIR / "config" / "contato_origem.json")
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", "config/contato_origem.json"],
            cwd=app_config.BASE_DIR, check=False,
        )
        self.assertEqual(ignored.returncode, 0)


class OriginContactRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.path = root / "config" / "contato_origem.json"
        router, _ = create_local_setup_router(
            model_path=lambda _kind: root / "modelo.xlsx",
            transaction_root=lambda: root,
            backups_directory=lambda: root / "backups",
            max_upload_bytes=lambda: 1024,
            parser_admission=lambda: None,
            export_dependency_paths=lambda: [],
            validate_export=lambda: None,
            origin_contact_file=lambda: self.path,
        )
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)
        # Real installation variables must not leak into these assertions.
        environment = patch.dict(os.environ, {})
        environment.start()
        self.addCleanup(environment.stop)
        for variable in ("SIMPRESS_TRANSFER_ORIGIN_CONTACT", "SIMPRESS_TRANSFER_ORIGIN_EMAIL", "SIMPRESS_TRANSFER_ORIGIN_PHONE"):
            os.environ.pop(variable, None)

    def put(self, payload):
        return self.client.put("/api/config/transferencia/contato-origem", json=payload)

    def test_valid_contact_is_saved_and_returned(self):
        response = self.put(FILE_CONTACT)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["contato_origem_configurado"])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["contato"], "Contato Arquivo")

    def test_missing_or_invalid_values_are_rejected_without_writing(self):
        self.assertEqual(self.put({**FILE_CONTACT, "contato": "  "}).status_code, 422)
        self.assertEqual(self.put({**FILE_CONTACT, "email": "sem-arroba"}).status_code, 422)
        self.assertEqual(self.put({**FILE_CONTACT, "telefone": "123"}).status_code, 422)
        self.assertFalse(self.path.exists())

    def test_environment_fields_may_stay_blank_in_the_file(self):
        with patch.dict(os.environ, {"SIMPRESS_TRANSFER_ORIGIN_PHONE": "(41) 90000-0003"}):
            response = self.put({**FILE_CONTACT, "telefone": ""})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["retirada_telefone"], "(41) 90000-0003")
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["telefone"], "")


if __name__ == "__main__":
    unittest.main()
