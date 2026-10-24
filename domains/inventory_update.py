"""Transactional workflow for replacing and comparing inventory snapshots."""

import asyncio
import hashlib
import json
import logging
import re
import shutil
import uuid
from copy import deepcopy
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple, Type

from core.errors import DomainBusyError, DomainConflictError, DomainError, DomainValidationError
from core.integrity import (
    FileBusyError,
    FileTransactionError,
    TransactionConflictError,
    WorkbookSafetyError,
    lock_paths,
)
from core.async_workers import await_worker_completion
from core.config import format_size_limit
from core.inventory_requests import IDEMPOTENCY_KEY_ERROR, IDEMPOTENCY_KEY_PATTERN

from domains.history_annotations import (
    effective_history_annotation, history_annotation_row_fingerprint,
    load_effective_history_annotations, same_annotation_revision,
)
from domains.effective_alias import (
    apply_effective_alias,
    build_endpoint_alias_index,
    endpoint_loss_warnings,
    endpoint_user_for_serial,
    with_details_serials,
)
from domains.local_setup import unpack_simpress_zip
from domains.user_holds import hold_change_rows, holds_file, plan_holds, read_holds
from domains.user_changes import (
    archived_manual_users,
    build_archived_manual_user_entries,
    build_endpoint_warning_entries,
    logged_user_changes,
    manual_user_dates_by_serial,
    manual_users_by_serial,
    manual_users_overridden_by_endpoint,
    read_manual_user_dates,
    read_manual_users,
    without_manual_users,
)


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
    inventory_idempotency_file: Callable[[], Path]
    upload_backups_directory: Callable[[], Path]
    history_annotations_directory: Callable[[], Path]
    local_annotation_outbox_directory: Callable[[], Path]
    build_history_annotation_record: Callable[..., Dict[str, Any]]
    history_annotation_record_path: Callable[..., Path]
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
    load_history_annotations: Callable[..., List[Dict[str, Any]]]
    comparison_annotation_item_id: Callable[..., str]
    inventory_update_preview_summary: Callable[..., Dict[str, Any]]
    create_inventory_preview_token: Callable[..., str]
    verify_inventory_preview_token: Callable[..., bool]
    # Errors raised by the application callbacks above (e.g. the HTTP layer's own
    # exceptions) that must reach the caller unchanged instead of becoming a 500.
    external_errors: Tuple[Type[BaseException], ...] = ()
    # Where warnings about Endpoint users/hostnames that vanished are recorded; None disables them.
    alias_history_file: Optional[Callable[[], Path]] = None
    # Normalized (serial, hostname) pairs discarded from the Endpoint duplicates; None keeps every row.
    removed_endpoint_hostnames: Optional[Callable[[], Any]] = None
    # Manual users file; with alias_history_file, manual users hidden by an Endpoint user are archived.
    manual_users_file: Optional[Callable[[], Path]] = None
    # The imported export model is a layout reference; paired inventory imports update its aliases.
    export_model_file: Optional[Callable[[], Path]] = None
    prepare_export_model_sync: Optional[
        Callable[[List[Dict[str, Any]], Dict[str, Any]], Optional[bytes]]
    ] = None
    validate_export_model_sync: Optional[Callable[[bytes], Any]] = None


_ANNOTATABLE_COMPARISON_CATEGORIES = (
    "apelidos_sem_atualizacao",
    "sem_acesso_7_dias",
    "ausentes_no_endpoint",
    "ausentes_em_detalhes",
    "divergencias_local",
    "correspondencias_ambiguas",
    "registros_ambiguos",
    "series_sem_mapeamento",
    "mudancas_usuarios",
)

# Keep the most recent confirmed writes. Once an entry is evicted, a retry is
# treated as a new operation; the bounded receipt file cannot grow indefinitely.
MAX_INVENTORY_IDEMPOTENCY_RECEIPTS = 256


def _inventory_request_sha256(staged: Dict[str, Any]) -> str:
    """Hash committed workbook bytes with explicit source-role framing."""
    digest = hashlib.sha256()
    for role in ("endpoint", "detalhes"):
        role_bytes = role.encode("ascii")
        workbook_bytes = staged[role]["bytes"]
        digest.update(len(role_bytes).to_bytes(2, "big"))
        digest.update(role_bytes)
        digest.update(len(workbook_bytes).to_bytes(8, "big"))
        digest.update(workbook_bytes)
    return digest.hexdigest()


