import asyncio
from collections import Counter
import io
import filecmp
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import threading
import time
import unicodedata
import uuid
from copy import deepcopy
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Any, Set, Tuple
from urllib.parse import quote

import openpyxl
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from starlette.datastructures import UploadFile as StarletteUploadFile
from routers.frontend import RevalidatingStaticFiles, frontend_response
from core.integrity import (
    AtomicFileTransaction,
    FileBusyError,
    FileTransactionError,
    TransactionConflictError,
    WorkbookSafetyError,
    lock_paths,
    load_workbook_safely,
    recover_pending_transactions,
    serialize_workbook_validated,
    stage_workbook_update,
    workbook_snapshot,
)
from core.config import (
    ALIAS_HISTORY_FILE,
    AUTOMATIC_INVENTORY_IMPORT_POLL_SECONDS,
    AUTOMATIC_INVENTORY_INBOX_DIR,
    AUTOMATIC_TICKET_IMPORT_POLL_SECONDS,
    AUTOMATIC_TICKET_INBOX_DIR,
    BASE_DIR,
    COMPARISON_HISTORY_FILE,
    CUSTOM_UNIDADES_FILE,
    DATA_DIR,
    DETAILS_UPLOAD_FILE,
    ENDPOINT_UPLOAD_FILE,
    EXPORT_MODEL_FILE,
    HISTORY_ANNOTATIONS_DIR,
    HISTORY_ANNOTATIONS_SYNC_ENABLED,
    LOCAL_HISTORY_ANNOTATION_OUTBOX_DIR,
    INPUT_DIR,
    MAX_API_REQUEST_BYTES,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_REQUEST_BYTES,
    MAX_CONCURRENT_UPLOAD_REQUESTS,
    MAX_CONCURRENT_WORKBOOK_PARSERS,
    HISTORY_RETENTION_DAYS,
    MODIFIED_APELIDOS_FILE,
    STATIC_DIR,
    STATE_DIR,
    TEMPLATE_FILE,
    TICKET_REPORT_FILE,
    TRANSACTION_ROOT,
    TRANSFER_HISTORY_FILE,
    UPLOAD_BACKUPS_DIR,
    SUPPORTED_CONTRACT,
    SUPPORTED_CONTRACT_LEGAL_NAME,
    TRANSFER_ORIGIN_CONTACT,
    TRANSFER_ORIGIN_EMAIL,
    TRANSFER_ORIGIN_PHONE,
)
from routers.inventory_history import (
    ComparisonAnnotationPayload,
    ComparisonRestorePayload,
    InventoryHistoryServices,
    ManualAliasConflictResolutionPayload,
    create_inventory_history_router,
)
from routers.transfers import (
    TransferenciaPayload,
    create_transfer_router,
    formatar_telefone_brasileiro,
)
from routers.transfer_history import TransferHistoryServices, create_transfer_history_router
from routers.dashboard import DashboardServices, create_dashboard_router
from routers.operations import MAX_TICKET_WORKBOOK_BYTES, create_operations_router
from routers.local_setup import create_local_setup_router
from domains.local_setup import validate_local_model
from core.xlsx_safety import WORKBOOK_READ_ERRORS, XlsxLimitExceeded, XlsxPackageError, validate_xlsx

from domains.inventory_comparison import (
    COMPARISON_SOURCE_LABELS,
    CURITIBA_HOSTNAME_PREFIXES,
    PINNED_COMPARISON_EVENT_ID,
    PINNED_COMPARISON_EVENT_TIME,
    SEBRAE_OWNED_NOTEBOOK_SERIALS,
    SERIE_LOCAL_MAP,
    _comparison_source_records,
    _record_value,
    _unique_upload_records,
    _upload_alias_value,
    _upload_serial_value,
    _uploaded_aliases_by_serial,
    comparison_annotation_item_id,
    compare_uploaded_workbooks,
    comparison_history_for_display,
    comparison_review_item_id,
    filter_curitiba_hostname_location_mismatches,
    filter_sebrae_owned_unmatched_items,
    filter_update_review_items,
    filter_update_unmatched_details,
    filter_update_unmatched_series,
    is_missing_cell_value,
    is_curitiba_hostname_exception,
    is_prnoteti_curitiba_location_match,
    is_sebrae_owned_notebook_serial,
    location_for_computer_name,
    normalize_reference_value,
)
from domains.inventory_inbox import (
    AutomaticInventoryInbox,
    automatic_inventory_import_worker as run_automatic_inventory_import_worker,
)
from domains.ticket_inbox import (
    AutomaticTicketInbox,
    automatic_ticket_import_worker as run_automatic_ticket_import_worker,
)
from domains.history_annotations import (
    build_history_annotation_record,
    history_annotation_row_fingerprint,
    history_annotation_record_path,
    load_history_annotations,
    save_history_annotation,
)
from domains import effective_alias
from domains import readiness, uploaded_workbooks
from domains.uploaded_workbooks import (
    DETAILS_ALIAS_HEADER_ALIASES,
    DETAILS_COMPLETE_SOURCE_COLUMN_COUNT,
    DETAILS_INSTALLATION_CNPJ_HEADER_ALIASES,
    DETAILS_REQUIRED_HEADERS,
    DETAILS_SERIAL_HEADER_ALIASES,
    DETAILS_TYPE_HEADER_ALIASES,
    WorkbookHeaderError,
    find_workbook_header_column,
    normalize_workbook_header,
    select_upload_table,
    validate_unambiguous_workbook_headers,
)
from domains.inventory_update import InventoryUpdateServices
from domains.inventory_update import preview_inventory_files
from domains.inventory_update import update_inventory_files
from domains.equipment_search import (
    CATEGORIES as _CATEGORIAS_EQUIPAMENTO,
    EquipmentSearchIndexEntry,
    build_search_index,
    categorize_equipment,
    normalize_search_term,
    search_normalized_index as search_normalized_equipment_index,
)
from routers.equipment_search import EquipmentSearchServices, create_equipment_search_router
from routers.system import SystemRouteServices, create_system_router
from routers.units import UnidadePayload, UnitRouteServices, create_units_router
from core.inventory_requests import (
    InventoryUpdateMiddleware,
    idempotency_key,
)
from security.local_requests import (
    LocalRequestSafetyMiddleware as _LocalRequestSafetyMiddleware,
    LocalRequestSafetyServices,
    RequestBodyLimits,
    RequestBodyTooLarge,
    allowed_local_authorities,
    parse_request_authority,
)

# Runtime synchronization and in-memory state remain in the application entry point.
# Lock hierarchy (docs/arquitetura/auditoria_backend/hierarquia_de_locks.md): the global
# ".atomic-transactions" lock, then file locks, then these Python locks as leaves.
# Hold a leaf lock only around memory or a single file read; never open a
# transaction, call lock_paths or load_database while holding one.
MODIFIED_APELIDOS_LOCK = threading.RLock()
ALIAS_HISTORY_LOCK = threading.RLock()
COMPARISON_HISTORY_LOCK = threading.RLock()
STATE_LOCK = threading.RLock()
UPLOAD_ADMISSION = threading.BoundedSemaphore(MAX_CONCURRENT_UPLOAD_REQUESTS)
WORKBOOK_PARSE_ADMISSION = threading.BoundedSemaphore(MAX_CONCURRENT_WORKBOOK_PARSERS)
logger = logging.getLogger(__name__)


class LocalJsonCorruptionError(ValueError):
    """A persisted JSON file is present but cannot be trusted or updated safely."""


def _read_json_object(path: Path, label: str) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise LocalJsonCorruptionError(f"O arquivo local de {label} está ilegível; os dados foram preservados.") from error
    if not isinstance(value, dict) or any(not isinstance(key, str) or not isinstance(item, str) for key, item in value.items()):
        raise LocalJsonCorruptionError(f"O arquivo local de {label} precisa conter um objeto com chaves e valores textuais.")
    return value


def _validate_json_object(value: Any, label: str) -> Dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) or not isinstance(item, str) for key, item in value.items()):
        raise LocalJsonCorruptionError(f"O arquivo local de {label} precisa conter um objeto com chaves e valores textuais.")
    return value


