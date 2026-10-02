import io
import filecmp
import hashlib
import hmac
import json
import os
import re
import shutil
import sys
import threading
import unicodedata
import uuid
import zipfile
from copy import deepcopy
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any, Set

import openpyxl
import pandas as pd
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from integrity import (
    AtomicFileTransaction,
    FileBusyError,
    FileTransactionError,
    TransactionConflictError,
    WorkbookSafetyError,
    atomic_copy_file,
    atomic_write_json,
    lock_paths,
    load_workbook_safely,
    recover_pending_transactions,
    serialize_workbook_validated,
    stage_workbook_update,
    workbook_snapshot,
)
from app_config import (
    ALIAS_HISTORY_FILE,
    BASE_DIR,
    COMPARISON_HISTORY_FILE,
    CUSTOM_UNIDADES_FILE,
    DETAILS_EXPORT_BASELINE_FILE,
    DETAILS_UPLOAD_FILE,
    ENDPOINT_UPLOAD_FILE,
    EXPORT_MODEL_FILE,
    INPUT_DIR,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_REQUEST_BYTES,
    MAX_XLSX_ARCHIVE_ENTRIES,
    MAX_XLSX_UNCOMPRESSED_BYTES,
    MODIFIED_APELIDOS_FILE,
    STATIC_DIR,
    TEMPLATE_FILE,
    TRANSACTION_ROOT,
    UPLOAD_BACKUPS_DIR,
)
from routers.inventory_history import create_inventory_history_router
from routers.transfers import (
    TransferenciaPayload,
    create_transfer_router,
    formatar_telefone_brasileiro,
)

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
    compare_uploaded_workbooks,
    comparison_history_for_display,
    filter_curitiba_hostname_location_mismatches,
    filter_sebrae_owned_unmatched_items,
    filter_update_review_items,
    filter_update_unmatched_details,
    filter_update_unmatched_series,
    is_curitiba_hostname_exception,
    is_prnoteti_curitiba_location_match,
    is_sebrae_owned_notebook_serial,
    location_for_computer_name,
    normalize_reference_value,
)
from domains.inventory_update import read_uploaded_xlsx as _read_uploaded_xlsx
from domains.inventory_update import update_inventory_files

# Runtime synchronization and in-memory state remain in the application entry point.
MODIFIED_APELIDOS_LOCK = threading.RLock()
ALIAS_HISTORY_LOCK = threading.RLock()
COMPARISON_HISTORY_LOCK = threading.RLock()
STATE_LOCK = threading.RLock()


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def _atomic_json_update(path: Path, updater, default):
    with AtomicFileTransaction(TRANSACTION_ROOT, [path]) as transaction:
        updated = transaction.update_json(path, updater, default)
        transaction.commit()
        return updated

