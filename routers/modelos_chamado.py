"""API local dos padrões do Chamado manual (Home F1): ``config/modelos_chamado.json`` (versionado)."""
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from domains import modelos_chamado
from domains.modelos_chamado import ErroModeloChamado

logger = logging.getLogger(__name__)


class SalvarModeloPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rotulo: str
    texto: str


class ModeloSalvo(BaseModel):
    rotulo: str = ""
    texto: str = ""


class ListaModelos(BaseModel):
    modelos: dict[str, ModeloSalvo]


def _executar(acao: Any) -> Any:
    try:
        return {"modelos": acao()}
    except ErroModeloChamado as falha:
        # Nome e texto nunca vão ao log: só o status.
        logger.warning("Modelos de chamado: status=%s", falha.status)
        return JSONResponse(status_code=falha.status, content={"detail": str(falha)})


def create_modelos_chamado_router(arquivo: Path) -> APIRouter:
    router = APIRouter(prefix="/api/modelos-chamado")

    @router.get("", response_model=ListaModelos)
    def listar() -> Any:
        return _executar(lambda: modelos_chamado.listar(arquivo))

    @router.put("/{slug}", response_model=ListaModelos)
    def salvar(slug: str, payload: SalvarModeloPayload) -> Any:
        return _executar(lambda: modelos_chamado.salvar(arquivo, slug, payload.rotulo, payload.texto))

    return router
