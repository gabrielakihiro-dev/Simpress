"""Small per-row annotation records kept outside the cloned repository."""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from integrity import atomic_write_json


MAX_ANNOTATION_LENGTH = 2000


def history_annotation_record_path(directory: Path, event_id: str, item_id: str) -> Path:
    key = f"{event_id}\0{item_id}".encode("utf-8")
    return Path(directory) / f"{hashlib.sha256(key).hexdigest()}.json"


def history_annotation_row_fingerprint(category: str, item: Dict[str, Any]) -> str:
    """Hash the complete row data and section, excluding annotation metadata."""
    if not isinstance(item, dict):
        raise ValueError("A linha da anotação é inválida.")
    row_data = {
        key: value
        for key, value in item.items()
        if key not in {"anotacao", "anotacao_id"}
    }
    payload = json.dumps(
        [str(category or ""), row_data],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_history_annotation_record(
    *,
    event_id: str,
    event_time: str,
    item_id: str,
    serie: str,
    computador: str,
    motivo: str,
    anotacao: str,
    categoria: str = "apelidos_sem_atualizacao",
    linha_hash: Optional[str] = None,
    updated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a validated annotation record with enough row context to display it."""
    if not isinstance(event_id, str) or not event_id.strip():
        raise ValueError("O identificador da atualização é inválido.")
    if not isinstance(item_id, str) or not item_id.strip():
        raise ValueError("O identificador da linha é inválido.")
    if not isinstance(anotacao, str) or len(anotacao) > MAX_ANNOTATION_LENGTH:
        raise ValueError("A anotação excede o limite permitido.")
    if linha_hash is not None and (
        not isinstance(linha_hash, str)
        or len(linha_hash) != 64
        or any(character not in "0123456789abcdef" for character in linha_hash)
    ):
        raise ValueError("A assinatura da linha é inválida.")

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
    if linha_hash is not None:
        record["linha_hash"] = linha_hash
    return record


def save_history_annotation(
    directory: Path,
    **values: Any,
) -> Dict[str, Any]:
    """Atomically save only the annotation and the row context needed to display it."""
    record = build_history_annotation_record(**values)
    target = history_annotation_record_path(directory, record["evento_id"], record["item_id"])
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
