"""Transactional workflow for replacing and comparing inventory snapshots."""

import asyncio
import filecmp
import logging
import re
import shutil
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException
from integrity import (
    FileBusyError,
    FileTransactionError,
    TransactionConflictError,
    WorkbookSafetyError,
)

from domains.history_annotations import history_annotation_row_fingerprint
from domains.local_setup import unpack_simpress_zip


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class InventoryUpdateServices:
    """Explicit application services used by the inventory upload workflow."""

    max_upload_bytes: Callable[[], int]
    workbook_parse_admission: Callable[[], Any]
    validate_uploaded_workbook: Callable[[bytes, str], Dict[str, Any]]
    input_directory: Callable[[], Path]
    endpoint_upload_file: Callable[[], Path]
    details_upload_file: Callable[[], Path]
    comparison_history_file: Callable[[], Path]
    upload_backups_directory: Callable[[], Path]
    history_annotations_directory: Callable[[], Path]
    get_primary_equipment_file: Callable[[], Optional[Path]]
    compare_uploaded_workbooks: Callable[..., Dict[str, Any]]
    inventory_state_transaction: Callable[..., Any]
    get_equipment_snapshot: Callable[[], Dict[str, Dict[str, Any]]]
    snapshot_equipment_aliases: Callable[
        [Dict[str, Dict[str, Any]]], Dict[str, Dict[str, str]]
    ]
    load_modified_apelidos: Callable[[], Dict[str, str]]
    manual_alias_source_snapshots: Callable[..., List[Dict[str, Any]]]
    normalize_reference_value: Callable[[Any], str]
    upload_serial_value: Callable[[Dict[str, Any], str], Any]
    upload_alias_value: Callable[[Dict[str, Any], str], Any]
    load_database: Callable[..., Any]
    read_endpoint_alias_index: Callable[[], Dict[str, Any]]
    compare_equipment_aliases: Callable[
        [Dict[str, Dict[str, str]], Dict[str, Dict[str, str]]], List[Dict[str, Any]]
    ]
    endpoint_alias_review_items: Callable[..., List[Dict[str, Any]]]
    publish_database_state: Callable[[Dict[str, Any]], None]
    comparison_history_for_display: Callable[[Dict[str, Any]], Dict[str, Any]]
    load_history_annotations: Callable[[Path], List[Dict[str, Any]]]
    comparison_annotation_item_id: Callable[..., str]
    save_history_annotation: Callable[..., Dict[str, Any]]


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


def _legacy_annotation(comparison: Dict[str, Any], category: str, index: int) -> Any:
    annotations = comparison.get("anotacoes")
    if not isinstance(annotations, dict):
        return None
    legacy_category = (
        "ambiguidades"
        if category in ("correspondencias_ambiguas", "registros_ambiguos")
        else category
    )
    legacy_index = index
    if category == "registros_ambiguos":
        ambiguity_items = comparison.get("correspondencias_ambiguas")
        if isinstance(ambiguity_items, list):
            legacy_index += len(ambiguity_items)
    return annotations.get(f"{legacy_category}:{legacy_index}")


