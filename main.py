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
import sys
import threading
import unicodedata
import uuid
from copy import deepcopy
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Any, Set, Tuple
from urllib.parse import quote, urlsplit

import openpyxl
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.datastructures import UploadFile as StarletteUploadFile
from integrity import (
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
from app_config import (
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
from routers.operations import MAX_TICKET_WORKBOOK_BYTES, create_operations_router
from routers.local_setup import create_local_setup_router
from domains.local_setup import validate_local_model
from xlsx_safety import XlsxLimitExceeded, XlsxPackageError, validate_xlsx

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
from domains.inventory_update import InventoryUpdateServices
from domains.inventory_update import read_uploaded_xlsx as _read_uploaded_xlsx
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
from persistence.config import PersistenceError, PersistenceSettings
from persistence.boundary import (
    IDEMPOTENCY_KEY_PATTERN,
    PersistenceBoundaryMiddleware,
    idempotency_key,
)
from security.network import is_direct_loopback_request

PERSISTENCE_SETTINGS = PersistenceSettings.from_environment()
from security.config import AuthSettings
from security.middleware import AuthenticationMiddleware
AUTH_SETTINGS = AuthSettings.from_environment()
_POSTGRES_BACKEND: Any = None


def postgres_backend():
    if PERSISTENCE_SETTINGS.backend == "files":
        return None
    if _POSTGRES_BACKEND is None:
        raise PersistenceError(503, "PostgreSQL não foi inicializado; o modo de arquivos permanece separado.")
    return _POSTGRES_BACKEND


def postgres_command(command, payload):
    backend = postgres_backend()
    if backend is None:
        return None
    return backend.execute(command, payload, idempotency_key.get())

# Runtime synchronization and in-memory state remain in the application entry point.
MODIFIED_APELIDOS_LOCK = threading.RLock()
ALIAS_HISTORY_LOCK = threading.RLock()
COMPARISON_HISTORY_LOCK = threading.RLock()
STATE_LOCK = threading.RLock()
UPLOAD_ADMISSION = threading.BoundedSemaphore(MAX_CONCURRENT_UPLOAD_REQUESTS)
WORKBOOK_PARSE_ADMISSION = threading.BoundedSemaphore(MAX_CONCURRENT_WORKBOOK_PARSERS)
logger = logging.getLogger(__name__)


class LocalJsonCorruptionError(ValueError):
    """A persisted JSON file is present but cannot be trusted or updated safely."""


class RequestBodyTooLarge(Exception):
    pass


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


def _atomic_json_update(path: Path, updater, default):
    with AtomicFileTransaction(TRANSACTION_ROOT, [path]) as transaction:
        updated = transaction.update_json(path, updater, default)
        transaction.commit()
        return updated

def load_modified_apelidos() -> Dict[str, str]:
    if (backend := postgres_backend()) is not None:
        return backend.state()["aliases"]
    with MODIFIED_APELIDOS_LOCK:
        if not MODIFIED_APELIDOS_FILE.exists():
            return {}
        return _read_json_object(MODIFIED_APELIDOS_FILE, "apelidos")

def save_modified_apelido_record(serial: str, apelido: str) -> None:
    s_key = serial.strip().upper()
    ap_val = apelido.strip()
    with MODIFIED_APELIDOS_LOCK:
        try:
            _atomic_json_update(
                MODIFIED_APELIDOS_FILE,
                lambda data: {**_validate_json_object(data, "apelidos"), s_key: ap_val},
                {},
            )
        except Exception:
            print("[ERRO] Falha ao gravar o arquivo local de apelidos.")
            raise

def load_alias_history() -> List[Dict[str, Any]]:
    if (backend := postgres_backend()) is not None:
        return backend.state()["history"]
    with ALIAS_HISTORY_LOCK:
        if not ALIAS_HISTORY_FILE.exists():
            return []
        try:
            return _read_json_history(ALIAS_HISTORY_FILE, "apelidos")
        except LocalJsonCorruptionError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

def append_alias_history_entry(entry: Dict[str, Any]) -> None:
    with ALIAS_HISTORY_LOCK:
        def append(history):
            history = _validate_json_history(history, "apelidos")
            return [*history, entry]
        _atomic_json_update(ALIAS_HISTORY_FILE, append, [])

def delete_alias_history_entry(event_id: str) -> bool:
    with ALIAS_HISTORY_LOCK:
        removed = {"value": False}
        def remove(history):
            history = _validate_json_history(history, "apelidos")
            filtered = [entry for entry in history if entry.get("id") != event_id]
            removed["value"] = len(filtered) != len(history)
            return filtered
        _atomic_json_update(ALIAS_HISTORY_FILE, remove, [])
        return removed["value"]

def load_comparison_history() -> List[Dict[str, Any]]:
    if (backend := postgres_backend()) is not None:
        return backend.files.history.load()
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


def append_comparison_history_entry(entry: Dict[str, Any]) -> None:
    with COMPARISON_HISTORY_LOCK:
        def append(history):
            history = _validate_json_history(history, "comparações")
            return [*history, entry]
        _atomic_json_update(COMPARISON_HISTORY_FILE, append, [])

def delete_comparison_history_entry(event_id: str) -> Optional[int]:
    with COMPARISON_HISTORY_LOCK:
        result: Dict[str, Optional[int]] = {"total": None}
        def remove(history):
            history = _validate_json_history(history, "comparações")
            filtered = [entry for entry in history if entry.get("id") != event_id]
            if len(filtered) != len(history):
                result["total"] = len(filtered)
            return filtered
        _atomic_json_update(COMPARISON_HISTORY_FILE, remove, [])
        return result["total"]

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

DETAILS_SERIAL_HEADER_ALIASES = ("NUMEROSERIE", "NUMERODESERIE", "SERIAL")
DETAILS_ALIAS_HEADER_ALIASES = (
    "APELIDO", "HOSTNAME", "NOMEDOCOMPUTADOR", "COMPUTERNAME"
)
DETAILS_INSTALLATION_CNPJ_HEADER_ALIASES = (
    "CNPJ Instalacao",
    "CNPJ de Instalacao",
    "CNPJ de Instalação",
    "CnpjInstalacao",
    "CnpjDeInstalacao",
    "CNPJ Instalacao Filial",
    "CNPJ de Instalacao Filial",
    "CNPJ da Instalacao Filial",
    "CNPJ da Instalacao",
    "CNPJ da Filial",
)
DETAILS_REQUIRED_HEADERS = frozenset({"MODELO", "CIDADE"})
DETAILS_COMPLETE_SOURCE_COLUMN_COUNT = 50


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


def normalize_workbook_header(value: Any) -> str:
    """Normaliza cabeçalhos com a mesma regra usada pelas tabelas enviadas."""
    return normalize_reference_value(value)


class WorkbookHeaderError(ValueError):
    """An uploaded workbook has duplicate or semantically ambiguous columns."""


def normalize_contract_value(value: Any) -> str:
    """Normalize Excel integer cells without accepting a different contract."""
    normalized = sanitize_value(value).strip()
    if re.fullmatch(r"\d+\.0+", normalized):
        normalized = normalized.split(".", 1)[0]
    return normalized


def find_workbook_header_column(headers: Iterable[Any], aliases: Iterable[str]) -> Optional[int]:
    """Return one unambiguous column whose normalized header matches an accepted alias."""
    normalized_aliases = {normalize_workbook_header(alias) for alias in aliases}
    matches = [
        index
        for index, value in enumerate(headers)
        if normalize_workbook_header(value) in normalized_aliases
    ]
    if len(matches) > 1:
        columns = ", ".join(str(index + 1) for index in matches)
        raise ValueError(f"Mais de uma coluna corresponde ao mesmo campo (colunas {columns}).")
    return matches[0] if matches else None


def validate_unambiguous_workbook_headers(headers: Iterable[Any]) -> None:
    """Reject duplicate normalized headers before mapping rows into dictionaries."""
    normalized_headers = [normalize_workbook_header(header) for header in headers]
    positions: Dict[str, List[int]] = {}
    for index, normalized in enumerate(normalized_headers):
        if normalized:
            positions.setdefault(normalized, []).append(index)
    duplicates = [indexes for indexes in positions.values() if len(indexes) > 1]
    if duplicates:
        columns = ", ".join(
            "/".join(str(index + 1) for index in indexes)
            for indexes in duplicates
        )
        raise WorkbookHeaderError(f"A planilha contém cabeçalhos repetidos nas colunas {columns}.")

    alias_groups = (
        DETAILS_SERIAL_HEADER_ALIASES,
        DETAILS_ALIAS_HEADER_ALIASES,
        ("NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME"),
        ("ROTULODESERVICONUMERODESERIE", "NUMEROSERIE", "NUMERODESERIE", "SERIAL", "SERVICETAG"),
    )
    for aliases in alias_groups:
        accepted = {normalize_workbook_header(alias) for alias in aliases}
        matches = [index for index, value in enumerate(normalized_headers) if value in accepted]
        if len(matches) > 1:
            columns = ", ".join(str(index + 1) for index in matches)
            raise WorkbookHeaderError(f"A planilha contém colunas candidatas conflitantes nas posições {columns}.")


def _read_details_sheet_records(file_path: Path, sheet_name: str):
    """Read inventory rows with openpyxl, preserving the cells used by the application."""
    workbook = None
    try:
        validate_xlsx(file_path)
        workbook = openpyxl.load_workbook(
            file_path, read_only=True, data_only=True, keep_links=False
        )
        worksheet = workbook[sheet_name]
        raw_headers = next(worksheet.iter_rows(min_row=1, max_row=1, values_only=True), ())
        validate_unambiguous_workbook_headers(raw_headers)
        headers = []
        used_headers = set()
        for index, value in enumerate(raw_headers):
            base = str(value).strip() if value is not None else f"Unnamed: {index}"
            header = base
            suffix = 1
            while header in used_headers:
                header = f"{base}.{suffix}"
                suffix += 1
            used_headers.add(header)
            headers.append(header)

        records = []
        for values in worksheet.iter_rows(min_row=2, values_only=True):
            if not any(value is not None and value != "" for value in values):
                continue
            records.append({
                header: values[index] if index < len(values) and values[index] is not None else ""
                for index, header in enumerate(headers)
            })
    finally:
        if workbook is not None:
            workbook.close()

    return headers, records


def find_details_sheet(file_path: Path) -> Optional[str]:
    """Retorna uma aba EquipamentosDetalhes com os campos usados pelo site."""
    workbook = None
    try:
        validate_xlsx(file_path)
        workbook = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        matching_sheets = []
        for worksheet in workbook.worksheets:
            headers = next(worksheet.iter_rows(min_row=1, max_row=1, values_only=True), ())
            validate_unambiguous_workbook_headers(headers)
            normalized_headers = {
                normalize_workbook_header(value)
                for value in headers
                if value is not None
            }

            has_serial = bool(set(DETAILS_SERIAL_HEADER_ALIASES) & normalized_headers)
            has_alias = bool(set(DETAILS_ALIAS_HEADER_ALIASES) & normalized_headers)
            if has_serial and has_alias and DETAILS_REQUIRED_HEADERS.issubset(normalized_headers):
                priority = int("parque" in worksheet.title.lower() or "equipamento" in worksheet.title.lower())
                matching_sheets.append((priority, worksheet.title))

        if matching_sheets:
            matching_sheets.sort(key=lambda item: item[0], reverse=True)
            return matching_sheets[0][1]
    except Exception:
        return None
    finally:
        if workbook is not None:
            workbook.close()
    return None


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
    """Retorna o EquipamentosDetalhes válido mais recente, fonte única do cadastro."""
    return next(
        (path for path in get_details_files() if find_details_sheet(path) is not None),
        None,
    )


def validate_xlsx_package(file_bytes: bytes) -> None:
    """Rejects non-XLSX, malformed, or excessively large ZIP packages before parsing."""
    try:
        validate_xlsx(file_bytes)
    except XlsxLimitExceeded as error:
        raise HTTPException(status_code=413, detail=str(error)) from None
    except XlsxPackageError:
        raise HTTPException(
            status_code=400,
            detail="O arquivo enviado não é uma planilha .xlsx válida.",
        ) from None
    except HTTPException:
        raise
    except (OSError, ValueError):
        raise HTTPException(
            status_code=400,
            detail="O arquivo enviado não é uma planilha .xlsx válida.",
        ) from None


def _check_startup_xlsx(path: Optional[Path]) -> Dict[str, Any]:
    """Check the local XLSX container without loading or logging workbook data."""
    if path is None:
        return {"available": False, "file": None, "reason": "ausente"}
    if not path.is_file():
        return {"available": False, "file": path.name, "reason": "ausente"}

    try:
        validate_xlsx(path)
    except XlsxLimitExceeded:
        return {"available": False, "file": path.name, "reason": "planilha excede os limites de processamento"}
    except XlsxPackageError:
        return {"available": False, "file": path.name, "reason": "arquivo inacessível ou XLSX inválido"}
    except (OSError, ValueError):
        return {"available": False, "file": path.name, "reason": "arquivo inacessível ou XLSX inválido"}

    return {"available": True, "file": path.name, "reason": "OK"}


_READINESS_VALIDATION_CACHE: Dict[Tuple[str, int, int, int, str], Dict[str, Any]] = {}
_READINESS_VALIDATION_LOCK = threading.Lock()


def get_local_transfer_template() -> Path:
    override = INPUT_DIR / "_modelos" / "transferencia.xlsx"
    return override if override.exists() else TEMPLATE_FILE


def _check_ready_workbook(path: Path, role: str) -> Dict[str, Any]:
    status = {"available": False, "file": path.name, "reason": "ausente", "state": "awaiting_import"}
    if not path.exists():
        return status
    try:
        stat = path.stat()
        key = (str(path.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, role)
        with _READINESS_VALIDATION_LOCK:
            cached = _READINESS_VALIDATION_CACHE.get(key)
        if cached is not None:
            return dict(cached)
        if role in {"transferencia", "exportacao"}:
            validate_local_model(path, role)
        else:
            if stat.st_size > MAX_UPLOAD_BYTES:
                raise ValueError("A planilha excede o limite de 30 MB.")
            validate_uploaded_workbook(path.read_bytes(), role)
        status.update(available=True, reason="OK", state="ready")
        with _READINESS_VALIDATION_LOCK:
            if len(_READINESS_VALIDATION_CACHE) >= 64:
                _READINESS_VALIDATION_CACHE.clear()
            _READINESS_VALIDATION_CACHE[key] = dict(status)
    except Exception as error:
        status.update(reason=str(getattr(error, "detail", error)) or "planilha inválida", state="invalid")
    return status


def _check_startup_ticket_report(path: Optional[Path]) -> Dict[str, Any]:
    """Check ticket history storage while allowing a fresh, not-yet-imported setup."""
    if path is None:
        return {"available": False, "file": None, "reason": "arquivo de histórico não configurado"}
    if not path.exists():
        return {
            "available": False,
            "file": path.name,
            "reason": "aguardando a primeira importação",
            "state": "awaiting_import",
        }
    if not path.is_file():
        return {"available": False, "file": path.name, "reason": "caminho do histórico inválido"}

    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {"available": False, "file": path.name, "reason": "histórico inacessível ou JSON inválido"}
    if not isinstance(report, dict) or not isinstance(report.get("chamados"), list):
        return {"available": False, "file": path.name, "reason": "estrutura do histórico inválida"}
    return {"available": True, "file": path.name, "reason": "OK"}


def get_startup_readiness() -> Dict[str, Any]:
    if postgres_backend() is not None:
        return _get_startup_readiness_unlocked()
    # Avoid publishing transient availability while an upload is being applied.
    with lock_paths([TRANSACTION_ROOT / ".atomic-transactions"]):
        return _get_startup_readiness_unlocked()


def _get_startup_readiness_unlocked() -> Dict[str, Any]:
    """Map essential local files to the application functions that need them."""
    ticket_report_status = _check_startup_ticket_report(TICKET_REPORT_FILE)
    if (backend := postgres_backend()) is not None:
        state = backend.state()
        available = bool(state["equipamentos_cache"])
        reason = "Nenhum lote com equipamentos foi importado no piloto local."
        return {
            "backend": "postgres",
            "files": {
                "inventario_equipamentos": {"available": available, "file": "PostgreSQL local", "reason": "OK" if available else reason},
                "historico_chamados": ticket_report_status,
            },
            "functions": {
                "consulta_equipamentos": {"available": available, "missing_files": [] if available else [reason]},
                "comparacao_atualizacao_inventarios": {"available":backend.files.storage is not None,"missing_files":[] if backend.files.storage is not None else ["Storage do piloto não configurado"]},
                "geracao_transferencia": {"available":state.get("transfer_available",False),"missing_files":[] if state.get("transfer_available") else ["Modelo de transferência privado ausente"]},
                "exportacao_equipamentos": {"available":state["stats_cache"].get("exportacao_disponivel",False),"missing_files":[] if state["stats_cache"].get("exportacao_disponivel") else [state["stats_cache"].get("exportacao_motivo", "Modelo de exportação ausente")]},
                "acompanhamento_chamados": {"available": ticket_report_status["available"], "missing_files": [] if ticket_report_status["available"] else [ticket_report_status["reason"]]},
            },
        }
    try:
        details_candidates = get_details_files()
        details_directory_readable = True
    except Exception:
        details_candidates = []
        details_directory_readable = False
    try:
        active_details = get_primary_equipment_file()
    except Exception:
        active_details = None

    units_loaded = False
    if active_details is not None:
        details_status = _check_startup_xlsx(active_details)
        with STATE_LOCK:
            base_loaded = bool(equipamentos_cache)
            units_loaded = bool(unidades_cache)
        if details_status["available"] and not base_loaded:
            details_status.update(available=False, reason="inventário não carregado; importe o par Simpress e Endpoint")
    elif details_candidates:
        details_status = {
            "available": False,
            "file": details_candidates[0].name,
            "reason": "nenhum inventário contém aba e cabeçalhos válidos",
        }
    elif not details_directory_readable:
        details_status = {
            "available": False,
            "file": DETAILS_UPLOAD_FILE.name,
            "reason": "não foi possível ler a pasta de inventários",
        }
    else:
        details_status = {
            "available": False,
            "file": DETAILS_UPLOAD_FILE.name,
            "reason": "ausente",
        }

    try:
        load_modified_apelidos()
        load_custom_units()
        if ALIAS_HISTORY_FILE.exists():
            load_alias_history()
        if COMPARISON_HISTORY_FILE.exists():
            load_comparison_history()
        local_state_status = {"available": True, "file": "catálogos e históricos JSON", "reason": "OK"}
    except (LocalJsonCorruptionError, HTTPException) as error:
        local_state_status = {
            "available": False,
            "file": "catálogos e históricos JSON",
            "reason": str(getattr(error, "detail", error)),
        }

    files = {
        "template_transferencia": _check_ready_workbook(get_local_transfer_template(), "transferencia"),
        "inventario_equipamentos": details_status,
        "inventario_detalhes_atualizacao": _check_ready_workbook(DETAILS_UPLOAD_FILE, "detalhes"),
        "inventario_endpoint": _check_ready_workbook(ENDPOINT_UPLOAD_FILE, "endpoint"),
        "modelo_exportacao": _check_ready_workbook(EXPORT_MODEL_FILE, "exportacao"),
        "catalogos_locais": local_state_status,
        "historico_chamados": ticket_report_status,
    }
    if files["modelo_exportacao"]["available"] and details_status["available"]:
        count_export_changes(locked=True)
        export_status = get_export_status()
        if not export_status["available"]:
            files["modelo_exportacao"].update(available=False, state="invalid", reason=export_status["reason"])
    for status in files.values():
        status.setdefault("state", "ready" if status["available"] else
                          "awaiting_import" if status["reason"] == "ausente" else "invalid")
    requirements = {
        "consulta_equipamentos": ["inventario_equipamentos", "catalogos_locais"],
        "geracao_transferencia": ["inventario_equipamentos", "catalogos_locais", "template_transferencia"],
        "comparacao_atualizacao_inventarios": [
            "inventario_equipamentos",
            "inventario_detalhes_atualizacao",
            "inventario_endpoint",
        ],
        "exportacao_equipamentos": ["inventario_equipamentos", "modelo_exportacao"],
        "acompanhamento_chamados": ["historico_chamados"],
    }
    functions = {
        name: {
            "available": all(files[key]["available"] for key in required_files),
            "missing_files": list(dict.fromkeys(
                files[key]["file"] or key
                for key in required_files
                if not files[key]["available"]
            )),
            "state": "ready" if all(files[key]["available"] for key in required_files)
                else "invalid" if any(files[key]["state"] == "invalid" for key in required_files)
                else "awaiting_import",
        }
        for name, required_files in requirements.items()
    }
    if functions["geracao_transferencia"]["available"] and not units_loaded:
        functions["geracao_transferencia"].update(available=False, state="invalid", missing_files=["localidades do inventário"])
    return {"backend": "files", "files": files, "functions": functions}


def report_startup_readiness() -> None:
    """Log a clear feature impact summary without exposing workbook contents."""
    report = get_startup_readiness()
    labels = {
        "template_transferencia": "Modelo de transferência",
        "inventario_equipamentos": "Inventário ativo EquipamentosDetalhes",
        "inventario_detalhes_atualizacao": "EquipamentosDetalhes para atualização",
        "inventario_endpoint": "Inventário InvAllComputersSummary",
        "modelo_exportacao": "Modelo de exportação",
        "catalogos_locais": "Catálogos e históricos locais",
        "historico_chamados": "Histórico do acompanhamento de chamados",
    }
    print("[PRONTIDÃO] Verificação dos arquivos locais:")
    for key, status in report["files"].items():
        if not status["available"]:
            state = f"INDISPONÍVEL ({status['reason']})"
        elif key == "historico_chamados":
            state = "JSON válido" if status["reason"] == "OK" else status["reason"]
        elif key == "catalogos_locais":
            state = "catálogos e históricos disponíveis"
        else:
            state = "PACOTE XLSX válido"
        filename = status["file"] or "arquivo não localizado"
        print(f"[PRONTIDÃO] {labels[key]} — {filename}: {state}")

    function_labels = {
        "consulta_equipamentos": "Consulta de equipamentos",
        "geracao_transferencia": "Geração de planilha de transferência",
        "comparacao_atualizacao_inventarios": "Comparação e atualização de inventários",
        "exportacao_equipamentos": "Exportação de equipamentos",
        "acompanhamento_chamados": "Acompanhamento de chamados",
    }
    for key, status in report["functions"].items():
        if status["available"]:
            detail = (
                "armazenamento do histórico disponível"
                if key == "acompanhamento_chamados"
                else "arquivos necessários presentes (checagem estrutural)"
            )
            print(f"[PRONTIDÃO] {function_labels[key]}: {detail}.")
        else:
            missing = ", ".join(status["missing_files"])
            print(f"[PRONTIDÃO] {function_labels[key]}: INDISPONÍVEL; dependência ausente ou inválida: {missing}.")


def _report_startup_readiness_best_effort() -> None:
    """Log feature readiness when possible without making it a startup requirement."""
    try:
        report_startup_readiness()
    except Exception:
        logger.exception(
            "Não foi possível calcular a prontidão local; o servidor continuará em execução."
        )


def read_workbook_tables(file_bytes: bytes) -> List[Dict[str, Any]]:
    """Lê abas não vazias de um XLSX e retorna cabeçalhos normalizados e linhas."""
    workbook = None
    try:
        validate_xlsx_package(file_bytes)
        workbook = openpyxl.load_workbook(
            io.BytesIO(file_bytes),
            read_only=True,
            data_only=True,
            keep_links=False,
        )
        tables = []
        for worksheet in workbook.worksheets:
            iterator = worksheet.iter_rows(values_only=True)
            raw_headers = next(iterator, ())
            headers = [normalize_workbook_header(value) for value in raw_headers]
            if not any(headers):
                continue
            validate_unambiguous_workbook_headers(raw_headers)

            records = []
            for excel_row_number, values in enumerate(iterator, start=2):
                if not any(value is not None and str(value).strip() for value in values):
                    continue
                record = {
                    headers[index]: values[index]
                    for index in range(min(len(headers), len(values)))
                    if headers[index]
                }
                record["__excel_row_number__"] = excel_row_number
                records.append(record)
            tables.append({
                "sheet": worksheet.title,
                "headers": set(headers),
                "column_count": sum(bool(header) for header in headers),
                "records": records,
            })
        return tables
    except HTTPException:
        raise
    except WorkbookHeaderError as error:
        raise HTTPException(status_code=400, detail=f"Cabeçalhos inválidos: {error}") from None
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="O arquivo enviado não contém uma planilha .xlsx válida ou legível.",
        ) from None
    finally:
        if workbook is not None:
            workbook.close()


def select_upload_table(tables: List[Dict[str, Any]], role: str) -> Dict[str, Any]:
    """Validates the required columns and refuses to guess between matching sheets."""
    serial_headers = set(DETAILS_SERIAL_HEADER_ALIASES)
    alias_headers = set(DETAILS_ALIAS_HEADER_ALIASES)

    if role == "detalhes":
        required = set(DETAILS_REQUIRED_HEADERS)
        basic_candidates = [
            table for table in tables
            if required.issubset(table["headers"])
            and table["headers"] & serial_headers
            and table["headers"] & alias_headers
        ]
        installation_cnpj_headers = {
            normalize_workbook_header(alias)
            for alias in DETAILS_INSTALLATION_CNPJ_HEADER_ALIASES
        }
        candidates = [
            table for table in basic_candidates
            if table.get("column_count", len(table["headers"] - {""})) == DETAILS_COMPLETE_SOURCE_COLUMN_COUNT
            and table["headers"] & installation_cnpj_headers
        ]
        description = (
            "a base completa de EquipamentosDetalhes com exatamente "
            f"{DETAILS_COMPLETE_SOURCE_COLUMN_COUNT} colunas, incluindo número de série, "
            "apelido/hostname, modelo, cidade e CNPJ de instalação"
        )
    elif role == "endpoint":
        name_headers = {"NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME"}
        service_tag_headers = {
            "ROTULODESERVICONUMERODESERIE", "NUMEROSERIE", "NUMERODESERIE", "SERIAL", "SERVICETAG"
        }
        candidates = [
            table for table in tables
            if table["headers"] & name_headers and table["headers"] & service_tag_headers
        ]
        description = "nome do computador e rótulo de serviço/número de série"
    else:
        raise ValueError(f"Papel de planilha desconhecido: {role}")

    candidates = [table for table in candidates if table["records"]]
    if not candidates:
        display_role = {
            "endpoint": "Endpoint",
            "detalhes": "Simpress",
        }[role]
        if role == "detalhes" and any(table["records"] for table in basic_candidates):
            actual_column_counts = sorted({
                table.get("column_count", len(table["headers"] - {""}))
                for table in basic_candidates
            })
            schema_problems = []
            if any(count != DETAILS_COMPLETE_SOURCE_COLUMN_COUNT for count in actual_column_counts):
                schema_problems.append(
                    "possui " + ", ".join(str(count) for count in actual_column_counts) + " colunas"
                )
            if any(not (table["headers"] & installation_cnpj_headers) for table in basic_candidates):
                schema_problems.append("não contém o cabeçalho CNPJ de instalação")
            problem_summary = " e ".join(schema_problems) or "não corresponde ao formato completo"
            raise HTTPException(
                status_code=400,
                detail=(
                    f"A planilha enviada como Simpress foi recusada: {problem_summary}. "
                    "A base de entrada precisa ter exatamente "
                    f"{DETAILS_COMPLETE_SOURCE_COLUMN_COUNT} colunas e o cabeçalho CNPJ de instalação. "
                    "A planilha reduzida do Exportar Excel não pode ser usada em Atualizar Planilhas."
                ),
            )
        raise HTTPException(
            status_code=400,
            detail=f"A planilha enviada como {display_role} não contém uma aba com os cabeçalhos obrigatórios: {description}.",
        )

    if len(candidates) > 1:
        sheet_names = ", ".join(f"'{table['sheet']}'" for table in candidates)
        display_role = {
            "endpoint": "Endpoint",
            "detalhes": "Simpress",
        }[role]
        raise HTTPException(
            status_code=400,
            detail=(
                f"O arquivo selecionado para {display_role} tem mais de uma aba compatível "
                f"({sheet_names}). A seleção automática foi cancelada; envie um arquivo com "
                "apenas a aba correta para evitar comparar a tabela errada."
            ),
        )

    table = candidates[0]
    if role == "endpoint":
        name_column = next(key for key in ("NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME") if key in table["headers"])
        populated_rows = sum(1 for row in table["records"] if str(row.get(name_column) or "").strip())
    else:
        populated_rows = sum(
            1 for row in table["records"]
            if _record_value(row, "NumeroSerie", "Número de série", "Serial", "ServiceTag")
        )

    if populated_rows == 0:
        raise HTTPException(status_code=400, detail=f"A aba '{table['sheet']}' não tem linhas de dados utilizáveis.")

    if role == "detalhes":
        installation_cnpj_column = next(
            header for header in table["headers"] if header in installation_cnpj_headers
        )
        missing_installation_cnpj_rows = sum(
            1
            for row in table["records"]
            if _record_value(row, "NumeroSerie", "Número de série", "Serial", "ServiceTag")
            and not str(row.get(installation_cnpj_column) or "").strip()
        )
        if missing_installation_cnpj_rows:
            raise HTTPException(
                status_code=400,
                detail=(
                    "A base completa da Simpress contém "
                    f"{missing_installation_cnpj_rows} série(s) sem CNPJ de instalação. "
                    "Preencha esse campo para todas as séries antes de atualizar as planilhas."
                ),
            )

    table["populated_rows"] = populated_rows
    return table


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
    except Exception:
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
    if not ENDPOINT_UPLOAD_FILE.is_file():
        return {"available": False, "unique": {}, "duplicates": {}, "blank_serials": [], "blank_hostnames": {}}

    try:
        table = validate_uploaded_workbook(ENDPOINT_UPLOAD_FILE.read_bytes(), "endpoint")
    except Exception:
        print("[AVISO] Não foi possível ler os hostnames atuais da InvAll.")
        return {"available": False, "unique": {}, "duplicates": {}, "blank_serials": [], "blank_hostnames": {}}

    rows_by_serial: Dict[str, List[Dict[str, str]]] = {}
    blank_serials: List[Dict[str, str]] = []
    for record in table.get("records", []):
        serial = _record_value(
            record,
            "ROTULODESERVICONUMERODESERIE",
            "NUMEROSERIE",
            "NUMERODESERIE",
            "SERIAL",
            "SERVICETAG",
        )
        serial_key = normalize_reference_value(serial)
        hostname = str(
            _record_value(record, "NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME", "APELIDO") or ""
        ).strip()
        row = {"serie": str(serial or "").strip(), "hostname": hostname}
        if serial_key:
            rows_by_serial.setdefault(serial_key, []).append(row)
        elif hostname:
            blank_serials.append(row)

    unique: Dict[str, str] = {}
    duplicates: Dict[str, List[Dict[str, str]]] = {}
    blank_hostnames: Dict[str, Dict[str, str]] = {}
    for serial_key, rows in rows_by_serial.items():
        if len(rows) > 1:
            duplicates[serial_key] = rows
        elif rows[0]["hostname"]:
            unique[serial_key] = rows[0]["hostname"]
        else:
            blank_hostnames[serial_key] = rows[0]

    return {
        "available": True,
        "unique": unique,
        "duplicates": duplicates,
        "blank_serials": blank_serials,
        "blank_hostnames": blank_hostnames,
    }


def endpoint_alias_review_items(
    index: Dict[str, Any],
    details_serials: Optional[Set[str]] = None,
    details_duplicate_serials: Optional[Set[str]] = None,
) -> List[Dict[str, str]]:
    """Describe InvAll rows that were deliberately not applied."""
    items: List[Dict[str, str]] = []
    for serial_key, rows in sorted(index.get("duplicates", {}).items()):
        items.append({
            "serie": rows[0].get("serie") or serial_key,
            "computador": ", ".join(row.get("hostname", "") for row in rows if row.get("hostname")),
            "motivo": "Série duplicada no endpoint; nenhum hostname foi escolhido.",
        })
    for row in index.get("blank_serials", []):
        items.append({
            "serie": "",
            "computador": row.get("hostname", ""),
            "motivo": "Número de série vazio no endpoint; hostname mantido sem associação.",
        })
    for serial_key, row in sorted(index.get("blank_hostnames", {}).items()):
        items.append({
            "serie": row.get("serie") or serial_key,
            "computador": "",
            "motivo": "Hostname vazio no endpoint; apelido atual preservado.",
        })
    if details_serials is not None:
        raw_details_duplicates = {
            normalize_reference_value(serial)
            for serial in (details_duplicate_serials or set())
        }
        mac_endpoint_serials = {
            normalize_reference_value(serial_key)
            for serial_key, hostname in index.get("unique", {}).items()
            if normalize_reference_value(hostname).startswith("PRMAC")
        }
        normalized_details_serials = set()
        normalized_details_duplicates = set()
        canonical_sources: Dict[str, Set[str]] = {}
        for serial_value in details_serials:
            serial_key = normalize_reference_value(serial_value)
            if not serial_key:
                continue
            comparison_key = (
                serial_key[1:]
                if serial_key.startswith("S") and serial_key[1:] in mac_endpoint_serials
                else serial_key
            )
            normalized_details_serials.add(comparison_key)
            canonical_sources.setdefault(comparison_key, set()).add(serial_key)
            if serial_key in raw_details_duplicates:
                normalized_details_duplicates.add(comparison_key)
        for comparison_key, source_keys in canonical_sources.items():
            if len(source_keys) > 1:
                normalized_details_duplicates.add(comparison_key)
        details_serials = normalized_details_serials
        details_duplicates = normalized_details_duplicates
        for serial_key in sorted(details_duplicates):
            items.append({
                "serie": serial_key,
                "computador": index.get("unique", {}).get(serial_key, ""),
                "motivo": "Série duplicada na Simpress; nenhum registro foi escolhido.",
            })
        known_invall_serials = (
            set(index.get("unique", {}))
            | set(index.get("duplicates", {}))
            | set(index.get("blank_hostnames", {}))
        )
        for serial_key in sorted(details_serials - known_invall_serials - details_duplicates):
            items.append({
                "serie": serial_key,
                "computador": "",
                "motivo": (
                    "Endpoint indisponível; apelido atual preservado para conferência."
                    if not index.get("available")
                    else "Série não encontrada no endpoint; apelido atual preservado."
                ),
            })
        for serial_key, hostname in sorted(index.get("unique", {}).items()):
            if serial_key not in details_serials:
                items.append({
                    "serie": serial_key,
                    "computador": hostname,
                    "motivo": "Série não encontrada na Simpress; nenhum dado foi alterado.",
                })
    return items


def _manual_alias_for_serial(overrides: Dict[str, str], serial: Any, fallback: str) -> str:
    serial_key = normalize_reference_value(serial)
    matches = [
        str(alias or "").strip()
        for key, alias in overrides.items()
        if normalize_reference_value(key) == serial_key
    ]
    return matches[0] if serial_key and len(matches) == 1 else fallback


def _manual_aliases_by_serial(overrides: Dict[str, str]) -> Dict[str, str]:
    aliases_by_serial: Dict[str, List[str]] = {}
    for serial, alias in overrides.items():
        serial_key = normalize_reference_value(serial)
        if serial_key:
            aliases_by_serial.setdefault(serial_key, []).append(str(alias or "").strip())
    return {
        serial_key: aliases[0]
        for serial_key, aliases in aliases_by_serial.items()
        if len(aliases) == 1
    }


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
    serial_key = normalize_reference_value(equipment.get("serial"))
    local_alias = str(equipment.get("_apelido_local", equipment.get("_apelido_base", "")) or "").strip()
    manual_override = bool(equipment.get("_apelido_manual_override"))
    equipment["apelido"] = local_alias

    if not endpoint_index.get("available"):
        equipment["invall_alias_status"] = "indisponivel"
        equipment["invall_alias_detail"] = "O Endpoint ativo não pôde ser lido; o apelido atual foi mantido."
    elif details_duplicate:
        equipment["invall_alias_status"] = "serie_detalhes_duplicada"
        equipment["invall_alias_detail"] = "A série aparece mais de uma vez na Simpress; confira antes de aplicar um hostname."
    elif serial_key in endpoint_index.get("duplicates", {}):
        equipment["invall_alias_status"] = "serie_invall_duplicada"
        equipment["invall_alias_detail"] = "A série aparece mais de uma vez no endpoint; o apelido atual foi mantido."
    elif serial_key in endpoint_index.get("unique", {}):
        if not manual_override:
            equipment["apelido"] = endpoint_index["unique"][serial_key]
        equipment["invall_alias_status"] = "aplicado"
        equipment["invall_alias_detail"] = (
            "Série associada ao Endpoint; o apelido manual prevalece."
            if manual_override
            else "Hostname do Endpoint associado pela série normalizada."
        )
    elif serial_key in endpoint_index.get("blank_hostnames", {}):
        equipment["invall_alias_status"] = "hostname_vazio"
        equipment["invall_alias_detail"] = "O Endpoint tem a série, mas o hostname está vazio; o apelido atual foi mantido."
    else:
        equipment["invall_alias_status"] = "serie_nao_encontrada"
        equipment["invall_alias_detail"] = "Série não encontrada no endpoint; o apelido atual foi mantido."


def get_export_aliases(endpoint_index: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Combina hostnames da InvAll com apelidos manuais, que têm prioridade."""
    aliases = dict(
        endpoint_index.get("unique", {})
        if endpoint_index is not None
        else load_endpoint_aliases()
    )
    aliases.update(_manual_aliases_by_serial(load_modified_apelidos()))
    return aliases


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
    for path in (get_parque_file(), EXPORT_MODEL_FILE, ENDPOINT_UPLOAD_FILE, MODIFIED_APELIDOS_FILE):
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
    global _POSTGRES_BACKEND
    if PERSISTENCE_SETTINGS.backend == "postgres":
        from persistence.postgres import PostgresBackend
        backend = PostgresBackend(PERSISTENCE_SETTINGS, sys.modules[__name__])
        try:
            await asyncio.to_thread(backend.open)
            _POSTGRES_BACKEND = backend
            yield
        finally:
            _POSTGRES_BACKEND = None
            await asyncio.to_thread(backend.close)
        return
    recover_pending_transactions(TRANSACTION_ROOT)
    try:
        migration_result = await asyncio.to_thread(migrate_legacy_history_annotations)
        if migration_result.get("legadas_enfileiradas"):
            logger.info(
                "Anotações legadas preparadas para sincronização: %s.",
                migration_result,
            )
    except Exception:
        logger.exception("Falha ao migrar anotações legadas do histórico de planilhas.")
    annotation_sync_task = asyncio.create_task(_history_annotation_sync_worker())
    automatic_import_task = asyncio.create_task(_automatic_inventory_import_worker())
    automatic_ticket_import_task = asyncio.create_task(_automatic_ticket_import_worker())
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
    try:
        yield
    finally:
        annotation_sync_task.cancel()
        automatic_import_task.cancel()
        automatic_ticket_import_task.cancel()
        await asyncio.gather(
            annotation_sync_task,
            automatic_import_task,
            automatic_ticket_import_task,
            return_exceptions=True,
        )


async def _history_annotation_sync_worker() -> None:
    while True:
        await asyncio.sleep(60)
        try:
            await asyncio.to_thread(flush_pending_history_annotations)
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


@app.exception_handler(PersistenceError)
async def persistence_error_handler(request, error):
    return JSONResponse(status_code=error.status_code, content={"detail": error.detail})


app.add_middleware(PersistenceBoundaryMiddleware, is_postgres=lambda: PERSISTENCE_SETTINGS.backend == "postgres")


class LocalRequestSafetyMiddleware:
    """Restrict local peers and authorities, cap uploads, and hide exceptions."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        if not is_direct_loopback_request(scope):
            response = JSONResponse(
                status_code=403,
                content={"detail": "A aplicação aceita somente conexões locais diretas, sem proxy."},
            )
            await response(scope, receive, send)
            return

        path = scope.get("path", "")
        raw_headers = scope.get("headers", [])
        headers = {key.lower(): value for key, value in raw_headers}
        host_values = [value for key, value in raw_headers if key.lower() == b"host"]
        if len(host_values) != 1:
            response = JSONResponse(
                status_code=400,
                content={"detail": "O cabeçalho Host da solicitação é inválido."},
            )
            await response(scope, receive, send)
            return

        host_authority = _parse_request_authority(host_values[0])
        if host_authority is None:
            response = JSONResponse(
                status_code=400,
                content={"detail": "O cabeçalho Host da solicitação é inválido."},
            )
            await response(scope, receive, send)
            return
        if host_authority not in _ALLOWED_LOCAL_AUTHORITIES:
            response = JSONResponse(
                status_code=403,
                content={"detail": "O Host não está autorizado para a aplicação local."},
            )
            await response(scope, receive, send)
            return

        origin_values = [value for key, value in raw_headers if key.lower() == b"origin"]
        if path.startswith("/api/") and origin_values and (
            len(origin_values) != 1
            or _parse_request_authority(origin_values[0], is_origin=True) != host_authority
        ):
            response = JSONResponse(
                status_code=403,
                content={"detail": "Origem não autorizada para a aplicação local."},
            )
            await response(scope, receive, send)
            return

        is_inventory_upload = path == "/api/planilhas/atualizar"
        is_model_upload = path.startswith("/api/modelos/") and path.endswith("/importar")
        is_ticket_upload = path == "/api/operacoes/chamados/importar"
        body_limit = (
            MAX_UPLOAD_REQUEST_BYTES if is_inventory_upload
            else MAX_UPLOAD_BYTES + 1024 * 1024 if is_model_upload
            else 2 * MAX_TICKET_WORKBOOK_BYTES + 1024 * 1024 if is_ticket_upload
            else MAX_API_REQUEST_BYTES if path.startswith("/api/") and scope.get("method") in {"POST", "PUT", "PATCH"}
            else None
        )
        if body_limit is not None:
            content_length = headers.get(b"content-length")
            if content_length is not None:
                try:
                    request_size = int(content_length)
                except (TypeError, ValueError):
                    response = JSONResponse(
                        status_code=400,
                        content={"detail": "O tamanho do envio é inválido."},
                    )
                    await response(scope, receive, send)
                    return
                if request_size > body_limit:
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": "O corpo da solicitação excede o limite permitido."},
                    )
                    await response(scope, receive, send)
                    return

        uses_upload_admission = is_inventory_upload or is_model_upload or is_ticket_upload or path == "/api/recarregar-base"
        if uses_upload_admission:
            key_headers = [value for name, value in raw_headers if name.lower() == b"idempotency-key"]
            is_keyed_inventory_update = is_inventory_upload and scope.get("method") == "POST"
            if is_keyed_inventory_update and len(key_headers) > 1:
                response = JSONResponse(
                    status_code=422,
                    content={"detail": "Informe somente uma Idempotency-Key."},
                )
                await response(scope, receive, send)
                return
            if (
                is_keyed_inventory_update
                and key_headers
                and not IDEMPOTENCY_KEY_PATTERN.fullmatch(key_headers[0].decode("latin-1"))
            ):
                response = JSONResponse(
                    status_code=422,
                    content={"detail": "Idempotency-Key deve conter de 1 a 128 letras, números, ponto, hífen, dois-pontos ou sublinhado."},
                )
                await response(scope, receive, send)
                return
            admitted = UPLOAD_ADMISSION.acquire(blocking=False)
            if (
                not admitted
                and is_keyed_inventory_update
                and len(key_headers) == 1
            ):
                # A keyed retry waits behind the in-flight upload so it can read
                # the durable receipt instead of failing before idempotency runs.
                deadline = asyncio.get_running_loop().time() + IDEMPOTENT_UPLOAD_ADMISSION_WAIT_SECONDS
                while not admitted and asyncio.get_running_loop().time() < deadline:
                    await asyncio.sleep(0.02)
                    admitted = UPLOAD_ADMISSION.acquire(blocking=False)
            if not admitted:
                response = JSONResponse(
                    status_code=503,
                    content={"detail": "A operação de inventário está ocupada. Tente novamente em instantes."},
                    headers={"Retry-After": "2"},
                )
                await response(scope, receive, send)
                return

        response_started = False
        request_size = 0

        async def safe_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        async def limited_receive():
            nonlocal request_size
            message = await receive()
            if body_limit is not None and message["type"] == "http.request":
                request_size += len(message.get("body", b""))
                if request_size > body_limit:
                    raise RequestBodyTooLarge()
            return message

        try:
            await self.app(scope, limited_receive, safe_send)
        except RequestBodyTooLarge:
            if response_started:
                return
            response = JSONResponse(
                status_code=413,
                content={"detail": "O corpo da solicitação excede o limite permitido."},
            )
            await response(scope, receive, send)
        except LocalJsonCorruptionError as error:
            if response_started:
                return
            response = JSONResponse(status_code=503, content={"detail": str(error)})
            await response(scope, receive, send)
        except Exception as error:
            print(
                f"[ERRO] Falha interna na rota {path or '/'} "
                f"({type(error).__name__})."
            )
            if response_started:
                return
            response = JSONResponse(
                status_code=500,
                content={"detail": "Falha interna do servidor. Consulte os logs locais."},
            )
            await response(scope, receive, send)
        finally:
            if uses_upload_admission:
                UPLOAD_ADMISSION.release()


SERVER_PORT = int(os.environ.get("SIMPRESS_PORT", "8000"))
IDEMPOTENT_UPLOAD_ADMISSION_WAIT_SECONDS = 120

_ALLOWED_LOCAL_AUTHORITIES = frozenset({
    ("127.0.0.1", SERVER_PORT),
    ("localhost", SERVER_PORT),
    ("::1", SERVER_PORT),
})


def _parse_request_authority(
    value: bytes,
    *,
    is_origin: bool = False,
) -> Optional[tuple[str, int]]:
    """Normalize a local Host or HTTP Origin without accepting suffix tricks."""
    try:
        text = value.decode("ascii")
    except UnicodeDecodeError:
        return None
    if not text or text != text.strip() or any(ord(character) < 0x20 for character in text):
        return None

    try:
        if is_origin:
            parsed = urlsplit(text)
            if (
                parsed.scheme.lower() != "http"
                or not parsed.netloc
                or parsed.path
                or parsed.query
                or parsed.fragment
            ):
                return None
        else:
            parsed = urlsplit(f"//{text}")
            if parsed.path or parsed.query or parsed.fragment:
                return None
        if parsed.username is not None or parsed.password is not None:
            return None
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None

    if hostname is None or port is None:
        return None
    return hostname.rstrip(".").lower(), port


app.add_middleware(LocalRequestSafetyMiddleware)
app.add_middleware(AuthenticationMiddleware, provider=postgres_backend, settings=lambda: AUTH_SETTINGS)

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

    with ALIAS_HISTORY_LOCK, COMPARISON_HISTORY_LOCK:
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
    if (backend := postgres_backend()) is not None:
        state = backend.state()
        # PostgreSQL requests use their own committed snapshots, never the XLSX cache.
        return True if publish else state
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
    active_details_file = get_parque_file()
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
    except Exception:
        print("[ERRO] Falha ao ler a planilha local de equipamentos.")
        return False

    # Strip column names e criar mapa normalizado de colunas
    norm_cols = {normalize_workbook_header(column): column for column in headers}
    new_equipamentos_cache: Dict[str, Dict[str, Any]] = {}
    details_serial_counts: Dict[str, int] = {}

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
        tipo = get_row_val(row, "Tipo", "ClasseEquipamento")
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
    tipo_col_real = norm_cols.get("tipo") or "Tipo"
    type_counts = dict(Counter(
        row.get(tipo_col_real, "")
        for row in records
        if tipo_col_real in headers
    ).most_common())
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
    if (backend := postgres_backend()) is not None:
        equipment = backend.state()["equipamentos_cache"].get(clean_serial)
        if equipment is not None:
            return _public_equipment(equipment)
        raise HTTPException(status_code=404, detail=f"Equipamento com serial '{serial}' não encontrado na base de dados.")
    with STATE_LOCK:
        equipment = deepcopy(equipamentos_cache.get(clean_serial))
    if equipment is not None:
        return _public_equipment(equipment)

    raise HTTPException(status_code=404, detail=f"Equipamento com serial '{serial}' não encontrado na base de dados.")


@app.post("/api/equipamento/salvar")
def salvar_equipamento(payload: EquipamentoUpdatePayload):
    """Atualiza ou cadastra um equipamento tanto na memória do site quanto diretamente na planilha Excel."""
    result = postgres_command("equipment", {"data": payload.model_dump(), "fields": sorted(payload.model_fields_set)})
    if result is not None:
        return result
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
    result = postgres_command("alias", payload.model_dump())
    if result is not None:
        return result
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
    result = postgres_command("delete_history", {"evento_id": evento_id})
    if result is not None:
        return result
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
    result = postgres_command("undo", payload.model_dump())
    if result is not None:
        return result
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
    if (backend := postgres_backend()) is not None:
        from persistence.exports import equipment
        return equipment(backend.files)
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
                source_file, wb, original, expected_values, allow_threaded_comments=True
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
    if (backend := postgres_backend()) is not None:
        state = backend.state()
        stats = state["stats_cache"]
        return {"sucesso": True, "arquivo_origem": stats["arquivo_origem"],
                "total_equipamentos": stats["total_equipamentos"], "total_unidades": stats["total_unidades"],
                "stats": stats, "mensagem": "Estado do PostgreSQL local recarregado."}
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
)


async def _import_automatic_inventory_batch(
    batch_id: str,
    endpoint_name: str,
    endpoint_bytes: bytes,
    simpress_name: str,
    simpress_bytes: bytes,
):
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


async def read_uploaded_xlsx(upload: UploadFile, role: str) -> Dict[str, Any]:
    return await _read_uploaded_xlsx(upload, role, _inventory_update_services)


@app.post("/api/planilhas/atualizar")
async def atualizar_planilhas(
    endpoint_file: UploadFile = File(...),
    details_file: UploadFile = File(...),
):
    if (backend := postgres_backend()) is not None:
        from persistence.routes import update
        return await update(backend.files,endpoint_file,details_file,read_uploaded_xlsx)
    result = await update_inventory_files(
        endpoint_file,
        details_file,
        services=_inventory_update_services,
        idempotency_key=idempotency_key.get(),
    )
    try:
        await asyncio.to_thread(prune_expired_histories)
    except Exception:
        event_id = (result.get("comparacao") or {}).get("evento_id") if isinstance(result, dict) else None
        logger.exception(
            "Falha na retenção após a atualização confirmada (evento=%s).",
            event_id or "desconhecido",
        )
    return result








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

    if (backend := postgres_backend()) is not None:
        return backend.search_equipment(term)

    with STATE_LOCK:
        if _EQUIPMENT_SEARCH_INDEX_SOURCE is not equipamentos_cache:
            _refresh_equipment_search_index_locked()
        current_index = _EQUIPMENT_SEARCH_INDEX
    return search_normalized_equipment_index(current_index, term)


def _get_stats_snapshot() -> Dict[str, Any]:
    if (backend := postgres_backend()) is not None:
        return backend.state()["stats_cache"]
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
    if (backend := postgres_backend()) is not None:
        return backend.state()["unidades_cache"]
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
    save_postgres_unit=lambda payload: postgres_command("unit", payload.model_dump()),
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

def _postgres_transfer(payload):
    if (backend := postgres_backend()) is not None:
        from persistence.exports import transfer
        return transfer(backend.files,payload)
    return None


transfer_router, gerar_planilha = create_transfer_router(get_local_transfer_template, _postgres_transfer)
app.include_router(transfer_router)


def _check_imported_export():
    if get_primary_equipment_file() is not None:
        count_export_changes(locked=True)
        status = get_export_status()
        return None if status["available"] else status["reason"]
    return None  # A model can be configured before the first inventory pair.


local_setup_router, importar_modelo_local = create_local_setup_router(
    enabled=lambda: postgres_backend() is None,
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
    comparison_history_lock=COMPARISON_HISTORY_LOCK,
    comparison_history_for_display=comparison_history_for_display,
    details_upload_path=lambda: DETAILS_UPLOAD_FILE,
    endpoint_upload_path=lambda: ENDPOINT_UPLOAD_FILE,
    get_equipment_snapshot=_history_equipment_snapshot,
    get_equipment_template_file=get_equipamentos_template_file,
    history_annotation_record_path=history_annotation_record_path,
    history_annotation_row_fingerprint=history_annotation_row_fingerprint,
    history_annotations_directory=lambda: HISTORY_ANNOTATIONS_DIR,
    history_annotations_sync_enabled=lambda: postgres_backend() is not None or HISTORY_ANNOTATIONS_SYNC_ENABLED,
    input_directory=lambda: INPUT_DIR,
    atomic_file_transaction=lambda *args, **kwargs: AtomicFileTransaction(*args, **kwargs),
    inventory_state_transaction=inventory_state_transaction,
    load_comparison_history=load_comparison_history,
    load_database=lambda *args, **kwargs: load_database(*args, **kwargs),
    load_history_annotations=lambda directory: [] if postgres_backend() is not None else load_history_annotations(directory),
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
    postgres_files=lambda: backend.files if (backend := postgres_backend()) is not None else None,
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
    history_annotations_sync_enabled=lambda: postgres_backend() is not None or HISTORY_ANNOTATIONS_SYNC_ENABLED,
    load_history_annotation_records=lambda directory: load_history_annotations(directory),
)
app.include_router(operations_router)

from persistence.routes import create_files_router
app.include_router(create_files_router(postgres_backend,MAX_UPLOAD_BYTES))

# Serve static files and frontend
STATIC_DIR.mkdir(parents=True, exist_ok=True)
from security.routes import create_auth_router
app.include_router(create_auth_router(postgres_backend, lambda: AUTH_SETTINGS, STATIC_DIR))
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/favicon.ico", include_in_schema=False)
def serve_favicon():
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")

@app.get("/")
def read_root():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {
        "mensagem": "API Simpress Transferência ativa. O arquivo static/index.html está sendo inicializado.",
        "docs": "/docs"
    }

if __name__ == "__main__":
    import uvicorn
    equipment_source = get_primary_equipment_file() if PERSISTENCE_SETTINGS.backend == "files" else "PostgreSQL local"
    print(f"[INFO] Diretório do projeto: {BASE_DIR}")
    print(f"[INFO] Modelo de transferência: {TEMPLATE_FILE} ({'OK' if TEMPLATE_FILE.is_file() else 'AUSENTE'})")
    print(f"[INFO] Fonte EquipamentosDetalhes: {equipment_source or 'AUSENTE'}")
    print(f"[INFO] Porta local: {SERVER_PORT}")
    uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT, proxy_headers=False)
