"""Excel presentation helpers for inventory comparison history."""

import re
from datetime import datetime
from typing import Any, Dict, Optional
from core.xlsx_safety import set_cell_value_as_text
from domains.history_annotations import annotation_export_text

from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo


_EXPORT_NAVY = "10213A"
_EXPORT_NAVY_DARK = "0B1729"
_EXPORT_CYAN = "00A3E0"
_EXPORT_TEXT = "26364A"
_EXPORT_MUTED = "63748A"
_EXPORT_PALE = "F2F6FA"
_EXPORT_BORDER = "D9E3ED"


def _export_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        value = "; ".join(f"{key}: {item}" for key, item in value.items())
    elif isinstance(value, (list, tuple, set)):
        value = "; ".join(str(item) for item in value if item is not None)
    return str(value)[:32767]


def _history_display_text(value: Any) -> str:
    """Mask legacy source names in history exports while keeping stored filenames intact."""
    text = _export_text(value)
    text = re.sub(r"\b(?:na|no|da|do|à|ao|pela|pelo|a|o)\s*InvAll", "no endpoint", text, flags=re.IGNORECASE)
    text = re.sub(r"InvAll", "no endpoint", text, flags=re.IGNORECASE)
    text = re.sub(
        r"(?<![\w.-])(?:no\s+)?Endpoint(?![\w.-])",
        "no endpoint",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\b(?:em|de|da|do|na|no|a|à|pela|pelo)\s*EquipamentosDetalhes", "na Simpress", text, flags=re.IGNORECASE)
    text = re.sub(r"EquipamentosDetalhes", "na Simpress", text, flags=re.IGNORECASE)
    return re.sub(r"\b(?:na\s+)?Simpress\b", "na Simpress", text, flags=re.IGNORECASE)


def _history_display_files(value: Any) -> Dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {key: _history_display_text(name) for key, name in value.items() if isinstance(key, str)}


def _export_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        except (TypeError, ValueError, OverflowError):
            return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def _export_event_timestamp(event: Dict[str, Any]) -> float:
    parsed = _export_datetime(event.get("horario"))
    return parsed.timestamp() if parsed is not None else float("-inf")


def _export_rows(comparison: Dict[str, Any], key: str) -> list:
    rows = comparison.get(key)
    return [item for item in rows if isinstance(item, dict)] if isinstance(rows, list) else []


def _export_note(
    comparison: Dict[str, Any],
    category: str,
    index: int,
    item: Optional[Dict[str, Any]] = None,
) -> str:
    if isinstance(item, dict):
        if item.get("anotacao_conflito"):
            return _export_text(annotation_export_text(item))
        if isinstance(item.get("anotacao"), str):
            return _export_text(item["anotacao"])
        if item.get("anotacao_id"):
            return ""
    annotations = comparison.get("anotacoes")
    if not isinstance(annotations, dict):
        return ""
    return _export_text(annotations.get(f"{category}:{index}"))


def _style_export_title(ws, title: str, subtitle: str, last_column: int) -> None:
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=last_column)
    title_cell = ws.cell(row=1, column=1, value=title)
    title_cell.fill = PatternFill("solid", fgColor=_EXPORT_NAVY_DARK)
    title_cell.font = Font(name="Aptos Display", size=18, bold=True, color="FFFFFF")
    title_cell.alignment = Alignment(vertical="center")
    ws.row_dimensions[1].height = 38

    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=last_column)
    subtitle_cell = ws.cell(row=2, column=1, value=subtitle)
    subtitle_cell.fill = PatternFill("solid", fgColor=_EXPORT_NAVY)
    subtitle_cell.font = Font(name="Aptos", size=10, color="D7E5F3")
    subtitle_cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.row_dimensions[2].height = 26
    ws.row_dimensions[3].height = 10


def _safe_export_cell(cell, value: Any) -> None:
    if isinstance(value, str):
        set_cell_value_as_text(cell, value[:32767])
        cell.number_format = "@"
    else:
        cell.value = value
        if isinstance(value, datetime):
            cell.number_format = "dd/mm/yyyy hh:mm"
        elif isinstance(value, int) and not isinstance(value, bool):
            cell.number_format = "#,##0"
    cell.alignment = Alignment(vertical="top", wrap_text=True)


