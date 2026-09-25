import io
import json
import os
import re
import shutil
import threading
import unicodedata
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any

import openpyxl
import pandas as pd
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

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
CUSTOM_UNIDADES_FILE = BASE_DIR / "unidades_custom.json"
MODIFIED_APELIDOS_FILE = BASE_DIR / "apelidos_modificados.json"
MODIFIED_APELIDOS_LOCK = threading.RLock()
ALIAS_HISTORY_FILE = BASE_DIR / "historico_alteracoes.json"
ALIAS_HISTORY_LOCK = threading.RLock()
COMPARISON_HISTORY_FILE = BASE_DIR / "historico_comparacoes.json"
COMPARISON_HISTORY_LOCK = threading.RLock()

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
                raise RuntimeError(f"Não foi possível ler apelidos_modificados.json: {e}") from e
            print(f"[AVISO] Erro ao carregar apelidos_modificados.json: {e}")
            return {}

def save_modified_apelidos(apelidos: Dict[str, str]) -> None:
    temp_file = MODIFIED_APELIDOS_FILE.with_name(f"{MODIFIED_APELIDOS_FILE.name}.tmp")
    with MODIFIED_APELIDOS_LOCK:
        try:
            temp_file.write_text(json.dumps(apelidos, ensure_ascii=False, indent=2), encoding="utf-8")
            temp_file.replace(MODIFIED_APELIDOS_FILE)
        except Exception:
            try:
                temp_file.unlink(missing_ok=True)
            except OSError:
                pass
            raise

def save_modified_apelido_record(serial: str, apelido: str) -> None:
    s_key = serial.strip().upper()
    ap_val = apelido.strip()
    with MODIFIED_APELIDOS_LOCK:
        data = load_modified_apelidos()
        data[s_key] = ap_val
        try:
            save_modified_apelidos(data)
        except Exception as e:
            print(f"[ERRO] Falha ao gravar apelidos_modificados.json: {e}")

def load_alias_history() -> List[Dict[str, Any]]:
    with ALIAS_HISTORY_LOCK:
        if not ALIAS_HISTORY_FILE.exists():
            return []
        try:
            data = json.loads(ALIAS_HISTORY_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                raise ValueError("O conteúdo do histórico não é uma lista.")
            return data
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Não foi possível ler o histórico de apelidos: {e}"
            )

def save_alias_history(history: List[Dict[str, Any]]) -> None:
    temp_file = ALIAS_HISTORY_FILE.with_name(f"{ALIAS_HISTORY_FILE.name}.tmp")
    try:
        temp_file.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_file.replace(ALIAS_HISTORY_FILE)
    except Exception as e:
        try:
            temp_file.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(
            status_code=500,
            detail=f"Não foi possível salvar o histórico de alterações: {e}"
        )

def append_alias_history_entry(entry: Dict[str, Any]) -> None:
    with ALIAS_HISTORY_LOCK:
        history = load_alias_history()
        history.append(entry)
        save_alias_history(history)

def delete_alias_history_entry(event_id: str) -> bool:
    with ALIAS_HISTORY_LOCK:
        history = load_alias_history()
        filtered_history = [entry for entry in history if entry.get("id") != event_id]
        if len(filtered_history) == len(history):
            return False
        save_alias_history(filtered_history)
        return True

def load_comparison_history() -> List[Dict[str, Any]]:
    with COMPARISON_HISTORY_LOCK:
        if not COMPARISON_HISTORY_FILE.exists():
            return []
        try:
            data = json.loads(COMPARISON_HISTORY_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                raise ValueError("O conteúdo do histórico não é uma lista.")
            return data
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Não foi possível ler o histórico de comparações: {e}"
            )

def save_comparison_history(history: List[Dict[str, Any]]) -> None:
    temp_file = COMPARISON_HISTORY_FILE.with_name(f"{COMPARISON_HISTORY_FILE.name}.tmp")
    try:
        temp_file.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_file.replace(COMPARISON_HISTORY_FILE)
    except Exception as e:
        try:
            temp_file.unlink(missing_ok=True)
        except OSError:
            pass
        raise RuntimeError(f"Não foi possível salvar o histórico de comparações: {e}") from e

def append_comparison_history_entry(entry: Dict[str, Any]) -> None:
    with COMPARISON_HISTORY_LOCK:
        history = load_comparison_history()
        history.append(entry)
        save_comparison_history(history)

