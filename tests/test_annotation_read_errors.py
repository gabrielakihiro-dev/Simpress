"""Unreadable annotation files are not the same as invalid ones."""

from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.datastructures import UploadFile

from core.integrity import AtomicFileTransaction, FileBusyError
from domains import history_annotations
from domains.history_annotations import (
    AnnotationReadError, build_history_annotation_record, history_annotation_record_path,
    history_annotation_row_fingerprint, load_history_annotations, resolve_history_annotations,
    save_history_annotation,
)
from domains.inventory_comparison import comparison_annotation_item_id
from domains.inventory_update import _copy_matching_history_annotations
from routers.inventory_history import create_inventory_history_router
from routers.operations import create_operations_router, TicketTimelineAnnotationPayload


ROOT = Path(__file__).resolve().parents[1]
SECRET_NOTE = "Texto sigiloso da anotação"


class LockedFiles:
    """Make ``read_bytes`` fail for selected paths, like a OneDrive lock or placeholder."""

    def __init__(self, predicate):
        self.predicate = predicate
        self.reads = []
        self.original = Path.read_bytes

    def __enter__(self):
        locked = self

        def read_bytes(path):
            locked.reads.append(path.name)
            if locked.predicate(path):
                raise PermissionError(13, "Permission denied", str(path))
            return locked.original(path)

        # Forget parsed files so the lock is actually observed.
        history_annotations._load_cache.clear()
        self.patcher = patch.object(Path, "read_bytes", read_bytes)
        self.patcher.start()
        return self

    def __exit__(self, *_exc):
        self.patcher.stop()


class AnnotationLoaderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=ROOT, prefix=".annotation-read-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.shared = self.root / "shared"
        self.values = dict(event_id="event", item_id="row", event_time="2026-10-11", serie="S1",
                           computador="HOST", motivo="Motivo", anotacao=SECRET_NOTE)

    def save(self, **overrides):
        return save_history_annotation(self.shared, **{**self.values, **overrides})

    def test_invalid_files_are_ignored_even_when_strict(self):
        valid = self.save()
        (self.shared / "corrompido.json").write_text("{not json", encoding="utf-8")
        (self.shared / "esquema.json").write_text(json.dumps({"versao": 9}), encoding="utf-8")
        (self.shared / "binario.json").write_bytes(b"\xff\xfe\x00")
        self.assertEqual(load_history_annotations(self.shared), [valid])
        self.assertEqual(load_history_annotations(self.shared, strict=True), [valid])

    def test_unreadable_file_is_logged_without_content_and_others_are_listed(self):
        readable = self.save(item_id="readable", anotacao="Visível")
        locked = self.save(item_id="locked")
        locked_name = next(p.name for p in self.shared.glob("*.json")
                           if json.loads(p.read_text(encoding="utf-8")) == locked)
        with LockedFiles(lambda path: path.name == locked_name):
            with self.assertLogs("domains.history_annotations", "WARNING") as logs:
                self.assertEqual(load_history_annotations(self.shared), [readable])
        output = "\n".join(logs.output)
        self.assertIn(locked_name, output)
        self.assertIn("PermissionError", output)
        self.assertNotIn(SECRET_NOTE, output)

    def test_unreadable_file_raises_busy_error_when_strict(self):
        self.save()
        with LockedFiles(lambda _path: True), self.assertLogs("domains.history_annotations", "WARNING"):
            with self.assertRaises(AnnotationReadError) as raised:
                load_history_annotations(self.shared, strict=True)
        self.assertIsInstance(raised.exception, FileBusyError)
        self.assertNotIn(SECRET_NOTE, str(raised.exception))

    def test_file_removed_between_listing_and_reading_is_not_an_error(self):
        self.save()
        with LockedFiles(lambda path: (_ for _ in ()).throw(FileNotFoundError(2, "gone", str(path)))):
            self.assertEqual(load_history_annotations(self.shared, strict=True), [])

    def test_listing_reuses_parsed_files_until_size_or_mtime_changes(self):
        first = self.save(item_id="a")
        with LockedFiles(lambda _path: False) as files:
            self.assertEqual(load_history_annotations(self.shared), [first])
            files.reads.clear()
            self.assertEqual(load_history_annotations(self.shared), [first])
            self.assertEqual(files.reads, [])
            second = self.save(item_id="b")
            self.assertCountEqual(load_history_annotations(self.shared), [first, second])
            self.assertEqual(len(files.reads), 1)
            # Callers may mutate the returned records without corrupting the cache.
            load_history_annotations(self.shared)[0]["anotacao"] = "alterado"
            self.assertCountEqual(load_history_annotations(self.shared), [first, second])

            invalid = self.shared / "zz.json"
            invalid.write_text("{}", encoding="utf-8")
            self.assertCountEqual(load_history_annotations(self.shared), [first, second])
            files.reads.clear()
            invalid.write_text(json.dumps(first), encoding="utf-8")
            self.assertEqual(len(load_history_annotations(self.shared)), 3)
            self.assertEqual(files.reads, ["zz.json"])


class InventoryInheritanceReadErrorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=ROOT, prefix=".annotation-read-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.shared = self.root / "shared"
        self.outbox = self.root / "outbox"

    def test_unreadable_revision_aborts_inheritance_instead_of_dropping_the_note(self):
        category = "sem_acesso_7_dias"
        row = {"serie": "S1", "computador": "HOST"}
        previous = {"id": "older", "comparacao": {category: [dict(row)]}}
        save_history_annotation(
            self.shared, event_id="older", event_time="2026-10-11",
            item_id=comparison_annotation_item_id("older", category, 0, row),
            serie="S1", computador="HOST", motivo="", anotacao=SECRET_NOTE, categoria=category,
            linha_hash=history_annotation_row_fingerprint(category, row),
        )
        services = SimpleNamespace(
            history_annotations_directory=lambda: self.shared,
            local_annotation_outbox_directory=lambda: self.outbox,
            load_history_annotations=load_history_annotations,
            comparison_annotation_item_id=comparison_annotation_item_id,
        )

        def new_event():
            return {"id": "new", "comparacao": {category: [dict(row)]}}

        with LockedFiles(lambda path: path.parent == self.shared), \
                self.assertLogs("domains.history_annotations", "WARNING"):
            with self.assertRaises(FileBusyError):
                _copy_matching_history_annotations(services, [previous], new_event())

        records = _copy_matching_history_annotations(services, [previous], new_event())
        self.assertEqual([record["anotacao"] for record in records], [SECRET_NOTE])


class LegacyMigrationReadErrorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=ROOT, prefix=".annotation-read-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.shared = self.root / "shared"
        self.outbox = self.root / "outbox"
        category = "sem_acesso_7_dias"
        event = {"id": "event", "horario": "2026-10-11", "comparacao": {
            category: [{"serie": "S1", "computador": "HOST", "anotacao": SECRET_NOTE}]}}
        self.history = [event]
        services = SimpleNamespace(
            history_annotations_directory=lambda: self.shared,
            local_annotation_outbox_directory=lambda: self.outbox,
            load_history_annotations=load_history_annotations,
            build_history_annotation_record=build_history_annotation_record,
            save_history_annotation=save_history_annotation,
            history_annotation_record_path=history_annotation_record_path,
            history_annotation_row_fingerprint=history_annotation_row_fingerprint,
            transaction_root=lambda: self.root,
            atomic_file_transaction=AtomicFileTransaction,
            load_comparison_history=lambda: self.history,
            comparison_annotation_item_id=lambda *args: "row",
        )
        self.migrate = create_inventory_history_router(services)[1].migrate_legacy_history_annotations
        # The newer shared revision cleared the note the history still embeds.
        save_history_annotation(
            self.shared, event_id="event", item_id="row", event_time="2026-10-11", serie="S1",
            computador="HOST", motivo="", anotacao="", categoria=category,
        )

    def view(self):
        return resolve_history_annotations([
            *load_history_annotations(self.shared), *load_history_annotations(self.outbox),
        ])[("event", "row")]

    def test_unreadable_revision_defers_migration_instead_of_queuing_a_false_conflict(self):
        with LockedFiles(lambda path: path.parent == self.shared), \
                self.assertLogs(level="WARNING") as logs:
            result = self.migrate()
        self.assertEqual(result["legadas_enfileiradas"], 0)
        self.assertEqual(result["adiada"], 1)
        self.assertEqual(list(self.outbox.glob("*.json")), [])
        self.assertEqual(len(list(self.shared.glob("*.json"))), 1)
        output = "\n".join(logs.output)
        self.assertIn("adiada", output)
        self.assertNotIn(SECRET_NOTE, output)

        # Next run, with the file readable again, recognizes the revision and queues nothing.
        result = self.migrate()
        self.assertEqual(result["legadas_enfileiradas"], 0)
        self.assertNotIn("adiada", result)
        view = self.view()
        self.assertFalse(view.get("anotacao_conflito"))
        self.assertEqual(view["anotacao"], "")


