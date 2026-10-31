import json
import unittest
from typing import Any, Dict, List, Optional, Tuple

from domains.assistant_api import SimpressApi
from domains.assistant_tools import (
    CHANGE_TOOLS, GRUPOS_FERRAMENTAS, NUCLEO_FERRAMENTAS, QUERY_TOOLS, TOOLS, grupos_da_mensagem, schemas_para_mensagem, tool_schemas,
)
from tests.test_assistant import FakeModel, abrir, call, calls, make_conversation, text

CNPJ = "11222333000181"


class Rotas:
    """Transport that answers from a table {(method, path): (status, data)} and records every call."""

    def __init__(self, rotas: Dict[Tuple[str, str], Tuple[int, Any]]) -> None:
        self.rotas = rotas
        self.calls: List[Tuple[str, str, Optional[Dict[str, Any]], Optional[Dict[str, Any]]]] = []

    def __call__(self, method: str, path: str, params: Optional[Dict[str, Any]], body: Optional[Dict[str, Any]]) -> Tuple[int, Any]:
        self.calls.append((method, path, params, body))
        return self.rotas.get((method, path), (404, {"detail": "não existe"}))

    def writes(self) -> List[Tuple[str, str]]:
        return [(m, p) for m, p, _, _ in self.calls if m != "GET"]


def montar(rotas: Dict[Tuple[str, str], Tuple[int, Any]]) -> Tuple[SimpressApi, Rotas]:
    transporte = Rotas(rotas)
    return SimpressApi(transporte), transporte


def descrever(nome: str, api: SimpressApi, args: Dict[str, Any]) -> str:
    return TOOLS[nome].describe(api, args) if TOOLS[nome].describe_com_api else TOOLS[nome].describe(args)  # type: ignore[misc]


def executar(nome: str, api: SimpressApi, args: Dict[str, Any]) -> Dict[str, Any]:
    return TOOLS[nome].run(api, args)


class CartaoValorAtualTests(unittest.TestCase):
    def test_apelido_card_shows_current_and_new_value(self) -> None:
        api, _ = montar({("GET", "/api/equipamento/ABC123"): (200, {"serial": "ABC123", "apelido": "Sala 1"})})
        self.assertEqual(descrever("atualizar_apelido", api, {"serial": "abc123", "apelido": "Sala 2"}), "Alterar o apelido do serial ABC123: 'Sala 1' → 'Sala 2'.")

    def test_apelido_card_hides_cpf_in_the_current_value(self) -> None:
        api, _ = montar({("GET", "/api/equipamento/ABC123"): (200, {"apelido": "João 529.982.247-25"})})
        self.assertNotIn("529.982.247-25", descrever("atualizar_apelido", api, {"serial": "ABC123", "apelido": "X"}))

    def test_usuario_card_shows_current_and_new_value(self) -> None:
        api, _ = montar({("GET", "/api/equipamento/ABC123"): (200, {"usuarios_logados": "Maria Souza"})})
        self.assertEqual(descrever("atualizar_usuario", api, {"serial": "ABC123", "usuario": "Ana"}), "Alterar o usuário do serial ABC123: 'Maria Souza' → 'Ana'.")

    def test_card_keeps_the_plain_text_when_the_current_value_is_unknown(self) -> None:
        api, _ = montar({("GET", "/api/equipamento/ABC123"): (200, {"serial": "ABC123"})})  # row without the key; and 404 for the other serial
        self.assertEqual(descrever("atualizar_apelido", api, {"serial": "ABC123", "apelido": "X"}), "Alterar o apelido do serial ABC123 para 'X'.")
        self.assertEqual(descrever("atualizar_usuario", api, {"serial": "ZZZ", "usuario": "Ana"}), "Alterar o usuário do serial ZZZ para 'Ana'.")

    def test_unit_card_lists_only_the_fields_that_change(self) -> None:
        unidade = {"id": 3, "cidade": "Curitiba", "endereco": "Rua A", "uf": "PR", "cep": "80000-000", "cnpj": "11.222.333/0001-81"}
        api, _ = montar({("GET", "/api/unidades"): (200, [unidade])})
        args = {"id": 3, "cidade": "Curitiba", "endereco": "Rua B", "uf": "PR", "cep": "80000000", "cnpj": CNPJ}
        self.assertEqual(descrever("salvar_unidade", api, args), "Editar a unidade #3: endereço 'Rua A' → 'Rua B'.")
        self.assertTrue(descrever("salvar_unidade", api, {**args, "id": 9}).startswith("Editar a unidade #9: cidade Curitiba"))  # unknown id: plain card
        self.assertTrue(descrever("salvar_unidade", api, {k: v for k, v in args.items() if k != "id"}).startswith("Criar nova unidade"))


