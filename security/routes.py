"""BFF endpoints: no Supabase token or credential is returned to the browser."""

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from routers.frontend import frontend_response

from persistence.config import PersistenceError
from persistence.routes import worker
from security.context import principal
from security.middleware import PRELOGIN_COOKIE,SESSION_COOKIE,csrf_header


def create_auth_router(provider, settings, static_dir):
    router = APIRouter()

    def service():
        backend = provider()
        if not settings().enabled or backend is None or backend.auth is None:
            raise PersistenceError(503,"A autenticação ainda não está disponível.")
        return backend.auth

    def cookie(response, name, value, seconds):
        response.set_cookie(name,value,max_age=seconds,httponly=True,secure=settings().secure,samesite="strict",path="/")

    @router.get("/login",include_in_schema=False)
    def login_page():
        return frontend_response(Path(static_dir), "login.html")

    @router.get("/api/auth/session")
    async def session(request: Request):
        if not settings().enabled:
            return {"enabled":False,"authenticated":False}
        auth = service()
        opaque = request.cookies.get(SESSION_COOKIE)
        if opaque:
            try:
                _,csrf = await worker(auth.load,opaque)
                return {"enabled":True,"authenticated":True,"perfil":"administrador","csrf_token":csrf}
            except PersistenceError as error:
                if error.status_code not in (401,403):
                    raise
        csrf,challenge = auth.prelogin(request.cookies.get(PRELOGIN_COOKIE))
        response = JSONResponse({"enabled":True,"authenticated":False,"csrf_token":csrf})
        cookie(response,PRELOGIN_COOKIE,challenge,900)
        response.delete_cookie(SESSION_COOKIE,path="/",secure=settings().secure,httponly=True,samesite="strict")
        return response

    @router.post("/api/auth/login")
    async def login(request: Request):
        auth = service()
        if not auth.prelogin_valid(request.cookies.get(PRELOGIN_COOKIE),csrf_header(request.scope)):
            raise PersistenceError(403,"Validação de segurança expirada. Atualize a página.")
        if request.headers.get("content-type","").split(";",1)[0] != "application/json":
            raise PersistenceError(422,"Informe e-mail e senha no formulário de acesso.")
        try:
            data = await request.json()
            if (not isinstance(data,dict) or not isinstance(data.get("email"),str) or not isinstance(data.get("password"),str)
                    or not 3 <= len(data["email"]) <= 254 or not 1 <= len(data["password"]) <= 1024):
                raise ValueError
        except (ValueError,UnicodeError):
            raise PersistenceError(422,"Informe e-mail e senha válidos.") from None
        opaque,result = await worker(auth.login,data["email"].strip(),data["password"],
            request.client.host if request.client else "unknown",request.cookies.get(SESSION_COOKIE))
        response = JSONResponse(result)
        cookie(response,SESSION_COOKIE,opaque,8*60*60)
        response.delete_cookie(PRELOGIN_COOKIE,path="/",secure=settings().secure,httponly=True,samesite="strict")
        return response

    @router.post("/api/auth/logout")
    @router.post("/api/auth/logout-all")
    async def logout(request: Request):
        identity = principal.get()
        if identity is None:
            raise PersistenceError(401,"Entre na sua conta para continuar.")
        await worker(service().logout,identity,request.url.path.endswith("logout-all"))
        response = JSONResponse({"sucesso":True})
        response.delete_cookie(SESSION_COOKIE,path="/",secure=settings().secure,httponly=True,samesite="strict")
        return response

    return router
