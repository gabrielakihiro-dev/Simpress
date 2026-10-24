"""lock_paths nesting and cross-thread exclusion on temporary files only."""

import tempfile
import threading
import time
import unittest
from pathlib import Path

from core.integrity import FileBusyError, lock_paths


def try_lock(target, timeout, results):
    try:
        with lock_paths([target], timeout=timeout):
            results.append("acquired")
    except FileBusyError:
        results.append("busy")


class LockPathsReentrancyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.target = Path(self._tmp.name) / "book.xlsx"

    def other_thread(self, timeout=0.3):
        results = []
        thread = threading.Thread(target=try_lock, args=(self.target, timeout, results))
        thread.start()
        thread.join()
        return results

    def test_same_thread_can_nest_without_waiting(self):
        started = time.monotonic()
        with lock_paths([self.target]):
            with lock_paths([self.target, self.target], timeout=2):
                pass
        self.assertLess(time.monotonic() - started, 1.0)

    def test_other_thread_stays_blocked_while_nested_and_after_inner_exit(self):
        with lock_paths([self.target]):
            with lock_paths([self.target]):
                self.assertEqual(self.other_thread(), ["busy"])
            self.assertEqual(self.other_thread(), ["busy"])

    def test_other_thread_acquires_after_outer_exit(self):
        with lock_paths([self.target]):
            with lock_paths([self.target]):
                pass
        self.assertEqual(self.other_thread(), ["acquired"])

    def test_released_after_exception_in_nested_block(self):
        with self.assertRaises(ValueError):
            with lock_paths([self.target]):
                with lock_paths([self.target]):
                    raise ValueError
        self.assertEqual(self.other_thread(), ["acquired"])


if __name__ == "__main__":
    unittest.main()
