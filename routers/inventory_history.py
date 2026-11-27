"""Routes for inventory comparison history and restore operations."""

import logging
import threading
from dataclasses import dataclass
from datetime import date
from functools import partial
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from domains import history_comparisons, history_restore
from routers.dashboard import long_unused_status
from domains.history_comparisons import HistoryComparisonError
from domains.history_export import build_history_export_workbook, history_export_series
from domains.history_restore import HistoryRestoreError, comparison_event_type
from domains.history_annotations import MAX_ANNOTATION_LENGTH

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
    anotacao: str = Field(..., max_length=MAX_ANNOTATION_LENGTH)
    revisao_id: Optional[str] = Field(None, pattern=r"^[a-f0-9]{32}$")
    base_revisoes: List[str] = Field(default_factory=list, max_length=100)
    resolver_conflito: bool = False


class ComparisonRestorePayload(BaseModel):
    preview_token: str = Field(..., min_length=64, max_length=64)


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
    # One cache per router instance (the tests build several); the lock only guards dict reads and updates.
    annotation_cache: Dict[str, Any] = {"key": None, "records": None}
    annotation_cache_lock = threading.Lock()

    @router.get("/api/historico-comparacoes")
    def get_historico_comparacoes():
        history = services.load_comparison_history()
        annotations = history_comparisons.listing_annotation_records(services, annotation_cache, annotation_cache_lock)
        return history_comparisons.history_listing(services, history, annotations)

    @router.get("/api/historico-comparacoes/exportar/excel")
    def exportar_historico_comparacoes_excel(data: str = Query(..., min_length=10, max_length=10, pattern=r"^\d{4}-\d{2}-\d{2}$")):
        try:
            selected_date = date.fromisoformat(data)
        except ValueError:
            raise HTTPException(status_code=400, detail="Selecione uma data válida para exportação.") from None

        try:
            display_events = history_comparisons.export_display_events(services, selected_date, long_unused_status)
        except HistoryComparisonError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from None
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
        try:
            return history_comparisons.comparison_event_view(services, evento_id, long_unused_status)
        except HistoryComparisonError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from None

    @router.put("/api/historico-comparacoes/{evento_id}/anotacoes/{item_id}")
    def salvar_anotacao_comparacao_historica(
        evento_id: str,
        item_id: str,
        payload: ComparisonAnnotationPayload,
    ):
        try:
            return history_comparisons.save_comparison_annotation(
                services, evento_id, item_id,
                anotacao=payload.anotacao,
                revisao_id=getattr(payload, "revisao_id", None),
                base_revisoes=getattr(payload, "base_revisoes", []),
                resolver_conflito=getattr(payload, "resolver_conflito", False),
                long_unused_status=long_unused_status,
            )
        except HistoryComparisonError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from None

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

        try:
            return history_comparisons.resolve_manual_alias_divergence(services, evento_id, serial, serial_key, acao)
        except HistoryComparisonError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from None

    @router.delete("/api/historico-comparacoes/{evento_id}")
    def excluir_comparacao_historica(evento_id: str):
        try:
            return history_comparisons.delete_history_event(services, evento_id)
        except HistoryComparisonError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from None

    return router, InventoryHistoryRouteExports(
        build_comparison_restore_context=partial(history_restore.build_restore_context, services),
        comparison_event_has_restorable_backup=partial(history_restore.event_has_restorable_backup, services),
        comparison_event_type=comparison_event_type,
        comparison_restore_backup_paths=partial(history_restore.restore_backup_paths, services),
        current_inventory_snapshot=partial(history_restore.current_inventory_snapshot, services),
        sha256_file=history_restore.sha256_file,
        validated_comparison_backup_files=partial(history_restore.validated_backup_files, services),
        flush_pending_history_annotations=partial(history_comparisons.flush_pending_history_annotations, services),
        migrate_legacy_history_annotations=partial(history_comparisons.migrate_legacy_history_annotations, services),
        history_annotation_view=partial(history_comparisons.history_annotation_view, services),
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
