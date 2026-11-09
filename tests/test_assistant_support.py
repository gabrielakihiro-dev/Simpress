import base64
import io
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

from fastapi import FastAPI, File, UploadFile
from security import sessao_local
from pydantic import BaseModel

from domains.assistant_api import ArquivoUpload, SimpressApi, asgi_transport
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

    def test_deepseek_key_selects_direct_api_and_flash_model(self) -> None:
        settings = OpenRouterSettings.load(None, environ={
            "DEEPSEEK_API_KEY": SECRET, "OPENROUTER_API_KEY": "outra", "MODELO_PRINCIPAL": "a/b",
        })
        self.assertTrue(settings.deepseek)
        self.assertTrue(settings.configured)
        self.assertEqual(settings.api_key, SECRET)
        self.assertEqual(settings.base_url, "https://api.deepseek.com")
        self.assertEqual(settings.primary_model, "deepseek-flash")
        self.assertFalse(OpenRouterSettings.load(None, environ={"OPENROUTER_API_KEY": SECRET}).deepseek)

    def test_deepseek_payload_has_no_openrouter_routing_and_no_audio(self) -> None:
        sent: list = []
        client = OpenRouterClient(OpenRouterSettings(api_key=SECRET, deepseek=True, primary_model="deepseek-flash"))
        client._send = lambda payload, orcamento=None: sent.append(payload) or {"choices": [{"message": {"content": "ok"}}]}  # type: ignore[method-assign]
        client.complete([{"role": "user", "content": "oi"}], [])
        self.assertEqual(sent[0]["model"], "deepseek-flash")
        self.assertNotIn("models", sent[0])
        self.assertNotIn("provider", sent[0])
        with self.assertRaises(OpenRouterError):
            client.transcribe(b"RIFF")

    def test_deepseek_mode_sends_voice_to_openrouter_when_its_key_exists(self) -> None:
        settings = OpenRouterSettings.load(None, environ={"DEEPSEEK_API_KEY": SECRET, "OPENROUTER_API_KEY": "sk-or-v1-voz"})
        self.assertEqual(settings.voice_key, "sk-or-v1-voz")
        urls: list = []

        class Resposta:
            def __enter__(self) -> "Resposta":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def read(self, n: int = -1) -> bytes:
                return b'{"choices": [{"message": {"content": "ola mundo"}}]}'

        def abrir(request: urllib.request.Request, timeout: float) -> Resposta:
            urls.append((request.full_url, request.get_header("Authorization")))
            return Resposta()

        with mock.patch("urllib.request.urlopen", abrir):
            self.assertEqual(OpenRouterClient(settings).transcribe(b"RIFF"), "ola mundo")
        self.assertEqual(urls, [("https://openrouter.ai/api/v1/chat/completions", "Bearer sk-or-v1-voz")])

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

    def test_transcribe_sends_wav_as_input_audio_with_privacy_options(self) -> None:
        seen: List[Any] = []

        def fake(request: Any, timeout: float) -> FakeResponse:
            seen.append(request)
            return FakeResponse(ok_body("  quantos notebooks?  "))

        with mock.patch("urllib.request.urlopen", fake):
            texto = self.client.transcribe(b"RIFF0000WAVEdados")
        self.assertEqual(texto, "quantos notebooks?")
        body = json.loads(seen[0].data)
        self.assertEqual(body["model"], self.settings.audio_model)
        self.assertEqual(body["provider"]["data_collection"], "deny")
        audio = body["messages"][0]["content"][1]
        self.assertEqual(audio["type"], "input_audio")
        self.assertEqual(audio["input_audio"]["format"], "wav")
        self.assertEqual(base64.b64decode(audio["input_audio"]["data"]), b"RIFF0000WAVEdados")
        self.assertNotIn(SECRET, seen[0].data.decode())

    def test_transcribe_turns_no_speech_marker_into_empty_text(self) -> None:
        for answer in ("[SEM_FALA]", " [sem_fala] "):
            with mock.patch("urllib.request.urlopen", lambda request, timeout, answer=answer: FakeResponse(ok_body(answer))):
                self.assertEqual(self.client.transcribe(b"RIFF0000WAVEdados"), "")

    def test_audio_model_comes_from_env_and_bad_value_falls_back(self) -> None:
        self.assertEqual(OpenRouterSettings.load(None, environ={"MODELO_AUDIO": "a/b"}).audio_model, "a/b")
        self.assertEqual(
            OpenRouterSettings.load(None, environ={"MODELO_AUDIO": "lixo com espaco"}).audio_model,
            OpenRouterSettings().audio_model,
        )

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
        self.assertTrue(marker.startswith("Maria [PESSOA_"))  # first name visible (08/11/2026), surname hidden
        self.assertNotIn("Souza", marker)
        self.assertEqual(mask.restaurar(f"Olá {marker}"), "Olá Maria Souza")

    # First name visible in the mask (08/11/2026, pedido do usuário): only plain names of 2+ words; the rest stays hidden.
    NOME_LONGO = "Marina Beatriz Teixeira da Costa"

    def test_first_name_is_shown_the_rest_is_hidden_and_the_round_trip_is_exact(self) -> None:
        mask = Mascara()
        original = {"usuarios_logados": self.NOME_LONGO, "lista": [{"nome": self.NOME_LONGO}]}
        masked = mask.mascarar(original)
        texto = masked["usuarios_logados"]
        self.assertRegex(texto, r"^Marina \[PESSOA_\d+\]$")
        for escondido in ("Beatriz", "Teixeira", "Costa"):
            self.assertNotIn(escondido, json.dumps(masked, ensure_ascii=False))
        self.assertEqual(mask.restaurar(masked), original)
        marcador = texto.split(" ", 1)[1]
        self.assertEqual(mask.restaurar(marcador), self.NOME_LONGO)  # the bare marker is accepted too
        self.assertEqual(mask.restaurar(f"Pediu ao {marcador}."), f"Pediu ao {self.NOME_LONGO}.")
        self.assertEqual(mask.restaurar(f"Pediu à {texto}."), f"Pediu à {self.NOME_LONGO}.")  # no "Marina Marina"
        self.assertEqual(mask.restaurar(f"marina {marcador}"), self.NOME_LONGO)

    def test_logins_emails_nicknames_hostnames_and_single_words_keep_the_full_mask(self) -> None:
        casos = [
            ("login", "mbteixeira"),
            ("usuario", "PR-SEBRAE\\mbteixeira"),
            ("usuario", "ana.souza"),
            ("email", "marina.costa@sebrae.com.br"),
            ("apelido", "Marina Costa notebook"),
            ("computador", "PRNOTEUMU005"),
            ("nome", "Marina"),
            ("nome", "Maria-Clara Souza"),
            ("usuario_logado", "de Souza Pedro"),
        ]
        for chave, valor in casos:
            with self.subTest(chave=chave, valor=valor):
                mask = Mascara()
                saida = mask.mascarar({chave: valor})[chave]
                self.assertRegex(saida, r"^\[PESSOA_\d+\]$")
                self.assertEqual(mask.restaurar(saida), valor)

    def test_first_name_alone_stays_readable_but_the_other_parts_become_markers(self) -> None:
        mask = Mascara()
        mask.mascarar({"usuario_logado": self.NOME_LONGO})
        frase = "Marina pediu. Beatriz Costa ligou depois."
        saida = mask.mascarar({"mensagem": frase})["mensagem"]
        self.assertTrue(saida.startswith("Marina pediu. "))
        self.assertNotIn("Beatriz", saida)
        self.assertNotIn("Costa", saida)
        self.assertEqual(mask.restaurar(saida), frase)

    def test_ocultar_conhecidos_ignores_case_and_keeps_the_first_name_as_written(self) -> None:
        mask = Mascara()
        marcador = mask.mascarar({"usuario_logado": self.NOME_LONGO})["usuario_logado"].split(" ", 1)[1]
        self.assertEqual(mask.ocultar_conhecidos("MARINA BEATRIZ TEIXEIRA DA COSTA ligou"), f"MARINA {marcador} ligou")
        self.assertEqual(mask.ocultar_conhecidos("marina beatriz teixeira da costa ligou"), f"marina {marcador} ligou")
        # What leaves the computer (web search) shows nothing: the whole name is its marker, a lone first name is omitted.
        self.assertEqual(
            mask.ocultar_conhecidos(f"{self.NOME_LONGO} ligou; Marina voltou", completo=True),
            f"{marcador} ligou; [PESSOA] voltou",
        )

    def test_ocultar_conhecidos_completo_drops_a_visible_first_name_of_any_length(self) -> None:
        # Disk history and web search: "Ana [PESSOA_n]" (3 letters) must lose "Ana" too, not only 4+ letter names.
        mask = Mascara()
        visivel = mask.mascarar({"usuario_logado": "Ana Souza Lima"})["usuario_logado"]
        self.assertRegex(visivel, r"^Ana \[PESSOA_\d+\]$")
        marcador = visivel.split(" ", 1)[1]
        self.assertEqual(mask.ocultar_conhecidos(f"{visivel} ligou", completo=True), f"{marcador} ligou")
        self.assertEqual(mask.ocultar_conhecidos(f"ANA {marcador} ligou", completo=True), f"{marcador} ligou")
        # A word that is not the registered first name stays in front of the marker.
        self.assertEqual(mask.ocultar_conhecidos(f"Falou {marcador}", completo=True), f"Falou {marcador}")
        # Without `completo` the first name is still shown.
        self.assertEqual(mask.ocultar_conhecidos("Ana Souza Lima ligou"), f"Ana {marcador} ligou")

    def test_base_names_show_the_first_name_and_survive_limpar(self) -> None:
        texto = f"{self.NOME_LONGO} ligou"
        mask = Mascara()
        mask.registrar_base([self.NOME_LONGO, "TI"])
        antes = mask.ocultar_conhecidos(texto)
        self.assertRegex(antes, r"^Marina \[PESSOA_\d+\] ligou$")
        self.assertEqual(mask.restaurar(antes), texto)
        mask.limpar()
        self.assertEqual(mask.ocultar_conhecidos(texto), antes)
        sem_base = Mascara()
        sem_base.mascarar({"usuario_logado": self.NOME_LONGO})
        sem_base.limpar()
        self.assertEqual(sem_base.ocultar_conhecidos(texto), texto)

    def test_surname_equal_to_another_first_name_keeps_that_name_masked(self) -> None:
        # Known limit: a text already rendered before the collision was known keeps what it showed.
        # Inside one call the result does not depend on the order.
        a, b = "Marina Costa", "Costa Silva"
        for ordem in ((a, b), (b, a)):
            with self.subTest(ordem=ordem):
                mask = Mascara()
                original = [{"nome": nome} for nome in ordem]
                saida = mask.mascarar(original)
                por_nome = {nome: item["nome"] for nome, item in zip(ordem, saida)}
                self.assertRegex(por_nome[b], r"^\[PESSOA_\d+\]$")
                self.assertRegex(por_nome[a], r"^Marina \[PESSOA_\d+\]$")
                self.assertNotIn("Costa", json.dumps(saida))
                self.assertEqual(mask.restaurar(saida), original)

    def test_unknown_marker_is_left_alone_and_still_detected(self) -> None:
        mask = Mascara()
        marcado = mask.mascarar({"usuario_logado": self.NOME_LONGO})["usuario_logado"]
        self.assertTrue(Mascara.tem_marcador(marcado))
        self.assertEqual(mask.restaurar("Marina [PESSOA_99]"), "Marina [PESSOA_99]")
        self.assertTrue(Mascara.tem_marcador("Marina [PESSOA_99]"))

    def test_modo_normal_protege_primeiro_nome_junto_do_proprio_marcador(self) -> None:
        mask = Mascara()
        marcador = mask.mascarar({"usuario_logado": self.NOME_LONGO})["usuario_logado"].split(" ", 1)[1]
        mask.mascarar({"nome": "Marina"})  # "marina" passa a ser um valor conhecido de uma palavra
        oculto = mask.ocultar_conhecidos(f"Marina {marcador} ligou")
        self.assertEqual(oculto, f"{marcador} ligou")
        self.assertEqual(mask.restaurar(oculto), f"{self.NOME_LONGO} ligou")

    def test_restaurar_nao_duplica_primeiro_nome_com_formatacao_no_meio(self) -> None:
        mask = Mascara()
        marcador = mask.mascarar({"usuario_logado": self.NOME_LONGO})["usuario_logado"].split(" ", 1)[1]
        self.assertEqual(
            mask.restaurar(f"**Marina** {marcador}"), f"**{self.NOME_LONGO}**"
        )
        for texto in (f"Marina ({marcador})", f"Marina\n{marcador}"):
            with self.subTest(texto=texto):
                restaurado = mask.restaurar(texto)
                self.assertEqual(restaurado.count("Marina"), 1)
                self.assertIn(self.NOME_LONGO, restaurado)

    def test_modo_completo_oculta_primeiro_nome_de_qualquer_tamanho(self) -> None:
        mask = Mascara()
        mask.mascarar({"nome": "Ana Paula Souza"})
        oculto = mask.ocultar_conhecidos("a Ana pediram", completo=True)
        self.assertNotIn("Ana", oculto)
        self.assertEqual(oculto, "a [PESSOA] pediram")

    def test_solicitante_do_sistema_fica_fora_da_mascara(self) -> None:
        mask = Mascara()
        saida = mask.mascarar({"solicitante": "API SEBRAE", "usuario": "Api  Sébrae"})
        self.assertEqual(saida, {"solicitante": "API SEBRAE", "usuario": "Api  Sébrae"})
        self.assertFalse(Mascara.tem_marcador(json.dumps(saida)))
        self.assertEqual(mask.mascarar("o Sebrae pediu"), "o Sebrae pediu")
        mask.registrar_base(["API SEBRAE", "Ana Paula Souza"])
        oculto = mask.ocultar_conhecidos("API SEBRAE abriu; Ana Paula Souza", completo=True)
        self.assertEqual(oculto, "API SEBRAE abriu; [PESSOA_1]")


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

        @app.post("/api/envio")
        async def envio(file: UploadFile = File(...)) -> Dict[str, Any]:
            dados = await file.read()
            return {"nome": file.filename, "tipo": file.content_type, "tamanho": len(dados), "inicio": dados[:5].decode("latin-1")}

        self.transport = asgi_transport(lambda: app, 8000)

    def test_get_with_params_and_post_with_body(self) -> None:
        self.assertEqual(self.transport("GET", "/api/ping", {"q": "açaí"}, None), (200, {"q": "açaí"}))
        self.assertEqual(self.transport("POST", "/api/eco", None, {"nome": "Ana"}), (200, {"nome": "Ana"}))

    def test_multipart_file_goes_in_the_body_slot(self) -> None:
        conteudo = b"%PDF-1.4\n" + bytes(range(256))
        resposta = self.transport("POST", "/api/envio", None, ArquivoUpload("file", "laudo.pdf", conteudo))
        esperado = {"nome": "laudo.pdf", "tipo": "application/pdf", "tamanho": len(conteudo), "inicio": "%PDF-"}
        self.assertEqual(resposta, (200, esperado))

    def test_multipart_file_name_cannot_break_the_header_and_the_repr_hides_the_content(self) -> None:
        status, data = self.transport("POST", "/api/envio", None, ArquivoUpload("file", 'a"b\r\nX: y.pdf', b"%PDF-1.4"))
        self.assertEqual((status, data["nome"]), (200, "a_b__X: y.pdf"))
        self.assertNotIn("segredo", repr(ArquivoUpload("file", "a.pdf", b"segredo")))

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

        def fake_complete(self: Any, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]], orcamento: Any = None) -> ModelReply:
            sent.append(json.loads(json.dumps(messages)))
            return script.pop(0)

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-test-local"}):
            import main

            client = TestClient(main.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000), cookies={sessao_local.nome_cookie(main.SERVER_PORT): sessao_local.SEGREDO})
            with mock.patch.object(OpenRouterClient, "complete", fake_complete):
                started = time.monotonic()
                response = client.post("/api/assistente/mensagem", json={"texto": "quantos equipamentos?"})
                elapsed = time.monotonic() - started
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["ferramentas"], ["obter_totais_inventario"])
        self.assertLess(elapsed, 20)
        result = sent[1][-1]
        self.assertEqual(result["role"], "tool")
        for failure in ("401", "403", "500", "tempo", "Falha", "Sessão"):
            self.assertNotIn(failure, result["content"][:80], result["content"][:200])

    def test_audio_route_accepts_up_to_its_own_limit_and_rejects_beyond(self) -> None:
        import os

        from fastapi.testclient import TestClient

        from core.config import MAX_API_REQUEST_BYTES, MAX_ASSISTANT_AUDIO_BYTES

        def fake_transcribe(self: Any, wav: bytes) -> str:
            return f"{len(wav)} bytes"

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-test-local"}):
            import main

            client = TestClient(main.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000), cookies={sessao_local.nome_cookie(main.SERVER_PORT): sessao_local.SEGREDO})
            headers = {"Content-Type": "audio/wav"}
            wav = b"RIFF" + bytes(4) + b"WAVE" + bytes(MAX_API_REQUEST_BYTES)  # above the generic /api/ limit
            with mock.patch.object(OpenRouterClient, "transcribe", fake_transcribe):
                ok = client.post("/api/assistente/audio", content=wav, headers=headers)
                too_big = client.post("/api/assistente/audio", content=bytes(MAX_ASSISTANT_AUDIO_BYTES + 1), headers=headers)
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json(), {"texto": f"{len(wav)} bytes"})
        self.assertEqual(too_big.status_code, 413)

    def test_attachment_route_accepts_up_to_its_own_limit_and_rejects_beyond(self) -> None:
        import os
        import zipfile
        from urllib.parse import quote

        from fastapi.testclient import TestClient

        from core.config import MAX_API_REQUEST_BYTES, MAX_ASSISTANT_ATTACHMENT_BYTES

        pack = io.BytesIO()
        with zipfile.ZipFile(pack, "w", zipfile.ZIP_STORED) as docx:
            docx.writestr(
                "word/document.xml",
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                "<w:body><w:p><w:r><w:t>Ata da reuni\u00e3o</w:t></w:r></w:p></w:body></w:document>",
            )
            docx.writestr("word/media/padding.bin", bytes(MAX_API_REQUEST_BYTES))  # above the generic /api/ limit
        big_docx = pack.getvalue()
        self.assertGreater(len(big_docx), MAX_API_REQUEST_BYTES)

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-test-local"}):
            import main

            client = TestClient(main.app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000), cookies={sessao_local.nome_cookie(main.SERVER_PORT): sessao_local.SEGREDO})
            headers = {"X-Nome-Arquivo": quote("ata final.docx")}
            ok = client.post("/api/assistente/anexo", content=big_docx, headers=headers)
            too_big = client.post(
                "/api/assistente/anexo", content=bytes(MAX_ASSISTANT_ATTACHMENT_BYTES + 64 * 1024 + 1), headers=headers
            )
            listed = client.get("/api/assistente/anexos")
            removed = client.delete(f"/api/assistente/anexo/{ok.json().get('id', 'x')}")
            after = client.get("/api/assistente/anexos")
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["nome"], "ata final.docx")
        self.assertEqual(ok.json()["tipo"], "docx")
        self.assertEqual(too_big.status_code, 413)
        self.assertEqual([a["id"] for a in listed.json()["anexos"]], [ok.json()["id"]])
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(after.json(), {"anexos": []})


if __name__ == "__main__":
    unittest.main()