def _copy_matching_history_annotations(
    services: InventoryUpdateServices,
    previous_history: Any,
    new_event: Dict[str, Any],
) -> list[Dict[str, str]]:
    """Copy notes from the latest exactly matching prior rows into one new event."""
    if not isinstance(previous_history, list):
        return []
    new_comparison = new_event.get("comparacao")
    if not isinstance(new_comparison, dict):
        return []

    shared_annotations_by_timestamp: Dict[
        tuple[str, str], tuple[str, Dict[str, Any]]
    ] = {}
    for record in services.load_history_annotations(services.history_annotations_directory()):
        event_id = str(record.get("evento_id") or "")
        item_id = str(record.get("item_id") or "")
        if not event_id or not item_id:
            continue
        key = (event_id, item_id)
        candidate = (str(record.get("atualizado_em") or ""), record)
        if (
            key not in shared_annotations_by_timestamp
            or candidate[0] >= shared_annotations_by_timestamp[key][0]
        ):
            shared_annotations_by_timestamp[key] = candidate
    shared_annotations: Dict[tuple[str, str], Dict[str, Any]] = {
        key: value[1] for key, value in shared_annotations_by_timestamp.items()
    }

    new_fingerprints = set()
    for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
        items = new_comparison.get(category)
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict):
                new_fingerprints.add(history_annotation_row_fingerprint(category, item))
    if not new_fingerprints:
        return []

    latest_prior_notes: Dict[str, Any] = {}
    for previous_event in reversed(previous_history):
        if not isinstance(previous_event, dict):
            continue
        previous_comparison = previous_event.get("comparacao")
        if not isinstance(previous_comparison, dict):
            continue
        event_id = str(previous_event.get("id") or previous_comparison.get("evento_id") or "")
        event_matches: Dict[str, list[Any]] = {}
        for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
            items = previous_comparison.get(category)
            if not isinstance(items, list):
                continue
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                fingerprint = history_annotation_row_fingerprint(category, item)
                if fingerprint not in new_fingerprints or fingerprint in latest_prior_notes:
                    continue
                annotation = item.get("anotacao")
                if not isinstance(annotation, str):
                    annotation = _legacy_annotation(previous_comparison, category, index)
                if not isinstance(annotation, str) and event_id:
                    item_id = services.comparison_annotation_item_id(event_id, category, index, item)
                    shared_record = shared_annotations.get((event_id, item_id))
                    if isinstance(shared_record, dict):
                        annotation = shared_record.get("anotacao")
                event_matches.setdefault(fingerprint, []).append(annotation)

        for fingerprint, annotations in event_matches.items():
            first_annotation = annotations[0] if annotations else None
            if isinstance(first_annotation, str) and all(
                annotation == first_annotation for annotation in annotations
            ):
                latest_prior_notes[fingerprint] = first_annotation
            else:
                # A newer matching row without a note, or conflicting duplicate
                # rows, prevents an older annotation from being resurrected.
                latest_prior_notes[fingerprint] = None

    local_event_ids = set()
    for event in previous_history:
        if not isinstance(event, dict):
            continue
        comparison = event.get("comparacao")
        event_id = str(
            event.get("id")
            or (comparison.get("evento_id") if isinstance(comparison, dict) else "")
            or ""
        )
        if event_id:
            local_event_ids.add(event_id)
    shared_only_events: Dict[tuple[str, str], list[Dict[str, Any]]] = {}
    for record in shared_annotations.values():
        if not isinstance(record, dict):
            continue
        event_id = str(record.get("evento_id") or "")
        fingerprint = str(record.get("linha_hash") or "")
        if (
            not event_id
            or event_id in local_event_ids
            or fingerprint not in new_fingerprints
        ):
            continue
        shared_only_events.setdefault((event_id, fingerprint), []).append(record)

    ordered_shared_events = sorted(
        shared_only_events.items(),
        key=lambda entry: max(
            (
                str(record.get("horario") or ""),
                str(record.get("atualizado_em") or ""),
            )
            for record in entry[1]
        ),
        reverse=True,
    )
    for (_, fingerprint), records in ordered_shared_events:
        if fingerprint in latest_prior_notes:
            continue
        annotations = [record.get("anotacao") for record in records]
        first_annotation = annotations[0] if annotations else None
        if isinstance(first_annotation, str) and all(
            annotation == first_annotation for annotation in annotations
        ):
            latest_prior_notes[fingerprint] = first_annotation
        else:
            latest_prior_notes[fingerprint] = None

    copied: list[Dict[str, str]] = []
    new_event_id = str(new_event.get("id") or "")
    if not new_event_id:
        return copied
    for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
        items = new_comparison.get(category)
        if not isinstance(items, list):
            continue
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            fingerprint = history_annotation_row_fingerprint(category, item)
            annotation = latest_prior_notes.get(fingerprint)
            if not isinstance(annotation, str) or not annotation:
                continue
            identity_item = {
                key: value
                for key, value in item.items()
                if key not in {"anotacao", "anotacao_id"}
            }
            item_id = services.comparison_annotation_item_id(
                new_event_id, category, index, identity_item
            )
            item["anotacao_id"] = item_id
            item["anotacao"] = annotation
            copied.append({
                "item_id": item_id,
                "serie": str(item.get("serie") or ""),
                "computador": str(item.get("computador") or item.get("chave") or ""),
                "motivo": str(item.get("motivo") or item.get("mensagem") or item.get("tipo") or ""),
                "categoria": category,
                "anotacao": annotation,
                "linha_hash": fingerprint,
            })
    return copied


