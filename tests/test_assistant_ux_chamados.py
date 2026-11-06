import unittest

from domains.assistant_api import SimpressApi
from domains.assistant_chat import AssistantConversation
from domains.assistant_openrouter import ModelReply


class FakeModel:
    def __init__(self):
        self.calls = []

    def complete(self, mensagens, _tools, **_kwargs):
        self.calls.append(repr(mensagens))
        return ModelReply(content="O modelo não deveria receber esta operação.")


class AssistantUXTests(unittest.TestCase):
    def test_description_and_profile_stay_local_and_sending_requires_a_program_card(self):
        calls = []
        def local(method, route, _params, body):
            calls.append((method, route, body))
            if route.endswith("/preparar"):
                return 200, {"serial": "S1", "modelo": "Modelo X", "session_id": "opaco", "opcoes": ["Teclado", "Mouse"]}
            return 200, {"status": "enviado", "os": "456"}

        model = FakeModel()
        conversa = AssistantConversation(model, SimpressApi(local))
        dados = {"serial": "S1", "descricao": "Descrição privada de teste com Pessoa Fictícia.", "revisao": 1}
        conversa.enviar_mensagem("Abrir chamado no UX. Descrição privada de teste com Pessoa Fictícia.", contexto_ux=dados)
        self.assertEqual(len(calls), 1)
        resposta = conversa.enviar_mensagem("Teclado", contexto_ux=dados)
        self.assertIn("Teclado", resposta.pendente["descricao"])
        self.assertNotIn("Pessoa Fictícia", resposta.pendente["descricao"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(model.calls, [])
        fim = conversa.resolver_confirmacao(True, contexto_ux=dados)
        self.assertIn("456", fim.texto)
        self.assertEqual(calls[-1][1], "/api/ux/abrir-chamado/enviar")
        self.assertEqual(calls[-1][2], {
            "session_id": "opaco", "serial": "S1", "problema": "Teclado", "descricao": dados["descricao"],
            "enviar": True, "confirmado": True,
        })


    def test_problem_must_be_a_literal_choice_and_changed_description_invalidates_card(self):
        calls = []
        def local(method, route, _params, body):
            calls.append(route)
            return 200, {"serial": "S1", "modelo": "Modelo X", "session_id": "opaco", "opcoes": ["Teclado", "Mouse"]}

        model = FakeModel()
        conversa = AssistantConversation(model, SimpressApi(local))
        dados = {"serial": "S1", "descricao": "O teclado não funciona.", "revisao": 1}
        conversa.enviar_mensagem("Abrir chamado no UX", contexto_ux=dados)
        self.assertIsNotNone(conversa.enviar_mensagem("Teclado", contexto_ux=dados).pendente)
        resposta = conversa.resolver_confirmacao(True, contexto_ux={**dados, "descricao": "Outro texto."})
        self.assertIn("Envio cancelado", resposta.texto)
        self.assertEqual(calls, ["/api/ux/abrir-chamado/preparar", "/api/ux/abrir-chamado/cancelar"])
        self.assertEqual(model.calls, [])

    def test_question_about_ux_tickets_never_opens_the_portal(self):
        rotas = []
        def local(method, route, _params, body):
            rotas.append(route)
            return 200, {}

        model = FakeModel()
        conversa = AssistantConversation(model, SimpressApi(local))
        dados = {"serial": "S1", "descricao": "O teclado não funciona.", "revisao": 1}
        for pergunta in ("quais chamados abertos no UX para essa série?", "Qual o atendimento do UX?"):
            conversa.enviar_mensagem(pergunta, contexto_ux=dados)
        self.assertEqual(len(model.calls), 2)
        self.assertFalse([r for r in rotas if "abrir-chamado" in r])

    def test_other_message_while_preparing_cancels_it_and_goes_to_the_model(self):
        rotas = []
        def local(method, route, _params, body):
            rotas.append(route)
            return 200, {"serial": "S1", "modelo": "Modelo X", "session_id": "opaco", "opcoes": ["Teclado", "Mouse"]}

        model = FakeModel()
        conversa = AssistantConversation(model, SimpressApi(local))
        dados = {"serial": "S1", "descricao": "O teclado não funciona.", "revisao": 1}
        conversa.enviar_mensagem("Abrir chamado no UX", contexto_ux=dados)
        resposta = conversa.enviar_mensagem("quais chamados abertos no UX para essa série?", contexto_ux=dados)
        self.assertNotIn("Digite exatamente", resposta.texto)
        self.assertEqual(len(model.calls), 1)
        self.assertIn("/api/ux/abrir-chamado/cancelar", rotas)
        self.assertIsNone(conversa.enviar_mensagem("Teclado", contexto_ux=dados).pendente)
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(rotas.count("/api/ux/abrir-chamado/preparar"), 1)
