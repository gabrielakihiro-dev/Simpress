"""Local connection policy using synthetic ASGI clients and no operational data."""

import asyncio
from contextlib import redirect_stdout
import importlib.util
import io
import unittest
from unittest.mock import Mock, patch

with (
    patch("integrity.recover_pending_transactions", return_value=None),
    patch("openpyxl.load_workbook", side_effect=RuntimeError("operational data blocked")),
    redirect_stdout(io.StringIO()),
):
    import main

HTTP_TEST_AVAILABLE = importlib.util.find_spec("httpx") is not None
if HTTP_TEST_AVAILABLE:
    from fastapi.testclient import TestClient
from persistence.boundary import PersistenceBoundaryMiddleware
from persistence.config import PersistenceError, PersistenceSettings
from security.config import AuthSettings
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware


def run_boundary(client, *, postgres=False, headers=(), proxy=False, boundary_only=False):
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

    app = PersistenceBoundaryMiddleware(endpoint, lambda: postgres)
    if not boundary_only:
        app = main.LocalRequestSafetyMiddleware(app)
    if proxy:
        # Even an accidentally trusted proxy must not turn a spoofed header into access.
        app = ProxyHeadersMiddleware(app, trusted_hosts="*")
    scope = {"type": "http", "path": "/api/stats", "method": "GET",
             "scheme": "http", "client": client,
             "headers": [(b"host", f"localhost:{main.SERVER_PORT}".encode()), *headers]}
    asyncio.run(app(scope, receive, send))
    return next(message["status"] for message in messages
                if message["type"] == "http.response.start"), bool(reached)


class LocalRequestSecurityTests(unittest.TestCase):
    def test_remote_peer_with_local_host_is_denied_in_both_backends(self):
        for postgres in (False, True):
            for address in ("192.0.2.1", "10.0.0.1", "2001:db8::1", "::ffff:192.0.2.1"):
                with self.subTest(postgres=postgres, address=address):
                    self.assertEqual(run_boundary((address, 1234), postgres=postgres), (403, False))

    def test_ipv4_ipv6_and_mapped_loopback_are_accepted_consistently(self):
        for postgres, boundary_only in ((False, False), (True, False), (True, True)):
            for address in ("127.0.0.1", "127.1.2.3", "::1", "0:0:0:0:0:0:0:1",
                            "::ffff:127.0.0.1", "::ffff:7f00:1"):
                with self.subTest(postgres=postgres, boundary_only=boundary_only, address=address):
                    self.assertEqual(run_boundary((address, 1234), postgres=postgres,
                                                  boundary_only=boundary_only), (200, True))

    def test_absent_malformed_or_scoped_client_fails_closed(self):
        clients = (None, (), ("127.0.0.1",), "127.0.0.1", {}, (None, 1234),
                   (2130706433, 1234), ("localhost", 1234), ("invalid", 1234),
                   ("127.0.0.1:1234", 1234), ("[::1]", 1234), ("::1%lo", 1234),
                   (" 127.0.0.1", 1234), ("127.0.0.1", "bad-port"))
        for postgres, boundary_only in ((False, False), (True, False), (True, True)):
            for client in clients:
                with self.subTest(postgres=postgres, boundary_only=boundary_only, client=client):
                    self.assertEqual(run_boundary(client, postgres=postgres,
                                                  boundary_only=boundary_only), (403, False))

    def test_forwarded_headers_are_denied_even_for_loopback_connections(self):
        for postgres, boundary_only in ((False, False), (True, False), (True, True)):
            for name in (b"forwarded", b"x-forwarded-for", b"X-Forwarded-Host",
                         b"x-forwarded-proto", b"x-forwarded-port", b"x-real-ip"):
                for address in ("127.0.0.1", "192.0.2.1"):
                    with self.subTest(postgres=postgres, header=name, address=address):
                        self.assertEqual(run_boundary((address, 1234), postgres=postgres,
                                                      boundary_only=boundary_only,
                                                      headers=[(name, b"127.0.0.1")]), (403, False))

    def test_uvicorn_proxy_rewriting_cannot_bypass_connection_policy(self):
        for postgres in (False, True):
            with self.subTest(postgres=postgres):
                self.assertEqual(run_boundary(("192.0.2.1", 1234), postgres=postgres,
                                              proxy=True, headers=[(b"x-forwarded-for", b"127.0.0.1")]),
                                 (403, False))

    @unittest.skipUnless(HTTP_TEST_AVAILABLE, "Optional httpx test dependency is not installed")
    def test_actual_application_local_public_routes_and_auth_remain_available(self):
        for mode, auth in (("files", False), ("postgres", False), ("postgres", True)):
            service = Mock()
            service.prelogin.return_value = ("a" * 43, "synthetic-challenge")
            service.load.side_effect = PersistenceError(401, "Entre novamente.")
            backend = Mock(auth=service)
            origin = f"http://127.0.0.1:{main.SERVER_PORT}"
            with (patch.object(main, "PERSISTENCE_SETTINGS", PersistenceSettings(mode)),
                  patch.object(main, "AUTH_SETTINGS", AuthSettings(enabled=auth, origin=origin)),
                  patch.object(main, "_POSTGRES_BACKEND", backend)):
                for address, expected in (("127.0.0.1", 200), ("::1", 200),
                                          ("::ffff:127.0.0.1", 200), ("192.0.2.1", 403)):
                    client = TestClient(main.app, base_url=origin, client=(address, 1234))
                    try:
                        for path in ("/login", "/static/favicon.svg", "/api/auth/session"):
                            with self.subTest(mode=mode, auth=auth, address=address, path=path):
                                self.assertEqual(client.get(path).status_code, expected)
                        if auth and expected == 200:
                            self.assertEqual(client.get("/api/stats").status_code, 401)
                    finally:
                        client.close()


if __name__ == "__main__":
    unittest.main()
