"""Assistant panel: a chat that runs inside Simpress and calls OpenRouter directly.

The key (OPENROUTER_API_KEY) is read from the local `.env` or the environment and is never
returned by a route. Tools reach Simpress through its own routes (in process, same security
middleware), so they see exactly what the screens see.
"""

import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from domains.assistant_api import SimpressApi, Transport
from domains.assistant_chat import MSG_OCUPADO, MSG_SEM_CHAVE, AssistantBusy, AssistantConversation, Resposta
from domains.assistant_openrouter import ModelClient, OpenRouterClient, OpenRouterSettings


@dataclass(frozen=True)
class AssistantRouteServices:
    load_settings: Callable[[], OpenRouterSettings]
    transport: Transport
    client_factory: Callable[[OpenRouterSettings], ModelClient] = OpenRouterClient


class MensagemPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    texto: str = Field(min_length=1, max_length=4000)


class ConfirmacaoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmado: bool


def _reply(resposta: Resposta) -> Dict[str, Any]:
    ferramentas: List[str] = [str(item) for item in resposta.ferramentas]
    pendente = resposta.pendente
    return {
        "texto": resposta.texto,
        "ferramentas": ferramentas,
        "pendente": {"descricao": str(pendente.get("descricao", ""))} if pendente else None,
    }


def create_assistant_router(services: AssistantRouteServices) -> APIRouter:
    router = APIRouter()
    guard = threading.Lock()
    holder: List[Optional[AssistantConversation]] = [None]

    def conversation() -> AssistantConversation:
        """One conversation per server run. Until a key exists it is rebuilt on each call,
        so filling in `.env` works without restarting; once configured it is kept."""
        with guard:
            current = holder[0]
            if current is not None and current.configurado:
                return current
            settings = services.load_settings()
            if current is not None and not settings.configured:
                return current
            client = services.client_factory(settings) if settings.configured else None
            holder[0] = AssistantConversation(client, SimpressApi(services.transport), settings.primary_model)
            return holder[0]  # type: ignore[return-value]

    def ready() -> AssistantConversation:
        current = conversation()
        if not current.configurado:
            raise HTTPException(status_code=503, detail=MSG_SEM_CHAVE)
        return current

    def busy() -> HTTPException:
        return HTTPException(status_code=409, detail=MSG_OCUPADO)

    @router.post("/api/assistente/mensagem")
    def enviar_mensagem(payload: MensagemPayload):
        current = ready()
        try:
            return _reply(current.enviar_mensagem(payload.texto))
        except AssistantBusy:
            raise busy() from None

    @router.post("/api/assistente/confirmar")
    def confirmar_acao(payload: ConfirmacaoPayload):
        current = ready()
        try:
            return _reply(current.resolver_confirmacao(payload.confirmado))
        except AssistantBusy:
            raise busy() from None

    @router.post("/api/assistente/limpar")
    def limpar_conversa():
        try:
            conversation().limpar_historico()
        except AssistantBusy:
            raise busy() from None
        return {"ok": True}

    @router.get("/api/assistente/estado")
    def estado_assistente():
        current = conversation()
        descricao = current.descricao_pendente
        return {
            "online": current.configurado,
            "modelo": current.modelo if current.configurado else "",
            "aguardando_confirmacao": current.aguardando_confirmacao,
            "pendente": {"descricao": descricao} if descricao else None,
        }

    return router
