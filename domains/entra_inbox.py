"""Restart-safe local inbox for Entra CSV exports."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable

from core.local_paths import is_link_or_junction
from domains.entra_users import MAX_CSV_BYTES


logger = logging.getLogger(__name__)

RESULT_NAME = "_resultado.json"


class EntraInbox:
    def __init__(self, root: Path, import_csv: Callable[[bytes], dict[str, Any]]) -> None:
        self.root = root
        self.import_csv = import_csv
        self._seen: dict[str, tuple[tuple[str, int, int], ...]] = {}

    def process_once(self) -> None:
        pending = self.root / "pendentes"
        processing = self.root / "processando"
        completed = self.root / "processadas"
        failed = self.root / "falhas"
        for directory in (pending, processing, completed, failed):
            directory.mkdir(parents=True, exist_ok=True)
        # A batch claimed before a restart is retried; the current name directory is replaced atomically.
        pending_batches = sorted(pending.iterdir())
        # Forget batches deleted or moved by hand, so _seen cannot grow without bound.
        names = {item.name for item in pending_batches}
        self._seen = {name: signature for name, signature in self._seen.items() if name in names}
        batches = sorted(processing.iterdir()) + pending_batches
        for batch in batches:
            if not batch.is_dir() or is_link_or_junction(batch) or batch.name.startswith("."):
                continue
            result_file = batch / RESULT_NAME
            if batch.parent == processing and result_file.is_file():
                self._recover(batch, completed, failed, result_file)
                continue
            files = [item for item in batch.iterdir() if item.name != RESULT_NAME]
            if batch.parent == pending:
                # A batch still being copied changes between passes; wait until it is stable.
                signature = self._signature(files)
                if self._seen.get(batch.name) != signature:
                    self._seen[batch.name] = signature
                    continue
                if (processing / batch.name).exists():
                    continue
            if len(files) != 1 or not files[0].is_file() or is_link_or_junction(files[0]) or files[0].suffix.lower() != ".csv":
                self._seen.pop(batch.name, None)
                self._finish(batch, failed, {"status": "falha", "erro": "O lote deve conter exatamente um CSV."})
                continue
            if batch.parent == pending:
                batch.rename(processing / batch.name)
                batch = processing / batch.name
                files = [batch / files[0].name]
            source = files[0]
            try:
                if source.stat().st_size > MAX_CSV_BYTES:
                    raise ValueError("O CSV excede 60 MB.")
                result = self.import_csv(source.read_bytes())
                self._finish(batch, completed, {"status": "concluido", **result})
            except (OSError, ValueError) as error:
                logger.warning("Falha no lote Entra %s: %s", batch.name, error)
                self._finish(batch, failed, {"status": "falha", "erro": str(error)})
            finally:
                self._seen.pop(batch.name, None)

    @staticmethod
    def _signature(files: list[Path]) -> tuple[tuple[str, int, int], ...]:
        entries = []
        for item in files:
            try:
                stat = item.stat()
            except OSError:
                return ()
            entries.append((item.name, stat.st_size, stat.st_mtime_ns))
        return tuple(sorted(entries))

    @staticmethod
    def _recover(batch: Path, completed: Path, failed: Path, result_file: Path) -> None:
        """Move a batch whose result was written but whose rename was interrupted."""
        try:
            status = json.loads(result_file.read_text(encoding="utf-8")).get("status")
        except (OSError, ValueError):
            status = None
        destination = completed if status == "concluido" else failed
        target = destination / batch.name
        if target.exists():
            logger.warning("Lote Entra %s preservado: destino já existe.", batch.name)
            return
        batch.rename(target)

    @staticmethod
    def _finish(batch: Path, destination: Path, result: dict[str, Any]) -> None:
        target = destination / batch.name
        if target.exists():
            logger.warning("Lote Entra %s preservado: destino já existe.", batch.name)
            return
        (batch / RESULT_NAME).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        batch.rename(target)
