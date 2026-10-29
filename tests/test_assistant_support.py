import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

from fastapi import FastAPI
from pydantic import BaseModel

from domains.assistant_api import SimpressApi, asgi_transport
from domains.assistant_lgpd import CPF_MASCARA, Mascara
from domains.assistant_openrouter import (
    OpenRouterClient,
    OpenRouterError,
    OpenRouterSettings,
    read_env_file,
)

CPF = "529.982.247-25"
SECRET = "sk-or-v1-chave-super-secreta"


class FakeResponse(io.BytesIO):
    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


def ok_body(content: str = "oi") -> bytes:
    return json.dumps({"model": "m", "choices": [{"message": {"role": "assistant", "content": content}}]}).encode()


def http_error(status: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://x", status, "err", {}, io.BytesIO(b"{}"))  # type: ignore[arg-type]


class SettingsTests(unittest.TestCase):
    def test_env_file_is_read_and_process_env_wins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text(f'# comentario\nOPENROUTER_API_KEY="{SECRET}"\nMODELO_PRINCIPAL=a/b\n', encoding="utf-8")
            self.assertEqual(read_env_file(path)["OPENROUTER_API_KEY"], SECRET)
            settings = OpenRouterSettings.load(path, environ={"MODELO_PRINCIPAL": "c/d"})
            self.assertEqual(settings.api_key, SECRET)
            self.assertEqual(settings.primary_model, "c/d")
            self.assertTrue(settings.configured)

    def test_missing_file_and_placeholder_are_not_configured(self) -> None:
        self.assertFalse(OpenRouterSettings.load(Path("nao-existe.env"), environ={}).configured)
        self.assertFalse(OpenRouterSettings.load(None, environ={"OPENROUTER_API_KEY": "sk-or-v1-coloque-sua-chave"}).configured)
        self.assertFalse(OpenRouterSettings.load(None, environ={"OPENROUTER_API_KEY": "  "}).configured)

    def test_plain_http_base_url_and_bad_values_fall_back(self) -> None:
        settings = OpenRouterSettings.load(None, environ={
            "OPENROUTER_API_KEY": SECRET, "OPENROUTER_BASE_URL": "http://evil.example",
            "MODELO_PRINCIPAL": "lixo com espaco", "ROUTING_SORT": "inventado",
        })
        self.assertTrue(settings.base_url.startswith("https://"))
        self.assertEqual(settings.primary_model, OpenRouterSettings().primary_model)
        self.assertEqual(settings.routing_sort, OpenRouterSettings().routing_sort)

    def test_repr_hides_the_key(self) -> None:
        self.assertNotIn(SECRET, repr(OpenRouterSettings(api_key=SECRET)))


class ClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = OpenRouterSettings(api_key=SECRET)
        self.sleeps: List[float] = []
        self.client = OpenRouterClient(self.settings, sleep=self.sleeps.append)

    def test_success_sends_privacy_options_and_key_only_in_header(self) -> None:
        seen: List[Any] = []

        def fake(request: Any, timeout: float) -> FakeResponse:
            seen.append(request)
            return FakeResponse(ok_body("olá"))

        with mock.patch("urllib.request.urlopen", fake):
            reply = self.client.complete([{"role": "user", "content": "oi"}], [])
        self.assertEqual(reply.content, "olá")
        request = seen[0]
        body = json.loads(request.data)
        self.assertEqual(body["provider"]["data_collection"], "deny")
        self.assertEqual(len(body["models"]), 2)
        self.assertNotIn(SECRET, request.data.decode())
        self.assertEqual(request.get_header("Authorization"), f"Bearer {SECRET}")

    def test_retries_then_succeeds(self) -> None:
        answers: List[Any] = [http_error(429), urllib.error.URLError("rede"), FakeResponse(ok_body())]

        def fake(request: Any, timeout: float) -> FakeResponse:
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        with mock.patch("urllib.request.urlopen", fake):
            self.assertEqual(self.client.complete([], []).content, "oi")
        self.assertEqual(self.sleeps, [1.0, 2.0])

    def test_gives_up_after_three_attempts_without_leaking_the_key(self) -> None:
        with mock.patch("urllib.request.urlopen", side_effect=http_error(503)) as patched:
            with self.assertRaises(OpenRouterError) as caught:
                self.client.complete([], [])
        self.assertEqual(patched.call_count, 3)
        self.assertNotIn(SECRET, str(caught.exception))

    def test_non_retryable_status_stops_at_once(self) -> None:
        with mock.patch("urllib.request.urlopen", side_effect=http_error(401)) as patched:
            with self.assertRaises(OpenRouterError):
                self.client.complete([], [])
        self.assertEqual(patched.call_count, 1)

    def test_unreadable_body(self) -> None:
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(b"nao e json")):
            with self.assertRaises(OpenRouterError):
                self.client.complete([], [])


