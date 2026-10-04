"""Bound XLSX package and worksheet dimensions before workbook parsing."""

from __future__ import annotations

import posixpath
import re
import threading
import zipfile
from pathlib import Path
from typing import BinaryIO, Union
from xml.parsers import expat

from app_config import (
    MAX_XLSX_ARCHIVE_ENTRIES,
    MAX_XLSX_CONTROL_XML_BYTES,
    MAX_XLSX_TOTAL_CELLS,
    MAX_XLSX_TOTAL_MERGED_CELLS,
    MAX_XLSX_UNCOMPRESSED_BYTES,
    MAX_XLSX_WORKSHEETS,
    MAX_XLSX_WORKSHEET_COLUMNS,
    MAX_XLSX_WORKSHEET_ROWS,
)


class XlsxPackageError(ValueError):
    """The ZIP package or its workbook XML is malformed."""


class XlsxLimitExceeded(XlsxPackageError):
    """The XLSX package exceeds a configured processing limit."""


_CELL_REFERENCE = re.compile(r"^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$")
_PATH_CACHE_LOCK = threading.Lock()
_VALIDATED_PATHS: dict[tuple[str, int, int, int], None] = {}


def _local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _parse_cell_reference(reference: str) -> tuple[int, int]:
    match = _CELL_REFERENCE.fullmatch(reference)
    if not match:
        raise XlsxPackageError("A planilha contém uma referência de célula inválida.")

    column = 0
    for character in match.group(1).upper():
        column = column * 26 + ord(character) - ord("A") + 1
    row = int(match.group(2))
    if column > 16_384 or row > 1_048_576:
        raise XlsxPackageError("A planilha contém uma referência fora dos limites do Excel.")
    return row, column


def _parse_dimension(reference: str) -> tuple[int, int]:
    pieces = reference.split(":")
    if len(pieces) not in (1, 2):
        raise XlsxPackageError("A planilha contém uma dimensão inválida.")
    coordinates = [_parse_cell_reference(piece) for piece in pieces]
    return max(row for row, _ in coordinates), max(column for _, column in coordinates)


def _parse_control_xml(archive: zipfile.ZipFile, name: str, on_start) -> None:
    parser = expat.ParserCreate()
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)

    def reject_doctype(*_args: object) -> None:
        raise XlsxPackageError("A planilha contém declarações XML não permitidas.")

    parser.StartDoctypeDeclHandler = reject_doctype
    parser.EntityDeclHandler = reject_doctype
    parser.StartElementHandler = lambda tag, attributes: on_start(_local_name(tag), attributes)
    try:
        with archive.open(name) as stream:
            parser.ParseFile(stream)
    except XlsxPackageError:
        raise
    except (expat.ExpatError, OSError, EOFError, zipfile.BadZipFile) as error:
        raise XlsxPackageError("O arquivo contém metadados XLSX inválidos.") from error


