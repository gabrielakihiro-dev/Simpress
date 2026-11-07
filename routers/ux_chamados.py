"""Local-only API for preparing, filling, confirming, and cancelling UX requests."""
import logging
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from domains.ux_chamados import ChamadosUX, ErroUX

T = TypeVar("T")
logger = logging.getLogger(__name__)
# Keyed by exception class name only: Playwright messages can carry selectors and form contents.
MENSAGENS_FALHA_UX = {
    "TimeoutError": (
        "ux_formulario_diferente",
        "O UX não mostrou o campo esperado a tempo. O formulário pode ter mudado ou ainda estar carregando: "
        "confira a aba do UX no Chrome de automação e tente de novo.",
    ),
}
MENSAGEM_FALHA_UX_GENERICA = (
    "ux_falha",
    "Falha inesperada ao falar com o UX. Confira o Chrome de automação e tente de novo; "
    "se persistir, o formulário do UX pode ter mudado.",
)


class SeriePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    serial: str = Field(min_length=1, max_length=128)

    @field_validator("serial")
    @classmethod
    def normalizar_serie(cls, valor: str) -> str:
        if not valor.strip() or any(ord(c) < 32 for c in valor):
            raise ValueError("Informe uma série válida.")
        return valor.strip().upper()


class PrepararPayload(SeriePayload):
    conferido: StrictBool = False


class EnviarPayload(SeriePayload):
    session_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    problema: str = Field(min_length=1, max_length=256)
    descricao: str = Field(max_length=8000)
    enviar: StrictBool = False
    confirmado: StrictBool = False


class CancelarPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(pattern=r"^[0-9a-f]{32}$")


def create_ux_chamados_router(
    servico: ChamadosUX, buscar_equipamento: Callable[[str], dict[str, Any]],
) -> APIRouter:
    router = APIRouter(prefix="/api/ux/abrir-chamado")

    def executar(acao: Callable[[], T]) -> T | JSONResponse:
        try:
            return acao()
        except ErroUX as falha:
            return JSONResponse(status_code=falha.status, content={"detail": str(falha), "codigo": falha.codigo})
        except HTTPException:
            raise
        except Exception as erro:
            # Playwright errors can include selectors, profile values and form contents: log only the class name.
            nome = type(erro).__name__
            logger.warning("UX: %s", nome)
            codigo, mensagem = MENSAGENS_FALHA_UX.get(nome, MENSAGEM_FALHA_UX_GENERICA)
            return JSONResponse(status_code=503, content={"detail": mensagem, "codigo": codigo})

    @router.post("/preparar", response_model=None)
    def preparar(payload: PrepararPayload) -> dict[str, Any] | JSONResponse:
        equipamento = buscar_equipamento(payload.serial)
        if equipamento.get("serie_detalhes_duplicada"):
            raise HTTPException(409, "A série está duplicada na base local. Confira o equipamento antes de abrir o chamado.")
        return executar(lambda: servico.preparar(payload.serial, conferido=payload.conferido))

    @router.post("/enviar", response_model=None)
    def enviar(payload: EnviarPayload) -> dict[str, Any] | JSONResponse:
        equipamento = buscar_equipamento(payload.serial)
        if equipamento.get("serie_detalhes_duplicada"):
            raise HTTPException(409, "A série está duplicada na base local. Confira o equipamento antes de abrir o chamado.")
        return executar(lambda: servico.executar(
            session_id=payload.session_id, serial=payload.serial, problema=payload.problema,
            descricao=payload.descricao, enviar=payload.enviar, confirmado=payload.confirmado,
        ))

    @router.post("/cancelar", response_model=None)
    def cancelar(payload: CancelarPayload) -> dict[str, str] | JSONResponse:
        return executar(lambda: servico.cancelar(payload.session_id))

    return router

