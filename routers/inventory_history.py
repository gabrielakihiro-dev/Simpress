"""Routes for inventory comparison history and restore operations."""

import filecmp
import hashlib
import hmac
import json
import logging
import os
import shutil
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from domains.history_export import (
    _export_datetime,
    _export_event_timestamp,
    _export_note,
    _export_rows,
    _export_text,
    _history_display_files,
    _history_display_text,
    _write_export_summary_sheet,
    _write_export_table_sheet,
)
from domains.history_annotations import (
    annotation_record_values, annotation_view, annotation_export_text, same_annotation_revision,
    effective_history_annotation, load_effective_history_annotations,
    sync_history_annotation, reuse_annotation_revision,
)

import openpyxl
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
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
    "sem_acesso_14_dias",
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
    comparison_history_lock: Any
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
    load_history_annotations: Callable[[Path], List[Dict[str, Any]]]
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
    postgres_files: Optional[Callable[[], Any]] = None


def create_inventory_history_router(services: InventoryHistoryServices):
    router = APIRouter()

    def _comparison_event_type(evento: Dict[str, Any]) -> str:
        comparison = evento.get("comparacao")
        if (
            evento.get("tipo") == "restauracao"
            or isinstance(comparison, dict) and comparison.get("tipo_operacao") == "restauracao"
        ):
            return "restauracao"
        return "atualizacao"


    def _comparison_restore_backup_paths(evento: Dict[str, Any]) -> Dict[str, Path]:
        comparison = evento.get("comparacao")
        if not isinstance(comparison, dict):
            raise HTTPException(status_code=409, detail="Esta atualização não possui um backup disponível para restauração.")
        relative_value = comparison.get("backup_diretorio")
        if not isinstance(relative_value, str) or not relative_value.strip():
            raise HTTPException(status_code=409, detail="Esta atualização não possui um backup disponível para restauração.")

        relative_path = Path(relative_value)
        if relative_path.is_absolute() or not relative_path.parts or any(part in {".", ".."} for part in relative_path.parts):
            raise HTTPException(status_code=409, detail="O caminho do backup desta atualização não é válido.")

        try:
            backup_root = services.upload_backups_directory().resolve(strict=False)
            backup_directory = (services.input_directory() / relative_path).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            raise HTTPException(status_code=409, detail="O backup desta atualização não está disponível.") from None
        if backup_directory.parent != backup_root or not backup_directory.is_dir():
            raise HTTPException(status_code=409, detail="O backup desta atualização não está disponível.")

        missing_roles = comparison.get("backup_arquivos_ausentes")
        invalid_roles = comparison.get("backup_arquivos_invalidos")
        target_files = {
            "endpoint": services.endpoint_upload_path(),
            "detalhes": services.details_upload_path(),
        }
        paths: Dict[str, Path] = {}
        for role, target_path in target_files.items():
            if (
                isinstance(missing_roles, dict) and missing_roles.get(role) is True
                or isinstance(invalid_roles, dict) and invalid_roles.get(role) is True
            ):
                raise HTTPException(status_code=409, detail="O backup desta atualização não contém dois inventários válidos.")
            try:
                role_directory = (backup_directory / role).resolve(strict=True)
                if role_directory.parent != backup_directory or not role_directory.is_dir():
                    raise ValueError("invalid backup role directory")
                backup_path = (role_directory / target_path.name).resolve(strict=True)
                if backup_path.parent != role_directory or not backup_path.is_file():
                    raise ValueError("invalid backup file")
            except (OSError, RuntimeError, ValueError):
                raise HTTPException(status_code=409, detail="O backup desta atualização não contém os dois inventários.") from None
            paths[role] = backup_path
        return paths


    def _comparison_event_has_restorable_backup(evento: Dict[str, Any]) -> bool:
        if services.postgres_files is not None and (files := services.postgres_files()) is not None:
            return files.restorable(str(evento.get("id") or ""))
        try:
            _comparison_restore_backup_paths(evento)
            return True
        except HTTPException:
            return False


    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()


    def _validated_comparison_backup_files(paths: Dict[str, Path]) -> Dict[str, Dict[str, Any]]:
        labels = {"endpoint": "no endpoint", "detalhes": "na Simpress"}
        files: Dict[str, Dict[str, Any]] = {}
        for role, backup_path in paths.items():
            label = labels[role]
            try:
                size = backup_path.stat().st_size
                if size <= 0 or size > services.max_upload_bytes:
                    raise HTTPException(status_code=409, detail="O arquivo excede o limite de tamanho ou está vazio.")
                file_bytes = backup_path.read_bytes()
                table = services.validate_uploaded_workbook(file_bytes, role)
            except HTTPException as error:
                raise HTTPException(
                    status_code=409,
                    detail=f"O backup de {label} não passou na validação: {error.detail}",
                ) from error
            except WorkbookSafetyError as error:
                raise HTTPException(
                    status_code=409,
                    detail=f"O backup de {label} não passou na validação: {error}",
                ) from error
            except OSError:
                raise HTTPException(status_code=409, detail=f"Não foi possível ler o backup de {label}.") from None
            files[role] = {
                "path": backup_path,
                "name": backup_path.name,
                "bytes": file_bytes,
                "sha256": hashlib.sha256(file_bytes).hexdigest(),
                "records": len(table.get("records", [])),
                "size": size,
                "modified": datetime.fromtimestamp(backup_path.stat().st_mtime).astimezone().isoformat(timespec="seconds"),
            }
        return files


    def _current_inventory_snapshot() -> tuple[Dict[str, Dict[str, Any]], Dict[str, Optional[str]]]:
        target_files = {
            "endpoint": services.endpoint_upload_path(),
            "detalhes": services.details_upload_path(),
        }
        metadata: Dict[str, Dict[str, Any]] = {}
        hashes: Dict[str, Optional[str]] = {}
        for role, target_path in target_files.items():
            if target_path.is_symlink():
                raise HTTPException(status_code=409, detail="Um arquivo ativo foi substituído por um atalho; a restauração foi cancelada.")
            if target_path.exists() and not target_path.is_file():
                raise HTTPException(status_code=409, detail=f"O caminho ativo {target_path.name} não é um arquivo regular.")
            if not target_path.is_file():
                metadata[role] = {"nome": target_path.name, "presente": False}
                hashes[role] = None
                continue
            try:
                stat = target_path.stat()
                if stat.st_size > services.max_upload_bytes:
                    raise HTTPException(status_code=409, detail=f"O arquivo ativo {target_path.name} excede o limite permitido para backup.")
                file_hash = _sha256_file(target_path)
            except HTTPException:
                raise
            except OSError:
                raise HTTPException(status_code=409, detail=f"Não foi possível conferir o arquivo ativo {target_path.name}.") from None
            metadata[role] = {
                "nome": target_path.name,
                "presente": True,
                "tamanho_bytes": stat.st_size,
                "modificado_em": datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec="seconds"),
            }
            hashes[role] = file_hash
        return metadata, hashes


    def _build_comparison_restore_context(evento_id: str) -> Dict[str, Any]:
        evento = next(
            (item for item in services.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        if evento is None:
            raise HTTPException(status_code=404, detail="A atualização selecionada não existe no histórico de planilhas.")

        backup_paths = _comparison_restore_backup_paths(evento)
        backup_files = _validated_comparison_backup_files(backup_paths)
        current_files, current_hashes = _current_inventory_snapshot()
        token_material = {
            "evento_id": evento_id,
            "horario": evento.get("horario"),
            "backup_diretorio": evento.get("comparacao", {}).get("backup_diretorio"),
            "backup_hashes": {role: backup_files[role]["sha256"] for role in sorted(backup_files)},
            "ativos_hashes": current_hashes,
        }
        preview_token = hashlib.sha256(
            json.dumps(token_material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return {
            "evento": evento,
            "backup_files": backup_files,
            "current_files": current_files,
            "current_hashes": current_hashes,
            "preview_token": preview_token,
        }


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
        records = _latest_annotation_records(history)
        versioned_keys = {
            (record["evento_id"], record["item_id"])
            for directory in (services.history_annotations_directory(), services.local_annotation_outbox_directory())
            for record in services.load_history_annotations(directory)
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
        for legacy in services.load_history_annotations(services.history_annotations_directory()):
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
            "sem_acesso_14_dias",
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
                "tipo": _comparison_event_type(evento),
                "arquivos_enviados": _history_display_files(evento.get("arquivos_enviados")),
                "arquivos_restaurados": _history_display_files(comparison.get("arquivos_restaurados")),
                "restauracao_de": comparison.get("restauracao_de", {}),
                "restauravel": _comparison_event_has_restorable_backup(evento),
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
        display_events.sort(key=_export_event_timestamp)

        event_counts = {"atualizacao": 0, "restauracao": 0}
        category_counts = {
            "Apelidos atualizados": 0,
            "Apelidos para conferência": 0,
            "Divergências manuais": 0,
            "Sem verificação há 14+ dias": 0,
            "Ausentes no endpoint": 0,
            "Ausentes na Simpress": 0,
            "Divergências de localidade": 0,
            "Duplicidades e ambiguidades": 0,
            "Séries sem local definido": 0,
        }
        history_rows = []
        alias_rows = []
        absence_rows = []
        no_access_rows = []
        location_rows = []
        ambiguity_rows = []

        for order, event in enumerate(display_events, start=1):
            comparison = event.get("comparacao")
            comparison = comparison if isinstance(comparison, dict) else {}
            summary = event.get("resumo")
            summary = summary if isinstance(summary, dict) else {}
            event_type = _comparison_event_type(event)
            event_type_label = "Restauração" if event_type == "restauracao" else "Atualização"
            event_counts[event_type] += 1
            timestamp = _export_datetime(event.get("horario") or comparison.get("horario_comparacao"))
            event_id = _export_text(event.get("id") or comparison.get("evento_id"))
            alias_updates = _export_rows(comparison, "apelidos_atualizados")
            alias_reviews = _export_rows(comparison, "apelidos_sem_atualizacao")
            manual_alias_conflicts = _export_rows(comparison, "divergencias_apelidos_manuais")
            absent_endpoint = _export_rows(comparison, "ausentes_no_endpoint")
            absent_simpress = _export_rows(comparison, "ausentes_em_detalhes")
            no_recent_verification = _export_rows(comparison, "sem_acesso_14_dias")
            local_divergences = _export_rows(comparison, "divergencias_local")
            unmapped_series = _export_rows(comparison, "series_sem_mapeamento")
            ambiguities = _export_rows(comparison, "correspondencias_ambiguas")
            ambiguous_records = _export_rows(comparison, "registros_ambiguos")

            manual_pending_count = sum(
                1 for item in manual_alias_conflicts
                if item.get("resolucao", "pendente") == "pendente"
            )
            ambiguity_count = len(ambiguities) + len(ambiguous_records)
            category_counts["Apelidos atualizados"] += len(alias_updates)
            category_counts["Apelidos para conferência"] += len(alias_reviews)
            category_counts["Divergências manuais"] += len(manual_alias_conflicts)
            category_counts["Sem verificação há 14+ dias"] += len(no_recent_verification)
            category_counts["Ausentes no endpoint"] += len(absent_endpoint)
            category_counts["Ausentes na Simpress"] += len(absent_simpress)
            category_counts["Divergências de localidade"] += len(local_divergences)
            category_counts["Duplicidades e ambiguidades"] += ambiguity_count
            category_counts["Séries sem local definido"] += len(unmapped_series)

            files_uploaded = event.get("arquivos_enviados")
            if not isinstance(files_uploaded, dict):
                files_uploaded = comparison.get("arquivos_enviados")
            files_uploaded = files_uploaded if isinstance(files_uploaded, dict) else {}
            files_restored = comparison.get("arquivos_restaurados")
            files_restored = files_restored if isinstance(files_restored, dict) else {}
            endpoint_file = files_restored.get("endpoint") if event_type == "restauracao" else files_uploaded.get("endpoint")
            simpress_file = files_restored.get("detalhes") if event_type == "restauracao" else files_uploaded.get("detalhes")
            history_rows.append((
                order,
                timestamp,
                event_type_label,
                event_id,
                _history_display_text(endpoint_file),
                _history_display_text(simpress_file),
                comparison.get("total_endpoint", summary.get("total_endpoint")),
                comparison.get("total_detalhes", summary.get("total_detalhes")),
                comparison.get("total_equipamentos_carregados", summary.get("total_equipamentos_carregados")),
                len(alias_updates),
                len(alias_reviews),
                manual_pending_count,
                len(absent_endpoint),
                len(absent_simpress),
                len(no_recent_verification),
                len(local_divergences),
                ambiguity_count,
                len(unmapped_series),
                _export_datetime((comparison.get("restauracao_de") or {}).get("horario"))
                if isinstance(comparison.get("restauracao_de"), dict) else None,
                _export_text(comparison.get("backup_diretorio")),
            ))

            for item in alias_updates:
                alias_rows.append((
                    timestamp, event_type_label, "Apelido atualizado",
                    item.get("serie"), "", item.get("apelido_anterior"),
                    item.get("apelido_equipamentos_detalhes"),
                    item.get("apelido_novo") or item.get("apelido_invall"),
                    _export_datetime(item.get("horario")), "Concluído", "",
                    _history_display_text(item.get("arquivos_origem")), "",
                ))
            for index, item in enumerate(alias_reviews):
                alias_rows.append((
                    timestamp, event_type_label, "Para conferência",
                    item.get("serie"), item.get("computador"), "", "", "", None,
                    "Pendente", item.get("motivo"), "",
                    _export_note(comparison, "apelidos_sem_atualizacao", index, item),
                ))
            manual_status = {
                "manter": "Alteração manual mantida",
                "excluir": "Alteração manual removida",
                "substituida": "Atualizada por nova planilha",
                "pendente": "Pendente",
            }
            for item in manual_alias_conflicts:
                resolution = item.get("resolucao") or "pendente"
                alias_rows.append((
                    timestamp, event_type_label, "Divergência manual",
                    item.get("serie"), "", item.get("apelido_manual"),
                    item.get("apelido_equipamentos_detalhes"), item.get("apelido_invall"),
                    _export_datetime(item.get("horario_resolucao")),
                    manual_status.get(resolution, _export_text(resolution)),
                    "Diferença entre apelido manual e as planilhas de origem.", "", "",
                ))

            for category, items, note_category in (
                ("Ausente no endpoint", absent_endpoint, "ausentes_no_endpoint"),
                ("Ausente na Simpress", absent_simpress, "ausentes_em_detalhes"),
            ):
                missing_source = "no endpoint" if category == "Ausente no endpoint" else "na Simpress"
                for index, item in enumerate(items):
                    absence_rows.append((
                        timestamp, category,
                        _export_text(item.get("ausente_em") or item.get("fonte_ausente") or missing_source),
                        item.get("computador"), item.get("serie"), item.get("local_previsto"),
                        _export_note(comparison, note_category, index, item),
                    ))

            for index, item in enumerate(no_recent_verification):
                no_access_rows.append((
                    timestamp, event_type_label, item.get("computador"), item.get("serie"),
                    _export_datetime(item.get("ultima_verificacao")), item.get("dias_sem_verificacao"),
                    item.get("linha_endpoint"), _export_note(comparison, "sem_acesso_14_dias", index, item),
                ))

            for index, item in enumerate(local_divergences):
                location_rows.append((
                    timestamp, "Localidade divergente", item.get("computador"),
                    item.get("serie"), item.get("local_previsto"), item.get("local_detalhes"),
                    None, "", _export_note(comparison, "divergencias_local", index, item),
                ))
            for index, item in enumerate(unmapped_series):
                location_rows.append((
                    timestamp, "Série sem local definido", "", item.get("serie"),
                    "", "", item.get("quantidade"), _export_text(item.get("exemplos")),
                    _export_note(comparison, "series_sem_mapeamento", index, item),
                ))

            for index, item in enumerate(ambiguities):
                sources = []
                for source in item.get("fontes") or []:
                    if not isinstance(source, dict):
                        continue
                    label = _export_text(source.get("fonte"))
                    if source.get("quantidade"):
                        label += f" ({source['quantidade']} registros)"
                    elif source.get("serie"):
                        label += f" — série {source['serie']}"
                    sources.append(label)
                note = _export_note(comparison, "ambiguidades", index, item)
                ambiguity_rows.append((
                    timestamp, item.get("tipo") or "Ambiguidade",
                    item.get("chave"), "; ".join(sources), item.get("mensagem"),
                    note,
                ))
            for index, item in enumerate(ambiguous_records, start=len(ambiguities)):
                ambiguous_sources = item.get("fontes") or {}
                source_summary = "; ".join(
                    str(source) for source, status in ambiguous_sources.items()
                    if status == "ambíguo"
                ) if isinstance(ambiguous_sources, dict) else ""
                record_key = f"{item.get('computador') or 'Sem hostname'} · {item.get('serie') or 'Sem série'}"
                notes = [_export_note(comparison, "ambiguidades", index, item)]
                notes.extend(
                    _export_text(annotation_export_text(associated))
                    for associated in item.get("anotacoes_associadas", [])
                    if isinstance(associated, dict)
                )
                note = "\n".join(value for value in notes if value)
                ambiguity_rows.append((
                    timestamp, "Presença ambígua", record_key,
                    source_summary, item.get("motivo"), note,
                ))

        detail_total = sum(category_counts.values())
        workbook = openpyxl.Workbook()
        workbook.properties.title = "Histórico de atualizações de planilhas"
        workbook.properties.subject = "Comparações, registros e anotações do histórico de planilhas"
        workbook.properties.creator = "Simpress"
        generated_at = datetime.now().astimezone().replace(tzinfo=None)
        _write_export_summary_sheet(workbook, generated_at, selected_date, display_events, event_counts, category_counts, detail_total)

        _write_export_table_sheet(
            workbook, "Histórico", "Eventos de planilhas",
            "Uma linha por atualização ou restauração, em ordem cronológica.",
            ["Ordem", "Data e hora", "Operação", "ID do evento", "Arquivo no endpoint", "Arquivo na Simpress",
             "Equipamentos no endpoint", "Equipamentos na Simpress", "Equipamentos carregados", "Apelidos atualizados",
             "Apelidos para conferência", "Divergências manuais pendentes", "Ausentes no endpoint",
             "Ausentes na Simpress", "Sem verificação há 14+ dias", "Divergências de local", "Duplicidades e ambiguidades",
             "Séries sem local", "Restauração de", "Diretório de backup"],
            history_rows, "tblHistoricoPlanilhas",
            [10, 20, 16, 34, 32, 42, 18, 18, 20, 17, 20, 22, 18, 18, 23, 18, 22, 17, 20, 36],
        )
        _write_export_table_sheet(
            workbook, "Apelidos", "Apelidos e hostnames",
            "Atualizações, linhas que precisam de conferência e divergências manuais registradas.",
            ["Data e hora", "Operação", "Categoria", "Série", "Hostname/Apelido",
             "Apelido anterior/manual", "Apelido na Simpress", "Apelido no endpoint/novo", "Horário da alteração",
             "Situação", "Motivo", "Arquivos de origem", "Anotação"],
            alias_rows, "tblHistoricoApelidos",
            [20, 16, 24, 18, 28, 30, 30, 32, 20, 29, 56, 36, 42],
        )
        _write_export_table_sheet(
            workbook, "Ausências", "Equipamentos ausentes por fonte",
            "Registros sem correspondência segura no endpoint ou na Simpress.",
            ["Data e hora", "Categoria", "Ausente em", "Hostname/Apelido", "Série",
             "Local previsto", "Anotação"],
            absence_rows, "tblHistoricoAusencias",
            [20, 24, 22, 32, 18, 28, 42],
        )
        _write_export_table_sheet(
            workbook, "Sem acesso", "Notebooks sem verificação recente",
            "Notebooks cuja última verificação com êxito ocorreu há pelo menos 14 dias.",
            ["Data e hora", "Operação", "Hostname/Apelido", "Série", "Última verificação com êxito",
             "Dias sem verificação", "Linha no endpoint", "Anotação"],
            no_access_rows, "tblHistoricoSemAcesso",
            [20, 16, 32, 20, 26, 20, 16, 42],
        )
        _write_export_table_sheet(
            workbook, "Localidades", "Divergências e séries sem local",
            "Diferenças de localidade e prefixos sem regra cadastrada.",
            ["Data e hora", "Categoria", "Computador", "Série", "Local previsto",
             "Local na Simpress", "Quantidade", "Exemplos", "Anotação"],
            location_rows, "tblHistoricoLocalidades",
            [20, 28, 30, 18, 28, 28, 14, 54, 42],
        )
        _write_export_table_sheet(
            workbook, "Ambiguidades", "Duplicidades e correspondências ambíguas",
            "Presenças ambíguas e correspondências sem identificação única.",
            ["Data e hora", "Ocorrência", "Série ou hostname/Apelido",
             "Fontes", "Tratamento", "Anotação"],
            ambiguity_rows, "tblHistoricoAmbiguidades",
            [20, 27, 48, 34, 66, 42],
        )

        output = BytesIO()
        workbook.save(output)
        output.seek(0)
        filename = f"Historico_Planilhas_{selected_date:%Y%m%d}_{generated_at:%H%M%S}.xlsx"
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
        if services.postgres_files is not None and (files := services.postgres_files()) is not None:
            from persistence.boundary import idempotency_key
            return files.history.mutate("note",{"event":evento_id,"item":item_id,"note":payload.anotacao},idempotency_key.get())
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
            with services.comparison_history_lock:
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
        except HTTPException:
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
        if services.postgres_files is not None and (files := services.postgres_files()) is not None:
            context = files.restore_context(evento_id)
            return {k:v for k,v in context.items() if k not in {"snapshot","revision"}}
        context = _build_comparison_restore_context(evento_id)
        return {
            "evento_id": evento_id,
            "evento_horario": context["evento"].get("horario"),
            "tipo_evento": _comparison_event_type(context["evento"]),
            "arquivos_backup": {
                role: {
                    "nome": item["name"],
                    "registros": item["records"],
                    "tamanho_bytes": item["size"],
                    "modificado_em": item["modified"],
                }
                for role, item in context["backup_files"].items()
            },
            "arquivos_atuais": context["current_files"],
            "preview_token": context["preview_token"],
        }


    @router.post("/api/historico-comparacoes/{evento_id}/restaurar")
    def restaurar_comparacao_historica(evento_id: str, payload: ComparisonRestorePayload):
        if services.postgres_files is not None and (files := services.postgres_files()) is not None:
            from persistence.boundary import idempotency_key
            return files.restore(evento_id,payload.preview_token,idempotency_key.get())
        persistent_backup_dir = None

        try:
            context = _build_comparison_restore_context(evento_id)
            if not hmac.compare_digest(payload.preview_token, context["preview_token"]):
                raise HTTPException(
                    status_code=409,
                    detail="Os arquivos ativos ou o backup mudaram desde a prévia. Atualize a prévia antes de restaurar.",
                )
            if all(
                context["backup_files"][role]["sha256"] == context["current_hashes"][role]
                for role in context["backup_files"]
            ):
                raise HTTPException(status_code=409, detail="Os dois inventários ativos já correspondem ao backup selecionado.")

            restoration_time = datetime.now().astimezone().isoformat(timespec="seconds")
            restoration_id = uuid.uuid4().hex
            persistent_backup_dir = services.upload_backups_directory() / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
            target_files = {
                "endpoint": services.endpoint_upload_path(),
                "detalhes": services.details_upload_path(),
            }
            source_event = context["evento"]
            source_comparison = source_event.get("comparacao") or {}
            source_backup_relative = source_comparison.get("backup_diretorio")
            transaction_targets = [
                *target_files.values(),
                services.comparison_history_path(),
                services.modified_aliases_path(),
            ]

            with services.inventory_state_transaction(transaction_targets) as transaction:
                _, locked_current_hashes = _current_inventory_snapshot()
                if locked_current_hashes != context["current_hashes"]:
                    raise HTTPException(
                        status_code=409,
                        detail="Os inventários ativos mudaram desde a prévia. Atualize a prévia antes de restaurar.",
                    )
                persistent_backup_dir.mkdir(parents=True, exist_ok=False)
                missing_current_files: Dict[str, bool] = {}
                invalid_current_files: Dict[str, bool] = {}
                for role, target_path in target_files.items():
                    role_backup_dir = persistent_backup_dir / role
                    role_backup_dir.mkdir(parents=True, exist_ok=True)
                    expected_current_hash = context["current_hashes"][role]
                    if not target_path.is_file():
                        if expected_current_hash is not None:
                            raise TransactionConflictError(f"'{target_path.name}' mudou durante a restauração.")
                        missing_current_files[role] = True
                        invalid_current_files[role] = False
                        continue
                    if expected_current_hash is None:
                        raise TransactionConflictError(f"'{target_path.name}' mudou durante a restauração.")
                    backup_path = role_backup_dir / target_path.name
                    shutil.copy2(target_path, backup_path)
                    with backup_path.open("r+b") as backup_file:
                        backup_file.flush()
                        os.fsync(backup_file.fileno())
                    if (
                        not filecmp.cmp(target_path, backup_path, shallow=False)
                        or _sha256_file(backup_path) != expected_current_hash
                    ):
                        raise TransactionConflictError(f"A cópia de segurança de '{target_path.name}' não passou na validação.")
                    missing_current_files[role] = False
                    try:
                        services.validate_uploaded_workbook(backup_path.read_bytes(), role)
                        invalid_current_files[role] = False
                    except (HTTPException, WorkbookSafetyError):
                        invalid_current_files[role] = True
                    except Exception:
                        logger.exception(
                            "Falha inesperada ao validar backup durante restauração (evento=%s, fonte=%s).",
                            evento_id,
                            role,
                        )
                        invalid_current_files[role] = True

                _, backed_up_current_hashes = _current_inventory_snapshot()
                if backed_up_current_hashes != context["current_hashes"]:
                    raise TransactionConflictError("Um inventário ativo mudou durante a cópia de segurança.")

                for role, target_path in target_files.items():
                    backup_bytes = context["backup_files"][role]["bytes"]

                    def validate_staged_backup(path: Path, current_role=role, expected_bytes=backup_bytes):
                        candidate_bytes = path.read_bytes()
                        if candidate_bytes != expected_bytes:
                            raise WorkbookSafetyError("O arquivo preparado difere do backup validado.")
                        services.validate_uploaded_workbook(candidate_bytes, current_role)

                    transaction.stage_bytes(target_path, backup_bytes, validate_staged_backup)

                transaction.apply()
                prepared_state = services.load_database(
                    transaction_locked=True,
                    publish=False,
                )
                if not isinstance(prepared_state, dict):
                    raise RuntimeError("O conjunto restaurado não pôde ser carregado pelo site.")

                restored_files = {role: path.name for role, path in target_files.items()}
                restoration_comparison = {
                    "evento_id": restoration_id,
                    "tipo_operacao": "restauracao",
                    "horario_comparacao": restoration_time,
                    "restauracao_de": {
                        "evento_id": evento_id,
                        "horario": source_event.get("horario"),
                        "tipo": _comparison_event_type(source_event),
                    },
                    "arquivos_restaurados": restored_files,
                    "total_endpoint_restaurado": context["backup_files"]["endpoint"]["records"],
                    "total_detalhes_restaurado": context["backup_files"]["detalhes"]["records"],
                    "total_equipamentos_carregados": prepared_state["stats_cache"].get("total_equipamentos", 0),
                    "backup_diretorio": str(persistent_backup_dir.relative_to(services.input_directory())),
                    "backup_arquivos_ausentes": missing_current_files,
                    "backup_arquivos_invalidos": invalid_current_files,
                    "historico_salvo": True,
                }
                restoration_event = {
                    "id": restoration_id,
                    "tipo": "restauracao",
                    "horario": restoration_time,
                    "arquivos_restaurados": restored_files,
                    "restauracao_de": restoration_comparison["restauracao_de"],
                    "resumo": {
                        "restauracao": True,
                        "total_endpoint_restaurado": restoration_comparison["total_endpoint_restaurado"],
                        "total_detalhes_restaurado": restoration_comparison["total_detalhes_restaurado"],
                    },
                    "comparacao": restoration_comparison,
                }

                def append_restoration(history):
                    if not isinstance(history, list):
                        raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
                    current_source_event = next(
                        (item for item in history if isinstance(item, dict) and item.get("id") == evento_id),
                        None,
                    )
                    current_source_comparison = (
                        current_source_event.get("comparacao")
                        if isinstance(current_source_event, dict) else None
                    )
                    if (
                        not isinstance(current_source_event, dict)
                        or not isinstance(current_source_comparison, dict)
                        or current_source_comparison.get("backup_diretorio") != source_backup_relative
                        or current_source_event.get("horario") != source_event.get("horario")
                    ):
                        raise HTTPException(
                            status_code=409,
                            detail="A atualização selecionada mudou ou foi removida do histórico. A restauração foi cancelada.",
                        )
                    updated = deepcopy(history)
                    updated.append(restoration_event)
                    return updated

                transaction.update_json(services.comparison_history_path(), append_restoration, [])
                transaction.commit()
                services.publish_database_state(prepared_state)

            return {
                "sucesso": True,
                "evento": {
                    "id": restoration_id,
                    "tipo": "restauracao",
                    "horario": restoration_time,
                    "restauracao_de": restoration_comparison["restauracao_de"],
                    "arquivos_restaurados": restored_files,
                    "desfazer_disponivel": not any(missing_current_files.values()) and not any(invalid_current_files.values()),
                    "total_endpoint_restaurado": restoration_comparison["total_endpoint_restaurado"],
                    "total_detalhes_restaurado": restoration_comparison["total_detalhes_restaurado"],
                    "total_equipamentos_carregados": restoration_comparison["total_equipamentos_carregados"],
                },
            }
        except HTTPException:
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
        if services.postgres_files is not None and (files := services.postgres_files()) is not None:
            from persistence.boundary import idempotency_key
            return files.history.mutate("resolve",{"event":evento_id,"serial":serial,"action":payload.acao},idempotency_key.get())
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
        if services.postgres_files is not None and (files := services.postgres_files()) is not None:
            from persistence.boundary import idempotency_key
            return files.history.mutate("delete",{"event":evento_id},idempotency_key.get())
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
            with services.comparison_history_lock:
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
        except HTTPException:
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

    return router, {
        '_build_comparison_restore_context': _build_comparison_restore_context,
        '_comparison_event_has_restorable_backup': _comparison_event_has_restorable_backup,
        '_comparison_event_type': _comparison_event_type,
        '_comparison_restore_backup_paths': _comparison_restore_backup_paths,
        '_current_inventory_snapshot': _current_inventory_snapshot,
        '_sha256_file': _sha256_file,
        '_validated_comparison_backup_files': _validated_comparison_backup_files,
        'flush_pending_history_annotations': flush_pending_history_annotations,
        'migrate_legacy_history_annotations': migrate_legacy_history_annotations,
        'history_annotation_view': history_annotation_view,
        'excluir_comparacao_historica': excluir_comparacao_historica,
        'exportar_historico_comparacoes_excel': exportar_historico_comparacoes_excel,
        'get_comparacao_historica': get_comparacao_historica,
        'get_historico_comparacoes': get_historico_comparacoes,
        'salvar_anotacao_comparacao': salvar_anotacao_comparacao_historica,
        'salvar_anotacao_comparacao_historica': salvar_anotacao_comparacao_historica,
        'resolver_divergencia_apelido_manual': resolver_divergencia_apelido_manual,
        'restaurar_comparacao_historica': restaurar_comparacao_historica,
        'visualizar_restauracao_comparacao': visualizar_restauracao_comparacao,
    }
