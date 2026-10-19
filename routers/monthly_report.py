"""Monthly report export for the contract manager (docs/operacao/relatorio-mensal.md)."""

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from io import BytesIO
import json
import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

import openpyxl

from core.errors import DomainBusyError
from core.integrity import AtomicFileTransaction
from domains.monthly_report import (
    ReportMonth,
    build_monthly_report,
    build_monthly_report_workbook,
    parse_report_month,
    report_filename,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MonthlyReportServices:
    # (equipment entries, stats) from the official EquipamentosDetalhes cache.
    inventory_snapshot: Callable[[], Tuple[List[Dict[str, Any]], Dict[str, Any]]]
    load_comparison_history: Callable[[], List[Dict[str, Any]]]
    comparison_history_for_display: Callable[[Dict[str, Any]], Dict[str, Any]]
    ticket_report_path: Callable[[], Path]
    read_usage_metrics: Callable[[], Dict[str, Any]]
    today: Callable[[], date] = date.today
    now: Callable[[], datetime] = datetime.now


def _read_ticket_report(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise DomainBusyError("O acompanhamento de chamados não pôde ser lido.") from None
    if not isinstance(data, dict):
        raise DomainBusyError("O acompanhamento de chamados está inválido.")
    return data


def _build_workbook(services: MonthlyReportServices, month: ReportMonth) -> Tuple[BytesIO, str]:
    equipment, stats = services.inventory_snapshot()
    if not equipment:
        raise DomainBusyError("A base oficial EquipamentosDetalhes não está carregada.")
    try:
        usage = services.read_usage_metrics()
    except (OSError, ValueError) as error:
        # Unreadable metrics never block the report; the usage block shows zeros.
        logger.warning("Métricas de uso ilegíveis no relatório mensal (erro=%s).", type(error).__name__)
        usage = {}
    report = build_monthly_report(
        month,
        equipment=equipment,
        stats=stats,
        comparison_history=services.load_comparison_history(),
        comparison_display=services.comparison_history_for_display,
        ticket_report=_read_ticket_report(services.ticket_report_path()),
        usage_store=usage,
        generated_at=services.now(),
    )
    return build_monthly_report_workbook(report)


def previous_report_month(today: date) -> ReportMonth:
    last_day = today.replace(day=1) - timedelta(days=1)
    return ReportMonth(last_day.year, last_day.month)


def _validate_workbook(path: Path) -> None:
    # Opened as a stream: the staged temp file does not carry the .xlsx extension.
    with path.open("rb") as handle:
        openpyxl.load_workbook(handle, read_only=True).close()


def generate_previous_month_report(
    services: MonthlyReportServices,
    reports_dir: Path,
    transaction_root: Path,
) -> Optional[Path]:
    """Save last month's report once; returns the new file, or None when nothing was written.

    An existing file is never replaced. Without the official base the run is skipped and the
    next check tries again, so the report is never saved with an empty inventory.
    """
    month = previous_report_month(services.today())
    target = reports_dir / report_filename(month)
    if target.exists():
        return None
    try:
        output, _filename = _build_workbook(services, month)
    except DomainBusyError as error:
        logger.info("Relatório mensal de %s adiado: %s", month.key, error)
        return None
    reports_dir.mkdir(parents=True, exist_ok=True)
    with AtomicFileTransaction(transaction_root, [target]) as transaction:
        # Re-checked under the lock: another process may have saved it meanwhile.
        if target.exists():
            return None
        transaction.stage_bytes(target, output.getvalue(), _validate_workbook)
        transaction.commit()
    logger.info("Relatório mensal de %s gerado automaticamente em %s.", month.key, target.name)
    return target


def create_monthly_report_router(services: MonthlyReportServices) -> APIRouter:
    router = APIRouter()

    @router.get("/api/relatorio-mensal")
    def exportar_relatorio_mensal(mes: str = Query(..., max_length=7)) -> StreamingResponse:
        month = parse_report_month(mes, services.today())
        output, filename = _build_workbook(services, month)
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return router
