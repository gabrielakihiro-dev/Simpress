"""Polled read routes give up quickly while an import owns the global lock."""

from contextlib import redirect_stdout
import io
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

with (
    patch("core.integrity.recover_pending_transactions", return_value=None),
    patch("openpyxl.load_workbook", side_effect=RuntimeError("operational data blocked")),
    redirect_stdout(io.StringIO()),
):
    import main

from core.integrity import FileBusyError, lock_paths


class ReadLockTimeoutTests(unittest.TestCase):
    def test_export_counts_fail_fast_while_the_global_lock_is_held(self):
        transaction_root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(main, "TRANSACTION_ROOT", transaction_root))
        held = threading.Event()
        release = threading.Event()

        def hold_global_lock():
            with lock_paths([transaction_root / ".atomic-transactions"]):
                held.set()
                release.wait(20)

        holder = threading.Thread(target=hold_global_lock)
        holder.start()
        try:
            self.assertTrue(held.wait(5))
            started = time.monotonic()
            with self.assertRaises(FileBusyError):
                main.count_export_changes()
            elapsed = time.monotonic() - started
        finally:
            release.set()
            holder.join(10)

        self.assertLess(elapsed, main.READ_LOCK_TIMEOUT_SECONDS + 2)


if __name__ == "__main__":
    unittest.main()
