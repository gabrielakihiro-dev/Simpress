import base64
import json
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from core.errors import DomainError
from domains import sebrae_dashboard_gravacao as G
from domains import sebrae_novos
from domains.sebrae_chamados import ChamadoSoftExpert
from routers.sebrae_dashboard import SebraeDashboardServices, create_sebrae_dashboard_router
from tests.test_sebrae_dashboard import CABECALHO, planilha
from tests.test_sebrae_dashboard_gravacao import _antes_da_coluna_p, montar, texto
from tests.test_sebrae_historico import planilha_com_status

CHAMADO = ChamadoSoftExpert(
    "UTIC-2026-1378", titulo="Travando", descricao="Meu notebook trava", solicitante="Camila Lopes",
    habilitada_em="26/10/2026, 17:25:23", detalhes_atendimento_realizado="Encaminhado",
)
REGISTROS = [{"nome": "Camila Lopes", "serie": "ABC123", "modelo": "Dell", "cidade": "Curitiba"}]
MANUAL = {"numero": "UTIC-2026-1378", "A": "CLIENTE", "B": "LENTIDÃO", "D": "EM ABERTO", "J": "INCIDENTE", "R": "", "S": "DISPONIBILIDADE"}


class RotasBase(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.caminhos = sebrae_novos.caminhos_padrao(self.dir)
        self.limite = 10 * 1024 * 1024
        app = FastAPI()

        @app.exception_handler(DomainError)
        async def erro(_request, error):
            return JSONResponse({"detail": error.detail}, status_code=error.status_code)

        app.include_router(create_sebrae_dashboard_router(SebraeDashboardServices(
            caminhos=lambda: self.caminhos, max_upload_bytes=lambda: self.limite,
            registros=lambda: REGISTROS, relatorio_chamados=lambda: {"chamados": [
                {"serie": "ABC123", "simpress": {"ordens_servico": ["7303022"]}}]},
        )))
        self.cliente = TestClient(app)

    def importar(self, conteudo=None, nome="Dashboard.xlsx"):
        conteudo = planilha() if conteudo is None else conteudo
        return self.cliente.post("/api/sebrae/dashboard", files={"file": (nome, conteudo, "application/octet-stream")})


class RotasSebraeTest(RotasBase):
    def test_estado_vazio_antes_de_importar(self):
        self.assertEqual(self.cliente.get("/api/sebrae/novos").json(), {"importado": None, "novos": None})

    def test_importar_guarda_so_os_numeros_e_responde_o_estado(self):
        resposta = self.importar()
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json()["importado"]["total"], 2)
        self.assertEqual(resposta.json()["novos"], None)
        self.assertNotIn("Camila", self.caminhos.existentes.read_text(encoding="utf-8"))

    def test_importar_recusa_arquivo_errado_vazio_grande_e_dashboard_sem_titulo(self):
        self.assertEqual(self.importar(nome="d.csv").status_code, 422)
        self.assertEqual(self.importar(b"").status_code, 422)
        self.limite = 10
        self.assertEqual(self.importar().status_code, 413)
        self.limite = 10 * 1024 * 1024
        sem_titulo = self.importar(planilha(cabecalho=CABECALHO[:6] + CABECALHO[7:]))
        self.assertEqual(sem_titulo.status_code, 422)
        self.assertIn("Título em G", sem_titulo.json()["detail"])

    def preparar_novos(self):
        self.importar()
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})

    def test_lista_novos_com_colunas_automaticas_e_cruzamento(self):
        self.preparar_novos()
        item = self.cliente.get("/api/sebrae/novos").json()["novos"]["formulario"][0]
        self.assertEqual(item["numero"], "UTIC-2026-1378")
        self.assertEqual([item["linha"][c] for c in "EKLN"], ["7303022", "ABC123", "Dell", "Curitiba"])

    def test_chamado_lancado_no_dashboard_some_da_lista_depois_de_nova_importacao(self):
        self.preparar_novos()
        self.importar(planilha(coluna_c=("UTIC-2026-1378",)))
        self.assertEqual(self.cliente.get("/api/sebrae/novos").json()["novos"]["formulario"], [])

    def test_exportar_devolve_blocos_e_a_mensagem_aprovada(self):
        self.preparar_novos()
        resposta = self.cliente.post("/api/sebrae/exportar", json={"chamados": [MANUAL]})
        self.assertEqual(resposta.status_code, 200)
        corpo = resposta.json()
        self.assertEqual(corpo["mensagem"], "Planilha Exportada com Sucesso!")
        self.assertEqual(corpo["bloco_a_p"].split("\t")[2], "UTIC-2026-1378")
        self.assertEqual(corpo["bloco_r_s"], "\tDISPONIBILIDADE")

    def test_exportar_recusa_manual_invalido_chamado_desconhecido_e_campo_extra(self):
        self.preparar_novos()
        invalido = self.cliente.post("/api/sebrae/exportar", json={"chamados": [{**MANUAL, "D": ""}]})
        self.assertEqual(invalido.status_code, 422)
        self.assertIn("STATUS", invalido.json()["detail"])
        desconhecido = self.cliente.post("/api/sebrae/exportar", json={"chamados": [{**MANUAL, "numero": "UTIC-2026-9999"}]})
        self.assertEqual(desconhecido.status_code, 422)
        extra = self.cliente.post("/api/sebrae/exportar", json={"chamados": [{**MANUAL, "Z": "x"}]})
        self.assertEqual(extra.status_code, 422)
        repetido = self.cliente.post("/api/sebrae/exportar", json={"chamados": [MANUAL, MANUAL]})
        self.assertEqual(repetido.status_code, 422)

    def test_exportar_sem_dashboard_ou_sem_busca_responde_422(self):
        self.assertEqual(self.cliente.post("/api/sebrae/exportar", json={"chamados": [MANUAL]}).status_code, 422)
        self.importar()
        self.assertEqual(self.cliente.post("/api/sebrae/exportar", json={"chamados": [MANUAL]}).status_code, 422)

    def test_importar_guarda_copia_listas_e_chamados_em_aberto(self):
        estado = self.importar(montar()).json()["importado"]
        self.assertTrue(estado["atualizavel"])
        self.assertEqual([a["numero"] for a in estado["abertos"]], ["UTIC-2026-0001"])
        self.assertTrue(sebrae_novos.caminho_planilha(self.caminhos).exists())
        # a Dashboard the writer cannot read still imports: only "Atualizar" is off
        simples = self.importar(planilha()).json()["importado"]
        self.assertFalse(simples["atualizavel"])
        self.assertEqual(simples["abertos"], [])

    def test_atualizar_grava_novo_e_edicao_numa_copia(self):
        self.importar(montar())
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        guardada = sebrae_novos.caminho_planilha(self.caminhos).read_bytes()
        edicao = {"numero": "UTIC-2026-0001", "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        resposta = self.cliente.post("/api/sebrae/dashboard/atualizar", json={"chamados": [MANUAL], "edicoes": [edicao]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        corpo = resposta.json()
        self.assertEqual(corpo["arquivo"], "Dashboard Operacional_SEBRAE.xlsx")
        saida = sebrae_novos.caminho_saida(self.caminhos, corpo["arquivo"])
        self.assertEqual(saida.read_bytes(), base64.b64decode(corpo["conteudo_base64"]))
        self.assertEqual({(g["numero"], g["tipo"]) for g in corpo["linhas"]}, {("UTIC-2026-1378", "novo"), ("UTIC-2026-0001", "alterado")})
        self.assertEqual([g.numero for g in G.chamados_para_editar(base64.b64decode(corpo["conteudo_base64"]))], ["UTIC-2026-1378"])
        self.assertEqual(sebrae_novos.caminho_planilha(self.caminhos).read_bytes(), guardada)

    def test_nova_importacao_apaga_a_saida_da_importacao_anterior(self):
        saida = sebrae_novos.caminho_saida(self.caminhos, "Dashboard Operacional_SEBRAE.xlsx")
        self.assertEqual(self.importar(montar()).status_code, 200)  # sem saída anterior: não dá erro
        self.assertFalse(saida.exists())
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        self.assertEqual(self.cliente.post("/api/sebrae/dashboard/atualizar", json={"chamados": [MANUAL]}).status_code, 200)
        self.assertTrue(saida.exists())
        self.assertEqual(self.importar(montar()).status_code, 200)
        self.assertFalse(saida.exists())

    def test_atualizar_grava_novo_com_a_d_j_em_branco_e_recusa_d_invalido(self):
        self.importar(montar())
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        url = "/api/sebrae/dashboard/atualizar"
        em_branco = {"numero": "UTIC-2026-1378", "A": "", "D": "", "J": ""}
        resposta = self.cliente.post(url, json={"chamados": [em_branco]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        corpo = resposta.json()
        self.assertEqual([(g["numero"], g["tipo"]) for g in corpo["linhas"]], [("UTIC-2026-1378", "novo")])
        self.assertIn("UTIC-2026-1378", [c.numero for c in G.chamados_para_editar(base64.b64decode(corpo["conteudo_base64"]))])
        invalido = self.cliente.post(url, json={"chamados": [{**em_branco, "D": "TALVEZ"}]})
        self.assertEqual(invalido.status_code, 422)
        self.assertIn("STATUS", invalido.json()["detail"])
        sem_campos = self.cliente.post("/api/sebrae/exportar", json={"chamados": [em_branco]})
        self.assertEqual(sem_campos.status_code, 422)

    def test_atualizar_edita_so_b_de_chamado_antigo_com_d_vazio(self):
        self.importar(montar(("UTIC-2026-0001",), status=("",)))
        url = "/api/sebrae/dashboard/atualizar"
        resposta = self.cliente.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "B": "REDE"}]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual([(g["numero"], g["tipo"], g["celulas"]) for g in resposta.json()["linhas"]], [("UTIC-2026-0001", "alterado", ["B"])])

    def test_atualizar_so_com_preenchimento_automatico_pelo_nome_da_coluna_i(self):
        base = _antes_da_coluna_p(montar(("Sem chamado", "UTIC-2026-0002"), status=("EM ABERTO", "FINALIZADO")), 2, texto("I2", "Camila Lopes"))
        estado = self.importar(base).json()["importado"]
        self.assertEqual([(a["numero"], a["chamado"], a["usuario"]) for a in estado["abertos"]], [("linha:2", "Sem chamado", "Camila Lopes")])
        self.assertEqual(estado["abertos"][0]["automaticos_sugeridos"], {"K": "ABC123", "L": "Dell", "N": "Curitiba", "E": "7303022"})
        resposta = self.cliente.post("/api/sebrae/dashboard/atualizar", json={})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual([(g["numero"], g["tipo"], g["celulas"]) for g in resposta.json()["linhas"]], [("linha:2", "alterado", ["E", "K", "L", "N"])])
        nada = self.importar(montar())  # no name in column I: nothing to fill, nothing sent
        self.assertEqual(nada.json()["importado"]["abertos"][0]["automaticos_sugeridos"], {})
        self.assertEqual(self.cliente.post("/api/sebrae/dashboard/atualizar", json={}).status_code, 422)

    def test_atualizar_edita_chamado_de_c_composto(self):
        self.importar(montar(("27371 / UTIC-2026-0094",), status=("EM ABERTO",)))
        edicao = {"numero": "UTIC-2026-0094", "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE", "R": "28/10/2026 14:30"}
        resposta = self.cliente.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [edicao]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual([(g["numero"], g["tipo"]) for g in resposta.json()["linhas"]], [("UTIC-2026-0094", "alterado")])

    def test_atualizar_recusa_pedido_vazio_sem_importacao_e_copia_adulterada(self):
        vazio = self.cliente.post("/api/sebrae/dashboard/atualizar", json={})
        self.assertEqual(vazio.status_code, 422)
        edicao = {"numero": "UTIC-2026-0001", "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        self.assertIn("Importe", self.cliente.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [edicao]}).json()["detail"])
        self.importar(montar())
        sebrae_novos.caminho_planilha(self.caminhos).write_bytes(b"outro conteudo")
        adulterada = self.cliente.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [edicao]})
        self.assertEqual(adulterada.status_code, 422)
        self.assertIn("importe o Dashboard de novo", adulterada.json()["detail"])

    def test_atualizar_valida_edicao_pela_regra_dos_manuais_e_pelas_listas(self):
        self.importar(montar())
        url = "/api/sebrae/dashboard/atualizar"
        # A, D and J may stay blank after merging (the stored ticket has no J); a filled invalid value is still refused
        sem_j = self.cliente.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "A": "CLIENTE", "D": "FINALIZADO"}]})
        self.assertEqual(sem_j.status_code, 200, sem_j.text)
        j_invalido = self.cliente.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "J": "OUTRO"}]})
        self.assertEqual(j_invalido.status_code, 422)
        self.assertIn("UTIC-2026-0001", j_invalido.json()["detail"])
        finalizado = self.cliente.post(url, json={"edicoes": [{"numero": "UTIC-2026-0002", "A": "CLIENTE", "D": "X", "J": "INCIDENTE"}]})
        self.assertEqual(finalizado.status_code, 422)
        self.assertIn("EM ABERTO", finalizado.json()["detail"])
        dados = sebrae_novos.ler_existentes(self.caminhos.existentes)
        sebrae_novos.salvar_existentes(
            self.caminhos.existentes, dados["numeros"], dados["arquivo"], sha256=dados["sha256"],
            listas={"A": ["CLIENTE"], "B": ["REDE"]}, abertos=dados["abertos"],
        )
        fora = self.cliente.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "A": "OUTRO", "D": "FINALIZADO", "J": "INCIDENTE"}]})
        self.assertEqual(fora.status_code, 422)
        self.assertIn("lista do Dashboard", fora.json()["detail"])
        repetido = {"numero": "UTIC-2026-0001", "A": "CLIENTE", "D": "FINALIZADO", "J": "INCIDENTE"}
        self.assertEqual(self.cliente.post(url, json={"edicoes": [repetido, repetido]}).status_code, 422)

    def test_atualizar_recusa_novo_que_nao_esta_na_lista_de_novos(self):
        self.importar(montar())
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        resposta = self.cliente.post("/api/sebrae/dashboard/atualizar", json={"chamados": [{**MANUAL, "numero": "UTIC-2026-9999"}]})
        self.assertEqual(resposta.status_code, 422)
        self.assertIn("não está entre os chamados novos", resposta.json()["detail"])