class LeiturasNovasTests(unittest.TestCase):
    def test_historico_chamados_lists_imports(self) -> None:
        eventos = [{"id": f"s{i}", "atualizado_em": "2026-01-01", "resumo": {"total": i}} for i in range(30)]
        api, transporte = montar({("GET", "/api/operacoes/chamados/historico"): (200, {"eventos": eventos, "total": 30})})
        resposta = executar("historico_chamados", api, {"limite": 3})
        self.assertEqual((resposta["total"], [e["id"] for e in resposta["eventos"]]), (30, ["s0", "s1", "s2"]))
        self.assertEqual(transporte.writes(), [])

    def test_snapshot_chamados_cuts_the_rows(self) -> None:
        chamados = [{"serie": f"S{i}", "relacao": "UTIC-2026-1", "obs": "x" * 500} for i in range(40)]
        corpo = {"id": "s1", "atualizado_em": "2026-01-01", "fontes": {"simpress": {"arquivo": "a.xlsx"}}, "resumo": {"total": 40}, "chamados": chamados}
        api, _ = montar({("GET", "/api/operacoes/chamados/snapshot/s1"): (200, corpo)})
        resposta = executar("snapshot_chamados", api, {"id": "s1"})
        self.assertEqual((resposta["total_chamados"], len(resposta["chamados"]), resposta["omitidos"]), (40, 20, 20))
        self.assertEqual(resposta["fontes"], {"simpress": "a.xlsx"})
        self.assertNotIn("obs", resposta["chamados"][0])
        self.assertIn("erro", executar("snapshot_chamados", api, {"id": "../x"}))
        self.assertIn("erro", executar("snapshot_chamados", api, {"id": "nao-existe"}))

    def test_evolucao_chamados_keeps_field_names_only(self) -> None:
        corpo = {
            "anterior": {"id": "a"}, "atual": {"id": "b"}, "contagens": {"novos": 1, "alterados": 1, "iguais": 5, "ausentes_arquivo": 0},
            "mudancas": {
                "novos": ["N1"], "alterados": [{"serie": "S1", "campos": [{"campo": "status", "anterior": "x", "atual": "y"}]}],
                "iguais": ["I1"], "ausentes_arquivo": [],
            },
            "aviso_ausentes": "",
        }
        api, transporte = montar({("GET", "/api/operacoes/chamados/evolucao"): (200, corpo)})
        resposta = executar("evolucao_chamados", api, {"anterior": "a", "atual": "b"})
        self.assertEqual(resposta["alterados"], [{"serie": "S1", "campos": ["status"]}])
        self.assertEqual((resposta["novos"], resposta["contagens"]["iguais"]), (["N1"], 5))
        self.assertNotIn("iguais", resposta)
        self.assertEqual(transporte.calls[0][2], {"anterior": "a", "atual": "b"})
        self.assertIn("erro", executar("evolucao_chamados", api, {"anterior": "a"}))

    def test_historico_sebrae_lists_and_opens_one_entry(self) -> None:
        api, transporte = montar({
            ("GET", "/api/sebrae/historico"): (200, {"total": 2, "itens": [{"id": "e1", "tipo": "busca"}], "importacoes": 1, "buscas": 1}),
            ("GET", "/api/sebrae/historico/e1"): (200, {"id": "e1", "tipo": "busca", "novos": 3}),
        })
        self.assertEqual(executar("historico_sebrae", api, {"tipo": "busca", "limite": 5})["dados"]["total"], 2)
        self.assertEqual(transporte.calls[0][2], {"limite": 5, "tipo": "busca"})
        self.assertEqual(executar("historico_sebrae", api, {"entrada_id": "e1"})["dados"]["novos"], 3)
        self.assertIn("erro", executar("historico_sebrae", api, {"entrada_id": "e2"}))

    def test_usuarios_logados_is_a_read_and_leaks_only_masked_fields(self) -> None:
        usuario = {
            "usuario": "maria.souza", "nome_pessoa": "Maria Souza", "origem": "entra", "serial_cadastro": "RAW-SERIAL", "hostname": "PC-MARIA",
            "hostname_candidatos": ["PC-OUTRO"], "candidatos": ["Outra Pessoa"], "hostname_ambiguo": False, "pendencia": "CPF 529.982.247-25",
        }
        api, transporte = montar({("POST", "/api/equipamentos/usuarios-logados"): (200, {"usuarios": {"ABC123": usuario}})})
        assert not TOOLS["usuarios_logados"].changes_data
        resposta = executar("usuarios_logados", api, {"series": ["abc123", "ABC123"]})
        self.assertEqual(transporte.calls[0][3], {"series": ["ABC123"]})
        item = resposta["itens"][0]
        self.assertEqual((item["serie"], item["usuario_logado"], item["nome_pessoa"], item["computador"]), ("ABC123", "maria.souza", "Maria Souza", "PC-MARIA"))
        bruto = json.dumps(resposta)
        for vazamento in ("RAW-SERIAL", "PC-OUTRO", "Outra Pessoa", "529.982.247-25"):
            self.assertNotIn(vazamento, bruto)
        self.assertIn("erro", executar("usuarios_logados", api, {"series": []}))


