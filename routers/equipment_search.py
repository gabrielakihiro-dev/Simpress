"""Search and statistics API routes for the equipment catalog."""

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from fastapi import APIRouter, HTTPException, Query


@dataclass(frozen=True)
class EquipmentSearchServices:
    search: Callable[[str], List[Dict[str, Any]]]
    normalize: Callable[[Any], str]
    categories: Sequence[Dict[str, Any]]
    get_stats: Callable[[], Dict[str, Any]]
    # Every equipment of the base, in index order; lists the ones without a user without a term.
    list_all: Optional[Callable[[], List[Dict[str, Any]]]] = None


USER_FILTERS = ("sem", "com")
NOTEBOOK_CATEGORIES = ("notebook", "macbook")
# Fones and "Micro Computador" (the monitors) stay out of the listing without a term.
LISTING_EXCLUDED_CATEGORIES = ("fone", "monitor")
LISTING_EXCLUDED_TYPE = "MICRO COMPUTADOR"


@dataclass(frozen=True)
class EquipmentSearchRouteExports:
    """Routes exposed to ``main`` for direct calls in tests and helpers."""

    buscar_seriais: Callable[..., Any]
    buscar_seriais_expandida: Callable[..., Any]
    get_stats: Callable[..., Any]


def create_equipment_search_router(services: EquipmentSearchServices) -> Tuple[APIRouter, EquipmentSearchRouteExports]:
    router = APIRouter()

    @router.get("/api/buscar")
    def buscar_seriais(q: str = Query(..., min_length=2)):
        """Busca rápida de seriais/modelos/apelidos/cidades para autocomplete."""
        return services.search(q)[:15]

    @router.get("/api/buscar-expandida")
    def buscar_seriais_expandida(
        q: str = Query("", max_length=200),
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=100),
        categoria: Optional[str] = Query(None, max_length=40),
        tipo: Optional[str] = Query(None, max_length=80),
        cidade: Optional[str] = Query(None, max_length=120),
        usuario: Optional[str] = Query(None, max_length=10),
        include_filters: bool = False,
    ):
        """Retorna resultados paginados, filtros e total de correspondências.

        ``usuario=sem`` mantém só os equipamentos sem usuário (nem do Endpoint nem manual);
        ``usuario=com`` mantém os que têm usuário. Sem termo, ``usuario=sem`` lista os notebooks
        sem usuário e os demais equipamentos da base, exceto fones e micro computador (monitor).
        """
        user_filter = str(usuario or "").strip().lower()
        if user_filter not in USER_FILTERS:
            user_filter = ""
        list_without_term = not q.strip() and user_filter == "sem" and services.list_all is not None
        if not list_without_term and len(q) < 2:
            raise HTTPException(status_code=422, detail="Digite ao menos 2 caracteres para pesquisar.")

        def has_user(item: Dict[str, Any]) -> bool:
            return bool(str(item.get("usuarios_logados") or "").strip())

        def in_listing(item: Dict[str, Any]) -> bool:
            if item.get("categoria") in LISTING_EXCLUDED_CATEGORIES:
                return False
            if services.normalize(item.get("tipo")) == LISTING_EXCLUDED_TYPE:
                return False
            return item.get("categoria") not in NOTEBOOK_CATEGORIES or not has_user(item)

        if list_without_term and services.list_all:
            all_results = [item for item in services.list_all() if in_listing(item)]
        else:
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
            and (list_without_term or not user_filter or has_user(item) == (user_filter == "com"))
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
            listed_categories = [
                entry for entry in services.categories
                if not (list_without_term and entry["value"] in LISTING_EXCLUDED_CATEGORIES)
            ]
            category_counts = {entry["value"]: 0 for entry in listed_categories}
            for item in all_results:
                if item.get("categoria") in category_counts:
                    category_counts[item["categoria"]] += 1
            response["filters"] = {
                "categories": [
                    {**entry, "count": category_counts[entry["value"]]}
                    for entry in listed_categories
                ],
                "types": filter_options("tipo"),
                "cities": filter_options("retirada_cidade"),
                "users": {
                    "sem": len(all_results) if list_without_term else sum(1 for item in all_results if not has_user(item)),
                    "com": 0 if list_without_term else sum(1 for item in all_results if has_user(item)),
                },
            }
        return response

    @router.get("/api/stats")
    def get_stats():
        """Retorna métricas da base de dados."""
        return services.get_stats()

    return router, EquipmentSearchRouteExports(
        buscar_seriais=buscar_seriais,
        buscar_seriais_expandida=buscar_seriais_expandida,
        get_stats=get_stats,
    )