def record_alias_change(
    serial: str,
    previous_alias: str,
    new_alias: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
) -> Dict[str, Any]:
    equipment = equipamentos_cache.get(serial, {})
    entry = {
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
    append_alias_history_entry(entry)
    return entry

def record_address_change(
    serial: str,
    previous_address: Dict[str, str],
    new_address: Dict[str, str],
) -> Dict[str, Any]:
    equipment = equipamentos_cache.get(serial, {})
    entry = {
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
    append_alias_history_entry(entry)
    return entry

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


def read_workbook_tables(file_bytes: bytes) -> List[Dict[str, Any]]:
    """Lê abas não vazias de um XLSX e retorna cabeçalhos normalizados e linhas."""
    workbook = None
    try:
        workbook = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
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
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"O arquivo não é um Excel .xlsx válido: {error}")
    finally:
        if workbook is not None:
            workbook.close()


def select_upload_table(tables: List[Dict[str, Any]], role: str) -> Dict[str, Any]:
    """Valida o esquema esperado para Endpoint ou EquipamentosDetalhes."""
    serial_headers = {"NUMEROSERIE", "SERIAL"}
    alias_headers = {"APELIDO", "HOSTNAME"}
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
            "ROTULODESERVICONUMERODESERIE", "NUMERODESERIE", "SERIAL", "SERVICETAG"
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
        raise HTTPException(
            status_code=400,
            detail=f"A planilha enviada como {role} não contém uma aba com os cabeçalhos obrigatórios: {description}.",
        )

    if role == "detalhes":
        candidates.sort(
            key=lambda table: int(
                "parque" in table["sheet"].lower() or "equipamento" in table["sheet"].lower()
            ),
            reverse=True,
        )

    table = candidates[0]
    if role == "endpoint":
        name_column = next(key for key in ("NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME") if key in table["headers"])
        populated_rows = sum(1 for row in table["records"] if str(row.get(name_column) or "").strip())
    else:
        populated_rows = sum(1 for row in table["records"] if _record_value(row, "NumeroSerie", "Serial"))

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


def _equipment_indexes(table: Dict[str, Any]) -> Dict[str, Dict[str, Dict[str, Any]]]:
    serial_index: Dict[str, Dict[str, Any]] = {}
    alias_index: Dict[str, Dict[str, Any]] = {}
    for row in table["records"]:
        serial_key = normalize_reference_value(_record_value(row, "numeroserie", "serial"))
        alias_key = normalize_reference_value(_record_value(row, "apelido", "hostname"))
        if serial_key:
            serial_index.setdefault(serial_key, row)
        if alias_key:
            alias_index.setdefault(alias_key, row)
    return {"serial": serial_index, "alias": alias_index}


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

            aliases = {}
            for row in worksheet.iter_rows(min_row=2, values_only=True):
                serial = row[serial_col] if serial_col < len(row) else None
                if serial is None or not str(serial).strip():
                    continue
                alias = row[alias_col] if alias_col < len(row) else None
                aliases[normalize_reference_value(serial)] = "" if alias is None else str(alias).strip()
            return aliases

        raise HTTPException(
            status_code=500,
            detail=f"O modelo '{EXPORT_MODEL_FILE.name}' não contém as colunas NumeroSerie e Apelido."
        )
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Não foi possível ler o modelo de exportação: {error}"
        ) from error
    finally:
        if workbook is not None:
            workbook.close()


def sync_uploaded_alias_changes(
    uploaded_table: Dict[str, Any],
    previous_aliases: Dict[str, str],
) -> None:
    """Registra só aliases alterados no novo EquipamentosDetalhes enviado."""
    model_aliases = load_export_model_aliases()
    with MODIFIED_APELIDOS_LOCK:
        modified_aliases = load_modified_apelidos(strict=True)
        normalized_override_keys = {
            normalize_reference_value(serial): serial
            for serial in modified_aliases
        }
        changed = False

        for record in uploaded_table.get("records", []):
            raw_serial = _record_value(record, "numeroserie", "serial")
            serial_key = normalize_reference_value(raw_serial)
            if not serial_key or serial_key not in model_aliases:
                continue

            new_alias = str(_record_value(record, "apelido", "hostname") or "").strip()
            previous_alias = previous_aliases.get(serial_key, model_aliases[serial_key])
            if new_alias == previous_alias:
                continue

            override_key = normalized_override_keys.get(serial_key)
            if new_alias == model_aliases[serial_key]:
                if override_key is not None:
                    modified_aliases.pop(override_key, None)
                    normalized_override_keys.pop(serial_key, None)
                    changed = True
                continue

            normalized_key = str(raw_serial).strip().upper()
            if override_key is not None and override_key != normalized_key:
                modified_aliases.pop(override_key, None)
            modified_aliases[normalized_key] = new_alias
            normalized_override_keys[serial_key] = normalized_key
            changed = True

        if changed:
            save_modified_apelidos(modified_aliases)


SERIE_LOCAL_MAP = {
    "APU": "Apucarana", "ARA": "Arapongas", "ARC": "Araucária",
    "CMO": "Campo Mourão", "CAS": "Cascavel", "CIA": "Cianorte",
    "COL": "Colombo", "COP": "Cornélio Procópio", "AAI": "Curitiba",
    "DIREX": "Curitiba", "RCWB": "Curitiba", "RL": "Curitiba",
    "UAI": "Curitiba", "UAJ": "Curitiba", "UANE": "Curitiba",
    "UAR": "Curitiba", "UCF": "Curitiba", "UCS": "Curitiba",
    "UGE": "Curitiba", "UGIP": "Curitiba", "UGP": "Curitiba",
    "UIC": "Curitiba", "UMC": "Curitiba", "TI": "Curitiba",
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
        if not isinstance(item, dict) or not is_curitiba_hostname_exception(item.get("computador"))
    ]