def _worksheet_parts(archive: zipfile.ZipFile, names: set[str]) -> list[str]:
    workbook_name = "xl/workbook.xml"
    relationships_name = "xl/_rels/workbook.xml.rels"
    if workbook_name not in names or relationships_name not in names:
        raise XlsxPackageError("O arquivo não contém a estrutura de abas esperada do XLSX.")

    for name in (workbook_name, relationships_name):
        info = archive.getinfo(name)
        if info.file_size > MAX_XLSX_CONTROL_XML_BYTES:
            raise XlsxLimitExceeded("A descrição das abas da planilha excede o limite permitido.")

    relationships = {}

    def collect_relationship(tag: str, attributes: dict[str, str]) -> None:
        if tag != "Relationship":
            return
        relationship_id = attributes.get("Id")
        relation_type = attributes.get("Type", "")
        target = attributes.get("Target")
        target_mode = attributes.get("TargetMode", "")
        if not relationship_id or not relation_type or not target:
            raise XlsxPackageError("O arquivo contém uma relação de planilha incompleta.")
        if relationship_id in relationships:
            raise XlsxPackageError("O arquivo contém uma identificação de relação duplicada.")
        if len(relationships) >= MAX_XLSX_ARCHIVE_ENTRIES:
            raise XlsxLimitExceeded("O arquivo contém relações demais para validar com segurança.")
        if target_mode.lower() == "external":
            relationships[relationship_id] = (relation_type, None)
            return
        normalized_target = (
            target.lstrip("/")
            if target.startswith("/")
            else posixpath.normpath(posixpath.join("xl", target))
        )
        if normalized_target.startswith("../") or normalized_target == "..":
            raise XlsxPackageError("O arquivo contém uma relação de planilha inválida.")
        relationships[relationship_id] = (relation_type, normalized_target)

    _parse_control_xml(archive, relationships_name, collect_relationship)
    sheet_ids = []

    def collect_sheet(tag: str, attributes: dict[str, str]) -> None:
        if tag != "sheet":
            return
        sheet_ids.append(next(
            (value for key, value in attributes.items() if _local_name(key) == "id"),
            None,
        ))
        if len(sheet_ids) > MAX_XLSX_WORKSHEETS:
            raise XlsxLimitExceeded("A quantidade de abas excede o limite permitido.")

    _parse_control_xml(archive, workbook_name, collect_sheet)
    if not sheet_ids:
        raise XlsxPackageError("O arquivo não contém uma aba de planilha legível.")

    worksheet_names = []
    for relation_id in sheet_ids:
        relation = relationships.get(relation_id)
        if relation is None:
            raise XlsxPackageError("Uma aba não tem uma relação XLSX válida.")
        relation_type, target = relation
        if relation_type.rstrip("/").endswith("/worksheet"):
            if target is None or target not in names or not target.startswith("xl/worksheets/"):
                raise XlsxPackageError("Uma aba de planilha aponta para um arquivo inválido.")
            worksheet_names.append(target)

    if len(worksheet_names) != len(set(worksheet_names)):
        raise XlsxPackageError("O arquivo referencia uma mesma aba mais de uma vez.")
    if not worksheet_names:
        raise XlsxPackageError("O arquivo não contém uma aba de planilha legível.")
    return worksheet_names


def _scan_worksheet(archive: zipfile.ZipFile, name: str) -> tuple[int, int]:
    max_row = 0
    max_column = 0
    current_row = 0
    current_column = 0
    merged_area = 0

    def add_bounds(row: int, column: int = 1) -> None:
        nonlocal max_row, max_column
        max_row = max(max_row, row)
        max_column = max(max_column, column)
        if max_row > MAX_XLSX_WORKSHEET_ROWS:
            raise XlsxLimitExceeded("Uma aba excede o limite de linhas permitido.")
        if max_column > MAX_XLSX_WORKSHEET_COLUMNS:
            raise XlsxLimitExceeded("Uma aba excede o limite de colunas permitido.")
        if max_row * max_column > MAX_XLSX_TOTAL_CELLS:
            raise XlsxLimitExceeded("A área de dados da planilha excede o limite permitido.")

    parser = expat.ParserCreate()
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)

    def reject_doctype(*_args: object) -> None:
        raise XlsxPackageError("O arquivo contém declarações XML não permitidas.")

    parser.StartDoctypeDeclHandler = reject_doctype
    parser.EntityDeclHandler = reject_doctype

    def start_element(tag: str, attributes: dict[str, str]) -> None:
        nonlocal current_row, current_column, merged_area
        local_tag = _local_name(tag)
        if local_tag == "dimension":
            reference = attributes.get("ref")
            if reference:
                row, column = _parse_dimension(reference)
                add_bounds(row, column)
        elif local_tag == "row":
            row_reference = attributes.get("r")
            if row_reference is not None:
                try:
                    current_row = int(row_reference)
                except ValueError as error:
                    raise XlsxPackageError("A planilha contém uma linha inválida.") from error
            else:
                current_row += 1
            current_column = 0
            if current_row < 1 or current_row > 1_048_576:
                raise XlsxPackageError("A planilha contém uma linha fora dos limites do Excel.")
            add_bounds(current_row)
        elif local_tag == "c":
            reference = attributes.get("r")
            if reference:
                row, column = _parse_cell_reference(reference)
                current_column = column
            else:
                if current_row < 1:
                    raise XlsxPackageError("A planilha contém uma célula fora de uma linha válida.")
                current_column += 1
                row, column = current_row, current_column
            add_bounds(row, column)
        elif local_tag == "mergeCell":
            reference = attributes.get("ref")
            if not reference:
                raise XlsxPackageError("A planilha contém uma mesclagem sem intervalo válido.")
            pieces = reference.split(":")
            if len(pieces) not in (1, 2):
                raise XlsxPackageError("A planilha contém um intervalo de mesclagem inválido.")
            coordinates = [_parse_cell_reference(piece) for piece in pieces]
            first_row = min(row for row, _ in coordinates)
            last_row = max(row for row, _ in coordinates)
            first_column = min(column for _, column in coordinates)
            last_column = max(column for _, column in coordinates)
            merged_area += (last_row - first_row + 1) * (last_column - first_column + 1)
            if merged_area > MAX_XLSX_TOTAL_MERGED_CELLS:
                raise XlsxLimitExceeded("As áreas mescladas da planilha excedem o limite permitido.")
            add_bounds(last_row, last_column)

    parser.StartElementHandler = start_element
    try:
        with archive.open(name) as stream:
            parser.ParseFile(stream)
    except XlsxPackageError:
        raise
    except (expat.ExpatError, OSError, EOFError, zipfile.BadZipFile) as error:
        raise XlsxPackageError("Uma aba contém XML inválido ou incompleto.") from error
    return max_row, max_column


