"""response_model de painel, equipamento e automação não pode cortar, converter nem acrescentar campo.

Rotas que filtram (devolvem dict): o corpo HTTP tem de ser igual ao do serviço, campo a campo (``_x``, camelCase,
tipos "estranhos" que o pydantic converteria). Rotas que devolvem JSONResponse passam direto; o modelo só documenta,
então o teste confere ida e volta contra a saída real do domínio. Só dados sintéticos e pastas temporárias.
"""

import io
import json
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
from fastapi.testclient import TestClient

from domains import equipment_edit, inventory_state
from domains.dashboard_agendamento import AgendadorDashboard
from domains.sebrae_agendamento import FUSO, AgendadorSebrae, caminhos_padrao
from routers import automation
from routers.automation import AutomationRouteServices, create_automation_router
from routers.dashboard import DashboardServices, create_dashboard_router, build_dashboard
from routers.equipment import EquipmentRouteServices, create_equipment_router
from test_chrome_automation import RunnerHarness
from test_dashboard import AGORA, CATEGORIES, categorize


def mesmo_json(teste, obtido, esperado):
    """Igualdade que distingue 1 de 1.0 e de True (assertEqual do Python não distingue)."""
    teste.assertEqual(json.dumps(obtido, sort_keys=True), json.dumps(jsonable_encoder(esperado), sort_keys=True))


def client_para(router):
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class PainelTests(unittest.TestCase):
    def test_corpo_igual_ao_do_domínio_com_todos_os_blocos(self):
        equipment_rows = [
            {"serial": "S1", "tipo": "Notebook", "modelo": "X", "retirada_cidade": "Cidade A"},
            {"serial": "S2", "tipo": "Monitor", "modelo": "Y", "retirada_cidade": ""},
            "linha estranha",
        ]
        evento = {
            "id": "e1", "horario": "2026-11-12T10:00:00", "tipo": "importacao",
            "resumo": {"divergencias_local": 2}, "comparacao": {"divergencias_local": [1, 2, 3], "ausentes_no_endpoint": []},
        }
        servicos = DashboardServices(
            get_equipment=lambda: equipment_rows,
            get_stats=lambda: {"total_unidades": 7, "ultima_atualizacao": "01/01/2026 10:00", "arquivo_origem": "a.xlsx"},
            get_comparison_events=lambda: [evento],
            get_comparison_history=lambda: [evento],
            get_details_file=lambda: Path("inexistente.xlsx"),
            get_other_technician_marks=lambda: [{"chamado": "UTIC-2026-1", "serie": "S1", "os": 5, "motivo": "m", "_x": 1}],
            get_softexpert_finalization_failures=lambda: {"total": 1, "itens": [{"chamado": "c", "_oculto": True}], "extra": 1.0},
            get_backups_regionais=lambda: {"fontes": {"a": 1.0}, "limitacoes": [], "_k": 0},
            get_lembretes_agendados=lambda: {"atrasados": 1, "hoje": 2},
            categories=CATEGORIES,
            categorize=categorize,
            now=lambda: AGORA,
        )
        esperado = jsonable_encoder(build_dashboard(servicos))
        router, _ = create_dashboard_router(servicos)
        resposta = client_para(router).get("/api/painel")
        self.assertEqual(resposta.status_code, 200)
        mesmo_json(self, resposta.json(), esperado)
        self.assertIsNotNone(esperado["ultima_comparacao"])
        self.assertIn("lembretes_agendados", esperado)

    def test_base_vazia_e_blocos_opcionais_ausentes_continuam_iguais(self):
        servicos = DashboardServices(
            get_equipment=lambda: [], get_stats=lambda: None, get_comparison_events=lambda: [],
            categories=CATEGORIES, categorize=categorize,
        )
        esperado = jsonable_encoder(build_dashboard(servicos))
        router, _ = create_dashboard_router(servicos)
        mesmo_json(self, client_para(router).get("/api/painel").json(), esperado)


EQUIPAMENTO = {
    "serial": "SINT-001", "modelo": "Modelo", "tipo": "Notebook", "apelido": "host-1", "idCliente": "123",
    "revisao": "r" * 64, "_revisao": "r" * 64, "_source_file": "x.xlsx", "retirada_cidade": "Cidade A",
    "descricao_sugerida": 1.0, "flag": 0, "quantidade": "3", "data": "2026-01-02", "vazio": None,
    "contrato": {"a": [1, 2.0]}, "campo_novo": True,
}


