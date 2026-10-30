import json
import unittest
from typing import Any, Dict, List, Optional, Tuple

from domains.assistant_api import SimpressApi
from domains.assistant_chat import MAX_CARACTERES_RESPOSTA, SYSTEM_PROMPT, AssistantConversation
from domains.assistant_notas import NotasStore
from domains.assistant_rascunhos import LIMITE_ITENS, TIPOS, montar_rascunho
from domains.assistant_tools import QUERY_TOOLS, TOOLS
from tests.test_assistant import CPF, FakeModel, abrir, call, calls, temp_json, text

SEBRAE_SERIES = ("BRJ135P5XS", "BRJ142QKBQ", "BRJ9435VMR", "BRJ9435VMF", "BRJ149SCJG")
EMAIL = "maria.souza@exemplo.com"


def comparacao_padrao() -> Dict[str, Any]:
    return {
        "sem_acesso_7_dias": [
            {"serie": "AAA111", "computador": "PRNOTE01", "dias_sem_verificacao": 9, "usuarios": "Maria Souza"},
            {"serie": "BBB222", "computador": "PRNOTE02", "dias_sem_verificacao": 12},
        ],
        "ausentes_no_endpoint": [{"serie": s, "computador": f"SEB{i}"} for i, s in enumerate(SEBRAE_SERIES)] + [{"serie": "CCC333", "computador": "PRNOTE03"}],
        "ausentes_em_detalhes": [{"serie": "DDD444", "computador": "PRNOTE04"}],
        "divergencias_local": [
            {"serie": "EEE555", "computador": "PRNOTE05", "local_previsto": "Curitiba", "local_detalhes": f"Sala 2, {EMAIL}, CPF {CPF}"},
        ],
    }


class FakeTransport:
    def __init__(self, comparacao: Optional[Dict[str, Any]] = None, eventos: bool = True) -> None:
        self.comparacao = comparacao if comparacao is not None else comparacao_padrao()
        self.eventos = eventos
        self.calls: List[Tuple[str, str]] = []

    def __call__(self, method: str, path: str, params: Optional[Dict[str, Any]], body: Optional[Dict[str, Any]]) -> Tuple[int, Any]:
        self.calls.append((method, path))
        if path == "/api/historico-comparacoes":
            return 200, {"eventos": [{"id": "e1", "horario": "2026-10-20T10:00:00"}] if self.eventos else []}
        if path == "/api/historico-comparacoes/e1":
            return 200, {"evento": {"id": "e1", "comparacao": self.comparacao}}
        return 404, {"detail": "não existe"}


def rascunho(tipo: Any, comparacao: Optional[Dict[str, Any]] = None, extra: Any = "") -> Dict[str, Any]:
    return montar_rascunho(SimpressApi(FakeTransport(comparacao)), tipo, extra)


