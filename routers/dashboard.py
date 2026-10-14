"""Read-only summary used by the Home dashboard panel."""

from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Sequence

from fastapi import APIRouter

ATTENTION_FIELDS = (
    ("divergencias_local", "Divergências com a base local"),
    ("sem_acesso_7_dias", "Sem acesso há 7 dias"),
    ("ausentes_no_endpoint", "Ausentes no endpoint"),
    ("ausentes_em_detalhes", "Ausentes nos detalhes"),
    ("divergencias_apelidos_manuais", "Apelidos manuais divergentes"),
    ("correspondencias_ambiguas", "Correspondências ambíguas"),
    ("series_sem_mapeamento", "Séries sem mapeamento"),
)
TOP_CITIES = 5


@dataclass(frozen=True)
class DashboardServices:
    get_equipment: Callable[[], Sequence[Dict[str, Any]]]
    get_stats: Callable[[], Dict[str, Any]]
    get_comparison_events: Callable[[], Sequence[Dict[str, Any]]]
    categories: Sequence[Dict[str, str]]
    categorize: Callable[[Any, Any], str]


def _count(value: Any) -> int:
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return 0


def build_dashboard(services: DashboardServices) -> Dict[str, Any]:
    equipment = list(services.get_equipment())
    by_category: Counter = Counter()
    by_city: Counter = Counter()
    without_city = 0
    for item in equipment:
        if not isinstance(item, dict):
            continue
        by_category[services.categorize(item.get("tipo"), item.get("modelo"))] += 1
        city = str(item.get("retirada_cidade") or "").strip()
        if city:
            by_city[city] += 1
        else:
            without_city += 1
    categories: List[Dict[str, Any]] = [
        {"value": entry["value"], "label": entry["label"], "total": by_category.get(entry["value"], 0)}
        for entry in services.categories
    ]
    ranked = sorted(by_city.items(), key=lambda pair: (-pair[1], pair[0].casefold()))
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
        latest = {
            "id": event.get("id"),
            "horario": event.get("horario"),
            "tipo": event.get("tipo"),
            "atencao": [
                {"campo": field, "rotulo": label, "total": _count(summary.get(field))}
                for field, label in ATTENTION_FIELDS
                if _count(summary.get(field)) > 0
            ],
        }

    return {
        "base_importada": len(equipment) > 0,
        "total_equipamentos": len(equipment),
        "total_unidades": _count(stats.get("total_unidades")),
        "por_categoria": categories,
        "sem_categoria": by_category.get("", 0),
        "cidades_principais": [{"cidade": city, "total": total} for city, total in ranked[:TOP_CITIES]],
        "total_cidades": len(by_city),
        "sem_cidade": without_city,
        "ultima_atualizacao": stats.get("ultima_atualizacao") or "",
        "arquivo_origem": stats.get("arquivo_origem") or "",
        "ultima_comparacao": latest,
    }


def create_dashboard_router(services: DashboardServices):
    router = APIRouter()

    @router.get("/api/painel")
    def obter_painel():
        """Resumo somente leitura da base para a página inicial."""
        return build_dashboard(services)

    return router, {"obter_painel": obter_painel}
