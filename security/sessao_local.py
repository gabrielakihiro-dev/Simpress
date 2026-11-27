"""Per-boot local session: only the browser opened by the launcher may call /api/*.

Another Windows user (or a process without access to this user's profile) can still reach
127.0.0.1, so the server proves the caller by a random secret written only under the user's
%LOCALAPPDATA%. `/bootstrap?t=<secret>` is the only place the secret itself is accepted.

/api/* needs the cookie AND the `X-Simpress-Sessao` header (approved by the user on 26/11/2026),
both HMAC-SHA256 of the secret with different labels, so neither one opens `/bootstrap`:
- the HttpOnly, SameSite=Strict cookie is not port-isolated (RFC 6265): a server on another
  127.0.0.1 port receives it, but it alone is not enough;
- the header value goes to the page in the `/#sessao=<hex>` fragment of the bootstrap redirect and
  lives in localStorage, which is per origin (port included), so another port never sees it.

The file and the cookie name carry the port, because two Simpress servers (e.g. a worktree on 8001)
would otherwise overwrite each other's session.

Still open: the phone mode (`iniciar_servidor_celular.bat`) is plain HTTP on the LAN, so anyone who
can sniff that network sees the cookie and the header.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from pathlib import Path
from typing import Optional

from starlette.requests import cookie_parser
from starlette.types import Scope

SEGREDO = secrets.token_urlsafe(32)
NOME_CABECALHO = "x-simpress-sessao"
_ROTULO_COOKIE = b"simpress-sessao/cookie/v1"
_ROTULO_CABECALHO = b"simpress-sessao/cabecalho/v1"
_FORMATO = re.compile(rb"[0-9a-f]{64}")


def nome_cookie(port: int) -> str:
    return f"simpress_sessao_{port}"


def arquivo_sessao(port: int) -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "Simpress" / f"sessao_{port}.txt"


def gravar_segredo(port: int) -> Path:
    """Called only by the real server start (never at import: tests would clobber a live file)."""
    caminho = arquivo_sessao(port)
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(SEGREDO, encoding="ascii")
    return caminho


def ler_segredo(port: int) -> Optional[str]:
    """For child scripts: a fresh import of this module has a different SEGREDO, so read the file."""
    try:
        return arquivo_sessao(port).read_text(encoding="ascii").strip() or None
    except (OSError, UnicodeDecodeError):
        return None


def _derivar(rotulo: bytes, segredo: Optional[str] = None) -> str:
    return hmac.new((SEGREDO if segredo is None else segredo).encode("ascii"), rotulo, hashlib.sha256).hexdigest()


def cookie_derivado(segredo: Optional[str] = None) -> str:
    return _derivar(_ROTULO_COOKIE, segredo)


def cabecalho_derivado(segredo: Optional[str] = None) -> str:
    return _derivar(_ROTULO_CABECALHO, segredo)


def cabecalhos_sessao(port: int, segredo: Optional[str] = None) -> dict[str, str]:
    """Headers for internal clients; `segredo` defaults to this process's secret."""
    return {"Cookie": f"{nome_cookie(port)}={cookie_derivado(segredo)}", "X-Simpress-Sessao": cabecalho_derivado(segredo)}


def valido(valor: Optional[str]) -> bool:
    if not valor:
        return False
    return hmac.compare_digest(valor.encode("utf-8", "replace"), SEGREDO.encode("ascii"))


def cookie_do_scope(scope: Scope, port: int) -> Optional[str]:
    nome = nome_cookie(port)
    for chave, valor in scope.get("headers", []):
        if chave.lower() == b"cookie":
            encontrado = cookie_parser(valor.decode("latin-1")).get(nome)
            if encontrado:
                return encontrado
    return None


def sessao_valida(scope: Scope, port: int) -> bool:
    """/api/* gate: the derived cookie and exactly one derived X-Simpress-Sessao header."""
    cabecalhos = [valor for chave, valor in scope.get("headers", []) if chave.lower() == NOME_CABECALHO.encode("ascii")]
    cabecalho = cabecalhos[0] if len(cabecalhos) == 1 else b""
    cookie = (cookie_do_scope(scope, port) or "").encode("utf-8", "replace")
    # fullmatch: `$` would accept a trailing newline. Both digests always run (`&`, not `and`).
    cookie_ok = hmac.compare_digest(cookie if _FORMATO.fullmatch(cookie) else b"", cookie_derivado().encode("ascii"))
    cabecalho_ok = hmac.compare_digest(cabecalho if _FORMATO.fullmatch(cabecalho) else b"", cabecalho_derivado().encode("ascii"))
    return cookie_ok & cabecalho_ok
