import tempfile
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.coverage import Manutencao
from domains.effective_alias import build_endpoint_alias_index
from routers.backups_regionais import (
    LIMITACAO_CONFIRMACOES,
    LIMITACAO_CONFIRMACOES_INDISPONIVEIS,
    BackupsRegionaisServices,
    ler_painel_backups,
)
from routers.dashboard import DashboardServices, create_dashboard_router

CATEGORIES = ({"value": "notebook", "label": "Notebooks"}, {"value": "monitor", "label": "Monitores"})


def categorize(tipo, modelo):
    text = f"{tipo} {modelo}".upper()
    if "MONITOR" in text:
        return "monitor"
    if "NOTEBOOK" in text:
        return "notebook"
    return ""


AGORA = datetime(2026, 11, 12, 12, 0, tzinfo=timezone(timedelta(hours=-3)))
REGIONAIS = ["Cascavel", "Londrina", "Pato Branco", "Maringá", "Ponta Grossa"]


def make_client(equipment, events, stats=None, backups=None):
    router, _ = create_dashboard_router(DashboardServices(
        get_backups_regionais=backups,
        get_equipment=lambda: equipment,
        get_stats=lambda: stats if stats is not None else {"total_unidades": 4, "ultima_atualizacao": "01/01/2026 10:00"},
        get_comparison_events=events if callable(events) else (lambda: events),
        categories=CATEGORIES,
        categorize=categorize,
    ))
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class DashboardRouteTests(unittest.TestCase):
    def test_empty_base(self):
        data = make_client([], []).get("/api/painel").json()
        self.assertFalse(data["base_importada"])
        self.assertEqual(data["total_equipamentos"], 0)
        self.assertIsNone(data["ultima_comparacao"])
        self.assertEqual([c["total"] for c in data["por_categoria"]], [0, 0])

    def test_counts_cities_and_categories(self):
        equipment = [
            {"tipo": "Notebook", "modelo": "A", "retirada_cidade": "Curitiba"},
            {"tipo": "Notebook", "modelo": "B", "retirada_cidade": "Curitiba"},
            {"tipo": "Monitor", "modelo": "C", "retirada_cidade": "Londrina"},
            {"tipo": "Mouse", "modelo": "D", "retirada_cidade": ""},
        ]
        data = make_client(equipment, []).get("/api/painel").json()
        self.assertEqual(data["total_equipamentos"], 4)
        self.assertEqual({c["value"]: c["total"] for c in data["por_categoria"]}, {"notebook": 2, "monitor": 1})
        self.assertEqual(data["sem_categoria"], 1)
        self.assertEqual(data["sem_cidade"], 1)
        self.assertEqual(data["total_cidades"], 2)
        self.assertEqual(data["cidades_principais"][0], {"cidade": "Curitiba", "total": 2})
        self.assertEqual(data["total_unidades"], 4)
        self.assertEqual(data["cidades_por_categoria"], {
            "notebook": [{"cidade": "Curitiba", "total": 2}],
            "monitor": [{"cidade": "Londrina", "total": 1}],
        })

    def test_latest_comparison_lists_only_attention_items(self):
        events = [{"id": "e1", "horario": "2026-01-01T10:00:00", "tipo": "atualizacao",
                   "resumo": {"divergencias_local": 3, "sem_acesso_7_dias": 0, "ausentes_no_endpoint": "2"},
                   "comparacao": {"ausentes_no_endpoint": [{"serie": "N-1"}, {"serie": "N-2"}]}}]
        equipment = [{"serial": "N-1", "tipo": "Notebook"}, {"serial": "N-2", "tipo": "Notebook"}]
        latest = make_client(equipment, events).get("/api/painel").json()["ultima_comparacao"]
        self.assertEqual(latest["id"], "e1")
        self.assertEqual([(i["campo"], i["total"]) for i in latest["atencao"]],
                         [("divergencias_local", 3), ("ausentes_no_endpoint", 2)])

    def test_endpoint_absences_count_only_notebooks_and_macbooks(self):
        equipment = [
            {"serial": "N-1", "tipo": "Notebook", "modelo": "A"},
            {"serial": "M-1", "tipo": "Notebook", "modelo": "MacBook Air"},
            {"serial": "MON-1", "tipo": "Monitor", "modelo": "C"},
        ]
        events = [{"id": "e1", "horario": "2026-01-01T10:00:00", "tipo": "atualizacao",
                   "resumo": {"ausentes_no_endpoint": 4},
                   "comparacao": {"ausentes_no_endpoint": [
                       {"serie": "N-1"}, {"serie": "M-1 / X-9"}, {"serie": "MON-1"}, {"serie": ""}]}}]
        latest = make_client(equipment, events).get("/api/painel").json()["ultima_comparacao"]
        self.assertEqual([(i["campo"], i["total"]) for i in latest["atencao"]], [("ausentes_no_endpoint", 2)])
        self.assertIn("somente Notebooks e MacBooks", latest["atencao"][0]["rotulo"])

    def test_history_failure_does_not_break_panel(self):
        def broken():
            raise RuntimeError("boom")
        response = make_client([{"tipo": "Notebook"}], broken).get("/api/painel")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["ultima_comparacao"])