def _estimated_row_height(values, widths) -> float:
    lines = 1
    for value, width in zip(values, widths):
        if value is None:
            continue
        effective_width = max(10, min(float(width or 20), 60))
        for line in str(value).splitlines() or [""]:
            lines = max(lines, (len(line) // int(effective_width * 1.35)) + 1)
    return min(90, max(25, lines * 15))


def _write_export_table_sheet(
    workbook,
    sheet_name: str,
    title: str,
    subtitle: str,
    headers,
    rows,
    table_name: str,
    widths,
) -> None:
    ws = workbook.create_sheet(sheet_name)
    ws.sheet_view.showGridLines = False
    ws.sheet_view.zoomScale = 90
    ws.sheet_properties.tabColor = _EXPORT_CYAN
    _style_export_title(ws, title, subtitle, len(headers))

    for column, header in enumerate(headers, start=1):
        cell = ws.cell(row=4, column=column, value=header)
        cell.fill = PatternFill("solid", fgColor=_EXPORT_NAVY)
        cell.font = Font(name="Aptos", size=10, bold=True, color="FFFFFF")
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        cell.border = Border(bottom=Side(style="medium", color=_EXPORT_CYAN))
        ws.column_dimensions[get_column_letter(column)].width = widths[column - 1]
    ws.row_dimensions[4].height = 34
    ws.freeze_panes = "A5"

    for row_index, values in enumerate(rows, start=5):
        for column, value in enumerate(values, start=1):
            cell = ws.cell(row=row_index, column=column)
            _safe_export_cell(cell, value)
            if row_index % 2 == 0:
                cell.fill = PatternFill("solid", fgColor=_EXPORT_PALE)
            cell.font = Font(name="Aptos", size=10, color=_EXPORT_TEXT)
            cell.border = Border(bottom=Side(style="hair", color=_EXPORT_BORDER))
        ws.row_dimensions[row_index].height = _estimated_row_height(values, widths)

    if rows:
        table = Table(
            displayName=table_name,
            ref=f"A4:{get_column_letter(len(headers))}{4 + len(rows)}",
        )
        table.tableStyleInfo = TableStyleInfo(
            name="TableStyleMedium2",
            showFirstColumn=False,
            showLastColumn=False,
            showRowStripes=True,
            showColumnStripes=False,
        )
        ws.add_table(table)
    else:
        ws.auto_filter.ref = f"A4:{get_column_letter(len(headers))}4"

    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = "1:4"


def _write_export_summary_sheet(workbook, generated_at, selected_date, events, event_counts, category_counts, detail_total) -> None:
    ws = workbook.active
    ws.title = "Resumo"
    ws.sheet_view.showGridLines = False
    ws.sheet_view.zoomScale = 95
    ws.sheet_properties.tabColor = _EXPORT_CYAN
    _style_export_title(
        ws,
        "Histórico de planilhas",
        f"Data selecionada: {selected_date:%d/%m/%Y} · Exportado em {generated_at:%d/%m/%Y às %H:%M} · {len(events):,} eventos".replace(",", "."),
        8,
    )
    for column in range(1, 9):
        ws.column_dimensions[get_column_letter(column)].width = 18
    for start_column, label, value in (
        (1, "EVENTOS", len(events)),
        (3, "ATUALIZAÇÕES", event_counts["atualizacao"]),
        (5, "RESTAURAÇÕES", event_counts["restauracao"]),
        (7, "LINHAS DE DETALHE", detail_total),
    ):
        end_column = start_column + 1
        ws.merge_cells(start_row=4, start_column=start_column, end_row=4, end_column=end_column)
        ws.merge_cells(start_row=5, start_column=start_column, end_row=5, end_column=end_column)
        label_cell = ws.cell(row=4, column=start_column, value=label)
        label_cell.fill = PatternFill("solid", fgColor="E7F3FA")
        label_cell.font = Font(name="Aptos", size=9, bold=True, color=_EXPORT_MUTED)
        label_cell.alignment = Alignment(horizontal="center", vertical="center")
        value_cell = ws.cell(row=5, column=start_column, value=value)
        value_cell.fill = PatternFill("solid", fgColor="F4F8FC")
        value_cell.font = Font(name="Aptos Display", size=22, bold=True, color=_EXPORT_NAVY)
        value_cell.alignment = Alignment(horizontal="center", vertical="center")
        for row in (4, 5):
            for column in range(start_column, end_column + 1):
                ws.cell(row=row, column=column).border = Border(
                    left=Side(style="thin", color=_EXPORT_BORDER),
                    right=Side(style="thin", color=_EXPORT_BORDER),
                    top=Side(style="thin", color=_EXPORT_BORDER),
                    bottom=Side(style="thin", color=_EXPORT_BORDER),
                )
    ws.row_dimensions[4].height = 24
    ws.row_dimensions[5].height = 42

    ws.merge_cells("A7:B7")
    section = ws["A7"]
    section.value = "Registros por categoria"
    section.fill = PatternFill("solid", fgColor=_EXPORT_NAVY)
    section.font = Font(name="Aptos", size=11, bold=True, color="FFFFFF")
    section.alignment = Alignment(vertical="center")
    ws.row_dimensions[7].height = 25
    for column, header in enumerate(("Categoria", "Linhas"), start=1):
        cell = ws.cell(row=8, column=column, value=header)
        cell.fill = PatternFill("solid", fgColor="DDEAF4")
        cell.font = Font(name="Aptos", size=10, bold=True, color=_EXPORT_NAVY)
        cell.alignment = Alignment(vertical="center")
    for row_index, (label, count) in enumerate(category_counts.items(), start=9):
        for column, value in enumerate((label, count), start=1):
            cell = ws.cell(row=row_index, column=column, value=value)
            cell.font = Font(name="Aptos", size=10, color=_EXPORT_TEXT)
            cell.alignment = Alignment(vertical="center")
            cell.border = Border(bottom=Side(style="hair", color=_EXPORT_BORDER))
            if row_index % 2 == 0:
                cell.fill = PatternFill("solid", fgColor=_EXPORT_PALE)
        ws.cell(row=row_index, column=2).number_format = "#,##0"
        ws.row_dimensions[row_index].height = 23

    note_row = 10 + len(category_counts)
    ws.merge_cells(start_row=note_row, start_column=1, end_row=note_row, end_column=8)
    note = ws.cell(row=note_row, column=1)
    note.value = "As abas seguintes mostram os eventos e os registros detalhados, incluindo as anotações salvas em cada comparação."
    note.font = Font(name="Aptos", size=9, italic=True, color=_EXPORT_MUTED)
    note.alignment = Alignment(wrap_text=True, vertical="center")
    ws.row_dimensions[note_row].height = 30
