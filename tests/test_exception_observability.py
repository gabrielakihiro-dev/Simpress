"""Expected input failures stay observable without logging workbook contents."""

import asyncio
from contextlib import ExitStack
import io
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from zipfile import BadZipFile

from fastapi import HTTPException
from starlette.datastructures import UploadFile

import main
from core import integrity
from core.errors import DomainError, DomainValidationError
from core.async_workers import await_worker_completion
from core.xlsx_safety import WORKBOOK_READ_ERRORS
from domains import inventory_state, ticket_reconciliation
from routers.local_setup import create_local_setup_router


PRIVATE_CONTENT = "PRIVATE_CELL_OR_PERSONAL_DATA"


class ExceptionObservabilityTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.file = self.root / "fixture.xlsx"
        self.file.write_bytes(b"synthetic workbook")

    def assert_safe_log(self, captured, *context):
        text = "\n".join(captured.output)
        self.assertNotIn(PRIVATE_CONTENT, text)
        self.assertTrue(captured.records)
        self.assertTrue(all(record.exc_info is None for record in captured.records))
        for value in context:
            self.assertIn(value, text)

    def test_details_sheet_expected_failures_keep_none_and_safe_log(self):
        for error_type in WORKBOOK_READ_ERRORS:
            with (
                self.subTest(error=error_type.__name__),
                patch.object(main, "_ensure_workbook_readable"),
                patch.object(main, "validate_xlsx", side_effect=error_type(PRIVATE_CONTENT)),
                self.assertLogs(main.logger, level="WARNING") as log,
            ):
                self.assertIsNone(main.find_details_sheet(self.file))
                self.assert_safe_log(log, self.file.name, "papel=detalhes", error_type.__name__)

    def test_details_sheet_closes_workbook_when_iteration_fails(self):
        sheet = Mock()
        sheet.iter_rows.side_effect = ValueError(PRIVATE_CONTENT)
        workbook = Mock(worksheets=[sheet])
        with (
            patch.object(main, "validate_xlsx"),
            patch.object(main.openpyxl, "load_workbook", return_value=workbook),
            self.assertLogs(main.logger, level="WARNING") as log,
        ):
            self.assertIsNone(main.find_details_sheet(self.file))
        workbook.close.assert_called_once()
        self.assert_safe_log(log, self.file.name)

    def test_ready_workbook_preserves_invalid_state_and_logs_role(self):
        with (
            patch.dict(main._READINESS_VALIDATION_CACHE, {}, clear=True),
            patch.object(main, "validate_uploaded_workbook", side_effect=DomainValidationError(PRIVATE_CONTENT)),
            self.assertLogs(main.logger, level="WARNING") as log,
        ):
            result = main._check_ready_workbook(self.file, "endpoint")
        self.assertFalse(result["available"])
        self.assertEqual(result["state"], "invalid")
        self.assertEqual(result["reason"], PRIVATE_CONTENT)
        self.assert_safe_log(log, self.file.name, "papel=endpoint", "DomainValidationError")

    def readiness(self, *, listing_error=None, selection_error=None):
        with ExitStack() as stack:
            for name in ("INPUT_DIR", "ALIAS_HISTORY_FILE", "COMPARISON_HISTORY_FILE", "TICKET_REPORT_FILE"):
                stack.enter_context(patch.object(main, name, self.root / name))
            stack.enter_context(patch.object(main, "load_modified_apelidos", return_value={}))
            stack.enter_context(patch.object(main, "load_custom_units", return_value=[]))
            stack.enter_context(patch.object(main, "get_transaction_recovery_block", return_value=None))
            stack.enter_context(patch.object(main, "_check_ready_workbook", side_effect=lambda path, role: {
                "available": False, "file": path.name, "reason": "ausente",
            }))
            stack.enter_context(patch.object(main, "get_details_files", return_value=[self.file], side_effect=listing_error))
            stack.enter_context(patch.object(main, "get_primary_equipment_file", return_value=None, side_effect=selection_error))
            return main._get_startup_readiness_unlocked()

    def test_inventory_listing_failure_is_logged_and_stays_unavailable(self):
        with self.assertLogs(main.logger, level="WARNING") as log:
            result = self.readiness(listing_error=OSError(PRIVATE_CONTENT))
        self.assertEqual(result["files"]["inventario_equipamentos"]["reason"], "não foi possível ler a pasta de inventários")
        self.assert_safe_log(log, "papel=detalhes", "OSError")

    def test_inventory_selection_failure_is_logged_and_stays_unavailable(self):
        with self.assertLogs(main.logger, level="WARNING") as log:
            result = self.readiness(selection_error=main.FileBusyError(PRIVATE_CONTENT))
        self.assertFalse(result["functions"]["consulta_equipamentos"]["available"])
        self.assert_safe_log(log, "papel=detalhes", "FileBusyError")

    def test_upload_read_failure_preserves_http_400_and_safe_log(self):
        with (
            patch.object(main, "validate_xlsx_package"),
            patch.object(main.openpyxl, "load_workbook", side_effect=BadZipFile(PRIVATE_CONTENT)),
            self.assertLogs(main.logger, level="WARNING") as log,
            self.assertRaises(DomainError) as error,
        ):
            main.read_workbook_tables(b"synthetic")
        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(error.exception.detail, "O arquivo enviado não contém uma planilha .xlsx válida ou legível.")
        self.assert_safe_log(log, "papel=upload", "BadZipFile")

    def test_export_model_read_failure_preserves_http_500_and_safe_log(self):
        with (
            patch.object(main, "EXPORT_MODEL_FILE", self.file),
            patch.object(main, "validate_xlsx", side_effect=ValueError(PRIVATE_CONTENT)),
            self.assertLogs(main.logger, level="WARNING") as log,
            self.assertRaises(DomainError) as error,
        ):
            main.load_export_model_aliases()
        self.assertEqual(error.exception.status_code, 500)
        self.assertEqual(error.exception.detail, "Não foi possível ler o modelo de exportação.")
        self.assert_safe_log(log, self.file.name, "papel=exportacao", "ValueError")

    def test_endpoint_read_failure_keeps_unavailable_index_and_safe_log(self):
        with (
            patch.object(main, "ENDPOINT_UPLOAD_FILE", self.file),
            patch.object(main, "validate_uploaded_workbook", side_effect=DomainValidationError(PRIVATE_CONTENT)),
            self.assertLogs(main.logger, level="WARNING") as log,
        ):
            result = main.read_endpoint_alias_index()
        self.assertEqual(result, {"available": False, "unique": {}, "duplicates": {}, "blank_serials": [], "blank_hostnames": {}, "users": {}})
        self.assert_safe_log(log, self.file.name, "papel=endpoint", "DomainValidationError")

    def test_inventory_read_failure_keeps_published_cache_and_logs(self):
        previous = {"SYNTHETIC": {"serial": "SYNTHETIC"}}
        with (
            patch.object(main, "get_parque_file", return_value=self.file),
            patch.object(main, "find_details_sheet", return_value="fixture"),
            patch.object(main, "_read_details_sheet_records", side_effect=OSError(PRIVATE_CONTENT)),
            patch.object(inventory_state, "equipamentos_cache", previous),
            self.assertLogs(main.logger, level="WARNING") as log,
        ):
            self.assertFalse(main.load_database(transaction_locked=True))
            self.assertIs(inventory_state.equipamentos_cache, previous)
        self.assert_safe_log(log, self.file.name, "papel=detalhes", "OSError")

    def test_invalid_recovery_manifest_is_logged_and_preserved(self):
        directory = self.root / "journal"
        directory.mkdir()
        manifest = directory / "manifest.json"
        for payload in ("{invalid", "[]", '{"version": 1, "entries": null}'):
            with self.subTest(payload=payload):
                manifest.write_text(payload, encoding="utf-8")
                with (
                    self.assertLogs(integrity.logger, level="WARNING") as log,
                    self.assertRaises(integrity.TransactionConflictError),
                ):
                    integrity._recover_transaction(self.root, directory)
                self.assertEqual(manifest.read_text(encoding="utf-8"), payload)
                self.assert_safe_log(log, "manifest.json")

    def test_json_update_read_failure_is_logged_without_replacing_data(self):
        target = self.root / "fixture.json"
        target.write_text("{invalid " + PRIVATE_CONTENT, encoding="utf-8")
        original = target.read_bytes()
        with (
            self.assertLogs(integrity.logger, level="WARNING") as log,
            self.assertRaises(integrity.FileTransactionError),
            integrity.AtomicFileTransaction(self.root, [target]) as transaction,
        ):
            transaction.update_json(target, lambda data: {}, {})
        self.assertEqual(target.read_bytes(), original)
        self.assert_safe_log(log, target.name, "JSONDecodeError")

    def test_ticket_table_read_failure_preserves_domain_error_and_safe_log(self):
        with (
            patch.object(ticket_reconciliation, "validate_xlsx"),
            patch.object(ticket_reconciliation.openpyxl, "load_workbook", side_effect=ValueError(PRIVATE_CONTENT)),
            self.assertLogs(ticket_reconciliation.logger, level="WARNING") as log,
            self.assertRaises(ticket_reconciliation.TicketWorkbookError) as error,
        ):
            ticket_reconciliation._source_table(b"synthetic", "Simpress", {}, [])
        self.assertIn("Não foi possível ler a planilha Simpress", str(error.exception))
        self.assert_safe_log(log, "papel=Simpress", "ValueError")

    def model_import(self, error):
        target = self.root / "modelo.xlsx"
        target.write_bytes(b"previous model")
        admission = threading.BoundedSemaphore(1)
        _, endpoint = create_local_setup_router(
            model_path=lambda kind: target,
            transaction_root=lambda: self.root, backups_directory=lambda: self.root / "backups",
            max_upload_bytes=lambda: 1024, parser_admission=lambda: admission,
            export_dependency_paths=lambda: [], validate_export=lambda: None,
        )
        upload = UploadFile(filename="modelo.xlsx", file=io.BytesIO(b"synthetic"))
        try:
            with patch("routers.local_setup.validate_local_model", side_effect=error):
                return asyncio.run(endpoint("exportacao", upload))
        finally:
            self.assertEqual(target.read_bytes(), b"previous model")
            self.assertTrue(upload.file.closed)
            self.assertTrue(admission.acquire(blocking=False))
            admission.release()

    def test_model_import_validation_keeps_http_400_and_logs(self):
        with (
            self.assertLogs("routers.local_setup", level="WARNING") as log,
            self.assertRaises(HTTPException) as error,
        ):
            self.model_import(ValueError(PRIVATE_CONTENT))
        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(error.exception.detail, "Modelo inválido: " + PRIVATE_CONTENT)
        self.assert_safe_log(log, "papel=exportacao", "ValueError")

    def test_unexpected_errors_are_not_disguised_as_bad_workbooks(self):
        checks = (
            ("validate_xlsx", lambda: main.find_details_sheet(self.file)),
            ("validate_xlsx_package", lambda: main.read_workbook_tables(b"synthetic")),
            ("validate_uploaded_workbook", lambda: main._check_ready_workbook(self.file, "endpoint")),
        )
        for hook, call in checks:
            with self.subTest(hook=hook), patch.object(main, hook, side_effect=RuntimeError("unexpected")):
                with self.assertRaisesRegex(RuntimeError, "unexpected"):
                    call()
        with self.assertRaisesRegex(RuntimeError, "unexpected"):
            self.readiness(selection_error=RuntimeError("unexpected"))
        with self.assertRaisesRegex(RuntimeError, "unexpected"):
            self.readiness(listing_error=RuntimeError("unexpected"))

    def test_unexpected_model_import_failure_releases_resources_and_propagates(self):
        with self.assertRaisesRegex(RuntimeError, "unexpected"):
            self.model_import(RuntimeError("unexpected"))

    def test_unexpected_json_reader_failure_propagates(self):
        target = self.root / "fixture.json"
        target.write_text("{}", encoding="utf-8")
        with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
            with patch.object(Path, "read_text", side_effect=RuntimeError("unexpected")):
                with self.assertRaisesRegex(RuntimeError, "unexpected"):
                    transaction.update_json(target, lambda data: {}, {})
        self.assertEqual(target.read_text(encoding="utf-8"), "{}")

    def test_cancelled_worker_failure_is_logged_without_callback(self):
        async def scenario():
            release = asyncio.Event()

            async def fail():
                await release.wait()
                raise RuntimeError(PRIVATE_CONTENT)

            worker = asyncio.create_task(fail())
            request = asyncio.create_task(await_worker_completion(worker))
            try:
                await asyncio.sleep(0)
                request.cancel()
                await asyncio.sleep(0)
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(request, 2)
                self.assertTrue(worker.done())
                self.assertFalse(worker.cancelled())
            finally:
                release.set()
                await asyncio.gather(worker, request, return_exceptions=True)

        with self.assertLogs("core.async_workers", level="WARNING") as log:
            asyncio.run(scenario())
        self.assert_safe_log(log, "cancelamento", "RuntimeError")


if __name__ == "__main__":
    unittest.main()
