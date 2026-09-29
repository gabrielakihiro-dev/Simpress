import io
import filecmp
import json
import os
import re
import shutil
import threading
import unicodedata
import uuid
import zipfile
from copy import deepcopy
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

# Base directories and files
BASE_DIR = Path(__file__).parent.resolve()
STATIC_DIR = BASE_DIR / "static"
INPUT_DIR = BASE_DIR / "planilhas_entrada"
TEMPLATE_FILE = INPUT_DIR / "(MODELO) - TRANSFERENCIA SIMPRESS.xlsx"
DETAILS_UPLOAD_FILE = INPUT_DIR / "EquipamentosDetalhes_atual.xlsx"
ENDPOINT_UPLOAD_FILE = INPUT_DIR / "InvAllComputersSummary_atual.xlsx"
DETAILS_EXPORT_BASELINE_FILE = INPUT_DIR / ".EquipamentosDetalhes_atual.export-baseline.xlsx"
EXPORT_MODEL_FILE = INPUT_DIR / "equipamentos-25-09-2026_160107.xlsx"
UPLOAD_BACKUPS_DIR = INPUT_DIR / "_backups"
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
MAX_UPLOAD_REQUEST_BYTES = 2 * MAX_UPLOAD_BYTES + 1024 * 1024
MAX_XLSX_ARCHIVE_ENTRIES = 10000
MAX_XLSX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
CUSTOM_UNIDADES_FILE = BASE_DIR / "unidades_custom.json"
MODIFIED_APELIDOS_FILE = BASE_DIR / "apelidos_modificados.json"
MODIFIED_APELIDOS_LOCK = threading.RLock()
ALIAS_HISTORY_FILE = BASE_DIR / "historico_alteracoes.json"
ALIAS_HISTORY_LOCK = threading.RLock()
COMPARISON_HISTORY_FILE = BASE_DIR / "historico_comparacoes.json"
COMPARISON_HISTORY_LOCK = threading.RLock()
TRANSACTION_ROOT = BASE_DIR
STATE_LOCK = threading.RLock()


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def _atomic_json_update(path: Path, updater, default):
    with AtomicFileTransaction(TRANSACTION_ROOT, [path]) as transaction:
        updated = transaction.update_json(path, updater, default)
        transaction.commit()
        return updated

def formatar_telefone_brasileiro(value: Any) -> str:
    """Padroniza telefones brasileiros no formato (DD) 9xxxx-xxxx e preserva ramais."""
    original = str(value or "").strip()
    if not original:
        return ""

    ramal_explicito = re.search(
        r"(?:ramal|ram\.?|ext\.?|x)\s*[:.]?\s*(\d+)\s*$",
        original,
        re.IGNORECASE,
    )
    if re.search(r"[A-Za-zÀ-ÿ]", original) and not ramal_explicito:
        return original

    telefone_original = original[:ramal_explicito.start()] if ramal_explicito else original
    digitos = re.sub(r"\D", "", telefone_original)

    if re.match(r"^\s*\+55\b", telefone_original) and len(digitos) >= 13:
        digitos = digitos[2:]
    elif re.match(r"^\s*0055\b", telefone_original) and len(digitos) >= 15:
        digitos = digitos[4:]

    if len(digitos) < 3:
        return original

    ddd = digitos[:2]
    numero = digitos[2:11]
    numero_formatado = f"{numero[:5]}-{numero[5:]}" if len(numero) > 5 else numero
    telefone_formatado = f"({ddd}) {numero_formatado}"
    ramal = ramal_explicito.group(1) if ramal_explicito else digitos[11:]
    return f"{telefone_formatado} Ramal: {ramal}" if ramal else telefone_formatado


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


def normalize_reference_value(value: Any) -> str:
    """Normaliza valores de série, apelido e cidade para comparações consistentes."""
    if value is None or pd.isna(value):
        return ""
    decomposed = unicodedata.normalize("NFKD", str(value).strip().upper())
    without_accents = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[^A-Z0-9]", "", without_accents)


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


