"""Monthly report export for the contract manager (docs/operacao/relatorio-mensal.md)."""

from dataclasses import dataclass
from datetime import date, datetime
import json
import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from core.errors import DomainBusyError
from domains.monthly_report import build_monthly_report, build_monthly_report_workbook, parse_report_month

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


def create_monthly_report_router(services: MonthlyReportServices) -> APIRouter:
    router = APIRouter()

    @router.get("/api/relatorio-mensal")
    def exportar_relatorio_mensal(mes: str = Query(..., max_length=7)) -> StreamingResponse:
        month = parse_report_month(mes, services.today())
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
        output, filename = build_monthly_report_workbook(report)
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return router
