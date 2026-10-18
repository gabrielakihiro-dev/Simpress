"""Read-only routes that describe local application configuration and readiness."""

from dataclasses import dataclass
from typing import Any, Callable, Dict, Tuple

from fastapi import APIRouter


@dataclass(frozen=True)
class SystemRouteServices:
    get_readiness_status: Callable[[], Dict[str, Any]]
    get_transfer_form_defaults: Callable[[], Dict[str, Any]]


@dataclass(frozen=True)
class SystemRouteExports:
    """Routes exposed to ``main`` for direct calls in tests and helpers."""

    get_readiness_status: Callable[..., Any]
    get_transfer_form_defaults: Callable[..., Any]


def create_system_router(services: SystemRouteServices) -> Tuple[APIRouter, SystemRouteExports]:
    router = APIRouter()

    @router.get("/api/prontidao")
    def get_readiness_status():
        """Expose local file and feature availability for the status panel."""
        return services.get_readiness_status()

    @router.get("/api/config/transferencia")
    def get_transfer_form_defaults():
        """Return the origin contact defaults (environment, then config/contato_origem.json)."""
        return services.get_transfer_form_defaults()

    return router, SystemRouteExports(
        get_readiness_status=get_readiness_status,
        get_transfer_form_defaults=get_transfer_form_defaults,
    )
