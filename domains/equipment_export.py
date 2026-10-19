"""Equipment export: fill the fixed export model with the active inventory's aliases and IdCliente.

The export model (``modelos/EquipamentosDetalhes-exportacao.xlsx``) defines the
format and rows; the values come from the active EquipamentosDetalhes, the
Endpoint hostnames and the manual aliases. ``count_export_changes`` keeps the
last count per file signature and records whether exporting is currently
possible (``get_export_status``).

``main.py`` wires the file locations and readers in ``EquipmentExportServices``
with late-bound callables, so tests that patch ``main`` keep affecting the
export. Errors are domain errors; ``external_errors`` lists the exception types
raised by those callbacks that must pass through unchanged.
"""

import json
import logging
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, ContextManager, Dict, List, Optional, Tuple, Type
from urllib.parse import quote

import openpyxl

from core.errors import DomainConflictError, DomainError
from core.integrity import (
    FileBusyError,
    FileTransactionError,
    WorkbookSafetyError,
    load_workbook_safely,
    serialize_workbook_validated,
    workbook_snapshot,
)
from core.xlsx_safety import WORKBOOK_READ_ERRORS
from domains.effective_alias import endpoint_alias_review_items, merge_export_aliases
from domains.inventory_comparison import normalize_reference_value
from domains.uploaded_workbooks import (
    DETAILS_ALIAS_HEADER_ALIASES,
    DETAILS_SERIAL_HEADER_ALIASES,
    find_workbook_header_column,
)


XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@dataclass(frozen=True)
class EquipmentExportServices:
    export_model_file: Callable[[], Path]
    endpoint_upload_file: Callable[[], Path]
    modified_aliases_file: Callable[[], Path]
    transaction_root: Callable[[], Path]
    read_lock_timeout: Callable[[], float]
    get_parque_file: Callable[[], Optional[Path]]
    get_details_files: Callable[[], List[Path]]
    find_details_sheet: Callable[[Path], Optional[str]]
    read_endpoint_alias_index: Callable[[], Dict[str, Any]]
    load_modified_apelidos: Callable[[], Dict[str, str]]
    latest_comparison_update_entry: Callable[[], Optional[Dict[str, Any]]]
    validate_xlsx: Callable[[Path], Any]
    lock_paths: Callable[..., ContextManager[Any]]
    logger: logging.Logger
    external_errors: Tuple[Type[BaseException], ...] = ()
    # Hostnames the user discarded from the Endpoint duplicates; they decide which one is exported.
    removed_hostnames_file: Optional[Callable[[], Path]] = None


def _removed_hostnames_paths(services: EquipmentExportServices) -> List[Path]:
    return [services.removed_hostnames_file()] if services.removed_hostnames_file is not None else []


@dataclass(frozen=True)
class EquipmentExport:
    """The exported workbook and the response headers that describe it."""

    content: bytes
    headers: Dict[str, str]


def load_export_model_aliases(services: EquipmentExportServices) -> Dict[str, str]:
    """Lê os apelidos do modelo fixo usado como base de exportação."""
    if not services.export_model_file().is_file():
        raise DomainError(f"O modelo de exportação '{services.export_model_file().name}' não foi encontrado.", status_code=404)

    workbook = None
    try:
        services.validate_xlsx(services.export_model_file())
        workbook = openpyxl.load_workbook(services.export_model_file(), read_only=True, data_only=True)
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

        raise DomainError(f"O modelo '{services.export_model_file().name}' não contém as colunas NumeroSerie e Apelido.")
    except DomainError:
        raise
    except WORKBOOK_READ_ERRORS as error:
        services.logger.warning(
            "Falha ao ler modelo (arquivo=%s, papel=exportacao, erro=%s).",
            services.export_model_file().name, type(error).__name__,
        )
        raise DomainError("Não foi possível ler o modelo de exportação.") from None
    finally:
        if workbook is not None:
            workbook.close()


