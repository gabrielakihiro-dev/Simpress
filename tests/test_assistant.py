import json
import threading
import time
import unittest
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.assistant_api import SimpressApi
from domains.assistant_chat import MSG_OCUPADO, MSG_SEM_CHAVE, AssistantBusy, AssistantConversation
from domains.assistant_openrouter import ModelReply, ModelToolCall, OpenRouterError, OpenRouterSettings
from domains.assistant_tools import CHANGE_TOOLS, QUERY_TOOLS, TOOLS, tool_schemas
from routers.assistant import AssistantRouteServices, create_assistant_router

CPF = "529.982.247-25"


class FakeSimpress:
    """Stands in for the transport: answers the routes the tests need and records every call."""

    def __init__(self) -> None:
        self.calls: List[Tuple[str, str, Optional[Dict[str, Any]], Optional[Dict[str, Any]]]] = []
        self.equipamento = {"serial": "ABC123", "modelo": "ProBook", "usuarios_logados": "Maria Souza", "cidade": "Curitiba"}

    def __call__(self, method: str, path: str, params: Optional[Dict[str, Any]], body: Optional[Dict[str, Any]]) -> Tuple[int, Any]:
        self.calls.append((method, path, params, body))
        if path == "/api/buscar-expandida":
            return 200, {"items": [{"usuarios_logados": "Maria Souza"}], "has_more": False}
        if path == "/api/equipamento/ABC123":
            return 200, self.equipamento
        if path == "/api/equipamento/atualizar-apelido":
            return 200, {"ok": True}
        return 404, {"detail": "não existe"}

    def writes(self) -> List[Tuple[str, str]]:
        return [(m, p) for m, p, _, _ in self.calls if m != "GET"]


class FakeModel:
    """Plays a script of replies and keeps a deep copy of what it was sent."""

    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies)
        self.sent: List[List[Dict[str, Any]]] = []

    def complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> ModelReply:
        self.sent.append(json.loads(json.dumps(messages)))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def call(name: str, **args: Any) -> ModelToolCall:
    return ModelToolCall(id=f"id-{name}", name=name, arguments=json.dumps(args))


def calls(*items: ModelToolCall) -> ModelReply:
    return ModelReply(tool_calls=list(items))


def text(content: str) -> ModelReply:
    return ModelReply(content=content)


def make_conversation(model: Optional[FakeModel], simpress: Optional[FakeSimpress] = None) -> Tuple[AssistantConversation, FakeSimpress]:
    simpress = simpress or FakeSimpress()
    return AssistantConversation(model, SimpressApi(simpress), "modelo-teste"), simpress


class ToolCatalogTests(unittest.TestCase):
    def test_every_tool_declares_kind_and_schema(self) -> None:
        self.assertEqual(len(TOOLS), len(QUERY_TOOLS) + len(CHANGE_TOOLS))
        for tool in QUERY_TOOLS:
            self.assertFalse(tool.changes_data, tool.name)
        for tool in CHANGE_TOOLS:
            self.assertTrue(tool.changes_data and tool.describe, tool.name)
        for schema in tool_schemas():
            function = schema["function"]
            self.assertTrue(function["name"] and function["description"])
            self.assertEqual(function["parameters"]["type"], "object")

    def test_dropped_tools_are_absent(self) -> None:
        for name in ("abrir_importacao", "exportar_planilha", "logar_site"):
            self.assertNotIn(name, TOOLS)

    def test_dashboard_routine_is_the_baixar_importar_buscar_button(self) -> None:
        tool = TOOLS["executar_automacao_chrome"]
        self.assertIn("dashboard", tool.properties["rotina"]["enum"])
        self.assertIn("Baixar, importar e buscar", tool.description)
        self.assertIn("Baixar, importar e buscar", tool.describe({"rotina": "dashboard"}))  # type: ignore[misc]
        self.assertEqual(tool.describe({"rotina": "os"}), "Executar a rotina 'os' de automação no Chrome.")  # type: ignore[misc]

    def test_confirmation_text_is_built_by_the_program(self) -> None:
        self.assertEqual(
            TOOLS["atualizar_apelido"].describe({"serial": " abc123 ", "apelido": "Sala 1"}),  # type: ignore[misc]
            "Alterar o apelido do serial ABC123 para 'Sala 1'.",
        )
        self.assertEqual(TOOLS["cancelar_automacao_chrome"].describe({}), "Cancelar a rotina de automação em andamento.")  # type: ignore[misc]
        unit = TOOLS["salvar_unidade"].describe  # type: ignore[misc]
        self.assertTrue(unit({"cidade": "A", "endereco": "B", "cnpj": "C"}).startswith("Criar nova unidade"))
        self.assertTrue(unit({"id": 3, "cidade": "A", "endereco": "B", "cnpj": "C"}).startswith("Editar a unidade #3"))


