"""Same-origin authentication boundary; identities never come from request headers."""

import asyncio
import hmac
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse

from domains.frontend_assets import CONTENT_SECURITY_POLICY
from persistence.config import PersistenceError
from security.context import principal

SESSION_COOKIE = "simpress_session"
PRELOGIN_COOKIE = "simpress_prelogin"
SAFE_METHODS = {"GET","HEAD"}


def same_origin(scope, settings):
    headers = scope.get("headers",[])
    hosts = [v.decode("latin-1") for k,v in headers if k.lower() == b"host"]
    origins = [v.decode("latin-1") for k,v in headers if k.lower() == b"origin"]
    expected_host = settings.origin.split("://",1)[1]
    if hosts != [expected_host] or (origins and origins != [settings.origin]):
        raise PersistenceError(403,"Origem não autorizada.")
    if scope.get("method") not in SAFE_METHODS and origins != [settings.origin]:
        raise PersistenceError(403,"A solicitação precisa partir da aplicação.")


def csrf_header(scope):
    values = [v.decode("latin-1") for k,v in scope.get("headers",[]) if k.lower() == b"x-csrf-token"]
    if len(values) != 1 or len(values[0]) != 43 or not values[0].isascii():
        raise PersistenceError(403,"Validação de segurança expirada. Atualize a página.")
    return values[0]


class AuthenticationMiddleware:
    def __init__(self, app, provider, settings):
        self.app,self.provider,self.settings = app,provider,settings

    async def __call__(self, scope, receive, send):
        settings = self.settings()
        if not settings.enabled:
            await self.app(scope,receive,send)
            return
        if scope["type"] == "websocket":
            await send({"type":"websocket.close","code":1008})
            return
        if scope["type"] != "http":
            await self.app(scope,receive,send)
            return

        async def secure_send(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers",[]))
                fixed = {b"cache-control":b"no-store",b"x-content-type-options":b"nosniff",
                    b"x-frame-options":b"DENY",b"referrer-policy":b"no-referrer",
                    b"permissions-policy":b"camera=(), microphone=(), geolocation=()",
                    b"content-security-policy":CONTENT_SECURITY_POLICY.encode()}
                if settings.secure:
                    fixed[b"strict-transport-security"] = b"max-age=31536000"
                message = {**message,"headers":[(k,v) for k,v in headers if k.lower() not in fixed]+list(fixed.items())}
            await send(message)

        token = None
        try:
            same_origin(scope,settings)
            path,method = scope.get("path",""),scope.get("method","")
            public = (method in SAFE_METHODS and (path == "/login" or path.startswith("/static/") or path == "/api/auth/session"))
            login = path == "/api/auth/login" and method == "POST"
            if not public and not login:
                backend = self.provider()
                if backend is None or backend.auth is None:
                    raise PersistenceError(503,"A autenticação ainda não está disponível.")
                opaque = Request(scope).cookies.get(SESSION_COOKIE)
                try:
                    identity,csrf = await asyncio.to_thread(backend.auth.load,opaque)
                except PersistenceError as error:
                    if error.status_code == 401 and path == "/" and method in SAFE_METHODS:
                        await RedirectResponse("/login",status_code=303)(scope,receive,secure_send)
                        return
                    raise
                if method not in SAFE_METHODS and not hmac.compare_digest(csrf_header(scope),csrf):
                    raise PersistenceError(403,"Validação de segurança expirada. Atualize a página.")
                token = principal.set(identity)
                scope.setdefault("state",{})["csrf_token"] = csrf
            await self.app(scope,receive,secure_send)
        except PersistenceError as error:
            await JSONResponse({"detail":error.detail},status_code=error.status_code)(scope,receive,secure_send)
        finally:
            if token is not None:
                principal.reset(token)
