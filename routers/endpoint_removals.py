"""Routes to discard (and restore) duplicated Endpoint hostnames."""

from fastapi import APIRouter
from pydantic import BaseModel, Field

from domains import endpoint_removals
from domains.endpoint_removals import EndpointRemovalServices


class HostnameRemovalPayload(BaseModel):
    serie: str = Field(..., min_length=1, max_length=endpoint_removals.MAX_SERIAL_LENGTH)
    hostname: str = Field(..., min_length=1, max_length=endpoint_removals.MAX_HOSTNAME_LENGTH)


def create_endpoint_removals_router(services: EndpointRemovalServices) -> APIRouter:
    router = APIRouter()

    @router.get("/api/endpoint/hostnames-removidos")
    def listar_hostnames_removidos():
        """Pares série/hostname descartados das duplicidades do Endpoint."""
        return endpoint_removals.list_removals(services)

    @router.post("/api/endpoint/hostnames-removidos")
    def remover_hostname(payload: HostnameRemovalPayload):
        """Descarta um hostname duplicado; o restante vale na base e nas exportações."""
        return endpoint_removals.remove_endpoint_hostname(services, payload.serie, payload.hostname)

    @router.post("/api/endpoint/hostnames-removidos/restaurar")
    def restaurar_hostname(payload: HostnameRemovalPayload):
        """Desfaz o descarte de um hostname."""
        return endpoint_removals.restore_endpoint_hostname(services, payload.serie, payload.hostname)

    return router
