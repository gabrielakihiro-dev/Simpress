import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from domains.inventory_inbox import AutomaticInventoryInbox


class AutomaticInventoryInboxTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix="inventory-inbox-",
            dir=Path(__file__).resolve().parents[1],
        )
        self.root = Path(self.temporary.name) / "entrada"
        self.history = []
        self.calls = []
        self.import_error = None
        self.inbox = AutomaticInventoryInbox(
            root=self.root,
            max_upload_bytes=1024,
            load_history=lambda: list(self.history),
            import_batch=self._import_batch,
        )

    def tearDown(self):
        self.temporary.cleanup()

    async def _import_batch(self, batch_id, endpoint_name, endpoint_bytes, simpress_name, simpress_bytes):
        self.calls.append((batch_id, endpoint_name, endpoint_bytes, simpress_name, simpress_bytes))
        if self.import_error is not None:
            raise self.import_error
        self.history.append({"importacao_automatica_id": batch_id})
        return {"sucesso": True}

    def _make_batch(self, name="lote-001"):
        batch_dir = self.inbox.pending_dir / name
        endpoint_dir = batch_dir / "endpoint"
        simpress_dir = batch_dir / "simpress"
        endpoint_dir.mkdir(parents=True)
        simpress_dir.mkdir(parents=True)
        (endpoint_dir / "InvAll_original.xlsx").write_bytes(b"endpoint data")
        (simpress_dir / "EquipamentosDetalhes_original.xlsx").write_bytes(b"simpress data")
        return batch_dir

    @staticmethod
    def _run_coroutine(coroutine):
        async def run_inline(function, *args, **kwargs):
            return function(*args, **kwargs)

        with patch.object(asyncio, "to_thread", new=run_inline):
            try:
                return coroutine.send(None)
            except StopIteration as completed:
                return completed.value
            finally:
                coroutine.close()

    def _scan(self):
        return self._run_coroutine(self.inbox.process_pending_once())

    def _scan_until_settled(self):
        self._scan()
        return self._scan()

    def test_processes_complete_pair_after_stability_checks_and_archives_original_names(self):
        self._make_batch()
        self.assertEqual(self._scan(), 0)
        self.assertEqual(self.calls, [])

        self.assertEqual(self._scan(), 1)

        self.assertEqual(
            self.calls,
            [(
                "lote-001",
                "InvAll_original.xlsx",
                b"endpoint data",
                "EquipamentosDetalhes_original.xlsx",
                b"simpress data",
            )],
        )
        archived = self.inbox.processed_dir / "lote-001"
        self.assertTrue((archived / "endpoint" / "InvAll_original.xlsx").is_file())
        self.assertTrue((archived / "simpress" / "EquipamentosDetalhes_original.xlsx").is_file())
        self.assertEqual(json.loads((archived / "_resultado.json").read_text(encoding="utf-8"))["status"], "concluido")

    def test_waits_if_one_source_folder_has_not_arrived_yet(self):
        batch = self._make_batch()
        (batch / "simpress" / "EquipamentosDetalhes_original.xlsx").unlink()
        self.assertEqual(self._scan(), 0)
        self.assertEqual(self._scan(), 0)

        (batch / "simpress" / "EquipamentosDetalhes_original.xlsx").write_bytes(b"simpress data")
        self.assertEqual(self._scan(), 0)
        self.assertEqual(self._scan(), 1)
        self.assertEqual(len(self.calls), 1)

    def test_transient_conflict_returns_batch_to_pending_for_retry(self):
        self.import_error = HTTPException(status_code=409, detail="ocupado")
        self._make_batch()
        self._scan_until_settled()
        self.assertTrue((self.inbox.pending_dir / "lote-001").is_dir())
        self.assertFalse((self.inbox.failed_dir / "lote-001").exists())
        self.assertEqual(len(self.calls), 1)

        self.import_error = None
        self._scan_until_settled()
        self.assertEqual(len(self.calls), 2)
        self.assertTrue((self.inbox.processed_dir / "lote-001").is_dir())

    def test_permanent_validation_error_is_archived_with_reason_and_source_files(self):
        self.import_error = HTTPException(status_code=400, detail="cabeçalho inválido")
        self._make_batch()
        self._scan_until_settled()

        failed = self.inbox.failed_dir / "lote-001"
        result = json.loads((failed / "_resultado.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "falha")
        self.assertIn("cabeçalho inválido", result["detalhe"])
        self.assertTrue((failed / "endpoint" / "InvAll_original.xlsx").is_file())
        self.assertEqual(self.calls[0][0], "lote-001")

    def test_recovered_batch_already_in_history_is_archived_without_reimport(self):
        interrupted = self._make_batch()
        self.inbox.processing_dir.mkdir(parents=True)
        interrupted.rename(self.inbox.processing_dir / interrupted.name)
        self.history.append({"importacao_automatica_id": "lote-001"})

        self.assertEqual(self._scan(), 0)
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self.calls, [])
        result = json.loads(
            (self.inbox.processed_dir / "lote-001" / "_resultado.json").read_text(encoding="utf-8")
        )
        self.assertIn("não foi importado novamente", result["detalhe"])

    def test_scan_keeps_event_loop_responsive_and_completes_async_import(self):
        self._make_batch()
        self.assertEqual(self._scan(), 0)
        archiving = threading.Event()
        release = threading.Event()
        archive = self.inbox._archive

        def slow_archive(*args, **kwargs):
            archiving.set()
            release.wait(5)
            return archive(*args, **kwargs)

        self.inbox._archive = slow_archive

        async def run():
            scan = asyncio.create_task(self.inbox.process_pending_once())
            while not archiving.is_set():
                await asyncio.sleep(0.01)
            # Filesystem work is still blocked, yet this coroutine keeps running.
            responsive = not scan.done()
            release.set()
            return await scan, responsive

        completed, responsive = asyncio.run(run())

        self.assertTrue(responsive)
        self.assertEqual(completed, 1)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue((self.inbox.processed_dir / "lote-001").is_dir())

    def test_oversized_workbook_is_failed_without_calling_update(self):
        self.inbox.max_upload_bytes = 4
        self._make_batch()
        self._scan_until_settled()

        failed = self.inbox.failed_dir / "lote-001"
        result = json.loads((failed / "_resultado.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "falha")
        self.assertIn("limite", result["detalhe"])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
