"""Cobertura: o formato declarado nas rotas (response_model) não pode cortar, acrescentar nem mudar campo do domínio.

Oráculo: as rotas de leitura chamadas direto (``CoverageRouteExports``, sem response_model) e o registro gravado no
arquivo de estado. Inclui um arquivo editado à mão (campo desconhecido, opcional ausente, data fora do formato,
quantidade em texto, kit com item estranho), que precisa continuar legível e igual.
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
from test_coverage_transporte import planilha, registro_historico

HOJE = date(2026, 11, 6)
AGORA = "2026-11-06T09:00:00-03:00"  # 12:00 UTC
SECAO = {"dem": "demandas", "dev": "devolucoes", "res": "reservas", "mov": "movimentacoes"}


class FormatoDeRespostaTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "data" / "state" / "operacao_cobertura.json"
        self.history = self.root / "data" / "state" / "historico_transferencias.json"
        router, self.exports = create_coverage_router(CoverageServices(
            state_file=lambda: self.state,
            archive_file=lambda: self.root / "data" / "state" / "operacao_cobertura_arquivados.json",
            transaction_root=lambda: self.root,
            hoje=lambda: HOJE,
            agora=lambda: AGORA,
            manutencao=Manutencao,
            cadastro=lambda: [{"serial": "SINT-001", "retirada_cidade": "Cidade A"}],
            history_file=lambda: self.history,
        ))
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)

    def arquivo(self):
        return json.loads(self.state.read_text(encoding="utf-8"))

    def gravado(self, registro):
        """O registro como está no arquivo: disponibilidade pela série normalizada, o resto pelo prefixo do id."""
        estado = self.arquivo()
        secao = SECAO.get(str(registro["id"]).split("-")[0], "disponibilidade")
        return estado[secao][registro["id"]]

    def post(self, path, body):
        resposta = self.client.post(path, json=body)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()

    def escrever(self, path, body):
        """Escrita que devolve o registro gravado: a resposta é idêntica ao registro do arquivo."""
        registro = self.post(path, body)
        self.assertEqual(registro, self.gravado(registro), path)
        return registro

    def conferir_leituras(self):
        """GET da cobertura e de cada caso iguais ao domínio chamado direto (nem um campo a mais, a menos ou mudado)."""
        resposta = self.client.get("/api/cobertura")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        leitura = resposta.json()
        self.assertEqual(leitura, json.loads(json.dumps(self.exports.ler_cobertura())))
        for secao in leitura["casos"].values():
            for caso_id in secao:
                caso = self.client.get(f"/api/cobertura/casos/{caso_id}")
                self.assertEqual(caso.status_code, 200, caso.text)
                self.assertEqual(caso.json(), json.loads(json.dumps(self.exports.ler_caso(caso_id))))
        return leitura

    def test_todas_as_rotas_devolvem_o_que_o_dominio_grava_e_le(self):
        demanda = self.escrever("/api/cobertura/demandas", {"data": "2026-11-20", "cidade": "Cidade A", "quantidade": 3})
        outra = self.escrever("/api/cobertura/demandas", {"data": "2026-11-21", "cidade": "Cidade B", "quantidade": 1,
                                                          "perfil": "Sintético", "monitor": True, "observacao": "Obs"})
        self.escrever(f"/api/cobertura/demandas/{outra['id']}/cancelar", {"rev": outra["rev"]})
        for corpo in ({"serie": "SINT-001", "estado": "disponivel"},
                      {"serie": "SINT-002", "estado": "disponivel", "cidade": "Cidade A"},
                      {"serie": "SINT-004", "estado": "disponivel", "cidade": "Cidade A"},
                      {"serie": "SINT-009", "estado": "em_manutencao", "cidade": "Cidade B"}):
            self.escrever("/api/cobertura/disponibilidade", corpo)
        dev = self.escrever("/api/cobertura/devolucoes", {"serie": "SINT-003", "data_prevista": "2026-11-15", "cidade": "Cidade A"})
        dev = self.escrever(f"/api/cobertura/devolucoes/{dev['id']}/reprogramar", {"rev": dev["rev"], "data_prevista": "2026-11-16"})
        self.escrever(f"/api/cobertura/devolucoes/{dev['id']}/receber", {"rev": dev["rev"]})
        dev2 = self.escrever("/api/cobertura/devolucoes", {"serie": "SINT-005", "data_prevista": "2026-11-01", "observacao": "Atrasada"})
        self.conferir_leituras()  # devolução atrasada e manutenção no meio
        self.escrever(f"/api/cobertura/devolucoes/{dev2['id']}/cancelar", {"rev": dev2["rev"]})

        reservas = {}
        for serie in ("SINT-001", "SINT-002", "SINT-004"):
            reserva = self.escrever("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": serie})
            for item in ("notebook", "carregador", "preparacao"):
                reserva = self.escrever(f"/api/cobertura/reservas/{reserva['id']}/kit",
                                        {"item": item, "marcado": True, "rev": reserva["rev"]})
            reservas[serie] = reserva
        reservas["SINT-001"] = self.escrever(f"/api/cobertura/reservas/{reservas['SINT-001']['id']}/renovar",
                                             {"rev": reservas["SINT-001"]["rev"]})
        self.escrever(f"/api/cobertura/reservas/{reservas['SINT-002']['id']}/cancelar", {"rev": reservas["SINT-002"]["rev"]})

        # Preparar devolve só 5 campos da movimentação gravada.
        movs = {}
        for serie in ("SINT-001", "SINT-004"):
            reserva = reservas[serie]
            mov = self.post("/api/cobertura/movimentacoes", {"reserva_id": reserva["id"], "rev": reserva["rev"], "tipo": "transporte"})
            self.assertEqual(mov, {chave: self.gravado(mov).get(chave) for chave in ("id", "serie", "destino_cidade", "chave", "rev")})
            movs[serie] = mov

        self.history.write_text(json.dumps([registro_historico("certo", "2026-11-06T12:05:00+00:00", serial="SINT-004")]),
                                encoding="utf-8")
        leitura = self.conferir_leituras()
        self.assertEqual([c["id"] for c in leitura["casos"]["movimentacoes"][movs["SINT-004"]["id"]]["candidatos_historico"]],
                         ["certo"])

        mov = movs["SINT-001"]
        gerada = self.post(f"/api/cobertura/movimentacoes/{mov['id']}/registrar-transferencia",
                           {"payload": planilha(), "chave": mov["chave"], "rev": mov["rev"]})
        ligada = self.post(f"/api/cobertura/movimentacoes/{movs['SINT-004']['id']}/vincular-historico",
                           {"historico_id": "certo", "rev": movs["SINT-004"]["rev"]})
        for resposta in (gerada, ligada):
            self.assertEqual(set(resposta), {"movimentacao", "historico_id", "transferencia", "repetido"})
            gravada = self.gravado(resposta["movimentacao"])
            self.assertEqual(resposta["movimentacao"], gravada)
            self.assertEqual((resposta["historico_id"], resposta["transferencia"]), (gravada["historico_id"], gravada["transferencia"]))
        self.assertIs(gerada["repetido"], False)

        mov = gerada["movimentacao"]
        for estado in ("coletada", "em_transito"):
            mov = self.escrever(f"/api/cobertura/movimentacoes/{mov['id']}/estado", {"estado": estado, "rev": mov["rev"]})
        mov = self.escrever(f"/api/cobertura/movimentacoes/{mov['id']}/estado", {
            "estado": "recebida_com_divergencia", "rev": mov["rev"], "recebido_por": "Pessoa Sintética", "data": "2026-11-06",
            "divergencia": {"tipo": "serie_diferente", "descricao": "Outra", "serie_recebida": "SINT-007"},
        })
        self.escrever(f"/api/cobertura/movimentacoes/{mov['id']}/resolver-divergencia", {"resolucao": "aceitar", "rev": mov["rev"]})
        self.conferir_leituras()

    def test_arquivo_editado_a_mao_continua_legivel_e_igual(self):
        demanda = self.escrever("/api/cobertura/demandas", {"data": "2026-11-20", "cidade": "Cidade A", "quantidade": 2})
        self.escrever("/api/cobertura/disponibilidade", {"serie": "SINT-001", "estado": "disponivel"})
        reserva = self.escrever("/api/cobertura/reservas", {"demanda_id": demanda["id"], "serie": "SINT-001"})
        dev = self.escrever("/api/cobertura/devolucoes", {"serie": "SINT-003", "data_prevista": "2026-11-15"})

        estado = self.arquivo()
        estado["demandas"][demanda["id"]].update(quantidade="2", campo_manual={"x": [1, None]}, observacao=None)
        disponivel = estado["disponibilidade"]["SINT001"]
        del disponivel["confirmada_em"]
        disponivel["anotacao"] = "à mão"
        estado["reservas"][reserva["id"]]["kit"]["estranho"] = "sim"
        estado["devolucoes"][dev["id"]]["data_prevista"] = "15/11/2026"
        self.state.write_text(json.dumps(estado), encoding="utf-8")

        leitura = self.conferir_leituras()
        self.assertEqual(leitura["casos"]["demandas"][demanda["id"]]["quantidade"], "2")  # sem conversão para número
        self.assertNotIn("confirmada_em", leitura["casos"]["disponibilidade"]["SINT001"])  # ausente não vira null
        cancelada = self.escrever(f"/api/cobertura/demandas/{demanda['id']}/cancelar", {"rev": demanda["rev"]})
        self.assertEqual(cancelada["campo_manual"], {"x": [1, None]})
        self.escrever(f"/api/cobertura/devolucoes/{dev['id']}/cancelar", {"rev": dev["rev"]})
        self.conferir_leituras()


if __name__ == "__main__":
    unittest.main()
