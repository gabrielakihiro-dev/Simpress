"""Cancellation regressions for thread-worker consumers, using synthetic state."""

import asyncio
import io
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.datastructures import UploadFile

from core.async_workers import await_worker_completion
from routers.local_setup import create_local_setup_router


class WorkerConsumerCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_worker_returns_its_result(self):
        worker = asyncio.create_task(asyncio.sleep(0, result={"sucesso": True}))
        await worker
        self.assertEqual(await await_worker_completion(worker), {"sucesso": True})

    async def test_cancellation_wins_when_worker_finishes_before_waiter_resumes(self):
        release = asyncio.Event()
        worker = asyncio.create_task(release.wait())
        request = asyncio.create_task(await_worker_completion(worker))
        await asyncio.sleep(0)
        release.set()
        request.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(request, 10)
        self.assertTrue(worker.done())
        self.assertFalse(worker.cancelled())
        self.assertTrue(worker.result())

    async def _assert_model_cancellation(self, *, reject):
        root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="model-worker-")))
        target = root / "modelo.xlsx"
        target.write_bytes(b"synthetic previous model")
        admission = threading.BoundedSemaphore(1)
        validation_started = threading.Event()
        release_validation = threading.Event()

        def validate_export():
            validation_started.set()
            if not release_validation.wait(10):
                raise TimeoutError("the test did not release model validation")
            return "synthetic validation rejection" if reject else None

        _, import_model = create_local_setup_router(
            model_path=lambda _kind: target,
            transaction_root=lambda: root,
            backups_directory=lambda: root / "backups",
            max_upload_bytes=lambda: 1024,
            parser_admission=lambda: admission,
            export_dependency_paths=lambda: [],
            validate_export=validate_export,
        )
        upload = UploadFile(filename="modelo.xlsx", file=io.BytesIO(b"synthetic new model"))
        # Validation here is controlled to reach a real applied file transaction.
        with patch("routers.local_setup.validate_local_model", return_value=None):
            request = asyncio.create_task(import_model("exportacao", upload))
            try:
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(validation_started.wait, 10), 12))
                self.assertEqual(target.read_bytes(), b"synthetic new model")
                for _ in range(4):
                    request.cancel()
                    await asyncio.sleep(0)
                    self.assertFalse(request.done())
                    self.assertFalse(upload.file.closed)
                    self.assertFalse(admission.acquire(blocking=False))

                second_upload = UploadFile(filename="modelo.xlsx", file=io.BytesIO(b"another model"))
                with self.assertRaises(HTTPException) as busy:
                    await import_model("exportacao", second_upload)
                self.assertEqual(busy.exception.status_code, 503)
                self.assertTrue(second_upload.file.closed)
                self.assertFalse(admission.acquire(blocking=False))

                release_validation.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(request, 12)
            finally:
                release_validation.set()
                await asyncio.wait_for(asyncio.gather(request, return_exceptions=True), 12)
        self.assertTrue(upload.file.closed)
        self.assertTrue(admission.acquire(blocking=False))
        admission.release()
        self.assertEqual(
            target.read_bytes(),
            b"synthetic previous model" if reject else b"synthetic new model",
        )
        backups = list((root / "backups").rglob("modelo.xlsx"))
        self.assertEqual([path.read_bytes() for path in backups], [] if reject else [b"synthetic previous model"])

    async def test_model_worker_keeps_admission_and_upload_until_commit_after_cancellation(self):
        await self._assert_model_cancellation(reject=False)

    async def test_model_worker_rolls_back_before_releasing_resources_after_cancellation(self):
        await self._assert_model_cancellation(reject=True)
