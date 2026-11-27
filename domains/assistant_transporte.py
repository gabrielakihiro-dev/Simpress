"""Loopback transport of the assistant: runs a request through the FastAPI app inside this process.

`asgi_transport` builds the request by hand, so every call passes the same safety middleware as a
browser request (session cookie and header included; no network, no extra server).
"""

import asyncio
import json
import re
import secrets
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple, Union
from urllib.parse import quote, urlencode

from security import sessao_local

# (method, path, query params, JSON body or an ArquivoUpload for multipart) -> (HTTP status, decoded JSON or text)
Transport = Callable[[str, str, Optional[Dict[str, Any]], Any], Tuple[int, Any]]
CALL_TIMEOUT_SECONDS = 30.0
ENDPOINT_LOOKUP_TIMEOUT_SECONDS = 1200.0  # Endpoint login wait (600 s) + navigation and filters (480 s); keeps the route thread from outliving the call.
MAX_ANSWER_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class ArquivoUpload:
    """A file for a multipart/form-data call (08/11/2026): goes in the `corpo` slot of a Transport call, instead of a JSON dict.

    Kept in memory only; `conteudo` stays out of repr so a log line or a traceback never prints it.
    """

    campo: str
    nome: str
    conteudo: bytes = field(repr=False)
    tipo: str = "application/pdf"


def _corpo_multipart(arquivo: ArquivoUpload) -> Tuple[bytes, str]:
    """(body, content-type) of a one-field multipart request, as a browser would send it."""
    fronteira = "simpress" + secrets.token_hex(16)
    # The name comes from the user: no quote, backslash or line break may reach the Content-Disposition header.
    nome = re.sub(r'[\r\n"\\\x00-\x1f\x7f]', "_", arquivo.nome)
    cabecalho = (
        f"--{fronteira}\r\n"
        f'Content-Disposition: form-data; name="{arquivo.campo}"; filename="{nome}"\r\n'
        f"Content-Type: {arquivo.tipo}\r\n\r\n"
    ).encode("utf-8")
    return cabecalho + arquivo.conteudo + f"\r\n--{fronteira}--\r\n".encode("ascii"), f"multipart/form-data; boundary={fronteira}"


async def _asgi_call(
    app: Any, port: int, method: str, path: str, params: Optional[Dict[str, Any]], body: Union[Dict[str, Any], ArquivoUpload, None],
) -> Tuple[int, Any]:
    tipo_corpo = ""
    if isinstance(body, ArquivoUpload):
        payload, tipo_corpo = _corpo_multipart(body)
    elif body is not None:
        payload, tipo_corpo = json.dumps(body, ensure_ascii=False).encode("utf-8"), "application/json"
    else:
        payload = b""
    headers: List[Tuple[bytes, bytes]] = [
        (b"host", f"127.0.0.1:{port}".encode("ascii")),
        (b"accept", b"application/json"),
    ]
    # Same process as the server, so this SEGREDO is the live one (security/sessao_local.py).
    headers += [(nome.lower().encode("ascii"), valor.encode("ascii")) for nome, valor in sessao_local.cabecalhos_sessao(port).items()]
    if tipo_corpo:
        headers += [(b"content-type", tipo_corpo.encode("ascii")), (b"content-length", str(len(payload)).encode("ascii"))]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": quote(path, safe="/").encode("ascii"),
        "query_string": urlencode(params or {}).encode("ascii"),
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", port),
    }
    sent_body = False
    finished = asyncio.Event()
    status = 0
    chunks: List[bytes] = []
    size = 0
    content_type = ""

    async def receive() -> Dict[str, Any]:
        nonlocal sent_body
        if not sent_body:
            sent_body = True
            return {"type": "http.request", "body": payload, "more_body": False}
        await finished.wait()
        return {"type": "http.disconnect"}

    async def send(message: Dict[str, Any]) -> None:
        nonlocal status, size, content_type
        if message["type"] == "http.response.start":
            status = int(message["status"])
            for name, value in message.get("headers", []):
                if name.lower() == b"content-type":
                    content_type = value.decode("latin-1")
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            size += len(chunk)
            if size <= MAX_ANSWER_BYTES:
                chunks.append(chunk)

    try:
        await app(scope, receive, send)
    finally:
        finished.set()
    if size > MAX_ANSWER_BYTES:
        raise ValueError("answer too large")
    raw = b"".join(chunks)
    if "json" in content_type:
        return status, json.loads(raw.decode("utf-8") or "null")
    if "spreadsheetml" in content_type:  # exported .xlsx: keep the bytes
        return status, raw
    return status, raw.decode("utf-8", errors="replace")


def asgi_transport(app_getter: Callable[[], Any], port: int) -> Transport:
    """A Transport that runs the request inside the FastAPI app. Meant for a worker thread (sync routes)."""

    def call(method: str, path: str, params: Optional[Dict[str, Any]], body: Union[Dict[str, Any], ArquivoUpload, None]) -> Tuple[int, Any]:
        async def run() -> Tuple[int, Any]:
            timeout = CALL_TIMEOUT_SECONDS
            if method == "POST" and path in ("/api/endpoint/consultar", "/api/endpoint/controle-remoto", "/api/endpoint/powershell"):
                timeout = ENDPOINT_LOOKUP_TIMEOUT_SECONDS
            elif method == "POST" and path in ("/api/ux/abrir-chamado/preparar", "/api/ux/abrir-chamado/enviar"):
                timeout = 580.0
            return await asyncio.wait_for(_asgi_call(app_getter(), port, method, path, params, body), timeout)

        return asyncio.run(run())

    return call