def _record_value(record: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        normalized = normalize_reference_value(key)
        value = record.get(normalized)
        if value is not None and str(value).strip():
            return value
    return ""


def validate_uploaded_workbook(file_bytes: bytes, role: str) -> Dict[str, Any]:
    return select_upload_table(read_workbook_tables(file_bytes), role)


COMPARISON_SOURCE_LABELS = {
    "endpoint": "Endpoint",
    "detalhes": "EquipamentosDetalhes",
}


def _comparison_source_records(table: Dict[str, Any], role: str) -> List[Dict[str, Any]]:
    """Converts source-specific columns to a shared, comparison-only record shape."""
    serial_headers = (
        "ROTULODESERVICONUMERODESERIE", "NUMEROSERIE", "NUMERODESERIE", "SERIAL", "SERVICETAG"
    )
    endpoint_name_headers = ("NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME")
    equipment_alias_headers = ("APELIDO", "HOSTNAME", "NOMEDOCOMPUTADOR", "COMPUTERNAME")
    location_headers = ("CIDADE", "LOCAL", "LOCALIDADE", "LOCATION")
    user_headers = ("USUARIOSLOGADOS", "LOGGEDINUSERS", "USUARIO")

    records = []
    for row_number, row in enumerate(table.get("records", []), start=2):
        serial_value = _record_value(row, *serial_headers)
        if role == "endpoint":
            computer_name = str(_record_value(row, *endpoint_name_headers) or "").strip()
            if not computer_name.upper().startswith(("PRNOTE", "PRMAC")):
                continue
            alias_value = computer_name
        else:
            alias_value = str(_record_value(row, *equipment_alias_headers) or "").strip()
            computer_name = alias_value

        serial_display = str(serial_value or "").strip()
        if not serial_display and not computer_name:
            continue
        location_value = str(_record_value(row, *location_headers) or "").strip()
        records.append({
            "source": role,
            "row_number": row_number,
            "serie": serial_display,
            "serial_key": normalize_reference_value(serial_value),
            "computador": computer_name,
            "alias_key": normalize_reference_value(alias_value),
            "local": location_value,
            "usuario": str(_record_value(row, *user_headers) or "").strip(),
            "row": row,
        })
    return records


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
        equipment["apelido"] = endpoint_index["unique"][serial_key]
        equipment["invall_alias_status"] = "aplicado"
        equipment["invall_alias_detail"] = "Hostname da InvAll associado pela série normalizada."
    elif serial_key in endpoint_index.get("blank_hostnames", {}):
        equipment["invall_alias_status"] = "hostname_vazio"
        equipment["invall_alias_detail"] = "A InvAll tem a série, mas o hostname está vazio; o apelido atual foi mantido."
    else:
        equipment["invall_alias_status"] = "serie_nao_encontrada"
        equipment["invall_alias_detail"] = "Série não encontrada na InvAll; o apelido atual foi mantido."


def get_export_aliases() -> Dict[str, str]:
    """Combina apelidos locais e hostnames da InvAll; a InvAll tem prioridade."""
    aliases = {
        normalize_reference_value(serial): str(alias or "").strip()
        for serial, alias in load_modified_apelidos().items()
        if normalize_reference_value(serial)
    }
    aliases.update(load_endpoint_aliases())
    return aliases


def count_export_alias_changes(locked: bool = False) -> int:
    """Conta quantos apelidos do modelo de exportação serão realmente alterados."""
    def count() -> int:
        aliases = get_export_aliases()
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


SERIE_LOCAL_MAP = {
    "APU": "Apucarana", "ARA": "Arapongas", "ARC": "Araucária",
    "CMO": "Campo Mourão", "CAS": "Cascavel", "CIA": "Cianorte",
    "COL": "Colombo", "COP": "Cornélio Procópio", "AAI": "Curitiba",
    "DIREX": "Curitiba", "RCWB": "Curitiba", "RL": "Curitiba",
    "UAI": "Curitiba", "UAJ": "Curitiba", "UANE": "Curitiba",
    "UAR": "Curitiba", "UCF": "Curitiba", "UCS": "Curitiba",
    "UGE": "Curitiba", "UGIP": "Curitiba", "UGP": "Curitiba",
    "UIC": "Curitiba", "UMC": "Curitiba", "TI": "Curitiba UTIC",
    "MTZ": "Curitiba", "BTA": "Curitiba", "CIC": "Curitiba",
    "SFE": "Curitiba", "FOZ": "Foz do Iguaçu", "FBO": "Francisco Beltrão",
    "GPV": "Guarapuava", "IRA": "Irati", "IVA": "Ivaiporã",
    "JAC": "Jacarezinho", "LAJ": "Laranjeiras do Sul", "LON": "Londrina",
    "MAR": "Maringá", "PN": "Paranaguá", "PV": "Paranavaí",
    "PAB": "Pato Branco", "PG": "Ponta Grossa", "PTU": "Porecatu",
    "RIO": "Rio Negro", "SJP": "São José dos Pinhais", "TBO": "Telêmaco Borba",
    "TOL": "Toledo", "UMU": "Umuarama", "UDV": "União da Vitória",
    "BAR": "Barracão",
}

CURITIBA_HOSTNAME_PREFIXES = ("SJP", "RL", "ARC")
SEBRAE_OWNED_NOTEBOOK_SERIALS = frozenset({
    "BRJ135P5XS",
    "BRJ142QKBQ",
    "BRJ9435VMR",
    "BRJ9435VMF",
    "BRJ149SCJG",
})


def is_sebrae_owned_notebook_serial(serial: Any) -> bool:
    return normalize_reference_value(serial) in SEBRAE_OWNED_NOTEBOOK_SERIALS


def is_curitiba_hostname_exception(computer_name: str) -> bool:
    name = str(computer_name or "").strip().upper()
    if not name.startswith("PRNOTE"):
        return False
    suffix = normalize_reference_value(name[len("PRNOTE"):])
    return suffix.startswith(CURITIBA_HOSTNAME_PREFIXES)


def is_prnoteti_curitiba_location_match(
    computer_name: Any,
    expected_location: Any,
    details_location: Any,
) -> bool:
    name = str(computer_name or "").strip().upper()
    return (
        name.startswith("PRNOTETI")
        and normalize_reference_value(expected_location) == normalize_reference_value("Curitiba UTIC")
        and normalize_reference_value(details_location) == normalize_reference_value("Curitiba")
    )


def filter_sebrae_owned_unmatched_items(items: Any) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [
        item for item in items
        if not isinstance(item, dict) or not is_sebrae_owned_notebook_serial(item.get("serie"))
    ]


def filter_curitiba_hostname_location_mismatches(items: Any) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [
        item for item in items
        if not isinstance(item, dict)
        or (
            not is_curitiba_hostname_exception(item.get("computador"))
            and not is_prnoteti_curitiba_location_match(
                item.get("computador"),
                item.get("local_previsto"),
                item.get("local_detalhes"),
            )
        )
    ]


def comparison_history_for_display(evento: Dict[str, Any]) -> Dict[str, Any]:
    """Aplica a classificação atual às visualizações sem reescrever o histórico salvo."""
    event_view = dict(evento)
    comparison = evento.get("comparacao")
    if not isinstance(comparison, dict):
        return event_view

    comparison_view = dict(comparison)
    for obsolete_key in ("total_base_principal", "ausentes_na_base_principal", "divergencias_endereco"):
        comparison_view.pop(obsolete_key, None)

    def without_legacy_source(item: Any) -> Any:
        if not isinstance(item, dict):
            return item
        cleaned = dict(item)
        for key in ("local_base_principal", "ip_endpoint", "ip_detalhes", "ip_base_principal"):
            cleaned.pop(key, None)
        absent_in = cleaned.get("ausente_em")
        if isinstance(absent_in, list):
            cleaned["ausente_em"] = [source for source in absent_in if source != "Base principal"]
        if cleaned.get("fonte_ausente") == "Base principal":
            cleaned.pop("fonte_ausente", None)
        sources = cleaned.get("fontes")
        if isinstance(sources, dict):
            cleaned["fontes"] = {key: value for key, value in sources.items() if key != "Base principal"}
        elif isinstance(sources, list):
            cleaned["fontes"] = [
                source for source in sources
                if not isinstance(source, dict) or source.get("fonte") != "Base principal"
            ]
        return cleaned

    missing_lists = {
        "ausentes_no_endpoint": filter_sebrae_owned_unmatched_items(
            comparison.get("ausentes_no_endpoint")
        ),
        "ausentes_em_detalhes": filter_sebrae_owned_unmatched_items(
            comparison.get("ausentes_em_detalhes")
        ),
    }
    missing_lists = {
        key: [without_legacy_source(item) for item in items]
        for key, items in missing_lists.items()
    }
    comparison_view.update(missing_lists)
    location_mismatches = filter_curitiba_hostname_location_mismatches(comparison.get("divergencias_local"))
    comparison_view["divergencias_local"] = [without_legacy_source(item) for item in location_mismatches]
    for field in ("correspondencias_ambiguas", "registros_ambiguos"):
        items = comparison.get(field)
        if isinstance(items, list):
            comparison_view[field] = [without_legacy_source(item) for item in items]
    comparison_files = comparison.get("arquivos_enviados")
    if isinstance(comparison_files, dict):
        comparison_view["arquivos_enviados"] = {
            key: comparison_files[key]
            for key in ("endpoint", "detalhes")
            if key in comparison_files
        }
    event_view["comparacao"] = comparison_view

    summary = dict(evento.get("resumo") or {})
    for obsolete_key in ("total_base_principal", "ausentes_na_base_principal", "divergencias_endereco"):
        summary.pop(obsolete_key, None)
    for key, items in missing_lists.items():
        if key in summary or key in comparison:
            summary[key] = len(items)
    summary["divergencias_local"] = len(location_mismatches)
    alias_changes = comparison.get("apelidos_atualizados")
    if isinstance(alias_changes, list):
        summary["apelidos_atualizados"] = len(alias_changes)
    alias_review = comparison.get("apelidos_sem_atualizacao")
    if isinstance(alias_review, list):
        summary["apelidos_sem_atualizacao"] = len(alias_review)
    event_view["resumo"] = summary
    uploaded_files = evento.get("arquivos_enviados")
    if isinstance(uploaded_files, dict):
        event_view["arquivos_enviados"] = {
            key: uploaded_files[key]
            for key in ("endpoint", "detalhes")
            if key in uploaded_files
        }
    return event_view


def location_for_computer_name(computer_name: str) -> Optional[str]:
    name = str(computer_name or "").strip().upper()
    if not name.startswith("PRNOTE"):
        return None
    suffix = normalize_reference_value(name[len("PRNOTE"):])
    if suffix.startswith("BACKUP"):
        backup_target = suffix[len("BACKUP"):]
        if not backup_target or not re.search(r"[A-Z]", backup_target):
            return "Curitiba"
        for prefix in sorted(SERIE_LOCAL_MAP, key=len, reverse=True):
            if backup_target.startswith(prefix):
                return SERIE_LOCAL_MAP[prefix]
        city_names = sorted(
            ((normalize_reference_value(city), city) for city in set(SERIE_LOCAL_MAP.values())),
            key=lambda item: len(item[0]),
            reverse=True,
        )
        for normalized_city, city in city_names:
            if backup_target.startswith(normalized_city):
                return city
        return None
    if suffix.startswith(CURITIBA_HOSTNAME_PREFIXES):
        return "Curitiba"
    prefix_source = suffix[3:] if suffix.startswith("BKP") else suffix
    for prefix in sorted(SERIE_LOCAL_MAP, key=len, reverse=True):
        if prefix_source.startswith(prefix):
            return SERIE_LOCAL_MAP[prefix]
    return None


def compare_uploaded_workbooks(
    endpoint_table: Dict[str, Any],
    details_table: Dict[str, Any],
    uploaded_names: Dict[str, str],
) -> Dict[str, Any]:
    """Compares Endpoint and EquipamentosDetalhes without silently selecting duplicate matches."""
    source_tables = {
        "endpoint": endpoint_table,
        "detalhes": details_table,
    }
    source_records = {
        role: _comparison_source_records(table, role)
        for role, table in source_tables.items()
    }

    nodes: Dict[tuple, Dict[str, Any]] = {}
    parent: Dict[tuple, tuple] = {}
    rank: Dict[tuple, int] = {}
    component_serials: Dict[tuple, set] = {}
    for role in COMPARISON_SOURCE_LABELS:
        for index, record in enumerate(source_records[role]):
            node = (role, index)
            record["node"] = node
            nodes[node] = record
            parent[node] = node
            rank[node] = 0
            component_serials[node] = {record["serial_key"]} if record["serial_key"] else set()

    def find(node: tuple) -> tuple:
        if parent[node] != node:
            parent[node] = find(parent[node])
        return parent[node]

    def union(left: tuple, right: tuple) -> bool:
        root_left = find(left)
        root_right = find(right)
        if root_left == root_right:
            return True
        serials_left = component_serials[root_left]
        serials_right = component_serials[root_right]
        if serials_left and serials_right and serials_left != serials_right:
            return False
        if rank[root_left] < rank[root_right]:
            root_left, root_right = root_right, root_left
        parent[root_right] = root_left
        component_serials[root_left] = serials_left | serials_right
        component_serials.pop(root_right, None)
        if rank[root_left] == rank[root_right]:
            rank[root_left] += 1
        return True

    issues: List[Dict[str, Any]] = []
    issue_keys = set()

    def add_issue(issue: Dict[str, Any]) -> None:
        key = (
            issue.get("tipo"),
            normalize_reference_value(issue.get("chave")),
            tuple(
                (source.get("fonte"), source.get("quantidade"), source.get("serie"))
                for source in issue.get("fontes", [])
            ),
        )
        if key not in issue_keys:
            issue_keys.add(key)
            issues.append(issue)

    serial_buckets: Dict[str, List[tuple]] = {}
    alias_buckets: Dict[str, List[tuple]] = {}
    for node, record in nodes.items():
        if record["serial_key"]:
            serial_buckets.setdefault(record["serial_key"], []).append(node)
        if record["alias_key"]:
            alias_buckets.setdefault(record["alias_key"], []).append(node)

    for serial_key, bucket in serial_buckets.items():
        by_source: Dict[str, List[tuple]] = {}
        for node in bucket:
            by_source.setdefault(node[0], []).append(node)
        duplicate_sources = [
            {"fonte": COMPARISON_SOURCE_LABELS[role], "quantidade": len(source_nodes)}
            for role, source_nodes in by_source.items()
            if len(source_nodes) > 1
        ]
        if duplicate_sources:
            add_issue({
                "tipo": "Número de série duplicado",
                "chave": nodes[bucket[0]]["serie"] or serial_key,
                "fontes": duplicate_sources,
                "mensagem": "A série aparece em mais de uma linha na mesma fonte; esses registros foram agrupados como ambíguos.",
            })
        for node in bucket[1:]:
            union(bucket[0], node)

    ambiguous_roles_by_node: Dict[tuple, set] = {node: set() for node in nodes}
    for alias_key, bucket in alias_buckets.items():
        by_source = {}
        for node in bucket:
            by_source.setdefault(node[0], []).append(node)
        duplicate_sources = [
            {"fonte": COMPARISON_SOURCE_LABELS[role], "quantidade": len(source_nodes)}
            for role, source_nodes in by_source.items()
            if len(source_nodes) > 1
        ]
        if duplicate_sources:
            add_issue({
                "tipo": "Hostname/Apelido duplicado",
                "chave": nodes[bucket[0]]["computador"] or alias_key,
                "fontes": duplicate_sources,
                "mensagem": "O hostname/Apelido não é único nesta fonte e não foi usado para escolher uma linha.",
            })

        roles = list(by_source)
        for role_index, left_role in enumerate(roles):
            for right_role in roles[role_index + 1:]:
                left_nodes = by_source[left_role]
                right_nodes = by_source[right_role]
                if len(left_nodes) != 1 or len(right_nodes) != 1:
                    for left_node in left_nodes:
                        for right_node in right_nodes:
                            left_serial = nodes[left_node]["serial_key"]
                            right_serial = nodes[right_node]["serial_key"]
                            if left_serial and right_serial:
                                if left_serial != right_serial:
                                    add_issue({
                                        "tipo": "Série divergente para o mesmo hostname/Apelido",
                                        "chave": nodes[left_node]["computador"] or alias_key,
                                        "fontes": [
                                            {"fonte": COMPARISON_SOURCE_LABELS[left_role], "serie": nodes[left_node]["serie"]},
                                            {"fonte": COMPARISON_SOURCE_LABELS[right_role], "serie": nodes[right_node]["serie"]},
                                        ],
                                        "mensagem": "As séries prevalecem sobre o hostname/Apelido; os registros não foram unidos.",
                                    })
                                continue
                            ambiguous_roles_by_node[left_node].add(right_role)
                            ambiguous_roles_by_node[right_node].add(left_role)
                    continue

                left_node = left_nodes[0]
                right_node = right_nodes[0]
                left_serial = nodes[left_node]["serial_key"]
                right_serial = nodes[right_node]["serial_key"]
                if left_serial and right_serial and left_serial != right_serial:
                    add_issue({
                        "tipo": "Série divergente para o mesmo hostname/Apelido",
                        "chave": nodes[left_node]["computador"] or alias_key,
                        "fontes": [
                            {"fonte": COMPARISON_SOURCE_LABELS[left_role], "serie": nodes[left_node]["serie"]},
                            {"fonte": COMPARISON_SOURCE_LABELS[right_role], "serie": nodes[right_node]["serie"]},
                        ],
                        "mensagem": "As séries prevalecem sobre o hostname/Apelido; os registros não foram unidos.",
                    })
                    continue
                if not union(left_node, right_node):
                    add_issue({
                        "tipo": "Correspondência ambígua por hostname/Apelido",
                        "chave": nodes[left_node]["computador"] or alias_key,
                        "fontes": [
                            {"fonte": COMPARISON_SOURCE_LABELS[left_role], "serie": nodes[left_node]["serie"]},
                            {"fonte": COMPARISON_SOURCE_LABELS[right_role], "serie": nodes[right_node]["serie"]},
                        ],
                        "mensagem": "O hostname/Apelido levaria a séries incompatíveis; nenhum registro foi escolhido.",
                    })
                    if not left_serial:
                        ambiguous_roles_by_node[left_node].add(right_role)
                    if not right_serial:
                        ambiguous_roles_by_node[right_node].add(left_role)

    components: Dict[tuple, List[tuple]] = {}
    for node in nodes:
        components.setdefault(find(node), []).append(node)

    def distinct_values(records: List[Dict[str, Any]], field: str) -> List[str]:
        values = []
        for record in records:
            value = str(record.get(field) or "").strip()
            if value and value not in values:
                values.append(value)
        return values

    entities = []
    missing_by_source = {role: [] for role in COMPARISON_SOURCE_LABELS}
    ambiguous_records = []
    for component_nodes in components.values():
        records_by_source = {role: [] for role in COMPARISON_SOURCE_LABELS}
        for node in component_nodes:
            records_by_source[node[0]].append(nodes[node])

        ambiguous_source_roles = set()
        for node in component_nodes:
            ambiguous_source_roles.update(ambiguous_roles_by_node[node])

        source_status = {}
        for role in COMPARISON_SOURCE_LABELS:
            count = len(records_by_source[role])
            if count > 1:
                source_status[role] = "ambíguo"
            elif count == 1:
                source_status[role] = "presente"
            elif role in ambiguous_source_roles:
                source_status[role] = "ambíguo"
            else:
                source_status[role] = "ausente"

        all_records = [record for role in COMPARISON_SOURCE_LABELS for record in records_by_source[role]]
        names = distinct_values(all_records, "computador")
        serials = distinct_values(all_records, "serie")
        endpoint_records = records_by_source["endpoint"]
        expected_locations = list(dict.fromkeys(
            location_for_computer_name(record["computador"])
            for record in endpoint_records
            if location_for_computer_name(record["computador"])
        ))
        expected_location = expected_locations[0] if len(expected_locations) == 1 else None
        entity = {
            "computador": " / ".join(names) if names else "Sem hostname/Apelido",
            "serie": " / ".join(serials),
            "usuario": " / ".join(distinct_values(endpoint_records, "usuario")),
            "local_previsto": expected_location or "Sem mapeamento de local",
            "fontes": {
                COMPARISON_SOURCE_LABELS[role]: source_status[role]
                for role in COMPARISON_SOURCE_LABELS
            },
            "ausente_em": [
                COMPARISON_SOURCE_LABELS[role]
                for role, status in source_status.items()
                if status == "ausente"
            ],
        }
        entities.append((entity, records_by_source, source_status, expected_location))

        for role, status in source_status.items():
            if status != "ausente" or is_sebrae_owned_notebook_serial(entity["serie"]):
                continue
            item = dict(entity)
            item["fonte_ausente"] = COMPARISON_SOURCE_LABELS[role]
            missing_by_source[role].append(item)

        if "ambíguo" in source_status.values():
            ambiguous_records.append({
                **entity,
                "motivo": "Há registros duplicados ou uma alternativa de hostname/Apelido que não é única.",
            })

    location_mismatches = []
    for entity, records_by_source, source_status, expected_location in entities:
        endpoint_records = records_by_source["endpoint"]
        if len(endpoint_records) != 1:
            continue
        endpoint_record = endpoint_records[0]
        computer_name = endpoint_record["computador"]
        if expected_location:
            location_values = {}
            any_location_mismatch = False
            details_records = records_by_source["detalhes"]
            details_location = details_records[0]["local"] if len(details_records) == 1 else ""
            location_values["local_detalhes"] = details_location
            if (
                details_location
                and normalize_reference_value(details_location) != normalize_reference_value(expected_location)
                and not is_curitiba_hostname_exception(computer_name)
                and not is_prnoteti_curitiba_location_match(
                    computer_name,
                    expected_location,
                    details_location,
                )
            ):
                any_location_mismatch = True
            if any_location_mismatch:
                location_mismatches.append({
                    "computador": computer_name,
                    "serie": endpoint_record["serie"],
                    "local_previsto": expected_location,
                    **location_values,
                })

    unmapped_series: Dict[str, List[str]] = {}
    for record in source_records["endpoint"]:
        computer_name = record["computador"]
        if not computer_name.upper().startswith("PRNOTE") or location_for_computer_name(computer_name):
            continue
        suffix = computer_name.upper()[len("PRNOTE"):]
        if suffix.startswith("BACKUP"):
            suffix = suffix[len("BACKUP"):]
        elif suffix.startswith("BKP"):
            suffix = suffix[3:]
        series_code = next(
            (prefix for prefix in sorted(SERIE_LOCAL_MAP, key=len, reverse=True) if suffix.startswith(prefix)),
            suffix.rstrip("0123456789-_") or suffix,
        )
        unmapped_series.setdefault(series_code, []).append(computer_name)

    return {
        "total_endpoint": len(source_records["endpoint"]),
        "total_detalhes": len(details_table["records"]),
        "ausentes_no_endpoint": missing_by_source["endpoint"],
        "ausentes_em_detalhes": missing_by_source["detalhes"],
        "correspondencias_ambiguas": issues,
        "registros_ambiguos": ambiguous_records,
        "divergencias_local": location_mismatches,
        "series_sem_mapeamento": [
            {"serie": code, "exemplos": names[:10], "quantidade": len(names)}
            for code, names in sorted(unmapped_series.items())
        ],
        "arquivos_enviados": uploaded_names,
    }


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

app = FastAPI(
    title="Simpress Transferência de Equipamentos - SEBRAE/PR",
    description="Sistema inteligente para emissão automatizada de planilhas oficiais de transferência de equipamentos.",
    version="1.3.0"
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
        
        cnpj_instalacao = get_row_val(row, "CNPJ Instalacao", "CnpjInstalacao", "CNPJ")

        contrato = get_row_val(row, "CodigoContrato", "Codigo Contrato", default="16467")
        razao_social = get_row_val(row, "RazaoSocial", "Razao Social", default="SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR")

        # Check if Sede Curitiba
        is_sede = ("caeté" in endereco.lower() or "caete" in endereco.lower() or "sede" in endereco.lower() or "sede" in cidade.lower()) and ("curitiba" in cidade.lower() or "sede" in cidade.lower())
        if is_sede:
            endereco = "R Caeté, 150 - SEDE - Prado Velho"
            cidade = "Curitiba"
            uf = "PR"
            cep_formatado = "80220-300"
            cnpj_instalacao = "75.110.585/0001-00"
            retirada_endereco = "R Caeté, 150 - SEDE - Prado Velho - Curitiba/PR - CEP 80220-300"
        else:
            if not cnpj_instalacao:
                cnpj_instalacao = "75.110.585/0001-00"
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
    curitiba_oficial = {
        "cidade": "Curitiba",
        "endereco": "R Caeté, 150 - SEDE - Prado Velho",
        "uf": "PR",
        "cep": "80220-300",
        "cnpj": "75.110.585/0001-00",
        "is_sede": True,
        "endereco_completo": "R Caeté, 150 - SEDE - Prado Velho - Curitiba/PR - CEP 80220-300",
        "label": "Curitiba - R Caeté, 150 - SEDE - Prado Velho (75.110.585/0001-00)"
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
            "label": f"{u['cidade']} - {u['endereco']} ({u['cnpj']})"
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

    # Apelidos manuais ficam como camada local; a InvAll única define o valor efetivo do site.
    mod_apelidos = load_modified_apelidos()
    endpoint_index = read_endpoint_alias_index()
    for serial_key, equipment in new_equipamentos_cache.items():
        normalized_serial = normalize_reference_value(equipment.get("serial"))
        equipment["_apelido_local"] = _manual_alias_for_serial(
            mod_apelidos, equipment.get("serial"), equipment.get("_apelido_base", "")
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
        "total_apelidos_modificados": count_export_alias_changes(locked=True),
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
    endereco: Optional[str] = Field("", description="Endereço de instalação")
    cidade: Optional[str] = Field("", description="Cidade")
    uf: Optional[str] = Field("PR", description="UF")
    cep: Optional[str] = Field("", description="CEP")
    cnpj_instalacao: Optional[str] = Field("", description="CNPJ de Instalação")


class UnidadePayload(BaseModel):
    id: Optional[int] = None
    cidade: str
    endereco: str
    uf: Optional[str] = "PR"
    cep: str
    cnpj: str


class TransferenciaPayload(BaseModel):
    serial: str = Field(..., description="Número de Série do Equipamento")
    descricao_equipamento: str = Field("", description="Descrição e Acessórios do Equipamento")
    razao_social: str = Field("SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR")
    contrato: Any = Field(16467, description="Número do Contrato")
    
    # Retirada (Origem)
    retirada_cnpj: str = Field("75.110.585/0001-00")
    retirada_endereco: str = Field("")
    retirada_horario: str = Field("09:00:00 às 18:00:00")
    retirada_almoco: str = Field("12:00:00")
    retirada_pausa_duracao: str = Field("1h12")
    retirada_tipo_acesso: str = Field("Elevador / Rampa / Térreo")
    retirada_acesso_obs: str = Field("")
    retirada_contato: str = Field("Gabriel Akihiro Noda Souza (Simpress)")
    retirada_email: str = Field("gansouza@simpress.com.br")
    retirada_telefone: str = Field("(41) 98751-2389")
    retirada_obs: str = Field("")
    retirada_voltagem: str = Field("Bivolt")

    # Entrega (Destino)
    entrega_cnpj: str = Field(...)
    entrega_endereco: str = Field(...)
    entrega_horario: str = Field("09:00:00 às 18:00:00")
    entrega_almoco: str = Field("12:00:00")
    entrega_pausa_duracao: str = Field("1h")
    entrega_tipo_acesso: str = Field("Elevador / Rampa / Térreo")
    entrega_acesso_obs: str = Field("")
    entrega_contato: str = Field(..., description="Nome do Destinatário")
    entrega_email: str = Field("", description="E-mail do Destinatário")
    entrega_telefone: str = Field("", description="Telefone do Destinatário")
    entrega_obs: str = Field("", description="Observações do Chamado")
    entrega_voltagem: str = Field("Bivolt")


class ApelidoUpdatePayload(BaseModel):
    serial: str = Field(..., description="Número de Série do Equipamento")
    apelido: str = Field(..., description="Novo Apelido / Hostname do Equipamento")


class ApelidoUndoPayload(BaseModel):
    evento_id: str = Field(..., description="ID do evento de apelido que deve ser desfeito")


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
    set_value(col_map.get("endereco"), payload.endereco.strip() if payload.endereco is not None else None)
    set_value(col_map.get("cidade"), payload.cidade.strip() if payload.cidade is not None else None)
    set_value(col_map.get("uf"), payload.uf.strip() if payload.uf is not None else None)
    cep_col = col_map.get("cep")
    if cep_col and payload.cep is not None:
        raw_cep = re.sub(r"\D", "", str(payload.cep))
        set_value(cep_col, int(raw_cep) if raw_cep.isdigit() else payload.cep.strip())
    set_value(col_map.get("cnpjinstalacao") or col_map.get("cnpj"), payload.cnpj_instalacao.strip() if payload.cnpj_instalacao is not None else None)
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
        cnpj = "75.110.585/0001-00"
    elif not cnpj:
        cnpj = "75.110.585/0001-00"

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
    endereco_info = normalizar_endereco_instalacao(payload)
    endereco = endereco_info["endereco"]
    cidade = endereco_info["cidade"]
    uf = endereco_info["uf"]
    cep_formatado = endereco_info["cep"]
    cnpj_instalacao = endereco_info["cnpj"]
    retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep_formatado}" if endereco else f"{cidade}/{uf}"

    desc_sugerida = get_suggested_description(payload.tipo, payload.modelo)

    existing = equipamentos_cache.get(target_serial_upper, {})
    modified_aliases = load_modified_apelidos()
    local_alias = _manual_alias_for_serial(modified_aliases, target_serial_upper, payload.apelido or "")
    updated_equipment = {
        "serial": target_serial_upper,
        "modelo": payload.modelo.strip() if payload.modelo else "",
        "tipo": payload.tipo.strip() if payload.tipo else "",
        "apelido": local_alias,
        "_apelido_base": payload.apelido.strip() if payload.apelido else "",
        "_apelido_local": local_alias,
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
    endereco_anterior = snapshot_endereco_instalacao(equipamento_existente) if equipamento_existente else None
    endereco_novo = normalizar_endereco_instalacao(payload) if equipamento_existente else None
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

    evento_endereco = None
    if endereco_anterior is not None and endereco_novo is not None and endereco_anterior != endereco_novo:
        evento_endereco = build_address_change_entry(target_serial, endereco_anterior, endereco_novo)
        def append_address(history):
            if not isinstance(history, list):
                raise RuntimeError("O conteúdo do histórico manual não é uma lista.")
            return [*history, evento_endereco]
        json_mutations[ALIAS_HISTORY_FILE] = append_address

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
        "mensagem": (
            "Apelido manual salvo; o hostname único da InvAll continua sendo exibido."
            if resultado["equipamento"].get("invall_alias_status") == "aplicado"
            else "Apelido salvo com sucesso."
        ),
        **{**resultado, "equipamento": {key: value for key, value in resultado["equipamento"].items() if not key.startswith("_")}},
        "total_modificados": len(load_modified_apelidos()),
    }


@app.get("/api/historico-alteracoes")
@app.get("/api/historico-apelidos")
def get_historico_apelidos():
    historico = load_alias_history()
    return {"total": len(historico), "eventos": list(reversed(historico))}


@app.get("/api/historico-comparacoes")
def get_historico_comparacoes():
    historico = load_comparison_history()
    eventos = []
    for evento in reversed(historico):
        event_view = comparison_history_for_display(evento)
        eventos.append({
            "id": event_view.get("id"),
            "horario": event_view.get("horario"),
            "arquivos_enviados": event_view.get("arquivos_enviados", {}),
            "resumo": event_view.get("resumo", {}),
        })
    return {"total": len(eventos), "eventos": eventos}


@app.get("/api/historico-comparacoes/{evento_id}")
def get_comparacao_historica(evento_id: str):
    historico = load_comparison_history()
    evento = next((item for item in historico if item.get("id") == evento_id), None)
    if evento is None:
        raise HTTPException(status_code=404, detail="O resultado selecionado não existe no histórico de planilhas.")
    return {"evento": comparison_history_for_display(evento)}


@app.delete("/api/historico-comparacoes/{evento_id}")
def excluir_comparacao_historica(evento_id: str):
    total = delete_comparison_history_entry(evento_id)
    if total is None:
        raise HTTPException(status_code=404, detail="A atualização selecionada não existe mais no histórico.")
    return {"sucesso": True, "total": total}


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
        "mensagem": (
            "Apelido manual restaurado; o hostname único da InvAll continua sendo exibido."
            if resultado["equipamento"].get("invall_alias_status") == "aplicado"
            else "Apelido restaurado; a reversão foi registrada no histórico."
        ),
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
    """Exporta o modelo escolhido, alterando somente Apelido por número de série."""
    source_file = EXPORT_MODEL_FILE
    if not source_file.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"O modelo de exportação '{source_file.name}' não foi encontrado."
        )

    wb = None
    try:
        with lock_paths([source_file, ENDPOINT_UPLOAD_FILE, MODIFIED_APELIDOS_FILE]):
            wb = load_workbook_safely(source_file)
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
            if not serial_col or not apelido_col:
                raise HTTPException(
                    status_code=500,
                    detail=f"A planilha '{source_file.name}' não contém as colunas NumeroSerie e Apelido esperadas."
                )

            endpoint_index = read_endpoint_alias_index()
            aliases = get_export_aliases()
            serial_counts: Dict[str, int] = {}
            for row in range(2, ws.max_row + 1):
                serial_key = normalize_reference_value(ws.cell(row=row, column=serial_col).value)
                if serial_key:
                    serial_counts[serial_key] = serial_counts.get(serial_key, 0) + 1

            expected_values = {}
            skipped_duplicate_rows = set()
            skipped_formula_rows = 0
            for row in range(2, ws.max_row + 1):
                serial_key = normalize_reference_value(ws.cell(row=row, column=serial_col).value)
                if not serial_key or serial_key not in aliases:
                    continue
                if serial_counts.get(serial_key) != 1:
                    skipped_duplicate_rows.add(serial_key)
                    continue

                alias_cell = ws.cell(row=row, column=apelido_col)
                if alias_cell.data_type == "f":
                    skipped_formula_rows += 1
                    continue
                updated_alias = aliases[serial_key]
                if alias_cell.value != updated_alias:
                    alias_cell.value = updated_alias
                    expected_values[(ws.title, alias_cell.coordinate)] = updated_alias

            review_items = endpoint_alias_review_items(endpoint_index, set(serial_counts))
            pending_review_count = len(review_items) + len(skipped_duplicate_rows) + skipped_formula_rows
            output_bytes = serialize_workbook_validated(source_file, wb, original, expected_values)

        now_str = datetime.now().strftime("%d-%m-%Y_%H%M%S")
        export_filename = f"EquipamentosDetalhes-{now_str}.xlsx"
        buffer = io.BytesIO(output_bytes)
        buffer.seek(0)
        headers = {
            "Content-Disposition": f'attachment; filename="{export_filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition, X-Total-Alterados, X-Total-Conferencia",
            "X-Total-Alterados": str(len(expected_values)),
            "X-Total-Conferencia": str(pending_review_count),
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
    display_role = {
        "endpoint": "Endpoint",
        "detalhes": "EquipamentosDetalhes",
    }.get(role, role)
    original_name = re.split(r"[/\\]", str(upload.filename or ""))[-1]
    if not original_name or Path(original_name).suffix.lower() != ".xlsx":
        raise HTTPException(status_code=400, detail=f"Selecione um arquivo .xlsx válido para {display_role}.")

    file_bytes = await upload.read(MAX_UPLOAD_BYTES + 1)
    if not file_bytes:
        raise HTTPException(status_code=400, detail=f"O arquivo de {display_role} está vazio.")
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"O arquivo de {display_role} excede o limite de 30 MB.")

    table = validate_uploaded_workbook(file_bytes, role)
    return {"name": original_name, "bytes": file_bytes, "table": table}


@app.post("/api/planilhas/atualizar")
async def atualizar_planilhas(
    endpoint_file: UploadFile = File(...),
    details_file: UploadFile = File(...),
):
    """Compara e atualiza Endpoint e EquipamentosDetalhes."""
    global equipamentos_cache, unidades_cache, stats_cache
    uploads = [endpoint_file, details_file]
    staging_dir = INPUT_DIR / f".upload-staging-{uuid.uuid4().hex}"
    backup_dir = UPLOAD_BACKUPS_DIR / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    state_before = None

    try:
        INPUT_DIR.mkdir(parents=True, exist_ok=True)
        staged = {
            "endpoint": await read_uploaded_xlsx(endpoint_file, "endpoint"),
            "detalhes": await read_uploaded_xlsx(details_file, "detalhes"),
        }
        comparison = compare_uploaded_workbooks(
            staged["endpoint"]["table"],
            staged["detalhes"]["table"],
            {
                "endpoint": staged["endpoint"]["name"],
                "detalhes": staged["detalhes"]["name"],
            },
        )
        previous_aliases = snapshot_equipment_aliases(equipamentos_cache)
        state_before = (
            deepcopy(equipamentos_cache),
            deepcopy(unidades_cache),
            deepcopy(stats_cache),
        )

        target_files = {
            "endpoint": ENDPOINT_UPLOAD_FILE,
            "detalhes": DETAILS_UPLOAD_FILE,
        }
        stage_paths = {}
        staging_dir.mkdir(parents=True, exist_ok=False)
        for role, target_path in target_files.items():
            stage_path = staging_dir / target_path.name
            stage_path.write_bytes(staged[role]["bytes"])
            stage_paths[role] = stage_path

        baseline_path = DETAILS_EXPORT_BASELINE_FILE
        fixed_targets = {path.resolve(strict=False) for path in [*target_files.values(), baseline_path, COMPARISON_HISTORY_FILE]}
        backup_dir.mkdir(parents=True, exist_ok=False)

        with AtomicFileTransaction(TRANSACTION_ROOT, fixed_targets) as transaction:
            old_sources = []
            old_sources.extend((path, "detalhes") for path in get_details_files())
            old_sources.extend((path, "endpoint") for path in INPUT_DIR.glob("InvAllComputersSummary*.xlsx"))
            old_sources.extend(
                (path, "baseline")
                for path in INPUT_DIR.glob(".EquipamentosDetalhes*.export-baseline.xlsx")
            )
            for role, target_path in target_files.items():
                if target_path.exists():
                    old_sources.append((target_path, role))

            unique_sources = []
            seen_source_paths = set()
            for source_path, role in old_sources:
                resolved_source = source_path.resolve(strict=False)
                if source_path.is_file() and resolved_source not in seen_source_paths:
                    transaction.add_target(source_path)
                    unique_sources.append((source_path, role))
                    seen_source_paths.add(resolved_source)

            for source_path, role in unique_sources:
                role_dir = backup_dir / role
                role_dir.mkdir(parents=True, exist_ok=True)
                backup_path = role_dir / source_path.name
                shutil.copy2(source_path, backup_path)
                if not filecmp.cmp(source_path, backup_path, shallow=False):
                    raise RuntimeError(f"A cópia de segurança de '{source_path.name}' não passou na validação.")

            for role, target_path in target_files.items():
                def validate_staged(path: Path, current_role=role) -> None:
                    validate_uploaded_workbook(path.read_bytes(), current_role)
                transaction.stage_file(
                    target_path,
                    lambda temp, stage=stage_paths[role]: shutil.copyfile(stage, temp),
                    validate_staged,
                )
            transaction.stage_file(
                baseline_path,
                lambda temp: shutil.copyfile(stage_paths["detalhes"], temp),
                lambda path: validate_uploaded_workbook(path.read_bytes(), "detalhes"),
            )
            for source_path, _ in unique_sources:
                if source_path.resolve(strict=False) not in fixed_targets:
                    transaction.stage_delete(source_path)

            # Apply the workbook set provisionally; load_database publishes new caches only after full validation.
            transaction.apply()
            if not load_database(transaction_locked=True):
                raise RuntimeError("O EquipamentosDetalhes enviado não pôde ser carregado pelo site.")

            endpoint_index = read_endpoint_alias_index()
            details_serial_counts: Dict[str, int] = {}
            blank_details_aliases = []
            for record in staged["detalhes"]["table"].get("records", []):
                raw_serial = _record_value(record, "NUMEROSERIE", "NUMERODESERIE", "SERIAL")
                serial_key = normalize_reference_value(raw_serial)
                if serial_key:
                    details_serial_counts[serial_key] = details_serial_counts.get(serial_key, 0) + 1
                else:
                    alias = str(_record_value(record, "APELIDO", "HOSTNAME") or "").strip()
                    if alias:
                        blank_details_aliases.append(alias)
            details_serials = set(details_serial_counts)
            details_duplicate_serials = {
                serial for serial, count in details_serial_counts.items() if count > 1
            }
            comparison["apelidos_atualizados"] = compare_equipment_aliases(
                previous_aliases,
                snapshot_equipment_aliases(equipamentos_cache),
            )
            comparison["apelidos_sem_atualizacao"] = endpoint_alias_review_items(
                endpoint_index, details_serials, details_duplicate_serials
            )
            comparison["apelidos_sem_atualizacao"].extend({
                "serie": "",
                "computador": alias,
                "motivo": "Número de série vazio em EquipamentosDetalhes; nenhum hostname foi associado.",
            } for alias in blank_details_aliases)
            comparison["backup_criado"] = True
            comparison["backup_diretorio"] = str(backup_dir.relative_to(INPUT_DIR))
            comparison["arquivo_detalhes_ativo"] = DETAILS_UPLOAD_FILE.name
            comparison["total_equipamentos_carregados"] = stats_cache.get("total_equipamentos", 0)
            comparison["ultima_atualizacao"] = stats_cache.get("ultima_atualizacao", "")
            comparison["horario_comparacao"] = datetime.now().astimezone().isoformat(timespec="seconds")
            source_names = {
                "endpoint": staged["endpoint"]["name"],
                "detalhes": staged["detalhes"]["name"],
            }
            comparison["apelidos_atualizados"] = [
                {
                    **item,
                    "horario": comparison["horario_comparacao"],
                    "arquivos_origem": source_names,
                }
                for item in comparison["apelidos_atualizados"]
                if item["apelido_anterior"] != item["apelido_novo"]
            ]
            comparison["historico_salvo"] = True
            evento_historico = {
                "id": uuid.uuid4().hex,
                "horario": comparison["horario_comparacao"],
                "arquivos_enviados": source_names,
                "resumo": {
                    "total_endpoint": comparison.get("total_endpoint", 0),
                    "ausentes_no_endpoint": len(comparison.get("ausentes_no_endpoint", [])),
                    "ausentes_em_detalhes": len(comparison.get("ausentes_em_detalhes", [])),
                    "divergencias_local": len(comparison.get("divergencias_local", [])),
                    "correspondencias_ambiguas": len(comparison.get("correspondencias_ambiguas", [])),
                    "series_sem_mapeamento": len(comparison.get("series_sem_mapeamento", [])),
                    "apelidos_atualizados": len(comparison["apelidos_atualizados"]),
                    "apelidos_sem_atualizacao": len(comparison["apelidos_sem_atualizacao"]),
                },
                "comparacao": comparison,
            }

            def append_update(history):
                if not isinstance(history, list):
                    raise RuntimeError("O Histórico planilhas não contém uma lista válida.")
                return [*history, evento_historico]
            transaction.update_json(COMPARISON_HISTORY_FILE, append_update, [])
            transaction.commit()

        return {
            "sucesso": True,
            "comparacao": comparison,
            "stats": stats_cache,
            "historico_salvo": True,
        }
    except HTTPException:
        if state_before:
            with STATE_LOCK:
                equipamentos_cache, unidades_cache, stats_cache = state_before
        raise
    except FileBusyError as error:
        if state_before:
            with STATE_LOCK:
                equipamentos_cache, unidades_cache, stats_cache = state_before
        raise HTTPException(status_code=409, detail=str(error)) from error
    except TransactionConflictError as error:
        if state_before:
            with STATE_LOCK:
                equipamentos_cache, unidades_cache, stats_cache = state_before
        raise HTTPException(status_code=500, detail=f"A recuperação detectou uma alteração externa em um arquivo e parou sem sobrescrevê-lo: {error}") from error
    except (FileTransactionError, WorkbookSafetyError) as error:
        if state_before:
            with STATE_LOCK:
                equipamentos_cache, unidades_cache, stats_cache = state_before
        raise HTTPException(status_code=500, detail=f"Não foi possível concluir a atualização; a transação restaurou os arquivos anteriores. {error}") from error
    except Exception:
        if state_before:
            with STATE_LOCK:
                equipamentos_cache, unidades_cache, stats_cache = state_before
        print("[ERRO] Falha ao atualizar o conjunto de planilhas.")
        raise HTTPException(status_code=500, detail="Falha ao atualizar as planilhas; os arquivos anteriores foram restaurados.") from None
    finally:
        for upload in uploads:
            await upload.close()
        shutil.rmtree(staging_dir, ignore_errors=True)


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


@app.post("/api/gerar-planilha")
def gerar_planilha(payload: TransferenciaPayload):
    """Gera a planilha oficial de transferência Simpress a partir do template com os dados preenchidos."""
    if not TEMPLATE_FILE.exists():
        raise HTTPException(status_code=500, detail=f"Arquivo de template '{TEMPLATE_FILE.name}' não encontrado no servidor.")

    wb = None
    try:
        with lock_paths([TEMPLATE_FILE]):
            wb = load_workbook_safely(TEMPLATE_FILE)
            original_snapshot = workbook_snapshot(wb)
            # Localiza a aba de 'Transferência'.
            sheet_target = next(
                (name for name in wb.sheetnames if "transfer" in name.lower() and "lote" not in name.lower()),
                wb.sheetnames[0],
            )
            ws = wb[sheet_target]
            expected_values = {}

            def set_template_cell(address: str, value: Any) -> None:
                ws[address].value = value
                expected_values[(ws.title, address)] = value

            # Formatação de valores.
            serial_val = payload.serial.strip().upper()
            descricao_val = payload.descricao_equipamento.strip() or f"Equipamento {serial_val}"
            retirada_obs_val = payload.retirada_obs.strip() or descricao_val
            retirada_telefone = formatar_telefone_brasileiro(payload.retirada_telefone)
            entrega_telefone = formatar_telefone_brasileiro(payload.entrega_telefone)

            # Contrato numérico se possível.
            contrato_val: Any = payload.contrato
            try:
                contrato_val = int(contrato_val)
            except (ValueError, TypeError):
                pass

            # Preenchimento exato conforme células oficiais.
            set_template_cell("B5", payload.razao_social or "SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR")
            set_template_cell("J5", contrato_val)
            set_template_cell("B8", serial_val)
            set_template_cell("F8", descricao_val)

            # Bloco de Retirada (Origem).
            set_template_cell("B17", payload.retirada_cnpj)
            set_template_cell("F17", payload.retirada_endereco)
            set_template_cell("B19", payload.retirada_horario)
            set_template_cell("F19", payload.retirada_almoco)
            set_template_cell("J19", payload.retirada_pausa_duracao)
            set_template_cell("B21", payload.retirada_tipo_acesso)
            set_template_cell("J21", payload.retirada_acesso_obs)
            set_template_cell("B23", payload.retirada_contato)
            set_template_cell("F23", payload.retirada_email)
            set_template_cell("J23", retirada_telefone)
            set_template_cell("B25", retirada_obs_val)
            set_template_cell("J25", payload.retirada_voltagem)

            # Bloco de Entrega (Destino).
            set_template_cell("B29", payload.entrega_cnpj)
            set_template_cell("F29", payload.entrega_endereco)
            set_template_cell("B31", payload.entrega_horario)
            set_template_cell("F31", payload.entrega_almoco)
            set_template_cell("J31", payload.entrega_pausa_duracao)
            set_template_cell("B33", payload.entrega_tipo_acesso)
            set_template_cell("J33", payload.entrega_acesso_obs)
            set_template_cell("B35", payload.entrega_contato)
            set_template_cell("F35", payload.entrega_email)
            set_template_cell("J35", entrega_telefone)
            set_template_cell("B37", payload.entrega_obs)
            set_template_cell("J37", payload.entrega_voltagem)

            # Salva e valida um temporário junto ao template antes de preparar o download.
            output_bytes = serialize_workbook_validated(TEMPLATE_FILE, wb, original_snapshot, expected_values)
            wb.close()

        buffer = io.BytesIO(output_bytes)
        buffer.seek(0)

        # Data para o nome do arquivo
        data_hoje = datetime.now().strftime("%Y%m%d")
        safe_serial = re.sub(r"[^\w\-]", "_", serial_val)
        filename = f"Transferencia_{safe_serial}_{data_hoje}.xlsx"

        headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
        }

        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers
        )

    except FileBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except WorkbookSafetyError as error:
        raise HTTPException(status_code=409, detail=f"Geração cancelada para preservar o template: {error}") from error
    except FileTransactionError as error:
        raise HTTPException(status_code=500, detail=f"Não foi possível validar a planilha gerada: {error}") from error
    except Exception:
        print("[ERRO] Falha ao gerar a planilha de transferência.")
        raise HTTPException(status_code=500, detail="Erro ao processar o modelo Excel.") from None
    finally:
        if wb is not None:
            wb.close()


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
