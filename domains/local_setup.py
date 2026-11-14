"""Validation for first-use imports, independent of application storage."""

import io
import json
import logging
import lzma
import os
import re
import threading
import unicodedata
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Mapping, Optional, Union

from openpyxl.cell.cell import MergedCell

from core.config import format_size_limit
from core.errors import DomainError, DomainValidationError
from core.integrity import atomic_write_json, load_workbook_safely
from core.openpyxl_compat import stored_cells


logger = logging.getLogger(__name__)


TRANSFER_CELLS = (
    "B5", "J5", "B8", "F8", "B17", "F17", "B19", "F19", "J19",
    "B21", "J21", "B23", "F23", "J23", "B25", "J25", "B29", "F29",
    "B31", "F31", "J31", "B33", "J33", "B35", "F35", "J35", "B37", "J37",
)


def unpack_simpress_zip(data: bytes, limit: int) -> tuple[bytes, str]:
    """Read one bounded XLSX member without extracting anything to disk."""
    size_label = format_size_limit(limit)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            if len(members) > 1000 or sum(item.file_size for item in members) > 2 * limit:
                raise DomainValidationError("O ZIP excede os limites de descompactação.", status_code=413)
            candidates = []
            for item in members:
                name = item.filename.replace("\\", "/")
                path = PurePosixPath(name)
                if path.is_absolute() or ".." in path.parts or ":" in name or "\x00" in name:
                    raise DomainValidationError("O ZIP contém um caminho inválido.")
                if item.flag_bits & 1:
                    raise DomainValidationError("Envie um ZIP sem senha.")
                if item.is_dir():
                    continue
                if item.file_size > limit:
                    raise DomainValidationError(f"Um arquivo no ZIP excede o limite de {size_label}.", status_code=413)
                if path.suffix.lower() == ".xlsx" and not path.name.startswith("~$"):
                    candidates.append(item)
            if len(candidates) != 1:
                raise DomainValidationError("O ZIP da Simpress precisa conter exatamente uma planilha .xlsx.")
            member = candidates[0]
            with archive.open(member) as stream:
                workbook = stream.read(limit + 1)
            if len(workbook) > limit:
                raise DomainValidationError(f"A planilha descompactada excede o limite de {size_label}.", status_code=413)
            if not workbook:
                raise DomainValidationError("A planilha dentro do ZIP está vazia.")
            return workbook, member.filename
    except DomainError:
        raise
    except (OSError, ValueError, RuntimeError, NotImplementedError, zipfile.BadZipFile, zlib.error, lzma.LZMAError) as error:
        raise DomainValidationError("Não foi possível ler o ZIP da Simpress.") from error


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    return re.sub(r"[^A-Z0-9]", "", text.encode("ascii", "ignore").decode().upper())


def validate_local_model(source: Union[Path, BinaryIO], kind: str) -> None:
    """Use the same selected sheet and writable fields as the generators."""
    wb = load_workbook_safely(
        source, allow_threaded_comments=True,
        allow_legacy_comments=kind == "transferencia",
        allow_custom_xml_passthrough=kind == "transferencia",
    )
    try:
        if kind == "transferencia":
            name = next((name for name in wb.sheetnames if "transfer" in name.lower()
                         and "lote" not in name.lower()), wb.sheetnames[0])
            ws = wb[name]
            stored_addresses = {cell.coordinate for cell in stored_cells(ws)}
            for address, expected in (("B2", "TRANSFERENCIADEEQUIPAMENTO"),
                                      ("B15", "DADOSDERETIRADA"), ("B27", "DADOSDEENTREGA")):
                if _normalize(ws[address].value) != expected:
                    raise ValueError("O modelo precisa usar o layout oficial de transferência da Simpress.")
            if any(isinstance(ws[address], MergedCell) for address in TRANSFER_CELLS):
                raise ValueError("O modelo contém campos de transferência que não podem ser preenchidos.")
            if not set(TRANSFER_CELLS).issubset(stored_addresses):
                raise ValueError("O modelo não contém todas as células de preenchimento da transferência.")
        elif kind == "exportacao":
            name = next((name for name in wb.sheetnames if "parque" in name.lower()
                         or "equipamento" in name.lower()), wb.sheetnames[0])
            ws = wb[name]
            stored_addresses = {cell.coordinate for cell in stored_cells(ws)}
            headers = [_normalize(cell.value) for cell in next(ws.iter_rows(max_row=1), ())]
            serial_columns = [index for index, header in enumerate(headers)
                              if header in {"NUMEROSERIE", "NUMERODESERIE", "SERIAL"}]
            if len(serial_columns) != 1 or headers.count("APELIDO") != 1:
                raise ValueError("O modelo de exportação precisa ter colunas únicas de número de série e apelido.")
            serial_col = serial_columns[0]
            alias_col = headers.index("APELIDO")
            id_col = headers.index("IDCLIENTE") if "IDCLIENTE" in headers else None
            has_equipment = False
            for row in ws.iter_rows(min_row=2):
                if not _normalize(row[serial_col].value):
                    continue
                has_equipment = True
                for column in (alias_col, id_col):
                    if column is None:
                        continue
                    cell = row[column]
                    if isinstance(cell, MergedCell) or cell.coordinate not in stored_addresses:
                        raise ValueError("O modelo de exportação contém campos ausentes ou mesclados que não podem ser preenchidos.")
            if not has_equipment:
                raise ValueError("O modelo de exportação não contém equipamentos.")
        else:
            raise ValueError("Tipo de modelo inválido.")
    finally:
        wb.close()