def load_modified_apelidos(strict: bool = False) -> Dict[str, str]:
    with MODIFIED_APELIDOS_LOCK:
        if not MODIFIED_APELIDOS_FILE.exists():
            return {}
        try:
            with open(MODIFIED_APELIDOS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("O conteúdo não é um objeto JSON.")
            return data
        except Exception as e:
            if strict:
                raise RuntimeError("Não foi possível ler o arquivo local de apelidos.") from e
            print("[AVISO] Erro ao carregar o arquivo local de apelidos.")
            return {}

def save_modified_apelidos(apelidos: Dict[str, str]) -> None:
    with MODIFIED_APELIDOS_LOCK:
        try:
            atomic_write_json(MODIFIED_APELIDOS_FILE, apelidos)
        except Exception:
            raise

def save_modified_apelido_record(serial: str, apelido: str) -> None:
    s_key = serial.strip().upper()
    ap_val = apelido.strip()
    with MODIFIED_APELIDOS_LOCK:
        try:
            _atomic_json_update(
                MODIFIED_APELIDOS_FILE,
                lambda data: {**(data if isinstance(data, dict) else {}), s_key: ap_val},
                {},
            )
        except Exception:
            print("[ERRO] Falha ao gravar o arquivo local de apelidos.")
            raise

def load_alias_history() -> List[Dict[str, Any]]:
    with ALIAS_HISTORY_LOCK:
        if not ALIAS_HISTORY_FILE.exists():
            return []
        try:
            data = json.loads(ALIAS_HISTORY_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                raise ValueError("O conteúdo do histórico não é uma lista.")
            return data
        except Exception:
            raise HTTPException(
                status_code=500,
                detail="Não foi possível ler o histórico de apelidos."
            )

def save_alias_history(history: List[Dict[str, Any]]) -> None:
    try:
        atomic_write_json(ALIAS_HISTORY_FILE, history)
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Não foi possível salvar o histórico de alterações."
        )

def append_alias_history_entry(entry: Dict[str, Any]) -> None:
    with ALIAS_HISTORY_LOCK:
        def append(history):
            if not isinstance(history, list):
                raise RuntimeError("O conteúdo do histórico de alterações não é uma lista.")
            return [*history, entry]
        _atomic_json_update(ALIAS_HISTORY_FILE, append, [])

def delete_alias_history_entry(event_id: str) -> bool:
    with ALIAS_HISTORY_LOCK:
        removed = {"value": False}
        def remove(history):
            if not isinstance(history, list):
                raise RuntimeError("O conteúdo do histórico de alterações não é uma lista.")
            filtered = [entry for entry in history if entry.get("id") != event_id]
            removed["value"] = len(filtered) != len(history)
            return filtered
        _atomic_json_update(ALIAS_HISTORY_FILE, remove, [])
        return removed["value"]

def load_comparison_history() -> List[Dict[str, Any]]:
    with COMPARISON_HISTORY_LOCK:
        if not COMPARISON_HISTORY_FILE.exists():
            return []
        try:
            data = json.loads(COMPARISON_HISTORY_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                raise ValueError("O conteúdo do histórico não é uma lista.")
            return data
        except Exception:
            raise HTTPException(
                status_code=500,
                detail="Não foi possível ler o histórico de comparações."
            )


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


def save_comparison_history(history: List[Dict[str, Any]]) -> None:
    try:
        atomic_write_json(COMPARISON_HISTORY_FILE, history)
    except Exception:
        raise RuntimeError("Não foi possível salvar o histórico de comparações.")

def append_comparison_history_entry(entry: Dict[str, Any]) -> None:
    with COMPARISON_HISTORY_LOCK:
        def append(history):
            if not isinstance(history, list):
                raise RuntimeError("O conteúdo do histórico de planilhas não é uma lista.")
            return [*history, entry]
        _atomic_json_update(COMPARISON_HISTORY_FILE, append, [])

def delete_comparison_history_entry(event_id: str) -> Optional[int]:
    with COMPARISON_HISTORY_LOCK:
        result = {"total": None}
        def remove(history):
            if not isinstance(history, list):
                raise RuntimeError("O conteúdo do histórico de planilhas não é uma lista.")
            filtered = [entry for entry in history if entry.get("id") != event_id]
            if len(filtered) != len(history):
                result["total"] = len(filtered)
            return filtered
        _atomic_json_update(COMPARISON_HISTORY_FILE, remove, [])
        return result["total"]

def record_alias_change(
    serial: str,
    previous_alias: str,
    new_alias: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
) -> Dict[str, Any]:
    entry = build_alias_change_entry(serial, previous_alias, new_alias, action, reference_id)
    append_alias_history_entry(entry)
    return entry


def build_alias_change_entry(
    serial: str,
    previous_alias: str,
    new_alias: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
) -> Dict[str, Any]:
    equipment = equipamentos_cache.get(serial, {})
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

def record_address_change(
    serial: str,
    previous_address: Dict[str, str],
    new_address: Dict[str, str],
) -> Dict[str, Any]:
    entry = build_address_change_entry(serial, previous_address, new_address)
    append_alias_history_entry(entry)
    return entry


def build_address_change_entry(
    serial: str,
    previous_address: Dict[str, str],
    new_address: Dict[str, str],
) -> Dict[str, Any]:
    equipment = equipamentos_cache.get(serial, {})
    return {
        "id": uuid.uuid4().hex,
        "tipo": "endereco",
        "serial": serial,
        "equipamento": equipment.get("modelo") or equipment.get("tipo") or "Equipamento",
        "endereco_anterior": previous_address,
        "endereco_novo": new_address,
        "horario": datetime.now().astimezone().isoformat(timespec="seconds"),
        "acao": "alteracao",
        "referencia_id": None,
    }

def find_details_sheet(file_path: Path) -> Optional[str]:
    """Retorna uma aba EquipamentosDetalhes com os campos usados pelo site."""
    workbook = None
    try:
        workbook = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        matching_sheets = []
        for worksheet in workbook.worksheets:
            headers = next(worksheet.iter_rows(min_row=1, max_row=1, values_only=True), ())
            normalized_headers = {
                re.sub(r"[\s_\-]+", "", str(value)).lower()
                for value in headers
                if value is not None
            }

            has_serial = bool({"numeroserie", "serial"} & normalized_headers)
            has_alias = bool({"apelido", "hostname"} & normalized_headers)
            if has_serial and has_alias and "modelo" in normalized_headers and "cidade" in normalized_headers:
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
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > MAX_XLSX_ARCHIVE_ENTRIES:
                raise HTTPException(
                    status_code=400,
                    detail="O arquivo enviado não é uma planilha .xlsx válida.",
                )

            uncompressed_size = sum(entry.file_size for entry in entries)
            if uncompressed_size > MAX_XLSX_UNCOMPRESSED_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="O conteúdo descompactado da planilha excede o limite permitido.",
                )

            required_parts = {"[Content_Types].xml", "xl/workbook.xml"}
            if not required_parts.issubset({entry.filename for entry in entries}):
                raise HTTPException(
                    status_code=400,
                    detail="O arquivo enviado não é uma planilha .xlsx válida.",
                )
    except HTTPException:
        raise
    except (OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile):
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
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > MAX_XLSX_ARCHIVE_ENTRIES:
                return {"available": False, "file": path.name, "reason": "pacote XLSX inválido"}
            if sum(entry.file_size for entry in entries) > MAX_XLSX_UNCOMPRESSED_BYTES:
                return {"available": False, "file": path.name, "reason": "pacote excede o limite de tamanho"}
            required_parts = {"[Content_Types].xml", "xl/workbook.xml"}
            if not required_parts.issubset({entry.filename for entry in entries}):
                return {"available": False, "file": path.name, "reason": "pacote XLSX inválido"}
    except (OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile):
        return {"available": False, "file": path.name, "reason": "arquivo inacessível ou XLSX inválido"}

    return {"available": True, "file": path.name, "reason": "OK"}


def get_startup_readiness() -> Dict[str, Any]:
    """Map essential local files to the application functions that need them."""
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

    if active_details is not None:
        details_status = _check_startup_xlsx(active_details)
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

    files = {
        "template_transferencia": _check_startup_xlsx(TEMPLATE_FILE),
        "inventario_equipamentos": details_status,
        "inventario_detalhes_atualizacao": _check_startup_xlsx(DETAILS_UPLOAD_FILE),
        "inventario_endpoint": _check_startup_xlsx(ENDPOINT_UPLOAD_FILE),
        "modelo_exportacao": _check_startup_xlsx(EXPORT_MODEL_FILE),
    }
    requirements = {
        "consulta_equipamentos": ["inventario_equipamentos"],
        "geracao_transferencia": ["template_transferencia"],
        "comparacao_atualizacao_inventarios": [
            "inventario_detalhes_atualizacao",
            "inventario_endpoint",
        ],
        "exportacao_equipamentos": ["inventario_equipamentos", "modelo_exportacao"],
    }
    functions = {
        name: {
            "available": all(files[key]["available"] for key in required_files),
            "missing_files": [
                files[key]["file"] or key
                for key in required_files
                if not files[key]["available"]
            ],
        }
        for name, required_files in requirements.items()
    }
    return {"files": files, "functions": functions}


def report_startup_readiness() -> None:
    """Log a clear feature impact summary without exposing workbook contents."""
    report = get_startup_readiness()
    labels = {
        "template_transferencia": "Modelo de transferência",
        "inventario_equipamentos": "Inventário ativo EquipamentosDetalhes",
        "inventario_detalhes_atualizacao": "EquipamentosDetalhes para atualização",
        "inventario_endpoint": "Inventário InvAllComputersSummary",
        "modelo_exportacao": "Modelo de exportação",
    }
    print("[PRONTIDÃO] Verificação dos arquivos locais:")
    for key, status in report["files"].items():
        state = "PACOTE XLSX válido" if status["available"] else f"INDISPONÍVEL ({status['reason']})"
        filename = status["file"] or "arquivo não localizado"
        print(f"[PRONTIDÃO] {labels[key]} — {filename}: {state}")

    function_labels = {
        "consulta_equipamentos": "Consulta de equipamentos",
        "geracao_transferencia": "Geração de planilha de transferência",
        "comparacao_atualizacao_inventarios": "Comparação e atualização de inventários",
        "exportacao_equipamentos": "Exportação de equipamentos",
    }
    for key, status in report["functions"].items():
        if status["available"]:
            print(f"[PRONTIDÃO] {function_labels[key]}: arquivos necessários presentes (checagem estrutural).")
        else:
            missing = ", ".join(status["missing_files"])
            print(f"[PRONTIDÃO] {function_labels[key]}: INDISPONÍVEL; dependência ausente ou inválida: {missing}.")


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
            headers = [normalize_reference_value(value) for value in raw_headers]
            if not any(headers):
                continue

            records = []
            for values in iterator:
                if not any(value is not None and str(value).strip() for value in values):
                    continue
                record = {
                    headers[index]: values[index]
                    for index in range(min(len(headers), len(values)))
                    if headers[index]
                }
                records.append(record)
            tables.append({"sheet": worksheet.title, "headers": set(headers), "records": records})
        return tables
    except HTTPException:
        raise
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
    serial_headers = {"NUMEROSERIE", "NUMERODESERIE", "SERIAL"}
    alias_headers = {"APELIDO", "HOSTNAME", "NOMEDOCOMPUTADOR", "COMPUTERNAME"}
    city_headers = {"CIDADE"}

    if role == "detalhes":
        required = {"MODELO"} | city_headers
        candidates = [
            table for table in tables
            if required.issubset(table["headers"])
            and table["headers"] & serial_headers
            and table["headers"] & alias_headers
        ]
        description = "número de série, modelo, apelido/hostname e cidade"
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
            "detalhes": "EquipamentosDetalhes",
        }[role]
        raise HTTPException(
            status_code=400,
            detail=f"A planilha enviada como {display_role} não contém uma aba com os cabeçalhos obrigatórios: {description}.",
        )

    if len(candidates) > 1:
        sheet_names = ", ".join(f"'{table['sheet']}'" for table in candidates)
        display_role = {
            "endpoint": "Endpoint",
            "detalhes": "EquipamentosDetalhes",
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
        workbook = openpyxl.load_workbook(EXPORT_MODEL_FILE, read_only=True, data_only=True)
        for worksheet in workbook.worksheets:
            header_row = [cell.value for cell in next(worksheet.iter_rows(max_row=1), ())]
            col_map = {
                re.sub(r"[\s_\-]+", "", str(value)).lower(): index
                for index, value in enumerate(header_row)
                if value is not None
            }
            serial_col = col_map.get("numeroserie", col_map.get("serial"))
            alias_col = col_map.get("apelido")
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
            "motivo": "Série duplicada na InvAll; nenhum hostname foi escolhido.",
        })
    for row in index.get("blank_serials", []):
        items.append({
            "serie": "",
            "computador": row.get("hostname", ""),
            "motivo": "Número de série vazio na InvAll; hostname mantido sem associação.",
        })
    for serial_key, row in sorted(index.get("blank_hostnames", {}).items()):
        items.append({
            "serie": row.get("serie") or serial_key,
            "computador": "",
            "motivo": "Hostname vazio na InvAll; apelido atual preservado.",
        })
    if details_serials is not None:
        details_duplicates = details_duplicate_serials or set()
        for serial_key in sorted(details_duplicates):
            items.append({
                "serie": serial_key,
                "computador": index.get("unique", {}).get(serial_key, ""),
                "motivo": "Série duplicada em EquipamentosDetalhes; nenhum registro foi escolhido.",
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
                    "InvAll indisponível; apelido atual preservado para conferência."
                    if not index.get("available")
                    else "Série não encontrada na InvAll; apelido atual preservado."
                ),
            })
        for serial_key, hostname in sorted(index.get("unique", {}).items()):
            if serial_key not in details_serials:
                items.append({
                    "serie": serial_key,
                    "computador": hostname,
                    "motivo": "Série não encontrada em EquipamentosDetalhes; nenhum dado foi alterado.",
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
        equipment["invall_alias_detail"] = "A InvAll ativa não pôde ser lida; o apelido atual foi mantido."
    elif details_duplicate:
        equipment["invall_alias_status"] = "serie_detalhes_duplicada"
        equipment["invall_alias_detail"] = "A série aparece mais de uma vez em EquipamentosDetalhes; confira antes de aplicar um hostname."
    elif serial_key in endpoint_index.get("duplicates", {}):
        equipment["invall_alias_status"] = "serie_invall_duplicada"
        equipment["invall_alias_detail"] = "A série aparece mais de uma vez na InvAll; o apelido atual foi mantido."
    elif serial_key in endpoint_index.get("unique", {}):
        if not manual_override:
            equipment["apelido"] = endpoint_index["unique"][serial_key]
        equipment["invall_alias_status"] = "aplicado"
        equipment["invall_alias_detail"] = (
            "Série associada à InvAll; o apelido manual prevalece."
            if manual_override
            else "Hostname da InvAll associado pela série normalizada."
        )
    elif serial_key in endpoint_index.get("blank_hostnames", {}):
        equipment["invall_alias_status"] = "hostname_vazio"
        equipment["invall_alias_detail"] = "A InvAll tem a série, mas o hostname está vazio; o apelido atual foi mantido."
    else:
        equipment["invall_alias_status"] = "serie_nao_encontrada"
        equipment["invall_alias_detail"] = "Série não encontrada na InvAll; o apelido atual foi mantido."


def get_export_aliases(endpoint_index: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Combina hostnames da InvAll com apelidos manuais, que têm prioridade."""
    aliases = dict(
        endpoint_index.get("unique", {})
        if endpoint_index is not None
        else load_endpoint_aliases()
    )
    aliases.update(_manual_aliases_by_serial(load_modified_apelidos()))
    return aliases


def count_export_alias_changes(
    locked: bool = False,
    endpoint_index: Optional[Dict[str, Any]] = None,
) -> int:
    """Conta quantos apelidos do modelo de exportação serão realmente alterados."""
    def count() -> int:
        aliases = get_export_aliases(endpoint_index)
        try:
            model_aliases = load_export_model_aliases()
        except HTTPException:
            return len(aliases)
        return sum(
            1
            for serial, alias in aliases.items()
            if serial in model_aliases and model_aliases[serial] != alias
        )

    if locked:
        return count()
    with lock_paths([ENDPOINT_UPLOAD_FILE, MODIFIED_APELIDOS_FILE, EXPORT_MODEL_FILE]):
        return count()


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

def prepare_export_baseline() -> Optional[Path]:
    """Mantém uma cópia imutável de EquipamentosDetalhes para exportar apelidos."""
    source_file = get_equipamentos_template_file()
    if source_file is None or not source_file.exists():
        return None

    baseline_file = source_file.with_name(f".{source_file.stem}.export-baseline.xlsx")
    if baseline_file.exists():
        return baseline_file

    try:
        atomic_copy_file(source_file, baseline_file)
        return baseline_file
    except Exception:
        print("[AVISO] Não foi possível preservar a base local para exportação.")
        return None

def get_parque_file() -> Optional[Path]:
    """Retorna a fonte EquipamentosDetalhes carregada pelo site."""
    return get_equipamentos_template_file()

@asynccontextmanager
async def lifespan(app: FastAPI):
    report_startup_readiness()
    yield


app = FastAPI(
    title="Simpress Transferência de Equipamentos - SEBRAE/PR",
    description="Sistema inteligente para emissão automatizada de planilhas oficiais de transferência de equipamentos.",
    version="1.3.0",
    lifespan=lifespan,
)


class LocalRequestSafetyMiddleware:
    """Limits upload request size and prevents raw internal exceptions reaching clients or logs."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        origin = headers.get(b"origin")
        allowed_local_origins = {
            b"http://127.0.0.1:8000",
            b"http://localhost:8000",
        }
        if (
            path.startswith("/api/")
            and origin is not None
            and origin.lower() not in allowed_local_origins
        ):
            response = JSONResponse(
                status_code=403,
                content={"detail": "Origem não autorizada para a aplicação local."},
            )
            await response(scope, receive, send)
            return

        if path == "/api/planilhas/atualizar":
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
                if request_size > MAX_UPLOAD_REQUEST_BYTES:
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": "O envio excede o limite total permitido para os arquivos."},
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
            if path == "/api/planilhas/atualizar" and message["type"] == "http.request":
                request_size += len(message.get("body", b""))
                if request_size > MAX_UPLOAD_REQUEST_BYTES:
                    raise UploadBodyTooLarge()
            return message

        try:
            await self.app(scope, limited_receive, safe_send)
        except UploadBodyTooLarge:
            if response_started:
                return
            response = JSONResponse(
                status_code=413,
                content={"detail": "O envio excede o limite total permitido para os arquivos."},
            )
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


class UploadBodyTooLarge(Exception):
    pass


app.add_middleware(LocalRequestSafetyMiddleware)

# In-memory storage
equipamentos_cache: Dict[str, Dict[str, Any]] = {}
unidades_cache: List[Dict[str, Any]] = []
stats_cache: Dict[str, Any] = {}

def format_cep(val: Any) -> str:
    if pd.isna(val) or val is None:
        return ""
    val_clean = re.sub(r"\D", "", str(val).split(".")[0]).zfill(8)
    if len(val_clean) == 8:
        return f"{val_clean[:5]}-{val_clean[5:]}"
    return str(val).strip()

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
    if pd.isna(val) or val is None:
        return default
    return str(val).strip()

def load_custom_units() -> List[Dict[str, Any]]:
    if CUSTOM_UNIDADES_FILE.exists():
        try:
            with open(CUSTOM_UNIDADES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            print("[ERRO] Falha ao carregar o catálogo local de unidades.")
    return []

def save_custom_units(units: List[Dict[str, Any]]) -> None:
    try:
        atomic_write_json(CUSTOM_UNIDADES_FILE, units)
    except Exception:
        print("[ERRO] Falha ao gravar o catálogo local de unidades.")
        raise

def load_database(transaction_locked: bool = False) -> bool:
    if transaction_locked:
        return _load_database_unlocked()
    with lock_paths([TRANSACTION_ROOT / ".atomic-transactions"]):
        detail_files = get_details_files()
        with lock_paths([
            *detail_files,
            ENDPOINT_UPLOAD_FILE,
            MODIFIED_APELIDOS_FILE,
            CUSTOM_UNIDADES_FILE,
            EXPORT_MODEL_FILE,
        ]):
            return _load_database_unlocked()


def _load_database_unlocked() -> bool:
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
        df = pd.read_excel(active_details_file, sheet_name=sheet_target)
    except Exception:
        print("[ERRO] Falha ao ler a planilha local de equipamentos.")
        return False

    # Strip column names e criar mapa normalizado de colunas
    df.columns = [str(col).strip() for col in df.columns]
    norm_cols = {re.sub(r'[\s_\-]+', '', str(c)).lower(): c for c in df.columns}
    new_equipamentos_cache: Dict[str, Dict[str, Any]] = {}
    details_serial_counts: Dict[str, int] = {}

    def get_row_val(row, *aliases, default=""):
        for a in aliases:
            key = re.sub(r'[\s_\-]+', '', a).lower()
            if key in norm_cols:
                val = row.get(norm_cols[key])
                if pd.notna(val) and val is not None:
                    return sanitize_value(val, default)
        return default

    unidades_dict: Dict[str, Dict[str, Any]] = {}
    sede_cnpjs = set()

    for _, row in df.iterrows():
        raw_serial = get_row_val(row, "NumeroSerie", "Numero Serie", "Serial")
        if not raw_serial:
            continue
        
        serial_key = raw_serial.upper()
        normalized_serial = normalize_reference_value(raw_serial)
        details_serial_counts[normalized_serial] = details_serial_counts.get(normalized_serial, 0) + 1
        modelo = get_row_val(row, "Modelo")
        tipo = get_row_val(row, "Tipo", "ClasseEquipamento")
        apelido = get_row_val(row, "Apelido", "Hostname")
        id_cliente = get_row_val(row, "IdCliente", "Id Cliente")
        endereco = get_row_val(row, "Endereco", "Endereço")
        cidade = get_row_val(row, "Cidade")
        uf = get_row_val(row, "UF", default="PR")
        raw_cep = get_row_val(row, "CEP")
        cep_formatado = format_cep(raw_cep)
        
        cnpj_instalacao = get_row_val(
            row,
            "CNPJ Instalacao",
            "CNPJ de Instalacao",
            "CNPJ de Instalação",
            "CnpjInstalacao",
            "CnpjDeInstalacao",
        )

        contrato = get_row_val(row, "CodigoContrato", "Codigo Contrato", default="16467")
        razao_social = get_row_val(row, "RazaoSocial", "Razao Social", default="SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR")

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
    filtered_units = []
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
            "label": f"{u['cidade']} - {u['endereco']}" + (f" ({u['cnpj']})" if u["cnpj"] else "")
        })

    # Mesclar unidades customizadas/editadas pelo usuário
    custom_units = load_custom_units()
    for cu in custom_units:
        match = next((x for x in final_units if x.get("cidade", "").lower() == cu.get("cidade", "").lower() and x.get("cnpj") == cu.get("cnpj")), None)
        if match:
            match.update(cu)
        else:
            final_units.append(cu)

    # Sort units: Sede first, then Cidade, Endereço
    new_unidades_cache = sorted(final_units, key=lambda u: (not u.get("is_sede", False), u.get("cidade", ""), u.get("endereco", "")))
    for idx, u in enumerate(new_unidades_cache, start=1):
        u["id"] = idx

    # Apelidos manuais persistem por série e prevalecem sobre o hostname da InvAll.
    mod_apelidos = load_modified_apelidos()
    manual_aliases = _manual_aliases_by_serial(mod_apelidos)
    endpoint_index = read_endpoint_alias_index()
    for serial_key, equipment in new_equipamentos_cache.items():
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
    type_counts = df[tipo_col_real].value_counts().to_dict() if tipo_col_real in df.columns else {}
    new_stats_cache = {
        "total_equipamentos": len(new_equipamentos_cache),
        "total_unidades": len(new_unidades_cache),
        "total_apelidos_modificados": count_export_alias_changes(
            locked=True,
            endpoint_index=endpoint_index,
        ),
        "tipos": type_counts,
        "arquivo_origem": active_details_file.name,
        "ultima_atualizacao": datetime.now().strftime("%d/%m/%Y %H:%M")
    }

    # Só publica os novos caches depois de ler, converter e validar toda a planilha.
    with STATE_LOCK:
        equipamentos_cache = new_equipamentos_cache
        unidades_cache = new_unidades_cache
        stats_cache = new_stats_cache

    print(f"[SUCESSO] Base carregada: {len(equipamentos_cache)} equipamentos ({len(mod_apelidos)} com apelido modificado) e {len(unidades_cache)} unidades catalogadas.")
    return True

# Recover incomplete local transactions before reading or creating operational files.
recover_pending_transactions(TRANSACTION_ROOT)

# Load database on startup
prepare_export_baseline()
load_database()


# Models for API
class EquipamentoUpdatePayload(BaseModel):
    serial: str = Field(..., description="Número de Série do Equipamento")
    modelo: Optional[str] = Field("", description="Modelo do Equipamento")
    tipo: Optional[str] = Field("", description="Tipo (Notebook, Micro Computador, Headsets...)")
    apelido: Optional[str] = Field("", description="Apelido / Hostname")
    idCliente: Optional[str] = Field("", description="ID do Cliente")
    # Mantidos para compatibilidade com clientes antigos; a rota ignora esses campos.
    endereco: Optional[str] = Field("", description="Endereço carregado de EquipamentosDetalhes")
    cidade: Optional[str] = Field("", description="Cidade carregada de EquipamentosDetalhes")
    uf: Optional[str] = Field("PR", description="UF carregada de EquipamentosDetalhes")
    cep: Optional[str] = Field("", description="CEP carregado de EquipamentosDetalhes")
    cnpj_instalacao: Optional[str] = Field("", description="CNPJ carregado de EquipamentosDetalhes")


class UnidadePayload(BaseModel):
    id: Optional[int] = None
    cidade: str
    endereco: str
    uf: Optional[str] = "PR"
    cep: str
    cnpj: str


class ApelidoUpdatePayload(BaseModel):
    serial: str = Field(..., description="Número de Série do Equipamento")
    apelido: str = Field(..., description="Novo Apelido / Hostname do Equipamento")


class ApelidoUndoPayload(BaseModel):
    evento_id: str = Field(..., description="ID do evento de apelido que deve ser desfeito")


class ManualAliasConflictResolutionPayload(BaseModel):
    acao: str = Field(..., description="Manter o apelido manual ou remover esse override")


class ComparisonRestorePayload(BaseModel):
    preview_token: str = Field(..., min_length=64, max_length=64)


def _edit_equipment_workbook(wb, payload: EquipamentoUpdatePayload):
    target_sheet_name = next(
        (name for name in wb.sheetnames if "equipamento" in name.lower() or "parque" in name.lower()),
        wb.sheetnames[0] if wb.sheetnames else None,
    )
    if target_sheet_name is None:
        return None
    ws = wb[target_sheet_name]
    header_row = [cell.value for cell in next(ws.iter_rows(max_row=1), ())]
    col_map = {
        re.sub(r"[\s_\-]+", "", str(value)).lower(): index + 1
        for index, value in enumerate(header_row)
        if value is not None
    }
    serial_col = col_map.get("numeroserie") or col_map.get("serial")
    if not serial_col:
        return None

    target_serial = normalize_reference_value(payload.serial)
    matching_rows = [
        row for row in range(2, ws.max_row + 1)
        if normalize_reference_value(ws.cell(row=row, column=serial_col).value) == target_serial
        and target_serial
    ]
    target_row = matching_rows[0] if matching_rows else ws.max_row + 1
    expected: Dict[tuple, Any] = {}

    def set_value(column: Optional[int], value: Any) -> None:
        if column is None or value is None:
            return
        cell = ws.cell(row=target_row, column=column)
        cell.value = value
        expected[(ws.title, cell.coordinate)] = value

    if not matching_rows:
        set_value(serial_col, payload.serial.strip().upper())
        set_value(col_map.get("codigocontrato"), 16467)
        set_value(col_map.get("itemdecontrato"), target_row - 1)
        set_value(col_map.get("razaosocial"), "SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR")

    set_value(col_map.get("apelido"), payload.apelido.strip() if payload.apelido is not None else None)
    set_value(col_map.get("modelo"), payload.modelo.strip() if payload.modelo is not None else None)
    set_value(col_map.get("tipo") or col_map.get("classeequipamento"), payload.tipo.strip() if payload.tipo is not None else None)
    set_value(col_map.get("idcliente"), payload.idCliente.strip() if payload.idCliente is not None else None)
    return expected


def update_equipment_in_workbook_file(
    file_path: Path,
    payload: EquipamentoUpdatePayload,
    transaction: Optional[AtomicFileTransaction] = None,
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
                lambda wb: _edit_equipment_workbook(wb, payload),
                allow_dimension_growth=True,
            )
        with AtomicFileTransaction(TRANSACTION_ROOT, [file_path]) as own_transaction:
            saved = stage_workbook_update(
                own_transaction,
                file_path,
                lambda wb: _edit_equipment_workbook(wb, payload),
                allow_dimension_growth=True,
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
):
    """Salva as alterações do equipamento diretamente em EquipamentosDetalhes."""
    target_serial_upper = payload.serial.strip().upper()

    # Coletar as versões EquipamentosDetalhes existentes
    target_files: List[Path] = []
    
    equip_model = get_equipamentos_template_file()
    if equip_model is not None and equip_model.exists():
        target_files.append(equip_model)

    for f in get_details_files():
        if f not in target_files and f.exists():
            target_files.append(f)

    if not target_files:
        raise HTTPException(status_code=404, detail="Nenhuma planilha EquipamentosDetalhes encontrada no servidor.")

    json_mutations = json_mutations or {}
    try:
        transaction_targets = [*target_files, *json_mutations.keys()]
        with AtomicFileTransaction(TRANSACTION_ROOT, transaction_targets) as transaction:
            salvo_em_algum = False
            for tf in target_files:
                if update_equipment_in_workbook_file(tf, payload, transaction):
                    salvo_em_algum = True
            if not salvo_em_algum:
                raise HTTPException(status_code=500, detail="Não foi possível atualizar o equipamento na planilha.")
            for path, updater in json_mutations.items():
                transaction.update_json(path, updater, [] if path == ALIAS_HISTORY_FILE else {})
            transaction.commit()
    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível concluir a gravação: {error}") from error

    # Atualiza o cache em memória imediatamente
    existing = equipamentos_cache.get(target_serial_upper, {})
    endereco_info = (
        snapshot_endereco_instalacao(existing)
        if existing
        else normalizar_endereco_instalacao(EquipamentoUpdatePayload(serial=target_serial_upper))
    )
    endereco = endereco_info["endereco"]
    cidade = endereco_info["cidade"]
    uf = endereco_info["uf"]
    cep_formatado = endereco_info["cep"]
    cnpj_instalacao = endereco_info["cnpj"]
    retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep_formatado}" if endereco else f"{cidade}/{uf}"

    desc_sugerida = get_suggested_description(payload.tipo, payload.modelo)

    modified_aliases = load_modified_apelidos()
    manual_aliases = _manual_aliases_by_serial(modified_aliases)
    normalized_serial = normalize_reference_value(target_serial_upper)
    local_alias = manual_aliases.get(normalized_serial, payload.apelido or "")
    updated_equipment = {
        "serial": target_serial_upper,
        "modelo": payload.modelo.strip() if payload.modelo else "",
        "tipo": payload.tipo.strip() if payload.tipo else "",
        "apelido": local_alias,
        "_apelido_base": payload.apelido.strip() if payload.apelido else "",
        "_apelido_local": local_alias,
        "_apelido_manual_override": normalized_serial in manual_aliases,
        "idCliente": payload.idCliente.strip() if payload.idCliente else "",
        "descricao_sugerida": desc_sugerida,
        "endereco_instalacao": endereco,
        "retirada_cnpj": cnpj_instalacao,
        "retirada_endereco": retirada_endereco,
        "retirada_cidade": cidade,
        "retirada_uf": uf,
        "retirada_cep": cep_formatado,
        "contrato": "16467",
        "razao_social": "SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR"
    }

    _apply_effective_alias(
        updated_equipment,
        None,
        details_duplicate=existing.get("invall_alias_status") == "serie_detalhes_duplicada",
    )
    with STATE_LOCK:
        equipamentos_cache[target_serial_upper] = updated_equipment

    stats_cache["total_equipamentos"] = len(equipamentos_cache)
    stats_cache["ultima_atualizacao"] = datetime.now().strftime("%d/%m/%Y %H:%M")


# Endpoints
@app.get("/api/equipamento/{serial}")
def get_equipamento(serial: str):
    """Busca um equipamento pelo número de série (sem distinção de maiúsculas/minúsculas)."""
    clean_serial = serial.strip().upper()
    if clean_serial in equipamentos_cache:
        return {key: value for key, value in equipamentos_cache[clean_serial].items() if not key.startswith("_")}
    
    # Busca parcial se termo tiver 4 ou mais caracteres
    if len(clean_serial) >= 4:
        for k, v in equipamentos_cache.items():
            if clean_serial in k:
                return {key: value for key, value in v.items() if not key.startswith("_")}

    raise HTTPException(status_code=404, detail=f"Equipamento com serial '{serial}' não encontrado na base de dados.")


@app.post("/api/equipamento/salvar")
def salvar_equipamento(payload: EquipamentoUpdatePayload):
    """Atualiza ou cadastra um equipamento tanto na memória do site quanto diretamente na planilha Excel."""
    if not payload.serial or not payload.serial.strip():
        raise HTTPException(status_code=400, detail="Número de série é obrigatório.")
    
    target_serial = payload.serial.strip().upper()
    equipamento_existente = equipamentos_cache.get(target_serial)
    if equipamento_existente is not None:
        # Para equipamentos já cadastrados, o apelido só pode ser alterado pela rota dedicada.
        # Isso impede que o formulário de dados/endereço sobrescreva apelidos acidentalmente.
        # Keep the stored EquipamentosDetalhes alias, not its InvAll presentation value.
        payload.apelido = equipamento_existente.get("_apelido_local", equipamento_existente.get("_apelido_base", ""))

    json_mutations = {}
    if equipamento_existente is None and payload.apelido is not None and payload.apelido.strip():
        new_alias = payload.apelido.strip()
        def save_new_alias(data):
            aliases = data if isinstance(data, dict) else {}
            for key in list(aliases):
                if normalize_reference_value(key) == normalize_reference_value(target_serial):
                    aliases.pop(key, None)
            aliases[target_serial] = new_alias
            return aliases
        json_mutations[MODIFIED_APELIDOS_FILE] = save_new_alias

    save_equipment_to_excel(payload, json_mutations=json_mutations)
    total_mod = len(load_modified_apelidos())
    return {
        "sucesso": True,
        "mensagem": f"Equipamento {target_serial} atualizado com sucesso no site e na planilha Excel!",
        "equipamento": {key: value for key, value in equipamentos_cache[target_serial].items() if not key.startswith("_")},
        "total_modificados": total_mod
    }


def _edit_alias_workbook(
    wb,
    target_serial: str,
    novo_apelido: str,
    expected_current_alias: Optional[str] = None,
):
    sheet_name = next(
        (name for name in wb.sheetnames if "equipamento" in name.lower() or "parque" in name.lower()),
        wb.sheetnames[0] if wb.sheetnames else None,
    )
    if sheet_name is None:
        return None
    ws = wb[sheet_name]
    header_row = [cell.value for cell in next(ws.iter_rows(max_row=1), ())]
    col_map = {
        re.sub(r"[\s_\-]+", "", str(value)).lower(): index + 1
        for index, value in enumerate(header_row)
        if value is not None
    }
    serial_col = col_map.get("numeroserie") or col_map.get("serial") or 4
    alias_col = col_map.get("apelido") or 5
    serial_key = normalize_reference_value(target_serial)
    matching_rows = [
        row for row in range(2, ws.max_row + 1)
        if normalize_reference_value(ws.cell(row=row, column=serial_col).value) == serial_key and serial_key
    ]
    if len(matching_rows) > 1:
        raise HTTPException(
            status_code=409,
            detail=f"A série {target_serial} aparece mais de uma vez em EquipamentosDetalhes; nenhum apelido foi escolhido.",
        )
    if not matching_rows:
        return None
    cell = ws.cell(row=matching_rows[0], column=alias_col)
    if expected_current_alias is not None:
        current_alias = "" if cell.value is None else str(cell.value).strip()
        if current_alias != str(expected_current_alias or "").strip():
            raise HTTPException(
                status_code=409,
                detail="O apelido salvo na planilha mudou depois deste registro; nenhuma alteração foi aplicada.",
            )
    cell.value = novo_apelido
    return {(ws.title, cell.coordinate): novo_apelido}


def atualizar_apelido_na_planilha(
    target_serial: str,
    novo_apelido: str,
    obrigatorio: bool = False,
    transaction: Optional[AtomicFileTransaction] = None,
    expected_current_alias: Optional[str] = None,
) -> bool:
    """Prepare a manual alias cell change and validate its temporary workbook."""
    target_file = get_equipamentos_template_file()
    if target_file is None or not target_file.exists():
        if obrigatorio:
            raise HTTPException(status_code=404, detail="A planilha de equipamentos não foi encontrada para salvar a restauração.")
        return False

    try:
        if transaction is None:
            with AtomicFileTransaction(TRANSACTION_ROOT, [target_file]) as own_transaction:
                saved = stage_workbook_update(
                    own_transaction,
                    target_file,
                    lambda wb: _edit_alias_workbook(
                        wb, target_serial, novo_apelido, expected_current_alias
                    ),
                )
                if not saved:
                    if obrigatorio:
                        raise HTTPException(status_code=404, detail=f"A série {target_serial} não foi encontrada na planilha para restaurar o apelido.")
                    return False
                own_transaction.commit()
                return True

        saved = stage_workbook_update(
            transaction,
            target_file,
            lambda wb: _edit_alias_workbook(
                wb, target_serial, novo_apelido, expected_current_alias
            ),
        )
        if not saved and obrigatorio:
            raise HTTPException(status_code=404, detail=f"A série {target_serial} não foi encontrada na planilha para restaurar o apelido.")
        return saved
    except HTTPException:
        raise
    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível salvar o apelido em '{target_file.name}': {error}") from error


def aplicar_alteracao_apelido(
    target_serial: str,
    novo_apelido: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
    registrar_historico: bool = True,
    exigir_salvamento_planilha: bool = False,
    expected_current_local: Optional[str] = None,
    expected_latest_event_id: Optional[str] = None,
    remove_history_event_id: Optional[str] = None,
) -> Dict[str, Any]:
    equipamento = equipamentos_cache.get(target_serial)
    if equipamento is None:
        raise HTTPException(status_code=404, detail=f"Equipamento com serial '{target_serial}' não encontrado na base de dados.")

    apelido_anterior = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
    target_file = get_equipamentos_template_file()
    workbook_exists = bool(target_file and target_file.exists())
    if exigir_salvamento_planilha and not workbook_exists:
        raise HTTPException(status_code=404, detail="A planilha de equipamentos não foi encontrada para salvar a restauração.")

    history_will_change = (apelido_anterior != novo_apelido and registrar_historico) or bool(remove_history_event_id)
    targets = [MODIFIED_APELIDOS_FILE]
    if history_will_change:
        targets.append(ALIAS_HISTORY_FILE)
    if workbook_exists:
        targets.append(target_file)

    try:
        with AtomicFileTransaction(TRANSACTION_ROOT, targets) as transaction:
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

            if workbook_exists:
                excel_salvo = atualizar_apelido_na_planilha(
                    target_serial,
                    novo_apelido,
                    obrigatorio=exigir_salvamento_planilha,
                    transaction=transaction,
                    expected_current_alias=expected_current_local,
                )
            else:
                excel_salvo = False

            def update_overrides(data):
                aliases = data if isinstance(data, dict) else {}
                for key in list(aliases):
                    if normalize_reference_value(key) == normalize_reference_value(target_serial):
                        aliases.pop(key, None)
                aliases[target_serial] = novo_apelido
                return aliases

            transaction.update_json(MODIFIED_APELIDOS_FILE, update_overrides, {})

            if history_will_change:
                def update_history(history):
                    if not isinstance(history, list):
                        raise RuntimeError("O conteúdo do histórico manual não é uma lista.")
                    updated = list(history)
                    if remove_history_event_id:
                        updated = [item for item in updated if item.get("id") != remove_history_event_id]
                        if len(updated) == len(history):
                            raise HTTPException(status_code=409, detail="O registro foi alterado por outra ação; atualize o histórico e tente novamente.")
                    if apelido_anterior != novo_apelido and registrar_historico:
                        updated.append(build_alias_change_entry(target_serial, apelido_anterior, novo_apelido, action, reference_id))
                    return updated
                transaction.update_json(ALIAS_HISTORY_FILE, update_history, [])

            transaction.commit()
    except HTTPException:
        raise
    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Gravação cancelada: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível concluir a alteração de apelido: {error}") from error

    equipment = equipamentos_cache[target_serial]
    equipment["_apelido_local"] = novo_apelido
    equipment["_apelido_base"] = novo_apelido
    equipment["_apelido_manual_override"] = True
    _apply_effective_alias(
        equipment,
        None,
        details_duplicate=equipment.get("invall_alias_status") == "serie_detalhes_duplicada",
    )
    return {
        "equipamento": equipamento,
        "apelido_anterior": apelido_anterior,
        "apelido_novo": novo_apelido,
        "salvo_no_disco": excel_salvo,
    }


@app.post("/api/equipamento/atualizar-apelido")
def atualizar_apelido(payload: ApelidoUpdatePayload):
    """Atualiza o apelido e registra o valor anterior, o novo e o horário."""
    target_serial = payload.serial.strip().upper()
    novo_apelido = payload.apelido.strip()
    resultado = aplicar_alteracao_apelido(target_serial, novo_apelido)

    return {
        "sucesso": True,
        "mensagem": "Apelido salvo e aplicado nas próximas pesquisas.",
        **{**resultado, "equipamento": {key: value for key, value in resultado["equipamento"].items() if not key.startswith("_")}},
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

    tipo_evento = "endereco" if evento.get("tipo") == "endereco" else "apelido"
    if tipo_evento == "endereco":
        raise HTTPException(
            status_code=409,
            detail="Endereços são atualizados pela planilha EquipamentosDetalhes e não podem mais ser restaurados manualmente.",
        )
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

    if tipo_evento == "apelido":
        apelido_atual = str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or "").strip()
        apelido_novo = str(evento.get("apelido_novo") or "").strip()
        if apelido_atual != apelido_novo:
            raise HTTPException(status_code=409, detail="O apelido salvo não corresponde mais a este registro. Recarregue a base antes de restaurar.")

        apelido_anterior = str(evento.get("apelido_anterior") or "").strip()
        resultado = aplicar_alteracao_apelido(
            target_serial,
            apelido_anterior,
            registrar_historico=False,
            exigir_salvamento_planilha=True,
            expected_current_local=apelido_novo,
            expected_latest_event_id=evento_id,
            remove_history_event_id=evento_id,
        )
        equipamento_restaurado = resultado["equipamento"]
    else:
        endereco_atual = snapshot_endereco_instalacao(equipamento)
        endereco_novo = evento.get("endereco_novo")
        endereco_anterior = evento.get("endereco_anterior")
        if not isinstance(endereco_novo, dict) or not isinstance(endereco_anterior, dict):
            raise HTTPException(status_code=500, detail="O registro de endereço está incompleto e não pode ser restaurado.")
        if endereco_atual != endereco_novo:
            raise HTTPException(status_code=409, detail="O endereço atual não corresponde mais a este registro. Recarregue a base antes de restaurar.")

        payload_restauracao = EquipamentoUpdatePayload(
            serial=target_serial,
            modelo=str(equipamento.get("modelo") or ""),
            tipo=str(equipamento.get("tipo") or ""),
            apelido=str(equipamento.get("_apelido_local", equipamento.get("_apelido_base", "")) or ""),
            idCliente=str(equipamento.get("idCliente") or ""),
            endereco=str(endereco_anterior.get("endereco") or ""),
            cidade=str(endereco_anterior.get("cidade") or ""),
            uf=str(endereco_anterior.get("uf") or "PR"),
            cep=str(endereco_anterior.get("cep") or ""),
            cnpj_instalacao=str(endereco_anterior.get("cnpj") or ""),
        )
        def remove_address_event(history):
            if not isinstance(history, list):
                raise RuntimeError("O conteúdo do histórico manual não é uma lista.")
            latest = next((
                item for item in reversed(history)
                if str(item.get("serial") or "").strip().upper() == target_serial
                and ("endereco" if item.get("tipo") == "endereco" else "apelido") == "endereco"
            ), None)
            if not latest or latest.get("id") != evento_id:
                raise HTTPException(status_code=409, detail="Só é possível excluir e restaurar o evento manual mais recente daquele campo.")
            filtered = [item for item in history if item.get("id") != evento_id]
            if len(filtered) == len(history):
                raise HTTPException(status_code=409, detail="O registro foi alterado por outra ação; atualize o histórico e tente novamente.")
            return filtered
        save_equipment_to_excel(payload_restauracao, {ALIAS_HISTORY_FILE: remove_address_event})
        equipamento_restaurado = equipamentos_cache[target_serial]

    return {
        "sucesso": True,
        "evento_id": evento_id,
        "tipo": tipo_evento,
        "equipamento": {key: value for key, value in equipamento_restaurado.items() if not key.startswith("_")},
        "mensagem": "Valor anterior restaurado e salvo; registro removido do histórico.",
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
        **{**resultado, "equipamento": {key: value for key, value in resultado["equipamento"].items() if not key.startswith("_")}},
        "total_modificados": len(load_modified_apelidos()),
    }


@app.get("/api/equipamento/apelidos-modificados")
def get_apelidos_modificados():
    """Retorna o registro de todos os apelidos que foram modificados pelo usuário."""
    apelidos = load_modified_apelidos()
    return {
        "total": len(apelidos),
        "apelidos": apelidos
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
        raise HTTPException(status_code=404, detail="A base EquipamentosDetalhes atual não foi encontrada.")

    wb = None
    current_wb = None
    try:
        with lock_paths([source_file, current_file, ENDPOINT_UPLOAD_FILE, MODIFIED_APELIDOS_FILE]):
            wb = load_workbook_safely(source_file, allow_threaded_comments=True)
            original = workbook_snapshot(wb)
            sheet_target = next(
                (name for name in wb.sheetnames if "parque" in name.lower() or "equipamento" in name.lower()),
                wb.sheetnames[0],
            )
            ws = wb[sheet_target]
            header_row = [cell.value for cell in next(ws.iter_rows(max_row=1), ())]
            col_map = {
                re.sub(r"[\s_\-]+", "", str(value)).lower(): index + 1
                for index, value in enumerate(header_row)
                if value is not None
            }

            serial_col = col_map.get("numeroserie") or col_map.get("serial")
            apelido_col = col_map.get("apelido")
            id_cliente_col = col_map.get("idcliente")
            if not serial_col or not apelido_col:
                raise HTTPException(
                    status_code=500,
                    detail=f"A planilha '{source_file.name}' não contém as colunas NumeroSerie e Apelido esperadas."
                )

            current_sheet_name = find_details_sheet(current_file)
            if current_sheet_name is None:
                raise HTTPException(status_code=409, detail="A base EquipamentosDetalhes atual não tem os cabeçalhos esperados.")
            current_wb = openpyxl.load_workbook(current_file, read_only=True, data_only=False)
            current_ws = current_wb[current_sheet_name]
            current_headers = [cell.value for cell in next(current_ws.iter_rows(max_row=1), ())]
            current_columns = {
                re.sub(r"[\s_\-]+", "", str(value)).lower(): index + 1
                for index, value in enumerate(current_headers)
                if value is not None
            }
            current_serial_col = current_columns.get("numeroserie") or current_columns.get("serial")
            if not current_serial_col:
                raise HTTPException(status_code=409, detail="A base atual não contém NumeroSerie.")
            current_alias_col = current_columns.get("apelido") or current_columns.get("hostname")
            if not current_alias_col:
                raise HTTPException(status_code=409, detail="A base atual não contém Apelido ou Hostname.")
            current_id_cliente_col = current_columns.get("idcliente")
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
            skipped_duplicate_rows = set()
            skipped_formula_rows = 0
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

                if formula_skipped:
                    skipped_formula_rows += 1

            review_items = endpoint_alias_review_items(endpoint_index, set(serial_counts))
            pending_review_count = len(review_items) + len(skipped_duplicate_rows) + skipped_formula_rows
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
                "Content-Disposition, X-Total-Alterados, X-Total-Conferencia, "
                "X-Historico-Apelidos-Atualizados, X-Historico-Horario"
            ),
            "X-Total-Alterados": str(alias_update_count),
            "X-Total-Conferencia": str(pending_review_count),
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


async def read_uploaded_xlsx(upload: UploadFile, role: str) -> Dict[str, Any]:
    return await _read_uploaded_xlsx(upload, role, sys.modules[__name__])


@app.post("/api/planilhas/atualizar")
async def atualizar_planilhas(
    endpoint_file: UploadFile = File(...),
    details_file: UploadFile = File(...),
):
    return await update_inventory_files(
        endpoint_file,
        details_file,
        context=sys.modules[__name__],
    )


@app.post("/api/unidade/salvar")
def salvar_unidade(payload: UnidadePayload):
    """Salva ou edita uma regional/filial SEBRAE e persiste no catálogo do sistema."""
    cidade = payload.cidade.strip()
    endereco = payload.endereco.strip()
    uf = (payload.uf.strip() if payload.uf else "PR").upper()
    cep = format_cep(payload.cep)
    cnpj = payload.cnpj.strip()
    retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep}"

    custom_units = load_custom_units()
    matched = False

    if payload.id:
        for u in custom_units:
            if u.get("id") == payload.id:
                u.update({
                    "cidade": cidade,
                    "endereco": endereco,
                    "uf": uf,
                    "cep": cep,
                    "cnpj": cnpj,
                    "endereco_completo": retirada_endereco,
                    "label": f"{cidade} - {endereco} ({cnpj})"
                })
                matched = True
                break

    if not matched:
        new_id = (max([u.get("id", 0) for u in unidades_cache] + [0]) + 1) if not payload.id else payload.id
        custom_units.append({
            "id": new_id,
            "cidade": cidade,
            "endereco": endereco,
            "uf": uf,
            "cep": cep,
            "cnpj": cnpj,
            "is_sede": "sede" in cidade.lower() or "sede" in endereco.lower(),
            "endereco_completo": retirada_endereco,
            "label": f"{cidade} - {endereco} ({cnpj})"
        })

    save_custom_units(custom_units)
    load_database()
    return {
        "sucesso": True,
        "mensagem": f"Unidade '{cidade}' cadastrada/atualizada com sucesso!",
        "unidades": unidades_cache
    }