async def read_uploaded_xlsx(
    upload: Any,
    role: str,
    services: InventoryUpdateServices,
) -> Dict[str, Any]:
    """Validate one uploaded workbook and retain its safe display name and bytes."""
    display_role = {
        "endpoint": "Endpoint",
        "detalhes": "Simpress",
    }.get(role, role)
    original_name = re.split(r"[/\\]", str(upload.filename or ""))[-1]
    suffix = Path(original_name).suffix.lower()
    allowed_suffixes = {".xlsx", ".zip"} if role == "detalhes" else {".xlsx"}
    if not original_name or suffix not in allowed_suffixes:
        formats = ".xlsx ou .zip" if role == "detalhes" else ".xlsx"
        raise HTTPException(status_code=400, detail=f"Selecione um arquivo {formats} válido para {display_role}.")

    max_upload_bytes = services.max_upload_bytes()
    file_bytes = await upload.read(max_upload_bytes + 1)
    if not file_bytes:
        raise HTTPException(status_code=400, detail=f"O arquivo de {display_role} está vazio.")
    if len(file_bytes) > max_upload_bytes:
        raise HTTPException(status_code=413, detail=f"O arquivo de {display_role} excede o limite de 30 MB.")

    parse_admission = services.workbook_parse_admission()
    if parse_admission is not None and not parse_admission.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="A análise de planilhas está ocupada. Tente novamente em instantes.")
    def parse():
        workbook_bytes = file_bytes
        if suffix == ".zip":
            workbook_bytes, _ = unpack_simpress_zip(file_bytes, max_upload_bytes)
        return workbook_bytes, services.validate_uploaded_workbook(workbook_bytes, role)

    worker = asyncio.create_task(asyncio.to_thread(parse))
    try:
        file_bytes, table = await asyncio.shield(worker)
    except asyncio.CancelledError:
        try:
            await asyncio.shield(worker)
        except Exception:
            logger.exception("Falha na validação de inventário após cancelamento.")
        raise
    finally:
        if parse_admission is not None:
            parse_admission.release()
    return {"name": original_name, "bytes": file_bytes, "table": table}

async def update_inventory_files(
    endpoint_file: Any,
    details_file: Any,
    services: InventoryUpdateServices,
    automatic_import_id: Optional[str] = None,
):
    """Read uploads asynchronously and run workbook and transaction work off-loop."""
    uploads = [endpoint_file, details_file]

    try:
        staged = {
            "endpoint": await read_uploaded_xlsx(endpoint_file, "endpoint", services),
            "detalhes": await read_uploaded_xlsx(details_file, "detalhes", services),
        }

        worker = asyncio.create_task(
            asyncio.to_thread(_commit_inventory_files, staged, services, automatic_import_id)
        )
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            # Once the transaction starts, let it finish or roll back before releasing request resources.
            try:
                await asyncio.shield(worker)
            except Exception:
                logger.exception("Falha na atualização em segundo plano após cancelamento da solicitação.")
            raise
    except HTTPException:
        raise
    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except TransactionConflictError as error:
        raise HTTPException(status_code=500, detail=f"A recuperação detectou uma alteração externa em um arquivo e parou sem sobrescrevê-lo: {error}") from error
    except (FileTransactionError, WorkbookSafetyError) as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível concluir a atualização; a transação restaurou os arquivos anteriores. {error}") from error
    except Exception:
        logger.exception("Falha inesperada ao atualizar o conjunto de planilhas.")
        raise HTTPException(status_code=500, detail="Falha ao atualizar as planilhas; os arquivos anteriores foram restaurados.") from None
    finally:
        for upload in uploads:
            await upload.close()