# Payload field, environment variable, key in config/contato_origem.json and length limit.
ORIGIN_CONTACT_FIELDS = (
    ("retirada_contato", "SIMPRESS_TRANSFER_ORIGIN_CONTACT", "contato", 160),
    ("retirada_email", "SIMPRESS_TRANSFER_ORIGIN_EMAIL", "email", 254),
    ("retirada_telefone", "SIMPRESS_TRANSFER_ORIGIN_PHONE", "telefone", 64),
)


def _read_origin_contact_file(path: Path, label: str = "contato de origem") -> tuple[dict, bool]:
    """Return the stored values and whether the file exists but could not be used."""
    try:
        stored = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {}, False
    except (OSError, ValueError):
        logger.warning("Arquivo de %s ilegível; os campos ficam vazios.", label)
        return {}, True
    if not isinstance(stored, dict):
        logger.warning("Arquivo de %s sem objeto JSON; os campos ficam vazios.", label)
        return {}, True
    return stored, False


def load_origin_contact(path: Path, environment: Optional[Mapping[str, str]] = None) -> dict:
    """Resolve each origin contact field: environment variable, then local file, then empty."""
    env = os.environ if environment is None else environment
    stored, invalid_file = _read_origin_contact_file(path)
    values, sources = {}, {}
    for field, variable, key, limit in ORIGIN_CONTACT_FIELDS:
        from_env = str(env.get(variable) or "").strip()
        from_file = stored.get(key)
        from_file = from_file.strip() if isinstance(from_file, str) else ""
        if from_env:
            values[field], sources[field] = from_env[:limit], "ambiente"
        elif from_file:
            values[field], sources[field] = from_file[:limit], "arquivo"
        else:
            values[field], sources[field] = "", ""
    return {
        **values,
        "contato_origem_configurado": all(values.values()),
        "contato_origem_fontes": sources,
        "contato_origem_arquivo_invalido": invalid_file,
    }


