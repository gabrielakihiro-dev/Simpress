"""Routes for inventory comparison history and restore operations."""

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime
from functools import partial
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from domains import history_restore
from domains.history_export import _history_display_files, build_history_export_workbook, history_export_series
from domains.history_restore import HistoryRestoreError, comparison_event_type
from domains.history_annotations import (
    AnnotationReadError, resolve_history_annotations,
    annotation_record_values, annotation_view, same_annotation_revision,
    effective_history_annotation, load_effective_history_annotations,
    sync_history_annotation, reuse_annotation_revision,
)

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from core.errors import DomainError
from core.integrity import (
    FileBusyError,
    FileTransactionError,
    TransactionConflictError,
    WorkbookSafetyError,
)


class ManualAliasConflictResolutionPayload(BaseModel):
    acao: str = Field(..., description="Manter o apelido manual ou remover esse override")


class ComparisonAnnotationPayload(BaseModel):
    anotacao: str = Field(..., max_length=2000)
    revisao_id: Optional[str] = Field(None, pattern=r"^[a-f0-9]{32}$")
    base_revisoes: List[str] = Field(default_factory=list, max_length=100)
    resolver_conflito: bool = False


class ComparisonRestorePayload(BaseModel):
    preview_token: str = Field(..., min_length=64, max_length=64)


_ANNOTATABLE_COMPARISON_CATEGORIES = (
    "apelidos_sem_atualizacao",
    "sem_acesso_7_dias",
    "ausentes_no_endpoint",
    "ausentes_em_detalhes",
    "divergencias_local",
    "correspondencias_ambiguas",
    "registros_ambiguos",
    "series_sem_mapeamento",
)
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class InventoryHistoryServices:
    """Explicit application services required by history routes."""

    manual_aliases_by_serial: Callable[[Dict[str, str]], Dict[str, str]]
    build_history_annotation_record: Callable[..., Dict[str, Any]]
    comparison_annotation_item_id: Callable[..., str]
    comparison_history_path: Callable[[], Path]
    comparison_history_for_display: Callable[[Dict[str, Any]], Dict[str, Any]]
    details_upload_path: Callable[[], Path]
    endpoint_upload_path: Callable[[], Path]
    get_equipment_snapshot: Callable[[], Dict[str, Dict[str, Any]]]
    get_equipment_template_file: Callable[[], Optional[Path]]
    history_annotation_record_path: Callable[..., Path]
    history_annotation_row_fingerprint: Callable[[str, Dict[str, Any]], str]
    history_annotations_directory: Callable[[], Path]
    history_annotations_sync_enabled: Callable[[], bool]
    input_directory: Callable[[], Path]
    atomic_file_transaction: Callable[..., Any]
    inventory_state_transaction: Callable[..., Any]
    load_comparison_history: Callable[[], List[Dict[str, Any]]]
    load_database: Callable[..., Any]
    load_history_annotations: Callable[..., List[Dict[str, Any]]]
    load_modified_apelidos: Callable[[], Dict[str, str]]
    local_annotation_outbox_directory: Callable[[], Path]
    max_upload_bytes: int
    modified_aliases_path: Callable[[], Path]
    normalize_reference_value: Callable[[Any], str]
    publish_database_state: Callable[[Dict[str, Any]], None]
    save_history_annotation: Callable[..., Dict[str, Any]]
    transaction_root: Callable[[], Path]
    upload_backups_directory: Callable[[], Path]
    validate_uploaded_workbook: Callable[[bytes, str], Dict[str, Any]]
    # Current logged user per series (``{serie: {usuario, origem}}``) for the history export.
    logged_users_for_series: Optional[Callable[[List[str]], Dict[str, Any]]] = None