class HistoricoRotasTest(RotasBase):
    def fechar(self, *linhas):
        return planilha_com_status([(c, d, r, "") for c, d, r in linhas])

    def test_importar_registra_a_entrada_inicial_e_responde_historico_ok(self):
        resposta = self.importar(self.fechar(("UTIC-2026-0001", "EM ABERTO", None)))
        self.assertTrue(resposta.json()["historico_ok"])
        lista = self.cliente.get("/api/sebrae/historico")
        self.assertEqual(lista.headers["cache-control"], "no-store")
        item = lista.json()["itens"][0]
        self.assertEqual((item["tipo"], item["arquivo"], item["total"], item["inicial"]), ("importacao", "Dashboard.xlsx", 1, True))
        self.assertEqual(len(item["sha256"]), 64)

    def test_reimportar_igual_so_conta_e_mudanca_vira_nova_entrada_com_status(self):
        aberto = self.fechar(("UTIC-2026-0001", "EM ABERTO", None))
        self.importar(aberto)
        self.importar(aberto)
        self.assertEqual(self.cliente.get("/api/sebrae/historico").json()["total"], 1)
        self.assertEqual(self.cliente.get("/api/sebrae/historico").json()["itens"][0]["repeticoes"], 1)
        self.importar(self.fechar(("UTIC-2026-0001", "FINALIZADO", "28/10/2026 10:00"), ("UTIC-2026-0002", "EM ABERTO", None)))
        lista = self.cliente.get("/api/sebrae/historico").json()
        self.assertEqual(lista["total"], 2)
        detalhe = self.cliente.get(f"/api/sebrae/historico/{lista['itens'][0]['id']}").json()
        self.assertEqual(detalhe["adicionados"], ["UTIC-2026-0002"])
        self.assertEqual(detalhe["alterados"][0]["para"], "FINALIZADO")

    def test_primeira_importacao_depois_do_recurso_compara_com_os_numeros_ja_guardados(self):
        sebrae_novos.salvar_existentes(self.caminhos.existentes, ["UTIC-2026-0001"], "antigo.xlsx")
        self.importar(self.fechar(("UTIC-2026-0001", "EM ABERTO", None), ("UTIC-2026-0002", "EM ABERTO", None)))
        item = self.cliente.get("/api/sebrae/historico").json()["itens"][0]
        self.assertEqual((item["inicial"], item["n_adicionados"]), (False, 1))

    def test_falha_do_historico_nao_impede_a_importacao_nem_apaga_o_arquivo(self):
        self.caminhos.historico.write_text("{ quebrado", encoding="utf-8")
        resposta = self.importar()
        self.assertEqual(resposta.status_code, 200)
        self.assertFalse(resposta.json()["historico_ok"])
        self.assertTrue(self.caminhos.existentes.exists())
        self.assertEqual(self.caminhos.historico.read_text(encoding="utf-8"), "{ quebrado")
        self.assertEqual(self.cliente.get("/api/sebrae/historico").status_code, 503)

    def test_listagem_valida_parametros_e_detalhe_inexistente_responde_404(self):
        self.assertEqual(self.cliente.get("/api/sebrae/historico").json()["total"], 0)
        self.assertEqual(self.cliente.get("/api/sebrae/historico?tipo=outro").status_code, 422)
        self.assertEqual(self.cliente.get("/api/sebrae/historico?limite=0").status_code, 422)
        self.assertEqual(self.cliente.get("/api/sebrae/historico/nao-existe").status_code, 404)

    def test_historico_nao_guarda_texto_de_outras_colunas(self):
        self.importar(planilha_com_status([("UTIC-2026-0001", "EM ABERTO", None, "senha: Segredo123 CPF 123.456.789-09")]))
        self.assertNotIn("Segredo", self.caminhos.historico.read_text(encoding="utf-8"))