def _read_json_history(path: Path, label: str) -> List[Dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise LocalJsonCorruptionError(f"O histórico local de {label} está ilegível; os dados foram preservados.") from error
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise LocalJsonCorruptionError(f"O histórico local de {label} precisa conter uma lista de registros.")
    return value
UPLOAD_PREVIEW_TOKEN_SECRET = os.urandom(32)
UPLOAD_PREVIEW_TOKEN_TTL_SECONDS = 10 * 60
INVENTORY_UPLOAD_PATHS = frozenset({
    "/api/planilhas/previsualizar",
    "/api/planilhas/atualizar",
})


@contextmanager
def inventory_state_transaction(targets):
    """Keep an in-memory inventory snapshot aligned with a file transaction."""
    global equipamentos_cache, unidades_cache, stats_cache
    with AtomicFileTransaction(TRANSACTION_ROOT, targets) as transaction:
        with STATE_LOCK:
            state_before = (
                deepcopy(equipamentos_cache),
                deepcopy(unidades_cache),
                deepcopy(stats_cache),
            )
        try:
            yield transaction
        except BaseException:
            with STATE_LOCK:
                equipamentos_cache, unidades_cache, stats_cache = state_before
            raise


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def load_modified_apelidos() -> Dict[str, str]:
    with MODIFIED_APELIDOS_LOCK:
        if not MODIFIED_APELIDOS_FILE.exists():
            return {}
        return _read_json_object(MODIFIED_APELIDOS_FILE, "apelidos")

def load_alias_history() -> List[Dict[str, Any]]:
    with ALIAS_HISTORY_LOCK:
        if not ALIAS_HISTORY_FILE.exists():
            return []
        try:
            return _read_json_history(ALIAS_HISTORY_FILE, "apelidos")
        except LocalJsonCorruptionError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

def load_comparison_history() -> List[Dict[str, Any]]:
    with COMPARISON_HISTORY_LOCK:
        if not COMPARISON_HISTORY_FILE.exists():
            return []
        try:
            return _read_json_history(COMPARISON_HISTORY_FILE, "comparações")
        except LocalJsonCorruptionError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error


def pinned_comparison_history_entry(history: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    entries = load_comparison_history() if history is None else history
    if not isinstance(entries, list):
        return None
    return next(
        (
            entry for entry in entries
            if isinstance(entry, dict)
            and entry.get("id") == PINNED_COMPARISON_EVENT_ID
            and entry.get("horario") == PINNED_COMPARISON_EVENT_TIME
        ),
        None,
    )


def latest_comparison_update_entry(history: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """Returns the newest comparison update while leaving the pinned baseline available."""
    entries = load_comparison_history() if history is None else history
    candidates = [
        entry for entry in entries
        if isinstance(entry, dict)
        and entry.get("id") != PINNED_COMPARISON_EVENT_ID
        and entry.get("tipo") != "restauracao"
        and not (
            isinstance(entry.get("comparacao"), dict)
            and entry["comparacao"].get("tipo_operacao") == "restauracao"
        )
    ] if isinstance(entries, list) else []
    if not candidates:
        return None

    def event_timestamp(entry: Dict[str, Any]) -> float:
        try:
            return datetime.fromisoformat(str(entry.get("horario") or "").replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError, OverflowError):
            return float("-inf")

    return max(candidates, key=event_timestamp)


def build_alias_change_entry(
    serial: str,
    previous_alias: str,
    new_alias: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
) -> Dict[str, Any]:
    with STATE_LOCK:
        equipment = dict(equipamentos_cache.get(serial, {}))
    return {
        "id": uuid.uuid4().hex,
        "tipo": "apelido",
        "serial": serial,
        "equipamento": equipment.get("modelo") or equipment.get("tipo") or "Equipamento",
        "apelido_anterior": previous_alias,
        "apelido_novo": new_alias,
        "horario": datetime.now().astimezone().isoformat(timespec="seconds"),
        "acao": action,
        "referencia_id": reference_id,
    }

def _equipment_revision(serial: Any, modelo: Any, tipo: Any, apelido: Any, id_cliente: Any) -> str:
    values = []
    for index, value in enumerate((serial, modelo, tipo, apelido, id_cliente)):
        if value is None:
            values.append("")
            continue
        text = str(value).strip()
        if index == 4 and re.fullmatch(r"\d+\.0+", text):
            text = text.split(".", 1)[0]
        values.append(text)
    payload = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def normalize_contract_value(value: Any) -> str:
    """Normalize Excel integer cells without accepting a different contract."""
    normalized = sanitize_value(value).strip()
    if re.fullmatch(r"\d+\.0+", normalized):
        normalized = normalized.split(".", 1)[0]
    return normalized


_ensure_workbook_readable = uploaded_workbooks.ensure_workbook_readable


def _read_details_sheet_records(file_path: Path, sheet_name: str):
    """Read inventory rows with openpyxl, preserving the cells used by the application."""
    return uploaded_workbooks.read_details_sheet_records(_workbook_reader_services, file_path, sheet_name)


def find_details_sheet(file_path: Path) -> Optional[str]:
    """Retorna uma aba EquipamentosDetalhes com os campos usados pelo site.

    Levanta FileBusyError quando o arquivo existe mas não pode ser lido; ``None``
    significa somente que o arquivo não tem uma aba de inventário válida.
    """
    return uploaded_workbooks.find_details_sheet(_workbook_reader_services, file_path)


def validate_xlsx_package(file_bytes: bytes) -> None:
    """Rejects non-XLSX, malformed, or excessively large ZIP packages before parsing."""
    uploaded_workbooks.validate_xlsx_package(file_bytes, validate_xlsx)


def read_workbook_tables(file_bytes: bytes) -> List[Dict[str, Any]]:
    """Lê abas não vazias de um XLSX e retorna cabeçalhos normalizados e linhas."""
    return uploaded_workbooks.read_workbook_tables(_workbook_reader_services, file_bytes)


_workbook_reader_services = uploaded_workbooks.WorkbookReaderServices(
    validate_xlsx=lambda *args, **kwargs: validate_xlsx(*args, **kwargs),
    validate_xlsx_package=lambda file_bytes: validate_xlsx_package(file_bytes),
    ensure_workbook_readable=lambda file_path: _ensure_workbook_readable(file_path),
    logger=logger,
)


def get_details_files() -> List[Path]:
    """Lista arquivos EquipamentosDetalhes enviados ou mantidos na pasta de entrada."""
    if not INPUT_DIR.is_dir():
        return []
    return sorted(
        (
            path for path in INPUT_DIR.glob("EquipamentosDetalhes*.xlsx")
            if path.is_file() and not path.name.startswith("~$")
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def get_primary_equipment_file() -> Optional[Path]:
    """Retorna o EquipamentosDetalhes válido mais recente, fonte única do cadastro.

    Um candidato ilegível interrompe a busca com FileBusyError em vez de deixar
    um arquivo mais antigo assumir a base ativa.
    """
    return next(
        (path for path in get_details_files() if find_details_sheet(path) is not None),
        None,
    )


def _check_startup_xlsx(path: Optional[Path]) -> Dict[str, Any]:
    """Check the local XLSX container without loading or logging workbook data."""
    return readiness.check_startup_xlsx(path, validate_xlsx)


_READY_WORKBOOK_CACHE = readiness.ReadyWorkbookCache()
_READINESS_VALIDATION_CACHE = _READY_WORKBOOK_CACHE.entries
_READINESS_VALIDATION_LOCK = _READY_WORKBOOK_CACHE.lock
_READINESS_REPORT_CACHE = readiness.ReadinessReportCache()


def get_local_transfer_template() -> Path:
    override = INPUT_DIR / "_modelos" / "transferencia.xlsx"
    return override if override.exists() else TEMPLATE_FILE


def _check_ready_workbook(path: Path, role: str) -> Dict[str, Any]:
    return readiness.check_ready_workbook(path, role, _ready_workbook_services, _READY_WORKBOOK_CACHE)


_check_startup_ticket_report = readiness.check_startup_ticket_report


def _readiness_loaded_state() -> Tuple[bool, bool]:
    with STATE_LOCK:
        return bool(equipamentos_cache), bool(unidades_cache)


def _validate_local_state_for_readiness() -> None:
    load_modified_apelidos()
    load_custom_units()
    if ALIAS_HISTORY_FILE.exists():
        load_alias_history()
    if COMPARISON_HISTORY_FILE.exists():
        load_comparison_history()


def _refresh_export_status_for_readiness() -> Dict[str, Any]:
    # Readiness reads without the transaction lock; files are replaced atomically.
    count_export_changes(locked=True)
    return get_export_status()


def _readiness_signature() -> Tuple[Any, ...]:
    """Everything the readiness report reads, so a cached report is never stale."""
    try:
        details_files: Any = tuple(get_details_files())
    except OSError as error:
        details_files = type(error).__name__
    watched = (
        TICKET_REPORT_FILE,
        DETAILS_UPLOAD_FILE,
        ENDPOINT_UPLOAD_FILE,
        EXPORT_MODEL_FILE,
        MODIFIED_APELIDOS_FILE,
        CUSTOM_UNIDADES_FILE,
        ALIAS_HISTORY_FILE,
        COMPARISON_HISTORY_FILE,
        INPUT_DIR / "_modelos" / "transferencia.xlsx",
        TEMPLATE_FILE,
    )
    details_signature = (
        readiness.file_signature(details_files) if isinstance(details_files, tuple) else details_files
    )
    return (
        readiness.file_signature(watched),
        details_signature,
        _readiness_loaded_state(),
        get_transaction_recovery_block(),
    )


def get_startup_readiness() -> Dict[str, Any]:
    """Readiness without the global transaction lock, cached while its inputs stay the same."""
    return _READINESS_REPORT_CACHE.get_or_compute(_readiness_signature(), _get_startup_readiness_unlocked)


def _get_startup_readiness_unlocked() -> Dict[str, Any]:
    """Map essential local files to the application functions that need them."""
    return readiness.build_readiness_report(_readiness_services)


_ready_workbook_services = readiness.ReadyWorkbookServices(
    validate_local_model=lambda *args, **kwargs: validate_local_model(*args, **kwargs),
    validate_uploaded_workbook=lambda *args, **kwargs: validate_uploaded_workbook(*args, **kwargs),
    max_upload_bytes=lambda: MAX_UPLOAD_BYTES,
    logger=logger,
)

_readiness_services = readiness.ReadinessServices(
    ticket_report_file=lambda: TICKET_REPORT_FILE,
    details_upload_file=lambda: DETAILS_UPLOAD_FILE,
    endpoint_upload_file=lambda: ENDPOINT_UPLOAD_FILE,
    export_model_file=lambda: EXPORT_MODEL_FILE,
    get_details_files=lambda: get_details_files(),
    get_primary_equipment_file=lambda: get_primary_equipment_file(),
    get_local_transfer_template=lambda: get_local_transfer_template(),
    check_startup_xlsx=lambda path: _check_startup_xlsx(path),
    check_ready_workbook=lambda path, role: _check_ready_workbook(path, role),
    check_startup_ticket_report=lambda path: _check_startup_ticket_report(path),
    loaded_state=lambda: _readiness_loaded_state(),
    validate_local_state=lambda: _validate_local_state_for_readiness(),
    local_state_errors=(LocalJsonCorruptionError, HTTPException),
    refresh_export_status=lambda: _refresh_export_status_for_readiness(),
    get_transaction_recovery_block=lambda: get_transaction_recovery_block(),
    logger=logger,
)


def report_startup_readiness() -> None:
    """Log a clear feature impact summary without exposing workbook contents."""
    for line in readiness.readiness_log_lines(get_startup_readiness()):
        print(line)


def _report_startup_readiness_best_effort() -> None:
    """Log feature readiness when possible without making it a startup requirement."""
    try:
        report_startup_readiness()
    except Exception:
        logger.exception(
            "Não foi possível calcular a prontidão local; o servidor continuará em execução."
        )


# Message of the startup recovery that refused to touch a diverged file; None when writes are allowed.
_TRANSACTION_RECOVERY_BLOCK: Optional[str] = None
_TRANSACTION_RECOVERY_BLOCK_LOCK = threading.Lock()


def _recover_pending_transactions_at_startup() -> bool:
    """Recover interrupted writes, or start read-only when the journal no longer matches the files."""
    global _TRANSACTION_RECOVERY_BLOCK
    try:
        recover_pending_transactions(TRANSACTION_ROOT)
    except TransactionConflictError as error:
        message = (
            f"{error} As gravações ficam bloqueadas até a conferência manual da pasta "
            f"'.transactions'; os dados exibidos podem refletir uma gravação incompleta."
        )
        with _TRANSACTION_RECOVERY_BLOCK_LOCK:
            _TRANSACTION_RECOVERY_BLOCK = message
        print(f"[INDISPONÍVEL] Recuperação de gravação pendente: {message}")
        return False
    with _TRANSACTION_RECOVERY_BLOCK_LOCK:
        _TRANSACTION_RECOVERY_BLOCK = None
    return True


def _has_pending_transaction_journal() -> bool:
    try:
        return any(
            (entry / "manifest.json").is_file()
            for entry in (TRANSACTION_ROOT / ".transactions").iterdir()
            if entry.is_dir()
        )
    except FileNotFoundError:
        return False
    except OSError:
        # An unreadable journal folder cannot prove that recovery was resolved.
        return True


def get_transaction_recovery_block() -> Optional[str]:
    """Return why writes are blocked, clearing the block once the journal was resolved manually."""
    global _TRANSACTION_RECOVERY_BLOCK
    with _TRANSACTION_RECOVERY_BLOCK_LOCK:
        message = _TRANSACTION_RECOVERY_BLOCK
        if message is None:
            return None
        # While blocked no transaction can open, so any remaining journal is the unresolved one.
        if not _has_pending_transaction_journal():
            _TRANSACTION_RECOVERY_BLOCK = None
            return None
        return message


def _raise_if_transaction_recovery_blocked() -> None:
    """Keep automatic batches pending (503 is transient for the inboxes) instead of failing them."""
    if (message := get_transaction_recovery_block()) is not None:
        raise HTTPException(status_code=503, detail=message)


def inventory_update_preview_summary(
    current_tables: Dict[str, Dict[str, Any]],
    incoming_tables: Dict[str, Dict[str, Any]],
) -> Dict[str, Dict[str, int]]:
    """Return counts only; never include row values or serials in an upload preview."""
    summary = {}
    for role in ("endpoint", "detalhes"):
        def count_serials(table):
            counts: Dict[str, int] = {}
            for record in table.get("records", []):
                serial_key = normalize_reference_value(_upload_serial_value(record, role))
                if serial_key:
                    counts[serial_key] = counts.get(serial_key, 0) + 1
            return counts

        current_counts = count_serials(current_tables[role])
        incoming_counts = count_serials(incoming_tables[role])
        current_serials = set(current_counts)
        incoming_serials = set(incoming_counts)
        summary[role] = {
            "linhas_atuais": len(current_tables[role].get("records", [])),
            "linhas_novas": len(incoming_tables[role].get("records", [])),
            "series_novas": len(incoming_serials - current_serials),
            "series_removidas": len(current_serials - incoming_serials),
            "series_duplicadas_no_arquivo_novo": sum(
                1 for count in incoming_counts.values() if count > 1
            ),
        }
    return summary


def _inventory_preview_token_payload(issued_at: int, staged, current_bytes) -> bytes:
    payload = {
        "versao": 1,
        "emitido_em": issued_at,
        "uploads": {
            role: hashlib.sha256(staged[role]["bytes"]).hexdigest()
            for role in ("endpoint", "detalhes")
        },
        "bases_atuais": {
            role: hashlib.sha256(current_bytes[role]).hexdigest()
            for role in ("endpoint", "detalhes")
        },
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def create_inventory_preview_token(staged, current_bytes) -> str:
    issued_at = int(time.time())
    payload = _inventory_preview_token_payload(issued_at, staged, current_bytes)
    signature = hmac.new(UPLOAD_PREVIEW_TOKEN_SECRET, payload, hashlib.sha256).hexdigest()
    return f"{issued_at}.{signature}"


def verify_inventory_preview_token(token, staged, current_bytes) -> bool:
    try:
        issued_at_text, supplied_signature = str(token).split(".", 1)
        issued_at = int(issued_at_text)
        age = int(time.time()) - issued_at
        if age < 0 or age > UPLOAD_PREVIEW_TOKEN_TTL_SECONDS:
            return False
        payload = _inventory_preview_token_payload(issued_at, staged, current_bytes)
        expected_signature = hmac.new(
            UPLOAD_PREVIEW_TOKEN_SECRET, payload, hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(supplied_signature, expected_signature)
    except (AttributeError, TypeError, ValueError):
        return False


def _manual_alias_source_snapshots(
    overrides: Dict[str, str],
    endpoint_table: Dict[str, Any],
    details_table: Dict[str, Any],
) -> List[Dict[str, Any]]:
    manual_aliases = _manual_aliases_by_serial(overrides)
    endpoint_rows = _unique_upload_records(endpoint_table, "endpoint")
    details_rows = _unique_upload_records(details_table, "detalhes")
    divergences = []

    for serial_key, manual_alias in manual_aliases.items():
        endpoint_record = endpoint_rows.get(serial_key)
        details_record = details_rows.get(serial_key)
        if endpoint_record is None and details_record is None:
            continue

        invall_alias = _upload_alias_value(endpoint_record, "endpoint") if endpoint_record else ""
        details_alias = _upload_alias_value(details_record, "detalhes") if details_record else ""
        details_differs = (
            details_record is not None
            and normalize_reference_value(details_alias) != normalize_reference_value(manual_alias)
        )
        invall_differs = (
            endpoint_record is not None
            and normalize_reference_value(invall_alias) != normalize_reference_value(manual_alias)
        )
        source_serial = (
            _upload_serial_value(details_record, "detalhes") if details_record else ""
        ) or (
            _upload_serial_value(endpoint_record, "endpoint") if endpoint_record else ""
        ) or serial_key
        divergences.append({
            "serie": str(source_serial).strip(),
            "apelido_manual": manual_alias,
            "apelido_equipamentos_detalhes": details_alias,
            "apelido_invall": invall_alias,
            "detalhes_encontrado": details_record is not None,
            "invall_encontrado": endpoint_record is not None,
            "diverge_detalhes": details_differs,
            "diverge_invall": invall_differs,
            "resolucao": "pendente",
        })

    return sorted(divergences, key=lambda item: normalize_reference_value(item["serie"]))


def _manual_alias_divergences(
    overrides: Dict[str, str],
    endpoint_table: Dict[str, Any],
    details_table: Dict[str, Any],
) -> List[Dict[str, Any]]:
    return [
        item for item in _manual_alias_source_snapshots(overrides, endpoint_table, details_table)
        if item["diverge_detalhes"] or item["diverge_invall"]
    ]


def validate_uploaded_workbook(file_bytes: bytes, role: str) -> Dict[str, Any]:
    return select_upload_table(read_workbook_tables(file_bytes), role)


def load_export_model_aliases() -> Dict[str, str]:
    """Lê os apelidos do modelo fixo usado como base de exportação."""
    if not EXPORT_MODEL_FILE.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"O modelo de exportação '{EXPORT_MODEL_FILE.name}' não foi encontrado."
        )

    workbook = None
    try:
        validate_xlsx(EXPORT_MODEL_FILE)
        workbook = openpyxl.load_workbook(EXPORT_MODEL_FILE, read_only=True, data_only=True)
        for worksheet in workbook.worksheets:
            header_row = [cell.value for cell in next(worksheet.iter_rows(max_row=1), ())]
            serial_col = find_workbook_header_column(header_row, DETAILS_SERIAL_HEADER_ALIASES)
            alias_col = find_workbook_header_column(header_row, ("APELIDO",))
            if serial_col is None or alias_col is None:
                continue

            aliases_by_serial: Dict[str, List[str]] = {}
            for row in worksheet.iter_rows(min_row=2, values_only=True):
                serial = row[serial_col] if serial_col < len(row) else None
                if serial is None or not str(serial).strip():
                    continue
                alias = row[alias_col] if alias_col < len(row) else None
                serial_key = normalize_reference_value(serial)
                if serial_key:
                    aliases_by_serial.setdefault(serial_key, []).append("" if alias is None else str(alias).strip())
            return {
                serial: values[0]
                for serial, values in aliases_by_serial.items()
                if len(values) == 1
            }

        raise HTTPException(
            status_code=500,
            detail=f"O modelo '{EXPORT_MODEL_FILE.name}' não contém as colunas NumeroSerie e Apelido."
        )
    except HTTPException:
        raise
    except WORKBOOK_READ_ERRORS as error:
        logger.warning(
            "Falha ao ler modelo (arquivo=%s, papel=exportacao, erro=%s).",
            EXPORT_MODEL_FILE.name, type(error).__name__,
        )
        raise HTTPException(
            status_code=500,
            detail="Não foi possível ler o modelo de exportação."
        ) from None
    finally:
        if workbook is not None:
            workbook.close()


def load_endpoint_aliases() -> Dict[str, str]:
    """Lê somente séries únicas com hostname preenchido na InvAll ativa."""
    return read_endpoint_alias_index()["unique"]


def read_endpoint_alias_index() -> Dict[str, Any]:
    """Retorna associações unívocas e linhas que precisam de conferência."""
    return effective_alias.read_endpoint_alias_index(_effective_alias_services)


endpoint_alias_review_items = effective_alias.endpoint_alias_review_items
_manual_alias_for_serial = effective_alias.manual_alias_for_serial
_manual_aliases_by_serial = effective_alias.manual_aliases_by_serial


def _apply_effective_alias(
    equipment: Dict[str, Any],
    endpoint_index: Optional[Dict[str, Any]] = None,
    *,
    details_duplicate: bool = False,
) -> None:
    if endpoint_index is None:
        with lock_paths([TRANSACTION_ROOT / ".atomic-transactions"]):
            with lock_paths([ENDPOINT_UPLOAD_FILE]):
                endpoint_index = read_endpoint_alias_index()
    effective_alias.apply_effective_alias(equipment, endpoint_index, details_duplicate=details_duplicate)


def get_export_aliases(endpoint_index: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Combina hostnames da InvAll com apelidos manuais, que têm prioridade."""
    endpoint_aliases = (
        endpoint_index.get("unique", {})
        if endpoint_index is not None
        else load_endpoint_aliases()
    )
    return effective_alias.merge_export_aliases(endpoint_aliases, load_modified_apelidos())


_effective_alias_services = effective_alias.EffectiveAliasServices(
    endpoint_upload_file=lambda: ENDPOINT_UPLOAD_FILE,
    validate_uploaded_workbook=lambda *args, **kwargs: validate_uploaded_workbook(*args, **kwargs),
    logger=logger,
)


_EXPORT_STATUS_LOCK = threading.Lock()
_EXPORT_COUNTS_LOCK = threading.Lock()
_EXPORT_STATUS = {"available": False, "reason": "A exportação ainda não foi conferida."}
_EXPORT_COUNTS_CACHE: Dict[Any, Dict[str, Any]] = {}


def _set_export_status(available: bool, reason: str) -> None:
    with _EXPORT_STATUS_LOCK:
        _EXPORT_STATUS.update({"available": available, "reason": reason})


def get_export_status() -> Dict[str, Any]:
    with _EXPORT_STATUS_LOCK:
        return dict(_EXPORT_STATUS)


def _export_files_signature() -> tuple:
    signature: List[Any] = []
    try:
        active_file = get_parque_file()
    except FileBusyError:
        active_file = None
    for path in (active_file, EXPORT_MODEL_FILE, ENDPOINT_UPLOAD_FILE, MODIFIED_APELIDOS_FILE):
        if path is None:
            signature.append(None)
            continue
        try:
            stat = path.stat()
            signature.append((str(path.resolve(strict=False)), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
        except OSError:
            signature.append((str(path.resolve(strict=False)), None))
    return tuple(signature)


def count_export_changes(
    locked: bool = False,
    endpoint_index: Optional[Dict[str, Any]] = None,
) -> Dict[str, int]:
    """Count writable alias and IdCliente cells that export would change."""
    empty_counts = {"apelidos": 0, "id_clientes": 0, "total": 0}

    def count() -> Dict[str, int]:
        source_file = get_parque_file()
        if source_file is None or not source_file.is_file() or not EXPORT_MODEL_FILE.is_file():
            _set_export_status(False, "A base ativa ou o modelo de exportação está ausente.")
            return empty_counts.copy()

        model_wb = None
        current_wb = None
        try:
            validate_xlsx(EXPORT_MODEL_FILE)
            model_wb = openpyxl.load_workbook(EXPORT_MODEL_FILE, read_only=True, data_only=False)
            model_sheet_name = next(
                (name for name in model_wb.sheetnames if "parque" in name.lower() or "equipamento" in name.lower()),
                model_wb.sheetnames[0],
            )
            model_ws = model_wb[model_sheet_name]
            model_headers = [cell.value for cell in next(model_ws.iter_rows(max_row=1), ())]
            model_serial_col = find_workbook_header_column(model_headers, DETAILS_SERIAL_HEADER_ALIASES)
            model_alias_col = find_workbook_header_column(model_headers, ("APELIDO",))
            model_id_col = find_workbook_header_column(model_headers, ("IDCLIENTE",))
            if model_serial_col is None or model_alias_col is None:
                _set_export_status(False, "O modelo de exportação não contém as colunas obrigatórias.")
                return empty_counts.copy()

            current_sheet_name = find_details_sheet(source_file)
            if current_sheet_name is None:
                _set_export_status(False, "A base ativa não contém uma aba de inventário compatível.")
                return empty_counts.copy()
            current_wb = openpyxl.load_workbook(source_file, read_only=True, data_only=False)
            current_ws = current_wb[current_sheet_name]
            current_headers = [cell.value for cell in next(current_ws.iter_rows(max_row=1), ())]
            current_serial_col = find_workbook_header_column(current_headers, DETAILS_SERIAL_HEADER_ALIASES)
            current_alias_col = find_workbook_header_column(current_headers, DETAILS_ALIAS_HEADER_ALIASES)
            current_id_col = find_workbook_header_column(current_headers, ("IDCLIENTE",))
            if current_serial_col is None or current_alias_col is None:
                _set_export_status(False, "A base ativa não contém as colunas de série e apelido.")
                return empty_counts.copy()

            current_rows: Dict[str, Dict[str, Any]] = {}
            for cells in current_ws.iter_rows(min_row=2, values_only=True):
                serial_key = normalize_reference_value(
                    cells[current_serial_col] if current_serial_col < len(cells) else None
                )
                if not serial_key:
                    continue
                if serial_key in current_rows:
                    _set_export_status(False, "A base ativa contém séries duplicadas; a exportação exige revisão.")
                    return empty_counts.copy()
                current_rows[serial_key] = {
                    "apelido": cells[current_alias_col] if current_alias_col < len(cells) else None,
                    "id_cliente": cells[current_id_col] if current_id_col is not None and current_id_col < len(cells) else None,
                }

            model_rows = []
            model_serial_counts: Dict[str, int] = {}
            for cells in model_ws.iter_rows(min_row=2):
                serial_key = normalize_reference_value(
                    cells[model_serial_col].value if model_serial_col < len(cells) else None
                )
                if not serial_key:
                    continue
                model_serial_counts[serial_key] = model_serial_counts.get(serial_key, 0) + 1
                model_rows.append((serial_key, cells))
            if set(model_serial_counts) != set(current_rows):
                _set_export_status(False, "O modelo e a base ativa não contêm o mesmo conjunto de séries.")
                return empty_counts.copy()

            effective_endpoint_index = endpoint_index if endpoint_index is not None else read_endpoint_alias_index()
            aliases = get_export_aliases(effective_endpoint_index)
            alias_count = 0
            id_cliente_count = 0
            for serial_key, cells in model_rows:
                if model_serial_counts.get(serial_key) != 1:
                    continue
                current = current_rows[serial_key]
                alias_cell = cells[model_alias_col] if model_alias_col < len(cells) else None
                if alias_cell is not None and alias_cell.data_type != "f":
                    updated_alias = aliases.get(serial_key, current["apelido"])
                    if updated_alias is None:
                        updated_alias = ""
                    if alias_cell.value != updated_alias:
                        alias_count += 1

                if model_id_col is not None and current_id_col is not None:
                    id_cell = cells[model_id_col] if model_id_col < len(cells) else None
                    if id_cell is not None and id_cell.data_type != "f":
                        updated_id = current["id_cliente"]
                        if updated_id is None:
                            updated_id = ""
                        if id_cell.value != updated_id:
                            id_cliente_count += 1

            _set_export_status(True, "OK")
            return {
                "apelidos": alias_count,
                "id_clientes": id_cliente_count,
                "total": alias_count + id_cliente_count,
            }
        except Exception as error:
            print(f"[AVISO] Contagem de exportação indisponível ({type(error).__name__}).")
            _set_export_status(False, "Não foi possível conferir o modelo e a base de exportação.")
            return empty_counts.copy()
        finally:
            if model_wb is not None:
                model_wb.close()
            if current_wb is not None:
                current_wb.close()

    def count_with_cache() -> Dict[str, int]:
        if endpoint_index is not None:
            return count()
        key = _export_files_signature()
        with _EXPORT_COUNTS_LOCK:
            cached = _EXPORT_COUNTS_CACHE.get(key)
            if cached is not None:
                _set_export_status(cached["available"], cached["reason"])
                return {name: cached[name] for name in empty_counts}
        values = count()
        status = get_export_status()
        with _EXPORT_COUNTS_LOCK:
            _EXPORT_COUNTS_CACHE.clear()
            _EXPORT_COUNTS_CACHE[key] = {
                **values,
                "available": status["available"],
                "reason": status["reason"],
            }
        return values

    if locked:
        return count_with_cache()
    with lock_paths([TRANSACTION_ROOT / ".atomic-transactions"]):
        detail_files = get_details_files()
        with lock_paths([
            *detail_files,
            ENDPOINT_UPLOAD_FILE,
            MODIFIED_APELIDOS_FILE,
            EXPORT_MODEL_FILE,
        ]):
            return count_with_cache()


def snapshot_equipment_aliases(
    equipment_records: Dict[str, Dict[str, Any]],
) -> Dict[str, Dict[str, str]]:
    """Captura apelidos únicos por série para comparar antes e depois da atualização."""
    by_serial: Dict[str, List[Dict[str, str]]] = {}
    for equipment in equipment_records.values():
        if equipment.get("invall_alias_status") == "serie_detalhes_duplicada":
            continue
        serial = str(equipment.get("serial") or "").strip()
        serial_key = normalize_reference_value(serial)
        if not serial_key:
            continue
        by_serial.setdefault(serial_key, []).append({
            "serie": serial,
            "apelido": str(equipment.get("apelido") or "").strip(),
        })

    # Não escolher automaticamente quando a mesma série aparece mais de uma vez.
    return {
        serial: records[0]
        for serial, records in by_serial.items()
        if len(records) == 1
    }


def compare_equipment_aliases(
    previous: Dict[str, Dict[str, str]],
    current: Dict[str, Dict[str, str]],
) -> List[Dict[str, str]]:
    """Lista mudanças de apelido entre duas cargas do cadastro, comparando por série."""
    changes = []
    for serial_key, updated in current.items():
        previous_record = previous.get(serial_key)
        if previous_record is None or previous_record["apelido"] == updated["apelido"]:
            continue
        changes.append({
            "serie": updated["serie"],
            "apelido_anterior": previous_record["apelido"],
            "apelido_novo": updated["apelido"],
        })
    return sorted(changes, key=lambda item: item["serie"])


def get_equipamentos_template_file() -> Optional[Path]:
    """Retorna a planilha EquipamentosDetalhes usada pelo site."""
    return get_primary_equipment_file()

def get_parque_file() -> Optional[Path]:
    """Retorna a fonte EquipamentosDetalhes carregada pelo site."""
    return get_equipamentos_template_file()

@asynccontextmanager
async def lifespan(app: FastAPI):
    def prepare_local_state() -> None:
        """Recover, migrate, prune and load disk state in one worker thread."""
        # A diverged journal keeps the server up in read-only mode; maintenance writes wait.
        if _recover_pending_transactions_at_startup():
            try:
                migration_result = migrate_legacy_history_annotations()
                if migration_result.get("legadas_enfileiradas"):
                    logger.info(
                        "Anotações legadas preparadas para sincronização: %s.",
                        migration_result,
                    )
            except Exception:
                logger.exception("Falha ao migrar anotações legadas do histórico de planilhas.")
            try:
                prune_result = prune_expired_histories()
                if any(prune_result.values()):
                    print(f"[RETENÇÃO] Registros e backups removidos conforme política de {HISTORY_RETENTION_DAYS} dias: {prune_result}.")
            except Exception as error:
                print(f"[AVISO] A retenção automática não pôde ser concluída ({type(error).__name__}); os arquivos foram preservados.")
        try:
            load_database()
        except LocalJsonCorruptionError as error:
            print(f"[INDISPONÍVEL] Estado local preservado: {error}")
        _report_startup_readiness_best_effort()

    # Workers start only after the base is loaded, as before; disk work stays off the loop.
    await asyncio.to_thread(prepare_local_state)
    background_tasks: List[asyncio.Task] = []
    try:
        background_tasks.extend((
            asyncio.create_task(_history_annotation_sync_worker()),
            asyncio.create_task(_automatic_inventory_import_worker()),
            asyncio.create_task(_automatic_ticket_import_worker()),
        ))
        yield
    finally:
        for task in background_tasks:
            task.cancel()
        await asyncio.gather(
            *background_tasks,
            return_exceptions=True,
        )


def _flush_pending_history_annotations_unless_blocked() -> None:
    # The outbox keeps every note; retrying against a blocked journal would only repeat the error.
    if get_transaction_recovery_block() is None:
        flush_pending_history_annotations()


async def _history_annotation_sync_worker() -> None:
    while True:
        await asyncio.sleep(60)
        try:
            await asyncio.to_thread(_flush_pending_history_annotations_unless_blocked)
        except Exception:
            logger.exception("Falha inesperada ao tentar sincronizar anotações pendentes.")


async def _automatic_inventory_import_worker() -> None:
    inbox = AutomaticInventoryInbox(
        root=AUTOMATIC_INVENTORY_INBOX_DIR,
        max_upload_bytes=MAX_UPLOAD_BYTES,
        load_history=load_comparison_history,
        import_batch=_import_automatic_inventory_batch,
    )
    logger.info("Entrada automática de planilhas ativa em %s.", AUTOMATIC_INVENTORY_INBOX_DIR)
    await run_automatic_inventory_import_worker(
        inbox,
        poll_interval_seconds=AUTOMATIC_INVENTORY_IMPORT_POLL_SECONDS,
    )


async def _automatic_ticket_import_worker() -> None:
    endpoint = next((
        route.endpoint
        for route in operations_router.routes
        if getattr(route, "path", None) == "/api/operacoes/chamados/importar"
        and "POST" in getattr(route, "methods", set())
    ), None)
    if endpoint is None:
        raise RuntimeError("A rota de importação de chamados não está registrada.")

    def import_batch(batch_id: str, simpress_name: str, simpress_bytes: bytes, oracle_name: str, oracle_bytes: bytes):
        _raise_if_transaction_recovery_blocked()
        simpress_upload = StarletteUploadFile(filename=simpress_name, file=io.BytesIO(simpress_bytes))
        oracle_upload = StarletteUploadFile(filename=oracle_name, file=io.BytesIO(oracle_bytes))
        return endpoint(
            simpress_file=simpress_upload,
            oracle_file=oracle_upload,
            automatic_import_id=batch_id,
        )

    inbox = AutomaticTicketInbox(
        root=AUTOMATIC_TICKET_INBOX_DIR,
        report_path=TICKET_REPORT_FILE,
        max_upload_bytes=MAX_TICKET_WORKBOOK_BYTES,
        import_batch=import_batch,
    )
    logger.info("Entrada automática de chamados ativa em %s.", AUTOMATIC_TICKET_INBOX_DIR)
    await run_automatic_ticket_import_worker(
        inbox,
        poll_interval_seconds=AUTOMATIC_TICKET_IMPORT_POLL_SECONDS,
    )


app = FastAPI(
    title="Simpress Transferência de Equipamentos - SEBRAE/PR",
    description="Sistema inteligente para emissão automatizada de planilhas oficiais de transferência de equipamentos.",
    version="1.3.0",
    lifespan=lifespan,
)

app.add_middleware(InventoryUpdateMiddleware)


SERVER_PORT = int(os.environ.get("SIMPRESS_PORT", "8000"))
IDEMPOTENT_UPLOAD_ADMISSION_WAIT_SECONDS = 120

_ALLOWED_LOCAL_AUTHORITIES = allowed_local_authorities(SERVER_PORT)
_parse_request_authority = parse_request_authority

_local_request_safety_services = LocalRequestSafetyServices(
    allowed_authorities=lambda: _ALLOWED_LOCAL_AUTHORITIES,
    inventory_upload_paths=lambda: INVENTORY_UPLOAD_PATHS,
    body_limits=lambda: RequestBodyLimits(
        upload_request_bytes=MAX_UPLOAD_REQUEST_BYTES,
        upload_bytes=MAX_UPLOAD_BYTES,
        ticket_workbook_bytes=MAX_TICKET_WORKBOOK_BYTES,
        api_request_bytes=MAX_API_REQUEST_BYTES,
    ),
    upload_admission=lambda: UPLOAD_ADMISSION,
    idempotent_upload_wait_seconds=lambda: IDEMPOTENT_UPLOAD_ADMISSION_WAIT_SECONDS,
    service_unavailable_errors=(LocalJsonCorruptionError,),
)


class LocalRequestSafetyMiddleware(_LocalRequestSafetyMiddleware):
    """Restrict local peers and authorities, cap uploads, and hide exceptions."""

    def __init__(self, app):
        super().__init__(app, _local_request_safety_services)


app.add_middleware(LocalRequestSafetyMiddleware)

# In-memory storage
equipamentos_cache: Dict[str, Dict[str, Any]] = {}
unidades_cache: List[Dict[str, Any]] = []
stats_cache: Dict[str, Any] = {}
_EQUIPMENT_SEARCH_INDEX: Tuple[EquipmentSearchIndexEntry, ...] = ()
_EQUIPMENT_SEARCH_INDEX_SOURCE = None

def format_cep(val: Any) -> str:
    if val is None:
        return ""
    if is_missing_cell_value(val):
        return ""
    original = str(val).strip()
    if not original:
        return ""
    digits = re.sub(r"\D", "", original)
    if len(digits) != 8:
        return original
    return f"{digits[:5]}-{digits[5:]}"

def get_suggested_description(tipo: Optional[str], modelo: Optional[str]) -> str:
    t = (tipo or "").strip().lower()
    m = (modelo or "").strip()
    if "notebook" in t:
        return "Notebook + kit na mochila"
    elif "micro" in t or "computador" in t:
        return f"{m} + cabos e periféricos"
    elif "headset" in t:
        return f"Headset {m}"
    return f"{tipo} {m}".strip() if tipo else m

def sanitize_value(val: Any, default: str = "") -> str:
    if is_missing_cell_value(val):
        return default
    return str(val).strip()

def load_custom_units() -> List[Dict[str, Any]]:
    if not CUSTOM_UNIDADES_FILE.exists():
        return []
    try:
        value = json.loads(CUSTOM_UNIDADES_FILE.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise LocalJsonCorruptionError("O catálogo local de unidades está ilegível; os dados foram preservados.") from error
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise LocalJsonCorruptionError("O catálogo local de unidades precisa conter uma lista de registros.")
    for item in value:
        if any(field in item and not isinstance(item[field], (str, int, float, bool, type(None))) for field in ("id", "cidade", "endereco", "uf", "cep", "cnpj")):
            raise LocalJsonCorruptionError("O catálogo local de unidades contém campos com tipos inválidos.")
    return value


def _history_event_datetime(event: Dict[str, Any]) -> Optional[datetime]:
    try:
        value = datetime.fromisoformat(str(event.get("horario") or "").replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    return value.astimezone()


def _backup_directory_from_history(event: Dict[str, Any]) -> Optional[Path]:
    comparison = event.get("comparacao")
    relative_value = comparison.get("backup_diretorio") if isinstance(comparison, dict) else None
    if not isinstance(relative_value, str) or not relative_value.strip():
        return None
    relative = Path(relative_value)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        return None
    candidate = (INPUT_DIR / relative).resolve(strict=False)
    backup_root = UPLOAD_BACKUPS_DIR.resolve(strict=False)
    if candidate.parent != backup_root:
        return None
    return candidate


def prune_expired_histories(now: Optional[datetime] = None) -> Dict[str, int]:
    """Apply the approved 90-day policy and remove only verified, unreferenced backups."""
    current_time = (now or datetime.now().astimezone()).astimezone()
    cutoff = current_time - timedelta(days=HISTORY_RETENTION_DAYS)
    results = {"apelidos_removidos": 0, "comparacoes_removidas": 0, "backups_removidos": 0}
    expired_backup_paths: Set[Path] = set()
    active_backup_paths: Set[Path] = set()
    targets = [path for path in (ALIAS_HISTORY_FILE, COMPARISON_HISTORY_FILE) if path.exists()]

    # The transaction's file locks serialize the histories; holding the Python
    # history locks here would invert the global → file → leaf order.
    if targets:
        with AtomicFileTransaction(TRANSACTION_ROOT, targets) as transaction:
            if ALIAS_HISTORY_FILE in targets:
                def keep_alias_events(value):
                    events = _validate_json_history(value, "apelidos")
                    kept = []
                    for event in events:
                        timestamp = _history_event_datetime(event)
                        if timestamp is not None and timestamp < cutoff:
                            results["apelidos_removidos"] += 1
                        else:
                            kept.append(event)
                    return kept
                transaction.update_json(ALIAS_HISTORY_FILE, keep_alias_events, [])

            if COMPARISON_HISTORY_FILE in targets:
                def keep_comparison_events(value):
                    events = _validate_json_history(value, "comparações")
                    kept = []
                    for event in events:
                        timestamp = _history_event_datetime(event)
                        is_pinned = event.get("id") == PINNED_COMPARISON_EVENT_ID
                        if not is_pinned and timestamp is not None and timestamp < cutoff:
                            backup_path = _backup_directory_from_history(event)
                            if backup_path is not None:
                                expired_backup_paths.add(backup_path)
                            results["comparacoes_removidas"] += 1
                            continue
                        kept.append(event)
                        backup_path = _backup_directory_from_history(event)
                        if backup_path is not None:
                            active_backup_paths.add(backup_path)
                    return kept
                transaction.update_json(COMPARISON_HISTORY_FILE, keep_comparison_events, [])
            transaction.commit()

    if UPLOAD_BACKUPS_DIR.is_symlink() or not UPLOAD_BACKUPS_DIR.is_dir():
        return results
    backup_root = UPLOAD_BACKUPS_DIR.resolve(strict=False)
    if backup_root.parent != INPUT_DIR.resolve(strict=False):
        return results
    expired_directories: List[Path] = []
    for path in backup_root.iterdir():
        if path.is_symlink() or not path.is_dir():
            continue
        resolved = path.resolve(strict=False)
        if resolved.parent != UPLOAD_BACKUPS_DIR.resolve(strict=False) or resolved in active_backup_paths:
            continue
        expired = resolved in expired_backup_paths
        if not expired:
            try:
                modified = datetime.fromtimestamp(path.stat().st_mtime).astimezone()
                expired = modified < cutoff
            except OSError:
                continue
        if expired:
            expired_directories.append(path)

    # Remove after enumeration; deleting while iterating a Windows directory can
    # cause the iterator to stop before other expired directories are visited.
    for path in expired_directories:
        try:
            shutil.rmtree(path)
            results["backups_removidos"] += 1
        except OSError as error:
            print(f"[AVISO] Não foi possível remover backup vencido '{path.name}': {type(error).__name__}.")
    return results


def _validate_json_history(value: Any, label: str) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise LocalJsonCorruptionError(f"O histórico local de {label} precisa conter uma lista de registros.")
    return value


def _coerce_unit_id(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        unit_id = int(value)
    except (TypeError, ValueError):
        return None
    return unit_id if unit_id > 0 else None


def _unit_identity_key(unit: Dict[str, Any]) -> str:
    return "\x1f".join(
        unicodedata.normalize("NFKC", str(unit.get(field) or "")).strip().casefold()
        for field in ("cidade", "endereco", "cnpj", "uf")
    )


def _stable_unit_source_key(unit: Dict[str, Any]) -> str:
    """Keep inventory identity stable while editable location fields change."""
    return hashlib.sha256(_unit_identity_key(unit).encode("utf-8")).hexdigest()


def _stable_unit_id(unit: Dict[str, Any], reserved_ids: Set[int]) -> int:
    """Return a deterministic numeric ID for inventory-derived units."""
    identity = _unit_identity_key(unit)
    collision_index = 0
    while True:
        seed = identity if collision_index == 0 else f"{identity}\x1f{collision_index}"
        candidate = int.from_bytes(hashlib.sha256(seed.encode("utf-8")).digest()[:6], "big") or 1
        if candidate not in reserved_ids:
            return candidate
        collision_index += 1


def load_database(transaction_locked: bool = False, publish: bool = True) -> Any:
    if transaction_locked:
        return _load_database_unlocked(publish=publish)
    with lock_paths([TRANSACTION_ROOT / ".atomic-transactions"]):
        detail_files = get_details_files()
        with lock_paths([
            *detail_files,
            ENDPOINT_UPLOAD_FILE,
            MODIFIED_APELIDOS_FILE,
            CUSTOM_UNIDADES_FILE,
            EXPORT_MODEL_FILE,
        ]):
            return _load_database_unlocked(publish=publish)


def prepare_database_state(
    equipment_cache: Dict[str, Dict[str, Any]],
    unit_cache: List[Dict[str, Any]],
    stats: Dict[str, Any],
) -> Dict[str, Any]:
    """Build every derived cache before a disk transaction is committed."""
    return {
        "equipamentos_cache": equipment_cache,
        "unidades_cache": unit_cache,
        "stats_cache": stats,
        "equipment_search_index": build_search_index(
            equipment_cache,
            _normalizar_termo_busca,
        ),
    }


def publish_database_state(state: Dict[str, Any]) -> None:
    global equipamentos_cache, unidades_cache, stats_cache
    global _EQUIPMENT_SEARCH_INDEX, _EQUIPMENT_SEARCH_INDEX_SOURCE
    with STATE_LOCK:
        equipamentos_cache = state["equipamentos_cache"]
        unidades_cache = state["unidades_cache"]
        stats_cache = state["stats_cache"]
        _EQUIPMENT_SEARCH_INDEX = state["equipment_search_index"]
        _EQUIPMENT_SEARCH_INDEX_SOURCE = equipamentos_cache


def _load_database_unlocked(publish: bool = True) -> Any:
    global equipamentos_cache, unidades_cache, stats_cache
    try:
        active_details_file = get_parque_file()
    except FileBusyError as error:
        print(f"[AVISO] {error} A base carregada foi mantida.")
        return False
    if active_details_file is None or not active_details_file.exists():
        print(f"[AVISO] Nenhuma planilha EquipamentosDetalhes válida encontrada em {INPUT_DIR}!")
        return False

    print(f"[INFO] Carregando equipamentos de {active_details_file.name}...")
    
    # Usa a aba com os campos necessários, sem depender do nome da aba.
    try:
        sheet_target = find_details_sheet(active_details_file)
        if sheet_target is None:
            print(f"[ERRO] {active_details_file.name} não contém cabeçalhos EquipamentosDetalhes válidos.")
            return False
        headers, records = _read_details_sheet_records(active_details_file, sheet_target)
    except (FileBusyError, *WORKBOOK_READ_ERRORS) as error:
        logger.warning(
            "Falha ao ler base de equipamentos (arquivo=%s, papel=detalhes, erro=%s).",
            active_details_file.name, type(error).__name__,
        )
        return False

    # Strip column names e criar mapa normalizado de colunas
    norm_cols = {normalize_workbook_header(column): column for column in headers}
    new_equipamentos_cache: Dict[str, Dict[str, Any]] = {}
    details_serial_counts: Dict[str, int] = {}
    tipo_header_aliases = DETAILS_TYPE_HEADER_ALIASES

    def get_row_val(row, *aliases, default=""):
        for a in aliases:
            key = normalize_workbook_header(a)
            if key in norm_cols:
                val = row.get(norm_cols[key])
                if not is_missing_cell_value(val):
                    return sanitize_value(val, default)
        return default

    def get_installation_cnpj(row):
        value = get_row_val(row, *DETAILS_INSTALLATION_CNPJ_HEADER_ALIASES)
        if value:
            return value
        for normalized_header, source_header in norm_cols.items():
            if (
                "CNPJ" in normalized_header
                and ("INSTALACAO" in normalized_header or "FILIAL" in normalized_header)
                and "FATURAMENTO" not in normalized_header
            ):
                raw_value = row.get(source_header)
                if not is_missing_cell_value(raw_value):
                    return sanitize_value(raw_value)
        return ""

    unidades_dict: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    sede_cnpjs = set()

    for row in records:
        raw_serial = get_row_val(row, *DETAILS_SERIAL_HEADER_ALIASES)
        if not raw_serial:
            continue
        
        serial_key = raw_serial.upper()
        normalized_serial = normalize_reference_value(raw_serial)
        details_serial_counts[normalized_serial] = details_serial_counts.get(normalized_serial, 0) + 1
        modelo = get_row_val(row, "Modelo")
        tipo = get_row_val(row, *tipo_header_aliases)
        apelido = get_row_val(row, *DETAILS_ALIAS_HEADER_ALIASES)
        id_cliente = get_row_val(row, "IdCliente", "Id Cliente")
        endereco = get_row_val(row, "Endereco", "Endereço")
        cidade = get_row_val(row, "Cidade")
        uf = get_row_val(row, "UF", default="PR")
        raw_cep = get_row_val(row, "CEP")
        cep_formatado = format_cep(raw_cep)
        
        cnpj_instalacao = get_installation_cnpj(row)

        contrato_value = get_row_val(
            row, "CodigoContrato", "Codigo Contrato", default=str(SUPPORTED_CONTRACT)
        )
        contrato = normalize_contract_value(contrato_value) or str(SUPPORTED_CONTRACT)
        if contrato != str(SUPPORTED_CONTRACT):
            print(
                f"[ERRO] A base contém contrato {contrato}; somente o contrato "
                f"{SUPPORTED_CONTRACT} é suportado. O cache anterior foi mantido."
            )
            return False
        razao_social = get_row_val(
            row, "RazaoSocial", "Razao Social", default=SUPPORTED_CONTRACT_LEGAL_NAME
        ) or SUPPORTED_CONTRACT_LEGAL_NAME

        # Check if Sede Curitiba
        is_sede = ("caeté" in endereco.lower() or "caete" in endereco.lower() or "sede" in endereco.lower() or "sede" in cidade.lower()) and ("curitiba" in cidade.lower() or "sede" in cidade.lower())
        if is_sede:
            if cnpj_instalacao:
                sede_cnpjs.add(cnpj_instalacao)
            endereco = "R Caeté, 150 - SEDE - Prado Velho"
            cidade = "Curitiba"
            uf = "PR"
            cep_formatado = "80220-300"
            retirada_endereco = "R Caeté, 150 - SEDE - Prado Velho - Curitiba/PR - CEP 80220-300"
        else:
            retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep_formatado}" if endereco else f"{cidade}/{uf}"

        # Suggested description
        desc_sugerida = get_suggested_description(tipo, modelo)

        new_equipamentos_cache[serial_key] = {
            "serial": raw_serial,
            "_source_file": str(active_details_file.resolve()),
            "_source_sheet": sheet_target,
            "modelo": modelo,
            "tipo": tipo,
            "apelido": apelido,
            "_apelido_base": apelido,
            "_apelido_local": apelido,
            "idCliente": id_cliente,
            "descricao_sugerida": desc_sugerida,
            "endereco_instalacao": endereco,
            "retirada_cnpj": cnpj_instalacao,
            "retirada_endereco": retirada_endereco,
            "retirada_cidade": cidade,
            "retirada_uf": uf,
            "retirada_cep": cep_formatado,
            "contrato": contrato,
            "razao_social": razao_social
        }

        # Candidate unit
        if cidade or endereco:
            u_key = (cidade.strip(), endereco.strip(), cnpj_instalacao.strip())
            if u_key not in unidades_dict:
                unidades_dict[u_key] = {
                    "cidade": cidade.strip(),
                    "endereco": endereco.strip(),
                    "uf": uf.strip(),
                    "cep": cep_formatado.strip(),
                    "cnpj": cnpj_instalacao.strip(),
                    "retirada_endereco": retirada_endereco
                }

    if not new_equipamentos_cache:
        print(f"[ERRO] {active_details_file.name} não contém equipamentos com número de série; os dados atuais foram mantidos.")
        return False

    # Filter units according to user specifications:
    filtered_units: List[Dict[str, Any]] = []
    for u in unidades_dict.values():
        cid_lower = u["cidade"].lower()
        end_lower = u["endereco"].lower()

        # 1. Curitiba: remover todas as outras (oficial Curitiba SEDE será inserido exclusivamente)
        if "curitiba" in cid_lower:
            continue

        # 2. Cascavel: somente ao lado da Plantar
        if "cascavel" in cid_lower:
            if "plantar" not in end_lower:
                continue

        # 3. Foz do Iguaçu: só deixe uma (duplicada)
        if "foz do igua" in cid_lower:
            if any("foz do igua" in x["cidade"].lower() for x in filtered_units):
                continue

        # 4. Maringá: deixe só o Terreo
        if "maring" in cid_lower:
            if "terreo" not in end_lower and "térreo" not in end_lower:
                continue

        # 5. Telêmaco Borba: deixe só o da Sala 1
        if "tel" in cid_lower and "borba" in cid_lower:
            if "sala 1" not in end_lower:
                continue

        # 6. Toledo: deixe só com os caracteres minúsculos (ignorar a versão em CAIXA ALTA)
        if "toledo" in cid_lower:
            if u["endereco"].isupper():
                continue

        filtered_units.append(u)

    # Inserir o Curitiba oficial com o padrão exato solicitado
    sede_cnpj = next(iter(sede_cnpjs)) if len(sede_cnpjs) == 1 else ""
    if len(sede_cnpjs) > 1:
        print("[AVISO] A base contém mais de um CNPJ de instalação para a Sede Curitiba; o CNPJ da unidade ficou vazio.")
    curitiba_label = "Curitiba - R Caeté, 150 - SEDE - Prado Velho"
    if sede_cnpj:
        curitiba_label += f" ({sede_cnpj})"
    curitiba_oficial = {
        "cidade": "Curitiba",
        "endereco": "R Caeté, 150 - SEDE - Prado Velho",
        "uf": "PR",
        "cep": "80220-300",
        "cnpj": sede_cnpj,
        "is_sede": True,
        "endereco_completo": "R Caeté, 150 - SEDE - Prado Velho - Curitiba/PR - CEP 80220-300",
        "label": curitiba_label,
    }
    curitiba_oficial["_source_key"] = _stable_unit_source_key(curitiba_oficial)

    final_units = [curitiba_oficial]
    for u in filtered_units:
        final_units.append({
            "cidade": u["cidade"],
            "endereco": u["endereco"],
            "uf": u["uf"],
            "cep": u["cep"],
            "cnpj": u["cnpj"],
            "is_sede": False,
            "endereco_completo": u["retirada_endereco"],
            "label": f"{u['cidade']} - {u['endereco']}" + (f" ({u['cnpj']})" if u["cnpj"] else ""),
            "_source_key": _stable_unit_source_key(u),
        })

    # Mesclar unidades customizadas/editadas pelo usuário
    custom_units = load_custom_units()
    for cu in custom_units:
        source_key = cu.get("_source_key")
        if source_key:
            match = next((x for x in final_units if x.get("_source_key") == source_key), None)
        else:
            match = next((
                x for x in final_units
                if str(x.get("cidade") or "").lower() == str(cu.get("cidade") or "").lower()
                and x.get("cnpj") == cu.get("cnpj")
            ), None)
        if match:
            match.update(cu)
        else:
            final_units.append(cu)

    # Sort for display, but retain persisted IDs and give inventory-derived
    # units a deterministic ID that does not depend on their position.
    new_unidades_cache = sorted(final_units, key=lambda u: (not u.get("is_sede", False), u.get("cidade", ""), u.get("endereco", "")))
    reserved_unit_ids = {
        unit_id
        for unit in custom_units
        if (unit_id := _coerce_unit_id(unit.get("id"))) is not None
    }
    reserved_unit_ids.update(
        unit_id
        for unit in new_unidades_cache
        if (unit_id := _coerce_unit_id(unit.get("id"))) is not None
    )
    for unit in new_unidades_cache:
        if _coerce_unit_id(unit.get("id")) is not None:
            continue
        generated_id = _stable_unit_id(unit, reserved_unit_ids)
        unit["id"] = generated_id
        reserved_unit_ids.add(generated_id)

    # Apelidos manuais persistem por série e prevalecem sobre o hostname da InvAll.
    mod_apelidos = load_modified_apelidos()
    manual_aliases = _manual_aliases_by_serial(mod_apelidos)
    endpoint_index = read_endpoint_alias_index()
    for serial_key, equipment in new_equipamentos_cache.items():
        equipment["_revisao"] = _equipment_revision(
            equipment.get("serial"),
            equipment.get("modelo"),
            equipment.get("tipo"),
            equipment.get("_apelido_base"),
            equipment.get("idCliente"),
        )
        normalized_serial = normalize_reference_value(equipment.get("serial"))
        equipment["_apelido_manual_override"] = normalized_serial in manual_aliases
        equipment["_apelido_local"] = manual_aliases.get(
            normalized_serial, equipment.get("_apelido_base", "")
        )
        _apply_effective_alias(
            equipment,
            endpoint_index,
            details_duplicate=details_serial_counts.get(normalized_serial, 0) > 1,
        )

    # Calculate stats
    tipo_col_real = next(
        (
            norm_cols[normalized_header]
            for alias in tipo_header_aliases
            if (normalized_header := normalize_workbook_header(alias)) in norm_cols
        ),
        None,
    )
    type_counts = (
        dict(Counter(row.get(tipo_col_real, "") for row in records).most_common())
        if tipo_col_real is not None
        else {}
    )
    export_counts = count_export_changes(
        locked=True,
        endpoint_index=endpoint_index,
    )
    export_status = get_export_status()
    new_stats_cache = {
        "total_equipamentos": len(new_equipamentos_cache),
        "total_unidades": len(new_unidades_cache),
        "total_apelidos_modificados": export_counts["apelidos"],
        "total_id_clientes_modificados": export_counts["id_clientes"],
        "total_alteracoes_exportaveis": export_counts["total"],
        "exportacao_disponivel": export_status["available"],
        "exportacao_motivo": export_status["reason"],
        "tipos": type_counts,
        "arquivo_origem": active_details_file.name,
        "ultima_atualizacao": datetime.now().strftime("%d/%m/%Y %H:%M")
    }

    # Só publica os novos caches depois de ler, converter e validar toda a planilha.
    state = prepare_database_state(
        new_equipamentos_cache,
        new_unidades_cache,
        new_stats_cache,
    )
    if publish:
        publish_database_state(state)

    print(f"[SUCESSO] Base carregada: {len(new_equipamentos_cache)} equipamentos ({len(mod_apelidos)} com apelido modificado) e {len(new_unidades_cache)} unidades catalogadas.")
    if not publish:
        return state
    return True

# Models for API
def _validate_equipment_serial(value: str) -> str:
    """Apply the same non-empty serial semantics to every equipment edit route."""
    if not normalize_reference_value(value):
        raise ValueError("O número de série precisa conter letras ou números.")
    return value.strip()


class EquipamentoUpdatePayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128, description="Número de Série do Equipamento")
    novo: bool = Field(False, description="Indica que o formulário está cadastrando um equipamento novo")
    modelo: Optional[str] = Field("", max_length=300, description="Modelo do Equipamento")
    tipo: Optional[str] = Field("", max_length=120, description="Tipo (Notebook, Micro Computador, Headsets...)")
    apelido: Optional[str] = Field("", max_length=160, description="Apelido / Hostname")
    idCliente: Optional[str] = Field("", max_length=128, description="ID do Cliente")
    revisao: Optional[str] = Field(None, min_length=64, max_length=64)
    # Mantidos para compatibilidade com clientes antigos; a rota ignora esses campos.
    endereco: Optional[str] = Field("", max_length=500, description="Endereço carregado da Simpress")
    cidade: Optional[str] = Field("", max_length=160, description="Cidade carregada da Simpress")
    uf: Optional[str] = Field("PR", max_length=2, description="UF carregada da Simpress")
    cep: Optional[str] = Field("", max_length=12, description="CEP carregado da Simpress")
    cnpj_instalacao: Optional[str] = Field("", max_length=24, description="CNPJ carregado da Simpress")

    @field_validator("serial")
    @classmethod
    def validate_serial(cls, value: str) -> str:
        return _validate_equipment_serial(value)




class ApelidoUpdatePayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128, description="Número de Série do Equipamento")
    apelido: str = Field(..., max_length=160, description="Novo Apelido / Hostname do Equipamento")

    @field_validator("serial")
    @classmethod
    def validate_serial(cls, value: str) -> str:
        return _validate_equipment_serial(value)


class ApelidoUndoPayload(BaseModel):
    evento_id: str = Field(..., description="ID do evento de apelido que deve ser desfeito")


def _public_equipment(equipment: Dict[str, Any]) -> Dict[str, Any]:
    public = {key: value for key, value in equipment.items() if not key.startswith("_")}
    revision = equipment.get("_revisao")
    if revision:
        public["revisao"] = revision
    return public


def _edit_equipment_workbook(
    wb,
    payload: EquipamentoUpdatePayload,
    target_sheet_name: Optional[str] = None,
    record_must_exist: Optional[bool] = None,
    fields_to_update: Optional[Set[str]] = None,
    expected_revision: Optional[str] = None,
):
    if target_sheet_name is None:
        target_sheet_name = next(
            (name for name in wb.sheetnames if "equipamento" in name.lower() or "parque" in name.lower()),
            wb.sheetnames[0] if wb.sheetnames else None,
        )
    elif target_sheet_name not in wb.sheetnames:
        return None
    if target_sheet_name is None:
        return None
    ws = wb[target_sheet_name]
    header_row = [cell.value for cell in next(ws.iter_rows(max_row=1), ())]
    col_map = {
        normalize_workbook_header(value): index + 1
        for index, value in enumerate(header_row)
        if value is not None
    }
    serial_col = next(
        (col_map.get(alias) for alias in DETAILS_SERIAL_HEADER_ALIASES if col_map.get(alias)),
        None,
    )
    if not serial_col:
        return None

    target_serial = normalize_reference_value(payload.serial)
    matching_rows = [
        row for row in range(2, ws.max_row + 1)
        if normalize_reference_value(ws.cell(row=row, column=serial_col).value) == target_serial
        and target_serial
    ]
    if len(matching_rows) > 1:
        raise HTTPException(
            status_code=409,
            detail=f"A série {payload.serial.strip()} aparece mais de uma vez na aba '{ws.title}'; nenhum registro foi alterado.",
        )
    if matching_rows:
        contract_col = col_map.get("CODIGOCONTRATO") or col_map.get("CODIGODOCONTRATO")
        if contract_col:
            raw_contract = ws.cell(row=matching_rows[0], column=contract_col).value
            normalized_contract = normalize_contract_value(raw_contract)
            if normalized_contract and normalized_contract != str(SUPPORTED_CONTRACT):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"O equipamento pertence ao contrato {normalized_contract}; "
                        f"este sistema só edita o contrato {SUPPORTED_CONTRACT}."
                    ),
                )
    if matching_rows and expected_revision:
        target_row_for_revision = matching_rows[0]

        def row_value(*aliases: str) -> Any:
            column = next(
                (col_map.get(normalize_workbook_header(alias)) for alias in aliases
                 if col_map.get(normalize_workbook_header(alias))),
                None,
            )
            return ws.cell(row=target_row_for_revision, column=column).value if column else ""

        current_revision = _equipment_revision(
            ws.cell(row=target_row_for_revision, column=serial_col).value,
            row_value("MODELO"),
            row_value("TIPO", "CLASSEEQUIPAMENTO"),
            row_value(*DETAILS_ALIAS_HEADER_ALIASES),
            row_value("IDCLIENTE", "ID CLIENTE"),
        )
        if not hmac.compare_digest(expected_revision, current_revision):
            raise HTTPException(
                status_code=409,
                detail="O equipamento foi alterado desde a leitura; recarregue os dados antes de salvar.",
            )
    if record_must_exist is True and not matching_rows:
        raise HTTPException(
            status_code=409,
            detail=f"A série {payload.serial.strip()} não está mais na planilha ativa; recarregue o inventário antes de editar.",
        )
    if record_must_exist is False and matching_rows:
        raise HTTPException(
            status_code=409,
            detail=f"A série {payload.serial.strip()} já existe na planilha ativa; recarregue o inventário antes de cadastrar.",
        )
    target_row = matching_rows[0] if matching_rows else ws.max_row + 1
    expected: Dict[tuple, Any] = {}
    requested_fields = set(fields_to_update if fields_to_update is not None else payload.model_fields_set)

    def set_value(column: Optional[int], value: Any) -> None:
        if column is None:
            return
        cell = ws.cell(row=target_row, column=column)
        persisted_value = "" if value is None else value
        cell.value = persisted_value
        expected[(ws.title, cell.coordinate)] = persisted_value

    if not matching_rows:
        set_value(serial_col, payload.serial.strip().upper())
        set_value(col_map.get("CODIGOCONTRATO"), SUPPORTED_CONTRACT)
        set_value(col_map.get("ITEMDECONTRATO"), target_row - 1)
        set_value(col_map.get("RAZAOSOCIAL"), SUPPORTED_CONTRACT_LEGAL_NAME)

    fields = (
        ("apelido", col_map.get("APELIDO")),
        ("modelo", col_map.get("MODELO")),
        ("tipo", col_map.get("TIPO") or col_map.get("CLASSEEQUIPAMENTO")),
        ("idCliente", col_map.get("IDCLIENTE")),
    )
    for field_name, column in fields:
        if matching_rows and field_name not in requested_fields:
            continue
        value = getattr(payload, field_name)
        set_value(column, value.strip() if value is not None else "")

    if not matching_rows:
        from openpyxl.utils.cell import get_column_letter, range_boundaries

        for table in ws.tables.values():
            min_col, min_row, max_col, max_row = range_boundaries(table.ref)
            if min_row == 1 and max_row == target_row - 1 and min_col <= serial_col <= max_col:
                expanded_ref = (
                    f"{get_column_letter(min_col)}{min_row}:"
                    f"{get_column_letter(max_col)}{target_row}"
                )
                table.ref = expanded_ref
                if table.autoFilter is not None:
                    table.autoFilter.ref = expanded_ref

        if ws.auto_filter.ref:
            min_col, min_row, max_col, max_row = range_boundaries(ws.auto_filter.ref)
            if min_row == 1 and max_row == target_row - 1 and min_col <= serial_col <= max_col:
                ws.auto_filter.ref = (
                    f"{get_column_letter(min_col)}{min_row}:"
                    f"{get_column_letter(max_col)}{target_row}"
                )
    return expected


def update_equipment_in_workbook_file(
    file_path: Path,
    payload: EquipamentoUpdatePayload,
    transaction: Optional[AtomicFileTransaction] = None,
    target_sheet_name: Optional[str] = None,
    record_must_exist: Optional[bool] = None,
    fields_to_update: Optional[Set[str]] = None,
    expected_revision: Optional[str] = None,
) -> bool:
    """Prepare and validate a workbook update before its atomic replacement."""
    file_path = Path(file_path)
    if not file_path.exists():
        return False
    try:
        if transaction is not None:
            return stage_workbook_update(
                transaction,
                file_path,
                lambda wb: _edit_equipment_workbook(
                    wb, payload, target_sheet_name, record_must_exist, fields_to_update, expected_revision
                ),
                allow_dimension_growth=True,
                allow_table_growth=True,
            )
        with AtomicFileTransaction(TRANSACTION_ROOT, [file_path]) as own_transaction:
            saved = stage_workbook_update(
                own_transaction,
                file_path,
                lambda wb: _edit_equipment_workbook(
                    wb, payload, target_sheet_name, record_must_exist, fields_to_update, expected_revision
                ),
                allow_dimension_growth=True,
                allow_table_growth=True,
            )
            if saved:
                own_transaction.commit()
            return saved
    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível salvar '{file_path.name}': {error}") from error


def normalizar_endereco_instalacao(payload: EquipamentoUpdatePayload) -> Dict[str, str]:
    endereco = payload.endereco.strip() if payload.endereco else ""
    cidade = payload.cidade.strip() if payload.cidade else ""
    uf = (payload.uf.strip() if payload.uf else "PR").upper()
    cep = format_cep(payload.cep)
    cnpj = payload.cnpj_instalacao.strip() if payload.cnpj_instalacao else ""

    is_sede = (
        ("caeté" in endereco.lower() or "caete" in endereco.lower() or "sede" in endereco.lower() or "sede" in cidade.lower())
        and ("curitiba" in cidade.lower() or "sede" in cidade.lower())
    )
    if is_sede:
        endereco = "R Caeté, 150 - SEDE - Prado Velho"
        cidade = "Curitiba"
        uf = "PR"
        cep = "80220-300"

    return {
        "endereco": endereco,
        "cidade": cidade,
        "uf": uf,
        "cep": cep,
        "cnpj": cnpj,
    }


def snapshot_endereco_instalacao(equipamento: Dict[str, Any]) -> Dict[str, str]:
    return {
        "endereco": str(equipamento.get("endereco_instalacao") or "").strip(),
        "cidade": str(equipamento.get("retirada_cidade") or "").strip(),
        "uf": str(equipamento.get("retirada_uf") or "").strip(),
        "cep": str(equipamento.get("retirada_cep") or "").strip(),
        "cnpj": str(equipamento.get("retirada_cnpj") or "").strip(),
    }


def save_equipment_to_excel(
    payload: EquipamentoUpdatePayload,
    json_mutations: Optional[Dict[Path, Any]] = None,
    fields_to_update: Optional[Set[str]] = None,
):
    """Salva um equipamento somente na fonte e na aba associadas ao cache atual."""
    target_serial_upper = payload.serial.strip().upper()
    detail_files = [path for path in get_details_files() if path.is_file()]
    if not detail_files:
        raise HTTPException(status_code=404, detail="Nenhuma planilha da Simpress encontrada no servidor.")

    requested_fields = set(fields_to_update if fields_to_update is not None else payload.model_fields_set)
    json_mutations = dict(json_mutations or {})
    try:
        # Lock every candidate while resolving the current primary source. Only
        # that source is staged below; legacy copies remain untouched.
        transaction_targets = list(dict.fromkeys([
            *detail_files,
            ENDPOINT_UPLOAD_FILE,
            MODIFIED_APELIDOS_FILE,
            *json_mutations.keys(),
        ]))
        with AtomicFileTransaction(TRANSACTION_ROOT, transaction_targets) as transaction:
            with STATE_LOCK:
                next_equipment_cache = deepcopy(equipamentos_cache)
                next_unit_cache = deepcopy(unidades_cache)
                next_stats_cache = deepcopy(stats_cache)
            cached_equipment = deepcopy(next_equipment_cache.get(target_serial_upper))
            if cached_equipment is None and not payload.novo:
                raise HTTPException(
                    status_code=409,
                    detail="Este equipamento não está mais na base carregada; recarregue o inventário antes de editar.",
                )
            expected_revision = payload.revisao
            if cached_equipment is not None:
                current_revision = str(cached_equipment.get("_revisao") or "")
                if not expected_revision:
                    raise HTTPException(
                        status_code=409,
                        detail="A revisão deste equipamento não foi informada; recarregue-o antes de salvar.",
                    )
                if not hmac.compare_digest(expected_revision, current_revision):
                    raise HTTPException(
                        status_code=409,
                        detail="O equipamento foi alterado desde a leitura; recarregue os dados antes de salvar.",
                    )
            if cached_equipment is not None and payload.novo:
                raise HTTPException(
                    status_code=409,
                    detail="A série já pertence a um equipamento carregado; atualize o inventário antes de cadastrar outra vez.",
                )
            if cached_equipment is not None:
                if cached_equipment.get("invall_alias_status") == "serie_detalhes_duplicada":
                    raise HTTPException(
                        status_code=409,
                        detail=f"A série {target_serial_upper} está duplicada na base ativa; nenhum registro foi alterado.",
                    )
                # Preserve the latest local alias when this save waited behind
                # a concurrent alias edit, and discard a now-stale new-record override.
                payload.apelido = cached_equipment.get(
                    "_apelido_local", cached_equipment.get("_apelido_base", "")
                )
                json_mutations.pop(MODIFIED_APELIDOS_FILE, None)

            active_file = get_primary_equipment_file()
            if active_file is None or not active_file.is_file():
                raise HTTPException(status_code=404, detail="Nenhuma planilha válida da Simpress está ativa.")

            target_file = active_file.resolve()
            locked_files = {path.resolve() for path in detail_files}
            if target_file not in locked_files:
                raise HTTPException(
                    status_code=409,
                    detail="A lista de inventários mudou durante a edição; recarregue a base e tente novamente.",
                )

            cached_source = cached_equipment.get("_source_file") if cached_equipment else None
            if cached_source:
                if Path(cached_source).resolve() != target_file:
                    raise HTTPException(
                        status_code=409,
                        detail="A base ativa mudou depois que este equipamento foi carregado; recarregue-o antes de editar.",
                    )

            current_sheet = find_details_sheet(target_file)
            if current_sheet is None:
                raise HTTPException(status_code=409, detail="A base ativa não contém uma aba de equipamentos válida.")
            cached_sheet = cached_equipment.get("_source_sheet") if cached_equipment else None
            if cached_sheet and cached_sheet != current_sheet:
                raise HTTPException(
                    status_code=409,
                    detail="A aba de origem mudou depois que este equipamento foi carregado; recarregue-o antes de editar.",
                )
            target_sheet = cached_sheet or current_sheet

            saved = update_equipment_in_workbook_file(
                target_file,
                payload,
                transaction,
                target_sheet_name=target_sheet,
                record_must_exist=not payload.novo,
                fields_to_update=requested_fields,
                expected_revision=expected_revision,
            )
            if not saved:
                raise HTTPException(status_code=500, detail="Não foi possível atualizar o equipamento na planilha.")
            staged_json: Dict[Path, Any] = {}
            for path, updater in json_mutations.items():
                staged_json[path] = transaction.update_json(
                    path,
                    updater,
                    [] if path == ALIAS_HISTORY_FILE else {},
                )

            endereco_info = (
                snapshot_endereco_instalacao(cached_equipment)
                if cached_equipment
                else normalizar_endereco_instalacao(EquipamentoUpdatePayload(
                    serial=target_serial_upper,
                    novo=False,
                    modelo="",
                    tipo="",
                    apelido="",
                    idCliente="",
                    revisao=None,
                    endereco="",
                    cidade="",
                    uf="PR",
                    cep="",
                    cnpj_instalacao="",
                ))
            )
            endereco = endereco_info["endereco"]
            cidade = endereco_info["cidade"]
            uf = endereco_info["uf"]
            cep_formatado = endereco_info["cep"]
            cnpj_instalacao = endereco_info["cnpj"]
            retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep_formatado}" if endereco else f"{cidade}/{uf}"

            def updated_value(field_name: str, cache_key: str) -> str:
                if cached_equipment is not None and field_name not in requested_fields:
                    return str(cached_equipment.get(cache_key) or "").strip()
                value = getattr(payload, field_name)
                return value.strip() if value is not None else ""

            base_alias = updated_value("apelido", "_apelido_base")
            modelo = updated_value("modelo", "modelo")
            tipo = updated_value("tipo", "tipo")
            id_cliente = updated_value("idCliente", "idCliente")
            desc_sugerida = get_suggested_description(tipo, modelo)

            modified_aliases = staged_json.get(MODIFIED_APELIDOS_FILE)
            if not isinstance(modified_aliases, dict):
                modified_aliases = load_modified_apelidos()
            manual_aliases = _manual_aliases_by_serial(modified_aliases)
            normalized_serial = normalize_reference_value(target_serial_upper)
            local_alias = manual_aliases.get(normalized_serial, base_alias)
            updated_equipment = {
                "serial": target_serial_upper,
                "_source_file": str(target_file),
                "_source_sheet": target_sheet,
                "modelo": modelo,
                "tipo": tipo,
                "apelido": local_alias,
                "_apelido_base": base_alias,
                "_apelido_local": local_alias,
                "_apelido_manual_override": normalized_serial in manual_aliases,
                "_revisao": _equipment_revision(
                    target_serial_upper, modelo, tipo, base_alias, id_cliente
                ),
                "idCliente": id_cliente,
                "descricao_sugerida": desc_sugerida,
                "endereco_instalacao": endereco,
                "retirada_cnpj": cnpj_instalacao,
                "retirada_endereco": retirada_endereco,
                "retirada_cidade": cidade,
                "retirada_uf": uf,
                "retirada_cep": cep_formatado,
                "contrato": (
                    cached_equipment.get("contrato", str(SUPPORTED_CONTRACT))
                    if cached_equipment else str(SUPPORTED_CONTRACT)
                ),
                "razao_social": (
                    cached_equipment.get("razao_social", SUPPORTED_CONTRACT_LEGAL_NAME)
                    if cached_equipment else SUPPORTED_CONTRACT_LEGAL_NAME
                ),
            }

            endpoint_index = read_endpoint_alias_index()
            _apply_effective_alias(
                updated_equipment,
                endpoint_index,
                details_duplicate=bool(
                    cached_equipment
                    and cached_equipment.get("invall_alias_status") == "serie_detalhes_duplicada"
                ),
            )
            next_equipment_cache[target_serial_upper] = updated_equipment
            next_stats_cache["total_equipamentos"] = len(next_equipment_cache)
            next_stats_cache["ultima_atualizacao"] = datetime.now().strftime("%d/%m/%Y %H:%M")
            prepared_state = prepare_database_state(
                next_equipment_cache,
                next_unit_cache,
                next_stats_cache,
            )

            # All reads and derived data are prepared before the durable commit.
            # Publishing afterward only swaps already-built references.
            transaction.commit()
            publish_database_state(prepared_state)
            return updated_equipment, len(modified_aliases)
    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível concluir a gravação: {error}") from error


@app.get("/api/equipamento/apelidos-modificados")
def get_apelidos_modificados():
    """Retorna o registro de todos os apelidos que foram modificados pelo usuário."""
    apelidos = load_modified_apelidos()
    return {"total": len(apelidos), "apelidos": apelidos}


# Endpoints
@app.get("/api/equipamento/{serial}")
def get_equipamento(serial: str):
    """Busca um equipamento pelo número de série (sem distinção de maiúsculas/minúsculas)."""
    clean_serial = serial.strip().upper()
    with STATE_LOCK:
        equipment = deepcopy(equipamentos_cache.get(clean_serial))
    if equipment is not None:
        return _public_equipment(equipment)

    raise HTTPException(status_code=404, detail=f"Equipamento com serial '{serial}' não encontrado na base de dados.")


@app.post("/api/equipamento/salvar")
def salvar_equipamento(payload: EquipamentoUpdatePayload):
    """Atualiza ou cadastra um equipamento tanto na memória do site quanto diretamente na planilha Excel."""
    if not payload.serial or not payload.serial.strip():
        raise HTTPException(status_code=400, detail="Número de série é obrigatório.")
    if not normalize_reference_value(payload.serial):
        raise HTTPException(status_code=422, detail="O número de série precisa conter letras ou números.")
    
    target_serial = payload.serial.strip().upper()
    requested_fields = set(payload.model_fields_set)
    with STATE_LOCK:
        equipamento_existente = deepcopy(equipamentos_cache.get(target_serial))
    if payload.novo and equipamento_existente is not None:
        raise HTTPException(
            status_code=409,
            detail="A série já está cadastrada; atualize a base antes de criar um novo equipamento.",
        )
    if not payload.novo and equipamento_existente is None:
        raise HTTPException(
            status_code=409,
            detail="Este equipamento não está mais na base carregada; recarregue o inventário antes de editar.",
        )
    if equipamento_existente is not None and not payload.revisao:
        raise HTTPException(
            status_code=409,
            detail="A revisão deste equipamento não foi informada; recarregue-o antes de salvar.",
        )
    if equipamento_existente is not None:
        # Para equipamentos já cadastrados, o apelido só pode ser alterado pela rota dedicada.
        # Isso impede que o formulário de dados/endereço sobrescreva apelidos acidentalmente.
        # Keep the stored EquipamentosDetalhes alias, not its InvAll presentation value.
        payload.apelido = equipamento_existente.get("_apelido_local", equipamento_existente.get("_apelido_base", ""))

    json_mutations = {}
    if equipamento_existente is None and payload.apelido is not None and payload.apelido.strip():
        new_alias = payload.apelido.strip()
        def save_new_alias(data):
            aliases = dict(_validate_json_object(data, "apelidos"))
            for key in list(aliases):
                if normalize_reference_value(key) == normalize_reference_value(target_serial):
                    aliases.pop(key, None)
            aliases[target_serial] = new_alias
            return aliases
        json_mutations[MODIFIED_APELIDOS_FILE] = save_new_alias

    saved_equipment, modified_alias_count = save_equipment_to_excel(
        payload,
        json_mutations=json_mutations,
        fields_to_update=requested_fields,
    )
    return {
        "sucesso": True,
        "mensagem": f"Equipamento {target_serial} atualizado com sucesso no site e na planilha Excel!",
        "equipamento": _public_equipment(saved_equipment),
        "total_modificados": modified_alias_count,
    }


def aplicar_alteracao_apelido(
    target_serial: str,
    novo_apelido: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
    registrar_historico: bool = True,
    expected_current_local: Optional[str] = None,
    expected_latest_event_id: Optional[str] = None,
    remove_history_event_id: Optional[str] = None,
) -> Dict[str, Any]:
    with STATE_LOCK:
        initial_equipment = equipamentos_cache.get(target_serial)
        initial_equipment = dict(initial_equipment) if initial_equipment is not None else None
    if initial_equipment is None:
        raise HTTPException(status_code=404, detail=f"Equipamento com serial '{target_serial}' não encontrado na base de dados.")

    cached_source = initial_equipment.get("_source_file")
    cached_sheet = initial_equipment.get("_source_sheet")
    if not cached_source or not cached_sheet:
        raise HTTPException(
            status_code=409,
            detail="A origem deste equipamento não está mais disponível no cache; recarregue a base antes de editar.",
        )
    source_file = Path(cached_source).resolve(strict=False)
    detail_files = get_details_files()
    locked_detail_files = {Path(path).resolve(strict=False) for path in detail_files}
    if source_file not in locked_detail_files:
        raise HTTPException(
            status_code=409,
            detail="A planilha de origem mudou depois que este equipamento foi carregado; recarregue a base antes de editar.",
        )

    # Lock source files alongside the alias/history JSON so uploads cannot race
    # with a manual override decision. Manual overrides never edit that source.
    targets = [MODIFIED_APELIDOS_FILE, ALIAS_HISTORY_FILE, *detail_files]

    try:
        with AtomicFileTransaction(TRANSACTION_ROOT, targets) as transaction:
            with STATE_LOCK:
                next_equipment_cache = deepcopy(equipamentos_cache)
                next_unit_cache = deepcopy(unidades_cache)
                next_stats_cache = deepcopy(stats_cache)
            equipamento = deepcopy(next_equipment_cache.get(target_serial))
            if equipamento is None:
                raise HTTPException(status_code=404, detail=f"Equipamento com serial '{target_serial}' não encontrado na base de dados.")

            current_source = equipamento.get("_source_file")
            current_sheet = equipamento.get("_source_sheet")
            active_file = get_primary_equipment_file()
            locked_files = {Path(path).resolve(strict=False) for path in detail_files}
            if (
                not current_source
                or Path(current_source).resolve(strict=False) != source_file
                or active_file is None
                or not active_file.is_file()
                or active_file.resolve(strict=False) != source_file
                or active_file.resolve(strict=False) not in locked_files
            ):
                raise HTTPException(
                    status_code=409,
                    detail="A planilha de origem mudou depois que este equipamento foi carregado; recarregue a base antes de editar.",
                )

            active_sheet = find_details_sheet(active_file)
            if not current_sheet or current_sheet != cached_sheet or active_sheet != cached_sheet:
                raise HTTPException(
                    status_code=409,
                    detail="A aba de origem mudou depois que este equipamento foi carregado; recarregue a base antes de editar.",
                )

            apelido_anterior = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
            history_will_change = (apelido_anterior != novo_apelido and registrar_historico) or bool(remove_history_event_id)
            if expected_latest_event_id:
                current_history = load_alias_history()
                latest = next((
                    item for item in reversed(current_history)
                    if str(item.get("serial") or "").strip().upper() == target_serial
                    and item.get("tipo") != "endereco"
                ), None)
                if not latest or latest.get("id") != expected_latest_event_id:
                    raise HTTPException(status_code=409, detail="Só é possível desfazer a alteração manual mais recente deste equipamento.")
                local_now = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
                if local_now != str(expected_current_local or "").strip():
                    raise HTTPException(status_code=409, detail="O apelido salvo mudou depois deste registro; nenhuma alteração foi aplicada.")

            def update_overrides(data):
                aliases = dict(_validate_json_object(data, "apelidos"))
                matching_keys = [
                    key for key in aliases
                    if normalize_reference_value(key) == normalize_reference_value(target_serial)
                ]
                if expected_current_local is not None and (
                    len(matching_keys) != 1
                    or str(aliases.get(matching_keys[0]) or "").strip()
                    != str(expected_current_local or "").strip()
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="O apelido manual salvo mudou depois deste registro; nenhuma alteração foi aplicada.",
                    )
                for key in matching_keys:
                    aliases.pop(key, None)
                aliases[target_serial] = novo_apelido
                return aliases

            transaction.update_json(MODIFIED_APELIDOS_FILE, update_overrides, {})

            if history_will_change:
                def update_history(history):
                    history = _validate_json_history(history, "apelidos")
                    updated = list(history)
                    if remove_history_event_id:
                        updated = [item for item in updated if item.get("id") != remove_history_event_id]
                        if len(updated) == len(history):
                            raise HTTPException(status_code=409, detail="O registro foi alterado por outra ação; atualize o histórico e tente novamente.")
                    if apelido_anterior != novo_apelido and registrar_historico:
                        updated.append(build_alias_change_entry(target_serial, apelido_anterior, novo_apelido, action, reference_id))
                    return updated
                transaction.update_json(ALIAS_HISTORY_FILE, update_history, [])

            updated_equipment = dict(equipamento)
            updated_equipment["_apelido_local"] = novo_apelido
            updated_equipment["_apelido_manual_override"] = True
            _apply_effective_alias(
                updated_equipment,
                read_endpoint_alias_index(),
                details_duplicate=updated_equipment.get("invall_alias_status") == "serie_detalhes_duplicada",
            )
            next_equipment_cache[target_serial] = updated_equipment
            prepared_state = prepare_database_state(
                next_equipment_cache,
                next_unit_cache,
                next_stats_cache,
            )
            transaction.commit()
            publish_database_state(prepared_state)
    except HTTPException:
        raise
    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível concluir a alteração de apelido: {error}") from error

    try:
        prune_expired_histories()
    except Exception as error:
        print(f"[AVISO] O apelido foi salvo, mas a retenção automática falhou ({type(error).__name__}).")

    return {
        "equipamento": updated_equipment,
        "apelido_anterior": apelido_anterior,
        "apelido_novo": novo_apelido,
        "salvo_no_disco": True,
    }


@app.post("/api/equipamento/atualizar-apelido")
def atualizar_apelido(payload: ApelidoUpdatePayload):
    """Atualiza o apelido e registra o valor anterior, o novo e o horário."""
    target_serial = payload.serial.strip().upper()
    novo_apelido = payload.apelido.strip()
    resultado = aplicar_alteracao_apelido(target_serial, novo_apelido)

    return {
        "sucesso": True,
        "mensagem": "Apelido salvo para as próximas pesquisas e exportações do Excel.",
        **{**resultado, "equipamento": _public_equipment(resultado["equipamento"])},
        "total_modificados": len(load_modified_apelidos()),
    }


@app.get("/api/historico-alteracoes")
@app.get("/api/historico-apelidos")
def get_historico_apelidos():
    historico = load_alias_history()
    return {"total": len(historico), "eventos": list(reversed(historico))}




@app.delete("/api/historico-alteracoes/{evento_id}")
@app.delete("/api/historico-apelidos/{evento_id}")
def excluir_evento_historico_apelido(evento_id: str):
    historico = load_alias_history()
    evento = next((item for item in historico if item.get("id") == evento_id), None)
    if evento is None:
        raise HTTPException(status_code=404, detail="O registro selecionado não existe mais no histórico.")

    target_serial = str(evento.get("serial") or "").strip().upper()
    equipamento = equipamentos_cache.get(target_serial)
    if equipamento is None:
        raise HTTPException(status_code=404, detail=f"Equipamento com serial '{target_serial}' não encontrado na base de dados.")

    if evento.get("tipo") == "endereco":
        raise HTTPException(
            status_code=409,
            detail="Endereços são atualizados pela planilha da Simpress e não podem mais ser restaurados manualmente.",
        )
    tipo_evento = "apelido"
    evento_mais_recente = next(
        (
            item for item in reversed(historico)
            if str(item.get("serial") or "").strip().upper() == target_serial
            and ("endereco" if item.get("tipo") == "endereco" else "apelido") == tipo_evento
        ),
        None,
    )
    if not evento_mais_recente or evento_mais_recente.get("id") != evento_id:
        raise HTTPException(status_code=409, detail="Só é possível excluir e restaurar o registro mais recente daquele campo.")

    apelido_atual = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
    apelido_novo = str(evento.get("apelido_novo") or "").strip()
    if apelido_atual != apelido_novo:
        raise HTTPException(status_code=409, detail="O apelido salvo não corresponde mais a este registro. Recarregue a base antes de restaurar.")

    apelido_anterior = str(evento.get("apelido_anterior") or "").strip()
    resultado = aplicar_alteracao_apelido(
        target_serial,
        apelido_anterior,
        registrar_historico=False,
        expected_current_local=apelido_novo,
        expected_latest_event_id=evento_id,
        remove_history_event_id=evento_id,
    )
    equipamento_restaurado = resultado["equipamento"]

    return {
        "sucesso": True,
        "evento_id": evento_id,
        "tipo": tipo_evento,
        "equipamento": _public_equipment(equipamento_restaurado),
        "mensagem": "Valor anterior restaurado para pesquisas e exportações; registro removido do histórico.",
    }


@app.post("/api/equipamento/apelido/desfazer")
def desfazer_alteracao_apelido(payload: ApelidoUndoPayload):
    historico = load_alias_history()
    evento = next((item for item in historico if item.get("id") == payload.evento_id), None)
    if evento is None:
        raise HTTPException(status_code=404, detail="A alteração selecionada não existe no histórico.")

    target_serial = str(evento.get("serial") or "").strip().upper()
    equipamento = equipamentos_cache.get(target_serial)
    if equipamento is None:
        raise HTTPException(status_code=404, detail=f"Equipamento com serial '{target_serial}' não encontrado na base de dados.")

    evento_mais_recente = next(
        (
            item for item in reversed(historico)
            if str(item.get("serial") or "").strip().upper() == target_serial
            and item.get("tipo") != "endereco"
        ),
        None,
    )
    if not evento_mais_recente or evento_mais_recente.get("id") != evento.get("id"):
        raise HTTPException(status_code=409, detail="Só é possível desfazer a alteração mais recente deste equipamento.")

    apelido_atual = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
    apelido_evento = str(evento.get("apelido_novo") or "").strip()
    if apelido_atual != apelido_evento:
        raise HTTPException(status_code=409, detail="O valor salvo foi alterado depois deste registro. Recarregue o histórico antes de desfazer.")

    apelido_restaurado = str(evento.get("apelido_anterior") or "").strip()
    resultado = aplicar_alteracao_apelido(
        target_serial,
        apelido_restaurado,
        action="desfazer",
        reference_id=evento["id"],
        expected_current_local=apelido_evento,
        expected_latest_event_id=evento["id"],
    )
    return {
        "sucesso": True,
        "mensagem": "Apelido restaurado; a reversão foi registrada no histórico.",
        **{**resultado, "equipamento": _public_equipment(resultado["equipamento"])},
        "total_modificados": len(load_modified_apelidos()),
    }


@app.get("/api/exportar-equipamentos")
def exportar_equipamentos():
    """Exporta a apresentação de referência com os registros da base ativa."""
    source_file = EXPORT_MODEL_FILE
    current_file = get_parque_file()
    if not source_file.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"O modelo de exportação '{source_file.name}' não foi encontrado."
        )
    if current_file is None or not current_file.is_file():
        raise HTTPException(status_code=404, detail="A base atual da Simpress não foi encontrada.")

    wb = None
    current_wb = None
    try:
        with lock_paths([source_file, current_file, ENDPOINT_UPLOAD_FILE, MODIFIED_APELIDOS_FILE]):
            validate_xlsx(source_file)
            wb = load_workbook_safely(source_file, allow_threaded_comments=True)
            original = workbook_snapshot(wb)
            sheet_target = next(
                (name for name in wb.sheetnames if "parque" in name.lower() or "equipamento" in name.lower()),
                wb.sheetnames[0],
            )
            ws = wb[sheet_target]
            header_row = [cell.value for cell in next(ws.iter_rows(max_row=1), ())]
            serial_col_index = find_workbook_header_column(header_row, DETAILS_SERIAL_HEADER_ALIASES)
            apelido_col_index = find_workbook_header_column(header_row, ("APELIDO",))
            id_cliente_col_index = find_workbook_header_column(header_row, ("IDCLIENTE",))
            if serial_col_index is None or apelido_col_index is None:
                raise HTTPException(
                    status_code=500,
                    detail=f"A planilha '{source_file.name}' não contém as colunas NumeroSerie e Apelido esperadas."
                )
            serial_col = serial_col_index + 1
            apelido_col = apelido_col_index + 1
            id_cliente_col = id_cliente_col_index + 1 if id_cliente_col_index is not None else None
            header_style_updates = {}
            default_header_style_id = ws.cell(row=1, column=serial_col).style_id
            for column in (apelido_col, id_cliente_col):
                if column is None:
                    continue
                header_cell = ws.cell(row=1, column=column)
                if header_cell.style_id != default_header_style_id:
                    header_style_updates[(ws.title, header_cell.coordinate)] = default_header_style_id

            current_sheet_name = find_details_sheet(current_file)
            if current_sheet_name is None:
                raise HTTPException(status_code=409, detail="A base atual da Simpress não tem os cabeçalhos esperados.")
            current_wb = openpyxl.load_workbook(current_file, read_only=True, data_only=False)
            current_ws = current_wb[current_sheet_name]
            current_headers = [cell.value for cell in next(current_ws.iter_rows(max_row=1), ())]
            current_serial_col_index = find_workbook_header_column(current_headers, DETAILS_SERIAL_HEADER_ALIASES)
            if current_serial_col_index is None:
                raise HTTPException(status_code=409, detail="A base atual não contém NumeroSerie.")
            current_alias_col_index = find_workbook_header_column(current_headers, DETAILS_ALIAS_HEADER_ALIASES)
            if current_alias_col_index is None:
                raise HTTPException(status_code=409, detail="A base atual não contém Apelido ou Hostname.")
            current_serial_col = current_serial_col_index + 1
            current_alias_col = current_alias_col_index + 1
            current_id_cliente_col_index = find_workbook_header_column(current_headers, ("IDCLIENTE",))
            current_id_cliente_col = current_id_cliente_col_index + 1 if current_id_cliente_col_index is not None else None
            current_rows = {}
            for cells in current_ws.iter_rows(min_row=2, values_only=True):
                serial_key = normalize_reference_value(cells[current_serial_col - 1])
                if not serial_key:
                    continue
                if serial_key in current_rows:
                    raise HTTPException(status_code=409, detail="A base atual contém séries duplicadas; confira antes de exportar.")
                current_rows[serial_key] = {
                    "apelido": cells[current_alias_col - 1],
                    "id_cliente": cells[current_id_cliente_col - 1] if current_id_cliente_col else None,
                }

            endpoint_index = read_endpoint_alias_index()
            aliases = get_export_aliases(endpoint_index)
            serial_counts: Dict[str, int] = {}
            for row in range(2, ws.max_row + 1):
                serial_key = normalize_reference_value(ws.cell(row=row, column=serial_col).value)
                if serial_key:
                    serial_counts[serial_key] = serial_counts.get(serial_key, 0) + 1

            if set(serial_counts) != set(current_rows):
                raise HTTPException(
                    status_code=409,
                    detail="As séries da base atual diferem das linhas do modelo de exportação. Atualize o modelo antes de exportar."
                )

            expected_values = {}
            alias_update_count = 0
            id_cliente_update_count = 0
            skipped_duplicate_rows = set()
            skipped_formula_rows = 0
            skipped_formula_serials = set()
            for row in range(2, ws.max_row + 1):
                serial_key = normalize_reference_value(ws.cell(row=row, column=serial_col).value)
                if not serial_key:
                    continue
                if serial_counts.get(serial_key) != 1:
                    skipped_duplicate_rows.add(serial_key)
                    continue

                formula_skipped = False
                alias_cell = ws.cell(row=row, column=apelido_col)
                if alias_cell.data_type == "f":
                    formula_skipped = True
                else:
                    updated_alias = aliases.get(
                        serial_key,
                        current_rows[serial_key]["apelido"],
                    )
                    if updated_alias is None:
                        updated_alias = ""
                    if alias_cell.value != updated_alias:
                        alias_cell.value = updated_alias
                        expected_values[(ws.title, alias_cell.coordinate)] = updated_alias
                        alias_update_count += 1

                if id_cliente_col and current_id_cliente_col:
                    id_cliente_cell = ws.cell(row=row, column=id_cliente_col)
                    if id_cliente_cell.data_type == "f":
                        formula_skipped = True
                    else:
                        updated_id_cliente = current_rows[serial_key]["id_cliente"]
                        if updated_id_cliente is None:
                            updated_id_cliente = ""
                        if id_cliente_cell.value != updated_id_cliente:
                            id_cliente_cell.value = updated_id_cliente
                            expected_values[(ws.title, id_cliente_cell.coordinate)] = updated_id_cliente
                            id_cliente_update_count += 1

                if formula_skipped:
                    skipped_formula_rows += 1
                    skipped_formula_serials.add(serial_key)

            review_items = endpoint_alias_review_items(endpoint_index, set(serial_counts))
            pending_review_count = len(review_items) + len(skipped_duplicate_rows) + skipped_formula_rows
            review_summary = [
                {
                    "motivo": "Registros do Endpoint que exigem conferência",
                    "total": len(review_items),
                    "series": [
                        str(item.get("serie") or "")[:64]
                        for item in review_items if item.get("serie")
                    ][:10],
                },
                {
                    "motivo": "Séries duplicadas no modelo de exportação",
                    "total": len(skipped_duplicate_rows),
                    "series": sorted(skipped_duplicate_rows)[:10],
                },
                {
                    "motivo": "Linhas protegidas por fórmulas",
                    "total": skipped_formula_rows,
                    "series": sorted(skipped_formula_serials)[:10],
                },
            ]
            review_summary = [item for item in review_summary if item["total"]]
            output_bytes = serialize_workbook_validated(
                source_file, wb, original, expected_values,
                expected_cell_styles=header_style_updates,
                allow_threaded_comments=True,
            )

        now_str = datetime.now().strftime("%d-%m-%Y_%H%M%S")
        export_filename = f"EquipamentosDetalhes-{now_str}.xlsx"
        buffer = io.BytesIO(output_bytes)
        buffer.seek(0)

        latest_history = None
        try:
            latest_history = latest_comparison_update_entry()
        except HTTPException:
            pass
        history_alias_count = 0
        history_timestamp = ""
        if isinstance(latest_history, dict):
            history_comparison = latest_history.get("comparacao")
            history_comparison = history_comparison if isinstance(history_comparison, dict) else {}
            history_alias_changes = history_comparison.get("apelidos_atualizados")
            if isinstance(history_alias_changes, list):
                history_alias_count = len(history_alias_changes)
            else:
                history_summary = latest_history.get("resumo")
                if isinstance(history_summary, dict):
                    try:
                        history_alias_count = max(0, int(history_summary.get("apelidos_atualizados", 0)))
                    except (TypeError, ValueError):
                        history_alias_count = 0
            history_timestamp = str(
                latest_history.get("horario")
                or history_comparison.get("horario_comparacao")
                or ""
            )

        headers = {
            "Content-Disposition": f'attachment; filename="{export_filename}"',
            "Access-Control-Expose-Headers": (
                "Content-Disposition, X-Total-Alterados, X-Total-IdCliente-Alterados, "
                "X-Total-Alteracoes-Exportadas, X-Total-Conferencia, X-Conferencia-Resumo, "
                "X-Historico-Apelidos-Atualizados, X-Historico-Horario"
            ),
            "X-Total-Alterados": str(alias_update_count),
            "X-Total-IdCliente-Alterados": str(id_cliente_update_count),
            "X-Total-Alteracoes-Exportadas": str(alias_update_count + id_cliente_update_count),
            "X-Total-Conferencia": str(pending_review_count),
            "X-Conferencia-Resumo": quote(json.dumps(review_summary, ensure_ascii=False, separators=(",", ":"))),
            "X-Historico-Apelidos-Atualizados": str(history_alias_count),
            "X-Historico-Horario": history_timestamp,
        }

        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers
        )
    except HTTPException:
        raise
    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Exportação cancelada para preservar a planilha: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível validar a exportação: {error}") from error
    except Exception:
        print("[ERRO] Falha ao exportar a base local de equipamentos.")
        raise HTTPException(status_code=500, detail="Erro ao exportar a base de equipamentos.") from None
    finally:
        if wb is not None:
            wb.close()
        if current_wb is not None:
            current_wb.close()


@app.post("/api/recarregar-base")
def recarregar_base():
    """Recarrega a planilha válida mais recente da pasta de entrada e informa arquivo e total."""
    if not load_database():
        raise HTTPException(
            status_code=400,
            detail=f"Nenhuma planilha válida pôde ser carregada em '{INPUT_DIR.name}'."
        )

    filename = stats_cache["arquivo_origem"]
    total_equipamentos = stats_cache["total_equipamentos"]
    return {
        "sucesso": True,
        "arquivo_origem": filename,
        "total_equipamentos": total_equipamentos,
        "mensagem": f"Planilha '{filename}' carregada com {total_equipamentos} equipamentos.",
        "stats": stats_cache,
        "total_unidades": len(unidades_cache)
    }


def _history_equipment_snapshot() -> Dict[str, Dict[str, Any]]:
    with STATE_LOCK:
        return deepcopy(equipamentos_cache)


_inventory_update_services = InventoryUpdateServices(
    max_upload_bytes=lambda: MAX_UPLOAD_BYTES,
    workbook_parse_admission=lambda: WORKBOOK_PARSE_ADMISSION,
    validate_uploaded_workbook=lambda *args, **kwargs: validate_uploaded_workbook(*args, **kwargs),
    input_directory=lambda: INPUT_DIR,
    endpoint_upload_file=lambda: ENDPOINT_UPLOAD_FILE,
    details_upload_file=lambda: DETAILS_UPLOAD_FILE,
    comparison_history_file=lambda: COMPARISON_HISTORY_FILE,
    inventory_idempotency_file=lambda: STATE_DIR / "inventory_update_idempotency.json",
    upload_backups_directory=lambda: UPLOAD_BACKUPS_DIR,
    history_annotations_directory=lambda: HISTORY_ANNOTATIONS_DIR,
    local_annotation_outbox_directory=lambda: LOCAL_HISTORY_ANNOTATION_OUTBOX_DIR,
    build_history_annotation_record=lambda *args, **kwargs: build_history_annotation_record(*args, **kwargs),
    history_annotation_record_path=history_annotation_record_path,
    get_primary_equipment_file=lambda: get_primary_equipment_file(),
    compare_uploaded_workbooks=lambda *args, **kwargs: compare_uploaded_workbooks(*args, **kwargs),
    inventory_state_transaction=lambda targets: inventory_state_transaction(targets),
    get_equipment_snapshot=_history_equipment_snapshot,
    snapshot_equipment_aliases=lambda *args, **kwargs: snapshot_equipment_aliases(*args, **kwargs),
    load_modified_apelidos=lambda: load_modified_apelidos(),
    manual_alias_source_snapshots=lambda *args, **kwargs: _manual_alias_source_snapshots(*args, **kwargs),
    normalize_reference_value=lambda *args, **kwargs: normalize_reference_value(*args, **kwargs),
    upload_serial_value=_upload_serial_value,
    upload_alias_value=_upload_alias_value,
    load_database=lambda *args, **kwargs: load_database(*args, **kwargs),
    read_endpoint_alias_index=lambda: read_endpoint_alias_index(),
    compare_equipment_aliases=lambda *args, **kwargs: compare_equipment_aliases(*args, **kwargs),
    endpoint_alias_review_items=lambda *args, **kwargs: endpoint_alias_review_items(*args, **kwargs),
    publish_database_state=lambda *args, **kwargs: publish_database_state(*args, **kwargs),
    comparison_history_for_display=lambda *args, **kwargs: comparison_history_for_display(*args, **kwargs),
    load_history_annotations=lambda *args, **kwargs: load_history_annotations(*args, **kwargs),
    comparison_annotation_item_id=lambda *args, **kwargs: comparison_annotation_item_id(*args, **kwargs),
    inventory_update_preview_summary=inventory_update_preview_summary,
    create_inventory_preview_token=create_inventory_preview_token,
    verify_inventory_preview_token=verify_inventory_preview_token,
)


async def _import_automatic_inventory_batch(
    batch_id: str,
    endpoint_name: str,
    endpoint_bytes: bytes,
    simpress_name: str,
    simpress_bytes: bytes,
):
    _raise_if_transaction_recovery_blocked()
    endpoint_upload = StarletteUploadFile(
        filename=endpoint_name,
        file=io.BytesIO(endpoint_bytes),
    )
    simpress_upload = StarletteUploadFile(
        filename=simpress_name,
        file=io.BytesIO(simpress_bytes),
    )
    result = await update_inventory_files(
        endpoint_upload,
        simpress_upload,
        services=_inventory_update_services,
        automatic_import_id=batch_id,
    )
    try:
        await asyncio.to_thread(prune_expired_histories)
    except Exception:
        logger.exception(
            "Falha na retenção após a atualização automática confirmada (lote=%s).",
            batch_id,
        )
    return result




async def previsualizar_planilhas(endpoint_file: UploadFile, details_file: UploadFile):
    return await preview_inventory_files(endpoint_file, details_file, services=_inventory_update_services)


@app.post("/api/planilhas/previsualizar")
async def previsualizar_planilhas_endpoint(
    endpoint_file: UploadFile = File(...),
    details_file: UploadFile = File(...),
):
    return await previsualizar_planilhas(endpoint_file, details_file)


async def atualizar_planilhas(
    endpoint_file: UploadFile,
    details_file: UploadFile,
    preview_token: Optional[str] = None,
):
    result = await update_inventory_files(
        endpoint_file, details_file, services=_inventory_update_services,
        idempotency_key=idempotency_key.get(), preview_token=preview_token,
    )
    try:
        await asyncio.to_thread(prune_expired_histories)
    except Exception:
        event_id = (result.get("comparacao") or {}).get("evento_id") if isinstance(result, dict) else None
        logger.exception("Falha na retenção após a atualização confirmada (evento=%s).", event_id or "desconhecido")
    return result


@app.post("/api/planilhas/atualizar")
async def atualizar_planilhas_endpoint(
    endpoint_file: UploadFile = File(...),
    details_file: UploadFile = File(...),
    preview_token: Optional[str] = Form(None, min_length=66, max_length=90),
):
    return await atualizar_planilhas(endpoint_file, details_file, preview_token=preview_token)



def _normalizar_termo_busca(valor: Any) -> str:
    return normalize_search_term(valor)


def _categoria_equipamento(tipo: Any, modelo: Any) -> str:
    """Agrupa os rótulos do inventário nas categorias usadas pela pesquisa."""
    return categorize_equipment(tipo, modelo, _normalizar_termo_busca)


def _refresh_equipment_search_index_locked() -> None:
    """Precompute normalized searchable values once per published cache generation."""
    global _EQUIPMENT_SEARCH_INDEX, _EQUIPMENT_SEARCH_INDEX_SOURCE
    _EQUIPMENT_SEARCH_INDEX = build_search_index(equipamentos_cache, _normalizar_termo_busca)
    _EQUIPMENT_SEARCH_INDEX_SOURCE = equipamentos_cache


def _buscar_equipamentos_por_termo(q: str) -> List[Dict[str, Any]]:
    """Busca por série, modelo, apelido, cidade ou categoria e prioriza série."""
    term = _normalizar_termo_busca(q)
    if not term:
        return []


    with STATE_LOCK:
        if _EQUIPMENT_SEARCH_INDEX_SOURCE is not equipamentos_cache:
            _refresh_equipment_search_index_locked()
        current_index = _EQUIPMENT_SEARCH_INDEX
    return search_normalized_equipment_index(current_index, term)


def _get_stats_snapshot() -> Dict[str, Any]:
    export_counts = count_export_changes()
    export_status = get_export_status()
    with STATE_LOCK:
        stats_snapshot = deepcopy(stats_cache)
        equipment_count = len(equipamentos_cache)
        unit_count = len(unidades_cache)
    return {
        **stats_snapshot,
        "total_equipamentos": equipment_count,
        "base_importada": equipment_count > 0,
        "exportacao_disponivel": export_status["available"],
        "exportacao_motivo": export_status["reason"],
        "total_apelidos_modificados": export_counts["apelidos"],
        "total_id_clientes_modificados": export_counts["id_clientes"],
        "total_alteracoes_exportaveis": export_counts["total"],
        "total_unidades": unit_count,
    }


def _unit_cache_snapshot() -> List[Dict[str, Any]]:
    with STATE_LOCK:
        return deepcopy(unidades_cache)






system_router, _system_exports = create_system_router(SystemRouteServices(
    get_readiness_status=lambda: get_startup_readiness(),
    get_transfer_form_defaults=lambda: {
        "retirada_contato": TRANSFER_ORIGIN_CONTACT,
        "retirada_email": TRANSFER_ORIGIN_EMAIL,
        "retirada_telefone": TRANSFER_ORIGIN_PHONE,
    },
))
get_readiness_status = _system_exports["get_readiness_status"]
get_transfer_form_defaults = _system_exports["get_transfer_form_defaults"]
app.include_router(system_router)

units_router, _units_exports = create_units_router(UnitRouteServices(
    format_cep=format_cep,
    get_details_files=get_details_files,
    endpoint_upload_file=lambda: ENDPOINT_UPLOAD_FILE,
    modified_aliases_file=lambda: MODIFIED_APELIDOS_FILE,
    custom_units_file=lambda: CUSTOM_UNIDADES_FILE,
    export_model_file=lambda: EXPORT_MODEL_FILE,
    transaction_root=lambda: TRANSACTION_ROOT,
    get_units_snapshot=_unit_cache_snapshot,
    coerce_unit_id=_coerce_unit_id,
    unit_identity_key=_unit_identity_key,
    local_json_corruption_error=LocalJsonCorruptionError,
    load_database=lambda *args, **kwargs: load_database(*args, **kwargs),
    publish_database_state=publish_database_state,
))
_public_unit_list = _units_exports["_public_unit_list"]
salvar_unidade = _units_exports["salvar_unidade"]
get_unidades = _units_exports["get_unidades"]
app.include_router(units_router)

equipment_search_router, _equipment_search_exports = create_equipment_search_router(EquipmentSearchServices(
    search=_buscar_equipamentos_por_termo,
    normalize=_normalizar_termo_busca,
    categories=_CATEGORIAS_EQUIPAMENTO,
    get_stats=_get_stats_snapshot,
))
buscar_seriais = _equipment_search_exports["buscar_seriais"]
buscar_seriais_expandida = _equipment_search_exports["buscar_seriais_expandida"]
get_stats = _equipment_search_exports["get_stats"]
app.include_router(equipment_search_router)

transfer_router, gerar_planilha = create_transfer_router(get_local_transfer_template)
app.include_router(transfer_router)

transfer_history_router, _transfer_history_exports = create_transfer_history_router(TransferHistoryServices(
    history_file=lambda: TRANSFER_HISTORY_FILE,
    transaction_root=lambda: TRANSACTION_ROOT,
))
listar_historico_transferencias = _transfer_history_exports["listar_historico_transferencias"]
registrar_historico_transferencia = _transfer_history_exports["registrar_historico_transferencia"]
app.include_router(transfer_history_router)


def _dashboard_equipment_snapshot() -> List[Dict[str, Any]]:
    with STATE_LOCK:
        return [
            {"tipo": item.get("tipo"), "modelo": item.get("modelo"), "retirada_cidade": item.get("retirada_cidade")}
            for item in equipamentos_cache.values()
        ]


def _dashboard_comparison_events() -> List[Dict[str, Any]]:
    return get_historico_comparacoes()["eventos"]


dashboard_router, _dashboard_exports = create_dashboard_router(DashboardServices(
    get_equipment=_dashboard_equipment_snapshot,
    get_stats=_get_stats_snapshot,
    get_comparison_events=_dashboard_comparison_events,
    categories=_CATEGORIAS_EQUIPAMENTO,
    categorize=_categoria_equipamento,
))
obter_painel = _dashboard_exports["obter_painel"]
app.include_router(dashboard_router)


def _check_imported_export():
    if get_primary_equipment_file() is not None:
        count_export_changes(locked=True)
        status = get_export_status()
        return None if status["available"] else status["reason"]
    return None  # A model can be configured before the first inventory pair.


local_setup_router, importar_modelo_local = create_local_setup_router(
    model_path=lambda kind: INPUT_DIR / "_modelos" / "transferencia.xlsx" if kind == "transferencia" else EXPORT_MODEL_FILE,
    transaction_root=lambda: TRANSACTION_ROOT,
    backups_directory=lambda: UPLOAD_BACKUPS_DIR,
    max_upload_bytes=lambda: MAX_UPLOAD_BYTES,
    parser_admission=lambda: WORKBOOK_PARSE_ADMISSION,
    export_dependency_paths=lambda: [*get_details_files(), ENDPOINT_UPLOAD_FILE, MODIFIED_APELIDOS_FILE],
    validate_export=_check_imported_export,
)
app.include_router(local_setup_router)

inventory_history_router, _inventory_history_exports = create_inventory_history_router(InventoryHistoryServices(
    manual_aliases_by_serial=_manual_aliases_by_serial,
    build_history_annotation_record=lambda *args, **kwargs: build_history_annotation_record(*args, **kwargs),
    comparison_annotation_item_id=comparison_annotation_item_id,
    comparison_history_path=lambda: COMPARISON_HISTORY_FILE,
    comparison_history_for_display=comparison_history_for_display,
    details_upload_path=lambda: DETAILS_UPLOAD_FILE,
    endpoint_upload_path=lambda: ENDPOINT_UPLOAD_FILE,
    get_equipment_snapshot=_history_equipment_snapshot,
    get_equipment_template_file=get_equipamentos_template_file,
    history_annotation_record_path=history_annotation_record_path,
    history_annotation_row_fingerprint=history_annotation_row_fingerprint,
    history_annotations_directory=lambda: HISTORY_ANNOTATIONS_DIR,
    history_annotations_sync_enabled=lambda: HISTORY_ANNOTATIONS_SYNC_ENABLED,
    input_directory=lambda: INPUT_DIR,
    atomic_file_transaction=lambda *args, **kwargs: AtomicFileTransaction(*args, **kwargs),
    inventory_state_transaction=inventory_state_transaction,
    load_comparison_history=load_comparison_history,
    load_database=lambda *args, **kwargs: load_database(*args, **kwargs),
    load_history_annotations=lambda directory: load_history_annotations(directory),
    load_modified_apelidos=load_modified_apelidos,
    local_annotation_outbox_directory=lambda: LOCAL_HISTORY_ANNOTATION_OUTBOX_DIR,
    max_upload_bytes=MAX_UPLOAD_BYTES,
    modified_aliases_path=lambda: MODIFIED_APELIDOS_FILE,
    normalize_reference_value=normalize_reference_value,
    publish_database_state=publish_database_state,
    save_history_annotation=lambda *args, **kwargs: save_history_annotation(*args, **kwargs),
    transaction_root=lambda: TRANSACTION_ROOT,
    upload_backups_directory=lambda: UPLOAD_BACKUPS_DIR,
    validate_uploaded_workbook=lambda *args, **kwargs: validate_uploaded_workbook(*args, **kwargs),
))
flush_pending_history_annotations = _inventory_history_exports["flush_pending_history_annotations"]
migrate_legacy_history_annotations = _inventory_history_exports["migrate_legacy_history_annotations"]
_build_comparison_restore_context = _inventory_history_exports["_build_comparison_restore_context"]
_comparison_event_has_restorable_backup = _inventory_history_exports["_comparison_event_has_restorable_backup"]
_comparison_event_type = _inventory_history_exports["_comparison_event_type"]
_comparison_restore_backup_paths = _inventory_history_exports["_comparison_restore_backup_paths"]
_current_inventory_snapshot = _inventory_history_exports["_current_inventory_snapshot"]
_sha256_file = _inventory_history_exports["_sha256_file"]
_validated_comparison_backup_files = _inventory_history_exports["_validated_comparison_backup_files"]
excluir_comparacao_historica = _inventory_history_exports["excluir_comparacao_historica"]
exportar_historico_comparacoes_excel = _inventory_history_exports["exportar_historico_comparacoes_excel"]
get_comparacao_historica = _inventory_history_exports["get_comparacao_historica"]
get_historico_comparacoes = _inventory_history_exports["get_historico_comparacoes"]
salvar_anotacao_comparacao = _inventory_history_exports["salvar_anotacao_comparacao"]
salvar_anotacao_comparacao_historica = _inventory_history_exports["salvar_anotacao_comparacao_historica"]
resolver_divergencia_apelido_manual = _inventory_history_exports["resolver_divergencia_apelido_manual"]
restaurar_comparacao_historica = _inventory_history_exports["restaurar_comparacao_historica"]
visualizar_restauracao_comparacao = _inventory_history_exports["visualizar_restauracao_comparacao"]
app.include_router(inventory_history_router)

operations_router = create_operations_router(
    load_comparison_history=load_comparison_history,
    comparison_history_for_display=_inventory_history_exports["history_annotation_view"],
    ticket_report_path=lambda: TICKET_REPORT_FILE,
    transaction_root=lambda: TRANSACTION_ROOT,
    history_annotations_directory=lambda: HISTORY_ANNOTATIONS_DIR,
    local_annotation_outbox_directory=lambda: LOCAL_HISTORY_ANNOTATION_OUTBOX_DIR,
    history_annotations_sync_enabled=lambda: HISTORY_ANNOTATIONS_SYNC_ENABLED,
    load_history_annotation_records=lambda directory: load_history_annotations(directory),
)
app.include_router(operations_router)

# Serve static files and frontend
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", RevalidatingStaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/favicon.ico", include_in_schema=False)
def serve_favicon():
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")

@app.get("/")
def read_root():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return frontend_response(STATIC_DIR)
    return {
        "mensagem": "API Simpress Transferência ativa. O arquivo static/index.html está sendo inicializado.",
        "docs": "/docs"
    }

if __name__ == "__main__":
    import uvicorn
    try:
        equipment_source: Path | str | None = get_primary_equipment_file()
    except FileBusyError:
        equipment_source = "INDISPONÍVEL no momento (arquivo em uso)"
    print(f"[INFO] Diretório do projeto: {BASE_DIR}")
    print(f"[INFO] Modelo de transferência: {TEMPLATE_FILE} ({'OK' if TEMPLATE_FILE.is_file() else 'AUSENTE'})")
    print(f"[INFO] Fonte EquipamentosDetalhes: {equipment_source or 'AUSENTE'}")
    print(f"[INFO] Porta local: {SERVER_PORT}")
    uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT, proxy_headers=False)