def validate_xlsx_archive(archive: zipfile.ZipFile) -> None:
    """Validate ZIP structure and worksheet extents without materializing cell values."""
    entries = archive.infolist()
    if not entries or len(entries) > MAX_XLSX_ARCHIVE_ENTRIES:
        raise XlsxPackageError("O arquivo XLSX tem uma estrutura ZIP inválida ou grande demais.")
    if len({entry.filename for entry in entries}) != len(entries):
        raise XlsxPackageError("O arquivo XLSX contém nomes de partes duplicados.")
    if sum(entry.file_size for entry in entries) > MAX_XLSX_UNCOMPRESSED_BYTES:
        raise XlsxLimitExceeded("O conteúdo descompactado da planilha excede o limite permitido.")

    names = {entry.filename for entry in entries}
    if "[Content_Types].xml" not in names:
        raise XlsxPackageError("O arquivo enviado não é uma planilha .xlsx válida.")

    worksheet_names = _worksheet_parts(archive, names)
    total_cells = 0
    for worksheet_name in worksheet_names:
        max_row, max_column = _scan_worksheet(archive, worksheet_name)
        total_cells += max_row * max_column
        if total_cells > MAX_XLSX_TOTAL_CELLS:
            raise XlsxLimitExceeded("A área total das abas excede o limite permitido.")


def validate_xlsx(source: Union[bytes, bytearray, Path, str, BinaryIO]) -> None:
    """Validate bytes or a local file path before passing it to openpyxl/pandas."""
    if isinstance(source, (bytes, bytearray)):
        from io import BytesIO

        package_source: Union[Path, BinaryIO] = BytesIO(source)
    elif isinstance(source, (str, Path)):
        path = Path(source)
        try:
            file_stat = path.stat()
        except OSError as error:
            raise XlsxPackageError("O arquivo XLSX não está disponível.") from error
        cache_key = (
            str(path.resolve(strict=False)),
            file_stat.st_size,
            file_stat.st_mtime_ns,
            file_stat.st_ctime_ns,
        )
        with _PATH_CACHE_LOCK:
            if cache_key in _VALIDATED_PATHS:
                return
        package_source = path
    else:
        package_source = source
    try:
        with zipfile.ZipFile(package_source) as archive:
            validate_xlsx_archive(archive)
        if isinstance(source, (str, Path)):
            current_stat = Path(source).stat()
            current_key = (
                str(Path(source).resolve(strict=False)),
                current_stat.st_size,
                current_stat.st_mtime_ns,
                current_stat.st_ctime_ns,
            )
            if current_key != cache_key:
                raise XlsxPackageError("O arquivo XLSX mudou durante a validação.")
            with _PATH_CACHE_LOCK:
                _VALIDATED_PATHS[cache_key] = None
                while len(_VALIDATED_PATHS) > 256:
                    _VALIDATED_PATHS.pop(next(iter(_VALIDATED_PATHS)))
    except XlsxPackageError:
        raise
    except (OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        raise XlsxPackageError("O arquivo enviado não é uma planilha .xlsx válida.") from error
