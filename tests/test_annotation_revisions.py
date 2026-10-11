"""Causal annotation synchronization with two disposable clone roots."""

import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from domains.history_annotations import (
    annotation_record_values, annotation_revision, annotation_export_text,
    build_history_annotation_record, history_annotation_record_path,
    history_annotation_row_fingerprint, load_history_annotations,
    resolve_history_annotations, save_history_annotation, sync_history_annotation,
)
from integrity import AtomicFileTransaction
from routers.inventory_history import create_inventory_history_router, ComparisonAnnotationPayload
from routers.operations import create_operations_router, TicketTimelineAnnotationPayload


ROOT = Path(__file__).resolve().parents[1]


class AnnotationRevisionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=ROOT, prefix=".annotation-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.shared = self.root / "shared"
        self.a = self.root / "clone-a" / "outbox"
        self.b = self.root / "clone-b" / "outbox"
        self.values = dict(event_id="event", item_id="row", event_time="2026-10-11",
                           serie="S1", computador="HOST", motivo="Conferir", anotacao="Base")

    def write(self, directory, text="Base", parents=None, **kwargs):
        return save_history_annotation(directory, **{**self.values, "anotacao": text},
                                       base_revisions=parents, **kwargs)

    def sync(self, record, outbox, publisher=save_history_annotation):
        return sync_history_annotation(record, directory=self.shared, outbox=outbox,
                                       transaction_root=self.root,
                                       transaction_factory=AtomicFileTransaction, publisher=publisher)

    def view(self, *directories):
        return resolve_history_annotations(
            record for directory in (directories or (self.shared,))
            for record in load_history_annotations(directory)
        )[("event", "row")]

    def test_two_clones_preserve_concurrent_edits_independent_of_clocks(self):
        base = self.write(self.shared)
        a = self.write(self.a, "Notebook A", [base["revisao_id"]], updated_at="2099-01-01")
        b = self.write(self.b, "Notebook B", [base["revisao_id"]], updated_at="1990-01-01")
        self.assertTrue(self.sync(b, self.b))
        self.assertTrue(self.sync(a, self.a))
        view = self.view()
        self.assertTrue(view["anotacao_conflito"])
        self.assertEqual(view["anotacao"], "")
        self.assertEqual({r["anotacao"] for r in view["anotacao_conflitos"]}, {"Notebook A", "Notebook B"})
        self.assertEqual(len(load_history_annotations(self.shared)), 3)

    def test_old_queued_legacy_record_never_replaces_new_shared_text(self):
        newer = self.write(self.shared, "Texto atual")
        legacy = {"versao": 1, "evento_id": "event", "item_id": "row", "anotacao": "Texto antigo"}
        path = history_annotation_record_path(self.a, "event", "row")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(legacy), encoding="utf-8")
        self.assertTrue(self.sync(legacy, self.a))
        self.assertFalse(path.exists())
        self.assertTrue(self.view()["anotacao_conflito"])
        self.assertIn(newer, load_history_annotations(self.shared))

    def test_explicit_merge_converges_but_late_unseen_branch_remains_a_conflict(self):
        base = self.write(self.shared)
        a = self.write(self.shared, "A", [base["revisao_id"]])
        b = self.write(self.shared, "B", [base["revisao_id"]])
        merge = self.write(self.shared, "", self.view()["anotacao_revisoes"])
        self.assertFalse(self.view()["anotacao_conflito"])
        self.assertEqual(self.view()["anotacao"], "")
        self.assertEqual(self.view()["anotacao_revisoes"], [merge["revisao_id"]])
        self.write(self.shared, "Edição atrasada", [a["revisao_id"]])
        self.assertTrue(self.view()["anotacao_conflito"])

    def test_child_arriving_before_parent_is_not_a_confirmed_resolution(self):
        base = self.write(self.a)
        child = self.write(self.b, "Filha", [base["revisao_id"]])
        self.sync(child, self.b)
        self.assertEqual(self.view()["anotacao_bases_ausentes"], [base["revisao_id"]])
        self.assertTrue(self.view()["anotacao_conflito"])
        self.sync(base, self.a)
        self.assertEqual(self.view()["anotacao"], "Filha")
        self.assertFalse(self.view()["anotacao_conflito"])

    def test_missing_intermediate_ancestor_is_detected_until_it_arrives(self):
        base = self.write(self.shared)
        middle = self.write(self.a, "Meio", [base["revisao_id"]])
        child = self.write(self.b, "Fim", [middle["revisao_id"]])
        self.sync(child, self.b)
        self.assertTrue(self.view()["anotacao_conflito"])
        self.sync(middle, self.a)
        self.assertEqual(self.view()["anotacao"], "Fim")

    def test_retry_preserves_the_exact_original_file_and_rejects_changed_content(self):
        record = self.write(self.shared)
        path = history_annotation_record_path(self.shared, "event", "row", record["revisao_id"])
        before = path.read_bytes()
        values = annotation_record_values(record)
        values["updated_at"] = "2200-01-01"
        self.assertEqual(save_history_annotation(self.shared, **values), record)
        self.assertEqual(path.read_bytes(), before)
        with self.assertRaises(ValueError):
            save_history_annotation(self.shared, **{**values, "anotacao": "Outro conteúdo"})
        self.assertEqual(path.read_bytes(), before)

    def test_network_failure_leaves_pending_revision_for_safe_retry(self):
        record = self.write(self.a)
        with self.assertRaises(OSError):
            self.sync(record, self.a, publisher=lambda *a, **k: (_ for _ in ()).throw(OSError("offline")))
        self.assertEqual(load_history_annotations(self.a), [record])
        self.assertTrue(self.sync(record, self.a))
        self.assertTrue(self.sync(record, self.a))
        self.assertEqual(load_history_annotations(self.a), [])
        self.assertEqual(len(load_history_annotations(self.shared)), 1)

    def test_new_edit_created_during_publication_keeps_its_own_pending_revision(self):
        old = self.write(self.a)
        created = []
        def publish(directory, **values):
            created.append(self.write(self.a, "Mais recente", [old["revisao_id"]]))
            return save_history_annotation(directory, **values)
        self.assertTrue(self.sync(old, self.a, publisher=publish))
        self.assertEqual(load_history_annotations(self.a), created)
        self.assertEqual(self.view(self.shared, self.a)["anotacao"], "Mais recente")

    def test_acknowledgement_must_match_the_written_revision(self):
        record = self.write(self.a)
        def false_ack(directory, **values):
            return build_history_annotation_record(**values)
        with self.assertRaises(FileNotFoundError):
            self.sync(record, self.a, publisher=false_ack)
        self.assertEqual(load_history_annotations(self.a), [record])

    def test_legacy_pending_replaced_during_sync_is_not_deleted(self):
        legacy = {"versao": 1, "evento_id": "event", "item_id": "row", "anotacao": "A"}
        path = history_annotation_record_path(self.a, "event", "row")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(legacy), encoding="utf-8")
        def publish(directory, **values):
            path.write_text(json.dumps({**legacy, "anotacao": "B"}), encoding="utf-8")
            return save_history_annotation(directory, **values)
        self.assertFalse(self.sync(legacy, self.a, publisher=publish))
        self.assertEqual(json.loads(path.read_text())["anotacao"], "B")

    def test_legacy_migration_is_deterministic_and_preserves_original_file(self):
        legacy = {"versao": 1, "evento_id": "event", "item_id": "row", "anotacao": "Legada"}
        path = history_annotation_record_path(self.shared, "event", "row")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(legacy), encoding="utf-8")
        before = path.read_bytes()
        for _ in range(2):
            save_history_annotation(self.shared, **annotation_record_values(legacy))
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(len(load_history_annotations(self.shared)), 2)
        self.assertEqual(self.view()["anotacao"], "Legada")
        self.assertFalse(self.view()["anotacao_conflito"])

    def test_length_limit_and_revision_identifiers_are_validated(self):
        self.write(self.shared, "a" * 2000)
        for kwargs in ({"anotacao": "a" * 2001}, {"revision_id": "../escape"},
                       {"base_revisions": ["../escape"]}, {"base_revisions": [None]}):
            values = {**self.values, **kwargs}
            with self.assertRaises(ValueError):
                save_history_annotation(self.shared, **values)

    def test_cyclic_or_colliding_revisions_cannot_select_a_winner(self):
        a = build_history_annotation_record(**self.values, revision_id="a" * 32, base_revisions=["b" * 32])
        b = build_history_annotation_record(**self.values, revision_id="b" * 32, base_revisions=["a" * 32])
        root = build_history_annotation_record(**self.values)
        view = resolve_history_annotations([root, a, b])[("event", "row")]
        self.assertTrue(view["anotacao_integridade_invalida"])
        self.assertTrue(view["anotacao_conflito"])
        collision = {**root, "anotacao": "Conteúdo divergente com o mesmo ID"}
        view = resolve_history_annotations([root, collision])[("event", "row")]
        self.assertTrue(view["anotacao_integridade_invalida"])
        self.assertEqual({r["anotacao"] for r in view["anotacao_conflitos"]},
                         {root["anotacao"], collision["anotacao"]})

    def inventory_router(self):
        history = self.root / "history.json"
        event = {"id": "event", "horario": "2026-10-11", "comparacao": {
            "sem_acesso_14_dias": [{"serie": "S1", "computador": "HOST"}]}}
        history.write_text(json.dumps([event]), encoding="utf-8")
        def display(event):
            view = copy.deepcopy(event)
            for row in view["comparacao"].get("sem_acesso_14_dias", []):
                row["anotacao_id"] = "row"
            return view
        services = SimpleNamespace(
            postgres_files=None, history_annotations_directory=lambda: self.shared,
            local_annotation_outbox_directory=lambda: self.a,
            load_history_annotations=load_history_annotations,
            build_history_annotation_record=build_history_annotation_record,
            save_history_annotation=save_history_annotation,
            history_annotation_record_path=history_annotation_record_path,
            history_annotation_row_fingerprint=history_annotation_row_fingerprint,
            transaction_root=lambda: self.root, atomic_file_transaction=AtomicFileTransaction,
            load_comparison_history=lambda: json.loads(history.read_text(encoding="utf-8")),
            comparison_history_path=lambda: history, comparison_history_lock=threading.RLock(),
            comparison_annotation_item_id=lambda *args: "row", comparison_history_for_display=display,
            history_annotations_sync_enabled=lambda: True,
        )
        return create_inventory_history_router(services)[1], history

    def test_history_routes_expose_conflicts_and_allow_explicit_resolution_without_local_history(self):
        routes, history = self.inventory_router()
        save = routes["salvar_anotacao_comparacao_historica"]
        first = save("event", "row", ComparisonAnnotationPayload(anotacao="A"))
        second = save("event", "row", ComparisonAnnotationPayload(anotacao="B"))
        self.assertTrue(second["anotacao_conflito"])
        history.write_text("[]", encoding="utf-8")
        event = routes["get_comparacao_historica"]("event")["evento"]
        row = event["comparacao"]["sem_acesso_14_dias"][0]
        self.assertTrue(row["anotacao_conflito"])
        self.assertIn("A", annotation_export_text(row))
        with self.assertRaises(HTTPException) as error:
            save("event", "row", ComparisonAnnotationPayload(anotacao="C", base_revisoes=row["anotacao_revisoes"]))
        self.assertEqual(error.exception.status_code, 409)
        resolved = save("event", "row", ComparisonAnnotationPayload(
            anotacao="", base_revisoes=row["anotacao_revisoes"], resolver_conflito=True))
        self.assertFalse(resolved["anotacao_conflito"])
        self.assertEqual(resolved["anotacao"], "")

    def test_history_migration_does_not_resurrect_embedded_old_text(self):
        routes, history = self.inventory_router()
        stored = json.loads(history.read_text())
        stored[0]["comparacao"]["sem_acesso_14_dias"][0]["anotacao"] = "Texto antigo"
        history.write_text(json.dumps(stored), encoding="utf-8")
        before = history.read_bytes()
        self.write(self.shared, "", categoria="sem_acesso_14_dias")
        for _ in range(2):
            result = routes["migrate_legacy_history_annotations"]()
            self.assertEqual(result["legadas_enfileiradas"], 0)
        self.assertEqual(history.read_bytes(), before)
        self.assertEqual(self.view()["anotacao"], "")

    def test_operational_editor_receives_the_text_and_bases_observed_in_history(self):
        routes, history = self.inventory_router()
        stored = json.loads(history.read_text())
        stored[0]["comparacao"]["sem_acesso_14_dias"][0]["anotacao"] = "Local antigo"
        latest = self.write(self.shared, "Compartilhado", categoria="sem_acesso_14_dias")
        view = routes["history_annotation_view"](stored[0])
        row = view["comparacao"]["sem_acesso_14_dias"][0]
        self.assertEqual(row["anotacao"], "Compartilhado")
        self.assertEqual(row["anotacao_revisoes"], [latest["revisao_id"]])
        self.assertEqual(stored[0]["comparacao"]["sem_acesso_14_dias"][0]["anotacao"], "Local antigo")

    def test_different_legacy_history_and_shared_text_are_both_migrated(self):
        routes, history = self.inventory_router()
        stored = json.loads(history.read_text())
        stored[0]["comparacao"]["sem_acesso_14_dias"][0]["anotacao"] = "Legada local"
        history.write_text(json.dumps(stored), encoding="utf-8")
        legacy = {"versao": 1, "evento_id": "event", "item_id": "row", "anotacao": "Legada compartilhada"}
        path = history_annotation_record_path(self.shared, "event", "row")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(legacy), encoding="utf-8")
        before = path.read_bytes(), history.read_bytes()
        routes["migrate_legacy_history_annotations"]()
        view = self.view()
        self.assertEqual({c["anotacao"] for c in view["anotacao_conflitos"]},
                         {"Legada local", "Legada compartilhada"})
        self.assertEqual((path.read_bytes(), history.read_bytes()), before)
        count = len(list(self.shared.glob("*.json")))
        routes["migrate_legacy_history_annotations"]()
        self.assertEqual(len(list(self.shared.glob("*.json"))), count)

    def test_retry_with_changed_content_is_rejected_after_acknowledgement(self):
        routes, history = self.inventory_router()
        save = routes["salvar_anotacao_comparacao_historica"]
        payload = ComparisonAnnotationPayload(anotacao="A", revisao_id="1" * 32)
        first = save("event", "row", payload)
        before = history.read_bytes()
        repeated = save("event", "row", payload)
        self.assertEqual(first["anotacao_revisoes"], repeated["anotacao_revisoes"])
        self.assertEqual(len(load_history_annotations(self.shared)), 1)
        with self.assertRaises(HTTPException) as error:
            save("event", "row", ComparisonAnnotationPayload(anotacao="B", revisao_id="1" * 32))
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(history.read_bytes(), before)
        self.assertEqual(load_history_annotations(self.a), [])

    def test_interrupted_acknowledgement_retries_without_replacing_shared_revision(self):
        record = self.write(self.a)
        with patch("integrity.AtomicFileTransaction.commit", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                self.sync(record, self.a)
        self.assertEqual(len(load_history_annotations(self.a)), 1)
        before = next(self.shared.glob("*.json")).read_bytes()
        self.assertTrue(self.sync(record, self.a))
        self.assertEqual(next(self.shared.glob("*.json")).read_bytes(), before)

    def test_simultaneous_publications_keep_both_branches(self):
        base = self.write(self.shared)
        a = self.write(self.a, "A", [base["revisao_id"]])
        b = self.write(self.b, "B", [base["revisao_id"]])
        barrier = threading.Barrier(2, timeout=5)
        errors = []
        def worker(record, outbox):
            try:
                barrier.wait()
                self.sync(record, outbox)
            except Exception as error:
                errors.append(error)
        threads = [threading.Thread(target=worker, args=args) for args in ((a, self.a), (b, self.b))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(self.view()["anotacao_conflito"])

    def test_ticket_routes_use_the_same_protocol(self):
        path = self.root / "tickets.json"
        snapshot = {"id": "ticket-event", "atualizado_em": "2026-10-11", "chamados": [{"serie": "S1"}]}
        path.write_text(json.dumps({**snapshot, "snapshot_id": "ticket-event", "historico": [snapshot]}), encoding="utf-8")
        router = create_operations_router(
            load_comparison_history=lambda: [], comparison_history_for_display=lambda x: x,
            ticket_report_path=lambda: path, transaction_root=lambda: self.root,
            history_annotations_directory=lambda: self.shared, local_annotation_outbox_directory=lambda: self.a,
        )
        timeline = next(r.endpoint for r in router.routes if r.path == "/api/operacoes/chamados/linha-do-tempo/{serial}")
        save = next(r.endpoint for r in router.routes if r.path == "/api/operacoes/chamados/linha-do-tempo/{event_id}/{item_id}")
        item = timeline("S1")["eventos"][0]
        a = save("ticket-event", item["item_id"], TicketTimelineAnnotationPayload(anotacao="A"))
        b = save("ticket-event", item["item_id"], TicketTimelineAnnotationPayload(anotacao="B"))
        self.assertTrue(b["anotacao_conflito"])
        resolved = save("ticket-event", item["item_id"], TicketTimelineAnnotationPayload(
            anotacao="A + B", base_revisoes=b["anotacao_revisoes"], resolver_conflito=True))
        self.assertFalse(resolved["anotacao_conflito"])
        self.assertEqual(timeline("S1")["eventos"][0]["anotacao"], "A + B")


if __name__ == "__main__":
    unittest.main()
