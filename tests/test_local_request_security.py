"""Local connection policy using synthetic ASGI clients and no operational data."""

import asyncio
from contextlib import redirect_stdout
import importlib.util
import io
import threading
import unittest
from unittest.mock import patch

with (
    patch("core.integrity.recover_pending_transactions", return_value=None),
    patch("openpyxl.load_workbook", side_effect=RuntimeError("operational data blocked")),
    redirect_stdout(io.StringIO()),
):
    import main

HTTP_TEST_AVAILABLE = importlib.util.find_spec("httpx") is not None
if HTTP_TEST_AVAILABLE:
    from fastapi.testclient import TestClient
from core.integrity import FileBusyError
from core.inventory_requests import InventoryUpdateMiddleware
from security import local_requests
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware


def run_boundary(
    client, *, headers=(), proxy=False,
    path="/api/stats", method="GET",
):
    messages = []
    reached = []

    async def endpoint(scope, receive, send):
        reached.append(True)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def receive():
        raise AssertionError("Rejected requests must not consume the body")

    async def send(message):
        messages.append(message)

    app = main.LocalRequestSafetyMiddleware(InventoryUpdateMiddleware(endpoint))
    if proxy:
        # Even an accidentally trusted proxy must not turn a spoofed header into access.
        app = ProxyHeadersMiddleware(app, trusted_hosts="*")
    scope = {"type": "http", "path": path, "method": method,
             "scheme": "http", "client": client,
             "headers": [(b"host", f"localhost:{main.SERVER_PORT}".encode()), *headers]}
    asyncio.run(app(scope, receive, send))
    return next(message["status"] for message in messages
                if message["type"] == "http.response.start"), bool(reached)


