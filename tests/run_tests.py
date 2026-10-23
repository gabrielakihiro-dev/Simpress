"""Run tests without loading or recovering local Simpress data at import time."""

import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = PROJECT_ROOT / "tests"
sys.path.insert(0, str(PROJECT_ROOT))
FIXTURE_ONLY_MODULES = (
    "test_integrity_transactions",
    "test_integrity_workflows",
)


def run() -> bool:
    with tempfile.TemporaryDirectory(
        prefix=".simpress-test-",
        dir=PROJECT_ROOT,
        ignore_cleanup_errors=True,
    ) as temporary_root:
        tempfile.tempdir = temporary_root
        from core import integrity
        import openpyxl

        # Keep fixture discovery independent from real operational workbooks.
        with (
            patch.object(integrity, "recover_pending_transactions", return_value=None),
            patch.object(
                openpyxl,
                "load_workbook",
                side_effect=RuntimeError("operational workbook access blocked during test import"),
            ),
        ):
            suite = unittest.defaultTestLoader.discover(
                start_dir=str(TESTS_DIR),
                pattern="test*.py",
                top_level_dir=str(TESTS_DIR),
            )

        for module_name in FIXTURE_ONLY_MODULES:
            module = importlib.import_module(module_name)
            module.PROJECT_ROOT = Path(temporary_root)

        result = unittest.TextTestRunner(verbosity=2).run(suite)
        return result.wasSuccessful()


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
