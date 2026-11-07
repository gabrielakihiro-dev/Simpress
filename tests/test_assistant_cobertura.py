"""Ferramenta `listar_cobertura` do Assistente: cenário V1-V4, filtros, máscara, só leitura e estado ilegível.

Usa o router real da Cobertura (o mesmo GET /api/cobertura da tela) como transporte. Só dados sintéticos e pastas temporárias.
"""

import hashlib
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.assistant_api import SimpressApi
from domains.assistant_chat import SYSTEM_PROMPT, AssistantConversation
from domains.assistant_tools import QUERY_TOOLS, TOOLS, grupos_da_mensagem, schemas_para_mensagem
from domains.coverage import Manutencao
from routers.coverage import CoverageServices, create_coverage_router
from tests.test_assistant import FakeModel, abrir, call, calls, text

HOJE = date(2026, 11, 6)
NOME = "Maria Sintética da Silva"
EMAIL = "maria.sintetica@exemplo.test"
TELEFONE = "(41) 99876-5432"
PERGUNTA = "vai faltar notebook na Cidade A dia 20?"


class ModeloComFerramentas(FakeModel):
    def __init__(self, *replies: Any) -> None:
        super().__init__(*replies)
        self.ferramentas: List[List[str]] = []

    def complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]], orcamento: Optional[float] = None) -> Any:
        self.ferramentas.append([t["function"]["name"] for t in tools])
        return super().complete(messages, tools, orcamento)


class ListarCoberturaTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "data" / "state" / "operacao_cobertura.json"
        self.archive = self.root / "data" / "state" / "operacao_cobertura_arquivados.json"
        router, _ = create_coverage_router(CoverageServices(
            state_file=lambda: self.state,
            archive_file=lambda: self.archive,
            transaction_root=lambda: self.root,
            hoje=lambda: HOJE,
            agora=lambda: "2026-11-06T09:00:00-03:00",
            manutencao=lambda: Manutencao(),
            cadastro=lambda: [{"serial": "SINT-001", "retirada_cidade": "Cidade A", "apelido": "PRNOTE0001"}],
        ))
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)
        self.api = SimpressApi(self.transporte)

    def transporte(self, method: str, path: str, params: Optional[Dict[str, Any]], body: Optional[Dict[str, Any]]) -> Any:
        resposta = self.client.request(method, path, params=params, json=body)
        return resposta.status_code, resposta.json()

    def post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        resposta = self.client.post(path, json=body)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()

    def cenario(self) -> None:
        """V1-V4: 4 vagas no dia 20 na Cidade A; 2 disponíveis, 1 devolução a tempo, 1 sem cobertura."""
        self.post("/api/cobertura/demandas", {
            "data": "2026-11-20", "cidade": "Cidade A", "quantidade": 4, "perfil": "Notebook padrão",
            "observacao": f"Entregar a {NOME}, {EMAIL}, {TELEFONE}",
        })
        self.post("/api/cobertura/disponibilidade", {"serie": "SINT-001", "estado": "disponivel"})
        self.post("/api/cobertura/disponibilidade", {"serie": "SINT-002", "estado": "disponivel", "cidade": "Cidade A"})
        self.post("/api/cobertura/devolucoes", {"serie": "SINT-003", "data_prevista": "2026-11-15", "cidade": "Cidade A"})

    def executar(self, **args: Any) -> Dict[str, Any]:
        return TOOLS["listar_cobertura"].run(self.api, args)

    def test_registrada_como_leitura_com_parametros(self) -> None:
        ferramenta = TOOLS["listar_cobertura"]
        self.assertIn(ferramenta, QUERY_TOOLS)
        self.assertFalse(ferramenta.changes_data)
        propriedades = ferramenta.schema()["function"]["parameters"]["properties"]
        self.assertEqual(set(propriedades), {"cidade", "data", "ate", "perfil"})
        self.assertIn("listar_cobertura", SYSTEM_PROMPT)

    def test_pergunta_alvo_envia_a_ferramenta(self) -> None:
        self.assertIn("cobertura", grupos_da_mensagem(PERGUNTA))
        self.assertIn("listar_cobertura", [s["function"]["name"] for s in schemas_para_mensagem(PERGUNTA)])
        self.assertNotIn("listar_cobertura", [s["function"]["name"] for s in schemas_para_mensagem("registre a transferência da ABC123")])

    def test_cenario_v1_v4_numeros_iguais_aos_da_tela(self) -> None:
        self.cenario()
        tela = self.client.get("/api/cobertura").json()
        resultado = self.executar()
        self.assertEqual(resultado["contagens"], tela["contagens"])
        self.assertEqual(resultado["contagens"], {"atendivel": 2, "condicionada": 1, "sem_cobertura": 1, "entregue": 0})
        self.assertEqual(resultado["faltam"], 1)
        self.assertEqual([(v["situacao"], v["serie"]) for v in resultado["vagas"]],
                         [("atendivel", "SINT-001"), ("atendivel", "SINT-002"), ("condicionada", "SINT-003"), ("sem_cobertura", None)])
        self.assertEqual([s["serie"] for s in resultado["disponiveis"]], ["SINT-001", "SINT-002"])

    def test_filtros_de_cidade_data_e_perfil(self) -> None:
        self.cenario()
        self.post("/api/cobertura/demandas", {"data": "2026-11-25", "cidade": "Cidade B", "quantidade": 1})
        filtrado = self.executar(cidade="cidade a", data="2026-11-20", perfil="notebook")
        self.assertEqual(filtrado["faltam"], 1)
        self.assertEqual(len(filtrado["vagas"]), 4)
        self.assertEqual(self.executar(cidade="Cidade B")["contagens"]["sem_cobertura"], 1)
        self.assertEqual(len(self.executar(ate="2026-11-20")["vagas"]), 4)
        self.assertNotIn("vagas", self.executar(cidade="Cidade"))  # igualdade, não pedaço do nome

    def test_filtro_sem_vaga_nao_vira_faltam_zero(self) -> None:
        self.cenario()
        resultado = self.executar(cidade="Cidade A", data="2026-11-21")
        self.assertNotIn("faltam", resultado)
        self.assertIn("Nenhuma vaga corresponde ao filtro", resultado["mensagem"])
        self.assertEqual(resultado["cidades_existentes"], ["Cidade A"])
        self.assertEqual(resultado["datas_existentes"], ["2026-11-20"])

    def test_data_invalida_da_erro_claro(self) -> None:
        for valor in ("20", "2026-11-31", "20/11/2026"):
            resultado = self.executar(data=valor)
            self.assertIn("AAAA-MM-DD", resultado["erro"], valor)

    def test_sem_dados_pessoais_no_resultado(self) -> None:
        self.cenario()
        bruto = json.dumps(self.client.get("/api/cobertura").json(), ensure_ascii=False)
        self.assertIn(EMAIL, bruto)  # a tela recebe os casos; a ferramenta não pode repassá-los
        saida = json.dumps(self.executar(), ensure_ascii=False)
        for dado in (NOME, EMAIL, TELEFONE, "casos", "observacao"):
            self.assertNotIn(dado, saida)

    def test_so_leitura_arquivos_de_estado_nao_mudam(self) -> None:
        self.cenario()

        def retrato() -> Dict[str, str]:
            return {
                str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(self.root.rglob("*")) if p.is_file()
            }

        antes = retrato()
        self.executar()
        self.executar(cidade="Cidade A", data="2026-11-20")
        self.executar(cidade="Cidade Z")
        self.assertEqual(retrato(), antes)

    def test_estado_ilegivel_da_erro_sem_numeros(self) -> None:
        self.state.parent.mkdir(parents=True, exist_ok=True)
        self.state.write_text("{ isto não é json", encoding="utf-8")
        resultado = self.executar(cidade="Cidade A")
        self.assertEqual(set(resultado), {"erro"})
        self.assertTrue(resultado["erro"].startswith("Erro 503 do Simpress: "), resultado["erro"])
        self.assertGreater(len(resultado["erro"]), len("Erro 503 do Simpress: "))
        self.assertEqual(self.state.read_text(encoding="utf-8"), "{ isto não é json")

    def test_conversa_chama_a_ferramenta_e_nada_e_gravado(self) -> None:
        self.cenario()
        modelo = ModeloComFerramentas(
            calls(call("listar_cobertura", cidade="Cidade A", data="2026-11-20")),
            text("Sim: falta 1 notebook na Cidade A no dia 20."),
        )
        conversa = AssistantConversation(modelo, self.api, "modelo-teste")
        resposta = conversa.enviar_mensagem(PERGUNTA)
        self.assertEqual(resposta.ferramentas, ["listar_cobertura"])
        self.assertIsNone(resposta.pendente)
        self.assertIn("listar_cobertura", modelo.ferramentas[0])
        resultado = json.loads(abrir(modelo.sent[1][-1]["content"]))
        self.assertEqual(resultado["faltam"], 1)


if __name__ == "__main__":
    unittest.main()