class MontarRascunhoTests(unittest.TestCase):
    def test_sem_acesso_skeleton_has_exact_facts(self) -> None:
        r = rascunho("sem_acesso_7_dias")
        self.assertEqual((r["tipo"], r["total"], r["horario_comparacao"]), ("sem_acesso_7_dias", 2, "20/10/2026"))
        esqueleto = r["esqueleto"]
        self.assertTrue(esqueleto.startswith("Assunto: Equipamentos sem acesso há 7 dias ou mais (2)"))
        self.assertIn("(20/10/2026), encontramos 2 item(ns)", esqueleto)
        self.assertIn("- AAA111 (PRNOTE01) — 9 dias sem verificação", esqueleto)
        self.assertIn("- BBB222 (PRNOTE02) — 12 dias sem verificação", esqueleto)
        self.assertNotIn("Maria", esqueleto)  # users never enter the facts

    def test_sem_correspondencia_has_both_sections_and_skips_sebrae(self) -> None:
        r = rascunho("sem_correspondencia")
        self.assertEqual(r["total"], 2)  # CCC333 + DDD444; the 5 Sebrae series do not count
        esqueleto = r["esqueleto"]
        self.assertIn("Séries na Simpress sem correspondência no Endpoint (1):", esqueleto)
        self.assertIn("Séries no Endpoint sem correspondência na Simpress (1):", esqueleto)
        self.assertIn("- CCC333 (PRNOTE03)", esqueleto)
        self.assertIn("- DDD444 (PRNOTE04)", esqueleto)
        for serie in SEBRAE_SERIES:
            self.assertNotIn(serie, json.dumps(r))

    def test_localidade_divergente_has_places_and_no_personal_data(self) -> None:
        r = rascunho("localidade_divergente")
        self.assertIn("- EEE555 (PRNOTE05) — local previsto: Curitiba; local na Simpress: Sala 2, [E-MAIL OCULTADO], CPF", r["esqueleto"])
        for segredo in (EMAIL, CPF, "529.982"):
            self.assertNotIn(segredo, json.dumps(r, ensure_ascii=False))

    def test_pendencias_operacionais_groups_all_categories(self) -> None:
        r = rascunho("pendencias_operacionais")
        self.assertEqual(r["total"], 2 + 1 + 1 + 1)
        for titulo in ("Sem acesso há 7 dias ou mais (2):", "Localidade divergente (1):", "Séries na Simpress sem correspondência no Endpoint (1):"):
            self.assertIn(titulo, r["esqueleto"])

    def test_long_list_is_cut_with_e_mais_and_total_is_kept(self) -> None:
        comparacao = {"sem_acesso_7_dias": [{"serie": f"S{i:04d}", "computador": f"PC{i:04d}", "dias_sem_verificacao": 8} for i in range(30)]}
        r = rascunho("sem_acesso_7_dias", comparacao)
        self.assertEqual(r["total"], 30)
        self.assertIn("encontramos 30 item(ns)", r["esqueleto"])
        self.assertIn(f"- e mais {30 - LIMITE_ITENS}", r["esqueleto"])
        self.assertEqual(r["esqueleto"].count("\n- S"), LIMITE_ITENS)
        self.assertNotIn("S0029", r["esqueleto"])

    def test_worst_case_reaches_the_model_without_being_cut(self) -> None:
        # Every field at the 80-character cap, 40 items in every section: the masked tool message must stay under the chat limit.
        campos = (
            "apelidos_sem_atualizacao", "sem_acesso_7_dias", "ausentes_no_endpoint", "ausentes_em_detalhes", "divergencias_local",
            "correspondencias_ambiguas", "registros_ambiguos", "series_sem_mapeamento",
        )
        item = {"dias_sem_verificacao": 99, "local_previsto": "L" * 80, "local_detalhes": "D" * 80}
        comparacao = {c: [dict(item, serie=f"{i}{c}".ljust(80, "S"), computador=f"H{i}{c}".ljust(80, "H")) for i in range(40)] for c in campos}
        for tipo in TIPOS:
            model = FakeModel(calls(call("montar_rascunho", tipo=tipo, assunto_extra="x" * 500)), text("ok"))
            conversa = AssistantConversation(model, SimpressApi(FakeTransport(comparacao)), "modelo-teste", lambda: "", NotasStore(temp_json()))  # type: ignore[arg-type]
            conversa.enviar_mensagem("rascunha")
            conteudo = abrir(next(m["content"] for m in model.sent[1] if m["role"] == "tool"))
            self.assertLess(len(conteudo), MAX_CARACTERES_RESPOSTA, tipo)
            self.assertNotIn("aviso", json.loads(conteudo), tipo)

    def test_assunto_extra_is_cleaned_and_limited(self) -> None:
        r = rascunho("sem_acesso_7_dias", extra=f"responder até sexta, falar com {EMAIL} ou {CPF} " + "y" * 400)
        linha = r["esqueleto"].split("Observação do solicitante: ")[1]
        self.assertLessEqual(len(linha), 200)
        self.assertNotIn(EMAIL, linha)
        self.assertNotIn(CPF, linha)
        self.assertNotIn("Observação", rascunho("sem_acesso_7_dias")["esqueleto"])

    def test_invalid_type_is_refused_without_reading_anything(self) -> None:
        transporte = FakeTransport()
        for tipo in ("enviar_email", "", None, 7, ["sem_acesso_7_dias"], "SEM_ACESSO_7_DIAS"):
            r = montar_rascunho(SimpressApi(transporte), tipo)
            self.assertIn("erro", r)
            self.assertEqual(sorted(r["tipos_validos"]), sorted(TIPOS))
        self.assertEqual(transporte.calls, [])

    def test_no_items_and_no_history_do_not_produce_a_draft(self) -> None:
        r = rascunho("sem_acesso_7_dias", {"sem_acesso_7_dias": []})
        self.assertEqual(r["total"], 0)
        self.assertNotIn("esqueleto", r)
        so_sebrae = rascunho("sem_correspondencia", {"ausentes_no_endpoint": [{"serie": SEBRAE_SERIES[0], "computador": "X"}]})
        self.assertEqual(so_sebrae["total"], 0)
        sem_historico = montar_rascunho(SimpressApi(FakeTransport(eventos=False)), "sem_acesso_7_dias")
        self.assertNotIn("esqueleto", sem_historico)
        self.assertIn("mensagem", sem_historico)