def _validated_inventory_idempotency_store(value: Any) -> Dict[str, Any]:
    if (
        not isinstance(value, dict)
        or type(value.get("version")) is not int
        or value.get("version") != 1
        or not isinstance(value.get("records"), list)
    ):
        raise RuntimeError("O registro local de idempotência está inválido; o arquivo foi preservado.")
    seen_keys = set()
    for record in value["records"]:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get("key"), str)
            or not IDEMPOTENCY_KEY_PATTERN.fullmatch(record["key"])
            or record["key"] in seen_keys
            or not isinstance(record.get("request_sha256"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", record["request_sha256"])
            or not isinstance(record.get("result"), dict)
        ):
            raise RuntimeError("O registro local de idempotência está inválido; o arquivo foi preservado.")
        seen_keys.add(record["key"])
    if len(value["records"]) > MAX_INVENTORY_IDEMPOTENCY_RECEIPTS:
        raise RuntimeError("O registro local de idempotência excede a retenção permitida; o arquivo foi preservado.")
    return value


def _append_inventory_idempotency_receipt(
    value: Any,
    key: str,
    request_sha256: str,
    result: Dict[str, Any],
) -> Dict[str, Any]:
    store = _validated_inventory_idempotency_store(
        value if value is not None else {"version": 1, "records": []}
    )
    records = [record for record in store["records"] if record["key"] != key]
    records.append({"key": key, "request_sha256": request_sha256, "result": result})
    return {"version": 1, "records": records[-MAX_INVENTORY_IDEMPOTENCY_RECEIPTS:]}


def _find_inventory_idempotency_receipt(value: Any, key: str) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    store = _validated_inventory_idempotency_store(value)
    return next((record for record in store["records"] if record["key"] == key), None)


@contextmanager
def _transaction_with_backup_cleanup(
    transaction_context: Any,
    backup_directory: Path,
    backup_targets: Dict[str, Path],
) -> Iterator[Any]:
    """Remove only this attempt's empty backup tree when its transaction fails."""
    try:
        with transaction_context as transaction:
            yield transaction
    except BaseException:
        if backup_directory.exists() and not any(path.is_file() for path in backup_targets.values()):
            shutil.rmtree(backup_directory, ignore_errors=True)
        raise


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

    effective_annotations = load_effective_history_annotations(
        services.history_annotations_directory(),
        services.local_annotation_outbox_directory(),
        services.load_history_annotations,
        # An unreadable revision must abort (409) rather than skip an existing note.
        strict=True,
    )

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
                item_id = services.comparison_annotation_item_id(event_id, category, index, item)
                observed = effective_history_annotation(
                    effective_annotations, event_id, item_id,
                    item.get("anotacao"), _legacy_annotation(previous_comparison, category, index),
                )
                annotation = None if observed.get("anotacao_conflito") else observed["anotacao"]
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
    for record in effective_annotations.values():
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
        annotations = [
            None if record.get("anotacao_conflito") else record.get("anotacao")
            for record in records
        ]
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
        raise DomainValidationError(f"Selecione um arquivo {formats} válido para {display_role}.")

    max_upload_bytes = services.max_upload_bytes()
    file_bytes = await upload.read(max_upload_bytes + 1)
    if not file_bytes:
        raise DomainValidationError(f"O arquivo de {display_role} está vazio.")
    if len(file_bytes) > max_upload_bytes:
        raise DomainValidationError(f"O arquivo de {display_role} excede o limite de {format_size_limit(max_upload_bytes)}.", status_code=413)

    parse_admission = services.workbook_parse_admission()
    if parse_admission is not None and not parse_admission.acquire(blocking=False):
        raise DomainBusyError("A análise de planilhas está ocupada. Tente novamente em instantes.")
    def parse() -> Tuple[bytes, Dict[str, Any]]:
        workbook_bytes = file_bytes
        if suffix == ".zip":
            workbook_bytes, _ = unpack_simpress_zip(file_bytes, max_upload_bytes)
        return workbook_bytes, services.validate_uploaded_workbook(workbook_bytes, role)

    worker = asyncio.create_task(asyncio.to_thread(parse))
    try:
        file_bytes, table = await await_worker_completion(
            worker,
            on_cancelled_failure=lambda error: logger.error(
                "Falha na validação de inventário após cancelamento.",
                exc_info=(type(error), error, error.__traceback__),
            ),
        )
    finally:
        if parse_admission is not None:
            parse_admission.release()
    return {"name": original_name, "bytes": file_bytes, "table": table}

async def preview_inventory_files(
    endpoint_file: Any, details_file: Any, services: InventoryUpdateServices,
) -> Dict[str, Any]:
    """Validate uploads and summarize a locked snapshot, including first access."""
    uploads = [endpoint_file, details_file]
    try:
        staged = {
            "endpoint": await read_uploaded_xlsx(endpoint_file, "endpoint", services),
            "detalhes": await read_uploaded_xlsx(details_file, "detalhes", services),
        }
        def read_current_snapshot() -> Dict[str, bytes]:
            # Resolving the active source opens workbooks; keep it off the event loop.
            target_files = {
                "endpoint": services.endpoint_upload_file(),
                "detalhes": services.get_primary_equipment_file() or services.details_upload_file(),
            }
            with lock_paths(target_files.values()):
                return {
                    role: path.read_bytes() if path.is_file() else b""
                    for role, path in target_files.items()
                }

        snapshot_worker = asyncio.create_task(asyncio.to_thread(read_current_snapshot))
        current_bytes = await await_worker_completion(snapshot_worker)

        def validate_current() -> Dict[str, Dict[str, Any]]:
            with services.workbook_parse_admission():
                return {
                    role: services.validate_uploaded_workbook(data, role) if data else {"records": []}
                    for role, data in current_bytes.items()
                }

        try:
            current_tables = await asyncio.to_thread(validate_current)
        except DomainError as error:
            raise DomainConflictError(
                detail="A base ativa não pôde ser validada; a prévia foi cancelada.",
            ) from error
        changes = await asyncio.to_thread(
            services.inventory_update_preview_summary,
            current_tables,
            {role: staged[role]["table"] for role in ("endpoint", "detalhes")},
        )
        return {
            "arquivos": {
                role: {"nome": staged[role]["name"], "linhas": len(staged[role]["table"].get("records", []))}
                for role in ("endpoint", "detalhes")
            },
            "alteracoes": changes,
            "preview_token": services.create_inventory_preview_token(staged, current_bytes),
        }
    except FileBusyError as error:
        raise DomainConflictError(str(error)) from error
    except (WorkbookSafetyError, FileTransactionError) as error:
        raise DomainValidationError(f"Não foi possível gerar a prévia com segurança. {error}") from error
    finally:
        for upload in uploads:
            await upload.close()


async def update_inventory_files(
    endpoint_file: Any,
    details_file: Any,
    services: InventoryUpdateServices,
    automatic_import_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    preview_token: Optional[str] = None,
) -> Dict[str, Any]:
    """Read uploads asynchronously and run workbook and transaction work off-loop."""
    uploads = [endpoint_file, details_file]
    passthrough_errors: Tuple[Type[BaseException], ...] = (DomainError, *services.external_errors)

    try:
        if idempotency_key is not None and not IDEMPOTENCY_KEY_PATTERN.fullmatch(idempotency_key):
            raise DomainValidationError(
                status_code=422,
                detail=IDEMPOTENCY_KEY_ERROR,
            )

        staged = {
            "endpoint": await read_uploaded_xlsx(endpoint_file, "endpoint", services),
            "detalhes": await read_uploaded_xlsx(details_file, "detalhes", services),
        }

        worker = asyncio.create_task(
            asyncio.to_thread(
                _commit_inventory_files,
                staged,
                services,
                automatic_import_id,
                idempotency_key,
                preview_token,
            )
        )
        # Once the transaction starts, let it finish or roll back before releasing request resources.
        return await await_worker_completion(
            worker,
            on_cancelled_failure=lambda error: logger.error(
                "Falha na atualização em segundo plano após cancelamento da solicitação.",
                exc_info=(type(error), error, error.__traceback__),
            ),
        )
    except passthrough_errors:
        raise
    except FileBusyError as error:
        raise DomainConflictError(str(error)) from error
    except TransactionConflictError as error:
        raise DomainError(f"A recuperação detectou uma alteração externa em um arquivo e parou sem sobrescrevê-lo: {error}") from error
    except (FileTransactionError, WorkbookSafetyError) as error:
        raise DomainError(f"Não foi possível concluir a atualização; a transação restaurou os arquivos anteriores. {error}") from error
    except Exception:
        logger.exception("Falha inesperada ao atualizar o conjunto de planilhas.")
        if idempotency_key is not None:
            raise DomainError(
                detail=(
                    "Não foi possível concluir a solicitação com segurança. Repita-a com a mesma "
                    "Idempotency-Key para recuperar uma confirmação existente ou tentar novamente."
                ),
            ) from None
        raise DomainError("Falha ao atualizar as planilhas; os arquivos anteriores foram restaurados.") from None
    finally:
        for upload in uploads:
            await upload.close()


@dataclass(frozen=True)
class _InventoryCommitPlan:
    """Paths and request facts resolved before the inventory transaction starts."""

    input_directory: Path
    comparison_history_file: Path
    inventory_idempotency_file: Path
    target_files: Dict[str, Path]
    backup_sources: Dict[str, Optional[Path]]
    request_sha256: Optional[str]
    backup_dir: Path
    backup_targets: Dict[str, Path]
    uploaded_names: Dict[str, Any]
    export_model_file: Optional[Path]


@dataclass(frozen=True)
class _PreviousInventoryState:
    """Inventory facts read under the transaction lock before any file is replaced."""

    equipment: Dict[str, Dict[str, Any]]
    aliases: Dict[str, Dict[str, str]]
    endpoint_index: Dict[str, Any]
    manual_alias_sources: List[Dict[str, Any]]
    manual_divergences: List[Dict[str, Any]]


def _plan_inventory_commit(
    staged: Dict[str, Any],
    services: InventoryUpdateServices,
    idempotency_key: Optional[str],
) -> _InventoryCommitPlan:
    """Resolve destinations, backup sources and this attempt's backup directory."""
    input_directory = services.input_directory()
    endpoint_upload_file = services.endpoint_upload_file()
    details_upload_file = services.details_upload_file()
    comparison_history_file = services.comparison_history_file()
    inventory_idempotency_file = services.inventory_idempotency_file()
    upload_backups_directory = services.upload_backups_directory()
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
    request_sha256 = _inventory_request_sha256(staged) if idempotency_key is not None else None
    backup_dir = upload_backups_directory / (
        f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    )
    backup_targets = {
        role: backup_dir / role / target_path.name
        for role, target_path in target_files.items()
    }
    export_model_file = services.export_model_file() if services.export_model_file is not None else None
    if (
        export_model_file is not None
        and export_model_file.is_file()
        and services.prepare_export_model_sync is not None
    ):
        backup_targets["modelo_exportacao"] = backup_dir / "modelos" / export_model_file.name
    return _InventoryCommitPlan(
        input_directory=input_directory,
        comparison_history_file=comparison_history_file,
        inventory_idempotency_file=inventory_idempotency_file,
        target_files=target_files,
        backup_sources=backup_sources,
        request_sha256=request_sha256,
        backup_dir=backup_dir,
        backup_targets=backup_targets,
        uploaded_names={
            "endpoint": staged["endpoint"]["name"],
            "detalhes": staged["detalhes"]["name"],
        },
        export_model_file=export_model_file,
    )


def _compare_staged_inventories(
    staged: Dict[str, Any],
    services: InventoryUpdateServices,
    uploaded_names: Dict[str, Any],
) -> Tuple[Dict[str, Any], datetime]:
    """Compare the uploads while the previous Endpoint is still the one on disk."""
    comparison_time = datetime.now().astimezone()
    comparison_options: Dict[str, Any] = {"as_of": comparison_time}
    if services.removed_endpoint_hostnames is not None:
        removed_hostnames = services.removed_endpoint_hostnames()
        if removed_hostnames:
            comparison_options["removed_endpoint_hostnames"] = removed_hostnames
    # O Endpoint em disco ainda é o anterior: ele indica quais hostnames sumiram no novo.
    comparison_options["previous_endpoint_hostnames"] = dict(
        services.read_endpoint_alias_index().get("unique", {})
    )
    comparison = services.compare_uploaded_workbooks(
        staged["endpoint"]["table"],
        staged["detalhes"]["table"],
        uploaded_names,
        **comparison_options,
    )
    return comparison, comparison_time


def _inventory_transaction_targets(
    plan: _InventoryCommitPlan,
    services: InventoryUpdateServices,
    idempotency_key: Optional[str],
) -> Tuple[List[Path], Optional[Path], Optional[Path]]:
    """List every file the transaction locks, plus the optional user-history files."""
    transaction_targets = [
        *plan.target_files.values(),
        *(path for path in plan.backup_sources.values() if path is not None),
        plan.comparison_history_file,
    ]
    if plan.export_model_file is not None:
        transaction_targets.append(plan.export_model_file)
    if idempotency_key is not None:
        transaction_targets.append(plan.inventory_idempotency_file)
    alias_history_file = services.alias_history_file() if services.alias_history_file is not None else None
    if alias_history_file is not None:
        transaction_targets.append(alias_history_file)
    manual_users_file = (
        services.manual_users_file()
        if services.manual_users_file is not None and alias_history_file is not None
        else None
    )
    if manual_users_file is not None:
        transaction_targets.append(manual_users_file)
        transaction_targets.append(holds_file(manual_users_file))
    return transaction_targets, alias_history_file, manual_users_file


def _replay_confirmed_inventory_update(
    plan: _InventoryCommitPlan,
    services: InventoryUpdateServices,
    idempotency_key: str,
) -> Optional[Dict[str, Any]]:
    """Return the stored result of an already confirmed request, or None for a new one."""
    inventory_idempotency_file = plan.inventory_idempotency_file
    receipt_store = (
        json.loads(inventory_idempotency_file.read_text(encoding="utf-8"))
        if inventory_idempotency_file.exists()
        else {"version": 1, "records": []}
    )
    prior_receipt = _find_inventory_idempotency_receipt(receipt_store, idempotency_key)
    if prior_receipt is None:
        return None
    if prior_receipt["request_sha256"] != plan.request_sha256:
        raise DomainConflictError(
            detail="A Idempotency-Key já foi confirmada com outro conteúdo.",
        )
    replay_state = services.load_database(transaction_locked=True, publish=False)
    if not isinstance(replay_state, dict):
        raise RuntimeError("O inventário confirmado não pôde ser recarregado antes da repetição.")
    services.publish_database_state(replay_state)
    replayed_result: Dict[str, Any] = deepcopy(prior_receipt["result"])
    return replayed_result


def _verify_inventory_preview(
    plan: _InventoryCommitPlan,
    staged: Dict[str, Any],
    services: InventoryUpdateServices,
    preview_token: str,
) -> None:
    """Reject the confirmation when the uploads or the active base changed after the preview."""
    current_bytes = {
        role: path.read_bytes() if path is not None and path.is_file() else b""
        for role, path in plan.backup_sources.items()
    }
    if not services.verify_inventory_preview_token(preview_token, staged, current_bytes):
        raise DomainConflictError(
            detail="A prévia expirou ou os arquivos/base mudaram. Gere uma nova prévia antes de confirmar.",
        )


def _capture_previous_inventory_state(
    staged: Dict[str, Any],
    services: InventoryUpdateServices,
) -> _PreviousInventoryState:
    """Snapshot equipment, aliases and manual alias sources before the replacement."""
    previous_equipment = services.get_equipment_snapshot()
    previous_aliases = services.snapshot_equipment_aliases(previous_equipment)
    previous_endpoint_index = services.read_endpoint_alias_index()
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
    return _PreviousInventoryState(
        equipment=previous_equipment,
        aliases=previous_aliases,
        endpoint_index=previous_endpoint_index,
        manual_alias_sources=manual_alias_sources,
        manual_divergences=manual_divergences,
    )


def _stage_previous_inventory_backups(
    transaction: Any,
    plan: _InventoryCommitPlan,
) -> Tuple[Dict[str, bool], Dict[str, bool]]:
    """Stage byte-identical backups of the current files; report which ones were missing."""
    missing_backup_files: Dict[str, bool] = {}
    invalid_backup_files = {"endpoint": False, "detalhes": False}
    for role in plan.target_files:
        source_path = plan.backup_sources[role]
        if source_path is None or not source_path.is_file():
            missing_backup_files[role] = True
            continue
        missing_backup_files[role] = False
        backup_bytes = source_path.read_bytes()

        def validate_backup(path: Path, expected_bytes: bytes = backup_bytes) -> None:
            if path.read_bytes() != expected_bytes:
                raise RuntimeError("A cópia de segurança não corresponde ao arquivo de origem.")

        transaction.stage_bytes(plan.backup_targets[role], backup_bytes, validate_backup)
    return missing_backup_files, invalid_backup_files


def _stage_uploaded_inventories(
    transaction: Any,
    plan: _InventoryCommitPlan,
    staged: Dict[str, Any],
    services: InventoryUpdateServices,
) -> None:
    """Stage the validated uploads over the active inventory files."""
    for role, target_path in plan.target_files.items():
        upload_bytes = staged[role]["bytes"]

        def validate_staged_upload(
            path: Path, current_role: str = role, expected_bytes: bytes = upload_bytes
        ) -> None:
            candidate_bytes = path.read_bytes()
            if candidate_bytes != expected_bytes:
                raise WorkbookSafetyError("O arquivo preparado difere do inventário validado.")
            services.validate_uploaded_workbook(candidate_bytes, current_role)

        transaction.stage_bytes(target_path, upload_bytes, validate_staged_upload)


def _stage_export_model_sync(
    transaction: Any,
    plan: _InventoryCommitPlan,
    staged: Dict[str, Any],
    services: InventoryUpdateServices,
) -> None:
    """Stage a backed-up, alias-only model refresh with the paired inventory files."""
    model_file = plan.export_model_file
    if (
        model_file is None
        or not model_file.is_file()
        or services.prepare_export_model_sync is None
    ):
        return

    removed_hostnames = (
        services.removed_endpoint_hostnames()
        if services.removed_endpoint_hostnames is not None
        else frozenset()
    )
    endpoint_index = build_endpoint_alias_index(
        staged["endpoint"]["table"]["records"],
        removed_hostnames or frozenset(),
    )
    details_records = staged["detalhes"]["table"]["records"]
    model_bytes = services.prepare_export_model_sync(details_records, endpoint_index)
    if model_bytes is None:
        return

    original_bytes = model_file.read_bytes()
    if model_bytes == original_bytes:
        return
    backup_target = plan.backup_targets.get("modelo_exportacao")
    if backup_target is None:
        raise RuntimeError("O backup do modelo de exportação não foi preparado.")
    transaction.add_target(backup_target)

    def validate_backup(path: Path) -> None:
        if path.read_bytes() != original_bytes:
            raise RuntimeError("O backup do modelo de exportação não corresponde ao original.")

    def validate_model(path: Path) -> None:
        if path.read_bytes() != model_bytes:
            raise WorkbookSafetyError("O modelo preparado difere do conteúdo validado.")
        if services.validate_export_model_sync is not None:
            services.validate_export_model_sync(model_bytes)

    transaction.stage_bytes(backup_target, original_bytes, validate_backup)
    transaction.stage_bytes(model_file, model_bytes, validate_model)


def _apply_inventory_replacement(transaction: Any, services: InventoryUpdateServices) -> Dict[str, Any]:
    """Apply the staged files and load the new state without publishing it yet."""
    transaction.apply()
    prepared_state = services.load_database(transaction_locked=True, publish=False)
    if not isinstance(prepared_state, dict):
        raise RuntimeError("As planilhas enviadas não puderam ser carregadas pelo site.")
    return prepared_state


def _use_held_manual_users_when_file_missing(
    prepared_state: Dict[str, Any],
    endpoint_index: Dict[str, Any],
    existing_holds: Dict[str, Dict[str, Any]],
    manual_now: Dict[str, str],
) -> None:
    """Fall back to the users kept by manual holds; stop if a pending decision would be lost."""
    fallback_manual_users = {
        key: str(hold["usuario_atual"]).strip()
        for key, hold in existing_holds.items()
        if hold.get("tipo") == "substituicao_manual"
    }
    manual_now.update(fallback_manual_users)
    endpoint_with_details = with_details_serials(
        endpoint_index, prepared_state["equipamentos_cache"],
    )
    for key, hold in existing_holds.items():
        if (
            hold.get("tipo") == "substituicao_manual"
            and hold.get("estado") == "pendente"
            and not endpoint_user_for_serial(endpoint_with_details, key).strip()
        ):
            raise DomainBusyError(
                "O cadastro manual está ausente e há uma decisão pendente sem usuário atual no Endpoint; "
                "a atualização foi interrompida para preservar a decisão."
            )
    if fallback_manual_users:
        endpoint_index["manual_users_file_missing"] = True
        endpoint_index["manual_users"] = dict(manual_now)


def _apply_held_aliases(
    services: InventoryUpdateServices,
    prepared_state: Dict[str, Any],
    endpoint_index: Dict[str, Any],
    manual_now: Dict[str, str],
    manual_users_file: Path,
    next_holds: Dict[str, Dict[str, Any]],
    existing_holds: Dict[str, Dict[str, Any]],
) -> None:
    """Recompute the effective alias of every cached equipment touched by a hold."""
    refreshed_index = dict(endpoint_index)
    refreshed_index["manual_users"] = manual_now
    refreshed_index["manual_user_dates"] = manual_user_dates_by_serial(
        manual_now, read_manual_user_dates(manual_users_file),
    )
    refreshed_index["user_holds"] = next_holds
    refreshed_index = with_details_serials(refreshed_index, prepared_state["equipamentos_cache"])
    for cached in prepared_state["equipamentos_cache"].values():
        cached_key = services.normalize_reference_value(cached.get("serial"))
        if cached_key in next_holds or cached_key in existing_holds:
            apply_effective_alias(
                cached, refreshed_index,
                details_duplicate=cached.get("invall_alias_status") == "serie_detalhes_duplicada",
            )


def _plan_manual_user_holds(
    transaction: Any,
    services: InventoryUpdateServices,
    prepared_state: Dict[str, Any],
    previous_equipment: Dict[str, Dict[str, Any]],
    endpoint_index: Dict[str, Any],
    manual_users_file: Path,
) -> Tuple[Dict[str, Dict[str, str]], List[Dict[str, Any]], bool]:
    """Journal user holds; return overridden manual users, created holds and file absence."""
    stored_users = read_manual_users(manual_users_file)
    manual_now = manual_users_by_serial(stored_users or {})
    holds_path = holds_file(manual_users_file)
    existing_holds = read_holds(manual_users_file)
    manual_users_missing = stored_users is None
    if manual_users_missing:
        _use_held_manual_users_when_file_missing(
            prepared_state, endpoint_index, existing_holds, manual_now,
        )
    # Um usuário manual ou um usuário do Endpoint que sumiu nunca muda sozinho: vira pendência
    # e o usuário atual continua valendo até a decisão (ver domains/user_holds.py).
    next_holds, created_holds = plan_holds(
        previous_equipment,
        prepared_state["equipamentos_cache"],
        with_details_serials(endpoint_index, prepared_state["equipamentos_cache"]),
        manual_now,
        existing_holds,
    )
    if next_holds != existing_holds:
        transaction.update_json(holds_path, lambda data: {
            entry["serial"]: entry for entry in next_holds.values()
        }, {})
    _apply_held_aliases(
        services, prepared_state, endpoint_index, manual_now, manual_users_file, next_holds, existing_holds,
    )
    # Um usuário mantido por uma pendência "ausente" não vem do Endpoint atual: o manual fica intacto.
    overridden = manual_users_overridden_by_endpoint(
        prepared_state["equipamentos_cache"],
        {key: user for key, user in manual_now.items()
         if next_holds.get(key, {}).get("tipo") != "usuario_ausente"},
    )
    return overridden, created_holds, manual_users_missing


def _read_alias_history(alias_history_file: Path) -> Any:
    """Read the alias history; an unreadable file only hides archived manual users."""
    try:
        return (
            json.loads(alias_history_file.read_text(encoding="utf-8"))
            if alias_history_file.is_file() else []
        )
    except (OSError, ValueError):
        return []


def _journal_endpoint_warnings(
    transaction: Any,
    services: InventoryUpdateServices,
    staged: Dict[str, Any],
    prepared_state: Dict[str, Any],
    alias_history_file: Path,
    loss_warnings: List[Dict[str, str]],
    overridden: Dict[str, Dict[str, str]],
) -> None:
    """Append vanished Endpoint users/hostnames and archived manual users to the alias history."""
    equipment_by_key = {
        services.normalize_reference_value(item.get("serial")): item
        for item in prepared_state["equipamentos_cache"].values()
    }
    source_label = hashlib.sha256(staged["endpoint"]["bytes"]).hexdigest()[:16]

    def append_endpoint_warnings(history: Any) -> List[Any]:
        if not isinstance(history, list):
            raise RuntimeError("O histórico de alterações não contém uma lista válida.")
        return [
            *history,
            *build_endpoint_warning_entries(loss_warnings, equipment_by_key, history, source_label),
            *build_archived_manual_user_entries(overridden),
        ]

    transaction.update_json(alias_history_file, append_endpoint_warnings, [])


def _reconcile_endpoint_users(
    transaction: Any,
    services: InventoryUpdateServices,
    staged: Dict[str, Any],
    prepared_state: Dict[str, Any],
    previous: _PreviousInventoryState,
    endpoint_index: Dict[str, Any],
    alias_history_file: Path,
    manual_users_file: Optional[Path],
) -> List[Dict[str, str]]:
    """Journal user holds and Endpoint warnings; return the logged-user changes of this update."""
    user_changes: List[Dict[str, str]] = []
    loss_warnings = endpoint_loss_warnings(previous.endpoint_index, endpoint_index)
    # A manual user hidden by an Endpoint user leaves the manual file and is kept in the
    # alias history, so it cannot come back silently if the Endpoint user disappears later.
    overridden: Dict[str, Dict[str, str]] = {}
    created_holds: List[Dict[str, Any]] = []
    manual_users_missing = False
    if manual_users_file is not None:
        overridden, created_holds, manual_users_missing = _plan_manual_user_holds(
            transaction, services, prepared_state, previous.equipment, endpoint_index, manual_users_file,
        )
    if overridden and manual_users_file is not None and not manual_users_missing:
        transaction.update_json(
            manual_users_file, lambda data: without_manual_users(data, set(overridden)), {},
        )
    earlier_history = _read_alias_history(alias_history_file)
    if previous.endpoint_index.get("available") and endpoint_index.get("available"):
        user_changes = hold_change_rows(created_holds) + logged_user_changes(
            previous.equipment,
            prepared_state["equipamentos_cache"],
            endpoint_index,
            overridden,
            archived_manual_users(earlier_history if isinstance(earlier_history, list) else []),
        )
    if loss_warnings or overridden:
        _journal_endpoint_warnings(
            transaction, services, staged, prepared_state, alias_history_file, loss_warnings, overridden,
        )
    return user_changes


def _detail_serial_index(
    staged: Dict[str, Any],
    services: InventoryUpdateServices,
) -> Tuple[set[str], set[str]]:
    """Normalized Simpress serials of the upload and the ones that appear more than once."""
    detail_serial_counts: Dict[str, int] = {}
    for record in staged["detalhes"]["table"].get("records", []):
        serial_key = services.normalize_reference_value(services.upload_serial_value(record, "detalhes"))
        if serial_key:
            detail_serial_counts[serial_key] = detail_serial_counts.get(serial_key, 0) + 1
    detail_serials = set(detail_serial_counts)
    detail_duplicates = {
        serial_key for serial_key, count in detail_serial_counts.items() if count > 1
    }
    return detail_serials, detail_duplicates


def _attach_alias_review(
    comparison: Dict[str, Any],
    comparison_time: datetime,
    services: InventoryUpdateServices,
    staged: Dict[str, Any],
    uploaded_names: Dict[str, Any],
    previous_aliases: Dict[str, Dict[str, str]],
    prepared_state: Dict[str, Any],
    endpoint_index: Dict[str, Any],
) -> None:
    """Record the comparison time, the updated aliases and the aliases left for review."""
    detail_serials, detail_duplicates = _detail_serial_index(staged, services)
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


def _attach_commit_metadata(
    comparison: Dict[str, Any],
    plan: _InventoryCommitPlan,
    previous: _PreviousInventoryState,
    user_changes: List[Dict[str, str]],
    missing_backup_files: Dict[str, bool],
    invalid_backup_files: Dict[str, bool],
    prepared_state: Dict[str, Any],
) -> None:
    """Record manual alias sources, user changes, backup details and the loaded totals."""
    comparison["divergencias_apelidos_manuais"] = previous.manual_divergences
    comparison["mudancas_usuarios"] = user_changes
    comparison["fontes_apelidos_manuais"] = previous.manual_alias_sources
    comparison["backup_diretorio"] = str(plan.backup_dir.relative_to(plan.input_directory))
    comparison["backup_arquivos_ausentes"] = missing_backup_files
    comparison["backup_arquivos_invalidos"] = invalid_backup_files
    comparison["total_equipamentos_carregados"] = prepared_state["stats_cache"].get("total_equipamentos", 0)
    comparison["ultima_atualizacao"] = prepared_state["stats_cache"].get("ultima_atualizacao", "")
    comparison["arquivos_enviados"] = plan.uploaded_names
    comparison["historico_salvo"] = True


def _comparison_summary(
    comparison: Dict[str, Any],
    manual_divergences: List[Dict[str, Any]],
    user_changes: List[Dict[str, str]],
) -> Dict[str, Any]:
    """Per-section counts stored with the history event."""
    return {
        "total_endpoint": comparison.get("total_endpoint", 0),
        "ausentes_no_endpoint": len(comparison.get("ausentes_no_endpoint", [])),
        "ausentes_em_detalhes": len(comparison.get("ausentes_em_detalhes", [])),
        "sem_acesso_7_dias": len(comparison.get("sem_acesso_7_dias", [])),
        "divergencias_local": len(comparison.get("divergencias_local", [])),
        "correspondencias_ambiguas": len(comparison.get("correspondencias_ambiguas", [])),
        "series_sem_mapeamento": len(comparison.get("series_sem_mapeamento", [])),
        "apelidos_atualizados": len(comparison.get("apelidos_atualizados", [])),
        "apelidos_sem_atualizacao": len(comparison.get("apelidos_sem_atualizacao", [])),
        "divergencias_apelidos_manuais": len(manual_divergences),
        "mudancas_usuarios": len(user_changes),
    }


def _build_history_entry(
    comparison: Dict[str, Any],
    event_id: str,
    uploaded_names: Dict[str, Any],
    summary: Dict[str, Any],
    automatic_import_id: Optional[str],
) -> Dict[str, Any]:
    """History event that carries the complete comparison of this update."""
    history_entry = {
        "id": event_id,
        "horario": comparison["horario_comparacao"],
        "arquivos_enviados": uploaded_names,
        "resumo": summary,
        "comparacao": comparison,
    }
    if automatic_import_id:
        history_entry["importacao_automatica_id"] = str(automatic_import_id)
    return history_entry


def _stage_inherited_annotations(
    transaction: Any,
    pending_annotation_records: List[Tuple[Path, Dict[str, Any]]],
) -> None:
    """Stage each inherited annotation revision; an existing different revision aborts."""
    for target, record in pending_annotation_records:
        if target.exists():
            existing = json.loads(target.read_text(encoding="utf-8"))
            if not same_annotation_revision(existing, record):
                raise RuntimeError("A revisão pendente já existe com outro conteúdo; arquivo preservado.")
            continue
        payload = json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8")

        def validate_annotation(path: Path, expected: Dict[str, Any] = record) -> None:
            actual = json.loads(path.read_text(encoding="utf-8"))
            if not same_annotation_revision(actual, expected):
                raise RuntimeError("A anotação preparada não corresponde à revisão herdada.")

        transaction.stage_bytes(target, payload, validate_annotation)


def _journal_comparison_history(
    transaction: Any,
    services: InventoryUpdateServices,
    comparison_history_file: Path,
    history_entry: Dict[str, Any],
    manual_alias_sources: List[Dict[str, Any]],
) -> List[Dict[str, str]]:
    """Append the event, supersede refreshed manual divergences and inherit matching notes."""
    event_id = history_entry["id"]
    comparison = history_entry["comparacao"]
    copied_annotations: list[Dict[str, str]] = []
    pending_annotation_records: list[tuple[Path, Dict[str, Any]]] = []

    def append_update(history: Any) -> List[Any]:
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
        for copied_annotation in copied_annotations:
            record = services.build_history_annotation_record(
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
            target = services.history_annotation_record_path(
                services.local_annotation_outbox_directory(),
                record["evento_id"], record["item_id"], record["revisao_id"],
            )
            # The transaction-wide lock remains held; lock the discovered
            # destination before staging it into the journal.
            transaction.add_target(target)
            pending_annotation_records.append((target, record))
        updated.append(history_entry)
        return updated

    transaction.update_json(comparison_history_file, append_update, [])
    _stage_inherited_annotations(transaction, pending_annotation_records)
    return copied_annotations


def _build_commit_response(
    services: InventoryUpdateServices,
    history_entry: Dict[str, Any],
    copied_annotations: List[Dict[str, str]],
    prepared_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Response shown after the update, with the history labels applied."""
    historical_view = services.comparison_history_for_display(history_entry)
    historical_comparison = dict(historical_view.get("comparacao") or {})
    historical_comparison["evento_id"] = history_entry["id"]
    historical_comparison["historico_salvo"] = True
    historical_comparison["anotacoes_herdadas_enfileiradas"] = len(copied_annotations)
    historical_comparison["sincronizacao_anotacoes"] = (
        "pendente" if copied_annotations else "nao_aplicavel"
    )
    return {
        "sucesso": True,
        "comparacao": historical_comparison,
        "anotacoes_herdadas_enfileiradas": len(copied_annotations),
        "sincronizacao_anotacoes": "pendente" if copied_annotations else "nao_aplicavel",
        "stats": deepcopy(prepared_state["stats_cache"]),
        "historico_salvo": True,
    }


def _journal_idempotency_receipt(
    transaction: Any,
    plan: _InventoryCommitPlan,
    idempotency_key: str,
    response: Dict[str, Any],
) -> None:
    """Journal the confirmation so a retry with the same key replays this response."""
    transaction.update_json(
        plan.inventory_idempotency_file,
        lambda current: _append_inventory_idempotency_receipt(
            current,
            idempotency_key,
            str(plan.request_sha256),
            response,
        ),
        {"version": 1, "records": []},
    )


def _commit_inventory_files(
    staged: Dict[str, Any],
    services: InventoryUpdateServices,
    automatic_import_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    preview_token: Optional[str] = None,
) -> Dict[str, Any]:
    """Validate, compare, replace, reload, and journal inventories in a worker thread."""
    plan = _plan_inventory_commit(staged, services, idempotency_key)
    comparison, comparison_time = _compare_staged_inventories(staged, services, plan.uploaded_names)
    transaction_targets, alias_history_file, manual_users_file = _inventory_transaction_targets(
        plan, services, idempotency_key,
    )
    with _transaction_with_backup_cleanup(
        services.inventory_state_transaction(transaction_targets),
        plan.backup_dir,
        plan.backup_targets,
    ) as transaction:
        if idempotency_key is not None:
            replayed = _replay_confirmed_inventory_update(plan, services, idempotency_key)
            if replayed is not None:
                return replayed

        if preview_token is not None:
            _verify_inventory_preview(plan, staged, services, preview_token)

        for role in plan.target_files:
            transaction.add_target(plan.backup_targets[role])

        previous = _capture_previous_inventory_state(staged, services)
        missing_backup_files, invalid_backup_files = _stage_previous_inventory_backups(transaction, plan)
        _stage_uploaded_inventories(transaction, plan, staged, services)
        _stage_export_model_sync(transaction, plan, staged, services)
        prepared_state = _apply_inventory_replacement(transaction, services)

        endpoint_index = services.read_endpoint_alias_index()
        user_changes: List[Dict[str, str]] = []
        if alias_history_file is not None:
            user_changes = _reconcile_endpoint_users(
                transaction, services, staged, prepared_state, previous,
                endpoint_index, alias_history_file, manual_users_file,
            )
        _attach_alias_review(
            comparison, comparison_time, services, staged, plan.uploaded_names,
            previous.aliases, prepared_state, endpoint_index,
        )
        _attach_commit_metadata(
            comparison, plan, previous, user_changes,
            missing_backup_files, invalid_backup_files, prepared_state,
        )
        event_id = uuid.uuid4().hex
        comparison["evento_id"] = event_id
        history_entry = _build_history_entry(
            comparison,
            event_id,
            plan.uploaded_names,
            _comparison_summary(comparison, previous.manual_divergences, user_changes),
            automatic_import_id,
        )
        copied_annotations = _journal_comparison_history(
            transaction, services, plan.comparison_history_file, history_entry, previous.manual_alias_sources,
        )
        response = _build_commit_response(services, history_entry, copied_annotations, prepared_state)
        if idempotency_key is not None:
            _journal_idempotency_receipt(transaction, plan, idempotency_key, response)
        transaction.commit()
        services.publish_database_state(prepared_state)
    return response
