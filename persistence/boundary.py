"""Request scope and feature boundary for the unfinished local PostgreSQL pilot."""

from contextvars import ContextVar
import ipaddress
from starlette.responses import JSONResponse

idempotency_key = ContextVar("simpress_idempotency_key", default=None)
PENDING = "Esta função aguarda a integração de arquivos e histórico da Etapa 6."


def pilot_route_allowed(method, path):
    reads = {"/api/buscar", "/api/buscar-expandida", "/api/stats", "/api/unidades",
             "/api/prontidao", "/api/config/transferencia", "/api/historico-alteracoes", "/api/historico-apelidos"}
    writes = {"/api/equipamento/salvar", "/api/equipamento/atualizar-apelido",
              "/api/equipamento/apelido/desfazer", "/api/unidade/salvar", "/api/recarregar-base"}
    if method == "GET":
        return path in reads or (path.startswith("/api/equipamento/") and len(path.split("/")) == 4)
    if method == "POST":
        return path in writes
    return method == "DELETE" and any(path.startswith(p) and len(path.split("/")) == 4 for p in
        ("/api/historico-alteracoes/", "/api/historico-apelidos/"))


class PersistenceBoundaryMiddleware:
    def __init__(self, app, is_postgres):
        self.app = app
        self.is_postgres = is_postgres

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not self.is_postgres():
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        try:
            local = client is not None and ipaddress.ip_address(client[0]).is_loopback
        except ValueError:
            local = False
        if not local:
            await JSONResponse({"detail": "O piloto PostgreSQL aceita somente conexões locais."}, status_code=403)(scope, receive, send)
            return
        path = scope.get("path", "")
        if path.startswith("/api/") and not pilot_route_allowed(scope["method"], path):
            await JSONResponse({"detail": PENDING}, status_code=501)(scope, receive, send)
            return
        values = [v for k,v in scope.get("headers", []) if k.lower() == b"idempotency-key"]
        if len(values) > 1:
            await JSONResponse({"detail": "Informe somente uma Idempotency-Key."}, status_code=422)(scope, receive, send)
            return
        token = idempotency_key.set(values[0].decode("latin-1") if values else None)
        try:
            await self.app(scope, receive, send)
        finally:
            idempotency_key.reset(token)