class EquipamentoTests(unittest.TestCase):
    def setUp(self):
        self.servicos = EquipmentRouteServices(
            edit=None,  # type: ignore[arg-type]
            public_equipment=lambda item: deepcopy(EQUIPAMENTO),
            validate_json_object=lambda valor, nome: valor,
            build_export=lambda: None,  # type: ignore[arg-type,return-value]
        )
        router, _ = create_equipment_router(self.servicos)
        self.client = client_para(router)

    def test_get_devolve_o_dict_do_servico_sem_cortar_nem_converter(self):
        with patch.dict(inventory_state.equipamentos_cache, {"SINT-001": {"serial": "SINT-001"}}, clear=False):
            resposta = self.client.get("/api/equipamento/sint-001")
        self.assertEqual(resposta.status_code, 200)
        mesmo_json(self, resposta.json(), EQUIPAMENTO)

    def test_get_sem_campos_opcionais_nao_cria_null(self):
        minimo = {"serial": "SINT-002", "modelo": "M"}
        servicos = EquipmentRouteServices(
            edit=None, public_equipment=lambda item: dict(minimo),  # type: ignore[arg-type]
            validate_json_object=lambda v, n: v, build_export=lambda: None,  # type: ignore[arg-type,return-value]
        )
        router, _ = create_equipment_router(servicos)
        with patch.dict(inventory_state.equipamentos_cache, {"SINT-002": {"serial": "SINT-002"}}, clear=False):
            mesmo_json(self, client_para(router).get("/api/equipamento/SINT-002").json(), minimo)

    def test_salvar_devolve_o_corpo_completo(self):
        with patch.object(equipment_edit, "save_equipment_to_excel", return_value=({"serial": "SINT-009"}, 2)):
            resposta = self.client.post("/api/equipamento/salvar", json={"serial": "SINT-009", "novo": True})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        mesmo_json(self, resposta.json(), {
            "sucesso": True,
            "mensagem": "Equipamento SINT-009 atualizado com sucesso no site e na planilha Excel!",
            "equipamento": EQUIPAMENTO,
            "total_modificados": 2,
        })


class AutomacaoFiltroTests(unittest.TestCase):
    ESTADO = {
        "estado": "em_andamento", "rotina": "os", "inicio": "2026-10-20T08:00:00", "origem": "externo", "pid": 12.0,
        "cancelamento_pedido": 0, "aguardando_login": 1, "login_origem": "UX",
        "log": {"arquivo": "a.log", "offset": 10.0, "linhas": ["a", "b"], "reiniciado": 0, "_x": 1},
        "ultima": {
            "id": "i", "rotina": "os", "origem": "site", "inicio": "", "fim": "", "status": "concluido", "codigo": 0,
            "mensagem": "", "lotes": [{"id": "1", "status": "ok", "n": 1.0}], "capturas": [{"nome": "c.png", "url": "/u"}], "log": "a.log",
            "extra": [1],
        },
        "novo": {"k": 1.0},
    }

    class Runner:
        def __init__(self, estado):
            self.estado = estado

        def start(self, rotina):
            return deepcopy(self.estado)

        def start_ux_alias(self, nome, conteudo):
            return deepcopy(self.estado)

        def cancel(self):
            return {"metodo": "sinal", "mensagem": "m", "estado": deepcopy(self.estado), "extra": 1.0}

    def setUp(self):
        runner = self.Runner(self.ESTADO)
        router = create_automation_router(AutomationRouteServices(runner=lambda: runner, sebrae=lambda: None))  # type: ignore[arg-type,return-value]
        self.client = client_para(router)

    def test_executar_ux_apelidos_e_cancelar_mantem_o_corpo(self):
        esperado = self.ESTADO
        resposta = self.client.post("/api/automacao/executar", json={"rotina": "os"})
        self.assertEqual(resposta.status_code, 202)
        mesmo_json(self, resposta.json(), esperado)
        resposta = self.client.post("/api/automacao/cancelar")
        self.assertEqual(resposta.status_code, 202)
        mesmo_json(self, resposta.json(), {"metodo": "sinal", "mensagem": "m", "estado": self.ESTADO, "extra": 1.0})
        resposta = self.client.post(
            "/api/automacao/ux-apelidos", data={"confirmado": "true"},
            files={"file": ("a.xlsx", io.BytesIO(b"x"), "application/octet-stream")},
        )
        self.assertEqual(resposta.status_code, 202)
        mesmo_json(self, resposta.json(), esperado)

    def test_chave_aninhada_ausente_nao_vira_500_nem_null(self):
        parcial = deepcopy(self.ESTADO)
        del parcial["ultima"]["mensagem"]
        del parcial["log"]["offset"]
        runner = self.Runner(parcial)
        router = create_automation_router(AutomationRouteServices(runner=lambda: runner, sebrae=lambda: None))  # type: ignore[arg-type,return-value]
        cliente = client_para(router)
        for resposta in (
            cliente.post("/api/automacao/executar", json={"rotina": "os"}),
            cliente.post("/api/automacao/cancelar"),
        ):
            self.assertEqual(resposta.status_code, 202, resposta.text)
        resposta = cliente.post("/api/automacao/executar", json={"rotina": "os"})
        mesmo_json(self, resposta.json(), parcial)
        self.assertNotIn("mensagem", resposta.json()["ultima"])


