import os
import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import patch

from scripts.cleanup_local_temps import CleanupBlockedError, QUARANTINE_DIRECTORY, cleanup_local_temps


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class LocalTemporaryCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".temp-cleanup-test-", dir=tempfile.gettempdir())
        self.root = Path(self.temp_context.name)
        self.history_dir = self.root / "data" / "state" / "historico_comparacoes"
        self.history_dir.mkdir(parents=True)
        self.target = self.history_dir / "historico_comparacoes.json"

    def tearDown(self):
        self.temp_context.cleanup()

    def _temporary(self, suffix: str, contents: bytes, *, age_hours: float) -> Path:
        temporary = self.history_dir / f".historico_comparacoes.json.{suffix}.tmp"
        temporary.write_bytes(contents)
        timestamp = time.time() - age_hours * 3600
        os.utime(temporary, (timestamp, timestamp))
        return temporary

    def test_old_identical_temporary_is_removed_but_different_snapshot_is_preserved(self):
        self.target.write_bytes(b"committed history")
        duplicate = self._temporary("a1b2c3d4", b"committed history", age_hours=30)
        distinct_snapshot = self._temporary("e5f6g7h8", b"older valid history", age_hours=30)

        result = cleanup_local_temps(self.root)

        self.assertFalse(duplicate.exists())
        self.assertEqual(distinct_snapshot.read_bytes(), b"older valid history")
        self.assertEqual(result["removidos"], 1)
        self.assertEqual(result["diferentes_preservados"], 1)

    def test_dry_run_reports_an_identical_temporary_without_removing_it(self):
        self.target.write_bytes(b"committed history")
        duplicate = self._temporary("a1b2c3d4", b"committed history", age_hours=30)

        result = cleanup_local_temps(self.root, dry_run=True)

        self.assertTrue(duplicate.exists())
        self.assertEqual(result["iguais_prontos"], 1)
        self.assertEqual(result["removidos"], 0)

    def test_workbook_temporary_matching_a_committed_backup_is_safe_to_remove(self):
        input_dir = self.root / "data" / "planilhas_entrada"
        input_dir.mkdir(parents=True)
        target = input_dir / "inventory.xlsx"
        target.write_bytes(b"current workbook")
        backup = input_dir / "_backups" / "20261004-fixture" / "detalhes" / target.name
        backup.parent.mkdir(parents=True)
        backup.write_bytes(b"previous workbook")
        temporary = input_dir / ".inventory.xlsx.a1b2c3d4.tmp"
        temporary.write_bytes(backup.read_bytes())
        timestamp = time.time() - 30 * 3600
        os.utime(temporary, (timestamp, timestamp))

        result = cleanup_local_temps(self.root)

        self.assertFalse(temporary.exists())
        self.assertEqual(backup.read_bytes(), b"previous workbook")
        self.assertEqual(result["removidos"], 1)

    def test_recent_identical_temporary_is_preserved_during_grace_period(self):
        self.target.write_bytes(b"committed history")
        recent = self._temporary("a1b2c3d4", b"committed history", age_hours=2)

        result = cleanup_local_temps(self.root)

        self.assertTrue(recent.exists())
        self.assertEqual(result["recentes_preservados"], 1)
        self.assertEqual(result["removidos"], 0)

    def test_failed_recovery_and_pending_upload_block_cleanup(self):
        self.target.write_bytes(b"committed history")
        duplicate = self._temporary("a1b2c3d4", b"committed history", age_hours=30)
        transaction_dir = self.root / ".transactions"
        transaction_dir.mkdir()
        (transaction_dir / "pending").write_text("fixture", encoding="utf-8")

        with patch("core.integrity.recover_pending_transactions", side_effect=RuntimeError("fixture")):
            with self.assertRaises(CleanupBlockedError):
                cleanup_local_temps(self.root)
        self.assertTrue(duplicate.exists())

        (transaction_dir / "pending").unlink()
        transaction_dir.rmdir()
        upload_dir = self.root / "data" / "planilhas_entrada" / ".upload-staging-active"
        upload_dir.mkdir(parents=True)
        with self.assertRaisesRegex(CleanupBlockedError, "upload temporário"):
            cleanup_local_temps(self.root)
        self.assertTrue(duplicate.exists())

    def test_old_differing_snapshot_is_quarantined_with_complete_report_and_never_deleted(self):
        self.target.write_bytes(b"committed history")
        content = b"previous distinct history"
        snapshot = self._temporary("a1b2c3d4", content, age_hours=8 * 24)
        metadata = snapshot.stat()

        result = cleanup_local_temps(self.root)

        self.assertFalse(snapshot.exists())
        quarantine = self.history_dir / QUARANTINE_DIRECTORY
        archived = list(quarantine.glob(f"*/{snapshot.name}"))
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0].read_bytes(), content)
        report = json.loads((archived[0].parent / "relatorio.json").read_text(encoding="utf-8"))
        self.assertEqual(report["arquivos"], [{
            "nome": snapshot.name, "tamanho": len(content),
            "data_modificacao": datetime.fromtimestamp(metadata.st_mtime, timezone.utc).isoformat(),
            "sha256": hashlib.sha256(content).hexdigest(),
        }])
        self.assertEqual(result["quarentenados"], 1)
        self.assertEqual(result["removidos"], 0)
        again = cleanup_local_temps(self.root)
        self.assertEqual(again["examinados"], 0)
        self.assertEqual(archived[0].read_bytes(), content)
        self.assertEqual(self.target.read_bytes(), b"committed history")

    def test_quarantine_dry_run_and_seven_day_boundary_preserve_files(self):
        self.target.write_bytes(b"committed history")
        old = self._temporary("a1b2c3d4", b"distinct", age_hours=8 * 24)
        result = cleanup_local_temps(self.root, dry_run=True)
        self.assertEqual(result["quarentena_prontos"], 1)
        self.assertTrue(old.exists())
        self.assertFalse((self.history_dir / QUARANTINE_DIRECTORY).exists())
        now = old.stat().st_mtime + 7 * 24 * 3600
        with patch("scripts.cleanup_local_temps.time.time", return_value=now):
            result = cleanup_local_temps(self.root)
        self.assertTrue(old.exists())
        self.assertEqual(result["diferentes_preservados"], 1)

    def test_quarantine_report_failure_preserves_snapshot(self):
        self.target.write_bytes(b"committed history")
        old = self._temporary("a1b2c3d4", b"distinct", age_hours=8 * 24)
        with patch("scripts.cleanup_local_temps.json.dump", side_effect=OSError("report failure")):
            with self.assertRaises(OSError):
                cleanup_local_temps(self.root)
        self.assertEqual(old.read_bytes(), b"distinct")

    def test_old_snapshot_matching_backup_but_differing_from_target_is_never_deleted(self):
        input_dir = self.root / "data" / "planilhas_entrada"
        input_dir.mkdir(parents=True)
        target = input_dir / "inventory.xlsx"
        target.write_bytes(b"current workbook")
        backup = input_dir / "_backups" / "fixture" / target.name
        backup.parent.mkdir(parents=True)
        backup.write_bytes(b"previous workbook")
        old = input_dir / ".inventory.xlsx.a1b2c3d4.tmp"
        old.write_bytes(backup.read_bytes())
        timestamp = time.time() - 8 * 24 * 3600
        os.utime(old, (timestamp, timestamp))

        result = cleanup_local_temps(self.root)

        self.assertEqual(result["removidos"], 0)
        self.assertEqual(result["quarentenados"], 1)
        archived = list((input_dir / QUARANTINE_DIRECTORY).glob(f"*/{old.name}"))
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0].read_bytes(), b"previous workbook")


if __name__ == "__main__":
    unittest.main()
