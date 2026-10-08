"""Search and statistics API routes for the equipment catalog."""

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence

from fastapi import APIRouter, Query


@dataclass(frozen=True)
class EquipmentSearchServices:
    search: Callable[[str], List[Dict[str, Any]]]
    normalize: Callable[[Any], str]
    categories: Sequence[Dict[str, Any]]
    get_stats: Callable[[], Dict[str, Any]]


def create_equipment_search_router(services: EquipmentSearchServices):
    router = APIRouter()

    @router.get("/api/buscar")
    def buscar_seriais(q: str = Query(..., min_length=2)):
        """Busca rápida de seriais/modelos/apelidos/cidades para autocomplete."""
        return services.search(q)[:15]

    @router.get("/api/buscar-expandida")
    def buscar_seriais_expandida(
        q: str = Query(..., min_length=2),
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=100),
        categoria: Optional[str] = Query(None, max_length=40),
        tipo: Optional[str] = Query(None, max_length=80),
        cidade: Optional[str] = Query(None, max_length=120),
        include_filters: bool = False,
    ):
        """Retorna resultados paginados, filtros e total de correspondências."""
        all_results = services.search(q)

        def filter_options(key: str) -> List[str]:
            options: Dict[str, str] = {}
            for item in all_results:
                value = str(item.get(key) or "").strip()
                normalized = services.normalize(value)
                if normalized:
                    options.setdefault(normalized, value)
            return sorted(options.values(), key=services.normalize)

        normalized_category = services.normalize(categoria)
        valid_categories = {entry["value"] for entry in services.categories}
        if normalized_category and normalized_category.lower() not in valid_categories:
            normalized_category = ""
        normalized_type = services.normalize(tipo)
        normalized_city = services.normalize(cidade)
        results = [
            item for item in all_results
            if (not normalized_category or item.get("categoria") == normalized_category.lower())
            and (not normalized_type or services.normalize(item.get("tipo")) == normalized_type)
            and (not normalized_city or services.normalize(item.get("retirada_cidade")) == normalized_city)
        ]
        page = results[offset:offset + limit]
        response = {
            "items": page,
            "total": len(results),
            "offset": offset,
            "limit": limit,
            "has_more": offset + len(page) < len(results),
        }
        if include_filters:
            category_counts = {entry["value"]: 0 for entry in services.categories}
            for item in all_results:
                if item.get("categoria") in category_counts:
                    category_counts[item["categoria"]] += 1
            response["filters"] = {
                "categories": [
                    {**entry, "count": category_counts[entry["value"]]}
                    for entry in services.categories
                ],
                "types": filter_options("tipo"),
                "cities": filter_options("retirada_cidade"),
            }
        return response

    @router.get("/api/stats")
    def get_stats():
        """Retorna métricas da base de dados."""
        return services.get_stats()

    return router, {
        "buscar_seriais": buscar_seriais,
        "buscar_seriais_expandida": buscar_seriais_expandida,
        "get_stats": get_stats,
    }
