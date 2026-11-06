"""Rotas /api/cobertura: cenário V1-V4, concorrência, rev, arquivados, divergência e estado ilegível.

Só dados sintéticos, pastas temporárias e data fixa injetada.
"""

import json
import tempfile
import threading
import unittest
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.coverage import Manutencao
from routers.coverage import CoverageServices, create_coverage_router

HOJE = date(2026, 11, 6)


class CoverageRouterTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "data" / "state" / "operacao_cobertura.json"
        self.archive = self.root / "data" / "state" / "operacao_cobertura_arquivados.json"
        self.hoje = HOJE
        self.manutencao = Manutencao()
        self.cadastro = [{"serial": "SINT-001", "retirada_cidade": "Cidade A", "apelido": "PRNOTE0001"}]
        router, self.exports = create_coverage_router(CoverageServices(
            state_file=lambda: self.state,
            archive_file=lambda: self.archive,
            transaction_root=lambda: self.root,
            hoje=lambda: self.hoje,
            agora=lambda: "2026-11-06T09:00:00-03:00",
            manutencao=lambda: self.manutencao,
            cadastro=lambda: self.cadastro,
        ))
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)

    def post(self, path, body, status=200):
        resposta = self.client.post(path, json=body)
        self.assertEqual(resposta.status_code, status, resposta.text)
        return resposta.json()

    def cenario(self):
        demanda = self.post("/api/cobertura/demandas", {"data": "2026-11-20", "cidade": "Cidade A", "quantidade": 4})
        self.post("/api/cobertura/disponibilidade", {"serie": "SINT-001", "estado": "disponivel"})
        self.post("/api/cobertura/disponibilidade", {"serie": "SINT-002", "estado": "disponivel", "cidade": "Cidade A"})
        devolucao = self.post("/api/cobertura/devolucoes", {"serie": "SINT-003", "data_prevista": "2026-11-15", "cidade": "Cidade A"})
        return demanda, devolucao

    def leitura(self):
        resposta = self.client.get("/api/cobertura")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()

    def test_cenario_v1_v4(self):
        demanda, _ = self.cenario()
        esperado = [("atendivel", "SINT-001"), ("atendivel", "SINT-002"), ("condicionada", "SINT-003"), ("sem_cobertura", None)]
        antes = self.leitura()
        self.assertEqual([(v["situacao"], v["serie"]) for v in antes["vagas"]], esperado)
        self.assertEqual([s["serie"] for s in antes["disponiveis"]], ["SINT-001", "SINT-002"])
        self.assertEqual(antes["casos"]["disponibilidade"]["SINT001"]["cidade"], "Cidade A")  # veio do cadastro

        self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001"})
        self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-002"})
        depois = self.leitura()
        self.assertEqual([(v["situacao"], v["serie"]) for v in depois["vagas"]], esperado)
        self.assertEqual(depois["disponiveis"], [])

        erro = self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001"}, 409)["detail"]
        self.assertEqual((erro["codigo"], erro["motivo"]), ("conflito_reserva", "reserva_ativa"))

    def test_duas_reservas_simultaneas_so_uma_grava(self):
        primeira = self.post("/api/cobertura/demandas", {"data": "2026-11-20", "cidade": "Cidade A", "quantidade": 1})
        segunda = self.post("/api/cobertura/demandas", {"data": "2026-11-21", "cidade": "Cidade A", "quantidade": 1})
        self.post("/api/cobertura/disponibilidade", {"serie": "SINT-001", "estado": "disponivel"})
        barreira = threading.Barrier(2)
        respostas = []

        def reservar(demanda_id):
            barreira.wait()
            respostas.append(self.client.post("/api/cobertura/reservas", json={"demanda_id": demanda_id, "serie": "SINT-001"}))

        threads = [threading.Thread(target=reservar, args=(d["id"],)) for d in (primeira, segunda)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        self.assertEqual(sorted(r.status_code for r in respostas), [200, 409])
        recusada = next(r for r in respostas if r.status_code == 409).json()["detail"]
        self.assertIn(recusada["codigo"], ("conflito_reserva", "arquivo_ocupado"))
        reservas = json.loads(self.state.read_text(encoding="utf-8"))["reservas"]
        self.assertEqual(len(reservas), 1)

    def test_rev_antigo_e_renovar_reserva_vencida(self):
        demanda, _ = self.cenario()
        reserva = self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001"})
        marcada = self.post(f"/api/cobertura/reservas/{reserva['id']}/kit", {"item": "notebook", "marcado": True, "rev": reserva["rev"]})
        erro = self.post(f"/api/cobertura/reservas/{reserva['id']}/cancelar", {"rev": reserva["rev"]}, 409)["detail"]
        self.assertEqual(erro["codigo"], "registro_alterado")

        self.hoje = HOJE + timedelta(days=8)
        leitura = self.leitura()
        self.assertEqual(leitura["reservas_vencidas"], [reserva["id"]])
        self.assertTrue(leitura["casos"]["reservas"][reserva["id"]]["vencida"])
        erro = self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001"}, 409)["detail"]
        self.assertEqual(erro["motivo"], "reserva_vencida_em_revisao")
        erro = self.post(f"/api/cobertura/reservas/{reserva['id']}/renovar", {"rev": marcada["rev"]}, 422)["detail"]
        self.assertEqual(erro["motivo"], "sem_disponibilidade")
        disponivel = leitura["casos"]["disponibilidade"]["SINT001"]
        self.post("/api/cobertura/disponibilidade", {"serie": "SINT-001", "estado": "disponivel", "rev": disponivel["rev"]})
        renovada = self.post(f"/api/cobertura/reservas/{reserva['id']}/renovar", {"rev": marcada["rev"]})
        self.assertEqual(renovada["valida_ate"], (self.hoje + timedelta(days=7)).isoformat())

    def test_devolucao_atrasada_e_cancelada_cancela_reserva_em_espera(self):
        demanda, devolucao = self.cenario()
        espera = self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "devolucao_id": devolucao["id"]})
        self.hoje = date(2026, 11, 18)
        caso = self.client.get(f"/api/cobertura/casos/{devolucao['id']}").json()
        self.assertEqual((caso["secao"], caso["registro"]["situacao"]), ("devolucoes", "atrasada"))
        reprogramada = self.post(f"/api/cobertura/devolucoes/{devolucao['id']}/reprogramar",
                                 {"rev": devolucao["rev"], "data_prevista": "2026-11-19"})
        self.post(f"/api/cobertura/devolucoes/{devolucao['id']}/cancelar", {"rev": reprogramada["rev"]})
        self.assertEqual(self.leitura()["casos"]["reservas"][espera["id"]]["estado"], "cancelada")

    def test_manutencao_422_e_chamado_ambiguo_nao_bloqueia(self):
        demanda, _ = self.cenario()
        self.manutencao = Manutencao(series=frozenset({"SINT001"}), sinais=frozenset({"SINT002"}))
        erro = self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001"}, 422)["detail"]
        self.assertEqual((erro["codigo"], erro["motivo"]), ("serie_indisponivel", "manutencao"))
        self.assertEqual(self.leitura()["disponiveis"][0]["sinal"], "Chamado possivelmente relacionado")
        self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-002"})

        self.manutencao = Manutencao(ilegivel=True)
        self.assertEqual(self.leitura()["manutencao"], {"verificada": False, "aviso": "Manutenção não verificada"})
        erro = self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001"}, 422)["detail"]
        self.assertEqual(erro["motivo"], "manutencao_nao_verificada")
        self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001", "manutencao_conferida": True})

    def test_serie_do_sebrae_fica_fora(self):
        erro = self.post("/api/cobertura/disponibilidade", {"serie": "BRJ142QKBQ", "estado": "disponivel", "cidade": "Cidade A"}, 422)
        self.assertEqual(erro["detail"]["motivo"], "fora_do_inventario")
        self.assertFalse(self.state.exists())

    def test_prnotesjp_conta_como_curitiba(self):
        self.cadastro = [{"serial": "SINT-007", "apelido": "PRNOTESJP0042", "retirada_cidade": "São José dos Pinhais"}]
        registro = self.post("/api/cobertura/disponibilidade", {"serie": "SINT-007", "estado": "disponivel"})
        self.assertEqual(registro["cidade"], "Curitiba")

    def test_movimentacao_preparada_retorna_campos_do_contrato(self):
        demanda, _ = self.cenario()
        reserva = self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001"})
        for item in ("notebook", "carregador", "preparacao"):
            reserva = self.post(f"/api/cobertura/reservas/{reserva['id']}/kit", {"item": item, "marcado": True, "rev": reserva["rev"]})
        mov = self.post("/api/cobertura/movimentacoes", {"reserva_id": reserva["id"], "rev": reserva["rev"]})
        self.assertEqual(set(mov), {"id", "serie", "destino_cidade", "chave", "rev"})
        self.assertEqual((mov["serie"], mov["destino_cidade"]), ("SINT-001", "Cidade A"))
        erro = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/estado", {"estado": "coletada", "rev": mov["rev"]}, 409)
        self.assertEqual(erro["detail"]["codigo"], "transicao_invalida")
        self.post(f"/api/cobertura/movimentacoes/{mov['id']}/estado", {"estado": "cancelada", "rev": mov["rev"]})
        self.assertEqual(self.leitura()["casos"]["reservas"][reserva["id"]]["estado"], "ativa")

    def semear_em_transito(self):
        """Movimentação já gerada pelo bloco 2 (registrar-transferencia), semeada direto no arquivo."""
        demanda, _ = self.cenario()
        reserva = self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001"})
        for item in ("notebook", "carregador", "preparacao"):
            reserva = self.post(f"/api/cobertura/reservas/{reserva['id']}/kit", {"item": item, "marcado": True, "rev": reserva["rev"]})
        mov = self.post("/api/cobertura/movimentacoes", {"reserva_id": reserva["id"], "rev": reserva["rev"]})
        estado = json.loads(self.state.read_text(encoding="utf-8"))
        estado["movimentacoes"][mov["id"]]["estado"] = "gerada"
        self.state.write_text(json.dumps(estado), encoding="utf-8")
        for proximo in ("coletada", "em_transito"):
            mov = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/estado", {"estado": proximo, "rev": mov["rev"]})
        return demanda, mov

    def divergente(self):
        demanda, mov = self.semear_em_transito()
        mov = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/estado", {
            "estado": "recebida_com_divergencia", "rev": mov["rev"], "recebido_por": "Pessoa Sintética",
            "data": "2026-11-19", "divergencia": {"tipo": "serie_diferente", "serie_recebida": "SINT-009"},
        })
        self.assertEqual(mov["estado"], "recebida_com_divergencia")
        return demanda, mov

    def test_divergencia_aceitar(self):
        _, mov = self.divergente()
        mov = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/resolver-divergencia", {"resolucao": "aceitar", "rev": mov["rev"]})
        self.assertEqual(mov["estado"], "recebida")
        self.assertEqual(self.leitura()["vagas"][0]["situacao"], "entregue")

    def test_divergencia_corrigir(self):
        _, mov = self.divergente()
        erro = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/resolver-divergencia",
                         {"resolucao": "corrigir", "rev": mov["rev"]}, 422)
        self.assertEqual(erro["detail"]["codigo"], "dados_invalidos")
        mov = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/resolver-divergencia",
                        {"resolucao": "corrigir", "serie_recebida": "SINT-009", "rev": mov["rev"]})
        self.assertEqual(mov["serie_recebida"], "SINT-009")
        leitura = self.leitura()
        self.assertEqual((leitura["vagas"][0]["situacao"], leitura["vagas"][0]["serie"]), ("entregue", "SINT-009"))
        self.assertEqual(leitura["casos"]["disponibilidade"]["SINT001"]["estado"], "a_confirmar")
        self.assertEqual(leitura["casos"]["disponibilidade"]["SINT009"]["estado"], "entregue")

    def test_divergencia_cancelar(self):
        _, mov = self.divergente()
        mov = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/resolver-divergencia", {"resolucao": "cancelar", "rev": mov["rev"]})
        self.assertEqual(mov["estado"], "cancelada")
        self.assertEqual(self.leitura()["casos"]["disponibilidade"]["SINT001"]["estado"], "a_confirmar")

    def test_arquivamento_e_caso_arquivado_por_link(self):
        velho = (HOJE - timedelta(days=40)).isoformat()
        estado = {"esquema": 1, "disponibilidade": {}, "devolucoes": {}, "reservas": {}, "vinculos": {}, "rejeicoes": {},
                  "demandas": {
                      "dem-velha": {"id": "dem-velha", "estado": "encerrada", "fechado_em": velho, "rev": 3},
                      "dem-solta": {"id": "dem-solta", "estado": "cancelada", "fechado_em": velho, "rev": 2},
                  },
                  "movimentacoes": {"mov-aberta": {"id": "mov-aberta", "tipo": "transporte", "estado": "em_transito",
                                                   "demanda_id": "dem-velha", "reserva_id": None, "rev": 4}}}
        self.state.parent.mkdir(parents=True)
        self.state.write_text(json.dumps(estado), encoding="utf-8")
        self.post("/api/cobertura/demandas", {"data": "2026-11-20", "cidade": "Cidade A", "quantidade": 1})
        casos = self.leitura()["casos"]["demandas"]
        self.assertIn("dem-velha", casos)
        self.assertNotIn("dem-solta", casos)
        arquivado = self.client.get("/api/cobertura/casos/dem-solta").json()
        self.assertEqual((arquivado["arquivado"], arquivado["registro"]["estado"]), (True, "cancelada"))
        self.assertFalse(self.client.get("/api/cobertura/casos/dem-velha").json()["arquivado"])
        self.assertEqual(self.client.get("/api/cobertura/casos/inexistente").status_code, 404)

    def test_json_ilegivel_503_e_preservado(self):
        self.state.parent.mkdir(parents=True)
        self.state.write_text("{quebrado", encoding="utf-8")
        leitura = self.client.get("/api/cobertura")
        self.assertEqual((leitura.status_code, leitura.json()["detail"]["codigo"]), (503, "estado_ilegível"))
        escrita = self.client.post("/api/cobertura/demandas", json={"data": "2026-11-20", "cidade": "Cidade A", "quantidade": 1})
        self.assertEqual((escrita.status_code, escrita.json()["detail"]["codigo"]), (503, "estado_ilegível"))
        self.assertEqual(self.state.read_text(encoding="utf-8"), "{quebrado")
        self.state.write_text(json.dumps({"esquema": 1, "demandas": []}), encoding="utf-8")
        self.assertEqual(self.client.get("/api/cobertura/casos/x").status_code, 503)

    def test_corpo_com_campo_desconhecido_e_recusado(self):
        resposta = self.client.post("/api/cobertura/reservas/res-x/cancelar", json={"rev": 1, "extra": True})
        self.assertEqual(resposta.status_code, 422)


if __name__ == "__main__":
    unittest.main()
