"""Automatic, restart-safe intake for paired inventory workbooks."""

import asyncio
import json
import logging
import os
import stat
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, cast

from fastapi import HTTPException


logger = logging.getLogger(__name__)
_PROCESS_WORKER_LOCK = threading.Lock()


class InventoryInboxError(ValueError):
    """A ready batch cannot be imported safely."""


class InventoryInboxChanged(RuntimeError):
    """A workbook changed while the inbox was reading it; retry after it settles."""


@contextmanager
def _try_worker_lock(path: Path):
    """Hold a non-blocking process lock while recovering and claiming batches."""
    if not _PROCESS_WORKER_LOCK.acquire(blocking=False):
        yield False
        return
    handle = None
    locked = False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a+b")
        if os.name == "nt":
            import msvcrt

            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                locked = True
            except OSError:
                locked = False
        else:
            import fcntl

            fcntl_api = cast(Any, fcntl)
            try:
                fcntl_api.flock(handle.fileno(), fcntl_api.LOCK_EX | fcntl_api.LOCK_NB)
                locked = True
            except OSError:
                locked = False
        yield locked
    finally:
        if locked and handle is not None:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl_api = cast(Any, fcntl)
                fcntl_api.flock(handle.fileno(), fcntl_api.LOCK_UN)
        if handle is not None:
            handle.close()
        _PROCESS_WORKER_LOCK.release()


