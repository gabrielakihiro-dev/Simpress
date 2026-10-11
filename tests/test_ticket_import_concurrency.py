"""Deterministic races for the shared manual/automatic ticket import route."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from io import BytesIO
import json
import multiprocessing
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.datastructures import UploadFile

from domains.history_annotations import load_history_annotations
from domains.ticket_inbox import AutomaticTicketInbox
from domains.ticket_reporting import MAX_TICKET_SNAPSHOTS
from integrity import AtomicFileTransaction, FileTransactionError
from routers.operations import create_operations_router, TicketTimelineAnnotationPayload


ROOT = Path(__file__).resolve().parents[1]


def make_router(root):
    return create_operations_router(
        load_comparison_history=lambda: [], comparison_history_for_display=lambda event: event,
        ticket_report_path=lambda: root / "tickets.json", transaction_root=lambda: root,
        history_annotations_directory=lambda: root / "shared",
        local_annotation_outbox_directory=lambda: root / "outbox",
    )


def endpoint(router, path, method="GET"):
    return next(r.endpoint for r in router.routes if r.path == path and method in r.methods)


def parsed_report(simpress_bytes, _oracle_bytes, **_kwargs):
    return {"fontes": {"simpress": {"arquivo": simpress_bytes.decode()}}, "resumo": {},
            "chamados": [{"serie": "SN-1", "simpress": {"status": ["Aberto"]}}]}


def import_version(router, label, batch=None):
    try:
        return endpoint(router, "/api/operacoes/chamados/importar", "POST")(
            simpress_file=UploadFile(filename="simpress.xlsx", file=BytesIO(label.encode())),
            oracle_file=UploadFile(filename="oracle.xlsx", file=BytesIO(b"oracle")),
            automatic_import_id=batch,
        )
    except HTTPException as error:
        return error


def process_import(root_name, ready, output, label, batch):
    """Spawn-safe entry point; filesystem transactions/OS locks remain real."""
    root = Path(root_name)
    path = (root / "tickets.json").resolve()

    class RacingTransaction(AtomicFileTransaction):
        def __enter__(transaction):
            if path in transaction.targets:
                ready.wait(timeout=15)
            return super().__enter__()

    try:
        with patch("routers.operations.reconcile_ticket_workbooks", side_effect=parsed_report), \
                patch("routers.operations.AtomicFileTransaction", RacingTransaction):
            result = import_version(make_router(root), label, batch)
        output.put(result if isinstance(result, dict) else {"error": result.status_code})
    except Exception as error:
        output.put({"exception": repr(error)})


class TicketImportConcurrencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=ROOT, prefix=".ticket-import-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.router = make_router(self.root)
        self.path = self.root / "tickets.json"
        self.parser = patch("routers.operations.reconcile_ticket_workbooks", side_effect=parsed_report)
        self.parser.start()
        self.addCleanup(self.parser.stop)

    def race(self, batches):
        ready = threading.Barrier(2, timeout=10)
        path = self.path.resolve()

        class RacingTransaction(AtomicFileTransaction):
            def __enter__(transaction):
                if path in transaction.targets:
                    ready.wait()
                return super().__enter__()

        with patch("routers.operations.AtomicFileTransaction", RacingTransaction):
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(import_version, self.router, label, batch)
                           for label, batch in zip(("A", "B"), batches)]
                return [future.result(timeout=25) for future in futures]

    def report(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def test_distinct_automatic_imports_preserve_both_committed_snapshots_and_receipts(self):
        results = self.race(("batch-a", "batch-b"))
        self.assertTrue(all(isinstance(result, dict) for result in results), results)
        report = self.report()
        self.assertEqual(len(report["historico"]), 2)
        self.assertEqual({s["fontes"]["simpress"]["arquivo"] for s in report["historico"]}, {"A", "B"})
        self.assertEqual({r["lote_id"] for r in report["importacoes_automaticas"]}, {"batch-a", "batch-b"})
        self.assertEqual(report["snapshot_id"], report["historico"][-1]["id"])
        self.assertEqual(sorted(len(result["historico"]) for result in results), [1, 2])

    def test_same_batch_concurrent_attempts_commit_once_and_reject_the_duplicate(self):
        results = self.race(("same-batch", "same-batch"))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        errors = [result for result in results if isinstance(result, HTTPException)]
        self.assertEqual([error.status_code for error in errors], [409])
        self.assertEqual(len(self.report()["historico"]), 1)
        self.assertEqual(len(self.report()["importacoes_automaticas"]), 1)

    def test_manual_and_automatic_imports_preserve_both_versions(self):
        results = self.race((None, "automatic"))
        self.assertTrue(all(isinstance(result, dict) for result in results), results)
        self.assertEqual(len(self.report()["historico"]), 2)
        self.assertEqual([r["lote_id"] for r in self.report()["importacoes_automaticas"]], ["automatic"])

    def test_actual_automatic_inbox_and_manual_upload_share_the_transaction(self):
        inbox_root = self.root / "inbox"
        batch = inbox_root / "pendentes" / "automatic"
        for role in ("simpress", "oracle"):
            (batch / role).mkdir(parents=True)
            (batch / role / "fixture.xlsx").write_bytes(role.encode())

        def import_batch(batch_id, simpress_name, simpress_bytes, oracle_name, oracle_bytes):
            return endpoint(self.router, "/api/operacoes/chamados/importar", "POST")(
                simpress_file=UploadFile(filename=simpress_name, file=BytesIO(simpress_bytes)),
                oracle_file=UploadFile(filename=oracle_name, file=BytesIO(oracle_bytes)),
                automatic_import_id=batch_id,
            )

        inbox = AutomaticTicketInbox(inbox_root, self.path, 1024, import_batch)
        self.assertEqual(inbox.process_pending_once_sync(), 0)
        ready = threading.Barrier(2, timeout=10)
        path = self.path.resolve()

        class RacingTransaction(AtomicFileTransaction):
            def __enter__(transaction):
                if path in transaction.targets:
                    ready.wait()
                return super().__enter__()

        with patch("routers.operations.AtomicFileTransaction", RacingTransaction):
            with ThreadPoolExecutor(max_workers=2) as pool:
                manual = pool.submit(import_version, self.router, "manual")
                automatic = pool.submit(inbox.process_pending_once_sync)
                self.assertIsInstance(manual.result(timeout=25), dict)
                self.assertEqual(automatic.result(timeout=25), 1)
        self.assertTrue((inbox_root / "processadas" / "automatic" / "_resultado.json").exists())
        self.assertEqual(len(self.report()["historico"]), 2)
        self.assertEqual([r["lote_id"] for r in self.report()["importacoes_automaticas"]], ["automatic"])

    def test_invalid_existing_report_keeps_error_contract_and_is_not_overwritten(self):
        for payload in (b"not JSON", b"[]", b'{"chamados": "invalid"}'):
            with self.subTest(payload=payload):
                self.path.write_bytes(payload)
                result = import_version(self.router, "new", "new")
                self.assertEqual(result.status_code, 503)
                self.assertEqual(self.path.read_bytes(), payload)

    def test_clock_regression_does_not_reorder_committed_versions(self):
        with patch("routers.operations.datetime") as clock:
            clock.now.side_effect = [datetime(2099, 1, 1, 12, tzinfo=timezone.utc),
                                     datetime(1990, 1, 1, 12, tzinfo=timezone.utc)]
            self.assertIsInstance(import_version(self.router, "first", "first"), dict)
            self.assertIsInstance(import_version(self.router, "second", "second"), dict)
        report = self.report()
        self.assertEqual([s["fontes"]["simpress"]["arquivo"] for s in report["historico"]], ["first", "second"])
        self.assertEqual([r["lote_id"] for r in report["importacoes_automaticas"]], ["first", "second"])
        self.assertEqual(report["snapshot_id"], self.timeline()[-1]["snapshot_id"])
        self.assertTrue(self.timeline()[-1]["atualizado_em"].startswith("1990"))

    def test_failure_before_commit_preserves_previous_report_and_annotations(self):
        import_version(self.router, "seed", "seed")
        original = self.path.read_bytes()
        notes = list(load_history_annotations(self.root / "shared"))

        class FailingTransaction(AtomicFileTransaction):
            def commit(transaction):
                raise FileTransactionError("Injected pre-commit failure")

        with patch("routers.operations.AtomicFileTransaction", FailingTransaction):
            result = import_version(self.router, "failed", "failed")
        self.assertEqual(result.status_code, 500)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(load_history_annotations(self.root / "shared"), notes)
        self.assertEqual(load_history_annotations(self.root / "outbox"), [])
        self.assertEqual(list((self.root / ".transactions").iterdir()), [])

    def test_partial_apply_failure_rolls_back_report_receipt_and_initial_notes(self):
        import_version(self.router, "seed", "seed")
        original = self.path.read_bytes()

        class FailingTransaction(AtomicFileTransaction):
            def _apply_entry(transaction, entry):
                super()._apply_entry(entry)
                if entry["target"] != "tickets.json":
                    raise FileTransactionError("Injected failure after applying an annotation")

        with patch("routers.operations.AtomicFileTransaction", FailingTransaction):
            result = import_version(self.router, "failed", "failed")
        self.assertEqual(result.status_code, 500)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(load_history_annotations(self.root / "outbox"), [])

    def timeline(self):
        return endpoint(self.router, "/api/operacoes/chamados/linha-do-tempo/{serial}")("SN-1")["eventos"]

    def save_note(self, event, text, parents=None):
        return endpoint(self.router, "/api/operacoes/chamados/linha-do-tempo/{event_id}/{item_id}", "PUT")(
            event["snapshot_id"], event["item_id"], TicketTimelineAnnotationPayload(
                anotacao=text, base_revisoes=parents if parents is not None else event["anotacao_revisoes"],
            ),
        )

    def test_waiting_import_inherits_from_actual_predecessor_and_keeps_commit_order(self):
        import_version(self.router, "seed")
        self.save_note(self.timeline()[-1], "Old note")
        waiting = threading.Event()
        proceed = threading.Event()
        path = self.path.resolve()

        class WaitingTransaction(AtomicFileTransaction):
            def __enter__(transaction):
                if path in transaction.targets and threading.current_thread().name.startswith("delayed"):
                    waiting.set()
                    if not proceed.wait(timeout=15):
                        raise RuntimeError("Waiting import was not released")
                return super().__enter__()

        with patch("routers.operations.AtomicFileTransaction", WaitingTransaction):
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="delayed") as pool:
                delayed = pool.submit(import_version, self.router, "started-first", "delayed")
                try:
                    self.assertTrue(waiting.wait(timeout=10))
                    confirmed = import_version(self.router, "committed-first", "first")
                    self.assertIsInstance(confirmed, dict)
                    self.save_note(self.timeline()[-1], "")
                finally:
                    proceed.set()
                self.assertIsInstance(delayed.result(timeout=20), dict)

        report = self.report()
        self.assertEqual([s["fontes"]["simpress"]["arquivo"] for s in report["historico"]],
                         ["seed", "committed-first", "started-first"])
        self.assertEqual(self.timeline()[-1]["anotacao"], "")
        self.assertEqual([r["lote_id"] for r in report["importacoes_automaticas"]], ["first", "delayed"])

    def test_following_import_inherits_pending_revision_before_shared_publication(self):
        import_version(self.router, "seed")
        self.save_note(self.timeline()[-1], "Keep this note")
        publishing = threading.Event()
        release = threading.Event()

        def delayed_publication(*_args, **_kwargs):
            if threading.current_thread().name.startswith("publishing"):
                publishing.set()
                if not release.wait(timeout=15):
                    raise RuntimeError("Publication was not released")
            return False

        with patch("routers.operations.sync_history_annotation", side_effect=delayed_publication):
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="publishing") as pool:
                first = pool.submit(import_version, self.router, "first")
                try:
                    self.assertTrue(publishing.wait(timeout=10))
                    self.assertIsInstance(import_version(self.router, "second"), dict)
                    events = self.timeline()
                    self.assertEqual([event["anotacao"] for event in events], ["Keep this note"] * 3)
                    self.assertEqual(len({event["anotacao_revisoes"][0] for event in events}), 3)
                    self.assertEqual(len(load_history_annotations(self.root / "outbox")), 2)
                finally:
                    release.set()
                self.assertIsInstance(first.result(timeout=20), dict)

    def test_conflicting_predecessor_notes_are_not_inherited(self):
        import_version(self.router, "seed")
        event = self.timeline()[-1]
        self.save_note(event, "A")
        self.save_note(event, "B")
        self.assertTrue(self.timeline()[-1]["anotacao_conflito"])
        import_version(self.router, "next")
        self.assertEqual(self.timeline()[-1]["anotacao"], "")
        self.assertFalse(self.timeline()[-1]["anotacao_conflito"])

    def test_retention_caps_snapshots_but_preserves_old_batch_receipts(self):
        snapshots = [{"id": str(index), "atualizado_em": "2026-01-01", "chamados": []}
                     for index in range(MAX_TICKET_SNAPSHOTS)]
        self.path.write_text(json.dumps({**snapshots[-1], "snapshot_id": snapshots[-1]["id"],
                                        "historico": snapshots,
                                        "importacoes_automaticas": [{"lote_id": "old"}]}), encoding="utf-8")
        self.assertIsInstance(import_version(self.router, "next", "next"), dict)
        report = self.report()
        self.assertEqual(len(report["historico"]), MAX_TICKET_SNAPSHOTS)
        self.assertEqual(report["historico"][0]["id"], "1")
        self.assertEqual([r["lote_id"] for r in report["importacoes_automaticas"]], ["old", "next"])
        self.assertEqual(import_version(self.router, "old", "old").status_code, 409)

    def process_race(self, batches):
        context = multiprocessing.get_context("spawn")
        ready = context.Barrier(2)
        output = context.Queue()
        processes = [context.Process(target=process_import, args=(str(self.root), ready, output, label, batch))
                     for label, batch in zip(("A", "B"), batches)]
        try:
            for process in processes:
                process.start()
            results = [output.get(timeout=30) for _ in processes]
            for process in processes:
                process.join(timeout=10)
                self.assertEqual(process.exitcode, 0)
            return results
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=5)
            output.close()
            output.join_thread()

    def test_distinct_batches_in_separate_processes_preserve_both_versions_and_receipts(self):
        results = self.process_race(("A", "B"))
        self.assertTrue(all("error" not in result and "exception" not in result for result in results), results)
        self.assertEqual(len(self.report()["historico"]), 2)
        self.assertEqual({r["lote_id"] for r in self.report()["importacoes_automaticas"]}, {"A", "B"})

    def test_same_batch_in_separate_processes_commits_once(self):
        results = self.process_race(("same", "same"))
        self.assertEqual(sum(result.get("error") == 409 for result in results), 1, results)
        self.assertEqual(len(self.report()["historico"]), 1)
        self.assertEqual(len(self.report()["importacoes_automaticas"]), 1)

    def test_manual_and_automatic_in_separate_processes_preserve_both_versions(self):
        results = self.process_race((None, "automatic"))
        self.assertTrue(all("error" not in result and "exception" not in result for result in results), results)
        self.assertEqual(len(self.report()["historico"]), 2)
        self.assertEqual([r["lote_id"] for r in self.report()["importacoes_automaticas"]], ["automatic"])


if __name__ == "__main__":
    unittest.main()