def get_export_aliases(
    services: EquipmentExportServices,
    endpoint_index: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """Combina hostnames da InvAll com apelidos manuais, que têm prioridade."""
    endpoint_aliases = (
        endpoint_index.get("unique", {})
        if endpoint_index is not None
        else services.read_endpoint_alias_index()["unique"]
    )
    return merge_export_aliases(endpoint_aliases, services.load_modified_apelidos())


@dataclass(frozen=True)
class ExportStatus:
    """Whether the export can run, with the reason shown when it cannot."""

    available: bool
    reason: str

    def as_dict(self) -> Dict[str, Any]:
        return {"available": self.available, "reason": self.reason}


@dataclass(frozen=True)
class CachedExportCounts:
    """Counts and status computed for one signature of the export files."""

    counts: Dict[str, int]
    status: ExportStatus


_EXPORT_STATUS_LOCK = threading.Lock()
_EXPORT_COUNTS_LOCK = threading.Lock()
_export_status = ExportStatus(available=False, reason="A exportação ainda não foi conferida.")
_EXPORT_COUNTS_CACHE: Dict[Any, CachedExportCounts] = {}


def _set_export_status(available: bool, reason: str) -> None:
    global _export_status
    with _EXPORT_STATUS_LOCK:
        _export_status = ExportStatus(available=available, reason=reason)


def _current_export_status() -> ExportStatus:
    with _EXPORT_STATUS_LOCK:
        return _export_status


def get_export_status() -> Dict[str, Any]:
    return _current_export_status().as_dict()


def export_files_signature(services: EquipmentExportServices) -> tuple:
    signature: List[Any] = []
    try:
        active_file = services.get_parque_file()
    except FileBusyError:
        active_file = None
    for path in (
        active_file,
        services.export_model_file(),
        services.endpoint_upload_file(),
        services.modified_aliases_file(),
        *_removed_hostnames_paths(services),
    ):
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
    services: EquipmentExportServices,
    locked: bool = False,
    endpoint_index: Optional[Dict[str, Any]] = None,
) -> Dict[str, int]:
    """Count writable alias and IdCliente cells that export would change."""
    empty_counts = {"apelidos": 0, "id_clientes": 0, "total": 0}

    def count() -> Dict[str, int]:
        source_file = services.get_parque_file()
        if source_file is None or not source_file.is_file() or not services.export_model_file().is_file():
            _set_export_status(False, "A base ativa ou o modelo de exportação está ausente.")
            return empty_counts.copy()

        model_wb = None
        current_wb = None
        try:
            services.validate_xlsx(services.export_model_file())
            model_wb = openpyxl.load_workbook(services.export_model_file(), read_only=True, data_only=False)
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

            current_sheet_name = services.find_details_sheet(source_file)
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

            effective_endpoint_index = endpoint_index if endpoint_index is not None else services.read_endpoint_alias_index()
            aliases = get_export_aliases(services, effective_endpoint_index)
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
            services.logger.warning("Contagem de exportação indisponível (%s).", type(error).__name__)
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
        key = export_files_signature(services)
        with _EXPORT_COUNTS_LOCK:
            cached = _EXPORT_COUNTS_CACHE.get(key)
            if cached is not None:
                _set_export_status(cached.status.available, cached.status.reason)
                return {name: cached.counts[name] for name in empty_counts}
        values = count()
        status = _current_export_status()
        with _EXPORT_COUNTS_LOCK:
            _EXPORT_COUNTS_CACHE.clear()
            _EXPORT_COUNTS_CACHE[key] = CachedExportCounts(counts=dict(values), status=status)
        return values

    if locked:
        return count_with_cache()
    with services.lock_paths([services.transaction_root() / ".atomic-transactions"], timeout=services.read_lock_timeout()):
        detail_files = services.get_details_files()
        with services.lock_paths([
            *detail_files,
            services.endpoint_upload_file(),
            services.modified_aliases_file(),
            *_removed_hostnames_paths(services),
            services.export_model_file(),
        ], timeout=services.read_lock_timeout()):
            return count_with_cache()


def build_equipment_export(services: EquipmentExportServices) -> EquipmentExport:
    """Exporta a apresentação de referência com os registros da base ativa."""
    source_file = services.export_model_file()
    current_file = services.get_parque_file()
    if not source_file.is_file():
        raise DomainError(f"O modelo de exportação '{source_file.name}' não foi encontrado.", status_code=404)
    if current_file is None or not current_file.is_file():
        raise DomainError("A base atual da Simpress não foi encontrada.", status_code=404)

    wb = None
    current_wb = None
    passthrough_errors: Tuple[Type[BaseException], ...] = (DomainError, *services.external_errors)
    try:
        with services.lock_paths([
            source_file,
            current_file,
            services.endpoint_upload_file(),
            services.modified_aliases_file(),
            *_removed_hostnames_paths(services),
        ]):
            services.validate_xlsx(source_file)
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
                raise DomainError(f"A planilha '{source_file.name}' não contém as colunas NumeroSerie e Apelido esperadas.")
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

            current_sheet_name = services.find_details_sheet(current_file)
            if current_sheet_name is None:
                raise DomainConflictError("A base atual da Simpress não tem os cabeçalhos esperados.")
            current_wb = openpyxl.load_workbook(current_file, read_only=True, data_only=False)
            current_ws = current_wb[current_sheet_name]
            current_headers = [cell.value for cell in next(current_ws.iter_rows(max_row=1), ())]
            current_serial_col_index = find_workbook_header_column(current_headers, DETAILS_SERIAL_HEADER_ALIASES)
            if current_serial_col_index is None:
                raise DomainConflictError("A base atual não contém NumeroSerie.")
            current_alias_col_index = find_workbook_header_column(current_headers, DETAILS_ALIAS_HEADER_ALIASES)
            if current_alias_col_index is None:
                raise DomainConflictError("A base atual não contém Apelido ou Hostname.")
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
                    raise DomainConflictError("A base atual contém séries duplicadas; confira antes de exportar.")
                current_rows[serial_key] = {
                    "apelido": cells[current_alias_col - 1],
                    "id_cliente": cells[current_id_cliente_col - 1] if current_id_cliente_col else None,
                }

            endpoint_index = services.read_endpoint_alias_index()
            aliases = get_export_aliases(services, endpoint_index)
            serial_counts: Dict[str, int] = {}
            for row in range(2, ws.max_row + 1):
                serial_key = normalize_reference_value(ws.cell(row=row, column=serial_col).value)
                if serial_key:
                    serial_counts[serial_key] = serial_counts.get(serial_key, 0) + 1

            if set(serial_counts) != set(current_rows):
                raise DomainConflictError("As séries da base atual diferem das linhas do modelo de exportação. Atualize o modelo antes de exportar.")

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
        latest_history = None
        try:
            latest_history = services.latest_comparison_update_entry()
        except services.external_errors:
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

        return EquipmentExport(content=output_bytes, headers=headers)
    except passthrough_errors:
        raise
    except FileBusyError as error:
        raise DomainConflictError(str(error)) from error
    except WorkbookSafetyError as error:
        raise DomainConflictError(f"Exportação cancelada para preservar a planilha: {error}") from error
    except FileTransactionError as error:
        raise DomainError(f"Não foi possível validar a exportação: {error}") from error
    except Exception:
        services.logger.exception("Falha ao exportar a base local de equipamentos.")
        raise DomainError("Erro ao exportar a base de equipamentos.") from None
    finally:
        if wb is not None:
            wb.close()
        if current_wb is not None:
            current_wb.close()
