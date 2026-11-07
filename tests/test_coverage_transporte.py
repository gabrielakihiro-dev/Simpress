"""Cobertura (bloco 2): entrega local e vínculo da movimentação com o histórico de transferências.

O Simpress só registra a planilha que o operador baixou; nada aqui gera planilha nem envia Transporte.
Só dados sintéticos, pastas temporárias e data fixa injetada.
"""

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains.coverage import Manutencao
from routers.coverage import CoverageServices, create_coverage_router

HOJE = date(2026, 11, 6)
AGORA = "2026-11-06T09:00:00-03:00"  # 12:00 UTC
CNPJ = "00.000.000/0001-91"


def planilha(serial="SINT-001", entrega_cidade="Cidade A"):
    return {
        "serial": serial, "retirada_cidade": "Cidade Origem", "entrega_cidade": entrega_cidade,
        "entrega_cnpj": CNPJ, "entrega_endereco": "Rua Sintética, 1", "entrega_contato": "Pessoa Sintética",
    }


def registro_historico(id_, criado_em, serial="SINT-001", entrega_cidade="Cidade A", **extra):
    return {"id": id_, "criado_em": criado_em, "serial": serial, "retirada_cidade": "Cidade Origem",
            "entrega_cidade": entrega_cidade, "entrega_contato": "Pessoa Sintética", "entrega_obs": "",
            "payload": {"serial": serial}, **extra}


class CoverageTransporteTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "data" / "state" / "operacao_cobertura.json"
        self.history = self.root / "data" / "state" / "historico_transferencias.json"
        self.client = self.criar_cliente(lambda: self.history)

    def criar_cliente(self, history_file):
        router, _ = create_coverage_router(CoverageServices(
            state_file=lambda: self.state,
            archive_file=lambda: self.root / "data" / "state" / "operacao_cobertura_arquivados.json",
            transaction_root=lambda: self.root,
            hoje=lambda: HOJE,
            agora=lambda: AGORA,
            manutencao=Manutencao,
            cadastro=lambda: [{"serial": "SINT-001", "retirada_cidade": "Cidade A"}],
            history_file=history_file,
        ))
        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def post(self, path, body, status=200):
        resposta = self.client.post(path, json=body)
        self.assertEqual(resposta.status_code, status, resposta.text)
        return resposta.json()

    def leitura(self):
        resposta = self.client.get("/api/cobertura")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()

    def historico(self):
        return json.loads(self.history.read_text(encoding="utf-8")) if self.history.exists() else []

    def preparar(self, serie="SINT-001", tipo="transporte", cidade_serie=None, status=200):
        demanda = self.post("/api/cobertura/demandas", {"data": "2026-11-20", "cidade": "Cidade A", "quantidade": 1})
        disponibilidade = {"serie": serie, "estado": "disponivel"}
        if cidade_serie:
            disponibilidade["cidade"] = cidade_serie
        self.post("/api/cobertura/disponibilidade", disponibilidade)
        reserva = self.post("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": serie})
        for item in ("notebook", "carregador", "preparacao"):
            reserva = self.post(f"/api/cobertura/reservas/{reserva['id']}/kit", {"item": item, "marcado": True, "rev": reserva["rev"]})
        corpo = {"reserva_id": reserva["id"], "rev": reserva["rev"], "tipo": tipo}
        return reserva, self.post("/api/cobertura/movimentacoes", corpo, status)

    def registrar(self, mov, status=200, **dados):
        rota = f"/api/cobertura/movimentacoes/{mov['id']}/registrar-transferencia"
        corpo = {"payload": planilha(**dados), "chave": mov["chave"], "rev": mov["rev"]}
        return self.post(rota, corpo, status)

    def test_preparar_nao_escreve_no_historico_e_nova_tentativa_cria_um_registro_so(self):
        _, mov = self.preparar()
        self.assertFalse(self.history.exists())

        primeiro = self.registrar(mov)
        self.assertEqual((primeiro["repetido"], primeiro["movimentacao"]["estado"]), (False, "gerada"))
        # Resposta perdida no caminho: o navegador repete com a mesma chave e o rev antigo.
        segundo = self.registrar(mov)
        self.assertTrue(segundo["repetido"])
        self.assertEqual(segundo["historico_id"], primeiro["historico_id"])
        historico = self.historico()
        self.assertEqual(len(historico), 1)
        self.assertEqual((historico[0]["movimentacao_id"], historico[0]["chave"]), (mov["id"], mov["chave"]))
        self.assertEqual(historico[0]["serial"], "SINT-001")

        outra = {"payload": planilha(), "chave": "outra-chave", "rev": mov["rev"]}
        erro = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/registrar-transferencia", outra, 409)["detail"]
        self.assertEqual(erro["codigo"], "chave_diferente")
        self.assertEqual(len(self.historico()), 1)

    def test_dados_divergentes_e_rev_velho(self):
        _, mov = self.preparar()
        erro = self.registrar(mov, 422, serial="SINT-999")["detail"]
        self.assertEqual((erro["codigo"], erro["campo"]), ("dados_divergentes", "serial"))
        erro = self.registrar(mov, 422, entrega_cidade="Cidade B")["detail"]
        self.assertEqual((erro["codigo"], erro["campo"]), ("dados_divergentes", "entrega_cidade"))
        velho = dict(mov, rev=mov["rev"] - 1)
        self.assertEqual(self.registrar(velho, 409)["detail"]["codigo"], "registro_alterado")
        self.assertFalse(self.history.exists())
        # Sem acento e sem caixa a comparação continua valendo.
        self.registrar(mov, serial=" sint-001 ", entrega_cidade="CIDADE Á")

    def test_historico_ilegivel_nao_grava_nada(self):
        _, mov = self.preparar()
        self.history.write_text("{quebrado", encoding="utf-8")
        estado_antes = self.state.read_text(encoding="utf-8")
        detalhe = self.registrar(mov, 503)["detail"]
        self.assertEqual(detalhe["codigo"], "estado_ilegível")
        # A mensagem diz qual arquivo está ilegível: o histórico, não o estado da cobertura.
        self.assertIn(self.history.name, detalhe["mensagem"])
        self.assertEqual(self.state.read_text(encoding="utf-8"), estado_antes)
        self.assertEqual(self.history.read_text(encoding="utf-8"), "{quebrado")
        self.history.write_text('{"esquema": "outro"}', encoding="utf-8")
        self.assertIn(self.history.name, self.registrar(mov, 503)["detail"]["mensagem"])

    def test_idempotencia_apos_retencao_de_501_registros(self):
        _, mov = self.preparar()
        primeiro = self.registrar(mov)
        # 501 planilhas depois, o registro original já saiu do histórico (só os 500 mais recentes ficam).
        outros = [registro_historico(f"h{n}", "2026-11-06T13:00:00+00:00", serial=f"SINT-{n:03d}") for n in range(501)]
        self.history.write_text(json.dumps(outros[-500:]), encoding="utf-8")
        segundo = self.registrar(mov)
        self.assertTrue(segundo["repetido"])
        self.assertEqual(segundo["transferencia"], primeiro["transferencia"])
        self.assertEqual(segundo["transferencia"]["serial"], "SINT-001")
        historico = self.historico()
        self.assertEqual(len(historico), 500)
        self.assertFalse(any(r.get("chave") == mov["chave"] for r in historico))

    def test_retencao_ao_registrar_mantem_500(self):
        _, mov = self.preparar()
        self.history.parent.mkdir(parents=True, exist_ok=True)
        cheios = [registro_historico(f"h{n}", "2026-11-06T13:00:00+00:00", serial="SINT-500") for n in range(500)]
        self.history.write_text(json.dumps(cheios), encoding="utf-8")
        self.registrar(mov)
        historico = self.historico()
        self.assertEqual((len(historico), historico[0]["id"], historico[-1]["chave"]), (500, "h1", mov["chave"]))

    def test_candidatos_e_vincular_pelo_historico(self):
        _, mov = self.preparar()
        self.history.write_text(json.dumps([
            registro_historico("antes", "2026-11-06T11:59:00+00:00"),  # antes da preparação
            registro_historico("certo", "2026-11-06T12:05:00+00:00", serial="sint-001", entrega_cidade="CIDADE A"),
            registro_historico("outra-serie", "2026-11-06T12:06:00+00:00", serial="SINT-002"),
            registro_historico("outro-destino", "2026-11-06T12:07:00+00:00", entrega_cidade="Cidade B"),
            registro_historico("ja-ligado", "2026-11-06T12:08:00+00:00", movimentacao_id="mov-x", chave="k"),
        ]), encoding="utf-8")
        candidatos = self.leitura()["casos"]["movimentacoes"][mov["id"]]["candidatos_historico"]
        self.assertEqual([c["id"] for c in candidatos], ["certo"])
        self.assertEqual(set(candidatos[0]), {"id", "criado_em", "serial", "retirada_cidade", "entrega_cidade"})

        rota = f"/api/cobertura/movimentacoes/{mov['id']}/vincular-historico"
        erro = self.post(rota, {"historico_id": "outro-destino", "rev": mov["rev"]}, 422)["detail"]
        self.assertEqual(erro["codigo"], "dados_divergentes")
        self.assertEqual(self.post(rota, {"historico_id": "outra-serie", "rev": mov["rev"]}, 422)["detail"]["campo"], "serial")
        self.assertEqual(self.post(rota, {"historico_id": "ja-ligado", "rev": mov["rev"]}, 409)["detail"]["codigo"], "conflito_vinculo")
        self.assertEqual(self.post(rota, {"historico_id": "certo", "rev": mov["rev"] - 1}, 409)["detail"]["codigo"], "registro_alterado")
        self.assertEqual(self.post(rota, {"historico_id": "sumiu", "rev": mov["rev"]}, 404)["detail"]["codigo"], "nao_encontrado")

        ligado = self.post(rota, {"historico_id": "certo", "rev": mov["rev"]})
        self.assertEqual((ligado["movimentacao"]["estado"], ligado["historico_id"]), ("gerada", "certo"))
        historico = {r["id"]: r for r in self.historico()}
        self.assertEqual((historico["certo"]["movimentacao_id"], historico["certo"]["chave"]), (mov["id"], mov["chave"]))
        self.assertEqual(len(historico), 5)
        self.assertNotIn("candidatos_historico", self.leitura()["casos"]["movimentacoes"][mov["id"]])
        self.assertEqual(self.post(rota, {"historico_id": "certo", "rev": ligado["movimentacao"]["rev"]}, 409)["detail"]["codigo"],
                         "transicao_invalida")
        # A planilha ligada pela lista também responde à nova tentativa pela chave, sem duplicar.
        self.assertTrue(self.registrar(mov)["repetido"])
        self.assertEqual(len(self.historico()), 5)

    def test_candidatos_vazios_sem_historico_ou_ilegivel(self):
        _, mov = self.preparar()
        self.assertEqual(self.leitura()["casos"]["movimentacoes"][mov["id"]]["candidatos_historico"], [])
        self.history.write_text("{quebrado", encoding="utf-8")
        self.assertEqual(self.leitura()["casos"]["movimentacoes"][mov["id"]]["candidatos_historico"], [])

    def test_sem_history_file_recusa_registrar(self):
        self.client = self.criar_cliente(None)
        _, mov = self.preparar()
        self.assertEqual(self.registrar(mov, 503)["detail"]["codigo"], "indisponivel")
        self.assertEqual(self.leitura()["casos"]["movimentacoes"][mov["id"]]["candidatos_historico"], [])

    def test_entrega_local(self):
        reserva, mov = self.preparar(tipo="local")
        leitura = self.leitura()
        self.assertEqual(leitura["casos"]["reservas"][reserva["id"]]["estado"], "consumida")
        self.assertEqual(leitura["casos"]["movimentacoes"][mov["id"]]["tipo"], "local")
        self.assertEqual(leitura["disponiveis"], [])
        self.assertFalse(self.history.exists())
        self.assertEqual(self.registrar(mov, 409)["detail"]["codigo"], "transicao_invalida")
        rota = f"/api/cobertura/movimentacoes/{mov['id']}/estado"
        erro = self.post(rota, {"estado": "recebida", "rev": mov["rev"]}, 422)["detail"]
        self.assertEqual(erro["codigo"], "dados_invalidos")
        recebida = self.post(rota, {"estado": "recebida", "rev": mov["rev"], "recebido_por": "Pessoa Sintética", "data": "2026-11-06"})
        self.assertEqual((recebida["estado"], recebida["recebimento"]["comprovante"]), ("recebida", ""))
        self.assertFalse(self.history.exists())

    def test_entrega_local_cancelada_restaura_reserva(self):
        reserva, mov = self.preparar(tipo="local")
        self.post(f"/api/cobertura/movimentacoes/{mov['id']}/estado", {"estado": "cancelada", "rev": mov["rev"]})
        self.assertEqual(self.leitura()["casos"]["reservas"][reserva["id"]]["estado"], "ativa")

    def test_cancelar_gerada_e_coletada_devolve_reserva_e_mantem_a_planilha_no_historico(self):
        for parada in ("gerada", "coletada"):
            with self.subTest(parada=parada):
                self.setUp()
                reserva, mov = self.preparar()
                gerada = self.registrar(mov)
                mov = gerada["movimentacao"]
                rota = f"/api/cobertura/movimentacoes/{mov['id']}/estado"
                if parada == "coletada":
                    mov = self.post(rota, {"estado": "coletada", "rev": mov["rev"]})
                cancelada = self.post(rota, {"estado": "cancelada", "rev": mov["rev"]})
                self.assertEqual(cancelada["estado"], "cancelada")
                leitura = self.leitura()
                restaurada = leitura["casos"]["reservas"][reserva["id"]]
                self.assertEqual((restaurada["estado"], restaurada["valida_ate"]), ("ativa", reserva["valida_ate"]))
                self.assertIsNone(leitura["vagas"][0]["movimentacao_id"])
                # A planilha gerada não é apagada nem reaparece como candidata de outra movimentação.
                historico = self.historico()
                self.assertEqual([(r["id"], r["movimentacao_id"]) for r in historico], [(gerada["historico_id"], mov["id"])])
                self.assertNotIn("candidatos_historico", leitura["casos"]["movimentacoes"][mov["id"]])
                # Nova tentativa do vínculo depois do cancelamento (resposta perdida): repetido, sem cópia no histórico.
                self.assertEqual(self.registrar(mov)["repetido"], True)
                self.assertEqual(len(self.historico()), 1)
                # A série volta a ser livre: nova movimentação sobre a mesma reserva.
                nova = self.post("/api/cobertura/movimentacoes", {"reserva_id": reserva["id"], "rev": restaurada["rev"], "tipo": "transporte"})
                self.assertNotEqual(nova["chave"], mov["chave"])
                self.assertEqual(self.registrar(nova)["repetido"], False)
                self.assertEqual(len(self.historico()), 2)

    def test_cancelar_em_transito_recusa_com_409(self):
        _, mov = self.preparar()
        mov = self.registrar(mov)["movimentacao"]
        rota = f"/api/cobertura/movimentacoes/{mov['id']}/estado"
        for proximo in ("coletada", "em_transito"):
            mov = self.post(rota, {"estado": proximo, "rev": mov["rev"]})
        erro = self.post(rota, {"estado": "cancelada", "rev": mov["rev"]}, 409)["detail"]
        self.assertEqual((erro["codigo"], erro["estado"]), ("transicao_invalida", "em_transito"))
        self.assertEqual(self.leitura()["casos"]["movimentacoes"][mov["id"]]["estado"], "em_transito")
        self.post(rota, {"estado": "encerrada", "rev": mov["rev"]}, 422)  # "encerrada" saiu do contrato da rota

    def test_entrega_local_em_outra_cidade_recusa(self):
        reserva, erro = self.preparar(serie="SINT-002", tipo="local", cidade_serie="Cidade B", status=422)
        self.assertEqual(erro["detail"]["codigo"], "fora_da_cidade")
        self.assertEqual(self.leitura()["casos"]["reservas"][reserva["id"]]["estado"], "ativa")

    def test_divergencia_em_entrega_local(self):
        _, mov = self.preparar(tipo="local")
        mov = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/estado", {
            "estado": "recebida_com_divergencia", "rev": mov["rev"], "recebido_por": "Pessoa Sintética", "data": "2026-11-06",
            "divergencia": {"tipo": "item_faltando", "descricao": "sem carregador"},
        })
        self.assertEqual(mov["estado"], "recebida_com_divergencia")
        mov = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/resolver-divergencia", {"resolucao": "aceitar", "rev": mov["rev"]})
        self.assertEqual(mov["estado"], "recebida")
        self.assertEqual(self.leitura()["casos"]["disponibilidade"]["SINT001"]["estado"], "entregue")


if __name__ == "__main__":
    unittest.main()
