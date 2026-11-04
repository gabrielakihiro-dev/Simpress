import json
import unittest
from unittest.mock import patch

from domains.assistant_api import SimpressApi, asgi_transport
from domains.assistant_lgpd import Mascara
from domains.assistant_tools import TOOLS, schemas_para_mensagem
from domains.assistant_chat import AssistantConversation
from tests.test_assistant import FakeModel, calls, call, text, abrir


class AssistantEndpointTests(unittest.TestCase):
    def test_only_endpoint_route_has_extended_transport_timeout(self):
        limits = []
        async def wait(awaitable, timeout):
            limits.append(timeout)
            return await awaitable
        async def response(*args):
            return 200, {"status": "not_found", "serial": "ABC"}
        with patch("domains.assistant_api.asyncio.wait_for", side_effect=wait), patch("domains.assistant_api._asgi_call", side_effect=response):
            transport = asgi_transport(lambda: None, 8000)
            transport("POST", "/api/endpoint/consultar", None, {"serial": "ABC"})
            transport("POST", "/api/endpoint/controle-remoto", None, {"serial": "ABC"})
            transport("GET", "/api/stats", None, None)
        self.assertGreaterEqual(limits[0], 120)
        self.assertEqual(limits[1], limits[0])
        self.assertEqual(limits[2], 30)

    def test_slow_endpoint_lookup_preserves_budget_for_final_model_answer(self):
        now = [0.0]
        model = FakeModel(calls(call("consultar_endpoint", serial="ABC")), text("Consulta concluída."))
        def transport(method, path, params, body):
            if path == "/api/endpoint/consultar":
                now[0] += 100
                return 200, {"status": "not_found", "serial": "ABC"}
            return 200, {"items": [], "has_more": False}
        conversation = AssistantConversation(model, SimpressApi(transport), "modelo-teste", relogio=lambda: now[0])
        response = conversation.enviar_mensagem("Consulte ABC no Endpoint")
        self.assertEqual(response.texto, "Consulta concluída.")
        self.assertEqual(len(model.sent), 2)

    def test_only_one_endpoint_lookup_can_spend_extended_timeout_per_turn(self):
        lookups = []
        model = FakeModel(calls(call("consultar_endpoint", serial="ABC"), call("consultar_endpoint", serial="OTHER")), text("Consulta concluída."))
        def transport(method, path, params, body):
            if path == "/api/endpoint/consultar":
                lookups.append(body["serial"])
                return 200, {"status": "not_found", "serial": body["serial"]}
            return 200, {"items": [], "has_more": False}
        conversation = AssistantConversation(model, SimpressApi(transport), "modelo-teste")
        conversation.enviar_mensagem("Consulte ABC e OTHER no Endpoint")
        self.assertEqual(lookups, ["ABC"])
        self.assertIn("uma consulta Endpoint por mensagem", model.sent[1][-1]["content"])
    def test_same_read_only_route_and_user_masked_before_model(self):
        calls = []
        def transport(method, path, params, body):
            calls.append((method, path, body))
            return 200, {"status": "found", "serial": "ABC", "ultimo_logon": "Private User", "extra": "must not escape"}
        tool = TOOLS["consultar_endpoint"]
        self.assertFalse(tool.changes_data)
        result = tool.run(SimpressApi(transport), {"serial": "abc"})
        self.assertEqual(calls, [("POST", "/api/endpoint/consultar", {"serial": "ABC"})])
        self.assertNotIn("extra", result)
        mask = Mascara()
        safe = mask.mascarar(result)
        self.assertNotIn("Private User", json.dumps(safe))
        self.assertIn("[PESSOA_", json.dumps(safe))
        self.assertEqual(mask.restaurar(safe)["ultimo_logon"], "Private User")

    def test_tool_available_for_endpoint_and_last_logon_requests(self):
        for prompt in ("Consulte ABC no Endpoint", "Qual o usuário do último logon de ABC?"):
            self.assertIn("consultar_endpoint", [s["function"]["name"] for s in schemas_para_mensagem(prompt)])

    def test_http_error_is_not_not_found(self):
        result = TOOLS["consultar_endpoint"].run(SimpressApi(lambda *args: (409, {"detail": "Chrome ocupado"})), {"serial": "ABC"})
        self.assertIn("erro", result)
        self.assertNotEqual(result.get("status"), "not_found")

    def test_local_ambiguity_origin_is_retained_for_model(self):
        result = TOOLS["consultar_endpoint"].run(SimpressApi(lambda *args: (200, {"status": "ambiguous", "serial": "SABC", "origem": "base_local"})), {"serial": "SABC"})
        self.assertEqual(result["origem"], "base_local")

    def test_conversation_model_never_receives_endpoint_user_and_screen_restores_it(self):
        class EchoModel(FakeModel):
            def complete(self, messages, tools, orcamento=None):
                if len(self.sent) == 1:
                    self.replies.append(text("Usuário: " + json.loads(abrir(messages[-1]["content"]))["ultimo_logon"]))
                return super().complete(messages, tools, orcamento)
        model = EchoModel(calls(call("consultar_endpoint", serial="ABC")))
        def transport(method, path, params, body):
            if path == "/api/endpoint/consultar":
                return 200, {"status": "found", "serial": "ABC", "ultimo_logon": "Private User"}
            return 200, {"items": [], "has_more": False}
        conversation = AssistantConversation(model, SimpressApi(transport), "modelo-teste")
        response = conversation.enviar_mensagem("Consulte ABC no Endpoint")
        self.assertIsNone(response.pendente)
        self.assertEqual(response.ferramentas, ["consultar_endpoint"])
        self.assertIn("Private User", response.texto)
        self.assertNotIn("Private User", json.dumps(model.sent))


