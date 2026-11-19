"""Configuração local pelo site: contas das automações, links internos e chaves de IA (`docs/cockpit-prompts/19-configuracao-local.md`)."""

import logging
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from core.config import ENDPOINT_URL_PADRAO, endpoint_url
from core.integrity import FileBusyError, FileTransactionError
from domains import configuracao_local as configuracao

logger = logging.getLogger(__name__)

# Os valores recebidos nunca voltam em erro nem entram no log: só a classe do erro.
ERROS_DE_GRAVACAO = (OSError, FileTransactionError, FileBusyError)
# Telas do Endpoint abertas pelos links da interface: None = o link configurado como está; senão, o fragmento no host dele.
TELAS_ENDPOINT = {
    "computadores": None,
    "som-computadores": "#/uems/agent/som/computers",
    "staged-computers": "#/uems/agent/som/staged-computers",
}


class ContasPayload(BaseModel):
    """Corpo de PUT /api/config/local/contas. Em branco mantém o valor atual. A caixa do Outlook ausente vale
    "marcada" com conta nova e "deixa como está" com o campo em branco."""
    conta_simpress: str = Field("", max_length=254)
    conta_sebrae: str = Field("", max_length=254)
    usuario_endpoint: str = Field("", max_length=100)
    usar_no_outlook_simpress: Optional[bool] = None
    usar_no_outlook_sebrae: Optional[bool] = None
    links: dict[str, str] = Field(default_factory=dict, max_length=50)


class AssistentePayload(BaseModel):
    """Corpo de PUT /api/config/local/assistente. Ausente ou em branco mantém a chave atual."""
    openrouter_api_key: Optional[str] = Field(None, max_length=1000)
    deepseek_api_key: Optional[str] = Field(None, max_length=1000)


def create_configuracao_local_router(*, contas_file: Callable[[], Path], client_file: Callable[[], Path],
                                     env_file: Callable[[], Path], backups_directory: Callable[[], Path]) -> Any:
    router = APIRouter()

    def leitura() -> dict:
        return configuracao.ler_configuracao(contas_file(), client_file(), env_file())

    def gravar(secao: str, escrever: Callable[[], None]) -> None:
        try:
            escrever()
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except ERROS_DE_GRAVACAO as error:
            logger.warning("configuracao_local: falha ao gravar %s (erro=%s)", secao, type(error).__name__)
            raise HTTPException(500, "Não foi possível gravar a configuração local.") from error

    @router.get("/api/config/local")
    def get_configuracao_local() -> Any:
        return leitura()

    @router.get("/api/config/local/endpoint/{tela}")
    def abrir_endpoint(tela: str) -> RedirectResponse:
        """Links da interface para o Endpoint: lê o link a cada clique, então vale sem reiniciar."""
        if tela not in TELAS_ENDPOINT:
            raise HTTPException(404, "Tela do Endpoint desconhecida.")
        url = endpoint_url(contas_file())
        if configuracao.validar_valor("link", url) is not None:
            url = ENDPOINT_URL_PADRAO
        fragmento = TELAS_ENDPOINT[tela]
        return RedirectResponse(url if fragmento is None else url.split("#")[0] + fragmento, status_code=302)

    @router.put("/api/config/local/contas")
    def put_contas(payload: ContasPayload) -> Any:
        gravar("contas", lambda: configuracao.gravar_contas(
            contas_file(), backups_directory(),
            contas={
                "conta_simpress": payload.conta_simpress, "conta_sebrae": payload.conta_sebrae,
                "usuario_endpoint": payload.usuario_endpoint,
            },
            links=payload.links,
            usar_no_outlook={
                conta: marcada for conta, marcada in (
                    ("conta_simpress", payload.usar_no_outlook_simpress), ("conta_sebrae", payload.usar_no_outlook_sebrae),
                ) if marcada is not None
            },
        ))
        return leitura()

    @router.put("/api/config/local/assistente")
    def put_assistente(payload: AssistentePayload) -> Any:
        gravar("assistente", lambda: configuracao.gravar_assistente(
            env_file(), backups_directory(),
            {"openrouter": payload.openrouter_api_key, "deepseek": payload.deepseek_api_key},
        ))
        return leitura()["assistente"]

    @router.delete("/api/config/local/assistente/{chave}")
    def delete_assistente(chave: str) -> Any:
        if chave not in configuracao.CHAVES_IA:
            raise HTTPException(404, "Chave de IA desconhecida.")
        gravar("assistente", lambda: configuracao.remover_chave_ia(env_file(), backups_directory(), chave))
        return leitura()["assistente"]

    return router