class AutomaticInventoryInbox:
    """Find ready endpoint/Simpress pairs and pass them through the normal update."""

    def __init__(
        self,
        root: Path,
        max_upload_bytes: int,
        load_history: Callable[[], Any],
        import_batch: Callable[[str, str, bytes, str, bytes], Awaitable[Any]],
    ) -> None:
        self.root = Path(root)
        self.max_upload_bytes = int(max_upload_bytes)
        self.load_history = load_history
        self.import_batch = import_batch
        self._stable_snapshots: dict[str, tuple[tuple[Any, ...], ...]] = {}

    @property
    def pending_dir(self) -> Path:
        return self.root / "pendentes"

    @property
    def processing_dir(self) -> Path:
        return self.root / "processando"

    @property
    def processed_dir(self) -> Path:
        return self.root / "processadas"

    @property
    def failed_dir(self) -> Path:
        return self.root / "falhas"

    async def process_pending_once(self) -> int:
        """Process stable ready batches, returning the number completed or archived."""
        for directory in (
            self.pending_dir,
            self.processing_dir,
            self.processed_dir,
            self.failed_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

        completed = 0
        with _try_worker_lock(self.root / ".importador.lock") as locked:
            if not locked:
                return 0
            self._recover_interrupted_batches()
            active_names = set()
            for batch_dir in sorted(self.pending_dir.iterdir(), key=lambda item: item.name.casefold()):
                if batch_dir.is_symlink() or not batch_dir.is_dir():
                    continue
                active_names.add(batch_dir.name)
                try:
                    snapshot = self._batch_snapshot(batch_dir)
                except OSError:
                    logger.exception("Não foi possível inspecionar o lote automático %s.", batch_dir.name)
                    continue
                if snapshot is None:
                    continue
                if self._stable_snapshots.get(batch_dir.name) != snapshot:
                    self._stable_snapshots[batch_dir.name] = snapshot
                    continue

                self._stable_snapshots.pop(batch_dir.name, None)
                if not await self._process_stable_batch(batch_dir):
                    continue
                completed += 1

            for batch_name in set(self._stable_snapshots) - active_names:
                self._stable_snapshots.pop(batch_name, None)
        return completed

    def _batch_snapshot(self, batch_dir: Path) -> Optional[tuple[tuple[Any, ...], ...]]:
        """Return a metadata signature after both source workbooks appear."""
        entries: list[tuple[Any, ...]] = []
        for role in ("endpoint", "simpress"):
            role_dir = batch_dir / role
            if not role_dir.exists() and not role_dir.is_symlink():
                return None
            entries.append(self._stat_signature(role, role_dir))
            if role_dir.is_symlink() or not role_dir.is_dir():
                continue
            for item in sorted(role_dir.iterdir(), key=lambda value: value.name.casefold()):
                entries.append(self._stat_signature(f"{role}/{item.name}", item))
            if not any(
                item.suffix.lower() == ".xlsx" and not item.name.startswith("~$")
                for item in role_dir.iterdir()
            ):
                return None
        return tuple(entries)

    @staticmethod
    def _stat_signature(label: str, path: Path) -> tuple[Any, ...]:
        details = path.lstat()
        return (label, details.st_mode, details.st_size, details.st_mtime_ns)

    async def _process_stable_batch(self, pending_batch: Path) -> bool:
        batch_id = pending_batch.name
        processing_batch = self.processing_dir / batch_id
        if (self.processed_dir / batch_id).exists():
            return self._fail_batch(
                pending_batch,
                batch_id,
                "Este identificador de lote já foi usado. Crie outro nome de pasta para uma nova importação.",
            )
        if processing_batch.exists():
            return self._fail_batch(
                pending_batch,
                batch_id,
                "Já existe um lote com este identificador em processamento; mantenha os nomes de lote exclusivos.",
            )

        try:
            pending_batch.rename(processing_batch)
        except OSError:
            logger.exception("Não foi possível reservar o lote automático %s.", batch_id)
            return False

        try:
            history = await self._load_history()
        except Exception:
            logger.exception("Não foi possível conferir a idempotência do lote %s.", batch_id)
            self._return_to_pending(processing_batch, batch_id)
            return False
        if self._history_contains_batch(history, batch_id):
            self._archive(processing_batch, self.processed_dir, batch_id, "concluido", "Lote já registrado no histórico; não foi importado novamente.")
            return True

        try:
            (
                endpoint_name,
                endpoint_bytes,
                simpress_name,
                simpress_bytes,
            ) = await asyncio.to_thread(self._read_batch_files, processing_batch)
        except InventoryInboxChanged:
            self._return_to_pending(processing_batch, batch_id)
            return False
        except InventoryInboxError as error:
            return self._fail_batch(processing_batch, batch_id, str(error))
        except OSError:
            logger.exception("Falha ao ler o lote automático %s.", batch_id)
            return self._fail_batch(processing_batch, batch_id, "Não foi possível ler os arquivos do lote.")

        try:
            await self.import_batch(
                batch_id,
                endpoint_name,
                endpoint_bytes,
                simpress_name,
                simpress_bytes,
            )
        except HTTPException as error:
            if error.status_code in (409, 503):
                logger.info("Lote %s aguardará nova tentativa: %s", batch_id, error.detail)
                self._return_to_pending(processing_batch, batch_id)
                return False
            return self._fail_batch(processing_batch, batch_id, str(error.detail))
        except Exception as error:
            logger.exception("Falha permanente ao importar o lote automático %s.", batch_id)
            reason = f"Falha na atualização ({type(error).__name__})."
            return self._fail_batch(processing_batch, batch_id, reason)

        self._archive(processing_batch, self.processed_dir, batch_id, "concluido", "Importação confirmada no histórico.")
        return True

    async def _load_history(self):
        return await asyncio.to_thread(self.load_history)

    @staticmethod
    def _history_contains_batch(history: Any, batch_id: str) -> bool:
        return isinstance(history, list) and any(
            isinstance(event, dict) and event.get("importacao_automatica_id") == batch_id
            for event in history
        )

    @staticmethod
    def _select_workbook(batch_dir: Path, role: str) -> Path:
        role_dir = batch_dir / role
        if role_dir.is_symlink() or not role_dir.is_dir():
            raise InventoryInboxError(f"Crie a pasta '{role}' diretamente no lote.")
        files = [
            item for item in role_dir.iterdir()
            if item.suffix.lower() == ".xlsx" and not item.name.startswith("~$")
        ]
        if len(files) != 1:
            raise InventoryInboxError(
                f"A pasta '{role}' deve conter exatamente um arquivo .xlsx; encontrados: {len(files)}."
            )
        path = files[0]
        if path.is_symlink() or not path.is_file():
            raise InventoryInboxError(f"O arquivo de '{role}' precisa ser um arquivo normal, sem link simbólico.")
        return path

    def _read_workbook(self, path: Path) -> tuple[str, bytes]:
        if path.is_symlink():
            raise InventoryInboxError("Links simbólicos não podem ser processados na pasta de entrada.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                raise InventoryInboxError("Os arquivos de entrada devem ser arquivos XLSX regulares.")
            if before.st_size <= 0:
                raise InventoryInboxError(f"O arquivo '{path.name}' está vazio.")
            if before.st_size > self.max_upload_bytes:
                raise InventoryInboxError(
                    f"O arquivo '{path.name}' excede o limite de {self._upload_limit_label()}."
                )
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                file_bytes = source.read(self.max_upload_bytes + 1)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        if len(file_bytes) > self.max_upload_bytes:
            raise InventoryInboxError(
                f"O arquivo '{path.name}' excede o limite de {self._upload_limit_label()}."
            )
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise InventoryInboxChanged("O arquivo mudou durante a leitura.")
        return path.name, file_bytes

    def _upload_limit_label(self) -> str:
        if self.max_upload_bytes >= 1024 * 1024:
            return f"{self.max_upload_bytes / (1024 * 1024):g} MB"
        if self.max_upload_bytes >= 1024:
            return f"{self.max_upload_bytes / 1024:g} KB"
        return f"{self.max_upload_bytes} bytes"

    def _read_batch_files(self, batch_dir: Path) -> tuple[str, bytes, str, bytes]:
        endpoint_path = self._select_workbook(batch_dir, "endpoint")
        simpress_path = self._select_workbook(batch_dir, "simpress")
        endpoint_name, endpoint_bytes = self._read_workbook(endpoint_path)
        simpress_name, simpress_bytes = self._read_workbook(simpress_path)
        return endpoint_name, endpoint_bytes, simpress_name, simpress_bytes

    def _recover_interrupted_batches(self) -> None:
        for processing_batch in sorted(self.processing_dir.iterdir(), key=lambda item: item.name.casefold()):
            if processing_batch.is_symlink() or not processing_batch.is_dir():
                continue
            pending_batch = self.pending_dir / processing_batch.name
            if pending_batch.exists():
                self._archive(
                    processing_batch,
                    self.failed_dir,
                    processing_batch.name,
                    "falha",
                    "Já existe outro lote pendente com o mesmo identificador.",
                )
                continue
            try:
                processing_batch.rename(pending_batch)
            except OSError:
                logger.exception("Não foi possível recuperar o lote interrompido %s.", processing_batch.name)

    def _return_to_pending(self, processing_batch: Path, batch_id: str) -> None:
        pending_batch = self.pending_dir / batch_id
        if pending_batch.exists():
            self._fail_batch(
                processing_batch,
                batch_id,
                "Não foi possível reagendar o lote porque já existe uma pasta pendente com o mesmo nome.",
            )
            return
        try:
            processing_batch.rename(pending_batch)
        except OSError:
            logger.exception("Não foi possível devolver o lote %s à fila pendente.", batch_id)

    def _fail_batch(self, batch_dir: Path, batch_id: str, detail: str) -> bool:
        self._archive(batch_dir, self.failed_dir, batch_id, "falha", detail)
        logger.warning("Lote automático %s arquivado com falha: %s", batch_id, detail)
        return True

    @staticmethod
    def _archive(
        batch_dir: Path,
        destination_root: Path,
        batch_id: str,
        status: str,
        detail: str,
    ) -> None:
        destination = destination_root / batch_dir.name
        if destination.exists():
            destination = destination_root / f"{batch_dir.name}--{uuid.uuid4().hex[:8]}"
        batch_dir.rename(destination)
        status_path = destination / "_resultado.json"
        temporary_path = destination / f"._resultado-{uuid.uuid4().hex}.tmp"
        temporary_path.write_text(
            json.dumps(
                {
                    "lote_id": batch_id,
                    "status": status,
                    "detalhe": str(detail)[:2000],
                    "registrado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        temporary_path.replace(status_path)


async def automatic_inventory_import_worker(
    inbox: AutomaticInventoryInbox,
    poll_interval_seconds: int = 10,
) -> None:
    """Run the inbox poller until the application lifespan cancels it."""
    while True:
        try:
            await inbox.process_pending_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Falha inesperada ao verificar a pasta automática de planilhas.")
        await asyncio.sleep(max(1, int(poll_interval_seconds)))
