import json
import unittest
from typing import Optional

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.assistant_api import SimpressApi
from domains.assistant_chat import AssistantConversation
from domains.assistant_conversas import LIMITE_CONVERSAS, LIMITE_MENSAGENS, LIMITE_TEXTO, LIMITE_TITULO, ConversasStore
from domains.assistant_notas import NotasStore
from domains.assistant_openrouter import OpenRouterSettings
from routers.assistant import AssistantRouteServices, create_assistant_router
from tests.test_assistant import CPF, FakeModel, FakeSimpress, call, calls, temp_json, text


def make_chat(model: FakeModel, store: ConversasStore) -> AssistantConversation:
    return AssistantConversation(model, SimpressApi(FakeSimpress()), "modelo-teste", lambda: "", conversas=store)  # type: ignore[arg-type]


class ConversasStoreTests(unittest.TestCase):
    def test_register_list_get_delete(self) -> None:
        store = ConversasStore(temp_json())
        store.registrar("a", "usuario", "  Primeira pergunta  ")
        store.registrar("a", "assistente", "Primeira resposta")
        store.registrar("b", "usuario", "Outra conversa")
        resumo = store.listar()
        self.assertEqual([c["id"] for c in resumo], ["b", "a"])  # newest first
        self.assertEqual((resumo[1]["titulo"], resumo[1]["mensagens"]), ("Primeira pergunta", 2))
        self.assertNotIn("texto", json.dumps(resumo))
        conversa = store.obter("a")
        self.assertEqual([m["papel"] for m in conversa["mensagens"]], ["usuario", "assistente"])  # type: ignore[index]
        self.assertTrue(store.apagar("a"))
        self.assertFalse(store.apagar("a"))
        self.assertIsNone(store.obter("a"))

    def test_ignores_invalid_input_and_applies_limits(self) -> None:
        store = ConversasStore(temp_json())
        store.registrar("a", "sistema", "x")
        store.registrar("a", "usuario", "   ")
        self.assertEqual(store.listar(), [])
        store.registrar("a", "usuario", "y" * (LIMITE_TITULO + 30))
        self.assertEqual(len(store.listar()[0]["titulo"]), LIMITE_TITULO)
        store.registrar("a", "assistente", "z" * (LIMITE_TEXTO + 10))
        self.assertEqual(len(store.obter("a")["mensagens"][1]["texto"]), LIMITE_TEXTO)  # type: ignore[index]
        for i in range(LIMITE_MENSAGENS + 5):
            store.registrar("a", "usuario", f"m{i}")
        self.assertEqual(len(store.obter("a")["mensagens"]), LIMITE_MENSAGENS)  # type: ignore[index]
        for i in range(LIMITE_CONVERSAS + 3):
            store.registrar(f"c{i}", "usuario", "oi")
        ids = {c["id"] for c in store.listar()}
        self.assertEqual(len(ids), LIMITE_CONVERSAS)
        self.assertNotIn("a", ids)  # the oldest went first

    def test_unreadable_file_is_empty_and_recovers(self) -> None:
        caminho = temp_json()
        caminho.write_text("{ não é json", encoding="utf-8")
        store = ConversasStore(caminho)
        self.assertEqual(store.listar(), [])
        store.registrar("a", "usuario", "oi")
        self.assertEqual(len(store.listar()), 1)


