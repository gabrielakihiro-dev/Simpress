"""Cancellation safety for blocking work dispatched to worker threads."""

import asyncio
import threading
import unittest

from core.async_workers import await_worker_completion


class AwaitWorkerCompletionTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_cancellation_keeps_resource_until_worker_finishes(self):
        admission = threading.BoundedSemaphore(1)
        started = threading.Event()
        release_worker = threading.Event()
        finished = threading.Event()

        def blocking_work():
            started.set()
            try:
                if not release_worker.wait(3):
                    raise TimeoutError("the test did not release the worker")
                return "finished"
            finally:
                finished.set()

        async def use_admission():
            self.assertTrue(admission.acquire(blocking=False))
            try:
                worker = asyncio.create_task(asyncio.to_thread(blocking_work))
                return await await_worker_completion(worker)
            finally:
                admission.release()

        request = asyncio.create_task(use_admission())
        try:
            self.assertTrue(await asyncio.wait_for(asyncio.to_thread(started.wait, 2), 3))
            for _ in range(4):
                request.cancel()
                await asyncio.sleep(0)
                self.assertFalse(request.done())
                self.assertFalse(admission.acquire(blocking=False))

            release_worker.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(request, 3)
            self.assertTrue(finished.is_set())
            self.assertTrue(admission.acquire(blocking=False))
            admission.release()
        finally:
            release_worker.set()
            if not request.done():
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)

    async def test_repeated_cancellation_wins_over_worker_failure_and_reports_it(self):
        started = threading.Event()
        release_worker = threading.Event()
        failures = []

        def blocking_failure():
            started.set()
            if not release_worker.wait(3):
                raise TimeoutError("the test did not release the worker")
            raise RuntimeError("synthetic worker failure")

        worker = asyncio.create_task(asyncio.to_thread(blocking_failure))
        request = asyncio.create_task(await_worker_completion(
            worker, on_cancelled_failure=failures.append,
        ))
        try:
            self.assertTrue(await asyncio.wait_for(asyncio.to_thread(started.wait, 2), 3))
            request.cancel()
            await asyncio.sleep(0)
            request.cancel()
            await asyncio.sleep(0)
            self.assertFalse(request.done())
            release_worker.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(request, 3)
            self.assertEqual(len(failures), 1)
            self.assertIsInstance(failures[0], RuntimeError)
            self.assertEqual(str(failures[0]), "synthetic worker failure")
        finally:
            release_worker.set()
            if not request.done():
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)

    async def test_uncancelled_worker_failure_propagates(self):
        def fail():
            raise RuntimeError("visible worker failure")

        worker = asyncio.create_task(asyncio.to_thread(fail))
        with self.assertRaisesRegex(RuntimeError, "visible worker failure"):
            await await_worker_completion(worker)

    async def test_worker_cancellation_is_not_swallowed(self):
        worker = asyncio.create_task(asyncio.sleep(10))
        worker.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await await_worker_completion(worker)
