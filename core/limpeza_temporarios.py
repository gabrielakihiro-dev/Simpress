"""Remove duplicate temporaries and quarantine differing snapshots older than seven days.

Shared by the CLI (``scripts/cleanup_local_temps.py``) and the "Saúde local" routes
(``domains/saude_local.py``). Call ``time.time``, ``json.dump`` and the integrity helpers
through their modules: the tests patch them there.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from core import integrity
from core.local_paths import is_link_or_junction


DEFAULT_MIN_AGE_HOURS = 24
QUARANTINE_AGE_HOURS = 7 * 24
QUARANTINE_DIRECTORY = ".temp-quarantine"
_RANDOM_TEMP_SUFFIX = re.compile(r"^[A-Za-z0-9_]{8}$")


class CleanupBlockedError(RuntimeError):
    """Recovery or an unfinished upload prevents a safe temporary-file scan.

    ``codigo`` is "transacoes" or "migracao" for the expected refusals; None for unsafe layouts.
    """

    def __init__(self, message: str, codigo: Optional[str] = None) -> None:
        super().__init__(message)
        self.codigo = codigo


def _inside(path: Path, root: Path) -> bool:
    try:
        return path.resolve(strict=False).is_relative_to(root.resolve(strict=False))
    except OSError:
        return False


def _walk_files(root: Path) -> Iterator[Path]:
    """Every regular file under ``root``, never entering links, junctions or a quarantine folder."""
    if not root.is_dir() or is_link_or_junction(root):
        return
    for current, dirs, files in os.walk(root, followlinks=False):
        base = Path(current)
        dirs[:] = [
            name for name in dirs
            if name != QUARANTINE_DIRECTORY and not is_link_or_junction(base / name)
        ]
        for name in files:
            yield base / name


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _target_for_temporary(temporary: Path) -> Optional[Path]:
    """Recognize only the two temporary naming schemes owned by core/integrity.py."""
    name = temporary.name
    if not name.startswith(".") or not name.endswith(".tmp"):
        return None
    stem = name[1:-4]
    if ".formula-cache-" in stem:
        target_name, random_suffix = stem.rsplit(".formula-cache-", 1)
    else:
        target_name, separator, random_suffix = stem.rpartition(".")
        if not separator:
            return None
    if not target_name or not _RANDOM_TEMP_SUFFIX.fullmatch(random_suffix):
        return None
    return temporary.with_name(target_name)


def _committed_reference_files(target: Path, input_dir: Path) -> List[Path]:
    references = [target] if target.is_file() else []
    if target.parent.resolve(strict=False) == input_dir.resolve(strict=False):
        references.extend(
            path for path in _walk_files(input_dir / "_backups")
            if path.name == target.name and path.is_file() and not is_link_or_junction(path)
        )
    return references


def _quarantine_temporary(temporary: Path, digest: str, scan_root: Path) -> None:
    """Write metadata before moving; keep both the snapshot and its report locally."""
    quarantine = temporary.parent / QUARANTINE_DIRECTORY
    if is_link_or_junction(quarantine) or not _inside(quarantine, scan_root):
        raise CleanupBlockedError("A pasta de quarentena não pode ser um link ou junção.")
    quarantine.mkdir(exist_ok=True)
    batch = Path(tempfile.mkdtemp(prefix="snapshot-", dir=quarantine))
    metadata = temporary.stat()
    report = {"arquivos": [{
        "nome": temporary.name,
        "tamanho": metadata.st_size,
        "data_modificacao": datetime.fromtimestamp(metadata.st_mtime, timezone.utc).isoformat(),
        "sha256": digest,
    }]}
    # If reporting or moving fails, the source is preserved and the error propagates.
    with (batch / "relatorio.json").open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    integrity._replace_with_retries(temporary, batch / temporary.name)


def cleanup_local_temps(
    project_root: Path,
    *,
    min_age_hours: float = DEFAULT_MIN_AGE_HOURS,
    dry_run: bool = False,
    itens: Optional[List[Dict[str, Any]]] = None,
    recuperar_transacoes: bool = True,
) -> Dict[str, int]:
    """Remove duplicates; preserve old differing snapshots in a local quarantine.

    ``itens`` (optional) receives one entry per file ready (prévia) or handled (aplicação):
    acao, area, caminho (raw, relative to the area root, with "/") and bytes.
    ``recuperar_transacoes=False`` only refuses when .transactions has entries (the server).
    """
    if min_age_hours < 0:
        raise ValueError("A idade mínima não pode ser negativa.")
    root = Path(project_root).resolve()
    input_dir = root / "data" / "planilhas_entrada"
    if input_dir.is_dir() and any(
        path.is_dir() and path.name.startswith(".upload-staging-")
        for path in input_dir.iterdir()
    ):
        raise CleanupBlockedError(
            "Há um upload temporário em andamento. Aguarde a operação terminar antes da limpeza.",
            "migracao",
        )

    if recuperar_transacoes:
        try:
            integrity.recover_pending_transactions(root)
        except Exception as error:
            raise CleanupBlockedError(
                "A recuperação transacional não terminou; os temporários foram preservados.",
                "transacoes",
            ) from error

    transaction_dir = root / ".transactions"
    if transaction_dir.is_dir() and any(transaction_dir.iterdir()):
        raise CleanupBlockedError(
            "Ainda há arquivos de recuperação em .transactions; os temporários foram preservados.",
            "transacoes",
        )

    scan_roots = {
        "planilhas_entrada": input_dir,
        "state": root / "data" / "state",
        "modelos": root / "modelos",
    }
    now = time.time()
    result = {
        "examinados": 0,
        "removidos": 0,
        "iguais_prontos": 0,
        "recentes_preservados": 0,
        "diferentes_preservados": 0,
        "quarentena_prontos": 0,
        "quarentenados": 0,
        "sem_destino_preservados": 0,
        "formato_desconhecido_preservado": 0,
        "bloqueados_preservados": 0,
    }

    candidates: Dict[Path, str] = {}
    for area, scan_root in scan_roots.items():
        for path in _walk_files(scan_root):
            if path.name.endswith(".tmp"):
                candidates.setdefault(path, area)

    for temporary in sorted(candidates):
        area = candidates[temporary]
        scan_root = scan_roots[area]
        result["examinados"] += 1
        if is_link_or_junction(temporary) or not _inside(temporary, scan_root):
            result["formato_desconhecido_preservado"] += 1
            continue
        target = _target_for_temporary(temporary)
        if target is None or target.parent != temporary.parent or is_link_or_junction(target):
            result["formato_desconhecido_preservado"] += 1
            continue
        metadata = temporary.stat()
        age_hours = (now - metadata.st_mtime) / 3600
        if age_hours < min_age_hours:
            result["recentes_preservados"] += 1
            continue
        item = {
            "area": area,
            "caminho": temporary.relative_to(scan_root).as_posix(),
            "bytes": metadata.st_size,
        }

        try:
            with integrity.lock_paths([target], timeout=0.0):
                reference_files = _committed_reference_files(target, input_dir)
                if not reference_files:
                    result["sem_destino_preservados"] += 1
                    continue
                temporary_hash = _digest(temporary)
                # Even a match in an old backup cannot authorize deleting a
                # snapshot that differs from today's target after seven days.
                if (age_hours > QUARANTINE_AGE_HOURS
                        and target.is_file() and temporary_hash != _digest(target)):
                    result["quarentena_prontos"] += 1
                    if not dry_run:
                        _quarantine_temporary(temporary, temporary_hash, scan_root)
                        result["quarentenados"] += 1
                    if itens is not None:
                        itens.append({"acao": "quarentena", **item})
                    continue
                if not any(temporary_hash == _digest(reference) for reference in reference_files):
                    result["diferentes_preservados"] += 1
                    continue
                result["iguais_prontos"] += 1
                if not dry_run:
                    temporary.unlink()
                    result["removidos"] += 1
                if itens is not None:
                    itens.append({"acao": "remover", **item})
        except integrity.FileBusyError:
            result["bloqueados_preservados"] += 1

    return result
