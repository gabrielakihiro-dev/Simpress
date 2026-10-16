"""Operational views over saved comparison history and service tickets."""

import json
from datetime import datetime
import logging
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.config import format_size_limit
from core.logging_setup import redact_reference
from domains.history_insights import compare_updates, is_restoration, latest_update, pending_rows
from domains.history_annotations import (
    MAX_ANNOTATION_LENGTH,
    AnnotationReadError,
    reuse_annotation_revision,
    annotation_view,
    resolve_history_annotations,
    same_annotation_revision,
    sync_history_annotation,
    build_history_annotation_record,
    history_annotation_record_path,
    history_annotation_row_fingerprint,
    load_history_annotations,
    save_history_annotation,
)
from domains.ticket_reconciliation import TicketWorkbookError, reconcile_ticket_workbooks
from domains.local_setup import unpack_simpress_zip
from domains.ticket_reporting import (
    MAX_TICKET_SNAPSHOTS,
    TICKET_TIMELINE_ANNOTATION_CATEGORY,
    TICKET_SNAPSHOT_FIELDS,
    TicketTimelineIndex,
    build_ticket_timeline,
    build_ticket_timeline_index,
    build_ticket_workbook,
    compare_ticket_snapshots,
    filter_ticket_records,
    normalize_ticket_snapshot,
    ticket_report_snapshots,
    ticket_snapshot_metadata,
)
from core.integrity import AtomicFileTransaction, FileBusyError, FileTransactionError
from core.xlsx_safety import XlsxLimitExceeded, XlsxPackageError


MAX_TICKET_WORKBOOK_BYTES = 64 * 1024 * 1024
logger = logging.getLogger(__name__)


class TicketTimelineAnnotationPayload(BaseModel):
    anotacao: str = Field(..., max_length=MAX_ANNOTATION_LENGTH)
    revisao_id: Optional[str] = Field(None, pattern=r"^[a-f0-9]{32}$")
    base_revisoes: List[str] = Field(default_factory=list, max_length=100)
    resolver_conflito: bool = False


