"""History, attention queue, filtering, and export for ticket reports."""

from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime
from hashlib import sha256
from io import BytesIO
import json
import re
import unicodedata
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from uuid import uuid4

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


MAX_TICKET_SNAPSHOTS = 50
TICKET_SNAPSHOT_FIELDS = ("atualizado_em", "fontes", "resumo", "chamados")
ORACLE_CHANGE_FIELDS = (
    ("solicitacao", "Solicitação Oracle"),
    ("ordem_servico", "OS Oracle"),
    ("status", "Status Oracle"),
    ("sub_status", "Sub-status Oracle"),
    ("fila", "Fila Oracle"),
    ("fase_atendimento", "Fase Oracle"),
    ("status_entregas", "Status das entregas"),
    ("status_atividades", "Status das atividades"),
    ("assunto", "Assunto Oracle"),
    ("data_criacao", "Criação Oracle"),
    ("ultima_atualizacao", "Última atualização Oracle"),
    ("data_conclusao", "Conclusão Oracle"),
)
SIMPRESS_CHANGE_FIELDS = (
    ("pedidos", "Pedidos Simpress"),
    ("ordens_servico", "OS Simpress"),
    ("chamados_cliente", "Chamados do cliente"),
    ("status", "Status Simpress"),
    ("datas_pedido", "Datas dos pedidos"),
    ("modelos", "Modelos Simpress"),
)


def _stable_serial(value: Any) -> str:
    plain = unicodedata.normalize("NFKD", str(value or ""))
    ascii_value = plain.encode("ascii", "ignore").decode("ascii").upper()
    return re.sub(r"[^A-Z0-9]+", "", ascii_value)


def _normalized_text(value: Any) -> str:
    plain = unicodedata.normalize("NFKD", str(value or ""))
    return " ".join(plain.encode("ascii", "ignore").decode("ascii").casefold().split())


