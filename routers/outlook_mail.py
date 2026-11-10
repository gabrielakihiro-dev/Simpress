"""API local dos e-mails por modelo pelo Outlook (Home): modelos, contatos do Entra e criação ou envio do e-mail."""
import logging
import subprocess
from pathlib import Path
from typing import Any, Callable, Literal, Optional, TypeVar

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictBool

from domains.outlook_mail import (
    SCRIPT_PS1, Diretorio, EmailOutlook, ErroOutlook, Executor, ModelosEmail, contas_publicas,
)

T = TypeVar("T")
logger = logging.getLogger(__name__)


class NovoModeloPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nome: Optional[str] = None
    copiar_de: Optional[str] = None


class AtualizarModeloPayload(BaseModel):
    """Parcial: só os campos enviados mudam; os limites e a conta são validados pelo domínio."""
    model_config = ConfigDict(extra="forbid")

    nome: Optional[str] = None
    conta: Optional[str] = None
    para: Optional[str] = None
    cc: Optional[str] = None
    assunto: Optional[str] = None
    corpo: Optional[str] = None


class ResolverPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tokens: list[str]


class EnviarEmailPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conta: str
    para: str = ""
    cc: str = ""
    assunto: str = ""
    corpo: str = ""
    nome: str = ""
    setor: str = ""
    modo: Literal["abrir", "enviar"]
    confirmado: StrictBool = False


def executar(acao: Callable[[], T]) -> T | JSONResponse:
    """Mapeia ErroOutlook para ``{detail, codigo}``; erro inesperado vira 500 sem conteúdo do pedido no log."""
    try:
        return acao()
    except ErroOutlook as falha:
        return JSONResponse(status_code=falha.status, content={"detail": str(falha), "codigo": falha.codigo})
    except Exception as erro:
        # Nada do pedido (corpo, nomes, termo buscado) vai ao log: só a classe do erro.
        logger.warning("Outlook e-mail: erro inesperado %s", type(erro).__name__)
        return JSONResponse(
            status_code=500,
            content={"detail": "Erro inesperado ao preparar o e-mail. Tente de novo.", "codigo": "erro_inesperado"},
        )


def create_outlook_mail_router(
    arquivo_modelos: Path, arquivo_entra: Path, *, executar_processo: Executor = subprocess.run,
    script: Path = SCRIPT_PS1,
) -> APIRouter:
    router = APIRouter(prefix="/api/outlook")
    modelos = ModelosEmail(arquivo_modelos)
    diretorio = Diretorio(arquivo_entra)
    email = EmailOutlook(executar=executar_processo, script=script)

    @router.get("/email/configuracao")
    def configuracao() -> Any:
        return executar(lambda: {
            "contas": contas_publicas(), "modelos": modelos.listar(), "diretorio": diretorio.resumo(),
        })

    @router.post("/email/modelos")
    def criar_modelo(payload: NovoModeloPayload) -> Any:
        return executar(lambda: modelos.criar(payload.nome, payload.copiar_de))

    @router.put("/email/modelos/{modelo_id}")
    def atualizar_modelo(modelo_id: str, payload: AtualizarModeloPayload) -> Any:
        return executar(lambda: modelos.atualizar(modelo_id, payload.model_dump(exclude_unset=True)))

    @router.delete("/email/modelos/{modelo_id}")
    def excluir_modelo(modelo_id: str) -> Any:
        def acao() -> dict[str, bool]:
            modelos.excluir(modelo_id)
            return {"ok": True}

        return executar(acao)

    @router.post("/email/modelos/{modelo_id}/restaurar")
    def restaurar_modelo(modelo_id: str) -> Any:
        return executar(lambda: modelos.restaurar(modelo_id))

    @router.get("/contatos")
    def contatos(q: str = Query("", max_length=200)) -> Any:
        return executar(lambda: {"contatos": diretorio.buscar(q)})

    @router.post("/contatos/resolver")
    def resolver(payload: ResolverPayload) -> Any:
        return executar(lambda: {"resultados": diretorio.resolver(payload.tokens)})

    @router.post("/email")
    def enviar_email(payload: EnviarEmailPayload) -> Any:
        return executar(lambda: email.processar(payload.model_dump()))

    return router
