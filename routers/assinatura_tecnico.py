"""Assinatura do técnico nos PDFs dos Termos: entrega ``data/state/assinatura_tecnico.svg`` só para leitura."""
import logging
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from core.integrity import FileBusyError, FileTransactionError
from domains import configuracao_local as configuracao

logger = logging.getLogger(__name__)

LIMITE_BYTES = 64 * 1024
# SVG vai numa <img>, onde o navegador não executa script; mesmo assim a rota recusa o que pode executar ou buscar algo fora.
# shortcut: filtro de texto simples, não um sanitizador (entidades como &#x6A; passam); vale porque a <img> e o CSP isolam o arquivo.
PROIBIDO = re.compile(r"<script|\bon\w+\s*=|javascript:|<foreignobject|href\s*=|<!entity", re.IGNORECASE)
CABECALHOS_SVG = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
}


def _recusa(status: int, codigo: str, detail: str) -> JSONResponse:
    # Só o código vai ao log: nunca o conteúdo da assinatura.
    logger.warning("Assinatura do técnico: codigo=%s", codigo)
    return JSONResponse(status_code=status, content={"detail": detail, "codigo": codigo})


def create_assinatura_tecnico_router(arquivo: Path, config: Optional[Path] = None,
                                     backups: Optional[Path] = None) -> APIRouter:
    router = APIRouter(prefix="/api/assinatura-tecnico")
    config = config or arquivo.with_suffix(".json")
    backups = backups or arquivo.parent / "config_backups"

    # Rotas fixas antes de qualquer rota com parâmetro; o nome nunca vai a log nem ao corpo de erro.
    @router.get("/config")
    def obter_config() -> Any:
        return configuracao.ler_assinatura(config)

    @router.put("/config")
    async def gravar_config(request: Request) -> Any:
        try:
            corpo = await request.json()
        except ValueError:
            corpo = None
        if not isinstance(corpo, dict):
            return JSONResponse(status_code=422, content={
                "detail": "Corpo inválido: envie estilo e nome.", "codigo": "assinatura_corpo_invalido"})
        try:
            return configuracao.gravar_assinatura(config, backups, corpo.get("estilo"), corpo.get("nome", ""))
        except configuracao.AssinaturaInvalida as erro:
            return JSONResponse(status_code=422, content={"detail": erro.detail, "codigo": erro.codigo})
        except (OSError, FileTransactionError, FileBusyError) as erro:
            logger.warning("configuracao_local: falha ao gravar assinatura_tecnico (erro=%s)", type(erro).__name__)
            return JSONResponse(status_code=500, content={"detail": "Não foi possível gravar a configuração local."})

    @router.get("")
    def obter() -> Any:
        try:
            tamanho = arquivo.stat().st_size
        except OSError:
            return _recusa(404, "assinatura_ausente", "Não há assinatura do técnico configurada.")
        if tamanho > LIMITE_BYTES:
            return _recusa(422, "assinatura_invalida", "A assinatura do técnico passa de 64 KB.")
        try:
            conteudo = arquivo.read_bytes()
            texto = conteudo.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            return _recusa(422, "assinatura_invalida", "A assinatura do técnico não pôde ser lida como SVG.")
        if len(conteudo) > LIMITE_BYTES or "<svg" not in texto.lower() or PROIBIDO.search(texto):
            return _recusa(422, "assinatura_invalida", "A assinatura do técnico tem conteúdo não permitido.")
        return Response(content=conteudo, media_type="image/svg+xml", headers=CABECALHOS_SVG)

    return router