class AlteracoesNovasTests(unittest.TestCase):
    def test_every_new_change_asks_for_confirmation(self) -> None:
        for nome in ("registrar_transferencia", "resolver_apelido_manual", "salvar_nome_pessoa", "excluir_chamados_antigos", "recarregar_base"):
            self.assertTrue(TOOLS[nome].changes_data and TOOLS[nome].describe, nome)
            self.assertIn(TOOLS[nome], CHANGE_TOOLS)

    def test_registrar_transferencia(self) -> None:
        api, transporte = montar({("POST", "/api/historico-transferencias"): (201, {"sucesso": True, "id": "t1"})})
        args = {"serial": "abc123", "entrega_cnpj": CNPJ, "entrega_endereco": "Rua A, 1", "entrega_contato": "Ana", "entrega_cidade": "Curitiba"}
        cartao = descrever("registrar_transferencia", api, args)
        self.assertIn("ABC123", cartao)
        self.assertIn("não gera a planilha", cartao)
        self.assertEqual(transporte.calls, [])  # building the card writes nothing
        self.assertTrue(executar("registrar_transferencia", api, args)["sucesso"])
        corpo = transporte.calls[0][3] or {}
        self.assertEqual((transporte.calls[0][:2], corpo["serial"], corpo["entrega_cnpj"]), (("POST", "/api/historico-transferencias"), "ABC123", CNPJ))
        self.assertNotIn("entrega_email", corpo)
        with self.assertRaises(ValueError):
            descrever("registrar_transferencia", api, {**args, "entrega_cnpj": "123"})
        with self.assertRaises(ValueError):
            descrever("registrar_transferencia", api, {"serial": "ABC123"})

    def test_resolver_apelido_manual(self) -> None:
        evento = {"evento": {"comparacao": {"divergencias_apelidos_manuais": [
            {"serie": "ABC123", "apelido_manual": "Sala 1", "resolucao": "pendente"},
            {"serie": "DEF456", "apelido_manual": "Sala 2", "resolucao": "manter"},
        ]}}}
        api, transporte = montar({
            ("GET", "/api/historico-comparacoes/e1"): (200, evento),
            ("POST", "/api/historico-comparacoes/e1/apelido-manual/ABC123"): (200, {"sucesso": True}),
        })
        cartao = descrever("resolver_apelido_manual", api, {"evento_id": "e1", "serial": "abc123", "acao": "excluir"})
        self.assertIn("Sala 1", cartao)
        self.assertIn("volta a seguir as planilhas", cartao)
        self.assertIn("Manter o apelido manual", descrever("resolver_apelido_manual", api, {"evento_id": "e1", "serial": "ABC123", "acao": "manter"}))
        for args in ({"evento_id": "e1", "serial": "DEF456", "acao": "manter"}, {"evento_id": "e1", "serial": "ZZZ", "acao": "manter"},
                     {"evento_id": "e1", "serial": "ABC123", "acao": "apagar"}, {"evento_id": "e9", "serial": "ABC123", "acao": "manter"}):
            with self.assertRaises(ValueError, msg=str(args)):
                descrever("resolver_apelido_manual", api, args)
        self.assertEqual(transporte.writes(), [])
        self.assertTrue(executar("resolver_apelido_manual", api, {"evento_id": "e1", "serial": "abc123", "acao": "excluir"})["sucesso"])
        self.assertEqual(transporte.calls[-1][3], {"acao": "excluir"})

    def test_salvar_nome_pessoa_takes_the_login_from_the_server(self) -> None:
        pessoa = {"usuario": "maria.souza", "nome_pessoa": "", "nome_pessoa_editavel": True, "serial_cadastro": "ABC123-CAD"}
        api, transporte = montar({
            ("POST", "/api/equipamentos/usuarios-logados"): (200, {"usuarios": {"ABC123": pessoa}}),
            ("POST", "/api/equipamento/nome-pessoa"): (200, {"sucesso": True}),
        })
        cartao = descrever("salvar_nome_pessoa", api, {"serial": "abc123", "nome": "Maria Souza"})
        self.assertIn("maria.souza", cartao)
        self.assertIn("Maria Souza", cartao)
        # the model never supplies the login: an invented one in the arguments is ignored
        self.assertTrue(executar("salvar_nome_pessoa", api, {"serial": "ABC123", "nome": "Maria Souza", "login_atual": "outro"})["sucesso"])
        self.assertEqual(transporte.calls[-1][3], {"serial": "ABC123-CAD", "login_atual": "maria.souza", "nome": "Maria Souza"})
        self.assertIn("Remover o nome", descrever("salvar_nome_pessoa", api, {"serial": "ABC123", "nome": ""}))

    def test_salvar_nome_pessoa_refuses_without_valid_login(self) -> None:
        api, _ = montar({("POST", "/api/equipamentos/usuarios-logados"): (200, {"usuarios": {"ABC123": {"usuario": "", "nome_pessoa_editavel": True}}})})
        with self.assertRaises(ValueError):
            descrever("salvar_nome_pessoa", api, {"serial": "ABC123", "nome": "Maria"})
        with self.assertRaises(ValueError):
            descrever("salvar_nome_pessoa", montar({})[0], {"serial": "ABC123", "nome": "Maria"})

    def test_excluir_chamados_antigos(self) -> None:
        historico = ("GET", "/api/operacoes/chamados/historico")
        api, transporte = montar({historico: (200, {"eventos": [], "total": 4}), ("DELETE", "/api/operacoes/chamados/historico/antigas"): (200, {"removidas": 3, "total": 1})})
        cartao = descrever("excluir_chamados_antigos", api, {})
        self.assertIn("3 importação", cartao)
        self.assertIn("Não dá para desfazer", cartao)
        self.assertEqual(transporte.writes(), [])
        self.assertIn("3 importação", executar("excluir_chamados_antigos", api, {})["mensagem"])
        sozinha, _ = montar({historico: (200, {"eventos": [], "total": 1})})
        with self.assertRaises(ValueError):
            descrever("excluir_chamados_antigos", sozinha, {})

    def test_recarregar_base_runs_only_after_the_card(self) -> None:
        rotas = {("POST", "/api/recarregar-base"): (200, {"sucesso": True, "arquivo_origem": "base.xlsx", "total_equipamentos": 10})}
        transporte = Rotas(rotas)
        conversa, _ = make_conversation(FakeModel(calls(call("recarregar_base")), text("Feito.")), transporte)  # type: ignore[arg-type]
        resposta = conversa.enviar_mensagem("recarregue a base")
        self.assertIn("Recarregar a base", (resposta.pendente or {})["descricao"])
        self.assertEqual(transporte.writes(), [])
        conversa.resolver_confirmacao(True)
        self.assertEqual(transporte.writes(), [("POST", "/api/recarregar-base")])

    def test_write_failure_is_reported_not_raised(self) -> None:
        api, _ = montar({})
        self.assertFalse(executar("recarregar_base", api, {})["sucesso"])
        self.assertFalse(executar("excluir_chamados_antigos", api, {})["sucesso"])
        self.assertFalse(executar("registrar_transferencia", api, {"serial": "X"})["sucesso"])

    def test_read_result_reaches_the_model_inside_the_data_envelope(self) -> None:
        rotas = Rotas({("GET", "/api/operacoes/chamados/historico"): (200, {"eventos": [{"id": "s1"}], "total": 1})})
        modelo = FakeModel(calls(call("historico_chamados")), text("ok"))
        conversa, _ = make_conversation(modelo, rotas)  # type: ignore[arg-type]
        conversa.enviar_mensagem("mostre o histórico de chamados")
        ferramenta = [m for m in modelo.sent[-1] if m.get("role") == "tool"][0]
        self.assertEqual(json.loads(abrir(ferramenta["content"]))["total"], 1)

    def test_usuarios_logados_names_never_reach_the_model(self) -> None:
        usuario = {"usuario": "maria.souza", "nome_pessoa": "Maria Souza", "hostname": "PC-MARIA", "origem": "entra"}
        rotas = Rotas({("POST", "/api/equipamentos/usuarios-logados"): (200, {"usuarios": {"ABC123": usuario}})})
        modelo = FakeModel(calls(call("usuarios_logados", series=["ABC123"])), text("A pessoa é [PESSOA_1]."))
        conversa, _ = make_conversation(modelo, rotas)  # type: ignore[arg-type]
        resposta = conversa.enviar_mensagem("quem usa a ABC123?")
        enviado = json.dumps(modelo.sent[-1], ensure_ascii=False)
        for dado in ("maria.souza", "Maria Souza", "PC-MARIA"):
            self.assertNotIn(dado, enviado)
        self.assertNotIn("[PESSOA_", resposta.texto)  # the marker is restored for the screen

    def test_card_current_value_does_not_reach_the_model_after_confirming(self) -> None:
        rotas = Rotas({
            ("GET", "/api/equipamento/ABC123"): (200, {"serial": "ABC123", "usuarios_logados": "Maria Souza", "apelido": "Sala Maria"}),
            ("POST", "/api/equipamento/atualizar-usuario"): (200, {"ok": True}),
        })
        modelo = FakeModel(calls(call("atualizar_usuario", serial="ABC123", usuario="Ana")), text("Feito."), text("De nada."))
        conversa, _ = make_conversation(modelo, rotas)  # type: ignore[arg-type]
        resposta = conversa.enviar_mensagem("troque o usuário da ABC123 para Ana")
        self.assertIn("Maria Souza", (resposta.pendente or {})["descricao"])  # the card (screen only) shows the current value
        conversa.resolver_confirmacao(True)
        conversa.enviar_mensagem("obrigado")
        enviado = json.dumps(modelo.sent, ensure_ascii=False)
        for dado in ("Maria Souza", "Sala Maria"):
            self.assertNotIn(dado, enviado)

    def test_name_card_with_a_lookup_post_does_not_write_before_confirming(self) -> None:
        pessoa = {"usuario": "maria.souza", "nome_pessoa_editavel": True}
        rotas = Rotas({
            ("POST", "/api/equipamentos/usuarios-logados"): (200, {"usuarios": {"ABC123": pessoa}}),
            ("POST", "/api/equipamento/nome-pessoa"): (200, {"sucesso": True}),
        })
        modelo = FakeModel(calls(call("salvar_nome_pessoa", serial="ABC123", nome="Maria Souza")), text("Feito."), text("ok"))
        conversa, _ = make_conversation(modelo, rotas)  # type: ignore[arg-type]
        resposta = conversa.enviar_mensagem("o nome da pessoa da ABC123 é Maria Souza")
        self.assertIn("maria.souza", (resposta.pendente or {})["descricao"])
        self.assertEqual(rotas.writes(), [("POST", "/api/equipamentos/usuarios-logados")])  # only the card's lookup, no change yet
        self.assertNotIn("/api/equipamento/nome-pessoa", [p for _, p, _, _ in rotas.calls])
        conversa.resolver_confirmacao(True)
        self.assertEqual(rotas.calls[-1][1], "/api/equipamento/nome-pessoa")

    def test_name_card_login_does_not_reach_the_model_after_confirming(self) -> None:
        pessoa = {"usuario": "maria.souza", "nome_pessoa_editavel": True}
        rotas = Rotas({
            ("POST", "/api/equipamentos/usuarios-logados"): (200, {"usuarios": {"ABC123": pessoa}}),
            ("POST", "/api/equipamento/nome-pessoa"): (200, {"sucesso": True}),
        })
        modelo = FakeModel(calls(call("salvar_nome_pessoa", serial="ABC123", nome="Maria Souza")), text("Feito."), text("ok"))
        conversa, _ = make_conversation(modelo, rotas)  # type: ignore[arg-type]
        conversa.enviar_mensagem("o nome da pessoa da ABC123 é Maria Souza")
        conversa.resolver_confirmacao(True)
        conversa.enviar_mensagem("obrigado")
        self.assertNotIn("maria.souza", json.dumps(modelo.sent[-1], ensure_ascii=False))


