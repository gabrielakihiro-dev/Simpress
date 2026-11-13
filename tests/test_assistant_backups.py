"""Ferramenta `listar_backups_regionais` do Assistente: números do painel, lista de campos permitidos, privacidade e só leitura.

Usa o router real do painel (o mesmo GET /api/painel da tela) como transporte, com o cálculo real de
``build_backups_regionais`` e serviços falsos. Só dados sintéticos e pastas temporárias; nunca usa ``data/``.
"""

import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.assistant_api import AVISO_BACKUPS_NO_PAINEL, MAX_ITENS_LISTA, SimpressApi
from domains.assistant_chat import SYSTEM_PROMPT, AssistantConversation
from domains.assistant_tools import QUERY_TOOLS, TOOLS, grupos_da_mensagem, schemas_para_mensagem
from domains.coverage import Manutencao
from domains.effective_alias import build_endpoint_alias_index
from routers.backups_regionais import BackupsRegionaisServices, ler_painel_backups
from routers.dashboard import DashboardServices, create_dashboard_router
from tests.test_assistant import FakeModel, abrir, call, calls, text

AGORA = datetime(2026, 11, 12, 12, 0, tzinfo=timezone(timedelta(hours=-3)))
FERRAMENTA = "listar_backups_regionais"
PERGUNTA = "Cascavel tem backup de notebook?"
# Nomes sintéticos, só ASCII: nenhum pode chegar ao modelo, por nenhum caminho.
NOME_APELIDO = "Marilda Zanzibar Quintela"
NOME_TRAVA = "Ottavio Pimpinela Rocha"
NOME_ENTRA = "Brunilda Tamandua Veloso"
NOME_MANUAL = "Edivaldo Cambuci Freire"
NOME_OUTRA = "Zenaide Piracicaba Lontra"  # apelido manual de uma cidade sem mínimo (Curitiba)
NOME_LOGIN = "joao.sintetico"  # usuário logado no Endpoint (USUARIOSLOGADOS), nunca sai do cálculo
NOMES = (NOME_APELIDO, NOME_TRAVA, NOME_ENTRA, NOME_MANUAL, NOME_OUTRA, NOME_LOGIN)
APELIDO_DIVERGENTE = "BACKUPLONDRINA01"


def notebook(serie: str, cidade: str = "Cascavel", **extra: Any) -> Dict[str, Any]:
    item = {
        "serial": serie, "tipo": "NOTEBOOK", "modelo": "Latitude 5440", "retirada_cidade": cidade,
        "_apelido_base": "", "apelido": "", "_apelido_manual_override": False, "serie_detalhes_duplicada": False,
    }
    item.update(extra)
    return item


def endpoint(*linhas: Any) -> Dict[str, Any]:
    """Cada linha: (serie, hostname, verificado_em|None) ou, com usuário logado, (serie, hostname, verificado_em|None, usuario)."""
    registros = [
        {
            "SERIAL": serie, "NOMEDOCOMPUTADOR": hostname, "USUARIOSLOGADOS": usuario,
            "ULTIMAVERIFICACAOCOMEXITO": verificado.isoformat() if verificado else "",
        }
        for serie, hostname, verificado, usuario in (linha if len(linha) == 4 else (*linha, "") for linha in linhas)
    ]
    indice = build_endpoint_alias_index(registros)
    indice["manual_users"] = {}
    indice["user_holds"] = {}
    return indice


class ModeloComFerramentas(FakeModel):
    def __init__(self, *replies: Any) -> None:
        super().__init__(*replies)
        self.ferramentas: List[List[str]] = []

    def complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]], orcamento: Optional[float] = None) -> Any:
        self.ferramentas.append([t["function"]["name"] for t in tools])
        return super().complete(messages, tools, orcamento)


class ListarBackupsRegionaisTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "data" / "state" / "backups_regionais.json"
        self.equipamentos: List[Dict[str, Any]] = self.cenario_equipamentos()
        self.endpoint: Dict[str, Any] = self.cenario_endpoint()
        self.servico_painel: Any = lambda: ler_painel_backups(self.backups)
        self.backups = BackupsRegionaisServices(
            state_file=lambda: self.state,
            transaction_root=lambda: self.root,
            equipamentos=lambda: self.equipamentos,
            endpoint=lambda: self.endpoint,
            estado_cobertura=lambda: {"disponibilidade": {}, "reservas": {}, "movimentacoes": {}, "devolucoes": {}},
            manutencao=lambda: Manutencao(),
            agora=lambda: AGORA,
        )
        self.client = self.montar_cliente(lambda: self.servico_painel())
        self.api = SimpressApi(self.transporte)

    def cenario_equipamentos(self) -> List[Dict[str, Any]]:
        return [
            # Cascavel: some do Endpoint, com o nome de uma pessoa no apelido manual (o `apelido` do cálculo).
            notebook("NB1", "Cascavel", apelido=f"{NOME_APELIDO} (M)", _apelido_manual_override=True),
            # Cascavel: usuário logado no Endpoint e verificada há 1 dia = excluída por usuário vigente (o login não pode sair).
            notebook("NB7", "Cascavel"),
            # Londrina: marca BACKUPLONDRINA02 válida e verificada há 1 dia = backup contado.
            notebook("NB2", "Londrina"),
            # Pato Branco: série com usuário vigente na trava = excluída.
            notebook("NB3", "Pato Branco"),
            # Maringá: apelido manual com marca de outra cidade = conferência.
            notebook("NB6", "Maringá", apelido=f"{APELIDO_DIVERGENTE} (M)", _apelido_manual_override=True),
            # Curitiba (sem mínimo): ausente do Endpoint, com nome de pessoa no apelido manual = candidata em outras_candidatos.
            notebook("NB8", "Curitiba", apelido=f"{NOME_OUTRA} (M)", _apelido_manual_override=True),
        ]

    def cenario_endpoint(self) -> Dict[str, Any]:
        indice = endpoint(
            ("NB2", "BACKUPLONDRINA02", AGORA - timedelta(days=1)),
            ("OUTRO", "PRNOTE-X", AGORA - timedelta(days=1)),
            ("NB7", "PRNOTE-C07", AGORA - timedelta(days=1), NOME_LOGIN),
        )
        indice["user_holds"] = {"NB3": {"tipo": "usuario_ausente", "estado": "pendente", "usuario_atual": NOME_TRAVA}}
        indice["entra_directory"] = {"entra-1": {"nome": NOME_ENTRA}}
        indice["manual_person_names"] = {"manual-1": NOME_MANUAL}
        return indice

    def montar_cliente(self, backups: Any) -> TestClient:
        router, _ = create_dashboard_router(DashboardServices(
            get_equipment=lambda: self.equipamentos,
            get_stats=lambda: {"total_unidades": len(self.equipamentos), "ultima_atualizacao": "12/11/2026 09:00"},
            get_comparison_events=lambda: [],
            categories=({"value": "notebook", "label": "Notebooks"},),
            categorize=lambda tipo, modelo: "notebook" if "NOTEBOOK" in f"{tipo} {modelo}".upper() else "",
            get_backups_regionais=backups,
        ))
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def transporte(self, method: str, path: str, params: Optional[Dict[str, Any]], body: Optional[Dict[str, Any]]) -> Any:
        resposta = self.client.request(method, path, params=params, json=body)
        return resposta.status_code, resposta.json()

    def executar(self, **args: Any) -> Dict[str, Any]:
        return TOOLS[FERRAMENTA].run(self.api, args)

    def regional(self, resultado: Dict[str, Any], cidade: str) -> Dict[str, Any]:
        return next(g for g in resultado["prioritarias"] if g["cidade"] == cidade)

    def test_registrada_como_leitura_com_parametro_cidade(self) -> None:
        ferramenta = TOOLS[FERRAMENTA]
        self.assertIn(ferramenta, QUERY_TOOLS)
        self.assertFalse(ferramenta.changes_data)
        self.assertEqual(set(ferramenta.schema()["function"]["parameters"]["properties"]), {"cidade"})
        self.assertIn(FERRAMENTA, SYSTEM_PROMPT)
        self.assertIn("só leitura", SYSTEM_PROMPT.lower().replace("é só leitura", "só leitura"))

    def test_grupo_backups_pega_backup_e_backups(self) -> None:
        for pergunta in ("tem backup em Cascavel?", "quais Backups temos?", "o bkp de Londrina está livre?", PERGUNTA):
            with self.subTest(pergunta=pergunta):
                self.assertIn("backups", grupos_da_mensagem(pergunta))
                self.assertIn(FERRAMENTA, [s["function"]["name"] for s in schemas_para_mensagem(pergunta)])
        for pergunta in ("quantos notebooks temos?", "registre a transferência da ABC123"):
            with self.subTest(pergunta=pergunta):
                self.assertNotIn("backups", grupos_da_mensagem(pergunta))
        # Com outro grupo reconhecido, a ferramenta fica de fora; sem nenhum grupo, o Assistente recebe todas as ferramentas.
        self.assertNotIn(FERRAMENTA, [s["function"]["name"] for s in schemas_para_mensagem("registre a transferência da ABC123")])

    def test_resultado_traz_so_a_lista_de_campos_permitidos(self) -> None:
        painel = self.client.get("/api/painel").json()["backups_regionais"]
        resultado = self.executar()
        self.assertEqual(
            set(resultado),
            {
                "gerado_em", "minimo", "fontes", "limitacoes", "pendencias", "prioritarias", "sobras", "sobras_omitidas",
                "outras_candidatos", "outras_candidatos_omitidas",
            },
        )
        self.assertEqual(
            [g["cidade"] for g in resultado["outras_candidatos"]], [g["cidade"] for g in painel["outras_candidatos"]]
        )
        for grupo in resultado["outras_candidatos"]:
            self.assertEqual(set(grupo), {"cidade", "candidatos", "candidatos_omitidos"})
            for candidato in grupo["candidatos"]:
                self.assertEqual(set(candidato), {"serie", "motivo", "dias_sem_verificacao"})
        self.assertEqual(resultado["gerado_em"], painel["gerado_em"])
        self.assertEqual(resultado["fontes"], painel["fontes"])
        self.assertEqual([g["cidade"] for g in resultado["prioritarias"]], [g["cidade"] for g in painel["prioritarias"]])
        for grupo in resultado["prioritarias"]:
            self.assertEqual(set(grupo), {
                "cidade", "status", "contados", "minimo", "excedente", "backups", "backups_omitidos",
                "candidatos", "candidatos_omitidos", "conferencia", "excluidos",
            })
            self.assertEqual(set(grupo["conferencia"]), {"total", "por_motivo"})
            self.assertEqual(set(grupo["excluidos"]), {"total", "por_motivo"})
            for candidato in grupo["candidatos"]:
                self.assertEqual(set(candidato), {"serie", "motivo", "dias_sem_verificacao"})
            for backup in grupo["backups"]:
                self.assertEqual(set(backup), {"serie", "origem", "ultima_verificacao", "confirmado_ate"})

    def test_cenario_cidade_a_cidade(self) -> None:
        resultado = self.executar()
        cascavel = self.regional(resultado, "Cascavel")
        self.assertEqual((cascavel["status"], cascavel["contados"], cascavel["minimo"]), ("conferir", 0, 1))
        self.assertEqual([(c["serie"], c["motivo"]) for c in cascavel["candidatos"]], [("NB1", "ausente_no_endpoint")])
        self.assertEqual(cascavel["excluidos"], {"total": 1, "por_motivo": {"usuario_vigente": 1}})  # NB7: o login pesou no cálculo
        londrina = self.regional(resultado, "Londrina")
        self.assertEqual((londrina["status"], londrina["contados"], londrina["excedente"]), ("ok", 1, 0))
        self.assertEqual([(b["serie"], b["origem"]) for b in londrina["backups"]], [("NB2", "marca")])
        self.assertIsNotNone(londrina["backups"][0]["ultima_verificacao"])
        pato = self.regional(resultado, "Pato Branco")
        self.assertEqual(pato["status"], "sem_backup")
        self.assertEqual(pato["excluidos"], {"total": 1, "por_motivo": {"usuario_vigente": 1}})
        maringa = self.regional(resultado, "Maringá")
        self.assertEqual(maringa["conferencia"], {"total": 1, "por_motivo": {"cidade_divergente": 1}})
        self.assertEqual(self.regional(resultado, "Ponta Grossa")["status"], "sem_backup")
        self.assertEqual(
            resultado["outras_candidatos"],
            [{"cidade": "Curitiba", "candidatos": [{"serie": "NB8", "motivo": "ausente_no_endpoint", "dias_sem_verificacao": None}],
              "candidatos_omitidos": 0}],
        )
        self.assertEqual(resultado["pendencias"], {"sem_backup": ["Pato Branco", "Maringá", "Ponta Grossa"], "conferir": ["Cascavel"]})

    def test_sem_nome_de_pessoa_em_nenhum_caminho(self) -> None:
        bruto = json.dumps(self.client.get("/api/painel").json(), ensure_ascii=False)
        self.assertIn(NOME_APELIDO, bruto)  # a tela recebe o apelido; a ferramenta não pode repassá-lo
        self.assertIn(NOME_OUTRA, bruto)
        self.assertIn(APELIDO_DIVERGENTE, bruto)
        for args in ({}, {"cidade": "Cascavel"}, {"cidade": "Maringá"}, {"cidade": "Curitiba"}):
            saida = json.dumps(self.executar(**args), ensure_ascii=False)
            for dado in (*NOMES, APELIDO_DIVERGENTE, "apelido", "conferencia\": [", "usuario_atual"):
                self.assertNotIn(dado, saida, args)
        painel = json.dumps(self.api.obter_painel(), ensure_ascii=False)
        for dado in (*NOMES, APELIDO_DIVERGENTE, "apelido", "candidatos", "prioritarias"):
            self.assertNotIn(dado, painel)

    def test_login_do_endpoint_entra_no_calculo_mas_nao_sai(self) -> None:
        # O login existe no dado bruto do Endpoint e muda o resultado (NB7 vira "usuario_vigente")...
        self.assertIn(NOME_LOGIN, json.dumps(self.endpoint, default=str))
        # ...mas nenhuma saída o repassa: nem o painel da tela, nem a ferramenta, nem o painel do Assistente.
        painel = json.dumps(self.client.get("/api/painel").json(), ensure_ascii=False)
        self.assertNotIn(NOME_LOGIN, painel)
        self.assertNotIn("joao", painel)
        saidas = [self.executar(**args) for args in ({}, {"cidade": "Cascavel"}, {"cidade": "Curitiba"})]
        saidas.append(self.api.obter_painel())
        for saida in saidas:
            self.assertNotIn(NOME_LOGIN, json.dumps(saida, ensure_ascii=False))
        modelo = FakeModel(calls(call(FERRAMENTA)), calls(call("obter_painel")), text("Ok."))
        AssistantConversation(modelo, self.api, "modelo-teste").enviar_mensagem(PERGUNTA)
        self.assertEqual(len(modelo.sent), 3)
        self.assertNotIn(NOME_LOGIN, json.dumps(modelo.sent, ensure_ascii=False))

    def test_conversa_nao_manda_nome_ao_modelo(self) -> None:
        modelo = ModeloComFerramentas(
            calls(call(FERRAMENTA, cidade="Cascavel")),
            calls(call("obter_painel")),
            text("Cascavel tem 1 candidato a backup para conferir."),
        )
        conversa = AssistantConversation(modelo, self.api, "modelo-teste")
        resposta = conversa.enviar_mensagem(PERGUNTA)
        self.assertEqual(resposta.ferramentas, [FERRAMENTA, "obter_painel"])
        self.assertIsNone(resposta.pendente)
        self.assertIn(FERRAMENTA, modelo.ferramentas[0])
        enviado = json.dumps(modelo.sent, ensure_ascii=False)
        for dado in (*NOMES, APELIDO_DIVERGENTE):
            self.assertNotIn(dado, enviado)
        resultado = json.loads(abrir(modelo.sent[1][-1]["content"]))
        self.assertEqual([g["cidade"] for g in resultado["prioritarias"]], ["Cascavel"])
        painel = json.loads(abrir(modelo.sent[2][-1]["content"]))
        self.assertEqual(painel["dados"]["backups_regionais"], AVISO_BACKUPS_NO_PAINEL)

    def test_obter_painel_troca_o_campo_pelo_aviso(self) -> None:
        resultado = self.api.obter_painel()
        self.assertEqual(resultado["dados"]["backups_regionais"], AVISO_BACKUPS_NO_PAINEL)
        self.assertIn(FERRAMENTA, AVISO_BACKUPS_NO_PAINEL)
        self.assertTrue(resultado["dados"]["base_importada"])  # o resto do painel continua igual
        self.assertEqual(resultado["dados"]["total_equipamentos"], len(self.equipamentos))

    def test_filtro_de_cidade_sem_acento_e_sem_caixa(self) -> None:
        resultado = self.executar(cidade="maringa")
        self.assertEqual([g["cidade"] for g in resultado["prioritarias"]], ["Maringá"])
        self.assertEqual(resultado["pendencias"], {"sem_backup": ["Maringá"], "conferir": []})
        fora = self.executar(cidade="Curitiba")
        self.assertEqual(fora["prioritarias"], [])
        self.assertIn("não quer dizer que não há notebook de backup", fora["mensagem"])
        # Cidade fora das cinco: os candidatos dela aparecem em outras_candidatos, sem apelido; os de outras cidades ficam de fora.
        self.assertEqual([g["cidade"] for g in fora["outras_candidatos"]], ["Curitiba"])
        self.assertEqual([c["serie"] for c in fora["outras_candidatos"][0]["candidatos"]], ["NB8"])
        self.assertNotIn("apelido", json.dumps(fora))
        self.assertEqual(self.executar(cidade="curitiba")["outras_candidatos"], fora["outras_candidatos"])
        self.assertEqual(self.executar(cidade="Cascavel")["outras_candidatos"], [])
        self.assertEqual([g["cidade"] for g in self.executar()["outras_candidatos"]], ["Curitiba"])
        self.assertEqual(fora["cidades_prioritarias"], ["Cascavel", "Londrina", "Pato Branco", "Maringá", "Ponta Grossa"])

    def test_listas_cortam_em_20_com_omitidos(self) -> None:
        self.equipamentos = [notebook(f"NB{n:03d}", "Cascavel") for n in range(MAX_ITENS_LISTA + 5)]
        cascavel = self.regional(self.executar(), "Cascavel")
        self.assertEqual(len(cascavel["candidatos"]), MAX_ITENS_LISTA)
        self.assertEqual(cascavel["candidatos_omitidos"], 5)

    def test_outras_candidatos_cortam_cidades_e_candidatos_em_20(self) -> None:
        self.equipamentos = [notebook(f"NC{n:03d}", "Curitiba") for n in range(MAX_ITENS_LISTA + 5)]
        self.equipamentos += [notebook(f"ND{n:03d}", f"Zona {n:02d}") for n in range(MAX_ITENS_LISTA + 2)]
        resultado = self.executar()
        self.assertEqual(len(resultado["outras_candidatos"]), MAX_ITENS_LISTA)
        self.assertEqual(resultado["outras_candidatos_omitidas"], 3)  # 23 cidades (Curitiba + 22), 20 no resultado
        curitiba = next(g for g in resultado["outras_candidatos"] if g["cidade"] == "Curitiba")
        self.assertEqual(len(curitiba["candidatos"]), MAX_ITENS_LISTA)
        self.assertEqual(curitiba["candidatos_omitidos"], 5)
        filtrado = self.executar(cidade="Curitiba")
        self.assertEqual((len(filtrado["outras_candidatos"]), filtrado["outras_candidatos_omitidas"]), (1, 0))

    def test_dados_insuficientes_nao_vira_sem_backup(self) -> None:
        self.endpoint = {"available": False}
        self.equipamentos = [notebook("NB9", "Curitiba")]  # sem candidata nas regionais: sem fonte, não há como afirmar falta
        resultado = self.executar()
        self.assertEqual(resultado["fontes"]["endpoint"], "indisponivel")
        self.assertEqual({g["status"] for g in resultado["prioritarias"]}, {"dados_insuficientes"})
        self.assertEqual(resultado["pendencias"], {"sem_backup": [], "conferir": []})
        self.assertIn("Endpoint indisponível: uso recente não conferido.", resultado["limitacoes"])

    def test_erro_sem_numeros(self) -> None:
        def quebrado() -> Dict[str, Any]:
            raise RuntimeError("falha inesperada")

        for servico in (quebrado, None):
            with self.subTest(servico=getattr(servico, "__name__", servico)):
                self.client = self.montar_cliente(servico)
                resultado = self.executar()
                self.assertEqual(set(resultado), {"erro"})
                self.assertIn("Não há números para informar", resultado["erro"])
        falha = SimpressApi(lambda *args: (503, {"detail": {"mensagem": "indisponível"}}))
        resultado = TOOLS[FERRAMENTA].run(falha, {})
        self.assertEqual(set(resultado), {"erro"})
        self.assertTrue(resultado["erro"].startswith("Erro 503 do Simpress: "), resultado["erro"])

    def test_so_leitura_arquivos_de_estado_nao_mudam(self) -> None:
        self.state.parent.mkdir(parents=True, exist_ok=True)
        confirmacao = {
            "serie": "NB1", "cidade": "Cascavel",
            "confirmado_em": "2026-11-12T10:00:00-03:00", "expira_em": "2026-11-19T10:00:00-03:00",
        }
        self.state.write_text(json.dumps({"esquema": 1, "confirmacoes": [confirmacao]}), encoding="utf-8")

        def retrato() -> Dict[str, str]:
            return {
                str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(self.root.rglob("*")) if p.is_file()
            }

        antes = retrato()
        self.assertEqual(self.regional(self.executar(), "Cascavel")["backups"][0]["origem"], "confirmacao")
        self.executar(cidade="Cascavel")
        self.executar(cidade="Curitiba")
        self.api.obter_painel()
        self.assertEqual(retrato(), antes)


if __name__ == "__main__":
    unittest.main()