@app.get("/api/unidades")
def get_unidades():
    """Retorna o catálogo completo de unidades SEBRAE catalogadas."""
    return unidades_cache


@app.get("/api/buscar")
def buscar_seriais(q: str = Query(..., min_length=2)):
    """Busca rápida de seriais/modelos/apelidos para autocomplete."""
    term = q.strip().upper()
    results = []
    count = 0
    for k, item in equipamentos_cache.items():
        if term in k or term in item["modelo"].upper() or term in item["apelido"].upper():
            results.append({
                "serial": item["serial"],
                "modelo": item["modelo"],
                "tipo": item["tipo"],
                "apelido": item["apelido"],
                "retirada_cidade": item["retirada_cidade"],
                "invall_alias_status": item.get("invall_alias_status"),
                "invall_alias_detail": item.get("invall_alias_detail"),
            })
            count += 1
            if count >= 15:
                break
    return results


@app.get("/api/stats")
def get_stats():
    """Retorna métricas da base de dados."""
    return {
        **stats_cache,
        "total_apelidos_modificados": count_export_alias_changes()
    }


transfer_router, gerar_planilha = create_transfer_router(lambda: TEMPLATE_FILE)
app.include_router(transfer_router)

inventory_history_router, inventory_history_exports = create_inventory_history_router(sys.modules[__name__])
globals().update(inventory_history_exports)
app.include_router(inventory_history_router)

# Serve static files and frontend
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

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
    equipment_source = get_primary_equipment_file()
    print(f"[INFO] Diretório do projeto: {BASE_DIR}")
    print(f"[INFO] Modelo de transferência: {TEMPLATE_FILE} ({'OK' if TEMPLATE_FILE.is_file() else 'AUSENTE'})")
    print(f"[INFO] Fonte EquipamentosDetalhes: {equipment_source or 'AUSENTE'}")
    uvicorn.run(app, host="127.0.0.1", port=8000)
