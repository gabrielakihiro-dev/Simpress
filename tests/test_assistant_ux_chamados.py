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

    def test_failed_preparation_shows_the_router_message_without_form_data(self):
        aviso = "Não foi possível abrir ou conectar o Chrome de automação. Feche as janelas desse Chrome e tente de novo."
        model = FakeModel()
        conversa = AssistantConversation(model, SimpressApi(lambda *_a: (503, {"detail": aviso, "codigo": "chrome_indisponivel"})))
        dados = {"serial": "S1", "descricao": "Descrição privada de teste.", "revisao": 1}
        resposta = conversa.enviar_mensagem("Abrir chamado no UX", contexto_ux=dados)
        self.assertIn(aviso, resposta.texto)
        self.assertNotIn("Descrição privada", resposta.texto)
        self.assertIsNone(resposta.pendente)
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

    def test_atualizacao_cadastral_ticket_goes_to_the_model_not_to_the_home_flow(self):
        rotas = []
        def local(method, route, _params, body):
            rotas.append(route)
            return 200, {"serial": "S1", "modelo": "Modelo X", "session_id": "opaco", "opcoes": ["Teclado"]}

        model = FakeModel()
        conversa = AssistantConversation(model, SimpressApi(local))
        dados = {"serial": "S1", "descricao": "O teclado não funciona.", "revisao": 1}
        frases = (
            "como gero o ticket de atualização cadastral no UX?",
            "gerar ticket no UX",
            "abrir chamado de alteração de endereço no UX",
            "abre o chamado de atualização cadastral no UX",
            "criar solicitação de alteração de razão social no UX",
            "abrir ticket no UX para a série S1",
        )
        for frase in frases:
            conversa.enviar_mensagem(frase, contexto_ux=dados)
        self.assertEqual(len(model.calls), len(frases))
        self.assertFalse([r for r in rotas if "abrir-chamado" in r])
        conversa.enviar_mensagem("Abrir chamado no UX", contexto_ux=dados)
        self.assertEqual([r for r in rotas if "/api/ux/" in r], ["/api/ux/abrir-chamado/preparar"])

    def test_outlook_email_questions_go_to_the_model_not_to_the_home_flow(self):
        rotas = []
        def local(method, route, _params, body):
            rotas.append(route)
            return 200, {"serial": "S1", "modelo": "Modelo X", "session_id": "opaco", "opcoes": ["Teclado"]}

        model = FakeModel()
        conversa = AssistantConversation(model, SimpressApi(local))
        dados = {"serial": "S1", "descricao": "O cabo de segurança não chegou.", "revisao": 1}
        frases = (
            "como mando o e-mail do cabo de segurança?",
            "abre o e-mail do cabo no Outlook",
            "criar o e-mail de solicitação do cabo de segurança",
            "enviar e-mail do cabo pelo Outlook",
        )
        for frase in frases:
            conversa.enviar_mensagem(frase, contexto_ux=dados)
        self.assertEqual(len(model.calls), len(frases))
        self.assertFalse([r for r in rotas if "abrir-chamado" in r])
        # A real equipment problem that mentions a cable still opens the Home flow.
        conversa.enviar_mensagem("abrir chamado no UX, cabo do carregador quebrado", contexto_ux=dados)
        self.assertEqual([r for r in rotas if "/api/ux/" in r], ["/api/ux/abrir-chamado/preparar"])

    def test_system_prompt_points_the_cadastral_ticket_to_transporte(self):
        from domains.assistant_chat import SYSTEM_PROMPT
        for trecho in ("Gerar Planilha", "Transporte (F2)", "Gerar ticket no UX", "Revisar e finalizar",
                       "Você não abre nem finaliza esse ticket", "O Registro já vem preenchido com o Texto para Transporte",
                       "modelo de chamado \"Deslocamento\"", "botão \"Texto para Transporte\" da aba Transporte (F2)",
                       "retirada e entrega"):
            self.assertIn(trecho, SYSTEM_PROMPT)
        self.assertNotIn("não tem mais o modelo", SYSTEM_PROMPT)

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