class DashboardBackupsRegionaisTests(unittest.TestCase):
    """``backups_regionais`` do painel: entradas isoladas, independente do histórico e nunca 500."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "backups_regionais.json"

    def services(self, **mudancas):
        base = dict(
            state_file=lambda: self.state,
            transaction_root=lambda: self.root,
            equipamentos=lambda: None,
            endpoint=lambda: {"available": False},
            estado_cobertura=lambda: {"disponibilidade": {}, "reservas": {}, "movimentacoes": {}, "devolucoes": {}},
            manutencao=lambda: Manutencao(),
            agora=lambda: AGORA,
        )
        base.update(mudancas)
        return BackupsRegionaisServices(**base)

    def painel(self, services, equipment=(), events=()):
        client = make_client(list(equipment), list(events), backups=lambda: ler_painel_backups(services))
        return client.get("/api/painel")

    def test_sem_base_o_campo_existe_com_as_cinco_regionais_sem_dados(self):
        resposta = self.painel(self.services())
        self.assertEqual(resposta.status_code, 200)
        campo = resposta.json()["backups_regionais"]
        self.assertEqual([c["cidade"] for c in campo["prioritarias"]], REGIONAIS)
        self.assertEqual({c["status"] for c in campo["prioritarias"]}, {"dados_insuficientes"})
        self.assertIs(campo["fontes"]["cadastro"], False)

    def test_sem_servico_o_campo_e_nulo(self):
        data = make_client([], []).get("/api/painel").json()
        self.assertIn("backups_regionais", data)
        self.assertIsNone(data["backups_regionais"])

    def test_endpoint_indisponivel_ou_com_erro_vira_fonte_indisponivel(self):
        def quebrado():
            raise RuntimeError("falha do Endpoint")

        for endpoint in (lambda: {"available": False}, quebrado):
            with self.subTest(endpoint=endpoint.__name__):
                resposta = self.painel(self.services(endpoint=endpoint))
                self.assertEqual(resposta.status_code, 200)
                campo = resposta.json()["backups_regionais"]
                self.assertEqual(campo["fontes"]["endpoint"], "indisponivel")
                self.assertIn("Endpoint indisponível: uso recente não conferido.", campo["limitacoes"])

    def test_cada_entrada_com_erro_e_isolada_e_nunca_derruba_o_painel(self):
        def quebrado():
            raise RuntimeError("falha de leitura")

        casos = {
            "equipamentos": ("cadastro", False),
            "estado_cobertura": ("cobertura", "ilegivel"),
            "manutencao": ("manutencao_verificada", False),
        }
        for entrada, (fonte, esperado) in casos.items():
            with self.subTest(entrada=entrada):
                resposta = self.painel(self.services(**{entrada: quebrado}))
                self.assertEqual(resposta.status_code, 200)
                self.assertEqual(resposta.json()["backups_regionais"]["fontes"][fonte], esperado)

    def test_confirmacoes_ilegiveis_viram_limitacao_sem_500_e_arquivo_preservado(self):
        self.state.write_text("{ isto não é json", encoding="utf-8")
        resposta = self.painel(self.services())
        self.assertEqual(resposta.status_code, 200)
        campo = resposta.json()["backups_regionais"]
        self.assertEqual(campo["fontes"]["confirmacoes"], "ilegivel")
        self.assertIn(LIMITACAO_CONFIRMACOES, campo["limitacoes"])
        self.assertEqual(self.state.read_text(encoding="utf-8"), "{ isto não é json")

    def test_falha_passageira_ao_ler_confirmacoes_vira_indisponivel_e_nao_ilegivel(self):
        self.state.write_text('{"esquema": 1, "confirmacoes": []}', encoding="utf-8")
        with mock.patch("pathlib.Path.read_text", side_effect=PermissionError("C:/Users/pessoa/arquivo.json")):
            with self.assertLogs("routers.backups_regionais", level="WARNING") as logs:
                campo = ler_painel_backups(self.services())
        self.assertEqual(campo["fontes"]["confirmacoes"], "indisponivel")
        self.assertIn(LIMITACAO_CONFIRMACOES_INDISPONIVEIS, campo["limitacoes"])
        self.assertNotIn(LIMITACAO_CONFIRMACOES, campo["limitacoes"])
        self.assertFalse(any("pessoa" in linha for linha in logs.output))

    def test_confirmacoes_lidas_marcam_fonte_ok_sem_limitacao(self):
        campo = self.painel(self.services()).json()["backups_regionais"]
        self.assertEqual(campo["fontes"]["confirmacoes"], "ok")
        self.assertNotIn(LIMITACAO_CONFIRMACOES, campo["limitacoes"])

    def test_log_traz_so_a_classe_do_erro(self):
        def quebrado():
            raise RuntimeError("/caminho/secreto/data/state com dado")

        with self.assertLogs("routers.backups_regionais", level="WARNING") as capturado:
            self.painel(self.services(endpoint=quebrado))
        texto = " ".join(capturado.output)
        self.assertIn("RuntimeError", texto)
        self.assertNotIn("secreto", texto)

    def test_independe_do_evento_historico(self):
        def notebook(serie, cidade):
            return {
                "serial": serie, "tipo": "NOTEBOOK", "modelo": "Latitude 5440", "retirada_cidade": cidade,
                "_apelido_base": "", "apelido": "", "_apelido_manual_override": False, "serie_detalhes_duplicada": False,
            }

        # Cadastro sintético: NB2 é backup contado em Londrina (marca BACKUPLONDRINA02, verificada há 1 dia); NB1 é candidata em Cascavel.
        indice = build_endpoint_alias_index([{
            "SERIAL": "NB2", "NOMEDOCOMPUTADOR": "BACKUPLONDRINA02", "USUARIOSLOGADOS": "",
            "ULTIMAVERIFICACAOCOMEXITO": (AGORA - timedelta(days=1)).isoformat(),
        }])
        indice["manual_users"] = {}
        indice["user_holds"] = {}
        completo = [notebook("NB1", "Cascavel"), notebook("NB2", "Londrina")]
        sem_backup = [notebook("NB1", "Cascavel")]
        eventos_a = [{"id": "e1", "horario": "2026-01-01T10:00:00", "tipo": "atualizacao", "resumo": {"divergencias_local": 3}}]
        eventos_b = [{"id": "e2", "horario": "2026-02-01T10:00:00", "tipo": "atualizacao", "resumo": {"divergencias_local": 9}}]

        def campo(cadastro, equipment, events):
            services = self.services(equipamentos=lambda: cadastro, endpoint=lambda: indice)
            return self.painel(services, equipment, events).json()

        a = campo(completo, [{"tipo": "Notebook"}], eventos_a)
        b = campo(completo, [], eventos_b)
        regional = {g["cidade"]: g for g in a["backups_regionais"]["prioritarias"]}
        self.assertEqual(regional["Londrina"]["contados"], 1)  # o campo não está vazio: há backup contado e candidato
        self.assertEqual([c["serie"] for c in regional["Cascavel"]["candidatos"]], ["NB1"])
        # (a) histórico e eventos diferentes, mesmo cadastro e mesmo `agora`: o campo é idêntico.
        self.assertNotEqual(a["ultima_comparacao"], b["ultima_comparacao"])
        self.assertEqual(a["backups_regionais"], b["backups_regionais"])
        # (b) mesmo histórico, cadastro diferente: o campo muda.
        c = campo(sem_backup, [{"tipo": "Notebook"}], eventos_a)
        self.assertEqual(a["ultima_comparacao"], c["ultima_comparacao"])
        self.assertNotEqual(a["backups_regionais"], c["backups_regionais"])
        self.assertEqual({g["cidade"]: g["contados"] for g in c["backups_regionais"]["prioritarias"]}["Londrina"], 0)

    def test_servico_que_levanta_devolve_objeto_minimo_e_o_painel_segue(self):
        def quebrado():
            raise RuntimeError("falha inesperada")

        client = make_client([{"tipo": "Notebook"}], [], backups=quebrado)
        resposta = client.get("/api/painel")
        self.assertEqual(resposta.status_code, 200)
        dados = resposta.json()
        self.assertTrue(dados["base_importada"])
        self.assertEqual(set(dados["backups_regionais"]), {"fontes", "limitacoes", "indisponivel"})
        self.assertIs(dados["backups_regionais"]["indisponivel"], True)
        self.assertEqual(dados["backups_regionais"]["fontes"], {})
        self.assertTrue(dados["backups_regionais"]["limitacoes"])


if __name__ == "__main__":
    unittest.main()