def create_operations_router(
    *,
    load_comparison_history: Callable[[], List[Dict[str, Any]]],
    comparison_history_for_display: Callable[[Dict[str, Any]], Dict[str, Any]],
    ticket_report_path: Callable[[], Path],
    transaction_root: Callable[[], Path],
    history_annotations_directory: Optional[Callable[[], Path]] = None,
    local_annotation_outbox_directory: Optional[Callable[[], Path]] = None,
    history_annotations_sync_enabled: Optional[Callable[[], bool]] = None,
    load_history_annotation_records: Optional[Callable[..., List[Dict[str, Any]]]] = None,
):
    router = APIRouter()

    @router.get("/api/operacoes/pendencias")
    def get_operational_pending_items():
        event = latest_update(load_comparison_history())
        if event is None:
            return {"evento": None, "pendencias": []}
        view = comparison_history_for_display(event)
        return {
            "evento": {"id": event.get("id"), "horario": event.get("horario")},
            "pendencias": pending_rows(view),
        }

    @router.get("/api/operacoes/evolucao")
    def get_update_evolution(anterior: str, atual: str):
        history = [event for event in load_comparison_history() if isinstance(event, dict)]
        previous = next((event for event in history if str(event.get("id") or "") == anterior), None)
        current = next((event for event in history if str(event.get("id") or "") == atual), None)
        if previous is None or current is None:
            raise HTTPException(status_code=404, detail="Uma das atualizações selecionadas não existe no histórico.")
        if previous is current:
            raise HTTPException(status_code=422, detail="Selecione duas atualizações diferentes.")
        if is_restoration(previous) or is_restoration(current):
            raise HTTPException(status_code=422, detail="Selecione duas atualizações de inventário, sem restaurações.")
        return compare_updates(
            comparison_history_for_display(previous),
            comparison_history_for_display(current),
        )

    def load_ticket_report() -> Dict[str, Any]:
        path = ticket_report_path()
        if not path.exists():
            return {
                "atualizado_em": None,
                "fontes": {},
                "resumo": {
                    "series_total": 0, "conferidas": 0, "divergentes": 0,
                    "sem_os": 0, "somente_simpress": 0, "somente_oracle": 0,
                },
                "chamados": [],
                "historico": [],
            }
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise HTTPException(status_code=503, detail="O acompanhamento de chamados não pôde ser lido.") from None
        if not isinstance(data, dict) or not isinstance(data.get("chamados"), list):
            raise HTTPException(status_code=503, detail="O acompanhamento de chamados está inválido.")
        return data

    def displayed_ticket_snapshots(report: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [normalize_ticket_snapshot(item) for item in ticket_report_snapshots(report)]

    def annotation_directory() -> Path:
        return history_annotations_directory() if history_annotations_directory else ticket_report_path().parent / "anotacoes_historico"

    def annotation_outbox_directory() -> Path:
        return local_annotation_outbox_directory() if local_annotation_outbox_directory else ticket_report_path().parent / "anotacoes_historico_pendentes"

    def read_annotation_directory(directory: Path, strict: bool = False) -> List[Dict[str, Any]]:
        reader = load_history_annotation_records or load_history_annotations
        return reader(directory, strict=True) if strict else reader(directory)

    def latest_ticket_annotations(strict: bool = False) -> Dict[tuple[str, str], Dict[str, Any]]:
        return resolve_history_annotations(
            record
            for directory in (annotation_directory(), annotation_outbox_directory())
            for record in read_annotation_directory(directory, strict)
            if record.get("categoria") == TICKET_TIMELINE_ANNOTATION_CATEGORY
        )

    def _ticket_annotation_event(
        snapshot: Dict[str, Any], serial: str, index: Optional[TicketTimelineIndex] = None,
    ) -> Optional[Dict[str, Any]]:
        timeline_index = index if index is not None else build_ticket_timeline_index([snapshot])
        return timeline_index.event_for_snapshot(snapshot, serial)

    def _ticket_annotation_row_hash(event: Dict[str, Any]) -> str:
        row = {"serie": event.get("serie", ""), **(event.get("estado") or {})}
        return history_annotation_row_fingerprint(TICKET_TIMELINE_ANNOTATION_CATEGORY, row)

    def _ticket_timeline_with_annotations(
        snapshots: Sequence[Dict[str, Any]], serial: str,
        records: Optional[Dict[tuple[str, str], Dict[str, Any]]] = None,
        index: Optional[TicketTimelineIndex] = None,
    ) -> List[Dict[str, Any]]:
        records = records if records is not None else latest_ticket_annotations()
        events = build_ticket_timeline(snapshots, serial, index=index)
        for event in events:
            event["anotacao_id"] = event["item_id"]
            record = records.get((event["snapshot_id"], event["item_id"]))
            event.update(annotation_view(record) if record else {"anotacao": "", "anotacao_revisoes": []})
        return events

    def prepare_ticket_timeline_annotations(
        previous_snapshots: Sequence[Dict[str, Any]], current_snapshot: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """Prepare independent revisions from the predecessors read under the import lock."""
        # An unreadable revision must abort (409) rather than skip an existing note.
        stored = latest_ticket_annotations(strict=True)
        all_records = list(stored.values())
        records = []
        timeline_index = build_ticket_timeline_index([*previous_snapshots, current_snapshot])
        series = sorted({
            str(ticket.get("serie") or "").strip()
            for ticket in current_snapshot.get("chamados", [])
            if isinstance(ticket, dict) and str(ticket.get("serie") or "").strip()
        })
        for serial in series:
            current_event = _ticket_annotation_event(current_snapshot, serial, timeline_index)
            if current_event is None:
                continue
            row_hash = _ticket_annotation_row_hash(current_event)
            previous_match: Optional[Dict[str, Any]] = None
            for prior_snapshot in previous_snapshots:
                prior_event = _ticket_annotation_event(prior_snapshot, serial, timeline_index)
                if prior_event and _ticket_annotation_row_hash(prior_event) == row_hash:
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
                motivo="Linha do tempo do acompanhamento de chamados", anotacao=annotation,
                categoria=TICKET_TIMELINE_ANNOTATION_CATEGORY, linha_hash=row_hash,
            ))
        return records

    def sync_ticket_annotation(record: Dict[str, Any]) -> bool:
        try:
            return sync_history_annotation(
                record, directory=annotation_directory(), outbox=annotation_outbox_directory(),
                transaction_root=transaction_root(), transaction_factory=AtomicFileTransaction,
                publisher=save_history_annotation,
            )
        except Exception:
            logger.exception("Anotação do chamado %s salva e aguardando sincronização.", redact_reference(record.get("serie")))
            return False

    def _persist_ticket_annotation(
        *, event_id: str, item_id: str, serial: str, event_time: str, row_hash: str, annotation: str,
        revision_id: Optional[str] = None, base_revisions: Optional[List[str]] = None,
    ) -> bool:
        values = {
            "event_id": event_id,
            "event_time": event_time,
            "item_id": item_id,
            "serie": serial,
            "computador": "",
            "motivo": "Linha do tempo do acompanhamento de chamados",
            "anotacao": annotation,
            "categoria": TICKET_TIMELINE_ANNOTATION_CATEGORY,
            "linha_hash": row_hash,
        }
        try:
            record = build_history_annotation_record(
                **values, revision_id=revision_id, base_revisions=base_revisions,
            )
        except ValueError as error:
            raise HTTPException(422, detail=str(error)) from None
        pending_path = history_annotation_record_path(annotation_outbox_directory(), event_id, item_id, record["revisao_id"])
        try:
            with AtomicFileTransaction(transaction_root(), [pending_path]) as transaction:
                try:
                    record = reuse_annotation_revision(annotation_directory(), record)
                except ValueError as error:
                    raise HTTPException(409, detail=str(error)) from None
                if pending_path.exists():
                    existing = json.loads(pending_path.read_text(encoding="utf-8"))
                    if not same_annotation_revision(existing, record):
                        raise HTTPException(409, detail="A revisão já foi usada com outro conteúdo.")
                    record = existing
                transaction.stage_bytes(
                    pending_path,
                    json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8"),
                    lambda path: json.loads(path.read_text(encoding="utf-8")),
                )
                transaction.commit()
        except (OSError, FileBusyError, FileTransactionError):
            logger.exception("Não foi possível enfileirar a anotação do chamado %s.", redact_reference(serial))
            raise HTTPException(status_code=503, detail="Não foi possível salvar a anotação localmente.") from None

        return sync_ticket_annotation(record)

    @router.get("/api/operacoes/chamados")
    def get_ticket_report():
        report = load_ticket_report()
        snapshots = displayed_ticket_snapshots(report)
        current = next((item for item in reversed(snapshots) if item), None)
        response = {key: value for key, value in report.items() if key not in {"historico", "importacoes_automaticas"}}
        response = normalize_ticket_snapshot(response)
        response["snapshot_id"] = current.get("id", "") if current else ""
        response["historico"] = [
            ticket_snapshot_metadata(item)
            for item in reversed(snapshots)
        ]
        return response

    @router.get("/api/operacoes/chamados/historico")
    def get_ticket_history():
        snapshots = displayed_ticket_snapshots(load_ticket_report())
        return {"eventos": [ticket_snapshot_metadata(item) for item in reversed(snapshots)], "total": len(snapshots)}

    @router.delete("/api/operacoes/chamados/historico/antigas")
    def delete_old_ticket_imports():
        path = ticket_report_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with AtomicFileTransaction(transaction_root(), [path]) as transaction:
                report = load_ticket_report()
                snapshots = ticket_report_snapshots(report)
                if len(snapshots) <= 1:
                    latest = snapshots[-1] if snapshots else None
                    return {
                        "removidas": 0,
                        "mantida": ticket_snapshot_metadata(latest) if latest else None,
                        "total": len(snapshots),
                    }

                latest = snapshots[-1]
                cleaned_report = dict(report)
                cleaned_report.update({field: latest.get(field) for field in TICKET_SNAPSHOT_FIELDS})
                cleaned_report["snapshot_id"] = latest["id"]
                cleaned_report["historico"] = [latest]
                transaction.update_json(path, lambda _current: cleaned_report, {})
                transaction.commit()
        except FileBusyError:
            raise HTTPException(status_code=409, detail="O acompanhamento está sendo atualizado por outra operação local.") from None
        except (OSError, FileTransactionError):
            raise HTTPException(status_code=500, detail="Não foi possível remover as importações antigas do acompanhamento.") from None

        return {
            "removidas": len(snapshots) - 1,
            "mantida": ticket_snapshot_metadata(latest),
            "total": 1,
        }

    @router.get("/api/operacoes/chamados/snapshot/{snapshot_id}")
    def get_ticket_snapshot(snapshot_id: str):
        snapshot = next(
            (item for item in displayed_ticket_snapshots(load_ticket_report()) if item.get("id") == snapshot_id),
            None,
        )
        if snapshot is None:
            raise HTTPException(status_code=404, detail="A versão selecionada não existe no histórico de chamados.")
        return snapshot

    @router.get("/api/operacoes/chamados/evolucao")
    def get_ticket_evolution(anterior: str, atual: str):
        snapshots = displayed_ticket_snapshots(load_ticket_report())
        previous = next((item for item in snapshots if item.get("id") == anterior), None)
        current = next((item for item in snapshots if item.get("id") == atual), None)
        if previous is None or current is None:
            raise HTTPException(status_code=404, detail="Uma das versões selecionadas não existe no histórico de chamados.")
        if anterior == atual:
            raise HTTPException(status_code=422, detail="Selecione duas versões diferentes para comparar.")
        return compare_ticket_snapshots(previous, current)

    @router.get("/api/operacoes/chamados/linha-do-tempo/{serial}")
    def get_ticket_timeline(serial: str, snapshot_id: str = ""):
        snapshots = displayed_ticket_snapshots(load_ticket_report())
        if snapshot_id:
            selected_index = next((index for index, item in enumerate(snapshots) if item.get("id") == snapshot_id), None)
            if selected_index is None:
                raise HTTPException(status_code=404, detail="A versão selecionada não existe no histórico de chamados.")
            snapshots = snapshots[:selected_index + 1]
        events = _ticket_timeline_with_annotations(snapshots, serial)
        if not events:
            raise HTTPException(status_code=404, detail="Não há histórico para esta série.")
        return {"serie": events[-1]["serie"], "eventos": events, "total": len(events)}

    @router.put("/api/operacoes/chamados/linha-do-tempo/{event_id}/{item_id}")
    def save_ticket_timeline_annotation(event_id: str, item_id: str, payload: TicketTimelineAnnotationPayload):
        snapshots = displayed_ticket_snapshots(load_ticket_report())
        snapshot = next((item for item in snapshots if item.get("id") == event_id), None)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="A importação desta linha do tempo não existe mais.")
        timeline_index = build_ticket_timeline_index([snapshot])
        event = timeline_index.events_by_item_id.get(item_id)
        if event is None:
            raise HTTPException(status_code=404, detail="A linha do tempo selecionada não existe nesta importação.")
        if len(payload.base_revisoes) > 1 and not payload.resolver_conflito:
            raise HTTPException(409, detail="Confirme explicitamente a resolução do conflito.")
        synced = _persist_ticket_annotation(
            event_id=event_id,
            item_id=item_id,
            serial=str(event.get("serie") or ""),
            event_time=str(event.get("atualizado_em") or ""),
            row_hash=_ticket_annotation_row_hash(event),
            annotation=payload.anotacao,
            revision_id=payload.revisao_id, base_revisions=payload.base_revisoes,
        )
        sync_enabled = bool(history_annotations_sync_enabled and history_annotations_sync_enabled())
        return {
            "sucesso": True,
            **annotation_view(latest_ticket_annotations()[(event_id, item_id)]),
            "sincronizacao": "sincronizada" if sync_enabled and synced else "pendente" if sync_enabled else "local",
        }

    @router.get("/api/operacoes/chamados/exportar")
    def export_ticket_report(
        snapshot_id: str = "",
        relation: str = "",
        status: str = "",
        queue: str = "",
        city: str = "",
        provider: str = "",
        search: str = "",
        stale_days: int = 3,
        age_filter: str = "",
        attention_only: bool = False,
    ):
        report = load_ticket_report()
        snapshots = displayed_ticket_snapshots(report)
        selected_id = snapshot_id or (snapshots[-1].get("id", "") if snapshots else "")
        snapshot = next((item for item in snapshots if item.get("id") == selected_id), None)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="A versão selecionada não existe no histórico de chamados.")
        filters = {
            "relation": relation, "status": status, "queue": queue, "city": city,
            "provider": provider, "search": search, "stale_days": 3,
            "age_filter": age_filter, "attention_only": attention_only,
        }
        tickets = filter_ticket_records(
            snapshot.get("chamados", []),
            relation=relation,
            status=status,
            queue=queue,
            city=city,
            provider=provider,
            search=search,
            stale_days=3,
            age_filter=age_filter,
            attention_only=attention_only,
        )
        selected_index = next((index for index, item in enumerate(snapshots) if item.get("id") == selected_id), len(snapshots) - 1)
        timeline_snapshots = snapshots[:selected_index + 1]
        annotation_records = latest_ticket_annotations()
        timeline_index = build_ticket_timeline_index(timeline_snapshots)
        timelines = {
            str(ticket.get("serie") or ""): _ticket_timeline_with_annotations(
                timeline_snapshots, str(ticket.get("serie") or ""), annotation_records, timeline_index
            )
            for ticket in tickets
        }
        output = build_ticket_workbook(snapshot, tickets, filters, timelines=timelines)
        date_label = str(snapshot.get("atualizado_em") or datetime.now().astimezone().isoformat())[:10].replace("-", "")
        return StreamingResponse(
            BytesIO(output),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="Acompanhamento_de_Chamados_{date_label}.xlsx"'},
        )

    @router.post("/api/operacoes/chamados/importar")
    def import_ticket_workbooks(
        simpress_file: UploadFile = File(...),
        oracle_file: UploadFile = File(...),
        automatic_import_id: Optional[str] = None,
    ):
        def read_source(upload: UploadFile, source_label: str, *, allow_zip: bool = False):
            raw_name = upload.filename or ""
            filename = raw_name.replace("\\", "/").rsplit("/", 1)[-1].strip()
            is_zip = allow_zip and filename.lower().endswith(".zip")
            if not filename.lower().endswith(".xlsx") and not is_zip:
                accepted = ".xlsx ou .zip com uma planilha .xlsx" if allow_zip else ".xlsx"
                raise HTTPException(status_code=400, detail=f"Selecione um arquivo {accepted} para a fonte {source_label}.")
            content = upload.file.read(MAX_TICKET_WORKBOOK_BYTES + 1)
            if len(content) > MAX_TICKET_WORKBOOK_BYTES:
                raise HTTPException(status_code=413, detail=f"O arquivo {source_label} excede o limite de {format_size_limit(MAX_TICKET_WORKBOOK_BYTES)}.")
            if not content:
                raise HTTPException(status_code=400, detail=f"O arquivo da fonte {source_label} está vazio.")
            if is_zip:
                content, _ = unpack_simpress_zip(content, MAX_TICKET_WORKBOOK_BYTES)
            return content, filename[:200]

        simpress_bytes, simpress_filename = read_source(simpress_file, "Simpress", allow_zip=True)
        oracle_bytes, oracle_filename = read_source(oracle_file, "Oracle")
        try:
            parsed_report = reconcile_ticket_workbooks(
                simpress_bytes,
                oracle_bytes,
                simpress_filename=simpress_filename,
                oracle_filename=oracle_filename,
            )
        except XlsxLimitExceeded as error:
            raise HTTPException(status_code=413, detail=str(error)) from None
        except XlsxPackageError:
            raise HTTPException(status_code=400, detail="Um dos arquivos não é um XLSX válido.") from None
        except TicketWorkbookError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None

        path = ticket_report_path()
        annotation_records: List[Dict[str, Any]] = []
        pending_annotations: List[tuple[Path, Dict[str, Any]]] = []

        def append_import(current: Any) -> Dict[str, Any]:
            nonlocal annotation_records
            if not isinstance(current, dict) or not isinstance(current.get("chamados"), list):
                raise HTTPException(status_code=503, detail="O acompanhamento de chamados está inválido.")
            receipts = current.get("importacoes_automaticas", [])
            automatic_imports = list(receipts) if isinstance(receipts, list) else []
            if automatic_import_id and any(
                isinstance(item, dict) and item.get("lote_id") == automatic_import_id
                for item in automatic_imports
            ):
                raise HTTPException(status_code=409, detail="Este lote já consta no histórico de chamados.")

            updated = dict(parsed_report)
            updated["atualizado_em"] = datetime.now().astimezone().isoformat(timespec="seconds")
            snapshot = {"id": str(uuid4()), **{field: updated.get(field) for field in TICKET_SNAPSHOT_FIELDS}}
            history = ticket_report_snapshots(current)
            annotation_records = prepare_ticket_timeline_annotations(
                [normalize_ticket_snapshot(item) for item in history], normalize_ticket_snapshot(snapshot),
            )
            # Discover every outbox target before staging. Revisions and the report commit together,
            # so a following import can inherit notes even while shared publication is still pending.
            for record in annotation_records:
                pending_path = history_annotation_record_path(
                    annotation_outbox_directory(), record["evento_id"], record["item_id"], record["revisao_id"],
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
            with AtomicFileTransaction(transaction_root(), [path]) as transaction:
                report = transaction.update_json(path, append_import, {"chamados": [], "historico": []})
                for pending_path, record in pending_annotations:
                    transaction.stage_bytes(
                        pending_path, json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8"),
                        lambda staged: json.loads(staged.read_text(encoding="utf-8")),
                    )
                transaction.commit()
        except AnnotationReadError as error:
            raise HTTPException(status_code=409, detail=str(error)) from None
        except FileBusyError:
            raise HTTPException(status_code=409, detail="O acompanhamento está sendo atualizado por outra operação local.") from None
        except (OSError, FileTransactionError) as error:
            if isinstance(error.__cause__, (OSError, UnicodeError, json.JSONDecodeError)):
                raise HTTPException(status_code=503, detail="O acompanhamento de chamados não pôde ser lido.") from None
            raise HTTPException(status_code=500, detail="Não foi possível salvar o acompanhamento de chamados.") from None

        for record in annotation_records:
            sync_ticket_annotation(record)
        displayed_report = normalize_ticket_snapshot(report)
        response = {key: value for key, value in displayed_report.items() if key not in {"historico", "importacoes_automaticas"}}
        response["historico"] = [
            ticket_snapshot_metadata(item)
            for item in reversed(displayed_ticket_snapshots(report))
        ]
        return response

    return router
