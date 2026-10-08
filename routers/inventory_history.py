"""Routes for inventory comparison history and restore operations."""

import re
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Optional

import openpyxl
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo
from pydantic import BaseModel, Field


class ManualAliasConflictResolutionPayload(BaseModel):
    acao: str = Field(..., description="Manter o apelido manual ou remover esse override")


class ComparisonAnnotationPayload(BaseModel):
    anotacao: str = Field(..., max_length=2000)


class ComparisonRestorePayload(BaseModel):
    preview_token: str = Field(..., min_length=64, max_length=64)


_EXPORT_NAVY = "10213A"
_EXPORT_NAVY_DARK = "0B1729"
_EXPORT_CYAN = "00A3E0"
_EXPORT_TEXT = "26364A"
_EXPORT_MUTED = "63748A"
_EXPORT_PALE = "F2F6FA"
_EXPORT_BORDER = "D9E3ED"

_ANNOTATABLE_COMPARISON_CATEGORIES = (
    "apelidos_sem_atualizacao",
    "sem_acesso_14_dias",
    "ausentes_no_endpoint",
    "ausentes_em_detalhes",
    "divergencias_local",
    "correspondencias_ambiguas",
    "registros_ambiguos",
    "series_sem_mapeamento",
)


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
    if isinstance(item, dict) and isinstance(item.get("anotacao"), str):
        return _export_text(item["anotacao"])
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
        cell.value = value[:32767]
        # Force strings that begin with '=' to remain text instead of formulas.
        cell.data_type = "s"
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