class MaskTests(unittest.TestCase):
    def test_cpf_email_phone_and_password_are_cleaned(self) -> None:
        mask = Mascara()
        out = mask.mascarar(f"CPF {CPF}, email ana@x.com, tel (41) 99999-1234, senha: abc123")
        self.assertNotIn(CPF, out)
        self.assertNotIn("ana@x.com", out)
        self.assertNotIn("99999-1234", out)
        self.assertNotIn("abc123", out)
        self.assertIn(CPF_MASCARA, out)

    def test_names_become_markers_and_come_back(self) -> None:
        mask = Mascara()
        masked = mask.mascarar({"usuarios_logados": "Maria Souza"})
        marker = masked["usuarios_logados"]
        self.assertTrue(Mascara.tem_marcador(marker))
        self.assertNotIn("Maria", marker)
        self.assertEqual(mask.restaurar(f"Olá {marker}"), "Olá Maria Souza")


class PingBody(BaseModel):
    nome: str


class TransportTests(unittest.TestCase):
    """The tools reach routes through the ASGI transport; check it against a small app."""

    def setUp(self) -> None:
        app = FastAPI()

        @app.get("/api/ping")
        def ping(q: str = "") -> Dict[str, Any]:
            return {"q": q}

        @app.post("/api/eco")
        def eco(body: PingBody) -> Dict[str, Any]:
            return {"nome": body.nome}

        self.transport = asgi_transport(lambda: app, 8000)

    def test_get_with_params_and_post_with_body(self) -> None:
        self.assertEqual(self.transport("GET", "/api/ping", {"q": "açaí"}, None), (200, {"q": "açaí"}))
        self.assertEqual(self.transport("POST", "/api/eco", None, {"nome": "Ana"}), (200, {"nome": "Ana"}))

    def test_missing_route_returns_404_and_api_turns_it_into_text(self) -> None:
        self.assertEqual(self.transport("GET", "/api/nada", None, None)[0], 404)
        ok, data = SimpressApi(self.transport)._chamar("GET", "/api/nada")
        self.assertFalse(ok)
        self.assertIsInstance(data, str)


class RealAppTests(unittest.TestCase):
    """Production chain: request into main.app, sync route in a worker thread, tool, nested ASGI call into main.app."""

    def test_query_tool_reaches_a_real_route_through_the_middleware(self) -> None:
        import os
        import time

        from fastapi.testclient import TestClient

        from domains.assistant_openrouter import ModelReply, ModelToolCall

        sent: List[List[Dict[str, Any]]] = []
        script = [
            ModelReply(tool_calls=[ModelToolCall("t1", "obter_totais_inventario", "{}")]),
            ModelReply(content="ok"),
        ]

        def fake_complete(self: Any, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> ModelReply:
            sent.append(json.loads(json.dumps(messages)))
            return script.pop(0)

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-test-local"}):
            import main

            client = TestClient(main.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000))
            with mock.patch.object(OpenRouterClient, "complete", fake_complete):
                started = time.monotonic()
                response = client.post("/api/assistente/mensagem", json={"texto": "quantos equipamentos?"})
                elapsed = time.monotonic() - started
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["ferramentas"], ["obter_totais_inventario"])
        self.assertLess(elapsed, 20)
        result = sent[1][-1]
        self.assertEqual(result["role"], "tool")
        for failure in ("403", "500", "tempo", "Falha"):
            self.assertNotIn(failure, result["content"][:80], result["content"][:200])


if __name__ == "__main__":
    unittest.main()
