"""Restart-safe folder intake for Simpress and Oracle ticket workbooks."""

from __future__ import annotations

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
from typing import Any, Callable, Optional, cast

from fastapi import HTTPException


logger = logging.getLogger(__name__)
_WORKER_LOCK = threading.Lock()


class TicketInboxError(ValueError):
    """A ticket batch is not ready or cannot be imported safely."""


class TicketInboxChanged(RuntimeError):
    """An input workbook changed while the importer was reading it."""


@contextmanager
def _try_worker_lock(path: Path):
    if not _WORKER_LOCK.acquire(blocking=False):
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

                cast(Any, fcntl).flock(handle.fileno(), fcntl.LOCK_UN)
        if handle is not None:
            handle.close()
        _WORKER_LOCK.release()


class AutomaticTicketInbox:
    """Import stable workbook pairs and retain every input batch for audit."""

    ROLES = ("simpress", "oracle")

    def __init__(
        self,
        root: Path,
        report_path: Path,
        max_upload_bytes: int,
        import_batch: Callable[[str, str, bytes, str, bytes], Any],
    ) -> None:
        self.root = Path(root)
        self.report_path = Path(report_path)
        self.max_upload_bytes = int(max_upload_bytes)
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
        """Keep filesystem and workbook work off the application event loop."""
        return await asyncio.to_thread(self.process_pending_once_sync)

    def process_pending_once_sync(self) -> int:
        """Process stable batches synchronously for the local command-line runner."""
        for directory in (self.pending_dir, self.processing_dir, self.processed_dir, self.failed_dir):
            directory.mkdir(parents=True, exist_ok=True)

        completed = 0
        with _try_worker_lock(self.root / ".importador.lock") as locked:
            if not locked:
                return 0
            self._recover_interrupted_batches()
            active_names: set[str] = set()
            for batch_dir in sorted(self.pending_dir.iterdir(), key=lambda item: item.name.casefold()):
                if batch_dir.is_symlink() or not batch_dir.is_dir():
                    continue
                active_names.add(batch_dir.name)
                try:
                    snapshot = self._batch_snapshot(batch_dir)
                except OSError:
                    logger.exception("Não foi possível inspecionar o lote de chamados %s.", batch_dir.name)
                    continue
                if snapshot is None:
                    continue
                if self._stable_snapshots.get(batch_dir.name) != snapshot:
                    self._stable_snapshots[batch_dir.name] = snapshot
                    continue
                self._stable_snapshots.pop(batch_dir.name, None)
                if self._process_stable_batch(batch_dir):
                    completed += 1

            for batch_name in set(self._stable_snapshots) - active_names:
                self._stable_snapshots.pop(batch_name, None)
        return completed

    def _batch_snapshot(self, batch_dir: Path) -> Optional[tuple[tuple[Any, ...], ...]]:
        entries: list[tuple[Any, ...]] = []
        for role in self.ROLES:
            role_dir = batch_dir / role
            if not role_dir.exists() and not role_dir.is_symlink():
                return None
            entries.append(self._stat_signature(role, role_dir))
            if role_dir.is_symlink() or not role_dir.is_dir():
                continue
            files = sorted(role_dir.iterdir(), key=lambda item: item.name.casefold())
            entries.extend(self._stat_signature(f"{role}/{item.name}", item) for item in files)
            if not any(item.suffix.lower() == ".xlsx" and not item.name.startswith("~$") for item in files):
                return None
        return tuple(entries)

    @staticmethod
    def _stat_signature(label: str, path: Path) -> tuple[Any, ...]:
        details = path.lstat()
        return label, details.st_mode, details.st_size, details.st_mtime_ns

    def _process_stable_batch(self, pending_batch: Path) -> bool:
        batch_id = pending_batch.name
        processing_batch = self.processing_dir / batch_id
        if (self.processed_dir / batch_id).exists():
            return self._fail_batch(pending_batch, batch_id, "Este identificador de lote já foi usado.")
        if processing_batch.exists():
            return self._fail_batch(pending_batch, batch_id, "Já existe um lote com este identificador em processamento.")

        try:
            pending_batch.rename(processing_batch)
        except OSError:
            logger.exception("Não foi possível reservar o lote de chamados %s.", batch_id)
            return False

        try:
            if self._history_contains_batch(batch_id):
                self._archive(processing_batch, self.processed_dir, batch_id, "concluido", "Lote já consta no histórico; não foi importado novamente.")
                return True
            simpress_name, simpress_bytes = self._read_workbook(self._select_workbook(processing_batch, "simpress"))
            oracle_name, oracle_bytes = self._read_workbook(self._select_workbook(processing_batch, "oracle"))
        except TicketInboxChanged:
            self._return_to_pending(processing_batch, batch_id)
            return False
        except TicketInboxError as error:
            return self._fail_batch(processing_batch, batch_id, str(error))
        except (OSError, UnicodeError, json.JSONDecodeError):
            logger.exception("Falha ao ler o lote de chamados %s.", batch_id)
            self._return_to_pending(processing_batch, batch_id)
            return False

        try:
            self.import_batch(batch_id, simpress_name, simpress_bytes, oracle_name, oracle_bytes)
        except HTTPException as error:
            if error.status_code in (409, 503):
                logger.info("Lote de chamados %s aguardará nova tentativa: %s", batch_id, error.detail)
                self._return_to_pending(processing_batch, batch_id)
                return False
            return self._fail_batch(processing_batch, batch_id, str(error.detail))
        except Exception as error:
            logger.exception("Falha permanente ao importar o lote de chamados %s.", batch_id)
            return self._fail_batch(processing_batch, batch_id, f"Falha na importação ({type(error).__name__}).")

        self._archive(processing_batch, self.processed_dir, batch_id, "concluido", "Importação confirmada no histórico de chamados.")
        return True

    def _history_contains_batch(self, batch_id: str) -> bool:
        if not self.report_path.exists():
            return False
        report = json.loads(self.report_path.read_text(encoding="utf-8"))
        receipts = report.get("importacoes_automaticas", []) if isinstance(report, dict) else []
        return isinstance(receipts, list) and any(
            isinstance(item, dict) and item.get("lote_id") == batch_id
            for item in receipts
        )

    @staticmethod
    def _select_workbook(batch_dir: Path, role: str) -> Path:
        role_dir = batch_dir / role
        if role_dir.is_symlink() or not role_dir.is_dir():
            raise TicketInboxError(f"Crie a pasta '{role}' diretamente no lote.")
        files = [item for item in role_dir.iterdir() if item.suffix.lower() == ".xlsx" and not item.name.startswith("~$")]
        if len(files) != 1:
            raise TicketInboxError(f"A pasta '{role}' deve conter exatamente um arquivo .xlsx; encontrados: {len(files)}.")
        path = files[0]
        if path.is_symlink() or not path.is_file():
            raise TicketInboxError(f"O arquivo de '{role}' precisa ser um arquivo normal, sem link simbólico.")
        return path

    def _read_workbook(self, path: Path) -> tuple[str, bytes]:
        if path.is_symlink():
            raise TicketInboxError("Links simbólicos não podem ser processados na pasta de entrada.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                raise TicketInboxError("Os arquivos de entrada devem ser arquivos XLSX regulares.")
            if before.st_size <= 0:
                raise TicketInboxError(f"O arquivo '{path.name}' está vazio.")
            if before.st_size > self.max_upload_bytes:
                raise TicketInboxError(f"O arquivo '{path.name}' excede o limite de 32 MB.")
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                content = source.read(self.max_upload_bytes + 1)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        if len(content) > self.max_upload_bytes:
            raise TicketInboxError(f"O arquivo '{path.name}' excede o limite de 32 MB.")
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise TicketInboxChanged("O arquivo mudou durante a leitura.")
        return path.name, content

    def _recover_interrupted_batches(self) -> None:
        for processing_batch in sorted(self.processing_dir.iterdir(), key=lambda item: item.name.casefold()):
            if processing_batch.is_symlink() or not processing_batch.is_dir():
                continue
            pending_batch = self.pending_dir / processing_batch.name
            if pending_batch.exists():
                self._archive(processing_batch, self.failed_dir, processing_batch.name, "falha", "Já existe outro lote pendente com o mesmo identificador.")
                continue
            try:
                processing_batch.rename(pending_batch)
            except OSError:
                logger.exception("Não foi possível recuperar o lote de chamados interrompido %s.", processing_batch.name)

    def _return_to_pending(self, processing_batch: Path, batch_id: str) -> None:
        pending_batch = self.pending_dir / batch_id
        if pending_batch.exists():
            self._fail_batch(processing_batch, batch_id, "Não foi possível reagendar o lote porque já existe outro lote com o mesmo nome.")
            return
        try:
            processing_batch.rename(pending_batch)
        except OSError:
            logger.exception("Não foi possível devolver o lote de chamados %s à fila pendente.", batch_id)

    def _fail_batch(self, batch_dir: Path, batch_id: str, detail: str) -> bool:
        self._archive(batch_dir, self.failed_dir, batch_id, "falha", detail)
        logger.warning("Lote de chamados %s arquivado com falha: %s", batch_id, detail)
        return True

    @staticmethod
    def _archive(batch_dir: Path, destination_root: Path, batch_id: str, status: str, detail: str) -> None:
        destination = destination_root / batch_dir.name
        if destination.exists():
            destination = destination_root / f"{batch_dir.name}--{uuid.uuid4().hex[:8]}"
        batch_dir.rename(destination)
        temporary_path = destination / f"._resultado-{uuid.uuid4().hex}.tmp"
        temporary_path.write_text(
            json.dumps({
                "lote_id": batch_id,
                "status": status,
                "detalhe": str(detail)[:2000],
                "registrado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_path.replace(destination / "_resultado.json")


async def automatic_ticket_import_worker(inbox: AutomaticTicketInbox, poll_interval_seconds: int = 10) -> None:
    while True:
        try:
            await inbox.process_pending_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Falha inesperada ao verificar a pasta automática de chamados.")
        await asyncio.sleep(max(1, int(poll_interval_seconds)))
