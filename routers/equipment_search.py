"""Search and statistics API routes for the equipment catalog."""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query


def create_equipment_search_router(ctx):
    router = APIRouter()

    @router.get("/api/buscar")
    def buscar_seriais(q: str = Query(..., min_length=2)):
        """Busca rápida de seriais/modelos/apelidos/cidades para autocomplete."""
        return ctx._buscar_equipamentos_por_termo(q)[:15]

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
        all_results = ctx._buscar_equipamentos_por_termo(q)

        def filter_options(key: str) -> List[str]:
            options: Dict[str, str] = {}
            for item in all_results:
                value = str(item.get(key) or "").strip()
                normalized = ctx._normalizar_termo_busca(value)
                if normalized:
                    options.setdefault(normalized, value)
            return sorted(options.values(), key=ctx._normalizar_termo_busca)

        normalized_category = ctx._normalizar_termo_busca(categoria)
        valid_categories = {entry["value"] for entry in ctx._CATEGORIAS_EQUIPAMENTO}
        if normalized_category and normalized_category.lower() not in valid_categories:
            normalized_category = ""
        normalized_type = ctx._normalizar_termo_busca(tipo)
        normalized_city = ctx._normalizar_termo_busca(cidade)
        results = [
            item for item in all_results
            if (not normalized_category or item.get("categoria") == normalized_category.lower())
            and (not normalized_type or ctx._normalizar_termo_busca(item.get("tipo")) == normalized_type)
            and (not normalized_city or ctx._normalizar_termo_busca(item.get("retirada_cidade")) == normalized_city)
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
            category_counts = {entry["value"]: 0 for entry in ctx._CATEGORIAS_EQUIPAMENTO}
            for item in all_results:
                if item.get("categoria") in category_counts:
                    category_counts[item["categoria"]] += 1
            response["filters"] = {
                "categories": [
                    {**entry, "count": category_counts[entry["value"]]}
                    for entry in ctx._CATEGORIAS_EQUIPAMENTO
                ],
                "types": filter_options("tipo"),
                "cities": filter_options("retirada_cidade"),
            }
        return response

    @router.get("/api/stats")
    def get_stats():
        """Retorna métricas da base de dados."""
        export_counts = ctx.count_export_changes()
        export_status = ctx.get_export_status()
        with ctx.STATE_LOCK:
            stats_snapshot = ctx.deepcopy(ctx.stats_cache)
            unit_count = len(ctx.unidades_cache)
        return {
            **stats_snapshot,
            "exportacao_disponivel": export_status["available"],
            "exportacao_motivo": export_status["reason"],
            "total_apelidos_modificados": export_counts["apelidos"],
            "total_id_clientes_modificados": export_counts["id_clientes"],
            "total_alteracoes_exportaveis": export_counts["total"],
            "total_unidades": unit_count,
        }

    return router, {
        "buscar_seriais": buscar_seriais,
        "buscar_seriais_expandida": buscar_seriais_expandida,
        "get_stats": get_stats,
    }
