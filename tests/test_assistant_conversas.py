import json
import unittest
from typing import Optional

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.assistant_anexos import analisar
from domains.assistant_api import SimpressApi
from domains.assistant_chat import AssistantConversation
from domains.assistant_conversas import LIMITE_CONVERSAS, LIMITE_MENSAGENS, LIMITE_TEXTO, LIMITE_TITULO, ConversasStore
from domains.assistant_notas import NotasStore
from domains.assistant_openrouter import OpenRouterSettings
from routers.assistant import AssistantRouteServices, create_assistant_router
from tests.test_assistant import (
    CPF, PDF_LAUDO, FakeModel, FakeSimpress, MarkerModel, PdfSimpress, SebraeSolicitantesSimpress, call, calls, temp_json, text,
)


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

    def test_history_file_keeps_the_whole_name_masked_even_though_the_model_saw_the_first_name(self) -> None:
        # 08/11/2026 (pedido do usuário): the first name is visible to the model and the screen, never on disk.
        arquivo = temp_json()
        store = ConversasStore(arquivo)
        model = MarkerModel(calls(call("consultar_equipamento", serial="ABC123")), text("placeholder"))
        chat = AssistantConversation(model, SimpressApi(PdfSimpress()), "modelo-teste", lambda: "", conversas=store)  # type: ignore[arg-type]
        resposta = chat.enviar_mensagem("quem usa a ABC123? a Marina Beatriz Teixeira da Costa ligou")
        self.assertEqual(resposta.texto, "O usuário é Marina Beatriz Teixeira da Costa.")  # the screen shows the real name
        gravado = store.obter(store.listar()[0]["id"])["mensagens"]  # type: ignore[index]
        tudo = json.dumps(gravado, ensure_ascii=False)
        bruto = arquivo.read_text(encoding="utf-8")  # the whole file: title, preview and cards too
        for escondido in ("Marina", "Beatriz", "Teixeira", "Costa"):
            self.assertNotIn(escondido, tudo)
            self.assertNotIn(escondido, bruto)
        self.assertEqual([m["papel"] for m in gravado], ["usuario", "assistente"])

    def test_history_file_keeps_neither_first_name_nor_surname_of_a_sebrae_requester(self) -> None:
        # 08/11/2026: the requester comes from the Sebrae route (never from the inventory), in the user text and in the ticket description.
        arquivo = temp_json()
        store = ConversasStore(arquivo)
        nome = SebraeSolicitantesSimpress.NOME
        simpress = SebraeSolicitantesSimpress(
            abertos=[{"numero": "UTIC-2026-0001", "titulo": "Remoção de usuário", "descricao": f"Remover {nome} da UGP", "valores": {}}],
            novos=[{"numero": "UTIC-2026-0200", "linha": {"I": nome}}],  # only the base knows this name before the tool answers
        )
        model = FakeModel(calls(call("chamados_antigos_abertos_sebrae", busca="Helga")), text("Achei o chamado UTIC-2026-0001 da Helga."))
        chat = AssistantConversation(model, SimpressApi(simpress), "modelo-teste", lambda: "", conversas=store)  # type: ignore[arg-type]
        resposta = chat.enviar_mensagem(f"anexa esse PDF no chamado da {nome}")
        self.assertIn("UTIC-2026-0001", resposta.texto)
        bruto = arquivo.read_text(encoding="utf-8")  # the whole file: title, preview and cards too
        for escondido in ("Helga", *SebraeSolicitantesSimpress.SOBRENOMES):
            self.assertNotIn(escondido, bruto)
        gravado = store.obter(store.listar()[0]["id"])["mensagens"]  # type: ignore[index]
        self.assertEqual([m["papel"] for m in gravado], ["usuario", "assistente"])

    def test_historico_nao_guarda_nome_do_pdf_nem_pdf_atual_do_chamado_em_nenhum_desfecho(self) -> None:
        # 08/11/2026: o cartão na tela mostra os nomes; o histórico e o disco ficam sem eles, seja qual for o desfecho.
        for desfecho in ("confirmado", "cancelado", "envio recusado", "anexo removido"):
            with self.subTest(desfecho):
                arquivo = temp_json()
                store = ConversasStore(arquivo)
                anexo = analisar(PDF_LAUDO, "Marina_Costa_laudo.pdf")
                args = {"numero": "UTIC-2026-1254", "anexo_id": anexo.id}  # esse chamado já tem o PDF "antigo.pdf"
                model = FakeModel(calls(call("anexar_pdf_chamado_sebrae", **args)), text("ok"))
                simpress = PdfSimpress(status_envio=422 if desfecho == "envio recusado" else 200)
                chat = AssistantConversation(model, SimpressApi(simpress), "modelo-teste", lambda: "", conversas=store)  # type: ignore[arg-type]
                chat.anexos.adicionar(anexo)
                cartao = chat.enviar_mensagem("anexa esse PDF no chamado").pendente["descricao"]  # type: ignore[index]
                self.assertIn("Marina_Costa_laudo.pdf", cartao)
                self.assertIn("antigo.pdf", cartao)
                if desfecho == "anexo removido":
                    chat.anexos.remover(anexo.id)
                resposta = chat.resolver_confirmacao(desfecho != "cancelado")
                if desfecho == "confirmado":
                    self.assertIn("UTIC-2026-1254", resposta.texto)
                historico = json.dumps(chat._mensagens[1:], ensure_ascii=False)  # [0] é o prompt do sistema, que lista os anexos mascarados
                bruto = arquivo.read_text(encoding="utf-8")
                for escondido in ("Marina_Costa_laudo.pdf", "antigo.pdf"):
                    self.assertNotIn(escondido, resposta.texto)
                    self.assertNotIn(escondido, historico)
                    self.assertNotIn(escondido, bruto)

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
