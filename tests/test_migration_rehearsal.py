"""Stage-8 checks with fictional files only; no Docker or operational data."""

import importlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from persistence.config import PersistenceError, PersistenceSettings

AVAILABLE = all(importlib.util.find_spec(n) is not None for n in ("psycopg", "cryptography"))


@unittest.skipUnless(AVAILABLE, "Optional PostgreSQL dependencies absent")
class MigrationRehearsalTests(unittest.TestCase):
    def setUp(self):
        self.migration = importlib.import_module("persistence.migration")
        self.recovery = importlib.import_module("persistence.recovery")
        self.stack_module = importlib.import_module("scripts.rehearsal_stack")
        self.workspace = self.stack_module.WORKSPACE
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=self.workspace, prefix="unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.domain = importlib.import_module("main")
        self.fixture = importlib.import_module("scripts.rehearsal_fixtures").generate(self.root / "bundle", self.domain)
        self.key = importlib.import_module("cryptography.fernet").Fernet.generate_key()

    def bundle(self):
        return self.migration.MigrationBundle(self.fixture, self.domain)

    def rewrite(self, role, document):
        manifest_path = self.fixture / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        content = json.dumps(document, ensure_ascii=False).encode()
        (self.fixture / manifest["files"][role]["path"]).write_bytes(content)
        manifest["files"][role]["sha256"] = self.migration.sha(content)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def test_dry_run_is_deterministic_and_counts_provenance(self):
        bundle = self.bundle()
        plan = bundle.dry_run()
        self.assertEqual(plan, bundle.dry_run())
        self.assertFalse(plan["writes"])
        self.assertEqual(plan["equipment"], 4)
        self.assertEqual(plan["source_rows"], {"detalhes": 4, "endpoint": 4})
        self.assertEqual(plan["duplicate_serial_groups"], 1)
        self.assertEqual(plan["legacy_events"], 13)

    def test_corrupted_file_rejected_before_import(self):
        (self.fixture / "estado.json").write_bytes(b"{}")
        with self.assertRaises(PersistenceError) as failure:
            self.bundle()
        self.assertEqual(failure.exception.status_code, 409)

    def test_path_escape_and_foreign_root_rejected(self):
        manifest_path = self.fixture / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["files"]["estado"]["path"] = "../outside.json"
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaises(PersistenceError):
            self.bundle()
        with self.assertRaises(PersistenceError):
            self.migration.MigrationBundle(self.root.parents[3], self.domain)

    def test_duplicate_json_keys_and_nonfinite_numbers_rejected(self):
        for content in (b'{"a":1,"a":2}', b'{"value":NaN}', b'{"value":Infinity}'):
            with self.subTest(content=content), self.assertRaises(PersistenceError):
                self.migration.parse_json(content)

    def test_notes_allow_empty_and_2000_but_reject_2001(self):
        bundle = self.bundle()
        self.assertEqual(len(bundle.history["historico"][0]["comparacao"]["apelidos_sem_atualizacao"][0]["anotacao"]), 2000)
        self.assertEqual(bundle.history["historico"][1]["comparacao"]["sem_acesso_7_dias"][0]["anotacao"], "")
        history = bundle.history
        history["anotacoes"][0]["anotacao"] = "a" * 2001
        self.rewrite("historico", history)
        with self.assertRaises(PersistenceError):
            self.bundle()

    def test_duplicate_event_and_line_identities_rejected(self):
        history = self.bundle().history
        history["historico"].append(history["historico"][0])
        self.rewrite("historico", history)
        with self.assertRaises(PersistenceError):
            self.bundle()

    def test_invalid_unit_id_rejected_during_offline_plan(self):
        state = self.bundle().state
        state["unidades"][0]["id"] = "900"
        self.rewrite("estado", state)
        with self.assertRaises(PersistenceError):
            self.bundle()

    def test_invalid_alias_event_rejected_before_writes(self):
        state = self.bundle().state
        state["historico_apelidos"][0]["id"] = 2
        self.rewrite("estado", state)
        with self.assertRaises(PersistenceError):
            self.bundle()

    def test_invalid_shared_fingerprint_rejected_offline(self):
        history = self.bundle().history
        history["anotacoes"][0]["linha_hash"] = "bad"
        self.rewrite("historico", history)
        with self.assertRaises(PersistenceError):
            self.bundle()

    def test_legacy_note_dictionary_limit_checked_offline(self):
        history = self.bundle().history
        item = history["historico"][0]["comparacao"]["apelidos_sem_atualizacao"][0]
        item.pop("anotacao")
        history["historico"][0]["comparacao"]["anotacoes"] = {"apelidos_sem_atualizacao:0": "a" * 2001}
        self.rewrite("historico", history)
        with self.assertRaises(PersistenceError):
            self.bundle()

    def test_changed_bundle_keeps_id_but_changes_fingerprint(self):
        original = self.bundle()
        state = json.loads(original.data["estado"])
        state["apelidos"][0]["apelido"] = "CHANGED"
        self.rewrite("estado", state)
        changed = self.bundle()
        self.assertEqual(original.identifier, changed.identifier)
        self.assertNotEqual(original.fingerprint, changed.fingerprint)

    def test_duplicate_line_identity_rejected(self):
        history = self.bundle().history
        rows = history["historico"][0]["comparacao"]["apelidos_sem_atualizacao"]
        rows.append(dict(rows[0]))
        self.rewrite("historico", history)
        with self.assertRaises(PersistenceError):
            self.bundle()

    def test_invalid_original_dates_are_preserved(self):
        bundle = self.bundle()
        event = next(e for e in bundle.history["historico"] if e["id"] == "legacy-integer")
        self.assertEqual(event["horario"], "invalid-original-date")
        self.assertIsNone(self.migration.parsed_time(event["horario"]))

    def test_ordinary_backend_cannot_import(self):
        for backend in (SimpleNamespace(rehearsal=False, authenticated=True), SimpleNamespace(rehearsal=True, authenticated=False)):
            with self.assertRaises(PersistenceError) as failure:
                self.bundle().apply(backend)
            self.assertEqual(failure.exception.status_code, 403)

    def test_environment_cannot_enable_rehearsal_profile(self):
        self.assertFalse(PersistenceSettings.from_environment({"SIMPRESS_REHEARSAL": "1"}).rehearsal)
        env = {"SIMPRESS_PERSISTENCE_BACKEND": "postgres", "SIMPRESS_POSTGRES_LOCAL_PILOT": "1",
               "SIMPRESS_REHEARSAL": "1", "SIMPRESS_DATABASE_URL": "postgresql://simpress_piloto_login:synthetic@127.0.0.1:55422/postgres"}
        with self.assertRaises(PersistenceError):
            PersistenceSettings.from_environment(env)

    def test_rehearsal_names_cannot_adopt_primary(self):
        for identifier, suffix in (("simpress-dev", "source"), ("123456789abc", "dev"), ("../../", "restore")):
            with self.assertRaises(RuntimeError):
                self.stack_module.RehearsalStack(identifier, suffix)

    def test_wrong_key_and_tampered_ciphertext_rejected(self):
        Fernet = importlib.import_module("cryptography.fernet").Fernet
        path = self.root / "synthetic.enc"
        path.write_bytes(Fernet(self.key).encrypt(b"synthetic-content"))
        for key in (Fernet.generate_key(), self.key):
            if key == self.key:
                path.write_bytes(path.read_bytes()[:-12] + b"tampered!!!!")
            with self.assertRaises(PersistenceError):
                with self.recovery.opened(path, key, SimpleNamespace(root=self.root)):
                    self.fail("Invalid archive opened")

    def test_unexpected_encrypted_archive_entries_rejected(self):
        Fernet = importlib.import_module("cryptography.fernet").Fernet
        memory = io.BytesIO()
        with zipfile.ZipFile(memory, "w") as archive:
            archive.writestr("unexpected.json", "{}")
        path = self.root / "unexpected.enc"
        path.write_bytes(Fernet(self.key).encrypt(memory.getvalue()))
        with self.assertRaises(PersistenceError):
            with self.recovery.opened(path, self.key, SimpleNamespace(root=self.root)):
                self.fail("Unexpected archive opened")

    def test_snapshot_digest_ignores_row_order_but_preserves_numeric_types(self):
        snapshot = {t: [] for t in self.recovery.TABLES}
        snapshot["operacoes"] = [{"v": 1}, {"v": 2}]
        first = self.recovery.domain_digest(snapshot)
        snapshot["operacoes"].reverse()
        self.assertEqual(first, self.recovery.domain_digest(snapshot))
        snapshot["operacoes"][1]["v"] = 1.0
        self.assertNotEqual(first, self.recovery.domain_digest(snapshot))

    def test_receipt_is_atomic_and_leaves_no_temporary_file(self):
        receipt = self.root / "receipt.json"
        self.recovery.write_receipt(receipt, {"state": "uploading"})
        with patch.object(self.recovery.os, "replace", side_effect=OSError("Synthetic interruption")):
            with self.assertRaises(OSError):
                self.recovery.write_receipt(receipt, {"state": "confirmed"})
        self.assertEqual(json.loads(receipt.read_bytes()), {"state": "uploading"})
        self.assertEqual(list(self.root.glob(".recovery-*")), [])

    def test_self_reference_cycle_rejected_without_disabling_constraints(self):
        class Connection:
            def execute(self, *args):
                return SimpleNamespace(fetchall=lambda: [{"column_name": "evento_id"}])
        rows = [{"evento_id": "a", "restauracao_de_evento_id": "b"}, {"evento_id": "b", "restauracao_de_evento_id": "a"}]
        with self.assertRaises(PersistenceError):
            self.recovery.insert_rows(Connection(), "simpress", "eventos_comparacao", rows)
