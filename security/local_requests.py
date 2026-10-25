"""ASGI middleware that keeps the application local and bounded.

It accepts only direct loopback peers with a local Host (and matching Origin
on API calls), caps request bodies, admits one upload at a time and replaces
unexpected exceptions with a generic response.
"""

import asyncio
import logging
import traceback
from dataclasses import dataclass
from typing import Any, Callable, FrozenSet, Optional, Tuple, Type
from urllib.parse import urlsplit

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from core.config import REQUEST_BODY_IDLE_TIMEOUT_SECONDS
from core.integrity import FileBusyError
from core.inventory_requests import IDEMPOTENCY_KEY_ERROR, IDEMPOTENCY_KEY_PATTERN
from security.network import is_direct_loopback_request

logger = logging.getLogger(__name__)

# Sent on every response, early rejections included; HTML pages add their CSP in routers/frontend.py.
SECURITY_RESPONSE_HEADERS = (
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
)
# Sec-Fetch-Site values for the app's own pages and URLs typed or bookmarked by the user.
ALLOWED_API_FETCH_SITES = frozenset({b"same-origin", b"none"})


class RequestBodyTooLarge(Exception):
    pass


class RequestBodyTimeout(Exception):
    pass


@dataclass(frozen=True)
class RequestBodyLimits:
    upload_request_bytes: int
    upload_bytes: int
    ticket_workbook_bytes: int
    api_request_bytes: int
    entra_csv_request_bytes: int


@dataclass(frozen=True)
class LocalRequestSafetyServices:
    allowed_authorities: Callable[[], FrozenSet[Tuple[str, int]]]
    inventory_upload_paths: Callable[[], FrozenSet[str]]
    body_limits: Callable[[], RequestBodyLimits]
    upload_admission: Callable[[], Any]
    idempotent_upload_wait_seconds: Callable[[], float]
    service_unavailable_errors: Tuple[Type[Exception], ...]


def allowed_local_authorities(port: int) -> FrozenSet[Tuple[str, int]]:
    return frozenset({
        ("127.0.0.1", port),
        ("localhost", port),
        ("::1", port),
    })


def parse_request_authority(
    value: bytes,
    *,
    is_origin: bool = False,
) -> Optional[tuple[str, int]]:
    """Normalize a local Host or HTTP Origin without accepting suffix tricks."""
    try:
        text = value.decode("ascii")
    except UnicodeDecodeError:
        return None
    if not text or text != text.strip() or any(ord(character) < 0x20 for character in text):
        return None

    try:
        if is_origin:
            parsed = urlsplit(text)
            if (
                parsed.scheme.lower() != "http"
                or not parsed.netloc
                or parsed.path
                or parsed.query
                or parsed.fragment
            ):
                return None
        else:
            parsed = urlsplit(f"//{text}")
            if parsed.path or parsed.query or parsed.fragment:
                return None
        if parsed.username is not None or parsed.password is not None:
            return None
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None

    if hostname is None or port is None:
        return None
    return hostname.rstrip(".").lower(), port


def send_with_security_headers(send: Send) -> Send:
    async def send_with_headers(message: Message) -> None:
        if message["type"] == "http.response.start":
            headers = list(message.get("headers", []))
            present = {name.lower() for name, _ in headers}
            headers.extend(header for header in SECURITY_RESPONSE_HEADERS if header[0] not in present)
            message = {**message, "headers": headers}
        await send(message)

    return send_with_headers