def parsed_report(simpress_bytes, _oracle_bytes, **_kwargs):
    return {"fontes": {"simpress": {"arquivo": simpress_bytes.decode()}}, "resumo": {},
            "chamados": [{"serie": "SN-1", "simpress": {"status": ["Aberto"]}}]}


class TicketInheritanceReadErrorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=ROOT, prefix=".annotation-read-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.router = create_operations_router(
            load_comparison_history=lambda: [], comparison_history_for_display=lambda event: event,
            ticket_report_path=lambda: self.root / "tickets.json", transaction_root=lambda: self.root,
            history_annotations_directory=lambda: self.root / "shared",
            local_annotation_outbox_directory=lambda: self.root / "outbox",
        )
        parser = patch("routers.operations.reconcile_ticket_workbooks", side_effect=parsed_report)
        parser.start()
        self.addCleanup(parser.stop)

    def endpoint(self, path, method="GET"):
        return next(r.endpoint for r in self.router.routes if r.path == path and method in r.methods)

    def import_version(self, label):
        return self.endpoint("/api/operacoes/chamados/importar", "POST")(
            simpress_file=UploadFile(filename="simpress.xlsx", file=BytesIO(label.encode())),
            oracle_file=UploadFile(filename="oracle.xlsx", file=BytesIO(b"oracle")),
            automatic_import_id=None,
        )

    def timeline(self):
        return self.endpoint("/api/operacoes/chamados/linha-do-tempo/{serial}")("SN-1")["eventos"]

    def test_unreadable_note_returns_409_and_keeps_report_until_retry(self):
        self.import_version("seed")
        event = self.timeline()[-1]
        self.endpoint("/api/operacoes/chamados/linha-do-tempo/{event_id}/{item_id}", "PUT")(
            event["snapshot_id"], event["item_id"], TicketTimelineAnnotationPayload(
                anotacao=SECRET_NOTE, base_revisoes=event["anotacao_revisoes"]),
        )
        report_path = self.root / "tickets.json"
        before = report_path.read_bytes()
        annotation_dirs = {self.root / "shared", self.root / "outbox"}

        with LockedFiles(lambda path: path.parent in annotation_dirs), \
                self.assertLogs("domains.history_annotations", "WARNING"):
            with self.assertRaises(HTTPException) as raised:
                self.import_version("next")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertNotIn(SECRET_NOTE, raised.exception.detail)
        self.assertEqual(report_path.read_bytes(), before)

        with LockedFiles(lambda path: path.parent in annotation_dirs), \
                self.assertLogs("domains.history_annotations", "WARNING"):
            # Display keeps working with what could be read.
            self.assertEqual([item["anotacao"] for item in self.timeline()], [""])

        self.import_version("next")
        self.assertEqual([item["anotacao"] for item in self.timeline()], [SECRET_NOTE, SECRET_NOTE])


if __name__ == "__main__":
    unittest.main()
