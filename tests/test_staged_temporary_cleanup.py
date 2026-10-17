"""Transaction temporaries stay bounded under no-op updates and sharing locks."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core import integrity


class StagedTemporaryCleanupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = self.root / "historico_comparacoes.json"
        integrity.atomic_write_json(self.target, {"history": []})

    def test_ten_identical_commits_do_not_accumulate_orphaned_stages(self):
        for update in range(10):
            with self.subTest(update=update):
                with integrity.AtomicFileTransaction(self.root, [self.target]) as transaction:
                    transaction.update_json(self.target, lambda value: value, {})
                    transaction.commit()
                self.assertEqual(list(self.root.glob(".historico_comparacoes.json.*.tmp")), [])

    def test_ten_updates_retry_permission_errors_in_commit_and_rollback_cleanup(self):
        original_unlink = Path.unlink
        attempts = {}

        def transient_lock(path, missing_ok=False):
            if path.name.startswith(".historico_comparacoes.json.") and path.suffix == ".tmp":
                attempts[path] = attempts.get(path, 0) + 1
                if attempts[path] <= 2:
                    raise PermissionError("private simulated lock detail")
            return original_unlink(path, missing_ok=missing_ok)

        with patch.object(Path, "unlink", transient_lock), patch.object(integrity.time, "sleep"):
            for update in range(10):
                for commit in (True, False):
                    with self.subTest(update=update, commit=commit):
                        before = self.target.read_bytes()
                        with integrity.AtomicFileTransaction(self.root, [self.target]) as transaction:
                            # The commit is a no-op; rollback discards a changed snapshot.
                            payload = before if commit else f"discarded {update}".encode()
                            transaction.stage_bytes(self.target, payload)
                            if commit:
                                transaction.commit()
                        self.assertEqual(self.target.read_bytes(), before)
                        self.assertEqual(list(self.root.glob(".historico_comparacoes.json.*.tmp")), [])
        self.assertEqual(len(attempts), 20)
        self.assertTrue(all(count == 3 for count in attempts.values()))

    def test_ten_changed_commits_leave_no_temporaries(self):
        for update in range(10):
            with integrity.AtomicFileTransaction(self.root, [self.target]) as transaction:
                transaction.update_json(self.target, lambda value: {"history": [update]}, {})
                transaction.commit()
            self.assertEqual(list(self.root.glob(".historico_comparacoes.json.*.tmp")), [])

    def test_exhausted_removal_logs_only_path_and_error_type(self):
        with integrity.AtomicFileTransaction(self.root, [self.target]) as transaction:
            transaction.stage_bytes(self.target, b"changed")
            entry = transaction.manifest["entries"][0]
            stage = self.root / entry["stage"]
            original_unlink = Path.unlink

            def persistent_lock(path, missing_ok=False):
                if path == stage:
                    raise PermissionError("confidential exception content")
                return original_unlink(path, missing_ok=missing_ok)

            with patch.object(Path, "unlink", persistent_lock), patch.object(
                integrity, "_PERMISSION_RETRY_BUDGET", 0
            ), self.assertLogs("core.integrity", level="WARNING") as captured:
                integrity._cleanup_staged_files(self.root, [entry])
            self.assertEqual([record.getMessage() for record in captured.records], [f"{entry['stage']} PermissionError"])
            self.assertTrue(stage.exists())
        self.assertFalse(stage.exists())

    def test_hash_failure_before_manifest_registration_cleans_owned_temporary(self):
        original_hash = integrity._hash_file

        def fail_stage_hash(path):
            if path.name.startswith(".historico_comparacoes.json."):
                raise OSError("simulated failure before manifest registration")
            return original_hash(path)

        with self.assertRaisesRegex(OSError, "before manifest registration"):
            with integrity.AtomicFileTransaction(self.root, [self.target]) as transaction:
                with patch.object(integrity, "_hash_file", side_effect=fail_stage_hash):
                    transaction.stage_bytes(self.target, b"changed")
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_preparation_manifest_and_body_failures_clean_temporaries(self):
        original = self.target.read_bytes()
        for failure in ("writer", "validator", "manifest", "body", "interruption"):
            with self.subTest(failure=failure):
                def fail(_):
                    raise RuntimeError("simulated preparation failure")

                with self.assertRaises((RuntimeError, KeyboardInterrupt)):
                    with integrity.AtomicFileTransaction(self.root, [self.target]) as transaction:
                        if failure == "writer":
                            transaction.stage_file(self.target, fail)
                        elif failure == "validator":
                            transaction.stage_bytes(self.target, b"changed", fail)
                        elif failure == "manifest":
                            with patch.object(integrity, "_persist_manifest", side_effect=RuntimeError("manifest failure")):
                                transaction.stage_bytes(self.target, b"changed")
                        elif failure == "interruption":
                            def interrupt(_):
                                raise KeyboardInterrupt()
                            transaction.stage_file(self.target, interrupt)
                        else:
                            transaction.stage_bytes(self.target, b"changed")
                            raise RuntimeError("body failed before commit")
                self.assertEqual(self.target.read_bytes(), original)
                self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_recovery_cleans_durable_stage_after_interruption(self):
        transaction = integrity.AtomicFileTransaction(self.root, [self.target])
        transaction.__enter__()
        transaction.stage_bytes(self.target, b"changed")
        transaction.close_after_interruption()
        integrity.recover_pending_transactions(self.root)
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_changed_stage_is_preserved_by_hash_checked_cleanup(self):
        stage = None
        with integrity.AtomicFileTransaction(self.root, [self.target]) as transaction:
            transaction.stage_bytes(self.target, b"changed")
            stage = self.root / transaction.manifest["entries"][0]["stage"]
            stage.write_bytes(b"external change")
        self.assertEqual(stage.read_bytes(), b"external change")


if __name__ == "__main__":
    unittest.main()