class SchemasPorMensagemTests(unittest.TestCase):
    @staticmethod
    def nomes(texto: str, web: bool = False, pendente: Optional[str] = None) -> set:  # type: ignore[type-arg]
        return {s["function"]["name"] for s in schemas_para_mensagem(texto, web, pendente)}

    def test_typical_phrases_pick_the_right_group(self) -> None:
        casos = {
            "quais chamados estão abertos?": "linha_do_tempo_chamados",
            "vincule a OS 123 ao chamado UTIC-2026-5": "vincular_os",
            "o que mudou no sebrae?": "proximo_passo_sebrae",
            "finalize o UTIC-2026-1253 no SoftExpert": "finalizar_chamado_softexpert",
            "deu certo a finalização?": "situacao_finalizacao_sebrae",
            "compare o histórico de planilhas": "listar_eventos_comparacao",
            "registre a transferência da ABC123": "registrar_transferencia",
            "rode a rotina de inventários no Chrome": "executar_automacao_chrome",
            "quem é o usuário logado na ABC123?": "usuarios_logados",
            "troque o apelido da ABC123": "atualizar_apelido",
            "mude o endereço da unidade 3": "salvar_unidade",
            "remova o hostname duplicado": "remover_hostname_endpoint",
            "relatório mensal de março": "obter_relatorio_mensal",
            "exporte para excel": "exportar_planilha",
            "recarregue a base": "recarregar_base",
        }
        for frase, esperado in casos.items():
            nomes = self.nomes(frase)
            self.assertIn(esperado, nomes, frase)
            self.assertLess(len(nomes), len(TOOLS), frase)  # a recognised phrase sends a subset
            self.assertTrue(set(NUCLEO_FERRAMENTAS) - {"buscar_web"} <= nomes, frase)

    def test_writes_do_not_enter_through_unrelated_words(self) -> None:
        nomes = self.nomes("quais chamados estão abertos?")
        for escrita in ("atualizar_apelido", "salvar_unidade", "recarregar_base", "executar_automacao_chrome", "registrar_transferencia", "remover_hostname_endpoint"):
            self.assertNotIn(escrita, nomes)

    def test_article_os_is_not_the_service_order(self) -> None:
        self.assertEqual(grupos_da_mensagem("mostre os notebooks"), [])
        self.assertEqual(grupos_da_mensagem("a OS 55 está aberta"), ["chamados"])

    def test_vague_phrase_returns_every_tool(self) -> None:
        for frase in ("oi", "quantos notebooks temos?", ""):
            self.assertEqual(schemas_para_mensagem(frase), tool_schemas(), frase)
        self.assertEqual(schemas_para_mensagem("oi", True), tool_schemas(True))

    def test_web_search_still_follows_the_switch(self) -> None:
        self.assertNotIn("buscar_web", self.nomes("chamados"))
        self.assertIn("buscar_web", self.nomes("chamados", web=True))
        self.assertNotIn("buscar_web", self.nomes("oi"))

    def test_pending_card_tool_is_always_kept(self) -> None:
        self.assertNotIn("recarregar_base", self.nomes("chamados"))
        self.assertIn("recarregar_base", self.nomes("chamados", pendente="recarregar_base"))

    def test_no_tool_disappears_from_the_full_set(self) -> None:
        agrupadas = set(NUCLEO_FERRAMENTAS).union(*(set(tools) for _, tools in GRUPOS_FERRAMENTAS.values()))
        self.assertEqual(agrupadas, set(TOOLS))
        self.assertEqual(len(QUERY_TOOLS) + len(CHANGE_TOOLS), len(TOOLS))  # no duplicated name swallowed by the dict
        todos = set().union(*(self.nomes(f"{padrao}") for padrao in ("chamados sebrae histórico transferência rotina usuário apelido unidade hostname mensal excel recarregar",)))
        self.assertEqual(todos, {t for t in TOOLS if t != "buscar_web"})

    def test_subset_is_smaller_than_the_full_set(self) -> None:
        completo = len(json.dumps(tool_schemas(), ensure_ascii=False))
        for frase in ("quais chamados estão abertos?", "troque o apelido da ABC123", "recarregue a base"):
            self.assertLess(len(json.dumps(schemas_para_mensagem(frase), ensure_ascii=False)), completo, frase)

    def test_order_follows_the_catalog(self) -> None:
        ordem = list(TOOLS)
        nomes = [s["function"]["name"] for s in schemas_para_mensagem("apelido")]
        self.assertEqual(nomes, sorted(nomes, key=ordem.index))


if __name__ == "__main__":
    unittest.main()