def run_endpoint(endpoint, *, headers=(), path="/api/stats", method="GET", client=("127.0.0.1", 1234)):
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    scope = {"type": "http", "path": path, "method": method,
             "scheme": "http", "client": client,
             "headers": [(b"host", f"localhost:{main.SERVER_PORT}".encode()), *headers]}
    asyncio.run(main.LocalRequestSafetyMiddleware(endpoint)(scope, receive, send))
    start = next(message for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return start["status"], {name.lower(): value for name, value in start["headers"]}, body


async def ok_endpoint(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


class LocalRequestSecurityTests(unittest.TestCase):
    def test_every_response_carries_the_browser_hardening_headers(self):
        for client, expected in ((("127.0.0.1", 1234), 200), (("192.0.2.1", 1234), 403)):
            with self.subTest(client=client):
                status, headers, _ = run_endpoint(ok_endpoint, client=client)
                self.assertEqual(status, expected)
                for name, value in local_requests.SECURITY_RESPONSE_HEADERS:
                    self.assertEqual(headers[name], value)

    def test_route_headers_take_precedence_over_defaults(self):
        async def framed(scope, receive, send):
            await send({"type": "http.response.start", "status": 200,
                        "headers": [(b"X-Frame-Options", b"SAMEORIGIN")]})
            await send({"type": "http.response.body", "body": b""})

        _, headers, _ = run_endpoint(framed)
        self.assertEqual(headers[b"x-frame-options"], b"SAMEORIGIN")

    def test_api_rejects_requests_that_the_browser_marks_as_cross_site(self):
        for value, expected in ((b"cross-site", 403), (b"same-site", 403), (b"Cross-Site", 403),
                                (b"same-origin", 200), (b"none", 200)):
            with self.subTest(sec_fetch_site=value):
                status, _, _ = run_endpoint(ok_endpoint, headers=[(b"sec-fetch-site", value)])
                self.assertEqual(status, expected)
        status, _, _ = run_endpoint(ok_endpoint, headers=[(b"sec-fetch-site", b"none"),
                                                         (b"sec-fetch-site", b"none")])
        self.assertEqual(status, 403)
        # A link from another site may still open the page itself.
        status, _, _ = run_endpoint(ok_endpoint, path="/", headers=[(b"sec-fetch-site", b"cross-site")])
        self.assertEqual(status, 200)

    def test_unmapped_busy_file_answers_409_with_its_message(self):
        async def busy(scope, receive, send):
            raise FileBusyError("A planilha ou configuração está ocupada por outra operação local.")

        status, headers, body = run_endpoint(busy, path="/api/prontidao")
        self.assertEqual(status, 409)
        self.assertEqual(headers[b"retry-after"], b"2")
        self.assertIn("ocupada por outra operação local", body.decode("utf-8"))

    def test_unexpected_failure_logs_the_stack_without_the_exception_message(self):
        private_value = "PRIVATE_CELL_VALUE"

        async def failing(scope, receive, send):
            raise ValueError(private_value)

        with self.assertLogs(local_requests.logger, level="ERROR") as captured:
            status, _, body = run_endpoint(failing, path="/api/stats")
        self.assertEqual(status, 500)
        self.assertNotIn("PRIVATE_CELL_VALUE", body.decode("utf-8"))
        text = "\n".join(captured.output)
        self.assertIn("/api/stats", text)
        self.assertIn("ValueError", text)
        self.assertIn("in failing", text)
        self.assertNotIn("PRIVATE_CELL_VALUE", text)

    def test_keyed_inventory_retry_waits_for_in_flight_upload_admission(self):
        admission = threading.BoundedSemaphore(1)
        self.assertTrue(admission.acquire(blocking=False))
        messages = []

        async def endpoint(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        async def receive():
            raise AssertionError("The safety middleware must not consume the upload body")

        async def send(message):
            messages.append(message)

        async def release_admission():
            await asyncio.sleep(0.03)
            admission.release()

        async def invoke():
            scope = {
                "type": "http",
                "path": "/api/planilhas/atualizar",
                "method": "POST",
                "scheme": "http",
                "client": ("127.0.0.1", 1234),
                "headers": [
                    (b"host", f"localhost:{main.SERVER_PORT}".encode()),
                    (b"idempotency-key", b"retry-01"),
                ],
            }
            app = main.LocalRequestSafetyMiddleware(endpoint)
            release_task = asyncio.create_task(release_admission())
            await app(scope, receive, send)
            await release_task

        with (
            patch.object(main, "UPLOAD_ADMISSION", admission),
            patch.object(main, "IDEMPOTENT_UPLOAD_ADMISSION_WAIT_SECONDS", 0.5),
        ):
            asyncio.run(invoke())

        self.assertEqual(
            next(message["status"] for message in messages if message["type"] == "http.response.start"),
            200,
        )

    def test_file_inventory_update_validates_one_compatible_idempotency_key(self):
        update_path = "/api/planilhas/atualizar"
        self.assertEqual(
            run_boundary(
                ("127.0.0.1", 1234),
                path=update_path,
                method="POST",
                headers=[(b"idempotency-key", b"upload-01:A_b.c")],
            ),
            (200, True),
        )
        for headers in (
            [(b"idempotency-key", b"first"), (b"Idempotency-Key", b"second")],
            [(b"idempotency-key", b"invalid key")],
            [(b"idempotency-key", b"k" * 129)],
            [(b"idempotency-key", b"")],
        ):
            with self.subTest(headers=headers):
                self.assertEqual(
                    run_boundary(
                        ("127.0.0.1", 1234),
                        path=update_path,
                        method="POST",
                        headers=headers,
                    ),
                    (422, False),
                )

    def test_file_mode_idempotency_validation_is_scoped_to_inventory_update(self):
        self.assertEqual(
            run_boundary(
                ("127.0.0.1", 1234),
                headers=[(b"idempotency-key", b"first"), (b"idempotency-key", b"second")],
            ),
            (200, True),
        )

    def test_remote_peer_with_local_host_is_denied(self):
        for address in ("192.0.2.1", "10.0.0.1", "2001:db8::1", "::ffff:192.0.2.1"):
            with self.subTest(address=address):
                self.assertEqual(run_boundary((address, 1234)), (403, False))

    def test_ipv4_ipv6_and_mapped_loopback_are_accepted_consistently(self):
        for address in ("127.0.0.1", "127.1.2.3", "::1", "0:0:0:0:0:0:0:1",
                        "::ffff:127.0.0.1", "::ffff:7f00:1"):
            with self.subTest(address=address):
                self.assertEqual(run_boundary((address, 1234)), (200, True))

    def test_absent_malformed_or_scoped_client_fails_closed(self):
        clients = (None, (), ("127.0.0.1",), "127.0.0.1", {}, (None, 1234),
                   (2130706433, 1234), ("localhost", 1234), ("invalid", 1234),
                   ("127.0.0.1:1234", 1234), ("[::1]", 1234), ("::1%lo", 1234),
                   (" 127.0.0.1", 1234), ("127.0.0.1", "bad-port"))
        for client in clients:
            with self.subTest(client=client):
                self.assertEqual(run_boundary(client), (403, False))

    def test_forwarded_headers_are_denied_even_for_loopback_connections(self):
        for name in (b"forwarded", b"x-forwarded-for", b"X-Forwarded-Host",
                     b"x-forwarded-proto", b"x-forwarded-port", b"x-real-ip"):
            for address in ("127.0.0.1", "192.0.2.1"):
                with self.subTest(header=name, address=address):
                    self.assertEqual(run_boundary((address, 1234),
                        headers=[(name, b"127.0.0.1")]), (403, False))

    def test_uvicorn_proxy_rewriting_cannot_bypass_connection_policy(self):
        self.assertEqual(run_boundary(("192.0.2.1", 1234),
            proxy=True, headers=[(b"x-forwarded-for", b"127.0.0.1")]), (403, False))

    @unittest.skipUnless(HTTP_TEST_AVAILABLE, "Optional httpx test dependency is not installed")
    def test_actual_application_local_public_routes_remain_available(self):
        origin = f"http://127.0.0.1:{main.SERVER_PORT}"
        for address, expected in (("127.0.0.1", 200), ("::1", 200),
                                  ("::ffff:127.0.0.1", 200), ("192.0.2.1", 403)):
            client = TestClient(main.app, base_url=origin, client=(address, 1234))
            self.addCleanup(client.close)
            for path in ("/", "/static/favicon.svg", "/openapi.json"):
                with self.subTest(address=address, path=path):
                    self.assertEqual(client.get(path).status_code, expected)

    @unittest.skipUnless(HTTP_TEST_AVAILABLE, "Optional httpx test dependency is not installed")
    def test_removed_login_and_pilot_routes_are_unavailable(self):
        client = TestClient(main.app, base_url=f"http://127.0.0.1:{main.SERVER_PORT}",
                            client=("127.0.0.1", 1234))
        self.addCleanup(client.close)
        for path in ("/login", "/api/auth/session", "/api/piloto/operacoes",
                     "/static/pages/login.html", "/static/js/auth/auth-session.js"):
            with self.subTest(path=path):
                self.assertEqual(client.get(path).status_code, 404)
        for path in ("/api/auth/login", "/api/auth/logout", "/api/auth/logout-all"):
            with self.subTest(path=path):
                self.assertEqual(client.post(path, json={}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
