import json
import multiprocessing
import os
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import openpyxl

import integrity


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class AtomicTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".integrity-test-", dir=PROJECT_ROOT)
        self.root = Path(self.temp_context.name)

    def tearDown(self):
        self.temp_context.cleanup()

    def test_transaction_entry_and_exit_commit_normally(self):
        target = self.root / "entry.json"
        target.write_bytes(b"before")
        transaction = integrity.AtomicFileTransaction(self.root, [target])

        with transaction as entered_transaction:
            self.assertIs(entered_transaction, transaction)
            self.assertTrue(transaction._entered)
            transaction.stage_bytes(target, b"after")
            transaction.commit()

        self.assertEqual(target.read_bytes(), b"after")
        self.assertFalse(transaction.transaction_dir.exists())
        self.assertTrue(transaction._closed)

    def test_failed_entry_releases_prior_locks_and_preserves_original_error(self):
        target = self.root / "later-lock.json"
        lock_error = integrity.FileBusyError("simulated failure acquiring the target lock")
        cleanup_error = RuntimeError("simulated cleanup callback failure")
        transaction = integrity.AtomicFileTransaction(self.root, [target])
        original_lock_paths = integrity.lock_paths

        def fail_target_lock(paths, timeout=15.0):
            requested_paths = [Path(path).resolve(strict=False) for path in paths]
            if target.resolve(strict=False) in requested_paths:
                raise lock_error
            return original_lock_paths(requested_paths, timeout)

        def fail_cleanup():
            raise cleanup_error

        transaction._stack.callback(fail_cleanup)
        with patch("integrity.lock_paths", side_effect=fail_target_lock):
            with self.assertRaises(integrity.FileBusyError) as raised:
                transaction.__enter__()

        self.assertIs(raised.exception, lock_error)
        self.assertTrue(any("simulated cleanup callback failure" in note for note in raised.exception.__notes__))
        self.assertFalse(transaction._entered)
        self.assertTrue(transaction._closed)
        self.assertFalse(transaction.transaction_dir.exists())

        acquired = threading.Event()
        errors = []

        def acquire_transaction_after_failure():
            def bounded_lock_paths(paths, timeout=15.0):
                return original_lock_paths(paths, timeout=0.5)

            try:
                with patch("integrity.lock_paths", side_effect=bounded_lock_paths):
                    with integrity.AtomicFileTransaction(self.root, [target]):
                        acquired.set()
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=acquire_transaction_after_failure)
        thread.start()
        thread.join(2)

        self.assertFalse(thread.is_alive(), "the next transaction stayed blocked after failed entry")
        self.assertTrue(acquired.is_set(), f"the next transaction could not acquire the locks: {errors}")
        self.assertEqual(errors, [])

    def test_json_write_is_atomic_and_keeps_utf8_json_shape(self):
        target = self.root / "settings.json"
        integrity.atomic_write_json(target, {"cidade": "Maringá", "ativa": True})

        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"cidade": "Maringá", "ativa": True})
        self.assertFalse(list(self.root.glob("*.tmp")))

    def test_validation_failure_before_replace_keeps_original(self):
        target = self.root / "equipment.xlsx"
        target.write_bytes(b"old-content")

        with self.assertRaises(ValueError):
            with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
                transaction.stage_bytes(target, b"new-content", lambda _: (_ for _ in ()).throw(ValueError("bad temp")))
                transaction.commit()

        self.assertEqual(target.read_bytes(), b"old-content")
        self.assertFalse((self.root / ".transactions").exists() and list((self.root / ".transactions").iterdir()))

    def test_rollback_removes_only_the_unchanged_staged_temporary(self):
        target = self.root / "inventory.xlsx"
        target.write_bytes(b"original")
        staged_path = None

        with self.assertRaisesRegex(RuntimeError, "cancel before apply"):
            with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
                transaction.stage_bytes(target, b"replacement")
                staged_path = self.root / transaction.manifest["entries"][0]["stage"]
                self.assertTrue(staged_path.exists())
                raise RuntimeError("cancel before apply")

        self.assertEqual(target.read_bytes(), b"original")
        self.assertIsNotNone(staged_path)
        self.assertFalse(staged_path.exists())

    def test_failure_during_second_replace_rolls_back_first_file(self):
        first = self.root / "first.xlsx"
        second = self.root / "second.xlsx"
        first.write_bytes(b"first-before")
        second.write_bytes(b"second-before")
        original_replace = os.replace

        def fail_second_replace(source, destination):
            if Path(destination) == second:
                raise PermissionError("simulated workbook lock")
            return original_replace(source, destination)

        with patch("integrity.os.replace", side_effect=fail_second_replace), patch("integrity._RETRY_DELAYS", (0, 0, 0)):
            with self.assertRaises(integrity.FileBusyError):
                with integrity.AtomicFileTransaction(self.root, [first, second]) as transaction:
                    transaction.stage_bytes(first, b"first-after")
                    transaction.stage_bytes(second, b"second-after")
                    transaction.commit()

        self.assertEqual(first.read_bytes(), b"first-before")
        self.assertEqual(second.read_bytes(), b"second-before")
        self.assertEqual(list((self.root / ".transactions").iterdir()), [])

    def test_blocked_destination_never_returns_success_or_changes_original(self):
        target = self.root / "open-in-excel.xlsx"
        target.write_bytes(b"unchanged")
        original_replace = os.replace

        def block_target(source, destination):
            if Path(destination) == target:
                raise PermissionError("simulated Excel lock")
            return original_replace(source, destination)

        with patch("integrity.os.replace", side_effect=block_target), patch("integrity._RETRY_DELAYS", (0, 0, 0)):
            with self.assertRaisesRegex(integrity.FileBusyError, "Feche a planilha"):
                with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
                    transaction.stage_bytes(target, b"replacement")
                    transaction.commit()

        self.assertEqual(target.read_bytes(), b"unchanged")

    def test_interrupted_transaction_recovers_idempotently(self):
        first = self.root / "first.xlsx"
        second = self.root / "second.xlsx"
        first.write_bytes(b"first-before")
        second.write_bytes(b"second-before")

        transaction = integrity.AtomicFileTransaction(self.root, [first, second])
        transaction.__enter__()
        transaction.stage_bytes(first, b"first-after")
        transaction.stage_bytes(second, b"second-after")
        transaction.apply()
        transaction.close_after_interruption()

        integrity.recover_pending_transactions(self.root)
        integrity.recover_pending_transactions(self.root)

        self.assertEqual(first.read_bytes(), b"first-before")
        self.assertEqual(second.read_bytes(), b"second-before")
        self.assertEqual(list((self.root / ".transactions").iterdir()), [])

    def test_concurrent_transactions_on_one_destination_are_serialized(self):
        target = self.root / "shared.json"
        target.write_bytes(b"initial")
        first_entered = threading.Event()
        release_first = threading.Event()
        results = []
        errors = []

        def first_writer():
            try:
                with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
                    transaction.stage_bytes(target, b"first")
                    first_entered.set()
                    if not release_first.wait(5):
                        raise TimeoutError("test synchronization timed out")
                    transaction.commit()
                results.append("first")
            except Exception as error:
                errors.append(error)

        def second_writer():
            try:
                if not first_entered.wait(5):
                    raise TimeoutError("first writer did not start")
                with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
                    transaction.stage_bytes(target, b"second")
                    transaction.commit()
                results.append("second")
            except Exception as error:
                errors.append(error)

        first = threading.Thread(target=first_writer)
        second = threading.Thread(target=second_writer)
        first.start()
        self.assertTrue(first_entered.wait(5))
        second.start()
        time.sleep(0.05)
        release_first.set()
        first.join(10)
        second.join(10)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(set(results), {"first", "second"})
        self.assertEqual(target.read_bytes(), b"second")

    def test_transactions_from_separate_processes_share_the_file_lock(self):
        target = self.root / "cross-process.json"
        target.write_bytes(b"initial")
        context = multiprocessing.get_context("spawn")
        attempting = context.Event()
        entered = context.Event()
        results = context.Queue()

        with integrity.AtomicFileTransaction(self.root, [target]) as first_transaction:
            first_transaction.stage_bytes(target, b"first-process")
            process = context.Process(
                target=_second_process_writer,
                args=(str(self.root), str(target), attempting, entered, results),
            )
            process.start()
            self.assertTrue(attempting.wait(10))
            self.assertFalse(entered.wait(0.3), "the second process entered while the first held the lock")
            first_transaction.commit()

        self.assertTrue(entered.wait(10))
        process.join(10)
        self.assertFalse(process.is_alive())
        self.assertEqual(results.get(timeout=2), "ok")
        self.assertEqual(target.read_bytes(), b"second-process")

    def test_workbook_with_unsupported_embedded_resource_is_refused(self):
        target = self.root / "unsafe.xlsx"
        workbook = openpyxl.Workbook()
        workbook.save(target)
        workbook.close()

        rewritten = self.root / "unsafe-repacked.xlsx"
        with zipfile.ZipFile(target, "r") as original, zipfile.ZipFile(rewritten, "w") as changed:
            for item in original.infolist():
                changed.writestr(item, original.read(item.filename))
            changed.writestr("xl/activeX/activeX1.bin", b"fictitious control")

        with self.assertRaises(integrity.WorkbookSafetyError):
            integrity.load_workbook_safely(rewritten)


def _second_process_writer(root, target, attempting, entered, results):
    attempting.set()
    try:
        with integrity.AtomicFileTransaction(Path(root), [Path(target)]) as transaction:
            entered.set()
            transaction.stage_bytes(Path(target), b"second-process")
            transaction.commit()
        results.put("ok")
    except Exception as error:
        results.put(f"error: {type(error).__name__}: {error}")


if __name__ == "__main__":
    unittest.main()
