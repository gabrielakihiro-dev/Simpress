"""Remove duplicate temporaries and quarantine differing snapshots older than seven days."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core import integrity
from core.local_paths import is_link_or_junction


DEFAULT_MIN_AGE_HOURS = 24
QUARANTINE_AGE_HOURS = 7 * 24
QUARANTINE_DIRECTORY = ".temp-quarantine"
_RANDOM_TEMP_SUFFIX = re.compile(r"^[A-Za-z0-9_]{8}$")


class CleanupBlockedError(RuntimeError):
    """Recovery or an unfinished upload prevents a safe temporary-file scan."""


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
        backups = input_dir / "_backups"
        if backups.is_dir() and not backups.is_symlink():
            references.extend(
                path for path in backups.rglob(target.name)
                if path.is_file() and not path.is_symlink()
            )
    return references


def _quarantine_temporary(temporary: Path, digest: str) -> None:
    """Write metadata before moving; keep both the snapshot and its report locally."""
    quarantine = temporary.parent / QUARANTINE_DIRECTORY
    if is_link_or_junction(quarantine):
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
) -> Dict[str, int]:
    """Remove duplicates; preserve old differing snapshots in a local quarantine."""
    if min_age_hours < 0:
        raise ValueError("A idade mínima não pode ser negativa.")
    root = Path(project_root).resolve()
    input_dir = root / "data" / "planilhas_entrada"
    if input_dir.is_dir() and any(
        path.is_dir() and path.name.startswith(".upload-staging-")
        for path in input_dir.iterdir()
    ):
        raise CleanupBlockedError(
            "Há um upload temporário em andamento. Aguarde a operação terminar antes da limpeza."
        )

    try:
        integrity.recover_pending_transactions(root)
    except Exception as error:
        raise CleanupBlockedError(
            "A recuperação transacional não terminou; os temporários foram preservados."
        ) from error

    transaction_dir = root / ".transactions"
    if transaction_dir.is_dir() and any(transaction_dir.iterdir()):
        raise CleanupBlockedError(
            "Ainda há arquivos de recuperação em .transactions; os temporários foram preservados."
        )

    scan_roots = (
        input_dir,
        root / "data" / "state",
        root / "modelos",
    )
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

    candidates: List[Path] = []
    for scan_root in scan_roots:
        if scan_root.is_dir() and not scan_root.is_symlink():
            candidates.extend(
                path for path in scan_root.rglob("*.tmp")
                if QUARANTINE_DIRECTORY not in path.relative_to(scan_root).parts and path.is_file()
            )

    for temporary in sorted(set(candidates)):
        result["examinados"] += 1
        if temporary.is_symlink():
            result["formato_desconhecido_preservado"] += 1
            continue
        target = _target_for_temporary(temporary)
        if target is None or target.parent != temporary.parent or target.is_symlink():
            result["formato_desconhecido_preservado"] += 1
            continue
        age_hours = (now - temporary.stat().st_mtime) / 3600
        if age_hours < min_age_hours:
            result["recentes_preservados"] += 1
            continue

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
                        _quarantine_temporary(temporary, temporary_hash)
                        result["quarentenados"] += 1
                    continue
                if not any(temporary_hash == _digest(reference) for reference in reference_files):
                    result["diferentes_preservados"] += 1
                    continue
                result["iguais_prontos"] += 1
                if not dry_run:
                    temporary.unlink()
                    result["removidos"] += 1
        except integrity.FileBusyError:
            result["bloqueados_preservados"] += 1

    return result


def _summary(result: Dict[str, int], *, dry_run: bool) -> str:
    action = "candidato(s) seguro(s)" if dry_run else "arquivo(s) removido(s)"
    count = result["iguais_prontos"] if dry_run else result["removidos"]
    return (
        f"Limpeza concluída: {count} {action}; "
        f"{result['quarentena_prontos'] if dry_run else result['quarentenados']} "
        f"versão(ões) diferente(s) {'para quarentena' if dry_run else 'em quarentena'}; "
        f"{result['diferentes_preservados']} versão(ões) diferente(s), "
        f"{result['recentes_preservados']} arquivo(s) recente(s) e "
        f"{result['bloqueados_preservados']} arquivo(s) bloqueado(s) preservado(s)."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Remove duplicatas antigas e move versões diferentes com mais de 7 dias para quarentena.",
    )
    parser.add_argument(
        "--min-age-hours",
        type=float,
        default=DEFAULT_MIN_AGE_HOURS,
        help="Idade mínima para considerar um temporário (padrão: 24 horas).",
    )
    arguments = parser.parse_args()
    try:
        report = cleanup_local_temps(
            PROJECT_ROOT,
            min_age_hours=arguments.min_age_hours,
            dry_run=not arguments.apply,
        )
    except (CleanupBlockedError, OSError, ValueError) as error:
        raise SystemExit(f"Limpeza interrompida com segurança: {error}") from error
    print(_summary(report, dry_run=not arguments.apply))