class ConversationTests(unittest.TestCase):
    def test_query_tool_then_answer_with_names_restored(self) -> None:
        model = FakeModel(calls(call("consultar_equipamento", serial="abc123")), text("O usuário é [PESSOA_1]."))
        conversation, simpress = make_conversation(model)
        reply = conversation.enviar_mensagem("quem usa a ABC123?")
        self.assertEqual(reply.texto, "O usuário é Maria Souza.")
        self.assertEqual(reply.ferramentas, ["consultar_equipamento"])
        self.assertIsNone(reply.pendente)
        self.assertIn(("GET", "/api/equipamento/ABC123"), [(m, p) for m, p, _, _ in simpress.calls])
        # The model never saw the real name: the tool result carried a marker.
        tool_message = model.sent[1][-1]
        self.assertEqual(tool_message["role"], "tool")
        self.assertNotIn("Maria", json.dumps(model.sent))
        self.assertIn("[PESSOA_", tool_message["content"])

    def test_change_stops_with_card_and_runs_only_after_confirmation(self) -> None:
        model = FakeModel(
            calls(call("atualizar_apelido", serial="abc123", apelido="Sala 1")),
            text("Feito: apelido alterado."),
        )
        conversation, simpress = make_conversation(model)
        reply = conversation.enviar_mensagem("troque o apelido da ABC123 para Sala 1")
        self.assertEqual(reply.pendente, {"descricao": "Alterar o apelido do serial ABC123 para 'Sala 1'."})
        self.assertEqual(reply.texto, reply.pendente["descricao"])  # type: ignore[index]
        self.assertTrue(conversation.aguardando_confirmacao)
        self.assertEqual(simpress.writes(), [])
        confirmed = conversation.resolver_confirmacao(True)
        self.assertEqual(simpress.writes(), [("POST", "/api/equipamento/atualizar-apelido")])
        self.assertEqual(simpress.calls[-1][3], {"serial": "ABC123", "apelido": "Sala 1"})
        self.assertEqual(confirmed.texto, "Feito: apelido alterado.")
        self.assertFalse(conversation.aguardando_confirmacao)

    def test_cancel_changes_nothing(self) -> None:
        model = FakeModel(calls(call("atualizar_apelido", serial="ABC123", apelido="X")), text("Ok, cancelado."))
        conversation, simpress = make_conversation(model)
        conversation.enviar_mensagem("mude")
        conversation.resolver_confirmacao(False)
        self.assertEqual(simpress.writes(), [])
        self.assertIn("cancelou", model.sent[1][-1]["content"])

    def test_pending_blocks_new_messages_and_survives_state_reads(self) -> None:
        model = FakeModel(calls(call("atualizar_apelido", serial="ABC123", apelido="X")))
        conversation, _ = make_conversation(model)
        conversation.enviar_mensagem("mude")
        again = conversation.enviar_mensagem("outra coisa")
        self.assertIn("aguardando sua confirmação", again.texto)
        self.assertEqual(len(model.sent), 1)
        self.assertEqual(conversation.descricao_pendente, "Alterar o apelido do serial ABC123 para 'X'.")

    def test_one_change_per_turn(self) -> None:
        model = FakeModel(
            calls(call("atualizar_apelido", serial="AAA", apelido="1"), call("atualizar_usuario", serial="BBB", usuario="Ana")),
        )
        conversation, simpress = make_conversation(model)
        reply = conversation.enviar_mensagem("mude os dois")
        self.assertEqual(reply.pendente, {"descricao": "Alterar o apelido do serial AAA para '1'."})
        self.assertEqual(simpress.writes(), [])
        refused = [m for m in conversation._mensagens if m["role"] == "tool"]
        self.assertIn("Uma alteração por vez", refused[0]["content"])

    def test_confirmation_without_pending(self) -> None:
        conversation, _ = make_conversation(FakeModel())
        self.assertEqual(conversation.resolver_confirmacao(True).texto, "Não há alteração pendente.")

    def test_cpf_and_known_names_never_reach_the_model(self) -> None:
        model = FakeModel(text("ok"))
        conversation, _ = make_conversation(model)
        conversation.enviar_mensagem(f"o CPF {CPF} é da Maria Souza, senha: segredo123")
        sent = json.dumps(model.sent, ensure_ascii=False)
        self.assertNotIn(CPF, sent)
        self.assertNotIn("Maria Souza", sent)
        self.assertNotIn("segredo123", sent)
        self.assertIn("***.***.***-**", sent)

    def test_tool_result_is_masked_and_cpf_in_ticket_text_hidden(self) -> None:
        simpress = FakeSimpress()
        simpress.equipamento = {"serial": "ABC123", "modelo": f"nota com cpf {CPF}", "cidade": "Curitiba"}
        model = FakeModel(calls(call("consultar_equipamento", serial="ABC123")), text("ok"))
        conversation, _ = make_conversation(model, simpress)
        conversation.enviar_mensagem("detalhes")
        self.assertNotIn(CPF, json.dumps(model.sent, ensure_ascii=False))

    def test_unknown_tool_bad_json_and_invented_marker(self) -> None:
        model = FakeModel(
            ModelReply(tool_calls=[
                ModelToolCall("a", "ferramenta_que_nao_existe", "{}"),
                ModelToolCall("b", "consultar_equipamento", "{nao e json"),
                ModelToolCall("c", "atualizar_usuario", json.dumps({"serial": "X", "usuario": "[PESSOA_99]"})),
            ]),
            text("ok"),
        )
        conversation, simpress = make_conversation(model)
        reply = conversation.enviar_mensagem("teste")
        self.assertIsNone(reply.pendente)
        results = [m["content"] for m in model.sent[1] if m["role"] == "tool"]
        self.assertIn("desconhecida", results[0])
        self.assertIn("JSON inválido", results[1])
        self.assertIn("Marcador de pessoa desconhecido", results[2])
        self.assertEqual(simpress.writes(), [])

    def test_promise_only_reply_is_nudged(self) -> None:
        model = FakeModel(text("Vou consultar agora."), calls(call("obter_totais_inventario")), text("São 10."))
        conversation, _ = make_conversation(model)
        reply = conversation.enviar_mensagem("quantos?")
        self.assertEqual(reply.texto, "São 10.")
        self.assertIn("Chame agora a ferramenta", model.sent[1][-1]["content"])

    def test_round_limit(self) -> None:
        model = FakeModel(*[calls(call("obter_totais_inventario")) for _ in range(5)])
        conversation, _ = make_conversation(model)
        self.assertIn("limite de consultas", conversation.enviar_mensagem("loop").texto)

    def test_model_failure_rolls_back_history_without_leaking_details(self) -> None:
        model = FakeModel(OpenRouterError("A conta do OpenRouter está sem créditos (402)."), RuntimeError("sk-or-v1-segredo"))
        conversation, _ = make_conversation(model)
        before = len(conversation._mensagens)
        reply = conversation.enviar_mensagem("oi")
        self.assertIn("402", reply.texto)
        self.assertEqual(len(conversation._mensagens), before)
        reply = conversation.enviar_mensagem("oi de novo")
        self.assertNotIn("segredo", reply.texto)
        self.assertEqual(len(conversation._mensagens), before)

    def test_missing_key_message(self) -> None:
        conversation, simpress = make_conversation(None)
        self.assertFalse(conversation.configurado)
        self.assertEqual(conversation.enviar_mensagem("oi").texto, MSG_SEM_CHAVE)
        self.assertEqual(simpress.calls, [])

    def test_clear_resets_history_and_pending(self) -> None:
        model = FakeModel(calls(call("atualizar_apelido", serial="ABC123", apelido="X")))
        conversation, _ = make_conversation(model)
        conversation.enviar_mensagem("mude")
        conversation.limpar_historico()
        self.assertFalse(conversation.aguardando_confirmacao)
        self.assertEqual(len(conversation._mensagens), 1)

    def test_history_is_capped_by_whole_turns(self) -> None:
        model = FakeModel(*[text(f"r{i}") for i in range(40)])
        conversation, _ = make_conversation(model)
        for i in range(40):
            conversation.enviar_mensagem(f"pergunta {i}")
        # Trimming runs before the new turn is added: system + 60 kept + this turn's user and reply.
        self.assertLessEqual(len(conversation._mensagens), 63)
        self.assertLess(len(conversation._mensagens), 80)
        self.assertEqual(conversation._mensagens[1]["role"], "user")

    def test_second_request_while_busy_is_refused(self) -> None:
        release = threading.Event()

        class SlowModel:
            def complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> ModelReply:
                release.wait(5)
                return text("pronto")

        conversation = AssistantConversation(SlowModel(), SimpressApi(FakeSimpress()), "m")
        worker = threading.Thread(target=conversation.enviar_mensagem, args=("oi",))
        worker.start()
        try:
            deadline = time.monotonic() + 5
            while not conversation._lock.locked() and time.monotonic() < deadline:
                time.sleep(0.01)
            with self.assertRaises(AssistantBusy):
                conversation.enviar_mensagem("outra")
        finally:
            release.set()
            worker.join(5)


