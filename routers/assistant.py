"""Assistant panel: a chat that runs inside Simpress and calls OpenRouter directly.

The key (OPENROUTER_API_KEY) is read from the local `.env` or the environment and is never
returned by a route. Tools reach Simpress through its own routes (in process, same security
middleware), so they see exactly what the screens see.
"""

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from core.config import MAX_ASSISTANT_AUDIO_BYTES
from domains.assistant_anexos import AnexoRecusado, analisar
from domains.assistant_api import SimpressApi, Transport
from domains.assistant_busca_web import LIMITE_CONSULTA, ler_busca_web, salvar_busca_web
from domains.assistant_chat import MSG_OCUPADO, MSG_SEM_CHAVE, AssistantBusy, AssistantConversation, Resposta
from domains.assistant_instrucoes import LIMITE_INSTRUCOES, ler_instrucoes, salvar_instrucoes
from domains.assistant_notas import LIMITE_NOTAS, LIMITE_TEXTO, NotasStore
from domains.assistant_openrouter import ModelClient, OpenRouterClient, OpenRouterError, OpenRouterSettings
from domains.assistant_relatorios import FORMATOS

# RIFF header (12) + fmt chunk (24) + data chunk header (8).
MIN_WAV_BYTES = 44


@dataclass(frozen=True)
class AssistantRouteServices:
    load_settings: Callable[[], OpenRouterSettings]
    transport: Transport
    instructions_file: Path
    notes_file: Optional[Path] = None  # default: next to the instructions file
    web_search_file: Optional[Path] = None  # default: next to the instructions file
    client_factory: Callable[[OpenRouterSettings], ModelClient] = OpenRouterClient


class MensagemPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    texto: str = Field(min_length=1, max_length=4000)


class InstrucoesPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The limit is checked in the route (clear pt-BR message); the middleware already caps the body at 1 MB.
    texto: str


class BuscaWebPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ativa: bool


class NotaPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    concluida: bool


class ConfirmacaoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmado: bool


def _reply(resposta: Resposta) -> Dict[str, Any]:
    ferramentas: List[str] = [str(item) for item in resposta.ferramentas]
    pendente = resposta.pendente
    reply: Dict[str, Any] = {
        "texto": resposta.texto,
        "ferramentas": ferramentas,
        "pendente": {"descricao": str(pendente.get("descricao", ""))} if pendente else None,
    }
    if resposta.buscas_web:  # only when a web search ran this turn: the screen builds the source card from it
        reply["busca_web"] = [dict(busca) for busca in resposta.buscas_web]
    if resposta.arquivos:  # only when a report was generated: the screen builds the download button from it
        reply["arquivos"] = [dict(arquivo) for arquivo in resposta.arquivos]
    return reply


def create_assistant_router(services: AssistantRouteServices) -> APIRouter:
    router = APIRouter()
    guard = threading.Lock()
    notas = NotasStore(services.notes_file or services.instructions_file.with_name("assistente_notas.json"))
    web_file = services.web_search_file or services.instructions_file.with_name("assistente_busca_web.json")
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
            holder[0] = AssistantConversation(
                client, SimpressApi(services.transport), settings.primary_model,
                lambda: ler_instrucoes(services.instructions_file), notas, lambda: ler_busca_web(web_file),
            )
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

    @router.post("/api/assistente/audio")
    async def transcrever_audio(request: Request):
        """Voice message: WAV in, text out. The text only fills the message box; the user reviews it and sends."""
        current = ready()
        wav = await request.body()
        if len(wav) > MAX_ASSISTANT_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="O áudio é grande demais. Grave um trecho mais curto.")
        if len(wav) < MIN_WAV_BYTES or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
            raise HTTPException(status_code=415, detail="Envie o áudio em formato WAV.")
        try:
            texto = await run_in_threadpool(current.transcrever, wav)
        except OpenRouterError as falha:
            raise HTTPException(status_code=502, detail=falha.message) from None
        return {"texto": texto}

    @router.post("/api/assistente/anexo")
    async def anexar_arquivo(request: Request):
        """Attach a PDF, .docx or image: raw bytes in, the file name in `X-Nome-Arquivo` (percent-encoded). Kept in memory only."""
        current = ready()
        dados = await request.body()
        try:
            anexo = await run_in_threadpool(analisar, dados, request.headers.get("x-nome-arquivo", ""))
            current.anexos.adicionar(anexo)
        except AnexoRecusado as falha:
            raise HTTPException(status_code=falha.status, detail=falha.mensagem) from None
        return anexo.publico()

    @router.get("/api/assistente/anexos")
    def listar_anexos():
        return {"anexos": [anexo.publico() for anexo in conversation().anexos.listar()]}

    @router.delete("/api/assistente/anexo/{anexo_id}")
    def remover_anexo(anexo_id: str):
        if not conversation().anexos.remover(anexo_id):
            raise HTTPException(status_code=404, detail="Anexo não encontrado.")
        return {"ok": True}

    @router.get("/api/assistente/relatorio/{relatorio_id}")
    def baixar_relatorio(relatorio_id: str):
        """Download a report generated in this server run (memory only; expires)."""
        arquivo = conversation().relatorios.obter(relatorio_id)
        if arquivo is None:
            raise HTTPException(status_code=404, detail="Relatório não encontrado. Ele expirou; peça de novo ao assistente.")
        return Response(
            content=arquivo.dados,
            media_type=FORMATOS[arquivo.formato],
            headers={
                "Content-Disposition": f'attachment; filename="{arquivo.nome}"',
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

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

    @router.get("/api/assistente/instrucoes")
    def ler_instrucoes_permanentes():
        return {"texto": ler_instrucoes(services.instructions_file), "limite": LIMITE_INSTRUCOES}

    @router.put("/api/assistente/instrucoes")
    def salvar_instrucoes_permanentes(payload: InstrucoesPayload):
        try:
            texto = salvar_instrucoes(services.instructions_file, payload.texto)
        except ValueError as falha:
            raise HTTPException(status_code=422, detail=str(falha)) from None
        return {"texto": texto, "limite": LIMITE_INSTRUCOES}

    @router.get("/api/assistente/busca-web")
    def ler_busca_web_ligada():
        return {"ativa": ler_busca_web(web_file), "limite_consulta": LIMITE_CONSULTA}

    @router.put("/api/assistente/busca-web")
    def alternar_busca_web(payload: BuscaWebPayload):
        return {"ativa": salvar_busca_web(web_file, payload.ativa), "limite_consulta": LIMITE_CONSULTA}

    @router.get("/api/assistente/notas")
    def listar_notas():
        return {"notas": notas.listar(), "limite_texto": LIMITE_TEXTO, "limite_quantidade": LIMITE_NOTAS}

    @router.patch("/api/assistente/notas/{nota_id}")
    def marcar_nota(nota_id: str, payload: NotaPayload):
        nota = notas.marcar(nota_id, payload.concluida)
        if nota is None:
            raise HTTPException(status_code=404, detail="Lembrete não encontrado.")
        return nota

    @router.delete("/api/assistente/notas/{nota_id}")
    def apagar_nota(nota_id: str):
        if not notas.apagar(nota_id):
            raise HTTPException(status_code=404, detail="Lembrete não encontrado.")
        return {"ok": True}

    return router
