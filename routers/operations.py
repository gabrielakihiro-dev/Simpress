"""Operational views over saved comparison history and service tickets."""

import json
import re
from datetime import datetime
import logging
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, Optional, Sequence

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from core.logging_setup import redact_reference
from domains import ticket_import
from domains.history_insights import compare_updates, is_restoration, latest_update, pending_rows
from domains.history_annotations import (
    MAX_ANNOTATION_LENGTH,
    reuse_annotation_revision,
    annotation_view,
    same_annotation_revision,
    sync_history_annotation,
    build_history_annotation_record,
    history_annotation_record_path,
    load_history_annotations,
)
from domains.ticket_import import (
    MAX_TICKET_WORKBOOK_BYTES,  # Re-exported: the upload limit is part of this route's contract.
    TICKET_TIMELINE_ANNOTATION_REASON,
    TicketImportError,
    TicketImportServices,
    TicketWorkbookSource,
    ticket_annotation_row_hash,
)
from domains.inventory_comparison import normalize_reference_value
from domains.ticket_reconciliation import reconcile_ticket_workbooks
from domains.ticket_reporting import (
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


logger = logging.getLogger(__name__)


class TicketTimelineAnnotationPayload(BaseModel):
    anotacao: str = Field(..., max_length=MAX_ANNOTATION_LENGTH)
    revisao_id: Optional[str] = Field(None, pattern=r"^[a-f0-9]{32}$")
    base_revisoes: List[str] = Field(default_factory=list, max_length=100)
    resolver_conflito: bool = False


class TicketOsLinkPayload(BaseModel):
    fonte: Literal["simpress", "oracle"]
    serie: str = Field(..., min_length=1, max_length=128)
    os: str = Field(..., min_length=1, max_length=160)
    ano: int = Field(..., ge=2000, le=9999)
    numero: str = Field("", max_length=24, pattern=r"^\d*$")

    @field_validator("serie", "os")
    @classmethod
    def trim_identifier(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Informe a série e o número da OS.")
        return normalized


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
    ticket_import_services: Optional[TicketImportServices] = None,
    ticket_os_links_file: Optional[Callable[[], Path]] = None,
):
    """Build the operations routes; ``ticket_import_services`` shares the import with the inbox."""
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

    def ticket_os_link_key(fonte: str, serie: str, ordem_servico: str) -> str:
        ordem_key = re.sub(r"\s+", "", str(ordem_servico or "")).upper()
        return json.dumps(
            [fonte, normalize_reference_value(serie), ordem_key],
            ensure_ascii=False, separators=(",", ":"),
        )

    def read_ticket_os_links(path: Path) -> Dict[str, Any]:
        if not path.exists():
            return {"version": 1, "vinculos": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise HTTPException(status_code=503, detail="Os vínculos manuais de OS não puderam ser lidos.") from None
        if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("vinculos"), dict):
            raise HTTPException(status_code=503, detail="Os vínculos manuais de OS estão inválidos.")
        links = data["vinculos"]
        for key, link in links.items():
            if not isinstance(key, str) or not isinstance(link, dict):
                raise HTTPException(status_code=503, detail="Os vínculos manuais de OS estão inválidos.")
            try:
                fonte = link["fonte"]
                serie = link["serie"]
                ordem = link["os"]
                ano = int(link["ano"])
                numero = link["numero"]
                expected_key = ticket_os_link_key(fonte, serie, ordem)
                valid = (
                    fonte in {"simpress", "oracle"}
                    and bool(str(serie).strip()) and bool(str(ordem).strip())
                    and 2000 <= ano <= 9999
                    and isinstance(numero, str) and re.fullmatch(r"\d{1,24}", numero)
                    and key == expected_key
                )
            except (KeyError, TypeError, ValueError):
                valid = False
                numero = ""
                ano = 0
            if not valid:
                raise HTTPException(status_code=503, detail="Os vínculos manuais de OS estão inválidos.")
            link["ano"] = ano
            link["chamado"] = f"UTIC-{ano}-{numero}"
        return data

    @router.get("/api/operacoes/chamados/vinculos-os")
    def get_ticket_os_links():
        path = ticket_os_links_file() if ticket_os_links_file else ticket_report_path().parent / "os_chamados_vinculos.json"
        data = read_ticket_os_links(path)
        return {"vinculos": list(data["vinculos"].values())}

    @router.put("/api/operacoes/chamados/vinculos-os")
    def save_ticket_os_link(payload: TicketOsLinkPayload):
        path = ticket_os_links_file() if ticket_os_links_file else ticket_report_path().parent / "os_chamados_vinculos.json"
        key = ticket_os_link_key(payload.fonte, payload.serie, payload.os)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with AtomicFileTransaction(transaction_root(), [path]) as transaction:
                state = read_ticket_os_links(path)
                links = dict(state["vinculos"])
                saved = None
                if payload.numero:
                    saved = {
                        "fonte": payload.fonte,
                        "serie": payload.serie,
                        "os": payload.os,
                        "ano": payload.ano,
                        "numero": payload.numero,
                        "chamado": f"UTIC-{payload.ano}-{payload.numero}",
                    }
                    links[key] = saved
                else:
                    links.pop(key, None)
                updated = {"version": 1, "vinculos": links}
                encoded = json.dumps(updated, ensure_ascii=False, indent=2).encode("utf-8")
                transaction.stage_bytes(
                    path,
                    encoded,
                    lambda staged: read_ticket_os_links(staged),
                )
                transaction.commit()
        except HTTPException:
            raise
        except FileBusyError:
            raise HTTPException(status_code=409, detail="Os vínculos de OS estão sendo atualizados por outra operação local.") from None
        except (OSError, FileTransactionError):
            logger.exception("Não foi possível salvar o vínculo manual da OS %s.", redact_reference(payload.os))
            raise HTTPException(status_code=503, detail="Não foi possível salvar o vínculo manual da OS.") from None
        return {"vinculo": saved}

    def displayed_ticket_snapshots(report: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [normalize_ticket_snapshot(item) for item in ticket_report_snapshots(report)]

    services = ticket_import_services or TicketImportServices(
        ticket_report_path=ticket_report_path,
        transaction_root=transaction_root,
        annotation_directory=lambda: (
            history_annotations_directory() if history_annotations_directory
            else ticket_report_path().parent / "anotacoes_historico"
        ),
        annotation_outbox_directory=lambda: (
            local_annotation_outbox_directory() if local_annotation_outbox_directory
            else ticket_report_path().parent / "anotacoes_historico_pendentes"
        ),
        load_annotation_records=load_history_annotation_records or load_history_annotations,
        # Late-bound: this module's collaborators stay replaceable, as they were before the extraction.
        reconcile_workbooks=lambda *args, **kwargs: reconcile_ticket_workbooks(*args, **kwargs),
        transaction_factory=lambda root, targets: AtomicFileTransaction(root, targets),
        publish_annotation=lambda *args, **kwargs: sync_history_annotation(*args, **kwargs),
        now=lambda: datetime.now(),
    )
    annotation_directory = services.annotation_directory
    annotation_outbox_directory = services.annotation_outbox_directory

    def latest_ticket_annotations(strict: bool = False) -> Dict[tuple[str, str], Dict[str, Any]]:
        return ticket_import.latest_ticket_annotations(services, strict)

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

    def sync_ticket_annotation(record: Dict[str, Any]) -> bool:
        return ticket_import.sync_ticket_annotation(services, record)

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
            "motivo": TICKET_TIMELINE_ANNOTATION_REASON,
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
            row_hash=ticket_annotation_row_hash(event),
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
        try:
            return ticket_import.import_ticket_workbooks(
                services,
                TicketWorkbookSource(simpress_file.filename, simpress_file.file.read),
                TicketWorkbookSource(oracle_file.filename, oracle_file.file.read),
                automatic_import_id,
            )
        except TicketImportError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from None

    return router
