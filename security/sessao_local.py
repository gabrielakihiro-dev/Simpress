"""Per-boot local session: only the browser opened by the launcher may call /api/*.

Another Windows user (or a process without access to this user's profile) can still reach
127.0.0.1, so the server proves the caller by a random secret written only under the user's
%LOCALAPPDATA%. `/bootstrap?t=<secret>` turns it into an HttpOnly, SameSite=Strict cookie.

The bootstrap token equals the cookie value on purpose: the browser history that keeps the URL
lives in the same user profile as the secret file, so a one-time code would add no protection
against the target threat and would break reopening a running instance from the launcher.

The file and the cookie name carry the port, because cookies on 127.0.0.1 ignore the port and
two Simpress servers (e.g. a worktree on 8001) would otherwise overwrite each other's session.
"""

from __future__ import annotations

import hmac
import os
import secrets
from pathlib import Path
from typing import Optional

from starlette.requests import cookie_parser
from starlette.types import Scope

SEGREDO = secrets.token_urlsafe(32)


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


def cabecalho_cookie(port: int, valor: Optional[str] = None) -> str:
    """`Cookie` header value for internal clients; `valor` defaults to this process's secret."""
    return f"{nome_cookie(port)}={SEGREDO if valor is None else valor}"


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