def create_inventory_history_router(ctx):
    router = APIRouter()

    def _comparison_event_type(evento: Dict[str, Any]) -> str:
        comparison = evento.get("comparacao")
        if (
            evento.get("tipo") == "restauracao"
            or isinstance(comparison, dict) and comparison.get("tipo_operacao") == "restauracao"
        ):
            return "restauracao"
        return "atualizacao"


    def _comparison_restore_backup_paths(evento: Dict[str, Any]) -> Dict[str, Path]:
        comparison = evento.get("comparacao")
        if not isinstance(comparison, dict):
            raise ctx.HTTPException(status_code=409, detail="Esta atualização não possui um backup disponível para restauração.")
        relative_value = comparison.get("backup_diretorio")
        if not isinstance(relative_value, str) or not relative_value.strip():
            raise ctx.HTTPException(status_code=409, detail="Esta atualização não possui um backup disponível para restauração.")

        relative_path = Path(relative_value)
        if relative_path.is_absolute() or not relative_path.parts or any(part in {".", ".."} for part in relative_path.parts):
            raise ctx.HTTPException(status_code=409, detail="O caminho do backup desta atualização não é válido.")

        try:
            backup_root = ctx.UPLOAD_BACKUPS_DIR.resolve(strict=False)
            backup_directory = (ctx.INPUT_DIR / relative_path).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            raise ctx.HTTPException(status_code=409, detail="O backup desta atualização não está disponível.") from None
        if backup_directory.parent != backup_root or not backup_directory.is_dir():
            raise ctx.HTTPException(status_code=409, detail="O backup desta atualização não está disponível.")

        missing_roles = comparison.get("backup_arquivos_ausentes")
        invalid_roles = comparison.get("backup_arquivos_invalidos")
        target_files = {
            "endpoint": ctx.ENDPOINT_UPLOAD_FILE,
            "detalhes": ctx.DETAILS_UPLOAD_FILE,
        }
        paths: Dict[str, Path] = {}
        for role, target_path in target_files.items():
            if (
                isinstance(missing_roles, dict) and missing_roles.get(role) is True
                or isinstance(invalid_roles, dict) and invalid_roles.get(role) is True
            ):
                raise ctx.HTTPException(status_code=409, detail="O backup desta atualização não contém dois inventários válidos.")
            try:
                role_directory = (backup_directory / role).resolve(strict=True)
                if role_directory.parent != backup_directory or not role_directory.is_dir():
                    raise ValueError("invalid backup role directory")
                backup_path = (role_directory / target_path.name).resolve(strict=True)
                if backup_path.parent != role_directory or not backup_path.is_file():
                    raise ValueError("invalid backup file")
            except (OSError, RuntimeError, ValueError):
                raise ctx.HTTPException(status_code=409, detail="O backup desta atualização não contém os dois inventários.") from None
            paths[role] = backup_path
        return paths


    def _comparison_event_has_restorable_backup(evento: Dict[str, Any]) -> bool:
        try:
            _comparison_restore_backup_paths(evento)
            return True
        except ctx.HTTPException:
            return False


    def _sha256_file(path: Path) -> str:
        digest = ctx.hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()


    def _validated_comparison_backup_files(paths: Dict[str, Path]) -> Dict[str, Dict[str, Any]]:
        labels = {"endpoint": "no endpoint", "detalhes": "na Simpress"}
        files: Dict[str, Dict[str, Any]] = {}
        for role, backup_path in paths.items():
            label = labels[role]
            try:
                size = backup_path.stat().st_size
                if size <= 0 or size > ctx.MAX_UPLOAD_BYTES:
                    raise ctx.HTTPException(status_code=409, detail="O arquivo excede o limite de tamanho ou está vazio.")
                file_bytes = backup_path.read_bytes()
                table = ctx.validate_uploaded_workbook(file_bytes, role)
            except ctx.HTTPException as error:
                raise ctx.HTTPException(
                    status_code=409,
                    detail=f"O backup de {label} não passou na validação: {error.detail}",
                ) from error
            except ctx.WorkbookSafetyError as error:
                raise ctx.HTTPException(
                    status_code=409,
                    detail=f"O backup de {label} não passou na validação: {error}",
                ) from error
            except OSError:
                raise ctx.HTTPException(status_code=409, detail=f"Não foi possível ler o backup de {label}.") from None
            files[role] = {
                "path": backup_path,
                "name": backup_path.name,
                "bytes": file_bytes,
                "sha256": ctx.hashlib.sha256(file_bytes).hexdigest(),
                "records": len(table.get("records", [])),
                "size": size,
                "modified": ctx.datetime.fromtimestamp(backup_path.stat().st_mtime).astimezone().isoformat(timespec="seconds"),
            }
        return files


    def _current_inventory_snapshot() -> tuple[Dict[str, Dict[str, Any]], Dict[str, Optional[str]]]:
        target_files = {
            "endpoint": ctx.ENDPOINT_UPLOAD_FILE,
            "detalhes": ctx.DETAILS_UPLOAD_FILE,
        }
        metadata: Dict[str, Dict[str, Any]] = {}
        hashes: Dict[str, Optional[str]] = {}
        for role, target_path in target_files.items():
            if target_path.is_symlink():
                raise ctx.HTTPException(status_code=409, detail="Um arquivo ativo foi substituído por um atalho; a restauração foi cancelada.")
            if target_path.exists() and not target_path.is_file():
                raise ctx.HTTPException(status_code=409, detail=f"O caminho ativo {target_path.name} não é um arquivo regular.")
            if not target_path.is_file():
                metadata[role] = {"nome": target_path.name, "presente": False}
                hashes[role] = None
                continue
            try:
                stat = target_path.stat()
                if stat.st_size > ctx.MAX_UPLOAD_BYTES:
                    raise ctx.HTTPException(status_code=409, detail=f"O arquivo ativo {target_path.name} excede o limite permitido para backup.")
                file_hash = _sha256_file(target_path)
            except ctx.HTTPException:
                raise
            except OSError:
                raise ctx.HTTPException(status_code=409, detail=f"Não foi possível conferir o arquivo ativo {target_path.name}.") from None
            metadata[role] = {
                "nome": target_path.name,
                "presente": True,
                "tamanho_bytes": stat.st_size,
                "modificado_em": ctx.datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec="seconds"),
            }
            hashes[role] = file_hash
        return metadata, hashes


    def _build_comparison_restore_context(evento_id: str) -> Dict[str, Any]:
        evento = next(
            (item for item in ctx.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        if evento is None:
            raise ctx.HTTPException(status_code=404, detail="A atualização selecionada não existe no histórico de planilhas.")

        backup_paths = _comparison_restore_backup_paths(evento)
        backup_files = _validated_comparison_backup_files(backup_paths)
        current_files, current_hashes = _current_inventory_snapshot()
        token_material = {
            "evento_id": evento_id,
            "horario": evento.get("horario"),
            "backup_diretorio": evento.get("comparacao", {}).get("backup_diretorio"),
            "backup_hashes": {role: backup_files[role]["sha256"] for role in sorted(backup_files)},
            "ativos_hashes": current_hashes,
        }
        preview_token = ctx.hashlib.sha256(
            ctx.json.dumps(token_material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return {
            "evento": evento,
            "backup_files": backup_files,
            "current_files": current_files,
            "current_hashes": current_hashes,
            "preview_token": preview_token,
        }


    def _latest_annotation_records(history=None):
        latest: Dict[tuple[str, str], tuple[str, Dict[str, Any]]] = {}
        for record in ctx.load_history_annotations(ctx.HISTORY_ANNOTATIONS_DIR):
            key = (record["evento_id"], record["item_id"])
            candidate = (str(record.get("atualizado_em") or ""), record)
            if key not in latest or candidate[0] >= latest[key][0]:
                latest[key] = candidate
        records: Dict[tuple[str, str], Dict[str, Any]] = {
            key: value[1] for key, value in latest.items()
        }

        # Move notes made by older versions into the shared store on first view.
        local_history = ctx.load_comparison_history() if history is None else history
        for event in local_history:
            if not isinstance(event, dict):
                continue
            event_id = str(event.get("id") or "")
            comparison = event.get("comparacao")
            if not event_id or not isinstance(comparison, dict):
                continue
            legacy_annotations = comparison.get("anotacoes")
            for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
                items = comparison.get(category)
                if not isinstance(items, list):
                    continue
                for index, item in enumerate(items):
                    if not isinstance(item, dict):
                        continue
                    annotation = item.get("anotacao")
                    if not isinstance(annotation, str) and isinstance(legacy_annotations, dict):
                        legacy_category = (
                            "ambiguidades"
                            if category in ("correspondencias_ambiguas", "registros_ambiguos")
                            else category
                        )
                        legacy_index = index
                        if category == "registros_ambiguos":
                            ambiguity_items = comparison.get("correspondencias_ambiguas")
                            legacy_index += len(ambiguity_items) if isinstance(ambiguity_items, list) else 0
                        annotation = legacy_annotations.get(f"{legacy_category}:{legacy_index}")
                    if not isinstance(annotation, str):
                        continue
                    item_id = ctx.comparison_annotation_item_id(event_id, category, index, item)
                    key = (event_id, item_id)
                    if key in records:
                        continue
                    try:
                        records[key] = ctx.save_history_annotation(
                            ctx.HISTORY_ANNOTATIONS_DIR,
                            event_id=event_id,
                            event_time=str(event.get("horario") or ""),
                            item_id=item_id,
                            serie=str(item.get("serie") or ""),
                            computador=str(item.get("computador") or item.get("chave") or ""),
                            motivo=str(item.get("motivo") or item.get("mensagem") or item.get("tipo") or ""),
                            anotacao=annotation,
                            categoria=category,
                        )
                    except Exception:
                        # Keep local history readable when OneDrive is temporarily unavailable.
                        continue
        return records


    def _merge_shared_annotations(
        event_view: Dict[str, Any],
        annotations: Dict[tuple[str, str], Dict[str, Any]],
    ) -> Dict[str, Any]:
        comparison = event_view.get("comparacao")
        if not isinstance(comparison, dict):
            return event_view
        comparison["anotacoes_sync_ativa"] = bool(ctx.HISTORY_ANNOTATIONS_SYNC_ENABLED)
        event_id = str(event_view.get("id") or "")
        for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
            items = comparison.get(category)
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                record = annotations.get((event_id, str(item.get("anotacao_id") or "")))
                if record is not None:
                    item["anotacao"] = record["anotacao"]
        return event_view


    def _synthetic_annotation_event(event_id: str, records: Dict[tuple, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        event_records = [
            record for (record_event_id, _), record in records.items()
            if record_event_id == event_id and record.get("anotacao")
        ]
        if not event_records:
            return None
        event_records.sort(key=lambda record: record["item_id"])
        event_time = next((record.get("horario") for record in event_records if record.get("horario")), "")
        category_items = {category: [] for category in _ANNOTATABLE_COMPARISON_CATEGORIES}
        synchronized_annotations = []
        for record in event_records:
            category = record.get("categoria")
            if category not in category_items:
                category = "apelidos_sem_atualizacao"
            item = {
                "serie": record.get("serie", ""),
                "computador": record.get("computador", ""),
                "motivo": record.get("motivo", ""),
                "anotacao_id": record["item_id"],
                "anotacao": record["anotacao"],
                "categoria": category,
            }
            category_items[category].append(item)
            synchronized_annotations.append(item)
        return {
            "id": event_id,
            "horario": event_time,
            "somente_anotacoes_sincronizadas": True,
            "arquivos_enviados": {},
            "resumo": {
                category: len(items)
                for category, items in category_items.items()
                if items
            },
            "comparacao": {
                "evento_id": event_id,
                "horario_comparacao": event_time,
                "tipo_operacao": "atualizacao",
                "arquivos_enviados": {},
                **category_items,
                "anotacoes_sincronizadas": synchronized_annotations,
                "apelidos_atualizados": [],
                "divergencias_apelidos_manuais": [],
                "anotacoes_sync_ativa": bool(ctx.HISTORY_ANNOTATIONS_SYNC_ENABLED),
                "somente_anotacoes_sincronizadas": True,
            },
        }


    @router.get("/api/historico-comparacoes")
    def get_historico_comparacoes():
        eventos = []
        history = ctx.load_comparison_history()
        annotations = _latest_annotation_records(history)
        local_event_ids = set()
        for evento in history:
            if not isinstance(evento, dict):
                continue
            event_id = str(evento.get("id") or "")
            if event_id:
                local_event_ids.add(event_id)
            event_view = ctx.comparison_history_for_display(evento)
            _merge_shared_annotations(event_view, annotations)
            comparison = event_view.get("comparacao")
            comparison = comparison if isinstance(comparison, dict) else {}
            eventos.append({
                "id": event_view.get("id"),
                "horario": event_view.get("horario"),
                "tipo": _comparison_event_type(event_view),
                "arquivos_enviados": _history_display_files(event_view.get("arquivos_enviados")),
                "arquivos_restaurados": _history_display_files(comparison.get("arquivos_restaurados")),
                "restauracao_de": comparison.get("restauracao_de", {}),
                "restauravel": _comparison_event_has_restorable_backup(evento),
                "resumo": event_view.get("resumo", {}),
            })
        shared_event_ids = {event_id for event_id, _ in annotations}
        for event_id in shared_event_ids - local_event_ids:
            event_view = _synthetic_annotation_event(event_id, annotations)
            if event_view is None:
                continue
            eventos.append({
                "id": event_view["id"],
                "horario": event_view["horario"],
                "tipo": "atualizacao",
                "arquivos_enviados": {},
                "arquivos_restaurados": {},
                "restauracao_de": {},
                "restauravel": False,
                "somente_anotacoes_sincronizadas": True,
                "resumo": event_view["resumo"],
            })
        def event_timestamp(item: Dict[str, Any]) -> float:
            try:
                return ctx.datetime.fromisoformat(str(item.get("horario") or "").replace("Z", "+00:00")).timestamp()
            except (TypeError, ValueError, OverflowError):
                return float("-inf")
        eventos.sort(key=event_timestamp, reverse=True)
        return {"total": len(eventos), "eventos": eventos}


    @router.get("/api/historico-comparacoes/exportar/excel")
    def exportar_historico_comparacoes_excel(data: str = Query(..., min_length=10, max_length=10, pattern=r"^\d{4}-\d{2}-\d{2}$")):
        try:
            selected_date = date.fromisoformat(data)
        except ValueError:
            raise ctx.HTTPException(status_code=400, detail="Selecione uma data válida para exportação.") from None

        display_events = []
        for event in ctx.load_comparison_history():
            if isinstance(event, dict) and str(event.get("horario") or "")[:10] == selected_date.isoformat():
                display_events.append(ctx.comparison_history_for_display(event))
        if not display_events:
            raise ctx.HTTPException(status_code=404, detail="Não há registros de planilhas na data selecionada.")
        display_events.sort(key=_export_event_timestamp)

        event_counts = {"atualizacao": 0, "restauracao": 0}
        category_counts = {
            "Apelidos atualizados": 0,
            "Apelidos para conferência": 0,
            "Divergências manuais": 0,
            "Sem verificação há 14+ dias": 0,
            "Ausentes no endpoint": 0,
            "Ausentes na Simpress": 0,
            "Divergências de localidade": 0,
            "Duplicidades e ambiguidades": 0,
            "Séries sem local definido": 0,
        }
        history_rows = []
        alias_rows = []
        absence_rows = []
        no_access_rows = []
        location_rows = []
        ambiguity_rows = []

        for order, event in enumerate(display_events, start=1):
            comparison = event.get("comparacao")
            comparison = comparison if isinstance(comparison, dict) else {}
            summary = event.get("resumo")
            summary = summary if isinstance(summary, dict) else {}
            event_type = _comparison_event_type(event)
            event_type_label = "Restauração" if event_type == "restauracao" else "Atualização"
            event_counts[event_type] += 1
            timestamp = _export_datetime(event.get("horario") or comparison.get("horario_comparacao"))
            event_id = _export_text(event.get("id") or comparison.get("evento_id"))
            alias_updates = _export_rows(comparison, "apelidos_atualizados")
            alias_reviews = _export_rows(comparison, "apelidos_sem_atualizacao")
            manual_alias_conflicts = _export_rows(comparison, "divergencias_apelidos_manuais")
            absent_endpoint = _export_rows(comparison, "ausentes_no_endpoint")
            absent_simpress = _export_rows(comparison, "ausentes_em_detalhes")
            no_recent_verification = _export_rows(comparison, "sem_acesso_14_dias")
            local_divergences = _export_rows(comparison, "divergencias_local")
            unmapped_series = _export_rows(comparison, "series_sem_mapeamento")
            ambiguities = _export_rows(comparison, "correspondencias_ambiguas")
            ambiguous_records = _export_rows(comparison, "registros_ambiguos")

            manual_pending_count = sum(
                1 for item in manual_alias_conflicts
                if item.get("resolucao", "pendente") == "pendente"
            )
            ambiguity_count = len(ambiguities) + len(ambiguous_records)
            category_counts["Apelidos atualizados"] += len(alias_updates)
            category_counts["Apelidos para conferência"] += len(alias_reviews)
            category_counts["Divergências manuais"] += len(manual_alias_conflicts)
            category_counts["Sem verificação há 14+ dias"] += len(no_recent_verification)
            category_counts["Ausentes no endpoint"] += len(absent_endpoint)
            category_counts["Ausentes na Simpress"] += len(absent_simpress)
            category_counts["Divergências de localidade"] += len(local_divergences)
            category_counts["Duplicidades e ambiguidades"] += ambiguity_count
            category_counts["Séries sem local definido"] += len(unmapped_series)

            files_uploaded = event.get("arquivos_enviados")
            if not isinstance(files_uploaded, dict):
                files_uploaded = comparison.get("arquivos_enviados")
            files_uploaded = files_uploaded if isinstance(files_uploaded, dict) else {}
            files_restored = comparison.get("arquivos_restaurados")
            files_restored = files_restored if isinstance(files_restored, dict) else {}
            endpoint_file = files_restored.get("endpoint") if event_type == "restauracao" else files_uploaded.get("endpoint")
            simpress_file = files_restored.get("detalhes") if event_type == "restauracao" else files_uploaded.get("detalhes")
            history_rows.append((
                order,
                timestamp,
                event_type_label,
                event_id,
                _history_display_text(endpoint_file),
                _history_display_text(simpress_file),
                comparison.get("total_endpoint", summary.get("total_endpoint")),
                comparison.get("total_detalhes", summary.get("total_detalhes")),
                comparison.get("total_equipamentos_carregados", summary.get("total_equipamentos_carregados")),
                len(alias_updates),
                len(alias_reviews),
                manual_pending_count,
                len(absent_endpoint),
                len(absent_simpress),
                len(no_recent_verification),
                len(local_divergences),
                ambiguity_count,
                len(unmapped_series),
                _export_datetime((comparison.get("restauracao_de") or {}).get("horario"))
                if isinstance(comparison.get("restauracao_de"), dict) else None,
                _export_text(comparison.get("backup_diretorio")),
            ))

            for item in alias_updates:
                alias_rows.append((
                    timestamp, event_type_label, "Apelido atualizado",
                    item.get("serie"), "", item.get("apelido_anterior"),
                    item.get("apelido_equipamentos_detalhes"),
                    item.get("apelido_novo") or item.get("apelido_invall"),
                    _export_datetime(item.get("horario")), "Concluído", "",
                    _history_display_text(item.get("arquivos_origem")), "",
                ))
            for index, item in enumerate(alias_reviews):
                alias_rows.append((
                    timestamp, event_type_label, "Para conferência",
                    item.get("serie"), item.get("computador"), "", "", "", None,
                    "Pendente", item.get("motivo"), "",
                    _export_note(comparison, "apelidos_sem_atualizacao", index, item),
                ))
            manual_status = {
                "manter": "Alteração manual mantida",
                "excluir": "Alteração manual removida",
                "substituida": "Atualizada por nova planilha",
                "pendente": "Pendente",
            }
            for item in manual_alias_conflicts:
                resolution = item.get("resolucao") or "pendente"
                alias_rows.append((
                    timestamp, event_type_label, "Divergência manual",
                    item.get("serie"), "", item.get("apelido_manual"),
                    item.get("apelido_equipamentos_detalhes"), item.get("apelido_invall"),
                    _export_datetime(item.get("horario_resolucao")),
                    manual_status.get(resolution, _export_text(resolution)),
                    "Diferença entre apelido manual e as planilhas de origem.", "", "",
                ))

            for category, items, note_category in (
                ("Ausente no endpoint", absent_endpoint, "ausentes_no_endpoint"),
                ("Ausente na Simpress", absent_simpress, "ausentes_em_detalhes"),
            ):
                missing_source = "no endpoint" if category == "Ausente no endpoint" else "na Simpress"
                for index, item in enumerate(items):
                    absence_rows.append((
                        timestamp, category,
                        _export_text(item.get("ausente_em") or item.get("fonte_ausente") or missing_source),
                        item.get("computador"), item.get("serie"), item.get("local_previsto"),
                        _export_note(comparison, note_category, index, item),
                    ))

            for index, item in enumerate(no_recent_verification):
                no_access_rows.append((
                    timestamp, event_type_label, item.get("computador"), item.get("serie"),
                    _export_datetime(item.get("ultima_verificacao")), item.get("dias_sem_verificacao"),
                    item.get("linha_endpoint"), _export_note(comparison, "sem_acesso_14_dias", index, item),
                ))

            for index, item in enumerate(local_divergences):
                location_rows.append((
                    timestamp, "Localidade divergente", item.get("computador"),
                    item.get("serie"), item.get("local_previsto"), item.get("local_detalhes"),
                    None, "", _export_note(comparison, "divergencias_local", index, item),
                ))
            for index, item in enumerate(unmapped_series):
                location_rows.append((
                    timestamp, "Série sem local definido", "", item.get("serie"),
                    "", "", item.get("quantidade"), _export_text(item.get("exemplos")),
                    _export_note(comparison, "series_sem_mapeamento", index, item),
                ))

            for index, item in enumerate(ambiguities):
                sources = []
                for source in item.get("fontes") or []:
                    if not isinstance(source, dict):
                        continue
                    label = _export_text(source.get("fonte"))
                    if source.get("quantidade"):
                        label += f" ({source['quantidade']} registros)"
                    elif source.get("serie"):
                        label += f" — série {source['serie']}"
                    sources.append(label)
                ambiguity_rows.append((
                    timestamp, item.get("tipo") or "Ambiguidade",
                    item.get("chave"), "; ".join(sources), item.get("mensagem"),
                    _export_note(comparison, "ambiguidades", index, item),
                ))
            for index, item in enumerate(ambiguous_records, start=len(ambiguities)):
                ambiguous_sources = item.get("fontes") or {}
                source_summary = "; ".join(
                    str(source) for source, status in ambiguous_sources.items()
                    if status == "ambíguo"
                ) if isinstance(ambiguous_sources, dict) else ""
                record_key = f"{item.get('computador') or 'Sem hostname'} · {item.get('serie') or 'Sem série'}"
                ambiguity_rows.append((
                    timestamp, "Presença ambígua", record_key,
                    source_summary, item.get("motivo"), _export_note(comparison, "ambiguidades", index, item),
                ))

        detail_total = sum(category_counts.values())
        workbook = openpyxl.Workbook()
        workbook.properties.title = "Histórico de atualizações de planilhas"
        workbook.properties.subject = "Comparações, registros e anotações do histórico de planilhas"
        workbook.properties.creator = "Simpress"
        generated_at = datetime.now().astimezone().replace(tzinfo=None)
        _write_export_summary_sheet(workbook, generated_at, selected_date, display_events, event_counts, category_counts, detail_total)

        _write_export_table_sheet(
            workbook, "Histórico", "Eventos de planilhas",
            "Uma linha por atualização ou restauração, em ordem cronológica.",
            ["Ordem", "Data e hora", "Operação", "ID do evento", "Arquivo no endpoint", "Arquivo na Simpress",
             "Equipamentos no endpoint", "Equipamentos na Simpress", "Equipamentos carregados", "Apelidos atualizados",
             "Apelidos para conferência", "Divergências manuais pendentes", "Ausentes no endpoint",
             "Ausentes na Simpress", "Sem verificação há 14+ dias", "Divergências de local", "Duplicidades e ambiguidades",
             "Séries sem local", "Restauração de", "Diretório de backup"],
            history_rows, "tblHistoricoPlanilhas",
            [10, 20, 16, 34, 32, 42, 18, 18, 20, 17, 20, 22, 18, 18, 23, 18, 22, 17, 20, 36],
        )
        _write_export_table_sheet(
            workbook, "Apelidos", "Apelidos e hostnames",
            "Atualizações, linhas que precisam de conferência e divergências manuais registradas.",
            ["Data e hora", "Operação", "Categoria", "Série", "Hostname/Apelido",
             "Apelido anterior/manual", "Apelido na Simpress", "Apelido no endpoint/novo", "Horário da alteração",
             "Situação", "Motivo", "Arquivos de origem", "Anotação"],
            alias_rows, "tblHistoricoApelidos",
            [20, 16, 24, 18, 28, 30, 30, 32, 20, 29, 56, 36, 42],
        )
        _write_export_table_sheet(
            workbook, "Ausências", "Equipamentos ausentes por fonte",
            "Registros sem correspondência segura no endpoint ou na Simpress.",
            ["Data e hora", "Categoria", "Ausente em", "Hostname/Apelido", "Série",
             "Local previsto", "Anotação"],
            absence_rows, "tblHistoricoAusencias",
            [20, 24, 22, 32, 18, 28, 42],
        )
        _write_export_table_sheet(
            workbook, "Sem acesso", "Notebooks sem verificação recente",
            "Notebooks cuja última verificação com êxito ocorreu há pelo menos 14 dias.",
            ["Data e hora", "Operação", "Hostname/Apelido", "Série", "Última verificação com êxito",
             "Dias sem verificação", "Linha no endpoint", "Anotação"],
            no_access_rows, "tblHistoricoSemAcesso",
            [20, 16, 32, 20, 26, 20, 16, 42],
        )
        _write_export_table_sheet(
            workbook, "Localidades", "Divergências e séries sem local",
            "Diferenças de localidade e prefixos sem regra cadastrada.",
            ["Data e hora", "Categoria", "Computador", "Série", "Local previsto",
             "Local na Simpress", "Quantidade", "Exemplos", "Anotação"],
            location_rows, "tblHistoricoLocalidades",
            [20, 28, 30, 18, 28, 28, 14, 54, 42],
        )
        _write_export_table_sheet(
            workbook, "Ambiguidades", "Duplicidades e correspondências ambíguas",
            "Séries duplicadas e registros sem correspondência única.",
            ["Data e hora", "Ocorrência", "Série ou hostname/Apelido",
             "Fontes", "Tratamento", "Anotação"],
            ambiguity_rows, "tblHistoricoAmbiguidades",
            [20, 27, 48, 34, 66, 42],
        )

        output = BytesIO()
        workbook.save(output)
        output.seek(0)
        filename = f"Historico_Planilhas_{selected_date:%Y%m%d}_{generated_at:%H%M%S}.xlsx"
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )


    @router.get("/api/historico-comparacoes/{evento_id}")
    def get_comparacao_historica(evento_id: str):
        evento = next(
            (item for item in ctx.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        annotations = _latest_annotation_records()
        if evento is None:
            event_view = _synthetic_annotation_event(evento_id, annotations)
            if event_view is None:
                raise ctx.HTTPException(status_code=404, detail="O resultado selecionado não existe no histórico de planilhas.")
            return {"evento": event_view}
        event_view = ctx.comparison_history_for_display(evento)
        _merge_shared_annotations(event_view, annotations)
        return {"evento": event_view}


    @router.put("/api/historico-comparacoes/{evento_id}/anotacoes/{item_id}")
    def salvar_anotacao_comparacao_historica(
        evento_id: str,
        item_id: str,
        payload: ComparisonAnnotationPayload,
    ):
        event = next(
            (item for item in ctx.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        annotation_row = None
        if event is not None:
            comparison = event.get("comparacao")
            if isinstance(comparison, dict):
                for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
                    items = comparison.get(category)
                    if not isinstance(items, list):
                        continue
                    for index, comparison_item in enumerate(items):
                        if not isinstance(comparison_item, dict):
                            continue
                        stable_id = ctx.comparison_annotation_item_id(
                            evento_id, category, index, comparison_item
                        )
                        if stable_id == item_id:
                            annotation_row = dict(comparison_item)
                            annotation_row["anotacao_id"] = stable_id
                            annotation_row["categoria"] = category
                            break
                    if annotation_row is not None:
                        break
        else:
            annotation_row = next(
                (
                    record for (record_event_id, record_item_id), record in _latest_annotation_records().items()
                    if record_event_id == evento_id and record_item_id == item_id
                ),
                None,
            )
        if annotation_row is None:
            raise ctx.HTTPException(status_code=404, detail="A linha selecionada não existe neste resultado.")

        def update_annotation(history):
            if not isinstance(history, list):
                raise ctx.HTTPException(status_code=500, detail="O histórico de planilhas não contém uma lista válida.")
            event = next(
                (item for item in history if isinstance(item, dict) and item.get("id") == evento_id),
                None,
            )
            if event is None:
                raise ctx.HTTPException(status_code=404, detail="A atualização selecionada não existe mais no histórico.")
            comparison = event.get("comparacao")
            if not isinstance(comparison, dict):
                raise ctx.HTTPException(status_code=404, detail="A linha selecionada não existe neste resultado.")
            for category in _ANNOTATABLE_COMPARISON_CATEGORIES:
                items = comparison.get(category)
                if not isinstance(items, list):
                    continue
                for index, comparison_item in enumerate(items):
                    if not isinstance(comparison_item, dict):
                        continue
                    stable_id = ctx.comparison_annotation_item_id(
                        evento_id, category, index, comparison_item
                    )
                    if stable_id == item_id:
                        comparison_item["anotacao_id"] = stable_id
                        comparison_item["anotacao"] = payload.anotacao
                        return history
            raise ctx.HTTPException(status_code=404, detail="A linha selecionada não existe neste resultado.")

        try:
            if event is not None:
                with ctx.COMPARISON_HISTORY_LOCK:
                    ctx._atomic_json_update(ctx.COMPARISON_HISTORY_FILE, update_annotation, [])
            ctx.save_history_annotation(
                ctx.HISTORY_ANNOTATIONS_DIR,
                event_id=evento_id,
                event_time=str(event.get("horario") or "") if event is not None else str(annotation_row.get("horario") or ""),
                item_id=item_id,
                serie=str(annotation_row.get("serie") or ""),
                computador=str(annotation_row.get("computador") or annotation_row.get("chave") or ""),
                motivo=str(annotation_row.get("motivo") or annotation_row.get("mensagem") or annotation_row.get("tipo") or ""),
                anotacao=payload.anotacao,
                categoria=str(annotation_row.get("categoria") or "apelidos_sem_atualizacao"),
            )
        except ctx.HTTPException:
            raise
        except Exception:
            status = 503 if ctx.HISTORY_ANNOTATIONS_SYNC_ENABLED else 500
            raise ctx.HTTPException(status_code=status, detail="Não foi possível salvar e sincronizar a anotação.") from None
        return {"sucesso": True, "anotacao": payload.anotacao}


    @router.get("/api/historico-comparacoes/{evento_id}/restauracao")
    def visualizar_restauracao_comparacao(evento_id: str):
        context = _build_comparison_restore_context(evento_id)
        return {
            "evento_id": evento_id,
            "evento_horario": context["evento"].get("horario"),
            "tipo_evento": _comparison_event_type(context["evento"]),
            "arquivos_backup": {
                role: {
                    "nome": item["name"],
                    "registros": item["records"],
                    "tamanho_bytes": item["size"],
                    "modificado_em": item["modified"],
                }
                for role, item in context["backup_files"].items()
            },
            "arquivos_atuais": context["current_files"],
            "preview_token": context["preview_token"],
        }


    @router.post("/api/historico-comparacoes/{evento_id}/restaurar")
    def restaurar_comparacao_historica(evento_id: str, payload: ComparisonRestorePayload):
        persistent_backup_dir = None

        try:
            context = _build_comparison_restore_context(evento_id)
            if not ctx.hmac.compare_digest(payload.preview_token, context["preview_token"]):
                raise ctx.HTTPException(
                    status_code=409,
                    detail="Os arquivos ativos ou o backup mudaram desde a prévia. Atualize a prévia antes de restaurar.",
                )
            if all(
                context["backup_files"][role]["sha256"] == context["current_hashes"][role]
                for role in context["backup_files"]
            ):
                raise ctx.HTTPException(status_code=409, detail="Os dois inventários ativos já correspondem ao backup selecionado.")

            restoration_time = ctx.datetime.now().astimezone().isoformat(timespec="seconds")
            restoration_id = ctx.uuid.uuid4().hex
            persistent_backup_dir = ctx.UPLOAD_BACKUPS_DIR / f"{ctx.datetime.now().strftime('%Y%m%d-%H%M%S')}-{ctx.uuid.uuid4().hex[:8]}"
            target_files = {
                "endpoint": ctx.ENDPOINT_UPLOAD_FILE,
                "detalhes": ctx.DETAILS_UPLOAD_FILE,
            }
            source_event = context["evento"]
            source_comparison = source_event.get("comparacao") or {}
            source_backup_relative = source_comparison.get("backup_diretorio")
            transaction_targets = [
                *target_files.values(),
                ctx.COMPARISON_HISTORY_FILE,
                ctx.MODIFIED_APELIDOS_FILE,
            ]

            with ctx.inventory_state_transaction(transaction_targets) as transaction:
                _, locked_current_hashes = _current_inventory_snapshot()
                if locked_current_hashes != context["current_hashes"]:
                    raise ctx.HTTPException(
                        status_code=409,
                        detail="Os inventários ativos mudaram desde a prévia. Atualize a prévia antes de restaurar.",
                    )
                persistent_backup_dir.mkdir(parents=True, exist_ok=False)
                missing_current_files: Dict[str, bool] = {}
                invalid_current_files: Dict[str, bool] = {}
                for role, target_path in target_files.items():
                    role_backup_dir = persistent_backup_dir / role
                    role_backup_dir.mkdir(parents=True, exist_ok=True)
                    expected_current_hash = context["current_hashes"][role]
                    if not target_path.is_file():
                        if expected_current_hash is not None:
                            raise ctx.TransactionConflictError(f"'{target_path.name}' mudou durante a restauração.")
                        missing_current_files[role] = True
                        invalid_current_files[role] = False
                        continue
                    if expected_current_hash is None:
                        raise ctx.TransactionConflictError(f"'{target_path.name}' mudou durante a restauração.")
                    backup_path = role_backup_dir / target_path.name
                    ctx.shutil.copy2(target_path, backup_path)
                    with backup_path.open("r+b") as backup_file:
                        backup_file.flush()
                        ctx.os.fsync(backup_file.fileno())
                    if (
                        not ctx.filecmp.cmp(target_path, backup_path, shallow=False)
                        or _sha256_file(backup_path) != expected_current_hash
                    ):
                        raise ctx.TransactionConflictError(f"A cópia de segurança de '{target_path.name}' não passou na validação.")
                    missing_current_files[role] = False
                    try:
                        ctx.validate_uploaded_workbook(backup_path.read_bytes(), role)
                        invalid_current_files[role] = False
                    except Exception:
                        invalid_current_files[role] = True

                _, backed_up_current_hashes = _current_inventory_snapshot()
                if backed_up_current_hashes != context["current_hashes"]:
                    raise ctx.TransactionConflictError("Um inventário ativo mudou durante a cópia de segurança.")

                for role, target_path in target_files.items():
                    backup_bytes = context["backup_files"][role]["bytes"]

                    def validate_staged_backup(path: Path, current_role=role, expected_bytes=backup_bytes):
                        candidate_bytes = path.read_bytes()
                        if candidate_bytes != expected_bytes:
                            raise ctx.WorkbookSafetyError("O arquivo preparado difere do backup validado.")
                        ctx.validate_uploaded_workbook(candidate_bytes, current_role)

                    transaction.stage_bytes(target_path, backup_bytes, validate_staged_backup)

                transaction.apply()
                if not ctx.load_database(transaction_locked=True):
                    raise RuntimeError("O conjunto restaurado não pôde ser carregado pelo site.")

                restored_files = {role: path.name for role, path in target_files.items()}
                restoration_comparison = {
                    "evento_id": restoration_id,
                    "tipo_operacao": "restauracao",
                    "horario_comparacao": restoration_time,
                    "restauracao_de": {
                        "evento_id": evento_id,
                        "horario": source_event.get("horario"),
                        "tipo": _comparison_event_type(source_event),
                    },
                    "arquivos_restaurados": restored_files,
                    "total_endpoint_restaurado": context["backup_files"]["endpoint"]["records"],
                    "total_detalhes_restaurado": context["backup_files"]["detalhes"]["records"],
                    "total_equipamentos_carregados": ctx.stats_cache.get("total_equipamentos", 0),
                    "backup_diretorio": str(persistent_backup_dir.relative_to(ctx.INPUT_DIR)),
                    "backup_arquivos_ausentes": missing_current_files,
                    "backup_arquivos_invalidos": invalid_current_files,
                    "historico_salvo": True,
                }
                restoration_event = {
                    "id": restoration_id,
                    "tipo": "restauracao",
                    "horario": restoration_time,
                    "arquivos_restaurados": restored_files,
                    "restauracao_de": restoration_comparison["restauracao_de"],
                    "resumo": {
                        "restauracao": True,
                        "total_endpoint_restaurado": restoration_comparison["total_endpoint_restaurado"],
                        "total_detalhes_restaurado": restoration_comparison["total_detalhes_restaurado"],
                    },
                    "comparacao": restoration_comparison,
                }

                def append_restoration(history):
                    if not isinstance(history, list):
                        raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
                    current_source_event = next(
                        (item for item in history if isinstance(item, dict) and item.get("id") == evento_id),
                        None,
                    )
                    current_source_comparison = (
                        current_source_event.get("comparacao")
                        if isinstance(current_source_event, dict) else None
                    )
                    if (
                        not isinstance(current_source_event, dict)
                        or not isinstance(current_source_comparison, dict)
                        or current_source_comparison.get("backup_diretorio") != source_backup_relative
                        or current_source_event.get("horario") != source_event.get("horario")
                    ):
                        raise ctx.HTTPException(
                            status_code=409,
                            detail="A atualização selecionada mudou ou foi removida do histórico. A restauração foi cancelada.",
                        )
                    updated = ctx.deepcopy(history)
                    updated.append(restoration_event)
                    return updated

                transaction.update_json(ctx.COMPARISON_HISTORY_FILE, append_restoration, [])
                transaction.commit()

            return {
                "sucesso": True,
                "evento": {
                    "id": restoration_id,
                    "tipo": "restauracao",
                    "horario": restoration_time,
                    "restauracao_de": restoration_comparison["restauracao_de"],
                    "arquivos_restaurados": restored_files,
                    "desfazer_disponivel": not any(missing_current_files.values()) and not any(invalid_current_files.values()),
                    "total_endpoint_restaurado": restoration_comparison["total_endpoint_restaurado"],
                    "total_detalhes_restaurado": restoration_comparison["total_detalhes_restaurado"],
                    "total_equipamentos_carregados": restoration_comparison["total_equipamentos_carregados"],
                },
            }
        except ctx.HTTPException:
            raise
        except ctx.FileBusyError as error:
            raise ctx.HTTPException(status_code=409, detail=str(error)) from error
        except ctx.TransactionConflictError as error:
            raise ctx.HTTPException(status_code=409, detail=f"Um arquivo mudou durante a restauração e nada foi sobrescrito: {error}") from error
        except (ctx.FileTransactionError, ctx.WorkbookSafetyError) as error:
            raise ctx.HTTPException(status_code=500, detail=f"Não foi possível concluir a restauração; os arquivos anteriores foram recuperados. {error}") from error
        except Exception:
            print("[ERRO] Falha ao restaurar o conjunto de planilhas.")
            raise ctx.HTTPException(status_code=500, detail="Falha ao restaurar o conjunto; os arquivos anteriores foram recuperados.") from None


    @router.post("/api/historico-comparacoes/{evento_id}/apelido-manual/{serial}")
    def resolver_divergencia_apelido_manual(
        evento_id: str,
        serial: str,
        payload: ManualAliasConflictResolutionPayload,
    ):
        acao = str(payload.acao or "").strip().lower()
        if acao not in {"manter", "excluir"}:
            raise ctx.HTTPException(status_code=400, detail="Escolha manter ou excluir a alteração manual.")

        serial_key = ctx.normalize_reference_value(serial)
        if not serial_key:
            raise ctx.HTTPException(status_code=400, detail="A série informada é inválida.")

        event = next(
            (item for item in ctx.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        if event is None:
            raise ctx.HTTPException(status_code=404, detail="A atualização selecionada não existe no histórico.")
        comparison = event.get("comparacao")
        divergences = comparison.get("divergencias_apelidos_manuais") if isinstance(comparison, dict) else None
        divergence = next(
            (
                item for item in divergences or []
                if isinstance(item, dict) and ctx.normalize_reference_value(item.get("serie")) == serial_key
            ),
            None,
        )
        if divergence is None:
            raise ctx.HTTPException(status_code=404, detail="A divergência de apelido não existe neste registro.")
        if divergence.get("resolucao") != "pendente":
            raise ctx.HTTPException(status_code=409, detail="Esta divergência já foi resolvida no histórico.")

        expected_manual_alias = str(divergence.get("apelido_manual") or "").strip()
        target_serial = next(
            (
                str(item.get("serial") or key).strip().upper()
                for key, item in ctx.equipamentos_cache.items()
                if ctx.normalize_reference_value(item.get("serial") or key) == serial_key
            ),
            str(serial).strip().upper(),
        )
        targets = [ctx.COMPARISON_HISTORY_FILE, ctx.MODIFIED_APELIDOS_FILE]
        if acao == "excluir":
            details_file = ctx.get_equipamentos_template_file()
            if details_file is None or not details_file.is_file():
                raise ctx.HTTPException(status_code=404, detail="A planilha atual na Simpress não foi encontrada.")
            targets.append(details_file)

        with ctx.inventory_state_transaction(targets) as transaction:
            current_aliases = ctx._manual_aliases_by_serial(ctx.load_modified_apelidos())
            if serial_key not in current_aliases or current_aliases[serial_key] != expected_manual_alias:
                raise ctx.HTTPException(
                    status_code=409,
                    detail="O apelido manual mudou desde esta comparação. Atualize o histórico antes de decidir.",
                )

            if acao == "excluir":
                def remove_manual_override(data):
                    if not isinstance(data, dict):
                        raise RuntimeError("O arquivo de apelidos manuais não contém um objeto válido.")
                    keys = [key for key in data if ctx.normalize_reference_value(key) == serial_key]
                    if len(keys) != 1 or str(data.get(keys[0]) or "").strip() != expected_manual_alias:
                        raise ctx.HTTPException(status_code=409, detail="O override manual mudou desde esta comparação.")
                    updated = dict(data)
                    for key in keys:
                        updated.pop(key, None)
                    return updated

                transaction.update_json(ctx.MODIFIED_APELIDOS_FILE, remove_manual_override, {})

            def mark_divergence_resolved(history):
                if not isinstance(history, list):
                    raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
                updated = list(history)
                stored_event = next((item for item in updated if item.get("id") == evento_id), None)
                if stored_event is None:
                    raise ctx.HTTPException(status_code=409, detail="A atualização foi removida do histórico.")
                stored_comparison = stored_event.get("comparacao")
                stored_divergences = stored_comparison.get("divergencias_apelidos_manuais") if isinstance(stored_comparison, dict) else None
                stored_divergence = next(
                    (
                        item for item in stored_divergences or []
                        if isinstance(item, dict) and ctx.normalize_reference_value(item.get("serie")) == serial_key
                    ),
                    None,
                )
                if stored_divergence is None or stored_divergence.get("resolucao") != "pendente":
                    raise ctx.HTTPException(status_code=409, detail="A divergência já foi alterada no histórico.")
                stored_divergence["resolucao"] = acao
                stored_divergence["horario_resolucao"] = ctx.datetime.now().astimezone().isoformat(timespec="seconds")
                return updated

            transaction.update_json(ctx.COMPARISON_HISTORY_FILE, mark_divergence_resolved, [])
            transaction.apply()
            if acao == "excluir" and not ctx.load_database(transaction_locked=True):
                raise RuntimeError("A base não pôde ser recarregada após excluir o override manual.")
            transaction.commit()

        equipment = next(
            (
                item for key, item in ctx.equipamentos_cache.items()
                if ctx.normalize_reference_value(item.get("serial") or key) == serial_key
            ),
            None,
        )
        return {
            "sucesso": True,
            "resolucao": acao,
            "mensagem": (
                "Apelido manual mantido para esta série."
                if acao == "manter"
                else "Alteração manual removida; o apelido voltou a seguir as planilhas de origem."
            ),
            "equipamento": {
                key: value for key, value in equipment.items() if not key.startswith("_")
            } if equipment else None,
            "total_modificados": len(ctx.load_modified_apelidos()),
        }


    @router.delete("/api/historico-comparacoes/{evento_id}")
    def excluir_comparacao_historica(evento_id: str):
        history = ctx.load_comparison_history()
        if not any(isinstance(item, dict) and item.get("id") == evento_id for item in history):
            raise ctx.HTTPException(status_code=404, detail="A atualização selecionada não existe mais no histórico.")
        try:
            for (record_event_id, _), record in _latest_annotation_records(history).items():
                if record_event_id == evento_id:
                    ctx.save_history_annotation(
                        ctx.HISTORY_ANNOTATIONS_DIR,
                        event_id=evento_id,
                        event_time=str(record.get("horario") or ""),
                        item_id=record["item_id"],
                        serie=str(record.get("serie") or ""),
                        computador=str(record.get("computador") or ""),
                        motivo=str(record.get("motivo") or ""),
                        anotacao="",
                        categoria=str(record.get("categoria") or "apelidos_sem_atualizacao"),
                    )
        except Exception:
            status = 503 if ctx.HISTORY_ANNOTATIONS_SYNC_ENABLED else 500
            raise ctx.HTTPException(status_code=status, detail="Não foi possível limpar as anotações sincronizadas.") from None
        total = ctx.delete_comparison_history_entry(evento_id)
        if total is None:
            raise ctx.HTTPException(status_code=404, detail="A atualização selecionada não existe mais no histórico.")
        return {"sucesso": True, "total": total}

    return router, {
        '_build_comparison_restore_context': _build_comparison_restore_context,
        '_comparison_event_has_restorable_backup': _comparison_event_has_restorable_backup,
        '_comparison_event_type': _comparison_event_type,
        '_comparison_restore_backup_paths': _comparison_restore_backup_paths,
        '_current_inventory_snapshot': _current_inventory_snapshot,
        '_sha256_file': _sha256_file,
        '_validated_comparison_backup_files': _validated_comparison_backup_files,
        'excluir_comparacao_historica': excluir_comparacao_historica,
        'exportar_historico_comparacoes_excel': exportar_historico_comparacoes_excel,
        'get_comparacao_historica': get_comparacao_historica,
        'get_historico_comparacoes': get_historico_comparacoes,
        'salvar_anotacao_comparacao': salvar_anotacao_comparacao_historica,
        'salvar_anotacao_comparacao_historica': salvar_anotacao_comparacao_historica,
        'resolver_divergencia_apelido_manual': resolver_divergencia_apelido_manual,
        'restaurar_comparacao_historica': restaurar_comparacao_historica,
        'visualizar_restauracao_comparacao': visualizar_restauracao_comparacao,
    }
