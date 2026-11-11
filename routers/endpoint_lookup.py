"""Endpoint lookup shares the selected equipment and never saves a user."""
import re
from collections import deque
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Collection, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.config import STATE_DIR
from domains import endpoint_lookup
from domains.equipment_search import categorize_equipment
from domains.powershell_codigos import ler_codigos, salvar_codigos


class ConsultaEndpointPayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128)

    @field_validator("serial")
    @classmethod
    def validar_serial(cls, value: str) -> str:
        if any(ord(c) < 32 for c in value) or not value.strip():
            raise ValueError("Informe um número de série válido.")
        return value.strip().upper()


class ControleRemotoPayload(ConsultaEndpointPayload):
    # Identificador opcional do pedido da Home; o Assistente não o envia.
    pedido: str | None = Field(None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9-]+$")


class CancelarControleRemotoPayload(BaseModel):
    pedido: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9-]+$")

class PowerShellPayload(BaseModel):
    hostname: str = Field(..., min_length=1, max_length=64)
    modo: Literal["sistema", "usuario"]
    comando: str = Field(..., min_length=1, max_length=endpoint_lookup.LIMITE_COMANDO_POWERSHELL)
    usuario: str | None = Field(None, max_length=128)

    @field_validator("hostname")
    @classmethod
    def validar_hostname(cls, value: str) -> str:
        value = value.strip().upper()
        if not re.fullmatch(r"[A-Z0-9_.-]+", value):  # vazio também cai aqui: não há computador padrão
            raise ValueError("Informe um hostname válido.")
        return value

    @field_validator("usuario")
    @classmethod
    def validar_usuario(cls, value: str | None) -> str | None:
        return (value or "").strip() or None

    @field_validator("comando")
    @classmethod
    def validar_comando(cls, value: str) -> str:
        return endpoint_lookup.validar_comando(value)


class CodigoPowerShellPayload(BaseModel):
    # Só os tipos aqui; limites e caracteres proibidos são validados em domains/powershell_codigos.py.
    model_config = ConfigDict(extra="forbid")
    id: str | None = None
    titulo: str
    modo: str
    comando: str


class CodigosPowerShellPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    codigos: list[CodigoPowerShellPayload]


def _codigos_file_padrao() -> Path:
    return STATE_DIR / "powershell_codigos.json"


def create_endpoint_lookup_router(
    get_snapshot: Callable[[str], dict[str, Any]],
    lookup: Callable[[str, bool, Collection[str]], dict[str, Any]] = endpoint_lookup.consultar,
    remote_control: Callable[..., dict[str, Any]] = endpoint_lookup.controle_remoto,
    powershell: Callable[..., dict[str, Any]] = endpoint_lookup.abrir_powershell,
    codigos_file: Callable[[], Path] = _codigos_file_padrao,
) -> APIRouter:
    router = APIRouter()
    # Pedidos de controle remoto cancelados ou substituídos; guardados só em memória.
    cancelados: deque[str] = deque(maxlen=64)
    estado: dict[str, str | None] = {"vigente": None}
    trava = Lock()

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
    def controle_remoto_endpoint(payload: ControleRemotoPayload) -> dict[str, Any]:
        if payload.pedido:
            with trava:  # pedido novo invalida o anterior
                if estado["vigente"] and estado["vigente"] != payload.pedido:
                    cancelados.append(estado["vigente"])
                estado["vigente"] = payload.pedido
        equipment = get_snapshot(payload.serial)
        macbook = equipment.get("categoria") == "macbook" or categorize_equipment(equipment.get("tipo"), equipment.get("modelo")) == "macbook"
        details_serials = tuple(equipment["details_serials"])
        if equipment.get("serie_detalhes_duplicada"):
            details_serials += (payload.serial,)

        def inalterado(fallback_mac: bool) -> bool:
            # Nunca conecta por um pedido cancelado ou substituído (a tela já descartou a resposta).
            if payload.pedido and payload.pedido in cancelados:
                return False
            # Antes de conectar por série alternativa de MacBook, a base local precisa continuar igual.
            if not fallback_mac:
                return True
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

    @router.post("/api/endpoint/controle-remoto/cancelar")
    def cancelar_controle_remoto(payload: CancelarControleRemotoPayload) -> dict[str, Any]:
        with trava:
            cancelados.append(payload.pedido)
        return {"status": "cancelled"}

    @router.post("/api/endpoint/powershell")
    def powershell_endpoint(payload: PowerShellPayload) -> dict[str, Any]:
        try:
            return powershell(payload.hostname, payload.modo, payload.comando, payload.usuario)
        except endpoint_lookup.automation.TravaOcupada:
            raise HTTPException(409, "O Chrome está ocupado por outra automação. Tente novamente ao terminar.") from None
        except Exception:
            raise HTTPException(503, "Não foi possível abrir o PowerShell. Confira o Chrome de automação (porta 9333) e o login no Endpoint.") from None

    @router.get("/api/endpoint/powershell/codigos")
    def ler_codigos_powershell() -> dict[str, Any]:
        return {"codigos": ler_codigos(codigos_file())}

    @router.put("/api/endpoint/powershell/codigos")
    def salvar_codigos_powershell(payload: CodigosPowerShellPayload) -> dict[str, Any]:
        # 422 (DomainValidationError) e 503 (DomainBusyError) seguem pelo handler de main.py; o comando nunca vai a log.
        return {"codigos": salvar_codigos(codigos_file(), [item.model_dump() for item in payload.codigos])}

    return router
