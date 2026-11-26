"""Ticket workbook import shared by the HTTP upload and the automatic folder inbox.

The import validates the Simpress and Oracle sources, reconciles them, appends a
snapshot to the ticket report and stages the inherited timeline annotations in
the same transaction. Failures raise ``TicketImportError`` with the status and
message the API already answers; the route turns them into ``HTTPException``
and the inbox reads the status directly (409/503 keep the batch pending).
The timeline annotation and export selection the route shares with the import live here too and raise ``DomainError``.
"""

from __future__ import annotations

import io
import json
import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from uuid import uuid4

from core.config import format_size_limit
from core.errors import DomainBusyError, DomainConflictError, DomainError, DomainValidationError
from core.integrity import AtomicFileTransaction, FileBusyError, FileTransactionError
from core.logging_setup import redact_reference
from core.xlsx_safety import XlsxLimitExceeded, XlsxPackageError
from domains.history_annotations import (
    AnnotationReadError,
    annotation_view,
    build_history_annotation_record,
    history_annotation_record_path,
    history_annotation_row_fingerprint,
    load_history_annotations,
    resolve_history_annotations,
    reuse_annotation_revision,
    same_annotation_revision,
    save_history_annotation,
    sync_history_annotation,
)
from domains.local_setup import unpack_simpress_zip
from domains.ticket_reconciliation import TicketWorkbookError, reconcile_ticket_workbooks
from domains.ticket_reporting import (
    MAX_TICKET_SNAPSHOTS,
    TICKET_SNAPSHOT_FIELDS,
    TICKET_TIMELINE_ANNOTATION_CATEGORY,
    TicketTimelineIndex,
    build_ticket_timeline,
    build_ticket_timeline_index,
    normalize_ticket_snapshot,
    ticket_report_snapshots,
    ticket_snapshot_metadata,
)


MAX_TICKET_WORKBOOK_BYTES = 60 * 1024 * 1024
TICKET_TIMELINE_ANNOTATION_REASON = "Linha do tempo do acompanhamento de chamados"
logger = logging.getLogger(__name__)


class TicketImportError(DomainError):
    """An import rejected with the status code the API has always answered."""


@dataclass(frozen=True)
class TicketImportServices:
    """Paths and collaborators of the ticket import; defaults are the real ones."""

    ticket_report_path: Callable[[], Path]
    transaction_root: Callable[[], Path]
    annotation_directory: Callable[[], Path]
    annotation_outbox_directory: Callable[[], Path]
    load_annotation_records: Callable[..., List[Dict[str, Any]]] = load_history_annotations
    reconcile_workbooks: Callable[..., Dict[str, Any]] = reconcile_ticket_workbooks
    transaction_factory: Callable[[Path, List[Path]], AtomicFileTransaction] = AtomicFileTransaction
    publish_annotation: Callable[..., bool] = sync_history_annotation
    now: Callable[[], datetime] = datetime.now


def latest_ticket_annotations(
    services: TicketImportServices, strict: bool = False,
) -> Dict[Tuple[str, str], Dict[str, Any]]:
    def read(directory: Path) -> List[Dict[str, Any]]:
        reader = services.load_annotation_records
        return reader(directory, strict=True) if strict else reader(directory)

    return resolve_history_annotations(
        record
        for directory in (services.annotation_directory(), services.annotation_outbox_directory())
        for record in read(directory)
        if record.get("categoria") == TICKET_TIMELINE_ANNOTATION_CATEGORY
    )


def ticket_annotation_event(
    snapshot: Dict[str, Any], serial: str, index: Optional[TicketTimelineIndex] = None,
) -> Optional[Dict[str, Any]]:
    timeline_index = index if index is not None else build_ticket_timeline_index([snapshot])
    return timeline_index.event_for_snapshot(snapshot, serial)


def ticket_annotation_row_hash(event: Dict[str, Any]) -> str:
    row = {"serie": event.get("serie", ""), **(event.get("estado") or {})}
    return history_annotation_row_fingerprint(TICKET_TIMELINE_ANNOTATION_CATEGORY, row)