def _commit_inventory_files(
    staged: Dict[str, Any],
    services: InventoryUpdateServices,
    automatic_import_id: Optional[str] = None,
):
    """Validate, compare, replace, reload, and journal inventories in a worker thread."""
    input_directory = services.input_directory()
    endpoint_upload_file = services.endpoint_upload_file()
    details_upload_file = services.details_upload_file()
    comparison_history_file = services.comparison_history_file()
    upload_backups_directory = services.upload_backups_directory()
    history_annotations_directory = services.history_annotations_directory()
    input_directory.mkdir(parents=True, exist_ok=True)
    active_details_file = services.get_primary_equipment_file()
    target_files = {
        "endpoint": endpoint_upload_file,
        "detalhes": details_upload_file,
    }
    backup_sources = {
        "endpoint": target_files["endpoint"] if target_files["endpoint"].is_file() else None,
        "detalhes": active_details_file,
    }

    uploaded_names = {
        "endpoint": staged["endpoint"]["name"],
        "detalhes": staged["detalhes"]["name"],
    }
    comparison_time = datetime.now().astimezone()
    comparison = services.compare_uploaded_workbooks(
        staged["endpoint"]["table"],
        staged["detalhes"]["table"],
        uploaded_names,
        as_of=comparison_time,
    )

    transaction_targets = [
        *target_files.values(),
        *(path for path in backup_sources.values() if path is not None),
        comparison_history_file,
    ]
    with services.inventory_state_transaction(transaction_targets) as transaction:
        previous_aliases = services.snapshot_equipment_aliases(services.get_equipment_snapshot())
        manual_overrides = services.load_modified_apelidos()
        manual_alias_sources = services.manual_alias_source_snapshots(
            manual_overrides,
            staged["endpoint"]["table"],
            staged["detalhes"]["table"],
        )
        manual_divergences = [
            item for item in manual_alias_sources
            if item["diverge_detalhes"] or item["diverge_invall"]
        ]
        backup_dir = upload_backups_directory / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
        backup_dir.mkdir(parents=True, exist_ok=False)

        missing_backup_files = {}
        invalid_backup_files = {"endpoint": False, "detalhes": False}
        for role, target_path in target_files.items():
            role_dir = backup_dir / role
            role_dir.mkdir(parents=True, exist_ok=True)
            source_path = backup_sources[role]
            if source_path is None or not source_path.is_file():
                missing_backup_files[role] = True
                continue
            missing_backup_files[role] = False
            backup_path = role_dir / target_path.name
            shutil.copy2(source_path, backup_path)
            if not filecmp.cmp(source_path, backup_path, shallow=False):
                raise RuntimeError(f"A cópia de segurança de '{target_path.name}' não passou na validação.")

        for role, target_path in target_files.items():
            upload_bytes = staged[role]["bytes"]

            def validate_staged_upload(path: Path, current_role=role, expected_bytes=upload_bytes) -> None:
                candidate_bytes = path.read_bytes()
                if candidate_bytes != expected_bytes:
                    raise WorkbookSafetyError("O arquivo preparado difere do inventário validado.")
                services.validate_uploaded_workbook(candidate_bytes, current_role)

            transaction.stage_bytes(target_path, upload_bytes, validate_staged_upload)

        transaction.apply()
        prepared_state = services.load_database(transaction_locked=True, publish=False)
        if not isinstance(prepared_state, dict):
            raise RuntimeError("As planilhas enviadas não puderam ser carregadas pelo site.")

        endpoint_index = services.read_endpoint_alias_index()
        detail_serial_counts: Dict[str, int] = {}
        for record in staged["detalhes"]["table"].get("records", []):
            serial_key = services.normalize_reference_value(services.upload_serial_value(record, "detalhes"))
            if serial_key:
                detail_serial_counts[serial_key] = detail_serial_counts.get(serial_key, 0) + 1
        detail_serials = set(detail_serial_counts)
        detail_duplicates = {
            serial_key for serial_key, count in detail_serial_counts.items() if count > 1
        }
        comparison["horario_comparacao"] = comparison_time.isoformat(timespec="seconds")
        comparison["apelidos_atualizados"] = services.compare_equipment_aliases(
            previous_aliases,
            services.snapshot_equipment_aliases(prepared_state["equipamentos_cache"]),
        )
        for change in comparison["apelidos_atualizados"]:
            change["arquivos_origem"] = dict(uploaded_names)
            change["horario"] = comparison["horario_comparacao"]
        comparison["apelidos_sem_atualizacao"] = services.endpoint_alias_review_items(
            endpoint_index, detail_serials, detail_duplicates
        )
        for record in staged["detalhes"]["table"].get("records", []):
            alias_without_serial = services.upload_alias_value(record, "detalhes")
            if alias_without_serial and not services.normalize_reference_value(
                services.upload_serial_value(record, "detalhes")
            ):
                comparison["apelidos_sem_atualizacao"].append({
                    "serie": "",
                    "computador": alias_without_serial,
                    "motivo": "Número de série vazio na Simpress; nenhum hostname foi associado.",
                })
        comparison["divergencias_apelidos_manuais"] = manual_divergences
        comparison["fontes_apelidos_manuais"] = manual_alias_sources
        comparison["backup_diretorio"] = str(backup_dir.relative_to(input_directory))
        comparison["backup_arquivos_ausentes"] = missing_backup_files
        comparison["backup_arquivos_invalidos"] = invalid_backup_files
        comparison["total_equipamentos_carregados"] = prepared_state["stats_cache"].get("total_equipamentos", 0)
        comparison["ultima_atualizacao"] = prepared_state["stats_cache"].get("ultima_atualizacao", "")
        comparison["arquivos_enviados"] = uploaded_names
        comparison["historico_salvo"] = True
        event_id = uuid.uuid4().hex
        comparison["evento_id"] = event_id
        summary = {
            "total_endpoint": comparison.get("total_endpoint", 0),
            "ausentes_no_endpoint": len(comparison.get("ausentes_no_endpoint", [])),
            "ausentes_em_detalhes": len(comparison.get("ausentes_em_detalhes", [])),
            "sem_acesso_14_dias": len(comparison.get("sem_acesso_14_dias", [])),
            "divergencias_local": len(comparison.get("divergencias_local", [])),
            "correspondencias_ambiguas": len(comparison.get("correspondencias_ambiguas", [])),
            "series_sem_mapeamento": len(comparison.get("series_sem_mapeamento", [])),
            "apelidos_atualizados": len(comparison.get("apelidos_atualizados", [])),
            "apelidos_sem_atualizacao": len(comparison.get("apelidos_sem_atualizacao", [])),
            "divergencias_apelidos_manuais": len(manual_divergences),
        }
        history_entry = {
            "id": event_id,
            "horario": comparison["horario_comparacao"],
            "arquivos_enviados": uploaded_names,
            "resumo": summary,
            "comparacao": comparison,
        }
        if automatic_import_id:
            history_entry["importacao_automatica_id"] = str(automatic_import_id)
        copied_annotations: list[Dict[str, str]] = []

        def append_update(history):
            if not isinstance(history, list):
                raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
            updated = deepcopy(history)
            refreshed_serials = {
                services.normalize_reference_value(item.get("serie"))
                for item in manual_alias_sources
                if item.get("detalhes_encontrado") or item.get("invall_encontrado")
            }
            for previous_event in updated:
                if not isinstance(previous_event, dict):
                    continue
                previous_comparison = previous_event.get("comparacao")
                previous_divergences = (
                    previous_comparison.get("divergencias_apelidos_manuais")
                    if isinstance(previous_comparison, dict) else None
                )
                for previous_divergence in previous_divergences or []:
                    if (
                        isinstance(previous_divergence, dict)
                        and previous_divergence.get("resolucao", "pendente") == "pendente"
                        and services.normalize_reference_value(previous_divergence.get("serie")) in refreshed_serials
                    ):
                        previous_divergence["resolucao"] = "substituida"
                        previous_divergence["horario_resolucao"] = comparison["horario_comparacao"]
            copied_annotations[:] = _copy_matching_history_annotations(services, updated, history_entry)
            updated.append(history_entry)
            return updated

        transaction.update_json(comparison_history_file, append_update, [])
        transaction.commit()
        for copied_annotation in copied_annotations:
            try:
                services.save_history_annotation(
                    history_annotations_directory,
                    event_id=event_id,
                    event_time=history_entry["horario"],
                    item_id=copied_annotation["item_id"],
                    serie=copied_annotation["serie"],
                    computador=copied_annotation["computador"],
                    motivo=copied_annotation["motivo"],
                    anotacao=copied_annotation["anotacao"],
                    categoria=copied_annotation["categoria"],
                    linha_hash=copied_annotation["linha_hash"],
                )
            except Exception:
                # The annotation is already in local history and will be retried
                # into shared storage when that event is next opened.
                logger.exception(
                    "Anotação copiada permaneceu no histórico local; sincronização pendente "
                    "(evento=%s, item=%s).",
                    event_id,
                    copied_annotation["item_id"],
                )
                continue
        services.publish_database_state(prepared_state)

    historical_view = services.comparison_history_for_display(history_entry)
    historical_comparison = dict(historical_view.get("comparacao") or {})
    historical_comparison["evento_id"] = event_id
    historical_comparison["historico_salvo"] = True
    return {
        "sucesso": True,
        "comparacao": historical_comparison,
        "stats": prepared_state["stats_cache"],
        "historico_salvo": True,
    }