class LocalRequestSafetyMiddleware:
    """Restrict local peers and authorities, cap uploads, and hide exceptions."""

    def __init__(self, app: ASGIApp, services: LocalRequestSafetyServices) -> None:
        self.app = app
        self.services = services

    def websocket_allowed(self, scope: Scope) -> bool:
        """Browsers do not apply the same-origin policy to WebSockets, so Origin is mandatory."""
        if not is_direct_loopback_request(scope):
            return False
        raw_headers = scope.get("headers", [])
        host_values = [value for key, value in raw_headers if key.lower() == b"host"]
        origin_values = [value for key, value in raw_headers if key.lower() == b"origin"]
        if len(host_values) != 1 or len(origin_values) != 1:
            return False
        host_authority = parse_request_authority(host_values[0])
        return (
            host_authority is not None
            and host_authority in self.services.allowed_authorities()
            and parse_request_authority(origin_values[0], is_origin=True) == host_authority
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            if not self.websocket_allowed(scope):
                # Closing before accept makes the server answer the handshake with 403.
                await send({"type": "websocket.close", "code": 1008})
                return
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        send = send_with_security_headers(send)
        if not is_direct_loopback_request(scope):
            response = JSONResponse(
                status_code=403,
                content={"detail": "A aplicação aceita somente conexões locais diretas, sem proxy."},
            )
            await response(scope, receive, send)
            return

        services = self.services
        path = scope.get("path", "")
        raw_headers = scope.get("headers", [])
        headers = {key.lower(): value for key, value in raw_headers}
        host_values = [value for key, value in raw_headers if key.lower() == b"host"]
        if len(host_values) != 1:
            response = JSONResponse(
                status_code=400,
                content={"detail": "O cabeçalho Host da solicitação é inválido."},
            )
            await response(scope, receive, send)
            return

        host_authority = parse_request_authority(host_values[0])
        if host_authority is None:
            response = JSONResponse(
                status_code=400,
                content={"detail": "O cabeçalho Host da solicitação é inválido."},
            )
            await response(scope, receive, send)
            return
        if host_authority not in services.allowed_authorities():
            response = JSONResponse(
                status_code=403,
                content={"detail": "O Host não está autorizado para a aplicação local."},
            )
            await response(scope, receive, send)
            return

        origin_values = [value for key, value in raw_headers if key.lower() == b"origin"]
        if path.startswith("/api/") and origin_values and (
            len(origin_values) != 1
            or parse_request_authority(origin_values[0], is_origin=True) != host_authority
        ):
            response = JSONResponse(
                status_code=403,
                content={"detail": "Origem não autorizada para a aplicação local."},
            )
            await response(scope, receive, send)
            return

        # GETs from another site carry no Origin; the browser's fetch metadata still names the caller.
        fetch_sites = [value.lower() for key, value in raw_headers if key.lower() == b"sec-fetch-site"]
        if path.startswith("/api/") and fetch_sites and (
            len(fetch_sites) != 1 or fetch_sites[0] not in ALLOWED_API_FETCH_SITES
        ):
            response = JSONResponse(
                status_code=403,
                content={"detail": "Origem não autorizada para a aplicação local."},
            )
            await response(scope, receive, send)
            return

        is_inventory_upload = path in services.inventory_upload_paths()
        is_model_upload = path.startswith("/api/modelos/") and path.endswith("/importar")
        is_ticket_upload = path == "/api/operacoes/chamados/importar"
        is_entra_upload = path == "/api/usuarios-entra/importar" and scope.get("method") == "POST"
        limits = services.body_limits()
        body_limit = (
            limits.upload_request_bytes if is_inventory_upload
            else limits.upload_bytes + 1024 * 1024 if is_model_upload
            else 2 * limits.ticket_workbook_bytes + 1024 * 1024 if is_ticket_upload
            else limits.entra_csv_request_bytes if is_entra_upload
            else limits.api_request_bytes if path.startswith("/api/")
            else None
        )
        if body_limit is not None:
            content_length = headers.get(b"content-length")
            if content_length is not None:
                try:
                    request_size = int(content_length)
                except (TypeError, ValueError):
                    response = JSONResponse(
                        status_code=400,
                        content={"detail": "O tamanho do envio é inválido."},
                    )
                    await response(scope, receive, send)
                    return
                if request_size > body_limit:
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": "O corpo da solicitação excede o limite permitido."},
                    )
                    await response(scope, receive, send)
                    return

        uses_upload_admission = is_inventory_upload or is_model_upload or is_ticket_upload or path == "/api/recarregar-base"
        if uses_upload_admission:
            key_headers = [value for name, value in raw_headers if name.lower() == b"idempotency-key"]
            is_keyed_inventory_update = is_inventory_upload and scope.get("method") == "POST"
            if is_keyed_inventory_update and len(key_headers) > 1:
                response = JSONResponse(
                    status_code=422,
                    content={"detail": "Informe somente uma Idempotency-Key."},
                )
                await response(scope, receive, send)
                return
            if (
                is_keyed_inventory_update
                and key_headers
                and not IDEMPOTENCY_KEY_PATTERN.fullmatch(key_headers[0].decode("latin-1"))
            ):
                response = JSONResponse(
                    status_code=422,
                    content={"detail": IDEMPOTENCY_KEY_ERROR},
                )
                await response(scope, receive, send)
                return
            upload_admission = services.upload_admission()
            admitted = upload_admission.acquire(blocking=False)
            if (
                not admitted
                and is_keyed_inventory_update
                and len(key_headers) == 1
            ):
                # A keyed retry waits behind the in-flight upload so it can read
                # the durable receipt instead of failing before idempotency runs.
                deadline = asyncio.get_running_loop().time() + services.idempotent_upload_wait_seconds()
                while not admitted and asyncio.get_running_loop().time() < deadline:
                    await asyncio.sleep(0.02)
                    admitted = upload_admission.acquire(blocking=False)
            if not admitted:
                response = JSONResponse(
                    status_code=503,
                    content={"detail": "A operação de inventário está ocupada. Tente novamente em instantes."},
                    headers={"Retry-After": "2"},
                )
                await response(scope, receive, send)
                return

        response_started = False
        request_size = 0

        async def safe_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        body_complete = False

        async def limited_receive() -> Message:
            nonlocal request_size, body_complete
            if body_limit is None or body_complete:
                # After the body ends receive() only waits for disconnect, which may legitimately idle.
                return await receive()
            try:
                message = await asyncio.wait_for(receive(), REQUEST_BODY_IDLE_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                raise RequestBodyTimeout() from None
            if message["type"] == "http.request":
                request_size += len(message.get("body", b""))
                if request_size > body_limit:
                    raise RequestBodyTooLarge()
                body_complete = not message.get("more_body", False)
            return message

        try:
            await self.app(scope, limited_receive, safe_send)
        except RequestBodyTimeout:
            if response_started:
                return
            response = JSONResponse(
                status_code=408,
                content={"detail": "O envio do corpo da solicitação demorou demais."},
                headers={"Connection": "close"},
            )
            await response(scope, receive, send)
        except RequestBodyTooLarge:
            if response_started:
                return
            response = JSONResponse(
                status_code=413,
                content={"detail": "O corpo da solicitação excede o limite permitido."},
            )
            await response(scope, receive, send)
        except services.service_unavailable_errors as error:
            if response_started:
                return
            response = JSONResponse(status_code=503, content={"detail": str(error)})
            await response(scope, receive, send)
        except FileBusyError as error:
            # Routes without their own mapping (readiness during an import) answer like the others.
            if response_started:
                return
            response = JSONResponse(
                status_code=409,
                content={"detail": str(error)},
                headers={"Retry-After": "2"},
            )
            await response(scope, receive, send)
        except Exception as error:
            # Frames and source lines only: exception messages may quote workbook cells.
            logger.error(
                "Falha interna na rota %s (%s).\n%s",
                path or "/",
                type(error).__name__,
                "".join(traceback.format_tb(error.__traceback__)).rstrip(),
            )
            if response_started:
                return
            response = JSONResponse(
                status_code=500,
                content={"detail": "Falha interna do servidor. Consulte os logs locais."},
            )
            await response(scope, receive, send)
        finally:
            if uses_upload_admission:
                upload_admission.release()
