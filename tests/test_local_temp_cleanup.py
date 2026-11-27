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
        with patch("core.limpeza_temporarios.time.time", return_value=now):
            result = cleanup_local_temps(self.root)
        self.assertTrue(old.exists())
        self.assertEqual(result["diferentes_preservados"], 1)

    def test_quarantine_report_failure_preserves_snapshot(self):
        self.target.write_bytes(b"committed history")
        old = self._temporary("a1b2c3d4", b"distinct", age_hours=8 * 24)
        with patch("core.limpeza_temporarios.json.dump", side_effect=OSError("report failure")):
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


    def test_items_list_what_was_ready_and_what_was_done(self):
        self.target.write_bytes(b"committed history")
        self._temporary("a1b2c3d4", b"committed history", age_hours=30)
        self._temporary("e5f6g7h8", b"distinct", age_hours=8 * 24)
        preview = []
        cleanup_local_temps(self.root, dry_run=True, itens=preview)
        expected = [
            {"acao": "remover", "area": "state", "bytes": 17,
             "caminho": "historico_comparacoes/.historico_comparacoes.json.a1b2c3d4.tmp"},
            {"acao": "quarentena", "area": "state", "bytes": 8,
             "caminho": "historico_comparacoes/.historico_comparacoes.json.e5f6g7h8.tmp"},
        ]
        self.assertEqual(preview, expected)
        aplicados = []
        cleanup_local_temps(self.root, itens=aplicados)
        self.assertEqual(aplicados, expected)

    def test_without_recovery_pending_transactions_only_refuse(self):
        self.target.write_bytes(b"committed history")
        duplicate = self._temporary("a1b2c3d4", b"committed history", age_hours=30)
        pending = self.root / ".transactions" / "pending"
        pending.parent.mkdir()
        pending.write_text("fixture", encoding="utf-8")
        with patch("core.integrity.recover_pending_transactions") as recover:
            with self.assertRaises(CleanupBlockedError) as raised:
                cleanup_local_temps(self.root, recuperar_transacoes=False)
        recover.assert_not_called()
        self.assertEqual(raised.exception.codigo, "transacoes")
        self.assertEqual(pending.read_text(encoding="utf-8"), "fixture")
        self.assertTrue(duplicate.exists())
        pending.unlink()
        (self.root / "data" / "planilhas_entrada" / ".upload-staging-x").mkdir(parents=True)
        with self.assertRaises(CleanupBlockedError) as raised:
            cleanup_local_temps(self.root, recuperar_transacoes=False)
        self.assertEqual(raised.exception.codigo, "migracao")

    def test_linked_folder_outside_the_root_is_never_scanned(self):
        outside_context = tempfile.TemporaryDirectory(prefix=".temp-cleanup-outside-", dir=tempfile.gettempdir())
        self.addCleanup(outside_context.cleanup)
        outside = Path(outside_context.name)
        (outside / "alvo.json").write_bytes(b"same")
        outside_temporary = outside / ".alvo.json.a1b2c3d4.tmp"
        outside_temporary.write_bytes(b"same")
        timestamp = time.time() - 30 * 3600
        os.utime(outside_temporary, (timestamp, timestamp))
        try:
            os.symlink(outside, self.history_dir / "link", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Sem permissão para criar link simbólico.")
        result = cleanup_local_temps(self.root)
        self.assertEqual(result["examinados"], 0)
        self.assertTrue(outside_temporary.exists())

    def test_dry_run_takes_no_lock_and_does_not_count_a_busy_target_as_blocked(self):
        from core import integrity

        self.target.write_bytes(b"committed history")
        duplicate = self._temporary("a1b2c3d4", b"committed history", age_hours=30)
        before = sorted(p.name for p in self.history_dir.iterdir())
        busy = integrity.FileBusyError("busy")  # the target is locked by another writer
        with patch("core.integrity.lock_paths", side_effect=busy) as lock_paths:
            preview = cleanup_local_temps(self.root, dry_run=True)
            lock_paths.assert_not_called()
            self.assertEqual(sorted(p.name for p in self.history_dir.iterdir()), before)  # no .lock created
            applied = cleanup_local_temps(self.root)
        self.assertEqual((preview["iguais_prontos"], preview["bloqueados_preservados"]), (1, 0))
        self.assertEqual((applied["removidos"], applied["bloqueados_preservados"]), (0, 1))
        self.assertTrue(duplicate.exists())

    def test_one_held_temporary_does_not_stop_the_others(self):
        from core import limpeza_temporarios

        first_target = self.history_dir / "a.json"
        second_target = self.history_dir / "b.json"
        first_target.write_bytes(b"x")
        second_target.write_bytes(b"y")
        held = self.history_dir / ".a.json.abcd1234.tmp"
        free = self.history_dir / ".b.json.abcd1234.tmp"
        for temporary, content in ((held, b"x"), (free, b"y")):
            temporary.write_bytes(content)
            timestamp = time.time() - 30 * 3600
            os.utime(temporary, (timestamp, timestamp))
        real_digest = limpeza_temporarios._digest

        def digest(path):
            if path == held:
                raise PermissionError("held by another program")
            return real_digest(path)

        with patch("core.limpeza_temporarios._digest", side_effect=digest):
            preview = cleanup_local_temps(self.root, dry_run=True)
            applied = cleanup_local_temps(self.root)
        self.assertEqual((preview["iguais_prontos"], preview["bloqueados_preservados"]), (1, 1))
        self.assertEqual((applied["removidos"], applied["bloqueados_preservados"]), (1, 1))
        self.assertTrue(held.exists())
        self.assertFalse(free.exists())

    def test_temporary_that_vanishes_or_is_held_at_stat_is_skipped(self):
        self.target.write_bytes(b"committed history")
        vanished = self._temporary("a1b2c3d4", b"committed history", age_hours=30)
        held = self._temporary("e5f6g7h8", b"committed history", age_hours=30)
        real_stat = Path.stat

        def stat(path, *args, **kwargs):
            if not kwargs.get("follow_symlinks", True):  # is_symlink and friends keep working
                return real_stat(path, *args, **kwargs)
            if path == vanished:
                raise FileNotFoundError(2, "gone")
            if path == held:
                raise PermissionError(13, "held")
            return real_stat(path, *args, **kwargs)

        with patch.object(Path, "stat", stat):
            result = cleanup_local_temps(self.root)
        self.assertEqual((result["examinados"], result["bloqueados_preservados"], result["removidos"]), (2, 1, 0))

if __name__ == "__main__":
    unittest.main()
