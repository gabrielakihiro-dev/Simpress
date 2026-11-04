"""Endpoint lookup shares the selected equipment and never saves a user."""
from typing import Any, Callable, Collection

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from domains import endpoint_lookup
from domains.equipment_search import categorize_equipment


class ConsultaEndpointPayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128)

    @field_validator("serial")
    @classmethod
    def validar_serial(cls, value: str) -> str:
        if any(ord(c) < 32 for c in value) or not value.strip():
            raise ValueError("Informe um número de série válido.")
        return value.strip().upper()


def create_endpoint_lookup_router(
    get_snapshot: Callable[[str], dict[str, Any]],
    lookup: Callable[[str, bool, Collection[str]], dict[str, Any]] = endpoint_lookup.consultar,
) -> APIRouter:
    router = APIRouter()

    @router.post("/api/endpoint/consultar")
    def consultar_endpoint(payload: ConsultaEndpointPayload) -> dict[str, Any]:
        equipment = get_snapshot(payload.serial)
        macbook = equipment.get("categoria") == "macbook" or categorize_equipment(equipment.get("tipo"), equipment.get("modelo")) == "macbook"
        details_serials = tuple(equipment["details_serials"])
        if equipment.get("serie_detalhes_duplicada"):
            details_serials += (payload.serial,)
        try:
            result = lookup(payload.serial, macbook, details_serials)
            if result.pop("_fallback_mac", False):
                try:
                    current = get_snapshot(payload.serial)
                except HTTPException as error:
                    if error.status_code != 404:
                        raise
                    current = None
                if current != equipment:
                    return {"status": "ambiguous", "serial": payload.serial, "origem": "base_local"}
            return result
        except endpoint_lookup.automation.TravaOcupada:
            raise HTTPException(409, "O Chrome está ocupado por outra automação. Tente novamente ao terminar.") from None
        except Exception:
            raise HTTPException(503, "Não foi possível consultar o Endpoint. Confira o Chrome de automação, o login e a coluna Usuário do último logon.") from None

    return router