class AssistantRemoteControlTests(unittest.TestCase):
    def conversation(self, response, requests):
        def transport(method, path, params, body):
            if method == "POST":
                requests.append((path, body))
                return 200, response
            return 200, {"items": [], "has_more": False}
        model = FakeModel(calls(call("abrir_controle_remoto", serial="abc")), text("Pronto."))
        return AssistantConversation(model, SimpressApi(transport), "modelo-teste"), model

    def test_remote_control_is_a_change_tool_and_needs_confirmation(self):
        self.assertTrue(TOOLS["abrir_controle_remoto"].changes_data)
        requests = []
        conversation, _ = self.conversation({"status": "connected", "serial": "ABC", "hostname": "PC1"}, requests)
        reply = conversation.enviar_mensagem("Abra o controle remoto da ABC")
        self.assertIn("ABC", reply.pendente["descricao"])
        self.assertIn("acesso", reply.pendente["descricao"])
        self.assertEqual(requests, [])  # nothing connects before the card is confirmed
        conversation.resolver_confirmacao(True)
        self.assertEqual(requests, [("/api/endpoint/controle-remoto", {"serial": "ABC"})])

    def test_cancel_never_connects(self):
        requests = []
        conversation, _ = self.conversation({"status": "connected", "serial": "ABC"}, requests)
        conversation.enviar_mensagem("Conecte na ABC")
        conversation.resolver_confirmacao(False)
        self.assertEqual(requests, [])

    def test_results_are_distinct(self):
        for status, success, trecho in (("connected", True, "solicitado"), ("offline", False, "offline"),
                                        ("not_found", False, "não encontrado"), ("ambiguous", False, "não foi aberto")):
            result = TOOLS["abrir_controle_remoto"].run(
                SimpressApi(lambda *args, s=status: (200, {"status": s, "serial": "ABC", "hostname": "PC1"})), {"serial": "abc"})
            self.assertEqual(result["sucesso"], success, status)
            self.assertIn(trecho, result["mensagem"], status)

    def test_http_error_and_unknown_status_are_errors(self):
        for answer in ((503, {"detail": "falha"}), (200, {"status": "x"}), (409, {"detail": "ocupado"})):
            result = TOOLS["abrir_controle_remoto"].run(SimpressApi(lambda *args, a=answer: a), {"serial": "ABC"})
            self.assertFalse(result["sucesso"])
            self.assertIn("erro", result)
        self.assertFalse(TOOLS["abrir_controle_remoto"].run(SimpressApi(lambda *args: (200, {})), {"serial": " "})["sucesso"])

    def test_tool_only_sent_for_remote_requests(self):
        for prompt in ("Abra o controle remoto da ABC", "Quero acesso remoto na ABC", "Conecte na máquina ABC"):
            self.assertIn("abrir_controle_remoto", [s["function"]["name"] for s in schemas_para_mensagem(prompt)], prompt)
        self.assertNotIn("abrir_controle_remoto", [s["function"]["name"] for s in schemas_para_mensagem("Consulte ABC no Endpoint")])
        self.assertNotIn("abrir_controle_remoto", [s["function"]["name"] for s in schemas_para_mensagem("quais chamados estão abertos?")])