class AutomacaoSomenteDocumentacaoTests(unittest.TestCase):
    """Saída real do domínio: o modelo declarado precisa descrevê-la sem perder nem acrescentar campo."""

    def ida_e_volta(self, modelo, saida):
        validado = modelo.model_validate(saida).model_dump(mode="json", exclude_unset=True)
        mesmo_json(self, validado, saida)

    def test_runner_em_todas_as_ramificacoes(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = RunnerHarness(Path(tmp))
            self.ida_e_volta(automation.EstadoAutomacao, h.runner.state())  # livre, sem histórico
            h.runner.start("os")
            h.append_log("linha 1\nlinha 2\n")
            self.ida_e_volta(automation.EstadoAutomacao, h.runner.state())  # em andamento
            h.finish(0)
            self.ida_e_volta(automation.EstadoAutomacao, h.runner.state())  # livre, com última
            h.runner.start("login")
            h.finish(1)
            # Registro do script (origem externa) com lote em dicionário, em texto e captura existente.
            log_dir = h.contract.log_dir
            (log_dir / "erro.png").write_bytes(b"png")
            (log_dir / "20261020_090000_sebrae.json").write_text(json.dumps({
                "rotina": "sebrae", "inicio": "2026-10-20T09:00:00", "fim": None, "status": "falha", "codigo": 3,
                "mensagem": "m", "lotes": [{"lote_id": 7, "estado": "x"}, "L2"], "capturas": ["erro.png", "nao.png"],
                "log": "20261020_090000_sebrae.log",
            }), encoding="utf-8")
            (log_dir / "20261020_090000_sebrae.log").write_text("a\nb\nc\n", encoding="utf-8")
            pagina = h.runner.history_page(10, 1)
            self.assertGreaterEqual(pagina["total"], 3)
            self.ida_e_volta(automation.HistoricoAutomacao, pagina)
            self.ida_e_volta(automation.HistoricoAutomacao, h.runner.history_page(1, 1, routine="inexistente"))
            self.ida_e_volta(automation.UltimasAutomacao, {"ultimas": h.runner.latest_by_routine(["os", "sebrae", "enviar"])})
            self.assertIsNone(h.runner.latest_by_routine(["enviar"])["enviar"])
            for entrada in pagina["execucoes"]:
                if entrada["log"] and (log_dir / entrada["log"]).is_file():
                    self.ida_e_volta(automation.LogExecucaoAutomacao, h.runner.execution_log(entrada["id"], 2))

    def test_agendamentos(self):
        with tempfile.TemporaryDirectory() as tmp:
            agora = datetime(2026, 11, 8, 23, 45, tzinfo=FUSO)
            sebrae = AgendadorSebrae(caminhos_padrao(Path(tmp)), lambda r: None, agora=lambda: agora, pronta=True)
            self.ida_e_volta(automation.ResumoSebrae, sebrae.resumo())
            self.ida_e_volta(automation.ResumoSebrae, sebrae.definir_ativo(True))
            dash = AgendadorDashboard(Path(tmp) / "dash.json", lambda r: None, agora=lambda: agora)
            self.ida_e_volta(automation.AgendamentoDashboardResumo, dash.resumo())
            self.ida_e_volta(automation.AgendamentoDashboardResumo, dash.definir_ativo(True, 60))
            agora += timedelta(minutes=61)
            dash.verificar()
            self.ida_e_volta(automation.AgendamentoDashboardResumo, dash.resumo())
            self.ida_e_volta(automation.AgendamentoDashboardResumo, dash.definir_ativo(False))


if __name__ == "__main__":
    unittest.main()
