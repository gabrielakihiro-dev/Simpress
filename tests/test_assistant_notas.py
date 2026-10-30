import json
import unittest
from typing import Any, List, Optional

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.assistant_api import SimpressApi
from domains.assistant_chat import SYSTEM_PROMPT, AssistantConversation
from domains.assistant_notas import LIMITE_NOTAS, LIMITE_TEXTO, NotasStore
from domains.assistant_openrouter import OpenRouterSettings
from domains.assistant_tools import CHANGE_TOOLS, QUERY_TOOLS, TOOLS
from routers.assistant import AssistantRouteServices, create_assistant_router
from tests.test_assistant import CPF, FakeModel, FakeSimpress, abrir, call, calls, temp_json, text


def make_store() -> NotasStore:
    return NotasStore(temp_json())


def make_chat(model: FakeModel, store: NotasStore, simpress: Optional[FakeSimpress] = None) -> AssistantConversation:
    return AssistantConversation(model, SimpressApi(simpress or FakeSimpress()), "modelo-teste", lambda: "", store)  # type: ignore[arg-type]


def tool_messages(conversation: AssistantConversation) -> List[Any]:
    return [json.loads(abrir(m["content"])) for m in conversation._mensagens if m["role"] == "tool"]


class NotasStoreTests(unittest.TestCase):
    def test_create_list_conclude_reopen_delete(self) -> None:
        store = make_store()
        nota = store.criar("  Conferir o lote X  ", "2026-11-05")
        self.assertEqual((nota["texto"], nota["prazo"], nota["concluida"]), ("Conferir o lote X", "2026-11-05", False))
        self.assertRegex(nota["id"], r"^[0-9a-f]{12}$")
        self.assertRegex(nota["criada_em"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$")
        outra = store.criar("Série Y foi para manutenção")
        self.assertIsNone(outra["prazo"])
        self.assertEqual([n["id"] for n in store.listar()], [nota["id"], outra["id"]])
        self.assertTrue(store.marcar(nota["id"])["concluida"])  # type: ignore[index]
        self.assertEqual([n["id"] for n in store.listar()], [outra["id"], nota["id"]])  # concluded go last
        self.assertEqual([n["id"] for n in store.listar(incluir_concluidas=False)], [outra["id"]])
        self.assertFalse(store.marcar(nota["id"], False)["concluida"])  # type: ignore[index]
        self.assertTrue(store.apagar(nota["id"]))
        self.assertFalse(store.apagar(nota["id"]))
        self.assertEqual([n["id"] for n in store.listar()], [outra["id"]])

    def test_limits_and_invalid_input(self) -> None:
        store = make_store()
        for texto, prazo, trecho in (
            ("", None, "vazio"), ("   ", None, "vazio"), ("x" * (LIMITE_TEXTO + 1), None, "500"),
            ("ok", "05/11/2026", "AAAA-MM-DD"), ("ok", "2026-02-30", "AAAA-MM-DD"),
        ):
            with self.assertRaises(ValueError) as erro:
                store.criar(texto, prazo)
            self.assertIn(trecho, str(erro.exception))
        store.criar("x" * LIMITE_TEXTO)
        self.assertEqual(len(store.listar()), 1)

    def test_note_limit(self) -> None:
        store = make_store()
        for i in range(LIMITE_NOTAS):
            store.criar(f"nota {i}")
        with self.assertRaises(ValueError) as erro:
            store.criar("a mais")
        self.assertIn("200", str(erro.exception))
        with self.assertRaises(ValueError):
            store.verificar("a mais")
        self.assertEqual(len(store.listar()), LIMITE_NOTAS)

    def test_unknown_id(self) -> None:
        store = make_store()
        store.criar("a")
        self.assertIsNone(store.marcar("naoexiste"))
        self.assertFalse(store.apagar("naoexiste"))
        self.assertIsNone(store.obter("naoexiste"))

    def test_corrupted_or_missing_file_reads_as_empty_and_is_replaced_on_write(self) -> None:
        store = make_store()
        self.assertEqual(store.listar(), [])
        for conteudo in ("{não é json", '{"notas": 3}', "[]", '{"notas": [1, {"id": 2}, {"id": "a", "texto": "ok", "concluida": 1}]}'):
            store._caminho.write_text(conteudo, encoding="utf-8")
            esperado = [("a", True)] if "texto" in conteudo else []
            self.assertEqual([(n["id"], n["concluida"]) for n in store.listar()], esperado, conteudo)
        store._caminho.write_text("{não é json", encoding="utf-8")
        store.criar("de novo")
        self.assertEqual([n["texto"] for n in store.listar()], ["de novo"])
        self.assertEqual(list(json.loads(store._caminho.read_text(encoding="utf-8"))), ["notas"])


class NotasToolTests(unittest.TestCase):
    def test_catalog(self) -> None:
        self.assertIn(TOOLS["listar_lembretes"], QUERY_TOOLS)
        for nome in ("criar_lembrete", "concluir_lembrete", "apagar_lembrete"):
            self.assertIn(TOOLS[nome], CHANGE_TOOLS)
            self.assertTrue(TOOLS[nome].changes_data)
        self.assertIn("alarme", TOOLS["criar_lembrete"].description + TOOLS["listar_lembretes"].description)

    def test_create_card_is_built_by_program_and_runs_only_after_confirmation(self) -> None:
        store = make_store()
        model = FakeModel(calls(call("criar_lembrete", texto="Conferir o lote X", prazo="2026-11-05")))
        conversation = make_chat(model, store)
        reply = conversation.enviar_mensagem("me lembre de conferir o lote X até 05/11")
        self.assertEqual(reply.pendente, {"descricao": 'Criar o lembrete "Conferir o lote X", com prazo em 05/11/2026.'})
        self.assertEqual(store.listar(), [])
        confirmado = conversation.resolver_confirmacao(True).texto
        self.assertTrue(confirmado.startswith("Lembrete criado."))
        self.assertIn("Conferir o lote X", confirmado)
        self.assertEqual([(n["texto"], n["prazo"]) for n in store.listar()], [("Conferir o lote X", "2026-11-05")])

    def test_cancel_creates_nothing(self) -> None:
        store = make_store()
        conversation = make_chat(FakeModel(calls(call("criar_lembrete", texto="a")), text("Ok.")), store)
        conversation.enviar_mensagem("anote a")
        conversation.resolver_confirmacao(False)
        self.assertEqual(store.listar(), [])

    def test_invalid_create_gives_error_without_card(self) -> None:
        store = make_store()
        model = FakeModel(calls(call("criar_lembrete", texto="a", prazo="amanhã")), text("Preciso da data completa."))
        conversation = make_chat(model, store)
        reply = conversation.enviar_mensagem("anote a para amanhã")
        self.assertIsNone(reply.pendente)
        self.assertFalse(conversation.aguardando_confirmacao)
        self.assertIn("AAAA-MM-DD", tool_messages(conversation)[0]["erro"])

    def test_conclude_and_delete_cards_quote_the_saved_text(self) -> None:
        store = make_store()
        nota = store.criar("Conferir o lote X")
        conversation = make_chat(FakeModel(calls(call("concluir_lembrete", id=nota["id"])), text("Feito.")), store)
        reply = conversation.enviar_mensagem("concluí o lote X")
        self.assertEqual(reply.pendente, {"descricao": 'Marcar como concluído o lembrete "Conferir o lote X".'})
        self.assertFalse(store.obter(nota["id"])["concluida"])  # type: ignore[index]
        conversation.resolver_confirmacao(True)
        self.assertTrue(store.obter(nota["id"])["concluida"])  # type: ignore[index]

        apagar = make_chat(FakeModel(calls(call("apagar_lembrete", id=nota["id"])), text("Apagado.")), store)
        reply = apagar.enviar_mensagem("apague o lote X")
        self.assertEqual(reply.pendente, {"descricao": 'Apagar o lembrete "Conferir o lote X".'})
        self.assertIsNotNone(store.obter(nota["id"]))
        apagar.resolver_confirmacao(True)
        self.assertIsNone(store.obter(nota["id"]))

    def test_unknown_or_already_concluded_id_gives_error_without_card(self) -> None:
        store = make_store()
        nota = store.criar("a")
        store.marcar(nota["id"])
        for nome, nota_id in (("concluir_lembrete", "naoexiste"), ("apagar_lembrete", "naoexiste"), ("concluir_lembrete", nota["id"])):
            conversation = make_chat(FakeModel(calls(call(nome, id=nota_id)), text("Não achei.")), store)
            reply = conversation.enviar_mensagem("faça")
            self.assertIsNone(reply.pendente, nome)
            self.assertIn("erro", tool_messages(conversation)[0], nome)
        self.assertEqual(len(store.listar()), 1)

    def test_one_change_per_turn(self) -> None:
        store = make_store()
        model = FakeModel(calls(call("criar_lembrete", texto="um"), call("criar_lembrete", texto="dois")), text("ok"))
        conversation = make_chat(model, store)
        reply = conversation.enviar_mensagem("anote dois")
        self.assertEqual(reply.pendente, {"descricao": 'Criar o lembrete "um".'})
        conversation.resolver_confirmacao(False)
        self.assertEqual(store.listar(), [])

    def test_list_returns_open_notes_by_default_and_masks_personal_data(self) -> None:
        store = make_store()
        aberta = store.criar(f"Ligar para Maria Souza, CPF {CPF}", "2026-11-05")
        feita = store.criar("Já resolvido")
        store.marcar(feita["id"])
        model = FakeModel(
            calls(call("consultar_equipamento", serial="abc123")),  # teaches the mask the name "Maria Souza"
            calls(call("listar_lembretes")),
            calls(call("listar_lembretes", incluir_concluidos=True)),
            text("Você tem lembretes."),
        )
        conversation = make_chat(model, store)
        conversation.enviar_mensagem("quais lembretes eu tenho?")
        abertos, todos = tool_messages(conversation)[1:]
        self.assertEqual([n["id"] for n in abertos["lembretes"]], [aberta["id"]])
        self.assertEqual(len(todos["lembretes"]), 2)
        enviado = json.dumps(model.sent)
        self.assertNotIn("Maria", enviado)
        self.assertNotIn(CPF, enviado)
        self.assertIn("***.***.***-**", enviado)

    def test_list_is_capped(self) -> None:
        store = make_store()
        for i in range(25):
            store.criar(f"nota {i} " + "ã" * 400)
        conversation = make_chat(FakeModel(calls(call("listar_lembretes")), text("ok")), store)
        conversation.enviar_mensagem("liste")
        resultado = tool_messages(conversation)[0]
        self.assertEqual(resultado["total"], 25)
        self.assertEqual(len(resultado["lembretes"]), 15)
        self.assertTrue(resultado["aviso"])

    def test_without_store_tools_fail_cleanly(self) -> None:
        conversation = AssistantConversation(FakeModel(calls(call("listar_lembretes")), text("ok")), SimpressApi(FakeSimpress()), "m")
        conversation.enviar_mensagem("liste")
        self.assertIn("não estão disponíveis", tool_messages(conversation)[0]["erro"])

    def test_prompt_treats_note_text_as_data(self) -> None:
        self.assertIn("Lembretes e notas", SYSTEM_PROMPT)
        self.assertIn("texto dos lembretes", SYSTEM_PROMPT)
        self.assertIn("alarme", SYSTEM_PROMPT)


class NotasRouteTests(unittest.TestCase):
    def make_client(self, model: Optional[FakeModel] = None) -> "tuple[TestClient, NotasStore]":
        arquivo = temp_json()
        app = FastAPI()
        app.include_router(create_assistant_router(AssistantRouteServices(
            load_settings=lambda: OpenRouterSettings(api_key="chave" if model else ""), transport=FakeSimpress(),
            client_factory=lambda settings: model, instructions_file=temp_json(), notes_file=arquivo,  # type: ignore[arg-type,return-value]
        )))
        return TestClient(app), NotasStore(arquivo)

    def test_list_patch_delete_work_without_key(self) -> None:
        client, store = self.make_client()
        nota = store.criar("Conferir o lote X", "2026-11-05")
        corpo = client.get("/api/assistente/notas").json()
        self.assertEqual((corpo["limite_texto"], corpo["limite_quantidade"]), (LIMITE_TEXTO, LIMITE_NOTAS))
        self.assertEqual([n["id"] for n in corpo["notas"]], [nota["id"]])
        feita = client.patch(f"/api/assistente/notas/{nota['id']}", json={"concluida": True})
        self.assertEqual((feita.status_code, feita.json()["concluida"]), (200, True))
        self.assertTrue(store.obter(nota["id"])["concluida"])  # type: ignore[index]
        self.assertEqual(client.delete(f"/api/assistente/notas/{nota['id']}").json(), {"ok": True})
        self.assertEqual(client.get("/api/assistente/notas").json()["notas"], [])

    def test_unknown_id_is_404_and_bad_body_is_422(self) -> None:
        client, store = self.make_client()
        nota = store.criar("a")
        self.assertEqual(client.patch("/api/assistente/notas/naoexiste", json={"concluida": True}).status_code, 404)
        self.assertEqual(client.delete("/api/assistente/notas/naoexiste").status_code, 404)
        for corpo in ({}, {"concluida": True, "texto": "outro"}, {"concluida": "talvez"}):
            self.assertEqual(client.patch(f"/api/assistente/notas/{nota['id']}", json=corpo).status_code, 422, corpo)
        self.assertEqual(store.obter(nota["id"])["texto"], "a")  # type: ignore[index]

    def test_pending_card_survives_reload_and_confirm_creates_note(self) -> None:
        model = FakeModel(calls(call("criar_lembrete", texto="Conferir o lote X")), text("Guardei."))
        client, store = self.make_client(model)
        cartao = {"descricao": 'Criar o lembrete "Conferir o lote X".'}
        self.assertEqual(client.post("/api/assistente/mensagem", json={"texto": "me lembre"}).json()["pendente"], cartao)
        self.assertEqual(client.get("/api/assistente/estado").json()["pendente"], cartao)
        self.assertEqual(store.listar(), [])
        client.post("/api/assistente/confirmar", json={"confirmado": True})
        self.assertEqual([n["texto"] for n in client.get("/api/assistente/notas").json()["notas"]], ["Conferir o lote X"])


if __name__ == "__main__":
    unittest.main()