def make_client(model: Optional[FakeModel], simpress: Optional[FakeSimpress] = None) -> Tuple[TestClient, FakeSimpress, List[int]]:
    simpress = simpress or FakeSimpress()
    loads: List[int] = []

    def load_settings() -> OpenRouterSettings:
        loads.append(1)
        return OpenRouterSettings(api_key="chave-de-teste" if model else "")

    app = FastAPI()
    app.include_router(create_assistant_router(AssistantRouteServices(
        load_settings=load_settings, transport=simpress, client_factory=lambda settings: model,  # type: ignore[arg-type,return-value]
    )))
    return TestClient(app), simpress, loads


class AssistantRouteTests(unittest.TestCase):
    def test_mensagem_returns_contract(self) -> None:
        client, _, _ = make_client(FakeModel(calls(call("obter_totais_inventario")), text("oi")))
        response = client.post("/api/assistente/mensagem", json={"texto": "olá"})
        self.assertEqual(response.json(), {"texto": "oi", "ferramentas": ["obter_totais_inventario"], "pendente": None})

    def test_confirm_flow_and_state_survive_reload(self) -> None:
        client, simpress, _ = make_client(FakeModel(calls(call("atualizar_apelido", serial="ABC123", apelido="X")), text("feito")))
        body = client.post("/api/assistente/mensagem", json={"texto": "mude"}).json()
        card = {"descricao": "Alterar o apelido do serial ABC123 para 'X'."}
        self.assertEqual(body["pendente"], card)
        state = client.get("/api/assistente/estado").json()
        self.assertEqual(state, {"online": True, "modelo": "openai/gpt-4o-mini", "aguardando_confirmacao": True, "pendente": card})
        self.assertEqual(simpress.writes(), [])
        done = client.post("/api/assistente/confirmar", json={"confirmado": True}).json()
        self.assertEqual(done, {"texto": "feito", "ferramentas": ["atualizar_apelido"], "pendente": None})
        self.assertEqual(len(simpress.writes()), 1)
        self.assertEqual(client.post("/api/assistente/limpar").json(), {"ok": True})

    def test_missing_key_is_503_and_state_offline(self) -> None:
        client, _, _ = make_client(None)
        for path, body in (("mensagem", {"texto": "a"}), ("confirmar", {"confirmado": False})):
            response = client.post(f"/api/assistente/{path}", json=body)
            self.assertEqual((response.status_code, response.json()), (503, {"detail": MSG_SEM_CHAVE}))
        self.assertEqual(
            client.get("/api/assistente/estado").json(),
            {"online": False, "modelo": "", "aguardando_confirmacao": False, "pendente": None},
        )

    def test_key_added_later_is_picked_up_without_restart(self) -> None:
        simpress = FakeSimpress()
        state = {"key": ""}
        app = FastAPI()
        app.include_router(create_assistant_router(AssistantRouteServices(
            load_settings=lambda: OpenRouterSettings(api_key=state["key"]),
            transport=simpress,
            client_factory=lambda settings: FakeModel(text("oi")),  # type: ignore[arg-type,return-value]
        )))
        client = TestClient(app)
        self.assertEqual(client.post("/api/assistente/mensagem", json={"texto": "a"}).status_code, 503)
        state["key"] = "chave-de-teste"
        self.assertEqual(client.post("/api/assistente/mensagem", json={"texto": "a"}).json()["texto"], "oi")

    def test_validation_422(self) -> None:
        client, _, _ = make_client(FakeModel())
        for texto in ("", "x" * 4001):
            self.assertEqual(client.post("/api/assistente/mensagem", json={"texto": texto}).status_code, 422)
        self.assertEqual(client.post("/api/assistente/mensagem", json={"texto": "a", "extra": 1}).status_code, 422)
        self.assertEqual(client.post("/api/assistente/confirmar", json={}).status_code, 422)

    def test_model_error_is_a_message_not_an_exception(self) -> None:
        client, _, _ = make_client(FakeModel(OpenRouterError("O OpenRouter não respondeu a tempo.")))
        response = client.post("/api/assistente/mensagem", json={"texto": "oi"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("não respondeu a tempo", response.json()["texto"])

    def test_response_never_contains_the_key(self) -> None:
        client, _, _ = make_client(FakeModel(text("oi")))
        for response in (
            client.post("/api/assistente/mensagem", json={"texto": "a"}),
            client.get("/api/assistente/estado"),
        ):
            self.assertNotIn("chave-de-teste", response.text)

    def test_busy_is_409(self) -> None:
        release = threading.Event()

        class SlowModel:
            def complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> ModelReply:
                release.wait(5)
                return text("pronto")

        simpress = FakeSimpress()
        app = FastAPI()
        app.include_router(create_assistant_router(AssistantRouteServices(
            load_settings=lambda: OpenRouterSettings(api_key="chave-de-teste"),
            transport=simpress,
            client_factory=lambda settings: SlowModel(),  # type: ignore[return-value]
        )))
        client = TestClient(app)
        first = threading.Thread(target=lambda: client.post("/api/assistente/mensagem", json={"texto": "a"}))
        first.start()
        try:
            for _ in range(200):
                response = client.post("/api/assistente/mensagem", json={"texto": "b"})
                if response.status_code == 409:
                    self.assertEqual(response.json(), {"detail": MSG_OCUPADO})
                    break
            else:
                self.fail("never got 409")
        finally:
            release.set()
            first.join(5)


if __name__ == "__main__":
    unittest.main()
