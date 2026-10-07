import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.migrate_local_data import MigrationConflictError, migrate_local_data

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class LocalDataMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".data-migration-test-", dir=PROJECT_ROOT)
        self.root = Path(self.temp_context.name)

    def tearDown(self):
        self.temp_context.cleanup()

    def test_legacy_data_moves_without_changing_backups_or_overwriting_equal_template(self):
        legacy_inputs = self.root / "planilhas_entrada"
        legacy_backup = legacy_inputs / "_backups" / "20261004-fixture" / "endpoint" / "inventory.xlsx"
        legacy_backup.parent.mkdir(parents=True)
        legacy_backup.write_bytes(b"fixture backup bytes")
        template = legacy_inputs / "(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"
        template.parent.mkdir(parents=True, exist_ok=True)
        template.write_bytes(b"fixture template")

        current_template = self.root / "data" / "planilhas_entrada" / template.name
        current_template.parent.mkdir(parents=True)
        current_template.write_bytes(template.read_bytes())

        legacy_alias = self.root / "apelidos_modificados" / "apelidos_modificados.json"
        legacy_alias.parent.mkdir(parents=True)
        legacy_alias.write_text('{"SN-FICTICIO":"HOST-FICTICIO"}', encoding="utf-8")
        legacy_history = self.root / "historico_comparacoes" / "historico_comparacoes.json"
        legacy_history.parent.mkdir(parents=True)
        legacy_history.write_text("[]", encoding="utf-8")
        legacy_units = self.root / "unidades_custom.json"
        legacy_units.write_text("[]", encoding="utf-8")

        result = migrate_local_data(self.root)

        migrated_backup = self.root / "data" / "planilhas_entrada" / "_backups" / "20261004-fixture" / "endpoint" / "inventory.xlsx"
        self.assertEqual(migrated_backup.read_bytes(), b"fixture backup bytes")
        self.assertEqual(current_template.read_bytes(), b"fixture template")
        self.assertFalse(legacy_inputs.exists())
        self.assertFalse(legacy_alias.parent.exists())
        self.assertFalse(legacy_history.parent.exists())
        self.assertEqual(
            (self.root / "data" / "state" / "apelidos_modificados" / legacy_alias.name).read_text(encoding="utf-8"),
            '{"SN-FICTICIO":"HOST-FICTICIO"}',
        )
        self.assertEqual(
            (self.root / "data" / "state" / "historico_comparacoes" / legacy_history.name).read_text(encoding="utf-8"),
            "[]",
        )
        self.assertEqual(
            (self.root / "data" / "state" / "unidades_custom.json").read_text(encoding="utf-8"),
            "[]",
        )
        self.assertEqual(result["duplicatas_iguais_removidas"], 1)

    def test_conflict_is_detected_before_any_legacy_file_moves(self):
        legacy_input = self.root / "planilhas_entrada" / "inventory.xlsx"
        legacy_input.parent.mkdir(parents=True)
        legacy_input.write_bytes(b"legacy fixture")
        legacy_alias = self.root / "apelidos_modificados" / "apelidos_modificados.json"
        legacy_alias.parent.mkdir(parents=True)
        legacy_alias.write_text("{}", encoding="utf-8")
        current_alias = self.root / "data" / "state" / "apelidos_modificados" / legacy_alias.name
        current_alias.parent.mkdir(parents=True)
        current_alias.write_text('{"fixture":"different"}', encoding="utf-8")

        with self.assertRaises(MigrationConflictError):
            migrate_local_data(self.root)

        self.assertEqual(legacy_input.read_bytes(), b"legacy fixture")
        self.assertEqual(legacy_alias.read_text(encoding="utf-8"), "{}")
        self.assertFalse((self.root / "data" / "planilhas_entrada" / legacy_input.name).exists())
        self.assertEqual(current_alias.read_text(encoding="utf-8"), '{"fixture":"different"}')

    def test_different_legacy_transfer_template_is_archived_without_replacing_active_template(self):
        legacy_template = self.root / "planilhas_entrada" / "(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"
        legacy_template.parent.mkdir(parents=True)
        legacy_template.write_bytes(b"newer legacy template")

        active_template = self.root / "data" / "planilhas_entrada" / legacy_template.name
        active_template.parent.mkdir(parents=True)
        active_template.write_bytes(b"current active template")

        result = migrate_local_data(self.root)

        import hashlib

        digest = hashlib.sha256(b"newer legacy template").hexdigest()
        archived_template = (
            self.root
            / "data"
            / "migration_conflicts"
            / "planilhas_entrada"
            / f"(MODELO) - TRANSFERENCIA SIMPRESS__sha256-{digest}.xlsx"
        )
        self.assertEqual(active_template.read_bytes(), b"current active template")
        self.assertEqual(archived_template.read_bytes(), b"newer legacy template")
        self.assertEqual(legacy_template.read_bytes(), b"newer legacy template")
        self.assertTrue(legacy_template.parent.is_dir())
        self.assertEqual(result["conflitos_preservados"], 1)

        repeated_result = migrate_local_data(self.root)
        self.assertEqual(legacy_template.read_bytes(), b"newer legacy template")
        self.assertEqual(archived_template.read_bytes(), b"newer legacy template")
        self.assertEqual(repeated_result["movidos"], 0)
        self.assertEqual(repeated_result["conflitos_preservados"], 1)

    def test_pending_transaction_is_recovered_before_migration(self):
        legacy_input = self.root / "planilhas_entrada" / "inventory.xlsx"
        legacy_input.parent.mkdir(parents=True)
        legacy_input.write_bytes(b"fixture")
        pending = self.root / ".transactions" / "pending"
        pending.parent.mkdir()
        pending.write_text("fixture manifest", encoding="utf-8")

        def recover_fixture_transaction(project_root):
            self.assertEqual(project_root, self.root.resolve())
            pending.unlink()
            pending.parent.rmdir()

        with patch("integrity.recover_pending_transactions", side_effect=recover_fixture_transaction) as recover:
            migrate_local_data(self.root)
        recover.assert_called_once_with(self.root.resolve())

        self.assertFalse(legacy_input.exists())
        self.assertEqual(
            (self.root / "data" / "planilhas_entrada" / legacy_input.name).read_bytes(),
            b"fixture",
        )

    def test_failed_transaction_recovery_preserves_legacy_files(self):
        legacy_input = self.root / "planilhas_entrada" / "inventory.xlsx"
        legacy_input.parent.mkdir(parents=True)
        legacy_input.write_bytes(b"fixture")
        pending = self.root / ".transactions" / "pending"
        pending.parent.mkdir()
        pending.write_text("fixture manifest", encoding="utf-8")

        with patch("integrity.recover_pending_transactions", side_effect=RuntimeError("fixture recovery failure")):
            with self.assertRaisesRegex(MigrationConflictError, "(?i)não foi possível concluir a recuperação"):
                migrate_local_data(self.root)

        self.assertTrue(legacy_input.is_file())
        self.assertTrue(pending.is_file())
        self.assertFalse((self.root / "data" / "planilhas_entrada").exists())

    def test_incomplete_upload_blocks_migration_without_moving_files(self):
        legacy_input = self.root / "planilhas_entrada" / "inventory.xlsx"
        legacy_input.parent.mkdir(parents=True)
        legacy_input.write_bytes(b"fixture")
        staging = legacy_input.parent / ".upload-staging-pending"
        staging.mkdir()

        with self.assertRaisesRegex(MigrationConflictError, "upload temporário"):
            migrate_local_data(self.root)

        self.assertTrue(legacy_input.is_file())
        self.assertTrue(staging.is_dir())
        self.assertFalse((self.root / "data" / "planilhas_entrada").exists())


if __name__ == "__main__":
    unittest.main()
