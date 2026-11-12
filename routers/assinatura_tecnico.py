"""Assinatura do técnico nos PDFs dos Termos: entrega ``data/state/assinatura_tecnico.svg`` só para leitura."""
import logging
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse

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


def create_assinatura_tecnico_router(arquivo: Path) -> APIRouter:
    router = APIRouter(prefix="/api/assinatura-tecnico")

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