class ConversaGravaHistoricoTests(unittest.TestCase):
    def test_turn_is_saved_masked(self) -> None:
        store = ConversasStore(temp_json())
        chat = make_chat(FakeModel(text("Ok, anotado.")), store)
        chat.enviar_mensagem(f"O CPF é {CPF}, meu e-mail é fulano@exemplo.com")
        gravado = store.obter(store.listar()[0]["id"])["mensagens"]  # type: ignore[index]
        self.assertEqual([m["papel"] for m in gravado], ["usuario", "assistente"])
        tudo = json.dumps(gravado, ensure_ascii=False)
        self.assertNotIn(CPF, tudo)
        self.assertNotIn("fulano@exemplo.com", tudo)
        self.assertEqual(gravado[1]["texto"], "Ok, anotado.")

    def test_failed_call_saves_nothing(self) -> None:
        store = ConversasStore(temp_json())
        chat = make_chat(FakeModel(), store)  # no reply left: the call fails
        chat.enviar_mensagem("pergunta")
        self.assertEqual(store.listar(), [])

    def test_pending_change_is_saved_with_the_confirmation(self) -> None:
        store = ConversasStore(temp_json())
        chat = AssistantConversation(
            FakeModel(calls(call("criar_lembrete", texto="Conferir lote")), text("Guardei.")),  # type: ignore[arg-type]
            SimpressApi(FakeSimpress()), "modelo-teste", lambda: "", NotasStore(temp_json()), conversas=store,
        )
        chat.enviar_mensagem("me lembre")
        self.assertEqual(store.listar(), [])  # waiting for the card: no answer yet
        chat.resolver_confirmacao(False)
        mensagens = store.obter(store.listar()[0]["id"])["mensagens"]  # type: ignore[index]
        self.assertEqual([m["papel"] for m in mensagens], ["usuario", "assistente"])

    def test_new_conversation_starts_a_new_history_entry(self) -> None:
        store = ConversasStore(temp_json())
        chat = make_chat(FakeModel(text("um"), text("dois")), store)
        chat.enviar_mensagem("primeira")
        chat.limpar_historico()
        chat.enviar_mensagem("segunda")
        self.assertEqual(sorted(c["titulo"] for c in store.listar()), ["primeira", "segunda"])

    def test_write_failure_does_not_break_the_chat(self) -> None:
        store = ConversasStore(temp_json())
        store.registrar = lambda *a, **k: (_ for _ in ()).throw(OSError("disco cheio"))  # type: ignore[method-assign]
        chat = make_chat(FakeModel(text("resposta")), store)
        with self.assertLogs("domains.assistant_chat", level="ERROR"):
            self.assertEqual(chat.enviar_mensagem("oi").texto, "resposta")


class ConversasRouteTests(unittest.TestCase):
    def make_client(self, model: Optional[FakeModel] = None) -> "tuple[TestClient, ConversasStore]":
        arquivo = temp_json()
        app = FastAPI()
        app.include_router(create_assistant_router(AssistantRouteServices(
            load_settings=lambda: OpenRouterSettings(api_key="chave" if model else ""), transport=FakeSimpress(),
            client_factory=lambda settings: model, instructions_file=temp_json(), conversations_file=arquivo,  # type: ignore[arg-type,return-value]
        )))
        return TestClient(app), ConversasStore(arquivo)

    def test_list_get_delete_work_without_key(self) -> None:
        client, store = self.make_client()
        store.registrar("abc", "usuario", "Pergunta")
        store.registrar("abc", "assistente", "Resposta")
        lista = client.get("/api/assistente/conversas").json()["conversas"]
        self.assertEqual([(c["id"], c["titulo"], c["mensagens"]) for c in lista], [("abc", "Pergunta", 2)])
        conversa = client.get("/api/assistente/conversas/abc").json()
        self.assertEqual([m["texto"] for m in conversa["mensagens"]], ["Pergunta", "Resposta"])
        self.assertEqual(client.delete("/api/assistente/conversas/abc").json(), {"ok": True})
        self.assertEqual(client.get("/api/assistente/conversas").json()["conversas"], [])

    def test_unknown_id_is_404(self) -> None:
        client, _ = self.make_client()
        self.assertEqual(client.get("/api/assistente/conversas/naoexiste").status_code, 404)
        self.assertEqual(client.delete("/api/assistente/conversas/naoexiste").status_code, 404)

    def test_message_through_the_route_lands_in_the_history(self) -> None:
        client, store = self.make_client(FakeModel(text("Olá!")))
        client.post("/api/assistente/mensagem", json={"texto": "Oi"})
        self.assertEqual([c["titulo"] for c in store.listar()], ["Oi"])


if __name__ == "__main__":
    unittest.main()
