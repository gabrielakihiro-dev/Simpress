"""Read-only summary used by the Home dashboard panel."""

from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence

from fastapi import APIRouter, Body, HTTPException

from core.integrity import FileBusyError, FileTransactionError
from domains.usage_metrics import InvalidManualMinutesError, UsageMetricsCorruptionError

ATTENTION_FIELDS = (
    ("divergencias_local", "Divergências com a base local"),
    ("sem_acesso_7_dias", "Sem acesso há 7 dias"),
    ("ausentes_no_endpoint", "Ausentes no endpoint (somente Notebooks e MacBooks)"),
    ("ausentes_em_detalhes", "Ausentes nos detalhes"),
    ("divergencias_apelidos_manuais", "Apelidos manuais divergentes"),
    ("correspondencias_ambiguas", "Correspondências ambíguas"),
    ("series_sem_mapeamento", "Séries sem mapeamento"),
)
TOP_CITIES = None  # lista todas as cidades; o painel limita a altura com rolagem
ENDPOINT_ABSENCE_CATEGORIES = frozenset({"notebook", "macbook"})


@dataclass(frozen=True)
class DashboardServices:
    get_equipment: Callable[[], Sequence[Dict[str, Any]]]
    get_stats: Callable[[], Dict[str, Any]]
    get_comparison_events: Callable[[], Sequence[Dict[str, Any]]]
    categories: Sequence[Dict[str, str]]
    categorize: Callable[[Any, Any], str]
    # Local usage counters (domains/usage_metrics.py); optional so the panel works without them.
    get_usage_summary: Optional[Callable[[], Dict[str, Any]]] = None
    set_manual_minutes: Optional[Callable[[Any], Dict[str, Any]]] = None


def _count(value: Any) -> int:
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return 0


def _endpoint_absences_in_scope(items: Sequence[Any], category_by_serial: Dict[str, str]) -> int:
    """Count endpoint absences whose serial belongs to notebooks or MacBooks in the base."""
    total = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        serials = str(item.get("serie") or "").split(" / ")
        if any(category_by_serial.get(serial.strip().upper()) in ENDPOINT_ABSENCE_CATEGORIES for serial in serials):
            total += 1
    return total


def build_dashboard(services: DashboardServices) -> Dict[str, Any]:
    equipment = list(services.get_equipment())
    by_category: Counter = Counter()
    by_city: Counter = Counter()
    by_city_category: Dict[str, Counter] = {}
    category_by_serial: Dict[str, str] = {}
    without_city = 0
    for item in equipment:
        if not isinstance(item, dict):
            continue
        category = services.categorize(item.get("tipo"), item.get("modelo"))
        by_category[category] += 1
        serial = str(item.get("serial") or "").strip().upper()
        if serial:
            category_by_serial[serial] = category
        city = str(item.get("retirada_cidade") or "").strip()
        if city:
            by_city[city] += 1
            if category:
                by_city_category.setdefault(category, Counter())[city] += 1
        else:
            without_city += 1
    categories: List[Dict[str, Any]] = [
        {"value": entry["value"], "label": entry["label"], "total": by_category.get(entry["value"], 0)}
        for entry in services.categories
    ]
    def top_cities(counter: Counter) -> List[Dict[str, Any]]:
        ranked_cities = sorted(counter.items(), key=lambda pair: (-pair[1], pair[0].casefold()))
        return [{"cidade": city, "total": total} for city, total in ranked_cities[:TOP_CITIES]]

    cities_by_category = {
        entry["value"]: top_cities(by_city_category.get(entry["value"], Counter()))
        for entry in services.categories
    }
    stats = services.get_stats() or {}

    latest = None
    try:
        events = list(services.get_comparison_events())
    except Exception:
        events = []
    if events and isinstance(events[0], dict):
        event = events[0]
        summary_value: Any = event.get("resumo")
        summary: Dict[str, Any] = summary_value if isinstance(summary_value, dict) else {}
        details_value: Any = event.get("comparacao")
        details: Dict[str, Any] = details_value if isinstance(details_value, dict) else {}
        absences_value: Any = details.get("ausentes_no_endpoint")
        totals = {field: _count(summary.get(field)) for field, _ in ATTENTION_FIELDS}
        # Without the detailed list the notebook/MacBook scope cannot be applied, so the row is omitted.
        totals["ausentes_no_endpoint"] = (
            _endpoint_absences_in_scope(absences_value, category_by_serial) if isinstance(absences_value, list) else 0
        )
        latest = {
            "id": event.get("id"),
            "horario": event.get("horario"),
            "tipo": event.get("tipo"),
            "atencao": [
                {"campo": field, "rotulo": label, "total": totals[field]}
                for field, label in ATTENTION_FIELDS
                if totals[field] > 0
            ],
        }

    return {
        "base_importada": len(equipment) > 0,
        "total_equipamentos": len(equipment),
        "total_unidades": _count(stats.get("total_unidades")),
        "por_categoria": categories,
        "sem_categoria": by_category.get("", 0),
        "cidades_principais": top_cities(by_city),
        "cidades_por_categoria": cities_by_category,
        "total_cidades": len(by_city),
        "sem_cidade": without_city,
        "ultima_atualizacao": stats.get("ultima_atualizacao") or "",
        "arquivo_origem": stats.get("arquivo_origem") or "",
        "ultima_comparacao": latest,
        "uso_30_dias": _usage_summary(services),
    }


def _usage_summary(services: DashboardServices) -> Optional[Dict[str, Any]]:
    if services.get_usage_summary is None:
        return None
    try:
        return services.get_usage_summary()
    except Exception:
        # The usage card is optional; the inventory summary must still load.
        return None


def create_dashboard_router(services: DashboardServices):
    router = APIRouter()

    @router.get("/api/painel")
    def obter_painel():
        """Resumo somente leitura da base para a página inicial."""
        return build_dashboard(services)

    if services.set_manual_minutes is not None:
        set_manual_minutes = services.set_manual_minutes

        @router.put("/api/painel/tempos-manuais")
        def salvar_tempos_manuais(payload: Dict[str, Any] = Body(...)):
            """Tempo manual estimado (minutos) por tarefa, usado para estimar as horas economizadas."""
            try:
                return set_manual_minutes(payload.get("tempos_minutos"))
            except InvalidManualMinutesError as error:
                raise HTTPException(status_code=422, detail=str(error)) from None
            except UsageMetricsCorruptionError as error:
                raise HTTPException(status_code=503, detail=str(error)) from None
            except FileBusyError:
                raise HTTPException(status_code=409, detail="As métricas de uso estão sendo gravadas; tente novamente.") from None
            except FileTransactionError:
                raise HTTPException(status_code=503, detail="Não foi possível salvar os tempos; o arquivo de métricas foi preservado.") from None

    return router, {"obter_painel": obter_painel}
