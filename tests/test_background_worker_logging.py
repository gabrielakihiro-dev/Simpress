"""Background workers report why they stopped; the ticket inbox imports through the service."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import main
from core.errors import DomainError
from domains.ticket_import import TicketImportError, TicketImportServices
from domains.ticket_inbox import AutomaticTicketInbox


WORKER_NAMES = (
    "_history_annotation_sync_worker",
    "_automatic_inventory_import_worker",
    "_automatic_ticket_import_worker",
    "_external_change_reload_worker",
    "_monthly_report_worker",
)


async def idle_worker():
    await asyncio.Event().wait()


class LifespanWorkerLoggingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # The startup preparation touches local state; these tests only exercise the workers.
        for name, value in (
            ("_recover_pending_transactions_at_startup", Mock(return_value=False)),
            ("load_database", Mock()),
            ("_report_startup_readiness_best_effort", Mock()),
        ):
            patcher = patch.object(main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def use_workers(self, **overrides):
        for name in WORKER_NAMES:
            patcher = patch.object(main, name, overrides.get(name, idle_worker))
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_worker_crash_while_running_is_logged_with_traceback(self):
        crashed = asyncio.Event()

        async def broken_reload_worker():
            crashed.set()
            raise RuntimeError("falha simulada do worker")

        self.use_workers(_external_change_reload_worker=broken_reload_worker)
        with self.assertLogs("main", "ERROR") as captured:
            async with main.lifespan(main.app):
                await asyncio.wait_for(crashed.wait(), 2)
                for _ in range(3):
                    await asyncio.sleep(0)
                # Logged while the server is still up, not only at shutdown.
                self.assertEqual(len(captured.records), 1)

        record = captured.records[0]
        self.assertIn("broken_reload_worker", record.getMessage())
        self.assertIsNotNone(record.exc_info)
        self.assertIs(record.exc_info[0], RuntimeError)
        self.assertEqual(len(captured.records), 1)

    async def test_failure_raised_while_cancelling_a_worker_is_logged(self):
        async def worker_failing_on_shutdown():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                raise OSError("falha ao liberar recurso")

        self.use_workers(_history_annotation_sync_worker=worker_failing_on_shutdown)
        with self.assertLogs("main", "ERROR") as captured:
            async with main.lifespan(main.app):
                await asyncio.sleep(0)

        self.assertEqual(len(captured.records), 1)
        self.assertIn("worker_failing_on_shutdown", captured.records[0].getMessage())
        self.assertIs(captured.records[0].exc_info[0], OSError)

    async def test_regular_shutdown_cancellation_is_not_logged_as_failure(self):
        self.use_workers()
        with self.assertNoLogs("main", "ERROR"):
            async with main.lifespan(main.app):
                await asyncio.sleep(0)


class MonthlyReportWorkerTests(unittest.TestCase):
    def test_recovery_check_failure_is_logged_and_does_not_stop_the_worker(self):
        with patch.object(main, "get_transaction_recovery_block", side_effect=OSError("disco indisponível")), \
                patch.object(main, "generate_previous_month_report") as generate, \
                self.assertLogs("main", "WARNING") as captured:
            main._generate_previous_month_report_best_effort()
        generate.assert_not_called()
        self.assertIn("OSError", captured.output[0])

    def test_blocked_recovery_skips_generation_silently(self):
        with patch.object(main, "get_transaction_recovery_block", return_value="bloqueado"), \
                patch.object(main, "generate_previous_month_report") as generate, \
                self.assertNoLogs("main", "WARNING"):
            main._generate_previous_month_report_best_effort()
        generate.assert_not_called()


def parsed_report(simpress_bytes, _oracle_bytes, **_kwargs):
    return {
        "fontes": {"simpress": {"arquivo": simpress_bytes.decode()}},
        "resumo": {},
        "chamados": [{"serie": "SN-1", "simpress": {"status": ["Aberto"]}}],
    }


class AutomaticTicketImportServiceTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.report_path = self.root / "tickets.json"
        services = TicketImportServices(
            ticket_report_path=lambda: self.report_path,
            transaction_root=lambda: self.root,
            annotation_directory=lambda: self.root / "shared",
            annotation_outbox_directory=lambda: self.root / "outbox",
            reconcile_workbooks=parsed_report,
        )
        self.enterContext(patch.object(main, "_ticket_import_services", services))
        self.enterContext(patch.object(main, "get_transaction_recovery_block", return_value=None))
        # The worker must not depend on the HTTP route being registered.
        self.enterContext(patch.object(main.operations_router, "routes", []))

    def report(self):
        return json.loads(self.report_path.read_text(encoding="utf-8"))

    def test_batch_is_imported_without_the_http_route(self):
        result = main._import_automatic_ticket_batch("lote-1", "simpress.xlsx", b"primeiro", "oracle.xlsx", b"oracle")

        self.assertEqual(result["fontes"]["simpress"]["arquivo"], "primeiro")
        self.assertEqual(len(result["historico"]), 1)
        self.assertEqual([item["lote_id"] for item in self.report()["importacoes_automaticas"]], ["lote-1"])

    def test_domain_errors_keep_status_codes_for_the_inbox(self):
        main._import_automatic_ticket_batch("lote-1", "simpress.xlsx", b"primeiro", "oracle.xlsx", b"oracle")
        cases = (
            ("lote-1", "simpress.xlsx", b"novo", 409),
            ("lote-2", "simpress.csv", b"novo", 400),
            ("lote-3", "simpress.xlsx", b"", 400),
        )
        for batch_id, simpress_name, content, status in cases:
            with self.subTest(batch_id=batch_id), self.assertRaises(TicketImportError) as raised:
                main._import_automatic_ticket_batch(batch_id, simpress_name, content, "oracle.xlsx", b"oracle")
            self.assertEqual(raised.exception.status_code, status)

    def test_recovery_block_keeps_the_batch_pending_with_503(self):
        with patch.object(main, "get_transaction_recovery_block", return_value="Recuperação pendente."), \
                self.assertRaises(DomainError) as raised:
            main._import_automatic_ticket_batch("lote-1", "simpress.xlsx", b"x", "oracle.xlsx", b"oracle")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertFalse(self.report_path.exists())

    def test_inbox_batch_completes_with_result_file_and_history(self):
        inbox_root = self.root / "entrada_chamados"
        batch = inbox_root / "pendentes" / "lote-pasta"
        for role in ("simpress", "oracle"):
            (batch / role).mkdir(parents=True)
            (batch / role / f"{role}.xlsx").write_bytes(role.encode())
        inbox = AutomaticTicketInbox(inbox_root, self.report_path, 1024, main._import_automatic_ticket_batch)

        self.assertEqual(inbox.process_pending_once_sync(), 0)  # The first pass only confirms stability.
        self.assertEqual(inbox.process_pending_once_sync(), 1)

        result = json.loads((inbox_root / "processadas" / "lote-pasta" / "_resultado.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "concluido")
        self.assertEqual([item["lote_id"] for item in self.report()["importacoes_automaticas"]], ["lote-pasta"])
        self.assertEqual(len(self.report()["historico"]), 1)


if __name__ == "__main__":
    unittest.main()