def prepare_ticket_timeline_annotations(
    services: TicketImportServices,
    previous_snapshots: Sequence[Dict[str, Any]],
    current_snapshot: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Prepare independent revisions from the predecessors read under the import lock."""
    # An unreadable revision must abort (409) rather than skip an existing note.
    stored = latest_ticket_annotations(services, strict=True)
    all_records = list(stored.values())
    records = []
    timeline_index = build_ticket_timeline_index([*previous_snapshots, current_snapshot])
    series = sorted({
        str(ticket.get("serie") or "").strip()
        for ticket in current_snapshot.get("chamados", [])
        if isinstance(ticket, dict) and str(ticket.get("serie") or "").strip()
    })
    for serial in series:
        current_event = ticket_annotation_event(current_snapshot, serial, timeline_index)
        if current_event is None:
            continue
        row_hash = ticket_annotation_row_hash(current_event)
        previous_match: Optional[Dict[str, Any]] = None
        for prior_snapshot in previous_snapshots:
            prior_event = ticket_annotation_event(prior_snapshot, serial, timeline_index)
            if prior_event and ticket_annotation_row_hash(prior_event) == row_hash:
                previous_match = prior_event

        if previous_match is not None:
            prior_record = stored.get((previous_match["snapshot_id"], previous_match["item_id"]))
            # A more recent local row without a note blocks reuse of an older note.
            annotation = str(prior_record.get("anotacao") or "") if prior_record else ""
        else:
            matching = [
                record for record in all_records
                if record.get("categoria") == TICKET_TIMELINE_ANNOTATION_CATEGORY
                and record.get("linha_hash") == row_hash
                and str(record.get("evento_id") or "") != current_event["snapshot_id"]
                and str(record.get("horario") or "") < str(current_event.get("atualizado_em") or "")
            ]
            if matching:
                latest_time = max(str(record.get("horario") or "") for record in matching)
                latest = [record for record in matching if str(record.get("horario") or "") == latest_time]
                unique_notes = {str(record.get("anotacao") or "") for record in latest}
                annotation = next(iter(unique_notes)) if len(unique_notes) == 1 else ""
            else:
                annotation = ""

        records.append(build_history_annotation_record(
            event_id=current_event["snapshot_id"], event_time=current_event.get("atualizado_em", ""),
            item_id=current_event["item_id"], serie=serial, computador="",
            motivo=TICKET_TIMELINE_ANNOTATION_REASON, anotacao=annotation,
            categoria=TICKET_TIMELINE_ANNOTATION_CATEGORY, linha_hash=row_hash,
        ))
    return records


def sync_ticket_annotation(services: TicketImportServices, record: Dict[str, Any]) -> bool:
    try:
        return services.publish_annotation(
            record, directory=services.annotation_directory(), outbox=services.annotation_outbox_directory(),
            transaction_root=services.transaction_root(), transaction_factory=services.transaction_factory,
            publisher=save_history_annotation,
        )
    except Exception:
        logger.exception("Anotação do chamado %s salva e aguardando sincronização.", redact_reference(record.get("serie")))
        return False


def ticket_timeline_with_annotations(
    services: TicketImportServices, snapshots: Sequence[Dict[str, Any]], serial: str,
    records: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None,
    index: Optional[TicketTimelineIndex] = None,
) -> List[Dict[str, Any]]:
    records = records if records is not None else latest_ticket_annotations(services)
    events = build_ticket_timeline(snapshots, serial, index=index)
    for event in events:
        event["anotacao_id"] = event["item_id"]
        record = records.get((event["snapshot_id"], event["item_id"]))
        event.update(annotation_view(record) if record else {"anotacao": "", "anotacao_revisoes": []})
    return events


def persist_ticket_annotation(
    services: TicketImportServices, *, transaction_root: Path,
    transaction_factory: Callable[[Path, Sequence[Path]], Any],
    event_id: str, item_id: str, serial: str, event_time: str, row_hash: str, annotation: str,
    revision_id: Optional[str] = None, base_revisions: Optional[List[str]] = None,
) -> bool:
    """Queue the annotation in the outbox (one transaction) and try to publish it; ``True`` when it was published.

    Raises ``DomainValidationError`` (422), ``DomainConflictError`` (409) or ``DomainBusyError`` (503)."""
    try:
        record = build_history_annotation_record(
            event_id=event_id,
            event_time=event_time,
            item_id=item_id,
            serie=serial,
            computador="",
            motivo=TICKET_TIMELINE_ANNOTATION_REASON,
            anotacao=annotation,
            categoria=TICKET_TIMELINE_ANNOTATION_CATEGORY,
            linha_hash=row_hash,
            revision_id=revision_id, base_revisions=base_revisions,
        )
    except ValueError as error:
        raise DomainValidationError(str(error), status_code=422) from None
    pending_path = history_annotation_record_path(
        services.annotation_outbox_directory(), event_id, item_id, record["revisao_id"],
    )
    try:
        with transaction_factory(transaction_root, [pending_path]) as transaction:
            try:
                record = reuse_annotation_revision(services.annotation_directory(), record)
            except ValueError as error:
                raise DomainConflictError(str(error)) from None
            if pending_path.exists():
                existing = json.loads(pending_path.read_text(encoding="utf-8"))
                if not same_annotation_revision(existing, record):
                    raise DomainConflictError("A revisão já foi usada com outro conteúdo.")
                record = existing
            transaction.stage_bytes(
                pending_path,
                json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8"),
                lambda path: json.loads(path.read_text(encoding="utf-8")),
            )
            transaction.commit()
    except (OSError, FileBusyError, FileTransactionError):
        logger.exception("Não foi possível enfileirar a anotação do chamado %s.", redact_reference(serial))
        raise DomainBusyError("Não foi possível salvar a anotação localmente.") from None

    return sync_ticket_annotation(services, record)


def ticket_export_selection(
    services: TicketImportServices, snapshots: Sequence[Dict[str, Any]], snapshot_id: str,
    select_tickets: Callable[[Sequence[Dict[str, Any]]], List[Dict[str, Any]]],
) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
    """``(snapshot, tickets, timelines)`` of the export; the snapshot defaults to the latest, and a missing one is a 404."""
    selected_id = snapshot_id or (snapshots[-1].get("id", "") if snapshots else "")
    snapshot = next((item for item in snapshots if item.get("id") == selected_id), None)
    if snapshot is None:
        raise DomainError("A versão selecionada não existe no histórico de chamados.", status_code=404)
    tickets = select_tickets(snapshot.get("chamados", []))
    selected_index = next((index for index, item in enumerate(snapshots) if item.get("id") == selected_id), len(snapshots) - 1)
    timeline_snapshots = snapshots[:selected_index + 1]
    annotation_records = latest_ticket_annotations(services)
    timeline_index = build_ticket_timeline_index(timeline_snapshots)
    timelines = {
        str(ticket.get("serie") or ""): ticket_timeline_with_annotations(
            services, timeline_snapshots, str(ticket.get("serie") or ""), annotation_records, timeline_index
        )
        for ticket in tickets
    }
    return snapshot, tickets, timelines


@dataclass(frozen=True)
class TicketWorkbookSource:
    """One uploaded or inbox workbook; ``read(limit)`` returns at most ``limit`` bytes."""

    filename: Optional[str]
    read: Callable[[int], bytes]

    @classmethod
    def from_bytes(cls, filename: Optional[str], content: bytes) -> "TicketWorkbookSource":
        return cls(filename, io.BytesIO(content).read)


def read_ticket_source(
    source: TicketWorkbookSource, source_label: str, *, allow_zip: bool = False,
) -> Tuple[bytes, str]:
    """Validate the name before reading, then read one byte past the limit to detect oversize."""
    filename = (source.filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    is_zip = allow_zip and filename.lower().endswith(".zip")
    if not filename.lower().endswith(".xlsx") and not is_zip:
        accepted = ".xlsx ou .zip com uma planilha .xlsx" if allow_zip else ".xlsx"
        raise TicketImportError(f"Selecione um arquivo {accepted} para a fonte {source_label}.", status_code=400)
    content = source.read(MAX_TICKET_WORKBOOK_BYTES + 1)
    if len(content) > MAX_TICKET_WORKBOOK_BYTES:
        raise TicketImportError(
            f"O arquivo {source_label} excede o limite de {format_size_limit(MAX_TICKET_WORKBOOK_BYTES)}.",
            status_code=413,
        )
    if not content:
        raise TicketImportError(f"O arquivo da fonte {source_label} está vazio.", status_code=400)
    if is_zip:
        content, _ = unpack_simpress_zip(content, MAX_TICKET_WORKBOOK_BYTES)
    return content, filename[:200]


def import_ticket_workbooks(
    services: TicketImportServices,
    simpress: TicketWorkbookSource,
    oracle: TicketWorkbookSource,
    automatic_import_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Append one reconciled snapshot and return the report as the API displays it."""
    simpress_bytes, simpress_filename = read_ticket_source(simpress, "Simpress", allow_zip=True)
    oracle_bytes, oracle_filename = read_ticket_source(oracle, "Oracle")
    try:
        parsed_report = services.reconcile_workbooks(
            simpress_bytes,
            oracle_bytes,
            simpress_filename=simpress_filename,
            oracle_filename=oracle_filename,
        )
    except XlsxLimitExceeded as error:
        raise TicketImportError(str(error), status_code=413) from None
    except XlsxPackageError:
        raise TicketImportError("Um dos arquivos não é um XLSX válido.", status_code=400) from None
    except TicketWorkbookError as error:
        raise TicketImportError(str(error), status_code=422) from None

    path = services.ticket_report_path()
    annotation_records: List[Dict[str, Any]] = []
    pending_annotations: List[Tuple[Path, Dict[str, Any]]] = []

    def append_import(current: Any) -> Dict[str, Any]:
        nonlocal annotation_records
        if not isinstance(current, dict) or not isinstance(current.get("chamados"), list):
            raise TicketImportError("O acompanhamento de chamados está inválido.", status_code=503)
        receipts = current.get("importacoes_automaticas", [])
        automatic_imports = list(receipts) if isinstance(receipts, list) else []
        if automatic_import_id and any(
            isinstance(item, dict) and item.get("lote_id") == automatic_import_id
            for item in automatic_imports
        ):
            raise TicketImportError("Este lote já consta no histórico de chamados.", status_code=409)

        updated = dict(parsed_report)
        updated["atualizado_em"] = services.now().astimezone().isoformat(timespec="seconds")
        snapshot = {"id": str(uuid4()), **{field: updated.get(field) for field in TICKET_SNAPSHOT_FIELDS}}
        history = ticket_report_snapshots(current)
        annotation_records = prepare_ticket_timeline_annotations(
            services, [normalize_ticket_snapshot(item) for item in history], normalize_ticket_snapshot(snapshot),
        )
        # Discover every outbox target before staging. Revisions and the report commit together,
        # so a following import can inherit notes even while shared publication is still pending.
        for record in annotation_records:
            pending_path = history_annotation_record_path(
                services.annotation_outbox_directory(), record["evento_id"], record["item_id"], record["revisao_id"],
            )
            transaction.add_target(pending_path)
            pending_annotations.append((pending_path, record))

        # The lock serializes commits: list position, never a wall clock, defines version order.
        updated["snapshot_id"] = snapshot["id"]
        updated["historico"] = (history + [snapshot])[-MAX_TICKET_SNAPSHOTS:]
        if automatic_import_id:
            automatic_imports.append({
                "lote_id": automatic_import_id, "snapshot_id": snapshot["id"],
                "atualizado_em": snapshot["atualizado_em"],
            })
        updated["importacoes_automaticas"] = automatic_imports
        return updated

    try:
        with services.transaction_factory(services.transaction_root(), [path]) as transaction:
            report = transaction.update_json(path, append_import, {"chamados": [], "historico": []})
            for pending_path, record in pending_annotations:
                transaction.stage_bytes(
                    pending_path, json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8"),
                    lambda staged: json.loads(staged.read_text(encoding="utf-8")),
                )
            transaction.commit()
    except AnnotationReadError as error:
        raise TicketImportError(str(error), status_code=409) from None
    except FileBusyError:
        raise TicketImportError("O acompanhamento está sendo atualizado por outra operação local.", status_code=409) from None
    except (OSError, FileTransactionError) as error:
        if isinstance(error.__cause__, (OSError, UnicodeError, json.JSONDecodeError)):
            raise TicketImportError("O acompanhamento de chamados não pôde ser lido.", status_code=503) from None
        raise TicketImportError("Não foi possível salvar o acompanhamento de chamados.", status_code=500) from None

    for record in annotation_records:
        sync_ticket_annotation(services, record)
    displayed_report = normalize_ticket_snapshot(report)
    response = {key: value for key, value in displayed_report.items() if key not in {"historico", "importacoes_automaticas"}}
    response["historico"] = [
        ticket_snapshot_metadata(normalize_ticket_snapshot(item))
        for item in reversed(ticket_report_snapshots(report))
    ]
    return response