class RascunhoNoChatTests(unittest.TestCase):
    def test_tool_is_registered_as_query_with_closed_enum_and_no_send_tool(self) -> None:
        tool = next(t for t in QUERY_TOOLS if t.name == "montar_rascunho")
        schema = tool.schema()["function"]["parameters"]
        self.assertEqual(schema["required"], ["tipo"])
        self.assertEqual(sorted(schema["properties"]["tipo"]["enum"]), sorted(TIPOS))
        nomes = " ".join(TOOLS)
        for verbo in ("enviar", "email", "e_mail", "mensagem", "send"):
            self.assertNotIn(verbo, nomes)

    def test_prompt_says_draft_is_text_and_never_claim_sending(self) -> None:
        self.assertIn("`montar_rascunho`", SYSTEM_PROMPT)
        self.assertIn("NÃO envia", SYSTEM_PROMPT)
        self.assertIn("Nunca diga que enviou", SYSTEM_PROMPT)
        self.assertIn("sem mudar séries, hostnames, números nem datas", SYSTEM_PROMPT)

    def test_hostnames_are_masked_for_the_model_and_restored_on_screen(self) -> None:
        model = FakeModel(
            calls(call("montar_rascunho", tipo="sem_acesso_7_dias")),
            text("Olá! Segue a lista:\n- AAA111 ([PESSOA_1]) — 9 dias sem verificação\nObrigado."),
        )
        conversa = AssistantConversation(model, SimpressApi(FakeTransport()), "modelo-teste", lambda: "", NotasStore(temp_json()))  # type: ignore[arg-type]
        resposta = conversa.enviar_mensagem("escreve a cobrança dos equipamentos sem acesso há 7 dias")
        enviado = json.dumps(model.sent[1], ensure_ascii=False)
        self.assertNotIn("PRNOTE01", enviado)
        self.assertNotIn("PRNOTE02", enviado)
        self.assertIn("[PESSOA_1]", enviado)
        self.assertIn("AAA111", enviado)  # serials are not names
        self.assertIn("AAA111 (PRNOTE01) — 9 dias sem verificação", resposta.texto)
        self.assertNotIn("PESSOA_", resposta.texto)
        self.assertEqual(resposta.ferramentas, ["montar_rascunho"])
        self.assertIsNone(resposta.pendente)

    def test_the_draft_never_writes_or_sends_anything(self) -> None:
        transporte = FakeTransport()
        model = FakeModel(calls(call("montar_rascunho", tipo="localidade_divergente", assunto_extra="até sexta")), text("Rascunho pronto."))
        conversa = AssistantConversation(model, SimpressApi(transporte), "modelo-teste", lambda: "", NotasStore(temp_json()))  # type: ignore[arg-type]
        conversa.enviar_mensagem("rascunha")
        self.assertTrue(all(metodo == "GET" for metodo, _ in transporte.calls))
        enviado = json.dumps(model.sent[1], ensure_ascii=False)
        self.assertNotIn(EMAIL, enviado)
        self.assertNotIn(CPF, enviado)


if __name__ == "__main__":
    unittest.main()
