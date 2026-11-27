"""Reuse a running local Simpress server or select an available local port."""

from __future__ import annotations

import hashlib
import hmac
import os
import socket
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


HOST = "127.0.0.1"
FIRST_PORT = 8000
LAST_PORT = 8099
# Route added after the first releases; a Simpress answering 404 for it is an old server.
CURRENT_PATH = "/api/automacao/estado"
PORT_PROBE_TIMEOUT = 0.1
HTTP_PROBE_TIMEOUT = 0.75


def _read_secret(port: int) -> str | None:
    """Per-boot secret the server writes under the user's %LOCALAPPDATA% (security/sessao_local.py)."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    try:
        return (Path(base) / "Simpress" / f"sessao_{port}.txt").read_text(encoding="ascii").strip() or None
    except (OSError, UnicodeDecodeError):
        return None


def _derive(secret: str, label: bytes) -> str:
    """Same HMAC as security/sessao_local.py (this script must not import the app); tests check parity."""
    return hmac.new(secret.encode("ascii"), label, hashlib.sha256).hexdigest()


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _probe_simpress(port: int) -> dict | None:
    """Return {"outdated": bool} when a Simpress answers on the port, else None.

    /openapi.json is off by default, so identity is checked with the session secret: the server that
    wrote sessao_<port>.txt answers /bootstrap?t=<secret> with 303 and a cookie carrying the value
    derived from that secret (HMAC, security/sessao_local.py). This is not a strong proof (the secret
    is sent before any proof, so a process that knows the derivation could answer); it fits the
    single-user local threat model (security/sessao_local.py).
    The secret is never printed or logged. After the 303, any failure of the version check counts
    as a running server (never None), so the .bat does not start a second copy.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
            connection.settimeout(PORT_PROBE_TIMEOUT)
            if connection.connect_ex((HOST, port)) != 0:
                return None
    except OSError:
        return None

    secret = _read_secret(port)
    if not secret:
        return None
    cookie = f"simpress_sessao_{port}={_derive(secret, b'simpress-sessao/cookie/v1')}"
    session = {"Cookie": cookie, "X-Simpress-Sessao": _derive(secret, b"simpress-sessao/cabecalho/v1")}
    opener = build_opener(ProxyHandler({}), _NoRedirect)
    try:
        with opener.open(
            f"http://{HOST}:{port}/bootstrap?t={quote(secret, safe='')}", timeout=HTTP_PROBE_TIMEOUT
        ):
            return None  # a Simpress answers 303, never a plain 200
    except HTTPError as error:
        if error.code != 303 or cookie not in (error.headers.get("Set-Cookie") or ""):
            return None
    except Exception:
        return None

    # Identity checked: from here on, never None.
    try:
        with opener.open(
            Request(f"http://{HOST}:{port}{CURRENT_PATH}", headers=session), timeout=HTTP_PROBE_TIMEOUT
        ):
            return {"outdated": False}
    except HTTPError as error:
        return {"outdated": error.code == 404}
    except Exception:
        return {"outdated": False}


def _is_simpress_running(port: int) -> bool:
    return _probe_simpress(port) is not None


def _is_outdated(result: dict) -> bool:
    return bool(result.get("outdated"))


def _listening_pid(port: int) -> str | None:
    """PID listening on the port (Windows netstat), or None when it cannot be found."""
    try:
        output = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in output.splitlines():
        columns = line.split()
        if len(columns) >= 5 and columns[3].upper() == "LISTENING" and columns[1].endswith(f":{port}"):
            return columns[4]
    return None


def _describe_port(port: int) -> str:
    pid = _listening_pid(port)
    return f"porta {port}" + (f" (PID {pid})" if pid else "")


def _is_port_available(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind((HOST, port))
        return True
    except OSError:
        return False


def main() -> int:
    first_available_port: int | None = None

    for port in range(FIRST_PORT, LAST_PORT + 1):
        if _is_port_available(port):
            if first_available_port is None:
                first_available_port = port
            continue

        result = _probe_simpress(port)
        if result is not None:
            if _is_outdated(result):
                print(
                    f"AVISO: o servidor Simpress em execucao na {_describe_port(port)} esta desatualizado "
                    "(sem as rotas /api/automacao). Feche essa janela do servidor e abra o iniciar_servidor.bat de novo.",
                    file=sys.stderr,
                )
                print(f"OUTDATED:{port}")
                return 0
            print(f"RUNNING:{port}")
            return 0
        if first_available_port is None:
            print(
                f"AVISO: a {_describe_port(port)} esta ocupada por outro programa (nao e o Simpress); "
                "o servidor usara a proxima porta livre.",
                file=sys.stderr,
            )

    if first_available_port is not None:
        print(f"PORT:{first_available_port}")
        return 0

    print(
        f"ERRO: nenhuma porta local entre {FIRST_PORT} e {LAST_PORT} está disponível.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
