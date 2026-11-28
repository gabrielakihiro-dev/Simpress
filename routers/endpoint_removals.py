"""Routes to discard (and restore) duplicated Endpoint hostnames."""

from typing import Any, Callable, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StrictBool

from core.errors import DomainError
from domains import endpoint_remocao, endpoint_removals
from domains.endpoint_removals import EndpointRemovalServices


class HostnameRemovalPayload(BaseModel):
    serie: str = Field(..., min_length=1, max_length=endpoint_removals.MAX_SERIAL_LENGTH)
    hostname: str = Field(..., min_length=1, max_length=endpoint_removals.MAX_HOSTNAME_LENGTH)


class EndpointComputerRemovalPayload(HostnameRemovalPayload):
    # Sem ``confirmado: true`` só simula: confere o diálogo do Endpoint e clica em Cancelar.
    confirmado: StrictBool = False


def create_endpoint_removals_router(
    services: EndpointRemovalServices,
    remover_no_endpoint: Callable[..., Dict[str, Any]] = endpoint_remocao.remover_computador,
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/endpoint/hostnames-removidos")
    def listar_hostnames_removidos():
        """Pares série/hostname descartados das duplicidades do Endpoint."""
        return endpoint_removals.list_removals(services)

    @router.post("/api/endpoint/hostnames-removidos")
    def remover_hostname(payload: HostnameRemovalPayload):
        """Descarta um hostname duplicado; o restante vale na base e nas exportações."""
        return endpoint_removals.remove_endpoint_hostname(services, payload.serie, payload.hostname)

    @router.post("/api/endpoint/hostnames-removidos/remover-no-endpoint")
    def remover_no_endpoint_central(payload: EndpointComputerRemovalPayload):
        """Remove o computador antigo no Endpoint Central (Chrome de automação) e só então grava o par local."""
        automacao = endpoint_remocao.automation

        def remover(
            hostname: str, confirmado: bool, corte: str,
            antes_do_clique: Callable[[], None], apos_trava: Callable[[], None],
        ) -> Dict[str, Any]:
            aba = " Se a aba do Endpoint ficou com o diálogo de remoção aberto, clique em Cancel."
            try:
                nome = endpoint_remocao.validar_hostname(hostname)
            except ValueError as erro:
                raise HTTPException(422, str(erro)) from None
            try:
                return remover_no_endpoint(
                    nome, confirmado, corte=corte, antes_do_clique=antes_do_clique, apos_trava=apos_trava
                )
            except DomainError:
                raise  # par pendente relido depois da trava (409)
            except automacao.TravaOcupada:
                raise HTTPException(409, "O Chrome está ocupado por outra automação. Tente novamente ao terminar.") from None
            except automacao.RotinaEncerrada as erro:
                raise HTTPException(409, f"{erro}{aba}") from None
            except Exception:
                # Erros antes do clique final (depois dele a rotina devolve ``incerto``): nada foi removido.
                raise HTTPException(
                    503, f"Não foi possível remover no Endpoint. Confira o Chrome de automação (porta 9333) e o login no Endpoint.{aba}"
                ) from None

        return endpoint_removals.remove_in_endpoint(
            services, payload.serie, payload.hostname, payload.confirmado is True, remover
        )

    @router.post("/api/endpoint/hostnames-removidos/restaurar")
    def restaurar_hostname(payload: HostnameRemovalPayload):
        """Desfaz o descarte de um hostname (só a lista local; não desfaz a remoção no Endpoint Central)."""
        return endpoint_removals.restore_endpoint_hostname(services, payload.serie, payload.hostname)

    return router
