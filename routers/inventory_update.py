"""Routes for inventory spreadsheet preview, update and database reloading."""

from dataclasses import dataclass
from typing import Any, Callable, Coroutine, Dict, Optional, Tuple

from fastapi import APIRouter, File, Form, UploadFile


@dataclass(frozen=True)
class InventoryUpdateRouteServices:
    preview: Callable[[UploadFile, UploadFile], Coroutine[Any, Any, Any]]
    update: Callable[[UploadFile, UploadFile, Optional[str]], Coroutine[Any, Any, Any]]
    reload_base: Callable[[], Dict[str, Any]]


@dataclass(frozen=True)
class InventoryUpdateRouteExports:
    previsualizar_planilhas: Callable[..., Any]
    atualizar_planilhas: Callable[..., Any]
    recarregar_base: Callable[[], Dict[str, Any]]


def create_inventory_update_router(services: InventoryUpdateRouteServices) -> Tuple[APIRouter, InventoryUpdateRouteExports]:
    router = APIRouter()

    @router.post("/api/planilhas/previsualizar")
    async def previsualizar_planilhas_endpoint(
        endpoint_file: UploadFile = File(...),
        details_file: UploadFile = File(...),
    ) -> Any:
        return await services.preview(endpoint_file, details_file)

    @router.post("/api/planilhas/atualizar")
    async def atualizar_planilhas_endpoint(
        endpoint_file: UploadFile = File(...),
        details_file: UploadFile = File(...),
        preview_token: str = Form(..., min_length=66, max_length=90),
    ) -> Any:
        return await services.update(endpoint_file, details_file, preview_token)

    @router.post("/api/recarregar-base")
    def recarregar_base_endpoint() -> Dict[str, Any]:
        return services.reload_base()

    exports = InventoryUpdateRouteExports(
        previsualizar_planilhas=services.preview,
        atualizar_planilhas=services.update,
        recarregar_base=services.reload_base,
    )
    return router, exports