def comparison_history_for_display(evento: Dict[str, Any]) -> Dict[str, Any]:
    """Aplica a classificação atual às visualizações sem reescrever o histórico salvo."""
    event_view = dict(evento)
    comparison = evento.get("comparacao")
    if not isinstance(comparison, dict):
        return event_view

    comparison_view = dict(comparison)
    unmatched = filter_sebrae_owned_unmatched_items(comparison.get("ausentes_em_detalhes"))
    comparison_view["ausentes_em_detalhes"] = unmatched
    location_mismatches = filter_curitiba_hostname_location_mismatches(comparison.get("divergencias_local"))
    comparison_view["divergencias_local"] = location_mismatches
    event_view["comparacao"] = comparison_view

    summary = dict(evento.get("resumo") or {})
    summary["ausentes_em_detalhes"] = len(unmatched)
    summary["divergencias_local"] = len(location_mismatches)
    event_view["resumo"] = summary
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
    """Compara notebooks do Endpoint com EquipamentosDetalhes e valida a localidade."""
    endpoint_name_headers = ("NOMEDOCOMPUTADOR", "COMPUTERNAME", "HOSTNAME")
    endpoint_serial_headers = ("ROTULODESERVICONUMERODESERIE", "NUMEROSERIE", "SERIAL", "SERVICETAG")
    endpoint_user_headers = ("USUARIOSLOGADOS", "LOGGEDINUSERS", "USUARIO")
    details_indexes = _equipment_indexes(details_table)

    def equipment_match(serial: str, name: str):
        if serial and serial in details_indexes["serial"]:
            return details_indexes["serial"][serial]
        if name and name in details_indexes["alias"]:
            return details_indexes["alias"][name]
        return None

    def location_value(row: Optional[Dict[str, Any]]) -> str:
        return str(_record_value(row or {}, "cidade") or "").strip()

    def missing_item(row: Dict[str, Any], name: str, serial: str, expected: Optional[str]) -> Dict[str, Any]:
        return {
            "computador": name,
            "serie": str(_record_value(row, *endpoint_serial_headers) or "").strip(),
            "usuario": str(_record_value(row, *endpoint_user_headers) or "").strip(),
            "local_previsto": expected or "Sem mapeamento de local",
        }

    endpoint_name_col = next(key for key in endpoint_name_headers if key in endpoint_table["headers"])
    endpoint_rows = [
        row for row in endpoint_table["records"]
        if str(row.get(endpoint_name_col) or "").strip().upper().startswith(("PRNOTE", "PRMAC"))
    ]
    missing_details = []
    location_mismatches = []
    unmapped_series: Dict[str, List[str]] = {}

    for row in endpoint_rows:
        computer_name = str(row.get(endpoint_name_col) or "").strip()
        name_key = normalize_reference_value(computer_name)
        serial_value = _record_value(row, *endpoint_serial_headers)
        serial_key = normalize_reference_value(serial_value)
        details_match = equipment_match(serial_key, name_key)
        expected_location = location_for_computer_name(computer_name)

        result_item = missing_item(row, computer_name, serial_key, expected_location)
        if details_match is None and not is_sebrae_owned_notebook_serial(serial_key):
            missing_details.append(result_item)
        if computer_name.upper().startswith("PRNOTE") and expected_location is None:
            suffix = computer_name.upper()[len("PRNOTE"):]
            if suffix.startswith("BACKUP"):
                suffix = suffix[len("BACKUP"):]
            elif suffix.startswith("BKP"):
                suffix = suffix[3:]
            series_code = next((prefix for prefix in sorted(SERIE_LOCAL_MAP, key=len, reverse=True) if suffix.startswith(prefix)), suffix.rstrip("0123456789-_") or suffix)
            unmapped_series.setdefault(series_code, []).append(computer_name)

        if not expected_location:
            continue
        details_city = location_value(details_match)
        expected_key = normalize_reference_value(expected_location)
        details_differs = bool(
            details_city
            and normalize_reference_value(details_city) != expected_key
            and not is_curitiba_hostname_exception(computer_name)
        )
        if details_differs:
            location_mismatches.append({
                "computador": computer_name,
                "serie": str(serial_value or "").strip(),
                "local_previsto": expected_location,
                "local_detalhes": details_city,
            })

    return {
        "total_endpoint": len(endpoint_rows),
        "total_detalhes": len(details_table["records"]),
        "ausentes_em_detalhes": missing_details,
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
        shutil.copy2(source_file, baseline_file)
        return baseline_file
    except Exception as e:
        print(f"[AVISO] Não foi possível preservar EquipamentosDetalhes para exportação: {e}")
        return None

def get_parque_file() -> Optional[Path]:
    """Retorna a fonte EquipamentosDetalhes carregada pelo site."""
    return get_equipamentos_template_file()

app = FastAPI(
    title="Simpress Transferência de Equipamentos - SEBRAE/PR",
    description="Sistema inteligente para emissão automatizada de planilhas oficiais de transferência de equipamentos.",
    version="1.3.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        except Exception as e:
            print(f"[ERRO] Falha ao carregar {CUSTOM_UNIDADES_FILE.name}: {e}")
    return []

def save_custom_units(units: List[Dict[str, Any]]) -> None:
    try:
        with open(CUSTOM_UNIDADES_FILE, "w", encoding="utf-8") as f:
            json.dump(units, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[ERRO] Falha ao gravar {CUSTOM_UNIDADES_FILE.name}: {e}")

def load_database() -> bool:
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
    except Exception as e:
        print(f"[ERRO] Falha ao ler {active_details_file.name}: {e}")
        return False

    # Strip column names e criar mapa normalizado de colunas
    df.columns = [str(col).strip() for col in df.columns]
    norm_cols = {re.sub(r'[\s_\-]+', '', str(c)).lower(): c for c in df.columns}
    new_equipamentos_cache: Dict[str, Dict[str, Any]] = {}

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

    # Mesclar apelidos modificados persistentes
    mod_apelidos = load_modified_apelidos()
    for s_key, ap_val in mod_apelidos.items():
        if s_key in new_equipamentos_cache:
            new_equipamentos_cache[s_key]["apelido"] = ap_val

    # Calculate stats
    tipo_col_real = norm_cols.get("tipo") or "Tipo"
    type_counts = df[tipo_col_real].value_counts().to_dict() if tipo_col_real in df.columns else {}
    new_stats_cache = {
        "total_equipamentos": len(new_equipamentos_cache),
        "total_unidades": len(new_unidades_cache),
        "total_apelidos_modificados": len(mod_apelidos),
        "tipos": type_counts,
        "arquivo_origem": active_details_file.name,
        "ultima_atualizacao": datetime.now().strftime("%d/%m/%Y %H:%M")
    }

    # Só publica os novos caches depois de ler, converter e validar toda a planilha.
    equipamentos_cache = new_equipamentos_cache
    unidades_cache = new_unidades_cache
    stats_cache = new_stats_cache

    print(f"[SUCESSO] Base carregada: {len(equipamentos_cache)} equipamentos ({len(mod_apelidos)} com apelido modificado) e {len(unidades_cache)} unidades catalogadas.")
    return True

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
    retirada_telefone: str = Field("(41) 9 98751-2389")
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


def update_equipment_in_workbook_file(file_path: Path, payload: EquipamentoUpdatePayload) -> bool:
    """Atualiza ou insere os dados de um equipamento em uma planilha Excel preservando 100%
    das linhas, colunas e formatações existentes."""
    if not file_path.exists():
        return False

    try:
        wb = openpyxl.load_workbook(file_path)
    except PermissionError:
        raise HTTPException(
            status_code=409,
            detail=f"Não foi possível salvar na planilha: o arquivo '{file_path.name}' está aberto no Excel ou em outro aplicativo. Feche o Excel no seu computador e tente novamente."
        )

    # Identificar aba ('equipamentos', 'Parque' ou primeira aba)
    target_sheet_name = None
    for name in wb.sheetnames:
        if "equipamento" in name.lower() or "parque" in name.lower():
            target_sheet_name = name
            break
    if not target_sheet_name:
        target_sheet_name = wb.sheetnames[0]

    ws = wb[target_sheet_name]
    header_row = [cell.value for cell in next(ws.iter_rows(max_row=1))]
    col_map = {re.sub(r'[\s_\-]+', '', str(val)).lower(): idx + 1 for idx, val in enumerate(header_row) if val is not None}

    serial_col = col_map.get("numeroserie") or col_map.get("serial")
    if not serial_col:
        return False

    target_serial_upper = payload.serial.strip().upper()
    target_row = None

    for row in range(2, ws.max_row + 1):
        c_val = ws.cell(row=row, column=serial_col).value
        if c_val and str(c_val).strip().upper() == target_serial_upper:
            target_row = row
            break

    # Se não existir na planilha, adiciona nova linha ao final
    if not target_row:
        target_row = ws.max_row + 1
        ws.cell(row=target_row, column=serial_col, value=target_serial_upper)
        if "codigocontrato" in col_map:
            ws.cell(row=target_row, column=col_map["codigocontrato"], value=16467)
        if "itemdecontrato" in col_map:
            ws.cell(row=target_row, column=col_map["itemdecontrato"], value=target_row - 1)
        if "razaosocial" in col_map:
            ws.cell(row=target_row, column=col_map["razaosocial"], value="SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR")

    # Atualiza as colunas que existirem na planilha alvo
    apelido_col = col_map.get("apelido")
    if apelido_col and payload.apelido is not None:
        ws.cell(row=target_row, column=apelido_col, value=payload.apelido.strip())

    modelo_col = col_map.get("modelo")
    if modelo_col and payload.modelo is not None:
        ws.cell(row=target_row, column=modelo_col, value=payload.modelo.strip())

    tipo_col = col_map.get("tipo") or col_map.get("classeequipamento")
    if tipo_col and payload.tipo is not None:
        ws.cell(row=target_row, column=tipo_col, value=payload.tipo.strip())

    id_cliente_col = col_map.get("idcliente")
    if id_cliente_col and payload.idCliente is not None:
        ws.cell(row=target_row, column=id_cliente_col, value=payload.idCliente.strip())

    endereco_col = col_map.get("endereco")
    if endereco_col and payload.endereco is not None:
        ws.cell(row=target_row, column=endereco_col, value=payload.endereco.strip())

    cidade_col = col_map.get("cidade")
    if cidade_col and payload.cidade is not None:
        ws.cell(row=target_row, column=cidade_col, value=payload.cidade.strip())

    uf_col = col_map.get("uf")
    if uf_col and payload.uf is not None:
        ws.cell(row=target_row, column=uf_col, value=payload.uf.strip())

    cep_col = col_map.get("cep")
    if cep_col and payload.cep is not None:
        raw_c = re.sub(r"\D", "", str(payload.cep))
        ws.cell(row=target_row, column=cep_col, value=int(raw_c) if raw_c.isdigit() else payload.cep.strip())

    cnpj_col = col_map.get("cnpjinstalacao") or col_map.get("cnpj")
    if cnpj_col and payload.cnpj_instalacao is not None:
        ws.cell(row=target_row, column=cnpj_col, value=payload.cnpj_instalacao.strip())

    try:
        wb.save(file_path)
        return True
    except PermissionError:
        raise HTTPException(
            status_code=409,
            detail=f"Não foi possível salvar na planilha: o arquivo '{file_path.name}' está aberto no Excel. Feche o Excel no seu computador e tente salvar novamente."
        )


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


def save_equipment_to_excel(payload: EquipamentoUpdatePayload):
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

    # Mantém todas as cópias EquipamentosDetalhes sincronizadas.
    salvo_em_algum = False
    for tf in target_files:
        if update_equipment_in_workbook_file(tf, payload):
            salvo_em_algum = True

    if not salvo_em_algum:
        raise HTTPException(status_code=500, detail="Não foi possível atualizar o equipamento na planilha.")

    # Atualiza o cache em memória imediatamente
    endereco_info = normalizar_endereco_instalacao(payload)
    endereco = endereco_info["endereco"]
    cidade = endereco_info["cidade"]
    uf = endereco_info["uf"]
    cep_formatado = endereco_info["cep"]
    cnpj_instalacao = endereco_info["cnpj"]
    retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep_formatado}" if endereco else f"{cidade}/{uf}"

    desc_sugerida = get_suggested_description(payload.tipo, payload.modelo)

    equipamentos_cache[target_serial_upper] = {
        "serial": target_serial_upper,
        "modelo": payload.modelo.strip() if payload.modelo else "",
        "tipo": payload.tipo.strip() if payload.tipo else "",
        "apelido": payload.apelido.strip() if payload.apelido else "",
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

    stats_cache["total_equipamentos"] = len(equipamentos_cache)
    stats_cache["ultima_atualizacao"] = datetime.now().strftime("%d/%m/%Y %H:%M")


# Endpoints
@app.get("/api/equipamento/{serial}")
def get_equipamento(serial: str):
    """Busca um equipamento pelo número de série (sem distinção de maiúsculas/minúsculas)."""
    clean_serial = serial.strip().upper()
    if clean_serial in equipamentos_cache:
        return equipamentos_cache[clean_serial]
    
    # Busca parcial se termo tiver 4 ou mais caracteres
    if len(clean_serial) >= 4:
        for k, v in equipamentos_cache.items():
            if clean_serial in k:
                return v

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
        payload.apelido = equipamento_existente.get("apelido", "")
    elif payload.apelido is not None and payload.apelido.strip():
        # Novos equipamentos ainda podem receber o apelido durante o cadastro.
        save_modified_apelido_record(target_serial, payload.apelido.strip())

    evento_endereco = None
    if endereco_anterior is not None and endereco_novo is not None and endereco_anterior != endereco_novo:
        evento_endereco = record_address_change(target_serial, endereco_anterior, endereco_novo)

    try:
        save_equipment_to_excel(payload)
    except Exception:
        if evento_endereco:
            try:
                delete_alias_history_entry(evento_endereco["id"])
            except Exception as history_error:
                print(f"[AVISO] Não foi possível desfazer o registro de endereço após falha ao salvar: {history_error}")
        raise
    total_mod = len(load_modified_apelidos())
    return {
        "sucesso": True,
        "mensagem": f"Equipamento {target_serial} atualizado com sucesso no site e na planilha Excel!",
        "equipamento": equipamentos_cache[target_serial],
        "total_modificados": total_mod
    }


def atualizar_apelido_na_planilha(target_serial: str, novo_apelido: str, obrigatorio: bool = False) -> bool:
    """Atualiza somente a célula do apelido na planilha oficial, sem tocar em estilos."""
    target_file = get_equipamentos_template_file()
    if not target_file.exists():
        if obrigatorio:
            raise HTTPException(status_code=404, detail="A planilha de equipamentos não foi encontrada para salvar a restauração.")
        return False

    try:
        wb = openpyxl.load_workbook(target_file)
        sheet_target = next((name for name in wb.sheetnames if "equipamento" in name.lower()), wb.sheetnames[0])
        ws = wb[sheet_target]
        header_row = [cell.value for cell in next(ws.iter_rows(max_row=1))]
        col_map = {
            re.sub(r'[\s_\-]+', '', str(val)).lower(): idx + 1
            for idx, val in enumerate(header_row)
            if val is not None
        }
        serial_col = col_map.get("numeroserie") or col_map.get("serial") or 4
        alias_col = col_map.get("apelido") or 5

        for row in range(2, ws.max_row + 1):
            cell_serial = ws.cell(row=row, column=serial_col).value
            if cell_serial and str(cell_serial).strip().upper() == target_serial:
                ws.cell(row=row, column=alias_col, value=novo_apelido)
                wb.save(target_file)
                return True
        if obrigatorio:
            raise HTTPException(status_code=404, detail=f"A série {target_serial} não foi encontrada na planilha para restaurar o apelido.")
        return False
    except HTTPException:
        raise
    except PermissionError:
        if obrigatorio:
            raise HTTPException(status_code=409, detail=f"Feche a planilha '{target_file.name}' no Excel para salvar a restauração do apelido.")
        print(f"[AVISO] Planilha '{target_file.name}' está aberta no Excel. O apelido foi salvo no histórico e no cache para exportação.")
    except Exception as e:
        if obrigatorio:
            raise HTTPException(status_code=500, detail=f"Não foi possível salvar a restauração do apelido: {e}")
        print(f"[AVISO] Não foi possível atualizar planilha em disco: {e}")
    return False


def aplicar_alteracao_apelido(
    target_serial: str,
    novo_apelido: str,
    action: str = "alteracao",
    reference_id: Optional[str] = None,
    registrar_historico: bool = True,
    exigir_salvamento_planilha: bool = False,
) -> Dict[str, Any]:
    equipamento = equipamentos_cache.get(target_serial)
    if equipamento is None:
        raise HTTPException(status_code=404, detail=f"Equipamento com serial '{target_serial}' não encontrado na base de dados.")

    apelido_anterior = str(equipamento.get("apelido") or "").strip()
    if apelido_anterior != novo_apelido and registrar_historico:
        # Registra antes de alterar o estado para não aplicar mudanças sem trilha de auditoria.
        record_alias_change(target_serial, apelido_anterior, novo_apelido, action, reference_id)

    if exigir_salvamento_planilha:
        excel_salvo = atualizar_apelido_na_planilha(target_serial, novo_apelido, obrigatorio=True)
        equipamento["apelido"] = novo_apelido
        save_modified_apelido_record(target_serial, novo_apelido)
    else:
        equipamento["apelido"] = novo_apelido
        save_modified_apelido_record(target_serial, novo_apelido)
        excel_salvo = atualizar_apelido_na_planilha(target_serial, novo_apelido)
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
        "mensagem": "Apelido salvo com sucesso.",
        **resultado,
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
        apelido_atual = str(equipamento.get("apelido") or "").strip()
        apelido_novo = str(evento.get("apelido_novo") or "").strip()
        if apelido_atual != apelido_novo:
            raise HTTPException(status_code=409, detail="O apelido atual não corresponde mais a este registro. Recarregue a base antes de restaurar.")

        apelido_anterior = str(evento.get("apelido_anterior") or "").strip()
        resultado = aplicar_alteracao_apelido(
            target_serial,
            apelido_anterior,
            registrar_historico=False,
            exigir_salvamento_planilha=True,
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
            apelido=str(equipamento.get("apelido") or ""),
            idCliente=str(equipamento.get("idCliente") or ""),
            endereco=str(endereco_anterior.get("endereco") or ""),
            cidade=str(endereco_anterior.get("cidade") or ""),
            uf=str(endereco_anterior.get("uf") or "PR"),
            cep=str(endereco_anterior.get("cep") or ""),
            cnpj_instalacao=str(endereco_anterior.get("cnpj") or ""),
        )
        save_equipment_to_excel(payload_restauracao)
        equipamento_restaurado = equipamentos_cache[target_serial]

    if not delete_alias_history_entry(evento_id):
        raise HTTPException(status_code=409, detail="O registro foi atualizado por outra ação. Atualize o histórico e tente novamente.")

    return {
        "sucesso": True,
        "evento_id": evento_id,
        "tipo": tipo_evento,
        "equipamento": equipamento_restaurado,
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

    apelido_atual = str(equipamento.get("apelido") or "").strip()
    if apelido_atual != str(evento.get("apelido_novo") or "").strip():
        raise HTTPException(status_code=409, detail="O apelido atual foi alterado depois deste registro. Recarregue o histórico antes de desfazer.")

    apelido_restaurado = str(evento.get("apelido_anterior") or "").strip()
    resultado = aplicar_alteracao_apelido(
        target_serial,
        apelido_restaurado,
        action="desfazer",
        reference_id=evento["id"],
    )
    return {
        "sucesso": True,
        "mensagem": "Apelido restaurado; a reversão foi registrada no histórico.",
        **resultado,
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
        wb = openpyxl.load_workbook(source_file)

        # Localiza a aba e as colunas pelos cabeçalhos.
        sheet_target = next((name for name in wb.sheetnames if "parque" in name.lower() or "equipamento" in name.lower()), wb.sheetnames[0])
        ws = wb[sheet_target]
        header_row = [cell.value for cell in next(ws.iter_rows(max_row=1))]
        col_map = {
            re.sub(r'[\s_\-]+', '', str(value)).lower(): index + 1
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

        apelidos_modificados = {
            normalize_reference_value(serial): alias
            for serial, alias in load_modified_apelidos().items()
        }
        total_alterados = 0

        # Só altera valores da coluna Apelido em linhas já existentes; nenhuma dimensão ou estilo é editado.
        for row in range(2, ws.max_row + 1):
            serial = ws.cell(row=row, column=serial_col).value
            if serial is None:
                continue

            serial_key = normalize_reference_value(serial)
            if serial_key in apelidos_modificados:
                ws.cell(row=row, column=apelido_col).value = apelidos_modificados[serial_key]
                total_alterados += 1

        buffer = io.BytesIO()
        wb.save(buffer)
        buffer.seek(0)

        now_str = datetime.now().strftime("%d-%m-%Y_%H%M%S")
        export_filename = f"EquipamentosDetalhes-{now_str}.xlsx"
        headers = {
            "Content-Disposition": f'attachment; filename="{export_filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition, X-Total-Alterados",
            "X-Total-Alterados": str(total_alterados)
        }

        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERRO] Falha ao exportar EquipamentosDetalhes: {e}")
        raise HTTPException(status_code=500, detail=f"Erro ao exportar EquipamentosDetalhes: {str(e)}")
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
    display_role = {"endpoint": "Endpoint", "detalhes": "EquipamentosDetalhes"}.get(role, role)
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
    """Valida e substitui Endpoint e EquipamentosDetalhes como uma única atualização."""
    uploads = [endpoint_file, details_file]
    staging_dir = INPUT_DIR / f".upload-staging-{uuid.uuid4().hex}"
    backup_dir = UPLOAD_BACKUPS_DIR / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"

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
        previous_aliases = {
            normalize_reference_value(serial): str(equipment.get("apelido") or "").strip()
            for serial, equipment in equipamentos_cache.items()
        }
        modified_aliases_before_update = load_modified_apelidos(strict=True)

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

        baseline_path = DETAILS_EXPORT_BASELINE_FILE

        unique_sources = []
        seen_source_paths = set()
        for source_path, role in old_sources:
            resolved_source = source_path.resolve()
            if source_path.is_file() and resolved_source not in seen_source_paths:
                unique_sources.append((source_path, role))
                seen_source_paths.add(resolved_source)

        backup_dir.mkdir(parents=True, exist_ok=False)
        backup_pairs = []
        for source_path, role in unique_sources:
            role_dir = backup_dir / role
            role_dir.mkdir(parents=True, exist_ok=True)
            backup_path = role_dir / source_path.name
            shutil.copy2(source_path, backup_path)
            backup_pairs.append((source_path, backup_path))

        try:
            for source_path, _ in unique_sources:
                source_path.unlink()

            for role, target_path in target_files.items():
                os.replace(stage_paths[role], target_path)

            shutil.copy2(DETAILS_UPLOAD_FILE, baseline_path)
            sync_uploaded_alias_changes(staged["detalhes"]["table"], previous_aliases)
            if not load_database():
                raise RuntimeError("O EquipamentosDetalhes enviado não pôde ser carregado pelo site.")
        except Exception as error:
            for target_path in [*target_files.values(), baseline_path]:
                try:
                    target_path.unlink(missing_ok=True)
                except OSError:
                    pass
            for source_path, backup_path in backup_pairs:
                source_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup_path, source_path)
            try:
                save_modified_apelidos(modified_aliases_before_update)
            except Exception as restore_error:
                print(f"[ERRO] Não foi possível restaurar os apelidos modificados após a falha no upload: {restore_error}")
            if backup_pairs:
                load_database()
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(
                status_code=500,
                detail=f"Não foi possível concluir a atualização; as planilhas anteriores foram restauradas. {error}",
            ) from error

        comparison["backup_criado"] = True
        comparison["backup_diretorio"] = str(backup_dir.relative_to(INPUT_DIR))
        comparison["arquivo_detalhes_ativo"] = DETAILS_UPLOAD_FILE.name
        comparison["total_equipamentos_carregados"] = stats_cache.get("total_equipamentos", 0)
        comparison["ultima_atualizacao"] = stats_cache.get("ultima_atualizacao", "")
        comparison["horario_comparacao"] = datetime.now().astimezone().isoformat(timespec="seconds")
        evento_historico = {
            "id": uuid.uuid4().hex,
            "horario": comparison["horario_comparacao"],
            "arquivos_enviados": comparison.get("arquivos_enviados", {}),
            "resumo": {
                "total_endpoint": comparison.get("total_endpoint", 0),
                "ausentes_em_detalhes": len(comparison.get("ausentes_em_detalhes", [])),
                "divergencias_local": len(comparison.get("divergencias_local", [])),
                "series_sem_mapeamento": len(comparison.get("series_sem_mapeamento", [])),
            },
            "comparacao": comparison,
        }
        try:
            append_comparison_history_entry(evento_historico)
            comparison["historico_salvo"] = True
        except Exception as history_error:
            print(f"[ERRO] Planilhas atualizadas, mas não foi possível registrar a comparação no histórico: {history_error}")
            comparison["historico_salvo"] = False
            comparison["aviso_historico"] = "Não foi possível salvar este resultado no histórico de comparações."
        return {
            "sucesso": True,
            "comparacao": comparison,
            "stats": stats_cache,
            "historico_salvo": comparison["historico_salvo"],
        }
    except HTTPException:
        raise
    except Exception as error:
        print(f"[ERRO] Falha ao atualizar o conjunto de planilhas: {error}")
        raise HTTPException(status_code=500, detail=f"Falha ao atualizar as planilhas: {error}") from error
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
                "retirada_cidade": item["retirada_cidade"]
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
        "total_apelidos_modificados": len(load_modified_apelidos())
    }


@app.post("/api/gerar-planilha")
def gerar_planilha(payload: TransferenciaPayload):
    """Gera a planilha oficial de transferência Simpress a partir do template com os dados preenchidos."""
    if not TEMPLATE_FILE.exists():
        raise HTTPException(status_code=500, detail=f"Arquivo de template '{TEMPLATE_FILE.name}' não encontrado no servidor.")

    try:
        wb = openpyxl.load_workbook(TEMPLATE_FILE)
        
        # Localiza a aba de 'Transferência'
        sheet_target = None
        for name in wb.sheetnames:
            if "transfer" in name.lower() and "lote" not in name.lower():
                sheet_target = name
                break
        if not sheet_target:
            sheet_target = wb.sheetnames[0]

        ws = wb[sheet_target]

        # Formatação de valores
        serial_val = payload.serial.strip().upper()
        descricao_val = payload.descricao_equipamento.strip() or f"Equipamento {serial_val}"
        retirada_obs_val = payload.retirada_obs.strip() or descricao_val

        # Contrato numérico se possível
        contrato_val: Any = payload.contrato
        try:
            contrato_val = int(contrato_val)
        except (ValueError, TypeError):
            pass

        # Preenchimento exato conforme células oficiais
        # Cabeçalho / Geral
        ws["B5"].value = payload.razao_social or "SERVICO DE APOIO AS MICRO E PEQUENAS EMPRESAS DO PARANA - SEBRAE/PR"
        ws["J5"].value = contrato_val
        ws["B8"].value = serial_val
        ws["F8"].value = descricao_val

        # Bloco de Retirada (Origem)
        ws["B17"].value = payload.retirada_cnpj
        ws["F17"].value = payload.retirada_endereco
        ws["B19"].value = payload.retirada_horario
        ws["F19"].value = payload.retirada_almoco
        ws["J19"].value = payload.retirada_pausa_duracao
        ws["B21"].value = payload.retirada_tipo_acesso
        ws["J21"].value = payload.retirada_acesso_obs
        ws["B23"].value = payload.retirada_contato
        ws["F23"].value = payload.retirada_email
        ws["J23"].value = payload.retirada_telefone
        ws["B25"].value = retirada_obs_val
        ws["J25"].value = payload.retirada_voltagem

        # Bloco de Entrega (Destino)
        ws["B29"].value = payload.entrega_cnpj
        ws["F29"].value = payload.entrega_endereco
        ws["B31"].value = payload.entrega_horario
        ws["F31"].value = payload.entrega_almoco
        ws["J31"].value = payload.entrega_pausa_duracao
        ws["B33"].value = payload.entrega_tipo_acesso
        ws["J33"].value = payload.entrega_acesso_obs
        ws["B35"].value = payload.entrega_contato
        ws["F35"].value = payload.entrega_email
        ws["J35"].value = payload.entrega_telefone
        ws["B37"].value = payload.entrega_obs
        ws["J37"].value = payload.entrega_voltagem

        # Salva em memória para download
        buffer = io.BytesIO()
        wb.save(buffer)
        buffer.seek(0)

        # Data para o nome do arquivo
        data_hoje = datetime.now().strftime("%Y%m%d")
        safe_serial = re.sub(r"[^\w\-]", "_", serial_val)
        filename = f"Transferencia_{safe_serial}_{data_hoje}.xlsx"

        headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition"
        }

        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers
        )

    except Exception as e:
        print(f"[ERRO] Falha ao gerar planilha: {e}")
        raise HTTPException(status_code=500, detail=f"Erro ao processar template Excel: {str(e)}")


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