@dataclass(frozen=True)
class InventoryHistoryRouteExports:
    """Routes and history helpers exposed to ``main`` and the tests."""

    build_comparison_restore_context: Callable[..., Any]
    comparison_event_has_restorable_backup: Callable[..., Any]
    comparison_event_type: Callable[..., Any]
    comparison_restore_backup_paths: Callable[..., Any]
    current_inventory_snapshot: Callable[..., Any]
    sha256_file: Callable[..., Any]
    validated_comparison_backup_files: Callable[..., Any]
    flush_pending_history_annotations: Callable[..., Any]
    migrate_legacy_history_annotations: Callable[..., Any]
    history_annotation_view: Callable[..., Any]
    excluir_comparacao_historica: Callable[..., Any]
    exportar_historico_comparacoes_excel: Callable[..., Any]
    get_comparacao_historica: Callable[..., Any]
    get_historico_comparacoes: Callable[..., Any]
    salvar_anotacao_comparacao: Callable[..., Any]
    salvar_anotacao_comparacao_historica: Callable[..., Any]
    resolver_divergencia_apelido_manual: Callable[..., Any]
    restaurar_comparacao_historica: Callable[..., Any]
    visualizar_restauracao_comparacao: Callable[..., Any]


def create_inventory_history_router(services: InventoryHistoryServices) -> Tuple[APIRouter, InventoryHistoryRouteExports]:
    router = APIRouter()

    def _latest_annotation_records(history=None):
        return load_effective_history_annotations(
            services.history_annotations_directory(),
            services.local_annotation_outbox_directory(),
            services.load_history_annotations,
        )


    def _sync_annotation_record(record: Dict[str, Any]) -> bool:
        try:
            return sync_history_annotation(
                record, directory=services.history_annotations_directory(),
                outbox=services.local_annotation_outbox_directory(),
                transaction_root=services.transaction_root(),
                transaction_factory=services.atomic_file_transaction,
                publisher=services.save_history_annotation,
            )
        except Exception:
            logger.exception(
                "Anotação salva localmente e aguardando sincronização (evento=%s, item=%s).",
                record["evento_id"],
                record["item_id"],
            )
            return False

    def flush_pending_history_annotations() -> Dict[str, int]:
        pending = services.load_history_annotations(services.local_annotation_outbox_directory())
        synchronized = sum(1 for record in pending if _sync_annotation_record(record))
        return {"pendentes": len(pending) - synchronized, "sincronizadas": synchronized}


    def migrate_legacy_history_annotations() -> Dict[str, int]:
        """Move legacy row notes into the durable outbox outside read requests."""
        history = services.load_comparison_history()
        try:
            # A revision that exists but cannot be read must not look absent here, or
            # the embedded legacy text would be queued as a false concurrent edit.
            shared_records = services.load_history_annotations(services.history_annotations_directory(), strict=True)
            outbox_records = services.load_history_annotations(
                services.local_annotation_outbox_directory(), strict=True,
            )
        except AnnotationReadError:
            logger.warning(
                "Migração de anotações legadas adiada para a próxima execução: há revisões ilegíveis no momento."
            )
            return {"legadas_enfileiradas": 0, "adiada": 1, **flush_pending_history_annotations()}
        records = resolve_history_annotations([*shared_records, *outbox_records])
        versioned_keys = {
            (record["evento_id"], record["item_id"])
            for record in (*shared_records, *outbox_records)
            if record.get("versao") == 2
        }
        queued = 0
        for event in history:
            if not isinstance(event, dict):
                continue
            event_id = str(event.get("id") or "")
            comparison = event.get("comparacao")
            if not event_id or not isinstance(comparison, dict):
                continue
            legacy_annotations = comparison.get("anotacoes")
            for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
                items = comparison.get(category)
                if not isinstance(items, list):
                    continue
                for index, item in enumerate(items):
                    if not isinstance(item, dict):
                        continue
                    annotation = item.get("anotacao")
                    if not isinstance(annotation, str) and isinstance(legacy_annotations, dict):
                        legacy_category = (
                            "ambiguidades"
                            if category in ("correspondencias_ambiguas", "registros_ambiguos")
                            else category
                        )
                        legacy_index = index
                        if category == "registros_ambiguos":
                            ambiguity_items = comparison.get("correspondencias_ambiguas")
                            legacy_index += len(ambiguity_items) if isinstance(ambiguity_items, list) else 0
                        annotation = legacy_annotations.get(f"{legacy_category}:{legacy_index}")
                    if not isinstance(annotation, str):
                        continue
                    item_id = services.comparison_annotation_item_id(event_id, category, index, item)
                    key = (event_id, item_id)
                    existing = records.get(key)
                    # Embedded history is a legacy fallback, never a new edit over a revision.
                    if key in versioned_keys or (existing is not None and existing.get("anotacao") == annotation):
                        continue
                    try:
                        legacy = {
                            "versao": 1, "evento_id": event_id, "item_id": item_id,
                            "horario": str(event.get("horario") or ""),
                            "serie": str(item.get("serie") or ""),
                            "computador": str(item.get("computador") or item.get("chave") or ""),
                            "motivo": str(item.get("motivo") or item.get("mensagem") or item.get("tipo") or ""),
                            "anotacao": annotation, "categoria": category,
                            "linha_hash": services.history_annotation_row_fingerprint(category, item),
                            "atualizado_em": str(event.get("horario") or ""),
                        }
                        record = services.save_history_annotation(
                            services.local_annotation_outbox_directory(),
                            **annotation_record_values(legacy),
                        )
                        records[key] = record
                        queued += 1
                    except Exception:
                        logger.exception(
                            "Falha ao colocar anotação legada na fila de sincronização (evento=%s, item=%s).",
                            event_id, item_id,
                        )
                        continue
        # Preserve existing v1 files and publish deterministic immutable copies.
        for legacy in shared_records:
            if legacy.get("versao") == 1:
                try:
                    values = annotation_record_values(legacy)
                    target = services.history_annotation_record_path(
                        services.history_annotations_directory(), legacy["evento_id"], legacy["item_id"],
                        values["revision_id"],
                    )
                    if not target.exists():
                        services.save_history_annotation(services.local_annotation_outbox_directory(), **values)
                        queued += 1
                except Exception:
                    logger.exception("A cópia imutável da anotação legada ficou pendente.")
        flush_result = flush_pending_history_annotations()
        return {"legadas_enfileiradas": queued, **flush_result}

    def _merge_shared_annotations(
        event_view: Dict[str, Any],
        annotations: Dict[tuple[str, str], Dict[str, Any]],
    ) -> Dict[str, Any]:
        comparison = event_view.get("comparacao")
        if not isinstance(comparison, dict):
            return event_view
        comparison["anotacoes_sync_ativa"] = bool(services.history_annotations_sync_enabled())
        event_id = str(event_view.get("id") or "")
        for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
            items = comparison.get(category)
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                item.update(effective_history_annotation(
                    annotations, event_id, str(item.get("anotacao_id") or ""),
                    item.get("anotacao"),
                ))
                associated_annotations = item.get("anotacoes_associadas")
                if not isinstance(associated_annotations, list):
                    continue
                for associated in associated_annotations:
                    if not isinstance(associated, dict):
                        continue
                    associated.update(effective_history_annotation(
                        annotations, event_id, str(associated.get("anotacao_id") or ""),
                        associated.get("anotacao"),
                    ))
        return event_view


    def _synthetic_annotation_event(event_id: str, records: Dict[tuple, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        event_records = [
            record for (record_event_id, _), record in records.items()
            if record_event_id == event_id and (record.get("anotacao") or record.get("anotacao_conflito"))
        ]
        if not event_records:
            return None
        event_records.sort(key=lambda record: record["item_id"])
        event_time = next((record.get("horario") for record in event_records if record.get("horario")), "")
        category_items: Dict[str, List[Dict[str, Any]]] = {
            category: [] for category in _ANNOTATABLE_COMPARISON_CATEGORIES
        }
        synchronized_annotations = []
        for record in event_records:
            category = record.get("categoria")
            if category not in category_items:
                category = "apelidos_sem_atualizacao"
            item = {
                "serie": record.get("serie", ""),
                "computador": record.get("computador", ""),
                "motivo": record.get("motivo", ""),
                "anotacao_id": record["item_id"],
                **annotation_view(record),
                "categoria": category,
            }
            category_items[category].append(item)
            synchronized_annotations.append(item)
        return {
            "id": event_id,
            "horario": event_time,
            "somente_anotacoes_sincronizadas": True,
            "arquivos_enviados": {},
            "resumo": {
                category: len(items)
                for category, items in category_items.items()
                if items
            },
            "comparacao": {
                "evento_id": event_id,
                "horario_comparacao": event_time,
                "tipo_operacao": "atualizacao",
                "arquivos_enviados": {},
                **category_items,
                "anotacoes_sincronizadas": synchronized_annotations,
                "apelidos_atualizados": [],
                "divergencias_apelidos_manuais": [],
                "anotacoes_sync_ativa": bool(services.history_annotations_sync_enabled()),
                "somente_anotacoes_sincronizadas": True,
            },
        }

    def history_annotation_view(event: Dict[str, Any]) -> Dict[str, Any]:
        """Supply the observed text and causal bases to consumers that also edit notes."""
        view = services.comparison_history_for_display(event)
        return _merge_shared_annotations(view, _latest_annotation_records())


    def _history_event_summary(event: Dict[str, Any]) -> Dict[str, Any]:
        summary = event.get("resumo")
        if isinstance(summary, dict):
            return dict(summary)
        comparison = event.get("comparacao")
        comparison = comparison if isinstance(comparison, dict) else {}
        categories = (
            "apelidos_atualizados",
            "apelidos_sem_atualizacao",
            "sem_acesso_7_dias",
            "ausentes_no_endpoint",
            "ausentes_em_detalhes",
            "divergencias_local",
            "correspondencias_ambiguas",
            "registros_ambiguos",
            "divergencias_apelidos_manuais",
            "series_sem_mapeamento",
        )
        result = {"total_endpoint": comparison.get("total_endpoint", 0)}
        for category in categories:
            values = comparison.get(category)
            result[category] = len(values) if isinstance(values, list) else 0
        return result


    @router.get("/api/historico-comparacoes")
    def get_historico_comparacoes():
        eventos = []
        history = services.load_comparison_history()
        annotations = _latest_annotation_records()
        local_event_ids = set()
        for evento in history:
            if not isinstance(evento, dict):
                continue
            event_id = str(evento.get("id") or "")
            if event_id:
                local_event_ids.add(event_id)
            comparison = evento.get("comparacao")
            comparison = comparison if isinstance(comparison, dict) else {}
            eventos.append({
                "id": evento.get("id"),
                "horario": evento.get("horario"),
                "tipo": comparison_event_type(evento),
                "arquivos_enviados": _history_display_files(evento.get("arquivos_enviados")),
                "arquivos_restaurados": _history_display_files(comparison.get("arquivos_restaurados")),
                "restauracao_de": comparison.get("restauracao_de", {}),
                "restauravel": history_restore.event_has_restorable_backup(services, evento),
                "resumo": _history_event_summary(evento),
            })
        shared_event_ids = {event_id for event_id, _ in annotations}
        for event_id in shared_event_ids - local_event_ids:
            event_records = [
                record for (record_event_id, _), record in annotations.items()
                if record_event_id == event_id and (record.get("anotacao") or record.get("anotacao_conflito"))
            ]
            if not event_records:
                continue
            summary: Dict[str, int] = {}
            for record in event_records:
                category = str(record.get("categoria") or "apelidos_sem_atualizacao")
                summary[category] = summary.get(category, 0) + 1
            event_time = next((record.get("horario") for record in event_records if record.get("horario")), "")
            eventos.append({
                "id": event_id,
                "horario": event_time,
                "tipo": "atualizacao",
                "arquivos_enviados": {},
                "arquivos_restaurados": {},
                "restauracao_de": {},
                "restauravel": False,
                "somente_anotacoes_sincronizadas": True,
                "resumo": summary,
            })
        def event_timestamp(item: Dict[str, Any]) -> float:
            try:
                return datetime.fromisoformat(str(item.get("horario") or "").replace("Z", "+00:00")).timestamp()
            except (TypeError, ValueError, OverflowError):
                return float("-inf")
        eventos.sort(key=event_timestamp, reverse=True)
        return {"total": len(eventos), "eventos": eventos}


    @router.get("/api/historico-comparacoes/exportar/excel")
    def exportar_historico_comparacoes_excel(data: str = Query(..., min_length=10, max_length=10, pattern=r"^\d{4}-\d{2}-\d{2}$")):
        try:
            selected_date = date.fromisoformat(data)
        except ValueError:
            raise HTTPException(status_code=400, detail="Selecione uma data válida para exportação.") from None

        history = services.load_comparison_history()
        annotations = _latest_annotation_records(history)
        display_events = []
        for event in history:
            if isinstance(event, dict) and str(event.get("horario") or "")[:10] == selected_date.isoformat():
                event_view = services.comparison_history_for_display(event)
                _merge_shared_annotations(event_view, annotations)
                display_events.append(event_view)
        if not display_events:
            raise HTTPException(status_code=404, detail="Não há registros de planilhas na data selecionada.")
        series = history_export_series(display_events)
        logged_users: Dict[str, Any] = {}
        lookup_users = getattr(services, "logged_users_for_series", None)
        if series and lookup_users is not None:
            try:
                logged_users = lookup_users(series)
            except Exception:  # The user columns are informative; the export still works without them.
                logger.exception("Não foi possível consultar os usuários logados para a exportação do histórico.")
        output, filename = build_history_export_workbook(display_events, selected_date, logged_users)
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


    @router.get("/api/historico-comparacoes/{evento_id}")
    def get_comparacao_historica(evento_id: str):
        evento = next(
            (item for item in services.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        annotations = _latest_annotation_records()
        if evento is None:
            event_view = _synthetic_annotation_event(evento_id, annotations)
            if event_view is None:
                raise HTTPException(status_code=404, detail="O resultado selecionado não existe no histórico de planilhas.")
            return {"evento": event_view}
        event_view = services.comparison_history_for_display(evento)
        _merge_shared_annotations(event_view, annotations)
        return {"evento": event_view}


    @router.put("/api/historico-comparacoes/{evento_id}/anotacoes/{item_id}")
    def salvar_anotacao_comparacao_historica(
        evento_id: str,
        item_id: str,
        payload: ComparisonAnnotationPayload,
    ):
        event = next(
            (item for item in services.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        annotation_row = None
        annotation_category = "apelidos_sem_atualizacao"
        annotation_line_hash = None
        if event is not None:
            comparison = event.get("comparacao")
            if isinstance(comparison, dict):
                for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
                    items = comparison.get(category)
                    if not isinstance(items, list):
                        continue
                    for index, comparison_item in enumerate(items):
                        if not isinstance(comparison_item, dict):
                            continue
                        stable_id = services.comparison_annotation_item_id(
                            evento_id, category, index, comparison_item
                        )
                        if stable_id == item_id:
                            annotation_row = dict(comparison_item)
                            annotation_row["anotacao_id"] = stable_id
                            annotation_category = category
                            break
                    if annotation_row is not None:
                        break
        else:
            annotation_row = next(
                (
                    record for (record_event_id, record_item_id), record in _latest_annotation_records().items()
                    if record_event_id == evento_id and record_item_id == item_id
                ),
                None,
            )
            if isinstance(annotation_row, dict):
                annotation_category = str(annotation_row.get("categoria") or annotation_category)
                annotation_line_hash = annotation_row.get("linha_hash")
        if annotation_row is None:
            raise HTTPException(status_code=404, detail="A linha selecionada não existe neste resultado.")

        def update_annotation(history):
            if not isinstance(history, list):
                raise HTTPException(status_code=500, detail="O histórico de planilhas não contém uma lista válida.")
            event = next(
                (item for item in history if isinstance(item, dict) and item.get("id") == evento_id),
                None,
            )
            if event is None:
                raise HTTPException(status_code=404, detail="A atualização selecionada não existe mais no histórico.")
            comparison = event.get("comparacao")
            if not isinstance(comparison, dict):
                raise HTTPException(status_code=404, detail="A linha selecionada não existe neste resultado.")
            for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
                items = comparison.get(category)
                if not isinstance(items, list):
                    continue
                for index, comparison_item in enumerate(items):
                    if not isinstance(comparison_item, dict):
                        continue
                    stable_id = services.comparison_annotation_item_id(
                        evento_id, category, index, comparison_item
                    )
                    if stable_id == item_id:
                        comparison_item["anotacao_id"] = stable_id
                        comparison_item["anotacao"] = payload.anotacao
                        return history
            raise HTTPException(status_code=404, detail="A linha selecionada não existe neste resultado.")

        category = annotation_category
        record_values = {
            "event_id": evento_id,
            "event_time": str(event.get("horario") or "") if event is not None else str(annotation_row.get("horario") or ""),
            "item_id": item_id,
            "serie": str(annotation_row.get("serie") or ""),
            "computador": str(annotation_row.get("computador") or annotation_row.get("chave") or ""),
            "motivo": str(annotation_row.get("motivo") or annotation_row.get("mensagem") or annotation_row.get("tipo") or ""),
            "anotacao": payload.anotacao,
            "categoria": category,
            "linha_hash": annotation_line_hash or services.history_annotation_row_fingerprint(category, annotation_row),
        }
        base_revisions = getattr(payload, "base_revisoes", [])
        if len(base_revisions) > 1 and not getattr(payload, "resolver_conflito", False):
            raise HTTPException(409, detail="Confirme explicitamente a resolução do conflito.")
        try:
            record = services.build_history_annotation_record(
                **record_values, revision_id=getattr(payload, "revisao_id", None),
                base_revisions=base_revisions,
            )
        except ValueError as error:
            raise HTTPException(422, detail=str(error)) from None
        pending_path = services.history_annotation_record_path(
            services.local_annotation_outbox_directory(),
            evento_id,
            item_id,
            record["revisao_id"],
        )
        try:
            # The transaction locks the history file; no Python lock is held around it.
            targets = [pending_path]
            if event is not None:
                targets.append(services.comparison_history_path())
            with services.atomic_file_transaction(services.transaction_root(), targets) as transaction:
                try:
                    record = reuse_annotation_revision(services.history_annotations_directory(), record)
                except ValueError as error:
                    raise HTTPException(409, detail=str(error)) from None
                if event is not None:
                    transaction.update_json(
                        services.comparison_history_path(),
                        update_annotation,
                        [],
                    )
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
        except (HTTPException, DomainError):
            raise
        except Exception:
            status = 503 if services.history_annotations_sync_enabled() else 500
            logger.exception(
                "Falha ao salvar anotação local (evento=%s, item=%s).",
                evento_id,
                item_id,
            )
            raise HTTPException(status_code=status, detail="Não foi possível salvar a anotação localmente.") from None

        synchronized = _sync_annotation_record(record)
        sync_status = (
            "sincronizada"
            if services.history_annotations_sync_enabled() and synchronized
            else "pendente"
            if services.history_annotations_sync_enabled()
            else "local"
        )
        return {
            "sucesso": True,
            **annotation_view(_latest_annotation_records()[(evento_id, item_id)]),
            "revisao_salva": record["revisao_id"],
            "sincronizacao": sync_status,
        }


    @router.get("/api/historico-comparacoes/{evento_id}/restauracao")
    def visualizar_restauracao_comparacao(evento_id: str):
        try:
            return history_restore.restore_preview(services, evento_id)
        except HistoryRestoreError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error


    @router.post("/api/historico-comparacoes/{evento_id}/restaurar")
    def restaurar_comparacao_historica(evento_id: str, payload: ComparisonRestorePayload):
        try:
            return history_restore.restore_comparison(services, evento_id, payload.preview_token)
        except HistoryRestoreError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error
        except (HTTPException, DomainError):
            raise
        except FileBusyError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except TransactionConflictError as error:
            raise HTTPException(status_code=409, detail=f"Um arquivo mudou durante a restauração e nada foi sobrescrito: {error}") from error
        except (FileTransactionError, WorkbookSafetyError) as error:
            raise HTTPException(status_code=500, detail=f"Não foi possível concluir a restauração; os arquivos anteriores foram recuperados. {error}") from error
        except Exception:
            logger.exception("Falha inesperada ao restaurar conjunto de planilhas (evento=%s).", evento_id)
            raise HTTPException(status_code=500, detail="Falha ao restaurar o conjunto; os arquivos anteriores foram recuperados.") from None


    @router.post("/api/historico-comparacoes/{evento_id}/apelido-manual/{serial}")
    def resolver_divergencia_apelido_manual(
        evento_id: str,
        serial: str,
        payload: ManualAliasConflictResolutionPayload,
    ):
        acao = str(payload.acao or "").strip().lower()
        if acao not in {"manter", "excluir"}:
            raise HTTPException(status_code=400, detail="Escolha manter ou excluir a alteração manual.")

        serial_key = services.normalize_reference_value(serial)
        if not serial_key:
            raise HTTPException(status_code=400, detail="A série informada é inválida.")

        event = next(
            (item for item in services.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        if event is None:
            raise HTTPException(status_code=404, detail="A atualização selecionada não existe no histórico.")
        comparison = event.get("comparacao")
        divergences = comparison.get("divergencias_apelidos_manuais") if isinstance(comparison, dict) else None
        divergence = next(
            (
                item for item in divergences or []
                if isinstance(item, dict) and services.normalize_reference_value(item.get("serie")) == serial_key
            ),
            None,
        )
        if divergence is None:
            raise HTTPException(status_code=404, detail="A divergência de apelido não existe neste registro.")
        if divergence.get("resolucao") != "pendente":
            raise HTTPException(status_code=409, detail="Esta divergência já foi resolvida no histórico.")

        expected_manual_alias = str(divergence.get("apelido_manual") or "").strip()
        target_serial = next(
            (
                str(item.get("serial") or key).strip().upper()
                for key, item in services.get_equipment_snapshot().items()
                if services.normalize_reference_value(item.get("serial") or key) == serial_key
            ),
            str(serial).strip().upper(),
        )
        targets = [services.comparison_history_path(), services.modified_aliases_path()]
        if acao == "excluir":
            details_file = services.get_equipment_template_file()
            if details_file is None or not details_file.is_file():
                raise HTTPException(status_code=404, detail="A planilha atual na Simpress não foi encontrada.")
            targets.append(details_file)

        with services.inventory_state_transaction(targets) as transaction:
            current_aliases = services.manual_aliases_by_serial(services.load_modified_apelidos())
            if serial_key not in current_aliases or current_aliases[serial_key] != expected_manual_alias:
                raise HTTPException(
                    status_code=409,
                    detail="O apelido manual mudou desde esta comparação. Atualize o histórico antes de decidir.",
                )

            if acao == "excluir":
                def remove_manual_override(data):
                    if not isinstance(data, dict):
                        raise RuntimeError("O arquivo de apelidos manuais não contém um objeto válido.")
                    keys = [key for key in data if services.normalize_reference_value(key) == serial_key]
                    if len(keys) != 1 or str(data.get(keys[0]) or "").strip() != expected_manual_alias:
                        raise HTTPException(status_code=409, detail="O override manual mudou desde esta comparação.")
                    updated = dict(data)
                    for key in keys:
                        updated.pop(key, None)
                    return updated

                transaction.update_json(services.modified_aliases_path(), remove_manual_override, {})

            def mark_divergence_resolved(history):
                if not isinstance(history, list):
                    raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
                updated = list(history)
                stored_event = next((item for item in updated if item.get("id") == evento_id), None)
                if stored_event is None:
                    raise HTTPException(status_code=409, detail="A atualização foi removida do histórico.")
                stored_comparison = stored_event.get("comparacao")
                stored_divergences = stored_comparison.get("divergencias_apelidos_manuais") if isinstance(stored_comparison, dict) else None
                stored_divergence = next(
                    (
                        item for item in stored_divergences or []
                        if isinstance(item, dict) and services.normalize_reference_value(item.get("serie")) == serial_key
                    ),
                    None,
                )
                if stored_divergence is None or stored_divergence.get("resolucao") != "pendente":
                    raise HTTPException(status_code=409, detail="A divergência já foi alterada no histórico.")
                stored_divergence["resolucao"] = acao
                stored_divergence["horario_resolucao"] = datetime.now().astimezone().isoformat(timespec="seconds")
                return updated

            transaction.update_json(services.comparison_history_path(), mark_divergence_resolved, [])
            transaction.apply()
            if acao == "excluir" and not services.load_database(transaction_locked=True):
                raise RuntimeError("A base não pôde ser recarregada após excluir o override manual.")
            transaction.commit()

        equipment = next(
            (
                item for key, item in services.get_equipment_snapshot().items()
                if services.normalize_reference_value(item.get("serial") or key) == serial_key
            ),
            None,
        )
        return {
            "sucesso": True,
            "resolucao": acao,
            "mensagem": (
                "Apelido manual mantido para esta série."
                if acao == "manter"
                else "Alteração manual removida; o apelido voltou a seguir as planilhas de origem."
            ),
            "equipamento": {
                key: value for key, value in equipment.items() if not key.startswith("_")
            } if equipment else None,
            "total_modificados": len(services.load_modified_apelidos()),
        }


    @router.delete("/api/historico-comparacoes/{evento_id}")
    def excluir_comparacao_historica(evento_id: str):
        history = services.load_comparison_history()
        event = next((item for item in history if isinstance(item, dict) and item.get("id") == evento_id), None)
        if event is None:
            raise HTTPException(status_code=404, detail="A atualização selecionada não existe mais no histórico.")
        tombstones = []
        for (record_event_id, _), record in _latest_annotation_records(history).items():
            if record_event_id != evento_id:
                continue
            tombstones.append(services.build_history_annotation_record(
                event_id=evento_id,
                event_time=str(record.get("horario") or event.get("horario") or ""),
                item_id=record["item_id"],
                serie=str(record.get("serie") or ""),
                computador=str(record.get("computador") or ""),
                motivo=str(record.get("motivo") or ""),
                anotacao="",
                base_revisions=record.get("anotacao_revisoes", []),
                categoria=str(record.get("categoria") or "apelidos_sem_atualizacao"),
                linha_hash=record.get("linha_hash"),
            ))

        pending_paths = [
            services.history_annotation_record_path(
                services.local_annotation_outbox_directory(),
                record["evento_id"],
                record["item_id"],
                record["revisao_id"],
            )
            for record in tombstones
        ]
        try:
            with services.atomic_file_transaction(
                services.transaction_root(),
                [services.comparison_history_path(), *pending_paths],
            ) as transaction:
                result: Dict[str, Any] = {"total": None}

                def remove_event(rows):
                    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                        raise HTTPException(status_code=500, detail="O histórico de planilhas não contém uma lista válida.")
                    updated = [row for row in rows if row.get("id") != evento_id]
                    if len(updated) == len(rows):
                        raise HTTPException(status_code=404, detail="A atualização selecionada não existe mais no histórico.")
                    result["total"] = len(updated)
                    return updated

                transaction.update_json(services.comparison_history_path(), remove_event, [])
                for record, pending_path in zip(tombstones, pending_paths):
                    transaction.stage_bytes(
                        pending_path,
                        json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8"),
                        lambda path: json.loads(path.read_text(encoding="utf-8")),
                    )
                transaction.commit()
        except (HTTPException, DomainError):
            raise
        except Exception:
            logger.exception("Falha ao remover evento do histórico (evento=%s).", evento_id)
            status = 503 if services.history_annotations_sync_enabled() else 500
            raise HTTPException(status_code=status, detail="Não foi possível remover o resultado do histórico localmente.") from None

        sync_results = [_sync_annotation_record(record) for record in tombstones]
        pending_count = sum(not result for result in sync_results)
        return {
            "sucesso": True,
            "total": result["total"],
            "sincronizacao": "pendente" if pending_count else (
                "sincronizada" if services.history_annotations_sync_enabled() else "local"
            ),
        }

    return router, InventoryHistoryRouteExports(
        build_comparison_restore_context=partial(history_restore.build_restore_context, services),
        comparison_event_has_restorable_backup=partial(history_restore.event_has_restorable_backup, services),
        comparison_event_type=comparison_event_type,
        comparison_restore_backup_paths=partial(history_restore.restore_backup_paths, services),
        current_inventory_snapshot=partial(history_restore.current_inventory_snapshot, services),
        sha256_file=history_restore.sha256_file,
        validated_comparison_backup_files=partial(history_restore.validated_backup_files, services),
        flush_pending_history_annotations=flush_pending_history_annotations,
        migrate_legacy_history_annotations=migrate_legacy_history_annotations,
        history_annotation_view=history_annotation_view,
        excluir_comparacao_historica=excluir_comparacao_historica,
        exportar_historico_comparacoes_excel=exportar_historico_comparacoes_excel,
        get_comparacao_historica=get_comparacao_historica,
        get_historico_comparacoes=get_historico_comparacoes,
        salvar_anotacao_comparacao=salvar_anotacao_comparacao_historica,
        salvar_anotacao_comparacao_historica=salvar_anotacao_comparacao_historica,
        resolver_divergencia_apelido_manual=resolver_divergencia_apelido_manual,
        restaurar_comparacao_historica=restaurar_comparacao_historica,
        visualizar_restauracao_comparacao=visualizar_restauracao_comparacao,
    )
