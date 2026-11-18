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
    # Cópia dos dados do termo; formato validado pelo domínio (termo_invalido).
    termo: Optional[Any] = None


class AtualizarLembretePayload(BaseModel):
    """Parcial: só os campos enviados mudam (`null` explícito em data/hora limpa); o domínio valida os valores."""
    model_config = ConfigDict(extra="forbid")

    descricao: Optional[str] = None
    concluido: Optional[StrictBool] = None
    data_agendada: Optional[str] = None
    hora_agendada: Optional[str] = None


class Lembrete(BaseModel):
    """Um item como o domínio devolve (domains.lembretes.CAMPOS). Tipos frouxos de propósito: a leitura do arquivo
    aceita data e hora fora do formato e qualquer objeto em `termo`; um tipo mais estrito daria 500 no GET."""

    id: str
    descricao: str
    criado_em: str
    alterado_em: Optional[str]
    concluido: bool
    concluido_em: Optional[str]
    origem: Optional[str]
    termo: Optional[dict[str, Any]]
    data_agendada: Optional[str]
    hora_agendada: Optional[str]


class ListaLembretes(BaseModel):
    lembretes: list[Lembrete]


class LembretesReagendados(ListaLembretes):
    reagendados: int


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

    @router.get("", response_model=ListaLembretes)
    def listar() -> Any:
        return executar(lambda: {"lembretes": lembretes.listar()})

    @router.post("", status_code=201, response_model=Lembrete)
    def criar(payload: NovoLembretePayload) -> Any:
        return executar(lambda: lembretes.criar(
            payload.descricao, payload.origem, payload.termo, payload.data_agendada, payload.hora_agendada,
        ))

    # Rota fixa antes de `/{lembrete_id}`, para nunca ser lida como id.
    @router.post("/reagendar-atrasados", response_model=LembretesReagendados)
    def reagendar_atrasados() -> Any:
        def acao() -> dict[str, Any]:
            itens, reagendados = lembretes.reagendar_atrasados()
            return {"lembretes": itens, "reagendados": reagendados}

        return executar(acao)

    @router.patch("/{lembrete_id}", response_model=Lembrete)
    def atualizar(lembrete_id: str, payload: AtualizarLembretePayload) -> Any:
        return executar(lambda: lembretes.atualizar(lembrete_id, payload.model_dump(exclude_unset=True)))

    @router.delete("/{lembrete_id}", status_code=204, response_model=None)  # 204 não tem corpo: sem modelo de resposta
    def excluir(lembrete_id: str) -> Any:
        def acao() -> Response:
            lembretes.excluir(lembrete_id)
            return Response(status_code=204)

        return executar(acao)

    return router
