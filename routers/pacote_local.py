"""Rotas do Pacote local (Configuração local): listar, escolher a pasta, exportar, prévia e restaurar.

Todas as rotas só valem para pedido direto deste computador (127.0.0.1/::1), mesmo com o acesso pela rede ou pelo
Tailscale ligado. Regras e mensagens em ``domains/pacote_local.py``.
"""

from typing import Any, Callable, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from core.errors import DomainError
from domains import pacote_local
from domains.pacote_local import PacoteLocalServices
from security.network import is_direct_loopback_request


class PacoteLocalItem(BaseModel):
    arquivo: str
    tipo: Literal["exportacao", "desfazer"]
    criado_em: str
    tamanho_bytes: int


class PacoteLocalLista(BaseModel):
    pasta: str
    pasta_padrao: bool
    pacotes: List[PacoteLocalItem]
    erro_pasta: Optional[str] = None


class PacoteLocalPastaPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pasta: str = Field("", max_length=1000)


class PacoteLocalExportacao(BaseModel):
    arquivo: str
    tamanho_bytes: int
    arquivos: int
    ausentes: int
    criado_em: str


class PacoteLocalPreviaItem(BaseModel):
    caminho: str
    acao: Literal["substituir", "criar", "igual", "manter", "apagar"]


class PacoteLocalPreviaTotais(BaseModel):
    substituir: int
    criar: int
    igual: int
    manter: int
    apagar: int


class PacoteLocalPrevia(BaseModel):
    arquivo: str
    tipo: Literal["exportacao", "desfazer"]
    versao_app: str
    criado_em: str
    itens: List[PacoteLocalPreviaItem]
    totais: PacoteLocalPreviaTotais
    muda_links: bool
    preview_token: str


class PacoteLocalRestaurarPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preview_token: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    confirmado: StrictBool = False


class PacoteLocalRestauracao(BaseModel):
    substituidos: int
    criados: int
    apagados: int
    mantidos: int
    pacote_desfazer: str


def _so_neste_computador(request: Request) -> None:
    if not is_direct_loopback_request(request.scope, estrito=True):
        raise HTTPException(status_code=403, detail="Disponível só neste computador.")


def _chamar(funcao: Callable[..., Any], *args: Any) -> Any:
    try:
        return funcao(*args)
    except DomainError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from None


def create_pacote_local_router(services: PacoteLocalServices) -> APIRouter:
    router = APIRouter(prefix="/api/pacote-local", dependencies=[Depends(_so_neste_computador)])

    @router.get("", response_model=PacoteLocalLista)
    def listar_pacotes_locais():
        return pacote_local.listar(services)

    @router.put("/pasta", response_model=PacoteLocalLista)
    def salvar_pasta_pacote_local(payload: PacoteLocalPastaPayload):
        return _chamar(pacote_local.salvar_pasta, services, payload.pasta)

    @router.post("/exportar", response_model=PacoteLocalExportacao)
    def exportar_pacote_local():
        return _chamar(pacote_local.exportar, services)

    @router.get("/{arquivo}/previa", response_model=PacoteLocalPrevia)
    def previa_pacote_local(arquivo: str):
        return _chamar(pacote_local.previa, services, arquivo)

    @router.post("/{arquivo}/restaurar", response_model=PacoteLocalRestauracao)
    def restaurar_pacote_local(arquivo: str, payload: PacoteLocalRestaurarPayload):
        return _chamar(pacote_local.restaurar, services, arquivo, payload.preview_token, payload.confirmado)

    return router
