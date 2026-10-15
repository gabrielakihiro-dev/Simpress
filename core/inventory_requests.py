"""Validate and carry the idempotency key for local inventory updates."""

from contextvars import ContextVar
import re

from starlette.responses import JSONResponse


idempotency_key: ContextVar[str | None] = ContextVar("simpress_idempotency_key", default=None)
IDEMPOTENCY_KEY_PATTERN = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")


class InventoryUpdateMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or scope.get("path") != "/api/planilhas/atualizar"
                or scope.get("method") != "POST"):
            await self.app(scope, receive, send)
            return
        values = [v for k, v in scope.get("headers", []) if k.lower() == b"idempotency-key"]
        if len(values) > 1:
            await JSONResponse({"detail": "Informe somente uma Idempotency-Key."}, status_code=422)(scope, receive, send)
            return
        key = values[0].decode("latin-1") if values else None
        if key is not None and not IDEMPOTENCY_KEY_PATTERN.fullmatch(key):
            await JSONResponse({
                "detail": "Idempotency-Key deve conter de 1 a 128 letras, números, ponto, hífen, dois-pontos ou sublinhado."
            }, status_code=422)(scope, receive, send)
            return
        token = idempotency_key.set(key)
        try:
            await self.app(scope, receive, send)
        finally:
            idempotency_key.reset(token)