def _ticket_snapshot(report: Dict[str, Any], snapshot_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if not isinstance(report, dict) or not isinstance(report.get("chamados"), list):
        return None
    snapshot = {field: deepcopy(report.get(field)) for field in TICKET_SNAPSHOT_FIELDS}
    snapshot["atualizado_em"] = str(snapshot.get("atualizado_em") or "")
    existing_id = snapshot_id or report.get("snapshot_id")
    if not existing_id:
        fingerprint = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        existing_id = "legado-" + sha256(fingerprint.encode("utf-8")).hexdigest()[:20]
    snapshot["id"] = str(existing_id)
    return snapshot


def ticket_report_snapshots(report: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return ordered snapshots, including the latest report when migrating legacy data."""
    snapshots: List[Dict[str, Any]] = []
    raw_history = report.get("historico") if isinstance(report, dict) else None
    if isinstance(raw_history, list):
        for item in raw_history:
            snapshot = _ticket_snapshot(item, item.get("id") if isinstance(item, dict) else None)
            if snapshot:
                snapshots.append(snapshot)

    has_imported_current = bool(
        isinstance(report, dict)
        and (report.get("atualizado_em") or report.get("fontes") or report.get("snapshot_id") or report.get("chamados"))
    )
    current = _ticket_snapshot(report) if has_imported_current else None
    if current and not any(item["id"] == current["id"] for item in snapshots):
        snapshots.append(current)

    # Keep the newest occurrence of an ID while preserving chronological order.
    unique: Dict[str, Dict[str, Any]] = {}
    for snapshot in snapshots:
        unique[snapshot["id"]] = snapshot
    ordered = list(unique.values())
    return ordered[-MAX_TICKET_SNAPSHOTS:]


def ticket_snapshot_metadata(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    sources = snapshot.get("fontes") or {}
    summary = snapshot.get("resumo") or {}
    return {
        "id": snapshot.get("id", ""),
        "atualizado_em": snapshot.get("atualizado_em", ""),
        "fontes": {
            "simpress": deepcopy((sources.get("simpress") or {}).get("arquivo", "")),
            "oracle": deepcopy((sources.get("oracle") or {}).get("arquivo", "")),
        },
        "resumo": deepcopy(summary),
    }


def _parse_date(value: Any) -> Optional[date]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        pass
    for pattern in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def _is_closed(ticket: Dict[str, Any]) -> bool:
    text = _normalized_text(f"{ticket.get('status', '')} {ticket.get('sub_status', '')}")
    return any(token in text for token in (
        "conclu", "encerr", "finaliz", "cancel", "resolvid", "fechad", "closed", "complete",
    ))


def ticket_attention(
    ticket: Dict[str, Any],
    *,
    stale_days: int = 7,
    today: Optional[date] = None,
) -> Dict[str, Any]:
    """Classify operational risk without interpreting a missing row as a resolution."""
    oracle = ticket.get("oracle") if isinstance(ticket.get("oracle"), list) else []
    active = [item for item in oracle if isinstance(item, dict) and not _is_closed(item)]
    update_dates = [_parse_date(item.get("ultima_atualizacao")) for item in active]
    update_dates = [value for value in update_dates if value is not None]
    latest_date = max(update_dates) if update_dates else None
    reference = today or datetime.now().astimezone().date()
    age = max(0, (reference - latest_date).days) if latest_date else None
    is_stale = bool(active and ((age is not None and age >= max(0, stale_days)) or latest_date is None))

    relation = str(ticket.get("relacao") or "")
    issue_priority = {
        "divergente": 0,
        "sem_os": 1,
        "somente_oracle": 3,
        "somente_simpress": 4,
        "conferida": 5,
    }.get(relation, 5)
    if is_stale:
        priority = min(issue_priority, 2)
        freshness_label = "Sem data de atualização" if age is None else f"Sem atualização há {age} dias"
    else:
        priority = issue_priority
        freshness_label = ""

    relation_label = {
        "divergente": "OS divergente",
        "sem_os": "Sem OS",
        "somente_oracle": "Somente Oracle",
        "somente_simpress": "Somente Simpress",
        "conferida": "OS conferida",
    }.get(relation, "Revisar chamado")
    reasons = [relation_label] if relation != "conferida" else []
    if is_stale:
        reasons.append(freshness_label)
    if not reasons:
        reasons.append("Em acompanhamento")

    return {
        "prioridade": priority,
        "em_atencao": relation != "conferida" or is_stale,
        "desatualizado": is_stale,
        "dias_sem_atualizacao": age,
        "ultima_atualizacao": latest_date.isoformat() if latest_date else "",
        "motivo": " · ".join(reasons),
    }


def _walk_values(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for nested in value.values():
            yield from _walk_values(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_values(nested)
    elif value is not None:
        yield str(value)


def filter_ticket_records(
    tickets: Sequence[Dict[str, Any]],
    *,
    relation: str = "",
    status: str = "",
    queue: str = "",
    search: str = "",
    stale_days: int = 7,
    age_filter: str = "",
    attention_only: bool = False,
    today: Optional[date] = None,
) -> List[Dict[str, Any]]:
    relation_filter = _normalized_text(relation)
    status_filter = _normalized_text(status)
    queue_filter = _normalized_text(queue)
    query = _normalized_text(search)
    minimum_age = int(age_filter) if str(age_filter).isdigit() else None
    missing_age = str(age_filter) == "sem_data"
    matched: List[Tuple[Tuple[int, int, str], Dict[str, Any]]] = []

    for ticket in tickets:
        if not isinstance(ticket, dict):
            continue
        oracle = [item for item in ticket.get("oracle", []) if isinstance(item, dict)]
        attention = ticket_attention(ticket, stale_days=stale_days, today=today)
        if relation_filter and _normalized_text(ticket.get("relacao")) != relation_filter:
            continue
        if (status_filter or queue_filter) and not any(
            (not status_filter or _normalized_text(item.get("status")) == status_filter)
            and (not queue_filter or _normalized_text(item.get("fila")) == queue_filter)
            for item in oracle
        ):
            continue
        if attention_only and not attention["em_atencao"]:
            continue
        active_oracle = [item for item in oracle if not _is_closed(item)]
        if missing_age and not (active_oracle and attention["dias_sem_atualizacao"] is None):
            continue
        if minimum_age is not None and not (
            attention["dias_sem_atualizacao"] is not None
            and attention["dias_sem_atualizacao"] >= minimum_age
        ):
            continue
        if query and query not in _normalized_text(" ".join(_walk_values(ticket))):
            continue
        age = attention["dias_sem_atualizacao"] or 0
        matched.append(((attention["prioridade"], -age, _normalized_text(ticket.get("serie"))), ticket))

    matched.sort(key=lambda item: item[0])
    return [ticket for _, ticket in matched]


def _ticket_field_values(ticket: Dict[str, Any], field: str, source: str) -> List[str]:
    if source == "simpress":
        values = (ticket.get("simpress") or {}).get(field, [])
        return sorted({str(item) for item in values if str(item)}, key=_normalized_text)
    values = [item.get(field, "") for item in ticket.get("oracle", []) if isinstance(item, dict)]
    return sorted({str(item) for item in values if str(item)}, key=_normalized_text)


def _oracle_ticket_rows(ticket: Dict[str, Any]) -> List[Dict[str, str]]:
    rows = []
    for oracle in ticket.get("oracle", []):
        if not isinstance(oracle, dict):
            continue
        rows.append({field: str(oracle.get(field, "") or "") for field, _label in ORACLE_CHANGE_FIELDS})
    return sorted(rows, key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True))


def compare_ticket_snapshots(previous: Dict[str, Any], current: Dict[str, Any]) -> Dict[str, Any]:
    previous_by_serial = {
        _stable_serial(item.get("serie")): item
        for item in previous.get("chamados", [])
        if isinstance(item, dict) and _stable_serial(item.get("serie"))
    }
    current_by_serial = {
        _stable_serial(item.get("serie")): item
        for item in current.get("chamados", [])
        if isinstance(item, dict) and _stable_serial(item.get("serie"))
    }
    before_keys, after_keys = set(previous_by_serial), set(current_by_serial)
    new_rows = [current_by_serial[key].get("serie", key) for key in sorted(after_keys - before_keys)]
    absent_rows = [previous_by_serial[key].get("serie", key) for key in sorted(before_keys - after_keys)]
    unchanged: List[str] = []
    changed: List[Dict[str, Any]] = []

    for key in sorted(before_keys & after_keys):
        old, new = previous_by_serial[key], current_by_serial[key]
        fields: List[Dict[str, Any]] = []
        if old.get("relacao") != new.get("relacao"):
            fields.append({"campo": "Relação das OS", "anterior": old.get("relacao", ""), "atual": new.get("relacao", "")})
        for field, label in SIMPRESS_CHANGE_FIELDS:
            old_values = _ticket_field_values(old, field, "simpress")
            new_values = _ticket_field_values(new, field, "simpress")
            if old_values != new_values:
                fields.append({"campo": label, "anterior": old_values, "atual": new_values})
        for field, label in ORACLE_CHANGE_FIELDS:
            old_values = _ticket_field_values(old, field, "oracle")
            new_values = _ticket_field_values(new, field, "oracle")
            if old_values != new_values:
                fields.append({"campo": label, "anterior": old_values, "atual": new_values})
        old_oracle_rows = _oracle_ticket_rows(old)
        new_oracle_rows = _oracle_ticket_rows(new)
        if old_oracle_rows != new_oracle_rows and not fields:
            fields.append({
                "campo": "Vínculo entre solicitações Oracle",
                "anterior": old_oracle_rows,
                "atual": new_oracle_rows,
            })
        if fields:
            changed.append({"serie": new.get("serie", old.get("serie", key)), "campos": fields})
        else:
            unchanged.append(new.get("serie", key))

    return {
        "anterior": ticket_snapshot_metadata(previous),
        "atual": ticket_snapshot_metadata(current),
        "contagens": {
            "novos": len(new_rows),
            "alterados": len(changed),
            "iguais": len(unchanged),
            "ausentes_arquivo": len(absent_rows),
        },
        "mudancas": {
            "novos": new_rows,
            "alterados": changed,
            "iguais": unchanged,
            "ausentes_arquivo": absent_rows,
        },
        "aviso_ausentes": "Ausência na planilha atual não confirma que o chamado foi resolvido.",
    }


def _safe_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool, date, datetime)):
        result = str(value) if isinstance(value, (str, int, float, bool)) else value.isoformat()
    else:
        result = ", ".join(str(item) for item in value) if isinstance(value, list) else str(value)
    if isinstance(result, str) and result.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + result
    return result


def build_ticket_workbook(snapshot: Dict[str, Any], tickets: Sequence[Dict[str, Any]], filters: Dict[str, Any]) -> bytes:
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Resumo"
    summary.append(["Acompanhamento de Chamados"])
    summary.append(["Versão importada", snapshot.get("atualizado_em", "")])
    sources = snapshot.get("fontes") or {}
    summary.append(["Arquivo Simpress", (sources.get("simpress") or {}).get("arquivo", "")])
    summary.append(["Arquivo Oracle", (sources.get("oracle") or {}).get("arquivo", "")])
    summary.append(["Séries no resultado", len(tickets)])
    for label, key in (("Relação", "relation"), ("Status Oracle", "status"), ("Fila Oracle", "queue"), ("Atualização", "age_filter"), ("Busca", "search"), ("Somente atenção", "attention_only")):
        value = filters.get(key, "")
        if value not in (None, "", False):
            summary.append([label, str(value)])
    summary.column_dimensions["A"].width = 24
    summary.column_dimensions["B"].width = 48

    sheet = workbook.create_sheet("Chamados")
    headers = [
        "Série", "Atenção", "Relação", "Pedidos Simpress", "OS Simpress", "Chamado do cliente", "Status Simpress", "Data do pedido", "Modelo",
        "Solicitação Oracle", "OS Oracle", "Status Oracle", "Sub-status Oracle", "Fila Oracle",
        "Fase Oracle", "Última atualização Oracle", "Status entregas", "Status atividades", "Assunto",
    ]
    sheet.append(headers)
    for ticket in tickets:
        oracle_rows = [item for item in ticket.get("oracle", []) if isinstance(item, dict)] or [{}]
        simpress = ticket.get("simpress") or {}
        attention = ticket_attention(ticket, stale_days=int(filters.get("stale_days", 7)))
        for oracle in oracle_rows:
            values = [
                ticket.get("serie", ""), attention["motivo"], ticket.get("relacao", ""),
                simpress.get("pedidos", []), simpress.get("ordens_servico", []), simpress.get("chamados_cliente", []),
                simpress.get("status", []), simpress.get("datas_pedido", []), simpress.get("modelos", []),
                oracle.get("solicitacao", ""), oracle.get("ordem_servico", ""), oracle.get("status", ""),
                oracle.get("sub_status", ""), oracle.get("fila", ""), oracle.get("fase_atendimento", ""),
                oracle.get("ultima_atualizacao", ""), oracle.get("status_entregas", ""),
                oracle.get("status_atividades", ""), oracle.get("assunto", ""),
            ]
            sheet.append([_safe_cell(value) for value in values])
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    sheet.row_dimensions[1].height = 30
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="166534")
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for index, width in enumerate((18, 36, 20, 24, 20, 24, 24, 22, 28, 22, 18, 24, 24, 24, 24, 24, 22, 22, 40), start=1):
        sheet.column_dimensions[get_column_letter(index)].width = width
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()
