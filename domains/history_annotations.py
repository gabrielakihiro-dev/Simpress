"""Small per-row annotation records kept outside the cloned repository."""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from integrity import atomic_write_json


MAX_ANNOTATION_LENGTH = 2000


def _record_path(directory: Path, event_id: str, item_id: str) -> Path:
    key = f"{event_id}\0{item_id}".encode("utf-8")
    return Path(directory) / f"{hashlib.sha256(key).hexdigest()}.json"


def save_history_annotation(
    directory: Path,
    *,
    event_id: str,
    event_time: str,
    item_id: str,
    serie: str,
    computador: str,
    motivo: str,
    anotacao: str,
    categoria: str = "apelidos_sem_atualizacao",
    updated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Atomically save only the annotation and the row context needed to display it."""
    if not isinstance(event_id, str) or not event_id.strip():
        raise ValueError("O identificador da atualização é inválido.")
    if not isinstance(item_id, str) or not item_id.strip():
        raise ValueError("O identificador da linha é inválido.")
    if not isinstance(anotacao, str) or len(anotacao) > MAX_ANNOTATION_LENGTH:
        raise ValueError("A anotação excede o limite permitido.")

    record = {
        "versao": 1,
        "evento_id": event_id,
        "horario": str(event_time or "")[:80],
        "item_id": item_id,
        "serie": str(serie or "")[:200],
        "computador": str(computador or "")[:500],
        "motivo": str(motivo or "")[:1000],
        "categoria": str(categoria or "apelidos_sem_atualizacao")[:80],
        "anotacao": anotacao,
        "atualizado_em": updated_at or datetime.now(timezone.utc).isoformat(timespec="microseconds"),
    }
    target = _record_path(Path(directory), event_id, item_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(target, record)
    return record


def load_history_annotations(directory: Path) -> List[Dict[str, Any]]:
    """Read valid annotation records; ignore incomplete OneDrive sync copies."""
    root = Path(directory)
    if not root.is_dir():
        return []

    records = []
    for path in sorted(root.glob("*.json")):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if not isinstance(record, dict) or record.get("versao") != 1:
            continue
        if not isinstance(record.get("evento_id"), str) or not record["evento_id"].strip():
            continue
        if not isinstance(record.get("item_id"), str) or not record["item_id"].strip():
            continue
        if not isinstance(record.get("anotacao"), str) or len(record["anotacao"]) > MAX_ANNOTATION_LENGTH:
            continue
        records.append(record)
    return records
