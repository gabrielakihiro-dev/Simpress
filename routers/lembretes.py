"""API local dos lembretes (Ferramentas): lista em ``data/state/lembretes.json``."""
import logging
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictBool

from domains.lembretes import ErroLembrete, Lembretes

T = TypeVar("T")
logger = logging.getLogger(__name__)


class NovoLembretePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    descricao: str
    origem: Optional[str] = None
    data_agendada: Optional[str] = None
    hora_agendada: Optional[str] = None


class AtualizarLembretePayload(BaseModel):
    """Parcial: só os campos enviados mudam (`null` explícito em data/hora limpa); o domínio valida os valores."""
    model_config = ConfigDict(extra="forbid")

    descricao: Optional[str] = None
    concluido: Optional[StrictBool] = None
    data_agendada: Optional[str] = None
    hora_agendada: Optional[str] = None


def executar(acao: Callable[[], T]) -> T | JSONResponse:
    """Mapeia ErroLembrete para ``{detail, codigo}``; erro inesperado vira 500 sem a descrição no log."""
    try:
        return acao()
    except ErroLembrete as falha:
        logger.warning("Lembretes: codigo=%s", falha.codigo)
        return JSONResponse(status_code=falha.status, content={"detail": str(falha), "codigo": falha.codigo})
    except Exception as erro:
        # A descrição pode estar na mensagem do erro: só a classe vai ao log.
        logger.warning("Lembretes: erro inesperado %s", type(erro).__name__)
        return JSONResponse(
            status_code=500,
            content={"detail": "Erro inesperado ao salvar o lembrete. Tente de novo.", "codigo": "erro_inesperado"},
        )


def create_lembretes_router(arquivo: Path) -> APIRouter:
    router = APIRouter(prefix="/api/lembretes")
    lembretes = Lembretes(arquivo)

    @router.get("")
    def listar() -> Any:
        return executar(lambda: {"lembretes": lembretes.listar()})

    @router.post("", status_code=201)
    def criar(payload: NovoLembretePayload) -> Any:
        return executar(
            lambda: lembretes.criar(payload.descricao, payload.origem, payload.data_agendada, payload.hora_agendada),
        )

    # Rota fixa antes de `/{lembrete_id}`, para nunca ser lida como id.
    @router.post("/reagendar-atrasados")
    def reagendar_atrasados() -> Any:
        def acao() -> dict[str, Any]:
            itens, reagendados = lembretes.reagendar_atrasados()
            return {"lembretes": itens, "reagendados": reagendados}

        return executar(acao)

    @router.patch("/{lembrete_id}")
    def atualizar(lembrete_id: str, payload: AtualizarLembretePayload) -> Any:
        return executar(lambda: lembretes.atualizar(lembrete_id, payload.model_dump(exclude_unset=True)))

    @router.delete("/{lembrete_id}", status_code=204, response_model=None)  # 204 não tem corpo: sem modelo de resposta
    def excluir(lembrete_id: str) -> Any:
        def acao() -> Response:
            lembretes.excluir(lembrete_id)
            return Response(status_code=204)

        return executar(acao)

    return router