def save_origin_contact(path: Path, contato: str, email: str, telefone: str) -> None:
    """Write the already validated contact to the git-ignored local file."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(target, {"contato": contato, "email": email, "telefone": telefone})


# Client data (config/cliente.json): contract, billing CNPJ and own notebook series. Environment variable, then file.
CLIENT_CONFIG_FIELDS = (
    ("contrato", "SIMPRESS_CLIENTE_CONTRATO"),
    ("cnpj_faturamento", "SIMPRESS_CLIENTE_CNPJ_FATURAMENTO"),
)
CLIENT_SERIES_VARIABLE = "SIMPRESS_CLIENTE_SERIES_SEBRAE_FORA"


def load_client_config(path: Path, environment: Optional[Mapping[str, str]] = None) -> dict:
    """Resolve the client data: environment variable, then local file, then empty. Never invents a value."""
    env = os.environ if environment is None else environment
    stored, invalid_file = _read_origin_contact_file(path, "dados do cliente")
    values, sources = {}, {}
    for key, variable in CLIENT_CONFIG_FIELDS:
        from_env = str(env.get(variable) or "").strip()
        from_file = stored.get(key)
        from_file = from_file.strip() if isinstance(from_file, str) else ""
        if from_env:
            values[key], sources[key] = from_env, "ambiente"
        elif from_file:
            values[key], sources[key] = from_file, "arquivo"
        else:
            values[key], sources[key] = "", ""
    series_env = str(env.get(CLIENT_SERIES_VARIABLE) or "").strip()
    series_file = stored.get("series_sebrae_fora")
    if series_env:
        series, series_source = [item.strip() for item in series_env.split(",") if item.strip()], "ambiente"
    elif isinstance(series_file, list):
        series, series_source = [str(item).strip() for item in series_file if str(item).strip()], "arquivo"
    else:
        series, series_source = [], ""
    sources["series_sebrae_fora"] = series_source
    return {
        **values,
        "series_sebrae_fora": series,
        "cliente_configurado": all(values.values()),
        "cliente_fontes": sources,
        "cliente_arquivo_invalido": invalid_file,
    }


def save_client_config(
    path: Path, contrato: Optional[str], cnpj_faturamento: Optional[str], series: Optional[list] = None
) -> None:
    """Write the already validated client data to the git-ignored file; a None field keeps the stored value."""
    target = Path(path)
    stored, _ = _read_origin_contact_file(target, "dados do cliente")
    if contrato is None:
        contrato = str(stored.get("contrato") or "")
    if cnpj_faturamento is None:
        cnpj_faturamento = str(stored.get("cnpj_faturamento") or "")
    if series is None:
        kept = stored.get("series_sebrae_fora")
        series = [str(item) for item in kept] if isinstance(kept, list) else []
    target.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(target, {"contrato": contrato, "cnpj_faturamento": cnpj_faturamento, "series_sebrae_fora": series})


# The 22 regional representatives of SEBRAE/PR (Transferência screen). The front end loads the effective defaults from
# GET /api/config/representantes-regionais (`padroes`); the git-ignored config/representantes_regionais.json keeps only
# per-city overrides. Name, e-mail and phone are personal data: the code keeps them blank and they come from the
# git-ignored data/state/representantes_regionais_padrao.json (example: config/representantes_regionais_padrao.exemplo.json).
REGIONAL_REPRESENTATIVE_CITIES = (
    "Cascavel", "Londrina", "Maringá", "Pato Branco", "Ponta Grossa", "Foz do Iguaçu", "Paranaguá",
    "Toledo", "Guarapuava", "Porecatu", "Irati", "Cornélio Procópio", "Apucarana", "Arapongas",
    "Cerro Azul", "Cianorte", "Francisco Beltrão", "Ivaiporã", "Jacarezinho", "Laranjeiras do Sul",
    "Paranavaí", "Campo Mourão",
)
# Defaults of each city in the code (hours only; the local defaults file and the saved overrides win over them).
REGIONAL_REPRESENTATIVE_FIELDS = ("nome", "email", "telefone", "horario", "almoco", "pausaDuracao")
REGIONAL_REPRESENTATIVE_DEFAULTS = {
    city: {"nome": "", "email": "", "telefone": "", "horario": hours, "almoco": lunch, "pausaDuracao": pause}
    for city, hours, lunch, pause in (
        ("Cascavel", "08:00:00 às 18:00:00", "Escritório não fecha", ""),
        ("Londrina", "08:00:00 às 18:00:00", "Escritório não fecha", ""),
        ("Maringá", "08:00:00 às 18:00:00", "Escritório não fecha", ""),
        ("Pato Branco", "08:00:00 às 17:00:00", "12:00:00", "1h30"),
        ("Ponta Grossa", "08:00:00 às 18:00:00", "Escritório não fecha", ""),
        ("Foz do Iguaçu", "08:00:00 às 17:00:00", "12:00:00", "1h30"),
        ("Paranaguá", "08:30:00 às 17:30:00", "12:00:00", "1h"),
        ("Toledo", "08:00:00 às 18:00:00", "12:00:00", "1h30"),
        ("Guarapuava", "08:00:00 às 18:00:00", "12:00:00", "2h"),
        ("Porecatu", "08:00:00 às 17:00:00", "12:00:00", "2h"),
        ("Irati", "08:00:00 às 18:00:00", "12:00:00", "2h"),
        ("Cornélio Procópio", "08:00:00 às 17:30:00", "12:00:00", "1h30"),
        ("Apucarana", "08:00:00 às 18:00:00", "12:00:00", "2h"),
        ("Arapongas", "08:00:00 às 18:00:00", "12:00:00", "2h"),
        ("Cerro Azul", "08:00:00 às 17:00:00", "12:00:00", "1h"),
        ("Cianorte", "08:00:00 às 17:00:00", "12:00:00", "2h"),
        ("Francisco Beltrão", "08:00:00 às 18:00:00", "12:00:00", "1h30"),
        ("Ivaiporã", "08:00:00 às 18:00:00", "12:00:00", "2h"),
        ("Jacarezinho", "08:00:00 às 18:00:00", "12:00:00", "2h"),
        ("Laranjeiras do Sul", "08:00:00 às 18:00:00", "12:00:00", "2h"),
        ("Paranavaí", "08:00:00 às 18:00:00", "12:00:00", "2h"),
        ("Campo Mourão", "08:00:00 às 18:00:00", "12:00:00", "2h"),
    )
}
# Option text the selectors show while a city's effective default name is empty (display only, not an editable field).
REGIONAL_REPRESENTATIVE_EMPTY_NAME_OPTION = "Não definido ainda"
_regional_representatives_lock = threading.Lock()


def load_regional_representative_defaults(path: Optional[Path]) -> tuple[dict, bool]:
    """Return the local defaults by city (only known cities and fields) and whether the file exists but could not be used.

    A None path means "no local file": the defaults stay the ones in the code, so tests do not depend on the machine.
    """
    if path is None:
        return {}, False
    stored, invalid_file = _read_origin_contact_file(path, "padrões dos representantes regionais")
    return {
        city: {field: value for field, value in values.items()
               if field in REGIONAL_REPRESENTATIVE_FIELDS and isinstance(value, str)}
        for city, values in stored.items() if city in REGIONAL_REPRESENTATIVE_CITIES and isinstance(values, dict)
    }, invalid_file


def effective_regional_representative_defaults(path: Optional[Path] = None) -> tuple[dict, bool]:
    """Return the default of every city (code merged with the local defaults file) and the invalid-file flag."""
    local, invalid_file = load_regional_representative_defaults(path)
    return {city: {**REGIONAL_REPRESENTATIVE_DEFAULTS[city], **local.get(city, {})}
            for city in REGIONAL_REPRESENTATIVE_CITIES}, invalid_file


def regional_representative_defaults(effective: Optional[Mapping[str, Mapping[str, str]]] = None) -> list[dict]:
    """The defaults in display order: city, the six fields and, for an empty name, `nomeOpcao` (text for that name).

    `effective` is the result of `effective_regional_representative_defaults`; None means the code defaults alone.
    """
    effective = REGIONAL_REPRESENTATIVE_DEFAULTS if effective is None else effective
    return [
        {"cidade": city, **effective[city],
         **({} if effective[city]["nome"] else {"nomeOpcao": REGIONAL_REPRESENTATIVE_EMPTY_NAME_OPTION})}
        for city in REGIONAL_REPRESENTATIVE_CITIES
    ]


def load_regional_representatives(path: Path) -> tuple[dict, bool]:
    """Return the saved overrides by city and whether the file exists but could not be used."""
    stored, invalid_file = _read_origin_contact_file(path, "representantes regionais")
    return {c: v for c, v in stored.items() if c in REGIONAL_REPRESENTATIVE_CITIES and isinstance(v, dict)}, invalid_file


def save_regional_representative(path: Path, city: str, values: dict, defaults_path: Optional[Path] = None) -> None:
    """Write the already validated override for one city, keeping the others.

    Only the fields that differ from the effective default (code plus local defaults file) are stored; when none differs
    the city is dropped (same as "Restaurar padrão"), so a default changed later reaches every city not edited on that field.
    """
    target = Path(path)
    default = effective_regional_representative_defaults(defaults_path)[0][city]
    changed = {f: values[f] for f in REGIONAL_REPRESENTATIVE_FIELDS if f in values and values[f] != default[f]}
    with _regional_representatives_lock:
        current, _ = load_regional_representatives(target)
        if changed:
            current[city] = changed
        elif city in current:
            del current[city]
        else:
            return  # nothing differs and nothing was saved: leave the file (or its absence) alone
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(target, current)


def remove_regional_representative(path: Path, city: str) -> bool:
    """Drop the override of one city (back to the default); False when none was saved."""
    target = Path(path)
    with _regional_representatives_lock:
        current, _ = load_regional_representatives(target)
        if city not in current:
            return False
        del current[city]
        atomic_write_json(target, current)
        return True
