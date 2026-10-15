"""Small per-row annotation records kept outside the cloned repository."""

import copy
import hashlib
import json
import logging
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Iterable

from core.integrity import FileBusyError

logger = logging.getLogger(__name__)

MAX_ANNOTATION_LENGTH = 2000
_REVISION_ID = re.compile(r"(?:[a-f0-9]{32}|legacy-[a-f0-9]{64})\Z")


def history_annotation_record_path(directory: Path, event_id: str, item_id: str, revision_id: Optional[str] = None) -> Path:
    key = f"{event_id}\0{item_id}".encode("utf-8")
    suffix = ""
    if revision_id is not None:
        if not isinstance(revision_id, str) or not _REVISION_ID.fullmatch(revision_id):
            raise ValueError("A revisão da anotação é inválida.")
        suffix = f".{revision_id}"
    return Path(directory) / f"{hashlib.sha256(key).hexdigest()}{suffix}.json"


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
    revision_id: Optional[str] = None,
    base_revisions: Optional[List[str]] = None,
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

    revision_id = revision_id or uuid.uuid4().hex
    history_annotation_record_path(Path("."), event_id, item_id, revision_id)
    if base_revisions is not None and (not isinstance(base_revisions, list) or len(base_revisions) > 100):
        raise ValueError("As revisões-base da anotação são inválidas.")
    if any(
        not isinstance(parent, str) or not _REVISION_ID.fullmatch(parent) or parent == revision_id
        for parent in (base_revisions or [])
    ):
        raise ValueError("As revisões-base da anotação são inválidas.")
    parents = sorted(set(base_revisions or []))
    record = {
        "versao": 2,
        "revisao_id": revision_id,
        "base_revisoes": parents,
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
    """Publish an immutable revision. Retries never replace an existing file."""
    record = build_history_annotation_record(**values)
    target = history_annotation_record_path(directory, record["evento_id"], record["item_id"], record["revisao_id"])
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".annotation-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        try:
            # Atomic create-if-absent, including concurrent retries on this filesystem.
            if os.name == "nt":
                # Windows rename fails if the destination exists (unlike POSIX rename).
                os.rename(temporary, target)
            else:
                os.link(temporary, target)
        except FileExistsError:
            pass
        saved = json.loads(target.read_text(encoding="utf-8"))
        if not same_annotation_revision(saved, record):
            raise ValueError("Uma revisão existente possui outro conteúdo; arquivo preservado.")
        return saved
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def same_annotation_revision(left: Dict[str, Any], right: Dict[str, Any]) -> bool:
    # The first persisted server timestamp wins when an HTTP request is retried.
    return ({k: v for k, v in left.items() if k != "atualizado_em"}
            == {k: v for k, v in right.items() if k != "atualizado_em"})


def reuse_annotation_revision(directory: Path, record: Dict[str, Any]) -> Dict[str, Any]:
    path = history_annotation_record_path(directory, record["evento_id"], record["item_id"], record["revisao_id"])
    if not path.exists():
        return record
    saved = json.loads(path.read_text(encoding="utf-8"))
    if not same_annotation_revision(saved, record):
        raise ValueError("A revisão já foi usada com outro conteúdo.")
    return saved


def annotation_revision(record: Dict[str, Any]) -> Dict[str, Any]:
    """Give v1 content a stable virtual revision, without rewriting the source."""
    if record.get("versao") == 2:
        return dict(record)
    digest = hashlib.sha256(json.dumps(record, sort_keys=True, ensure_ascii=False,
                                       separators=(",", ":")).encode("utf-8")).hexdigest()
    return build_history_annotation_record(
        event_id=record["evento_id"], item_id=record["item_id"],
        event_time=record.get("horario", ""), serie=record.get("serie", ""),
        computador=record.get("computador", ""), motivo=record.get("motivo", ""),
        anotacao=record["anotacao"], categoria=record.get("categoria", "apelidos_sem_atualizacao"),
        linha_hash=record.get("linha_hash"),
        updated_at=record.get("atualizado_em") or record.get("horario") or "1970-01-01T00:00:00+00:00",
        revision_id=f"legacy-{digest}",
    )


def annotation_record_values(record: Dict[str, Any]) -> Dict[str, Any]:
    revision = annotation_revision(record)
    return {
        "event_id": revision["evento_id"], "event_time": revision.get("horario", ""),
        "item_id": revision["item_id"], "serie": revision.get("serie", ""),
        "computador": revision.get("computador", ""), "motivo": revision.get("motivo", ""),
        "anotacao": revision["anotacao"], "categoria": revision.get("categoria", "apelidos_sem_atualizacao"),
        "linha_hash": revision.get("linha_hash"), "updated_at": revision.get("atualizado_em"),
        "revision_id": revision["revisao_id"], "base_revisions": revision["base_revisoes"],
    }


def resolve_history_annotations(records: Iterable[Dict[str, Any]]) -> Dict[tuple[str, str], Dict[str, Any]]:
    """Resolve causal heads, never using clocks or directory precedence to pick a winner."""
    grouped: Dict[tuple[str, str], List[Dict[str, Any]]] = {}
    for raw in records:
        record = annotation_revision(raw)
        grouped.setdefault((record["evento_id"], record["item_id"]), []).append(record)
    result = {}
    for key, revisions in grouped.items():
        by_id: Dict[str, Dict[str, Any]] = {}
        invalid = False
        collisions = []
        for revision in revisions:
            previous = by_id.get(revision["revisao_id"])
            if previous is not None and not same_annotation_revision(previous, revision):
                invalid = True
                collisions.extend([previous, revision])
            by_id[revision["revisao_id"]] = revision
        parents = {parent for revision in by_id.values() for parent in revision["base_revisoes"]}
        missing = sorted(parents - by_id.keys())
        children: Dict[str, List[str]] = {rid: [] for rid in by_id}
        degrees = {}
        for rid, revision in by_id.items():
            known_parents = set(revision["base_revisoes"]) & by_id.keys()
            degrees[rid] = len(known_parents)
            for parent in known_parents:
                children[parent].append(rid)
        ready = [rid for rid, degree in degrees.items() if degree == 0]
        visited = set()
        while ready:
            rid = ready.pop()
            visited.add(rid)
            for child in children[rid]:
                degrees[child] -= 1
                if degrees[child] == 0:
                    ready.append(child)
        cyclic = set(by_id) - visited
        invalid = invalid or bool(cyclic)
        heads = [revision for rid, revision in sorted(by_id.items()) if rid not in parents]
        if invalid:
            heads.extend(by_id[rid] for rid in sorted(cyclic))
            heads.extend(collisions)
        if not heads:  # Malformed cycles cannot turn into a successful empty annotation.
            heads = list(by_id.values())
            invalid = True
        conflict = len(heads) > 1 or bool(missing) or invalid
        result[key] = {
            **heads[0],
            "anotacao": "" if conflict else heads[0]["anotacao"],
            "anotacao_revisoes": sorted({revision["revisao_id"] for revision in heads}),
            "anotacao_conflito": conflict,
            "anotacao_integridade_invalida": invalid,
            "anotacao_bases_ausentes": missing,
            "anotacao_conflitos": [
                {"revisao_id": revision["revisao_id"], "anotacao": revision["anotacao"],
                 "atualizado_em": revision.get("atualizado_em", "")}
                for revision in heads
            ] if conflict else [],
        }
    return result


def load_effective_history_annotations(
    shared_directory: Path,
    outbox_directory: Path,
    loader: Callable[..., List[Dict[str, Any]]],
    *,
    strict: bool = False,
) -> Dict[tuple[str, str], Dict[str, Any]]:
    """Resolve shared and pending revisions together, without directory precedence."""
    if strict:
        return resolve_history_annotations([
            *loader(shared_directory, strict=True), *loader(outbox_directory, strict=True),
        ])
    return resolve_history_annotations([
        *loader(shared_directory), *loader(outbox_directory),
    ])


def effective_history_annotation(
    records: Dict[tuple[str, str], Dict[str, Any]],
    event_id: str,
    item_id: str,
    embedded: Any = None,
    legacy: Any = None,
) -> Dict[str, Any]:
    """Return the observed note; even an empty revision or conflict blocks legacy text."""
    record = records.get((event_id, item_id))
    if record is not None:
        return annotation_view(record)
    for candidate in (embedded, legacy):
        if isinstance(candidate, str):
            return {"anotacao": candidate}
    return {"anotacao": ""}


def annotation_view(record: Dict[str, Any]) -> Dict[str, Any]:
    return {key: record[key] for key in (
        "anotacao", "anotacao_revisoes", "anotacao_conflito",
        "anotacao_conflitos", "anotacao_bases_ausentes",
        "anotacao_integridade_invalida",
    ) if key in record}


def annotation_export_text(record: Dict[str, Any]) -> str:
    if not record.get("anotacao_conflito"):
        return str(record.get("anotacao") or "")
    alternatives = "\n".join(
        f"{candidate['revisao_id']}: {candidate['anotacao'] or '(Anotação vazia)'}"
        for candidate in record.get("anotacao_conflitos", [])
    )
    return f"[CONFLITO DE ANOTAÇÃO — versões preservadas]\n{alternatives}"


def sync_history_annotation(record, *, directory, outbox, transaction_root,
                            transaction_factory, publisher=save_history_annotation) -> bool:
    """Acknowledge the exact immutable revision, then remove only its own pending file."""
    values = annotation_record_values(record)
    expected = annotation_revision(record)
    saved = publisher(directory, **values)
    if not same_annotation_revision(saved, expected):
        raise ValueError("A revisão publicada não corresponde à pendência.")
    published = history_annotation_record_path(directory, record["evento_id"], record["item_id"], expected["revisao_id"])
    if not same_annotation_revision(json.loads(published.read_text(encoding="utf-8")), expected):
        raise ValueError("A confirmação da revisão publicada falhou.")
    pending = history_annotation_record_path(outbox, record["evento_id"], record["item_id"],
                                             record.get("revisao_id") if record.get("versao") == 2 else None)
    with transaction_factory(transaction_root, [pending]) as transaction:
        if pending.exists():
            current = json.loads(pending.read_text(encoding="utf-8"))
            if current != record:
                return False
            transaction.stage_delete(pending)
            transaction.commit()
    return True


class AnnotationReadError(FileBusyError):
    """An annotation file exists but could not be read (locked or a cloud placeholder)."""


# Parsed records keyed by directory, then file name, valid while (size, mtime_ns) match.
# ``None`` marks an invalid file so it is not reparsed on every listing.
_RecordCache = Dict[str, tuple[int, int, Optional[Dict[str, Any]]]]
_load_cache: Dict[str, _RecordCache] = {}
_load_cache_lock = threading.Lock()


def _validated_annotation_record(record: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(record, dict) or record.get("versao") not in (1, 2):
        return None
    if not isinstance(record.get("evento_id"), str) or not record["evento_id"].strip():
        return None
    if not isinstance(record.get("item_id"), str) or not record["item_id"].strip():
        return None
    if not isinstance(record.get("anotacao"), str) or len(record["anotacao"]) > MAX_ANNOTATION_LENGTH:
        return None
    try:
        if record["versao"] == 2:
            validated = build_history_annotation_record(**annotation_record_values(record))
            if not same_annotation_revision(validated, record):
                return None
        else:
            annotation_revision(record)
    except (ValueError, TypeError, KeyError):
        return None
    return record


def load_history_annotations(directory: Path, *, strict: bool = False) -> List[Dict[str, Any]]:
    """Read valid annotation records, ignoring invalid ones (e.g. incomplete sync copies).

    A file that exists but cannot be read (``OSError``, e.g. locked by OneDrive or
    an offline placeholder) is not the same as an invalid one: with ``strict`` it
    raises ``AnnotationReadError`` so callers that inherit notes can retry instead
    of silently dropping a revision; otherwise it is logged and the rest is returned.
    """
    root = Path(directory)
    if not root.is_dir():
        return []

    cache_key = str(root.resolve(strict=False))
    with _load_cache_lock:
        previous = dict(_load_cache.get(cache_key, {}))
    current: _RecordCache = {}
    records = []
    unreadable = []
    for path in sorted(root.glob("*.json")):
        try:
            if path.is_symlink() or not path.is_file():
                continue
            status = path.stat()
            cached = previous.get(path.name)
            if cached is not None and cached[:2] == (status.st_size, status.st_mtime_ns):
                record = cached[2]
            else:
                raw = path.read_bytes()
                try:
                    record = _validated_annotation_record(json.loads(raw.decode("utf-8")))
                except (UnicodeError, json.JSONDecodeError):
                    record = None
        except FileNotFoundError:
            continue  # Removed between listing and reading, e.g. by a concurrent flush.
        except OSError as error:
            logger.warning(
                "Anotação ilegível ignorada nesta leitura (arquivo=%s, erro=%s).",
                path.name, type(error).__name__,
            )
            unreadable.append(path.name)
            continue
        current[path.name] = (status.st_size, status.st_mtime_ns, record)
        if record is not None:
            records.append(copy.deepcopy(record))

    with _load_cache_lock:
        _load_cache[cache_key] = current
    if strict and unreadable:
        raise AnnotationReadError(
            "Há anotações do histórico que não puderam ser lidas agora (arquivo em uso ou ainda "
            "não baixado pelo OneDrive). Aguarde a sincronização e tente novamente."
        )
    return records
