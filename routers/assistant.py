"""Assistant panel: proxies to the local "Jarvis leve" server (loopback only, see AGENTS.md).

Simpress never calls an external service here; the model call happens in the Jarvis repo.
The proxy sends no Origin/Sec-Fetch-Site header because Jarvis leve rejects browser-originated calls.
"""

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

DEFAULT_JARVIS_URL = "http://127.0.0.1:8766"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
CHAT_TIMEOUT_SECONDS = 90
STATE_TIMEOUT_SECONDS = 3
OFFLINE_DETAIL = "Assistente desligado. Abra iniciar_jarvis_leve.bat na pasta do Jarvis."
OFFLINE_STATE = {"online": False, "modelo": "", "aguardando_confirmacao": False, "pendente": None}


class JarvisUnreachable(Exception):
    """Connection refused, timeout or any transport failure."""


class JarvisHttpError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


Transport = Callable[[str, str, Optional[Dict[str, Any]], float], Dict[str, Any]]


def validated_jarvis_url(raw: str) -> Optional[str]:
    """Return the base URL when it is http on a loopback host; None (and a log) otherwise."""
    try:
        parts = urlsplit((raw or "").strip())
        host = parts.hostname
        port = parts.port
    except ValueError:
        host, port, parts = None, None, None
    if parts is None or parts.scheme != "http" or host not in LOOPBACK_HOSTS:
        logger.error("JARVIS_LEVE_URL recusada: use http em 127.0.0.1, localhost ou ::1.")
        return None
    netloc = f"[{host}]" if ":" in host else host
    return f"http://{netloc}" + (f":{port}" if port else "")


def urllib_transport(method: str, url: str, payload: Optional[Dict[str, Any]], timeout: float) -> Dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    # Empty ProxyHandler: loopback traffic must never go through an environment proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            body = json.loads(error.read().decode("utf-8"))
            detail = body.get("detail", "") if isinstance(body, dict) else ""
        except (ValueError, OSError):
            pass
        raise JarvisHttpError(error.code, detail if isinstance(detail, str) else "") from None
    except (OSError, ValueError) as error:  # URLError, timeout and bad JSON are all "not usable"
        raise JarvisUnreachable(type(error).__name__) from None


@dataclass(frozen=True)
class AssistantRouteServices:
    jarvis_url: Callable[[], str]
    transport: Transport = urllib_transport


class MensagemPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    texto: str = Field(min_length=1, max_length=4000)


class ConfirmacaoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmado: bool


def _reply(raw: Dict[str, Any]) -> Dict[str, Any]:
    pendente = raw.get("pendente")
    ferramentas: List[str] = [str(item) for item in raw.get("ferramentas") or []]
    return {
        "texto": str(raw.get("texto", "")),
        "ferramentas": ferramentas,
        "pendente": {"descricao": str(pendente.get("descricao", ""))} if isinstance(pendente, dict) else None,
    }


def create_assistant_router(services: AssistantRouteServices) -> APIRouter:
    router = APIRouter()
    base = validated_jarvis_url(services.jarvis_url())

    def call(method: str, path: str, payload: Optional[Dict[str, Any]], timeout: float) -> Dict[str, Any]:
        if base is None:
            raise JarvisUnreachable("url")
        return services.transport(method, base + path, payload, timeout)

    def forward(path: str, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        try:
            return call("POST", path, payload, CHAT_TIMEOUT_SECONDS)
        except JarvisUnreachable:
            raise HTTPException(status_code=503, detail=OFFLINE_DETAIL) from None
        except JarvisHttpError as error:
            if 400 <= error.status < 500:
                raise HTTPException(status_code=error.status, detail=error.detail or "Pedido recusado pelo assistente.") from None
            raise HTTPException(status_code=502, detail="O assistente falhou ao responder.") from None

    @router.post("/api/assistente/mensagem")
    def enviar_mensagem(payload: MensagemPayload):
        return _reply(forward("/mensagem", {"texto": payload.texto}))

    @router.post("/api/assistente/confirmar")
    def confirmar_acao(payload: ConfirmacaoPayload):
        return _reply(forward("/confirmar", {"confirmado": payload.confirmado}))

    @router.post("/api/assistente/limpar")
    def limpar_conversa():
        forward("/limpar", {})
        return {"ok": True}

    @router.get("/api/assistente/estado")
    def estado_assistente():
        try:
            raw = call("GET", "/estado", None, STATE_TIMEOUT_SECONDS)
        except (JarvisUnreachable, JarvisHttpError):
            return dict(OFFLINE_STATE)
        return {
            "online": bool(raw.get("online", True)),
            "modelo": str(raw.get("modelo", "")),
            "aguardando_confirmacao": bool(raw.get("aguardando_confirmacao", False)),
            "pendente": _reply(raw)["pendente"],
        }

    return router
