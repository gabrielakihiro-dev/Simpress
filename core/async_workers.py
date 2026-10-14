"""Helpers for safely awaiting blocking work performed in worker threads."""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, TypeVar


_Result = TypeVar("_Result")
logger = logging.getLogger(__name__)


async def await_worker_completion(
    worker: asyncio.Task[_Result],
    *,
    on_cancelled_failure: Callable[[Exception], None] | None = None,
) -> _Result:
    """Wait until a worker ends before allowing request cancellation to escape.

    ``asyncio.shield`` protects the worker from cancellation, but a repeated
    cancellation can interrupt the shielded await again. Keep waiting so
    callers do not release semaphores, uploads, or transaction resources while
    the worker is still using them.
    """
    cancellation_requested = False
    while True:
        try:
            result = await asyncio.shield(worker)
        except asyncio.CancelledError:
            if worker.cancelled():
                raise
            cancellation_requested = True
            continue
        except Exception as error:
            if cancellation_requested:
                logger.warning(
                    "Falha de tarefa após cancelamento da requisição (erro=%s).",
                    type(error).__name__,
                )
                if on_cancelled_failure is not None:
                    on_cancelled_failure(error)
                raise asyncio.CancelledError from None
            raise

        if cancellation_requested:
            raise asyncio.CancelledError
        return result
