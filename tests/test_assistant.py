import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.assistant import (
    OFFLINE_DETAIL,
    AssistantRouteServices,
    JarvisHttpError,
    JarvisUnreachable,
    create_assistant_router,
    urllib_transport,
    validated_jarvis_url,
)


class FakeTransport:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def __call__(self, method, url, payload, timeout):
        self.calls.append((method, url, payload, timeout))
        if self.error:
            raise self.error
        return self.result


def make_client(transport, url="http://127.0.0.1:8766"):
    app = FastAPI()
    app.include_router(create_assistant_router(AssistantRouteServices(jarvis_url=lambda: url, transport=transport)))
    return TestClient(app)


REPLY = {"texto": "oi", "ferramentas": ["buscar"], "pendente": {"descricao": "apagar", "extra": 1}, "x": 1}


class AssistantRouteTests(unittest.TestCase):
    def test_mensagem_forwards_and_normalizes(self):
        transport = FakeTransport(REPLY)
        response = make_client(transport).post("/api/assistente/mensagem", json={"texto": "olá"})
        self.assertEqual(response.json(), {"texto": "oi", "ferramentas": ["buscar"], "pendente": {"descricao": "apagar"}})
        self.assertEqual(transport.calls[0], ("POST", "http://127.0.0.1:8766/mensagem", {"texto": "olá"}, 90))

    def test_confirmar_and_limpar(self):
        transport = FakeTransport({"texto": "feito"})
        client = make_client(transport)
        body = client.post("/api/assistente/confirmar", json={"confirmado": True}).json()
        self.assertEqual(body, {"texto": "feito", "ferramentas": [], "pendente": None})
        self.assertEqual(client.post("/api/assistente/limpar").json(), {"ok": True})
        self.assertEqual(
            [c[1] for c in transport.calls],
            ["http://127.0.0.1:8766/confirmar", "http://127.0.0.1:8766/limpar"],
        )

    def test_estado_online_and_offline(self):
        transport = FakeTransport({"online": True, "modelo": "m", "aguardando_confirmacao": True, "pendente": {"descricao": "d"}})
        self.assertEqual(
            make_client(transport).get("/api/assistente/estado").json(),
            {"online": True, "modelo": "m", "aguardando_confirmacao": True, "pendente": {"descricao": "d"}},
        )
        self.assertEqual(transport.calls[0][3], 3)
        response = make_client(FakeTransport(error=JarvisUnreachable("x"))).get("/api/assistente/estado")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"online": False, "modelo": "", "aguardando_confirmacao": False, "pendente": None})

    def test_validation_422(self):
        client = make_client(FakeTransport(REPLY))
        for texto in ("", "x" * 4001):
            self.assertEqual(client.post("/api/assistente/mensagem", json={"texto": texto}).status_code, 422)
        self.assertEqual(client.post("/api/assistente/confirmar", json={}).status_code, 422)

    def test_unreachable_is_503(self):
        client = make_client(FakeTransport(error=JarvisUnreachable("timeout")))
        for path, body in (("mensagem", {"texto": "a"}), ("confirmar", {"confirmado": False}), ("limpar", None)):
            response = client.post(f"/api/assistente/{path}", json=body)
            self.assertEqual((response.status_code, response.json()), (503, {"detail": OFFLINE_DETAIL}))

    def test_upstream_errors(self):
        response = make_client(FakeTransport(error=JarvisHttpError(409, "Nada pendente."))).post(
            "/api/assistente/confirmar", json={"confirmado": True})
        self.assertEqual((response.status_code, response.json()), (409, {"detail": "Nada pendente."}))
        response = make_client(FakeTransport(error=JarvisHttpError(500, "segredo"))).post(
            "/api/assistente/mensagem", json={"texto": "a"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("segredo", response.text)

    def test_non_loopback_url_refused(self):
        for url in ("http://example.com:8766", "https://127.0.0.1:8766", "http://192.168.0.5", "", "http://127.0.0.1:x"):
            self.assertIsNone(validated_jarvis_url(url), url)
            transport = FakeTransport(REPLY)
            response = make_client(transport, url).post("/api/assistente/mensagem", json={"texto": "a"})
            self.assertEqual(response.status_code, 503)
            self.assertEqual(transport.calls, [])
        self.assertEqual(validated_jarvis_url("http://[::1]:8766"), "http://[::1]:8766")
        self.assertEqual(validated_jarvis_url("http://localhost:9"), "http://localhost:9")

    def test_real_transport_sends_no_origin_headers(self):
        seen = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                seen["headers"] = {k.lower(): v for k, v in self.headers.items()}
                self.rfile.read(int(self.headers["Content-Length"]))
                body = json.dumps({"ok": True}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            result = urllib_transport("POST", f"http://127.0.0.1:{server.server_port}/limpar", {}, 5)
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(result, {"ok": True})
        self.assertNotIn("origin", seen["headers"])
        self.assertNotIn("sec-fetch-site", seen["headers"])
        self.assertEqual(seen["headers"]["content-type"], "application/json")

    def test_real_transport_connection_refused(self):
        with self.assertRaises(JarvisUnreachable):
            urllib_transport("GET", "http://127.0.0.1:1/estado", None, 2)


if __name__ == "__main__":
    unittest.main()