class ArquivoRotasTest(RotasBase):
    def arquivo(self):
        return json.loads(sebrae_novos.caminho_arquivo(self.caminhos).read_text(encoding="utf-8"))

    def test_importar_semeia_finalizados_e_arquiva_o_que_saiu_da_lista_de_abertos(self):
        primeira = self.importar(montar())
        self.assertTrue(primeira.json()["arquivo_ok"])
        self.assertEqual(list(self.arquivo()["itens"]), ["UTIC-2026-0002"])  # already FINALIZADO in the first Dashboard
        segunda = self.importar(montar(status=("FINALIZADO", "FINALIZADO")))
        self.assertTrue(segunda.json()["arquivo_ok"])
        itens = self.arquivo()["itens"]
        self.assertEqual(sorted(itens), ["UTIC-2026-0001", "UTIC-2026-0002"])
        self.assertEqual(itens["UTIC-2026-0001"]["ciclos"][0]["motivo"], "finalizado")
        self.assertEqual(len(itens["UTIC-2026-0002"]["ciclos"]), 1)

    def test_falha_do_arquivo_bloqueia_a_importacao_e_mantem_o_dashboard_anterior(self):
        self.importar(montar())
        antes = self.caminhos.existentes.read_bytes()
        sebrae_novos.caminho_arquivo(self.caminhos).write_text("{ quebrado", encoding="utf-8")
        resposta = self.importar(montar(status=("FINALIZADO", "FINALIZADO")))
        self.assertEqual(resposta.status_code, 503)
        self.assertIn("chamados encerrados", resposta.json()["detail"])
        self.assertEqual(self.caminhos.existentes.read_bytes(), antes)
        self.assertEqual(sebrae_novos.caminho_arquivo(self.caminhos).read_text(encoding="utf-8"), "{ quebrado")

    def test_dashboard_importado_nao_guarda_cpf_nem_senha_dos_abertos(self):
        conteudo = _antes_da_coluna_p(montar(), 2, texto("H2", "CPF 123.456.789-09 senha: Segredo123") + texto("I2", "Camila Lopes"))
        self.importar(conteudo)
        guardado = self.caminhos.existentes.read_text(encoding="utf-8")
        self.assertNotIn("123.456.789-09", guardado)
        self.assertNotIn("Segredo123", guardado)
        self.assertIn("Camila Lopes", guardado)


if __name__ == "__main__":
    unittest.main()
