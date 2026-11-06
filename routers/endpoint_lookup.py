"""Endpoint lookup shares the selected equipment and never saves a user."""
import re
from typing import Any, Callable, Collection, Literal

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


class PowerShellPayload(BaseModel):
    hostname: str | None = Field(None, max_length=64)
    modo: Literal["sistema", "usuario"]
    comando: str = Field(..., min_length=1, max_length=endpoint_lookup.LIMITE_COMANDO_POWERSHELL)
    usuario: str | None = Field(None, max_length=128)

    @field_validator("hostname")
    @classmethod
    def validar_hostname(cls, value: str | None) -> str | None:
        value = (value or "").strip().upper()
        if value and not re.fullmatch(r"[A-Z0-9_.-]+", value):
            raise ValueError("Informe um hostname válido.")
        return value or None

    @field_validator("usuario")
    @classmethod
    def validar_usuario(cls, value: str | None) -> str | None:
        return (value or "").strip() or None

    @field_validator("comando")
    @classmethod
    def validar_comando(cls, value: str) -> str:
        return endpoint_lookup.validar_comando(value)


def create_endpoint_lookup_router(
    get_snapshot: Callable[[str], dict[str, Any]],
    lookup: Callable[[str, bool, Collection[str]], dict[str, Any]] = endpoint_lookup.consultar,
    remote_control: Callable[..., dict[str, Any]] = endpoint_lookup.controle_remoto,
    powershell: Callable[..., dict[str, Any]] = endpoint_lookup.abrir_powershell,
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

    @router.post("/api/endpoint/controle-remoto")
    def controle_remoto_endpoint(payload: ConsultaEndpointPayload) -> dict[str, Any]:
        equipment = get_snapshot(payload.serial)
        macbook = equipment.get("categoria") == "macbook" or categorize_equipment(equipment.get("tipo"), equipment.get("modelo")) == "macbook"
        details_serials = tuple(equipment["details_serials"])
        if equipment.get("serie_detalhes_duplicada"):
            details_serials += (payload.serial,)

        def inalterado() -> bool:
            # Antes de conectar por série alternativa de MacBook, a base local precisa continuar igual.
            try:
                return get_snapshot(payload.serial) == equipment
            except HTTPException as error:
                if error.status_code != 404:
                    raise
                return False

        try:
            result = remote_control(payload.serial, macbook, details_serials, antes_de_conectar=inalterado)
            result.pop("_fallback_mac", None)
            return result
        except endpoint_lookup.automation.TravaOcupada:
            raise HTTPException(409, "O Chrome está ocupado por outra automação. Tente novamente ao terminar.") from None
        except Exception:
            raise HTTPException(503, "Não foi possível abrir o controle remoto. Confira o Chrome de automação (porta 9333) e o login no Endpoint.") from None

    @router.post("/api/endpoint/powershell")
    def powershell_endpoint(payload: PowerShellPayload) -> dict[str, Any]:
        try:
            return powershell(payload.hostname, payload.modo, payload.comando, payload.usuario)
        except endpoint_lookup.automation.TravaOcupada:
            raise HTTPException(409, "O Chrome está ocupado por outra automação. Tente novamente ao terminar.") from None
        except Exception:
            raise HTTPException(503, "Não foi possível abrir o PowerShell. Confira o Chrome de automação (porta 9333) e o login no Endpoint.") from None

    return router
