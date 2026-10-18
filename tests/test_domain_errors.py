import asyncio
import io
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile

import main
from core.errors import DomainBusyError, DomainConflictError, DomainError, DomainValidationError
from domains.inventory_update import update_inventory_files


class DomainErrorClassTests(unittest.TestCase):
    def test_default_status_codes(self):
        self.assertEqual(DomainError("x").status_code, 500)
        self.assertEqual(DomainValidationError("x").status_code, 400)
        self.assertEqual(DomainConflictError("x").status_code, 409)
        self.assertEqual(DomainBusyError("x").status_code, 503)

    def test_explicit_status_and_structured_detail_are_kept(self):
        detail = {"mensagem": "Planilha recusada.", "linhas": [2, 3]}
        error = DomainValidationError(detail, status_code=413)
        self.assertEqual(error.status_code, 413)
        self.assertIs(error.detail, detail)
        self.assertIsInstance(error, DomainError)

    def test_text_matches_http_exception(self):
        self.assertEqual(str(DomainConflictError("Arquivo em uso.")), str(HTTPException(409, "Arquivo em uso.")))


class DomainErrorHandlerTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.add_exception_handler(DomainError, main.domain_error_handler)

        @app.get("/http/{status}")
        def raise_http(status: int, structured: bool = False):
            raise HTTPException(status_code=status, detail=self.detail(structured))

        @app.get("/domain/{status}")
        def raise_domain(status: int, structured: bool = False):
            raise DomainError(self.detail(structured), status_code=status)

        @app.get("/conflict")
        def raise_conflict():
            raise DomainConflictError("A prévia expirou.")

        self.client = TestClient(app)

    @staticmethod
    def detail(structured):
        return {"mensagem": "Séries duplicadas.", "series": ["S1", "S2"]} if structured else "Ação recusada: é preciso confirmar."

    def test_main_app_registers_the_handler(self):
        self.assertIs(main.app.exception_handlers.get(DomainError), main.domain_error_handler)

    def test_response_matches_http_exception_for_every_status_in_use(self):
        for status in (400, 409, 413, 422, 500, 503):
            for structured in (False, True):
                with self.subTest(status=status, structured=structured):
                    expected = self.client.get(f"/http/{status}", params={"structured": structured})
                    actual = self.client.get(f"/domain/{status}", params={"structured": structured})
                    self.assertEqual(actual.status_code, expected.status_code)
                    self.assertEqual(actual.content, expected.content)
                    self.assertEqual(actual.headers["content-type"], expected.headers["content-type"])

    def test_subclass_uses_its_default_status(self):
        response = self.client.get("/conflict")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "A prévia expirou."})


class InventoryUpdateExternalErrorTests(unittest.TestCase):
    def run_update(self, error):
        def fail_comparison(*_args, **_kwargs):
            raise error

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            services = replace(
                main._inventory_update_services,
                max_upload_bytes=lambda: 1024,
                workbook_parse_admission=lambda: None,
                validate_uploaded_workbook=lambda _data, _role: {"records": []},
                input_directory=lambda: root,
                endpoint_upload_file=lambda: root / "InvAll_atual.xlsx",
                details_upload_file=lambda: root / "EquipamentosDetalhes_atual.xlsx",
                comparison_history_file=lambda: root / "historico.json",
                upload_backups_directory=lambda: root / "backups",
                get_primary_equipment_file=lambda: None,
                compare_uploaded_workbooks=fail_comparison,
            )
            asyncio.run(update_inventory_files(
                UploadFile(filename="InvAll.xlsx", file=io.BytesIO(b"endpoint")),
                UploadFile(filename="Detalhes.xlsx", file=io.BytesIO(b"detalhes")),
                services=services,
            ))

    def test_application_http_error_reaches_the_caller_unchanged(self):
        error = HTTPException(status_code=503, detail="Histórico indisponível.")
        with self.assertRaises(HTTPException) as raised:
            self.run_update(error)
        self.assertIs(raised.exception, error)

    def test_domain_error_reaches_the_caller_unchanged(self):
        error = DomainConflictError("Base em uso.")
        with self.assertRaises(DomainConflictError) as raised:
            self.run_update(error)
        self.assertIs(raised.exception, error)


class AutomaticInboxTranslationTests(unittest.TestCase):
    def test_http_error_keeps_status_and_detail(self):
        error = main._as_domain_error(HTTPException(status_code=503, detail="Recuperação pendente."))
        self.assertIsInstance(error, DomainError)
        self.assertEqual((error.status_code, error.detail), (503, "Recuperação pendente."))

    def test_inventory_batch_reports_recovery_block_as_domain_error(self):
        with patch.object(main, "get_transaction_recovery_block", return_value="Recuperação pendente."):
            with self.assertRaises(DomainError) as raised:
                asyncio.run(main._import_automatic_inventory_batch("lote", "a.xlsx", b"", "b.xlsx", b""))
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, "Recuperação pendente.")


if __name__ == "__main__":
    unittest.main()
