"""Run tests without loading or recovering local Simpress data at import time."""

import importlib
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = PROJECT_ROOT / "tests"
TEMP_ROOT = PROJECT_ROOT / "TEMP"
sys.path.insert(0, str(PROJECT_ROOT))
from core.local_paths import is_link_or_junction

FIXTURE_ONLY_MODULES = (
    "test_integrity_transactions",
    "test_integrity_workflows",
)


def _remove_stale_temp_roots(max_age_seconds: int = 3600) -> None:
    """Drop old test roots, including legacy roots outside TEMP."""
    cutoff = time.time() - max_age_seconds
    patterns = (".simpress-test-*", ".bancada-softexpert-*")
    for parent in (PROJECT_ROOT, TEMP_ROOT):
        if is_link_or_junction(parent) or not parent.is_dir():
            continue
        for pattern in patterns:
            for stale in parent.glob(pattern):
                if is_link_or_junction(stale) or not stale.is_dir():
                    continue
                try:
                    old_enough = stale.stat().st_mtime < cutoff
                except OSError:
                    continue
                if old_enough:
                    shutil.rmtree(stale, ignore_errors=True)


def run() -> bool:
    if is_link_or_junction(TEMP_ROOT):
        raise RuntimeError("A pasta TEMP do projeto não pode ser um link ou junção.")
    TEMP_ROOT.mkdir(exist_ok=True)
    _remove_stale_temp_roots()
    with tempfile.TemporaryDirectory(
        prefix=".simpress-test-",
        dir=TEMP_ROOT,
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
