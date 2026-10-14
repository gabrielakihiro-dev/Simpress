"""PermissionError backoff for file replacement under OneDrive/antivirus locks."""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from core import integrity


# Longer than the old fixed retry window (≈0,85 s), well inside the new budget.
TRANSIENT_LOCK_SECONDS = 1.5


class PermissionBackoffTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".permission-backoff-")
        self.root = Path(self.temp_context.name)

    def tearDown(self):
        self.temp_context.cleanup()

    def _replace_locked_until(self, target: Path, release_at: float):
        original_replace = os.replace
        calls = []

        def locked_replace(source, destination):
            if Path(destination) == target:
                calls.append(time.monotonic())
                if time.monotonic() < release_at:
                    raise PermissionError(13, "simulated OneDrive sync lock")
            return original_replace(source, destination)

        return locked_replace, calls

    def test_transient_lock_longer_than_old_window_is_retried_until_replace_succeeds(self):
        target = self.root / "sync-held.json"
        target.write_bytes(b"before")
        locked_replace, calls = self._replace_locked_until(target, time.monotonic() + TRANSIENT_LOCK_SECONDS)

        with patch("core.integrity.os.replace", side_effect=locked_replace):
            integrity.atomic_write_bytes(target, b"after")

        self.assertEqual(target.read_bytes(), b"after")
        self.assertGreater(len(calls), 1)
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_transaction_commit_survives_transient_lock_on_replace(self):
        target = self.root / "planilha.xlsx"
        target.write_bytes(b"before")
        locked_replace, _ = self._replace_locked_until(target, time.monotonic() + TRANSIENT_LOCK_SECONDS)

        with patch("core.integrity.os.replace", side_effect=locked_replace):
            with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
                transaction.stage_bytes(target, b"after")
                transaction.commit()

        self.assertEqual(target.read_bytes(), b"after")
        self.assertEqual(list((self.root / ".transactions").iterdir()), [])

    def test_transaction_delete_survives_transient_lock_on_unlink(self):
        target = self.root / "obsoleto.json"
        target.write_bytes(b"remove me")
        release_at = time.monotonic() + TRANSIENT_LOCK_SECONDS
        original_unlink = Path.unlink

        def locked_unlink(path, missing_ok=False):
            if path == target and time.monotonic() < release_at:
                raise PermissionError(13, "simulated antivirus scan")
            return original_unlink(path, missing_ok=missing_ok)

        with patch.object(Path, "unlink", locked_unlink):
            with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
                transaction.stage_delete(target)
                transaction.commit()

        self.assertFalse(target.exists())
        self.assertEqual(list((self.root / ".transactions").iterdir()), [])

    def test_persistent_lock_still_raises_file_busy_after_budget_and_keeps_original(self):
        target = self.root / "aberto-no-excel.xlsx"
        target.write_bytes(b"unchanged")
        locked_replace, calls = self._replace_locked_until(target, float("inf"))
        budget = 0.4

        started = time.monotonic()
        with patch("core.integrity.os.replace", side_effect=locked_replace), patch(
            "core.integrity._PERMISSION_RETRY_BUDGET", budget
        ):
            with self.assertRaisesRegex(integrity.FileBusyError, "Feche a planilha"):
                with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
                    transaction.stage_bytes(target, b"replacement")
                    transaction.commit()
        elapsed = time.monotonic() - started

        self.assertEqual(target.read_bytes(), b"unchanged")
        self.assertGreater(len(calls), 1)
        self.assertGreaterEqual(calls[-1] - calls[0], budget * 0.9)
        self.assertLess(elapsed, budget + 2.0)
        self.assertEqual(list((self.root / ".transactions").iterdir()), [])

    def test_persistent_lock_on_unlink_raises_file_busy(self):
        target = self.root / "travado.json"
        target.write_bytes(b"keep")
        original_unlink = Path.unlink

        def locked_unlink(path, missing_ok=False):
            if path == target:
                raise PermissionError(13, "simulated Excel lock")
            return original_unlink(path, missing_ok=missing_ok)

        with patch.object(Path, "unlink", locked_unlink), patch("core.integrity._PERMISSION_RETRY_BUDGET", 0.2):
            with self.assertRaisesRegex(integrity.FileBusyError, "Feche 'travado.json'"):
                with integrity.AtomicFileTransaction(self.root, [target]) as transaction:
                    transaction.stage_delete(target)
                    transaction.commit()

        self.assertEqual(target.read_bytes(), b"keep")

    def test_backoff_delays_grow_with_jitter_and_respect_cap(self):
        sleeps = []
        with patch("core.integrity.time.sleep", side_effect=sleeps.append), patch(
            "core.integrity._PERMISSION_RETRY_BUDGET", 3600
        ):
            backoff = integrity._PermissionBackoff()
            for _ in range(8):
                self.assertTrue(backoff.wait())

        base = integrity._PERMISSION_RETRY_BASE_DELAY
        cap = integrity._PERMISSION_RETRY_MAX_DELAY
        for index, delay in enumerate(sleeps):
            nominal = min(base * 2**index, cap)
            self.assertGreaterEqual(delay, nominal * 0.5)
            self.assertLessEqual(delay, nominal)


if __name__ == "__main__":
    unittest.main()
