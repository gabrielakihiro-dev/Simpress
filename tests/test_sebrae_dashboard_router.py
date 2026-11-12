import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from core.errors import DomainBusyError, DomainError
from domains import assistant_relatorios, sebrae_dashboard_gravacao as G, sebrae_finalizacao as fin
from domains import sebrae_categoria, sebrae_categoria_ia, sebrae_novos, sebrae_observacoes as obs
from domains.assistant_api import MAX_ITENS_LISTA, SimpressApi
from domains.sebrae_chamados import ChamadoSoftExpert
from routers.sebrae_dashboard import SebraeDashboardServices, create_sebrae_dashboard_router
from tests.test_sebrae_dashboard import CABECALHO, planilha
from tests.test_sebrae_dashboard_gravacao import _antes_da_coluna_p, _trocar_na_folha, linha_xml, montar, texto
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

    def post(self, url, **kwargs):
        if url in ("/api/sebrae/dashboard/atualizar", "/api/sebrae/finalizar-softexpert") and isinstance(kwargs.get("json"), dict):
            atual = sebrae_novos.ler_existentes(self.caminhos.existentes)
            kwargs["json"].setdefault("versao_importacao", atual["versao"] if atual else "")
        return self.cliente.post(url, **kwargs)

    def importar(self, conteudo=None, nome="Dashboard.xlsx"):
        conteudo = planilha() if conteudo is None else conteudo
        return self.post("/api/sebrae/dashboard", files={"file": (nome, conteudo, "application/octet-stream")})


class OsDeMacbookPelaSerieTest(unittest.TestCase):
    """Wiring of the MacBook ``S`` equivalence: the suggested E and the update flow use ``indice_endpoint``, and its failure is harmless."""

    MAC = [{"nome": "Camila Lopes", "serie": "SCXC9F072K1", "modelo": "MacBook", "cidade": "Curitiba"}]
    INDICE = {"unique": {"CXC9F072K1": "PRMAC001"}, "details_serials": {"SCXC9F072K1"}}

    def cliente(self, indice):
        self.caminhos = sebrae_novos.caminhos_padrao(Path(tempfile.mkdtemp()))
        app = FastAPI()
        app.include_router(create_sebrae_dashboard_router(SebraeDashboardServices(
            caminhos=lambda: self.caminhos, max_upload_bytes=lambda: 10 * 1024 * 1024, registros=lambda: self.MAC,
            relatorio_chamados=lambda: {"chamados": [{"serie": "CXC9F072K1", "simpress": {"ordens_servico": ["77"]}}]},
            indice_endpoint=indice,
        )))
        cliente = TestClient(app)
        base = _antes_da_coluna_p(montar(("Sem chamado", "UTIC-2026-0002"), status=("EM ABERTO", "FINALIZADO")), 2, texto("I2", "Camila Lopes"))
        return cliente, cliente.post("/api/sebrae/dashboard", files={"file": ("Dashboard.xlsx", base, "application/octet-stream")}).json()["importado"]

    def test_os_sugerida_pela_outra_grafia_da_serie_e_gravada_na_atualizacao(self):
        cliente, estado = self.cliente(lambda: self.INDICE)
        self.assertEqual(estado["abertos"][0]["automaticos_sugeridos"], {"K": "SCXC9F072K1", "L": "MacBook", "N": "Curitiba", "E": "77"})
        resposta = cliente.post("/api/sebrae/dashboard/atualizar", json={"versao_importacao": estado["versao"]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["linhas"][0]["celulas"], ["E", "K", "L", "N"])

    def test_sem_indice_ou_com_indice_quebrado_a_tela_segue_sem_a_os(self):
        def quebrado():
            raise KeyError("x")
        for indice in (lambda: None, quebrado):
            _, estado = self.cliente(indice)
            self.assertEqual(estado["abertos"][0]["automaticos_sugeridos"], {"K": "SCXC9F072K1", "L": "MacBook", "N": "Curitiba"})


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
        resposta = self.post("/api/sebrae/exportar", json={"chamados": [MANUAL]})
        self.assertEqual(resposta.status_code, 200)
        corpo = resposta.json()
        self.assertEqual(corpo["mensagem"], "Planilha Exportada com Sucesso!")
        self.assertEqual(corpo["bloco_a_p"].split("\t")[2], "UTIC-2026-1378")
        self.assertEqual(corpo["bloco_r_s"], "\tDISPONIBILIDADE")

    def test_exportar_recusa_manual_invalido_chamado_desconhecido_e_campo_extra(self):
        self.preparar_novos()
        invalido = self.post("/api/sebrae/exportar", json={"chamados": [{**MANUAL, "D": ""}]})
        self.assertEqual(invalido.status_code, 422)
        self.assertIn("STATUS", invalido.json()["detail"])
        desconhecido = self.post("/api/sebrae/exportar", json={"chamados": [{**MANUAL, "numero": "UTIC-2026-9999"}]})
        self.assertEqual(desconhecido.status_code, 422)
        extra = self.post("/api/sebrae/exportar", json={"chamados": [{**MANUAL, "Z": "x"}]})
        self.assertEqual(extra.status_code, 422)
        repetido = self.post("/api/sebrae/exportar", json={"chamados": [MANUAL, MANUAL]})
        self.assertEqual(repetido.status_code, 422)

    def test_exportar_sem_dashboard_ou_sem_busca_responde_422(self):
        self.assertEqual(self.post("/api/sebrae/exportar", json={"chamados": [MANUAL]}).status_code, 422)
        self.importar()
        self.assertEqual(self.post("/api/sebrae/exportar", json={"chamados": [MANUAL]}).status_code, 422)

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
        resposta = self.post("/api/sebrae/dashboard/atualizar", json={"chamados": [MANUAL], "edicoes": [edicao]})
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
        self.assertEqual(self.post("/api/sebrae/dashboard/atualizar", json={"chamados": [MANUAL]}).status_code, 200)
        self.assertTrue(saida.exists())
        self.assertTrue(self.cliente.get("/api/sebrae/novos").json()["importado"]["saida_pronta"])
        nova = self.importar(montar()).json()["importado"]
        self.assertFalse(nova["saida_pronta"])
        self.assertFalse(saida.exists())
        self.assertEqual(self.importar(montar()).status_code, 200)
        self.assertFalse(saida.exists())

    def test_atualizar_grava_novo_com_a_d_j_em_branco_e_recusa_d_invalido(self):
        self.importar(montar())
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        url = "/api/sebrae/dashboard/atualizar"
        em_branco = {"numero": "UTIC-2026-1378", "A": "", "D": "", "J": ""}
        resposta = self.post(url, json={"chamados": [em_branco]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        corpo = resposta.json()
        self.assertEqual([(g["numero"], g["tipo"]) for g in corpo["linhas"]], [("UTIC-2026-1378", "novo")])
        self.assertIn("UTIC-2026-1378", [c.numero for c in G.chamados_para_editar(base64.b64decode(corpo["conteudo_base64"]))])
        invalido = self.post(url, json={"chamados": [{**em_branco, "D": "TALVEZ"}]})
        self.assertEqual(invalido.status_code, 422)
        self.assertIn("STATUS", invalido.json()["detail"])
        sem_campos = self.post("/api/sebrae/exportar", json={"chamados": [em_branco]})
        self.assertEqual(sem_campos.status_code, 422)

    def test_atualizar_edita_so_b_de_chamado_antigo_com_d_vazio(self):
        self.importar(montar(("UTIC-2026-0001",), status=("",)))
        url = "/api/sebrae/dashboard/atualizar"
        resposta = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "B": "REDE"}]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual([(g["numero"], g["tipo"], g["celulas"]) for g in resposta.json()["linhas"]], [("UTIC-2026-0001", "alterado", ["B"])])

    def test_atualizar_so_com_preenchimento_automatico_pelo_nome_da_coluna_i(self):
        base = _antes_da_coluna_p(montar(("Sem chamado", "UTIC-2026-0002"), status=("EM ABERTO", "FINALIZADO")), 2, texto("I2", "Camila Lopes"))
        estado = self.importar(base).json()["importado"]
        self.assertEqual([(a["numero"], a["chamado"], a["usuario"]) for a in estado["abertos"]], [("linha:2", "Sem chamado", "Camila Lopes")])
        self.assertEqual(estado["abertos"][0]["automaticos_sugeridos"], {"K": "ABC123", "L": "Dell", "N": "Curitiba", "E": "7303022"})
        resposta = self.post("/api/sebrae/dashboard/atualizar", json={})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual([(g["numero"], g["tipo"], g["celulas"]) for g in resposta.json()["linhas"]], [("linha:2", "alterado", ["E", "K", "L", "N"])])
        nada = self.importar(montar())  # no name in column I: nothing to fill, nothing sent
        self.assertEqual(nada.json()["importado"]["abertos"][0]["automaticos_sugeridos"], {})
        self.assertEqual(self.post("/api/sebrae/dashboard/atualizar", json={}).status_code, 422)

    def test_atualizar_edita_chamado_de_c_composto(self):
        self.importar(montar(("27371 / UTIC-2026-0094",), status=("EM ABERTO",)))
        edicao = {"numero": "UTIC-2026-0094", "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE", "R": "28/10/2026 14:30"}
        resposta = self.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [edicao]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual([(g["numero"], g["tipo"]) for g in resposta.json()["linhas"]], [("UTIC-2026-0094", "alterado")])

    def titulos(self, resposta):
        return {c.numero: c.titulo for c in G.chamados_para_editar(base64.b64decode(resposta.json()["conteudo_base64"]))}

    def test_atualizar_grava_o_titulo_g_digitado_do_chamado_novo_e_em_branco_mantem_o_do_softexpert(self):
        self.importar(montar())
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        url = "/api/sebrae/dashboard/atualizar"
        sem_g = self.post(url, json={"chamados": [MANUAL]})
        self.assertEqual(self.titulos(sem_g)["UTIC-2026-1378"], "Travando")
        em_branco = self.post(url, json={"chamados": [{**MANUAL, "G": "   "}]})
        self.assertEqual(self.titulos(em_branco)["UTIC-2026-1378"], "Travando")
        digitado = self.post(url, json={"chamados": [{**MANUAL, "G": "  Notebook   trava ao ligar "}]})
        self.assertEqual(digitado.status_code, 200, digitado.text)
        self.assertEqual(self.titulos(digitado)["UTIC-2026-1378"], "Notebook trava ao ligar")
        self.assertEqual(self.cliente.get("/api/sebrae/novos").json()["novos"]["formulario"][0]["linha"]["G"], "Travando")  # the stored search stays a pure copy
        com_exportar = self.post("/api/sebrae/exportar", json={"chamados": [{**MANUAL, "G": "Outro título"}]})
        self.assertEqual(com_exportar.json()["bloco_a_p"].split("\t")[6], "Outro título")

    def test_atualizar_grava_o_titulo_g_de_chamado_antigo_preenchido_ou_vazio_e_so_ele_muda(self):
        vazio = _trocar_na_folha(montar(), texto("G2", "titulo UTIC-2026-0001", 112), '<c r="G2" s="112"/>')
        for nome, conteudo, antes in (("preenchido", montar(), "titulo UTIC-2026-0001"), ("vazio", vazio, "")):
            with self.subTest(g=nome):
                self.importar(conteudo)
                resposta = self.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [{"numero": "UTIC-2026-0001", "G": "Impressora sem toner"}]})
                self.assertEqual(resposta.status_code, 200, resposta.text)
                self.assertEqual([(g["numero"], g["tipo"], g["celulas"]) for g in resposta.json()["linhas"]], [("UTIC-2026-0001", "alterado", ["G"])])
                self.assertEqual(self.titulos(resposta)["UTIC-2026-0001"], "Impressora sem toner")
                self.assertEqual(sebrae_novos.ler_existentes(self.caminhos.existentes)["abertos"][0]["titulo"], antes)  # the import is untouched

    def test_atualizar_ignora_o_titulo_g_em_branco_e_o_igual_ao_da_planilha(self):
        self.importar(montar())
        url = "/api/sebrae/dashboard/atualizar"
        em_branco = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "B": "REDE", "G": "  "}]})
        self.assertEqual([g["celulas"] for g in em_branco.json()["linhas"]], [["B"]])
        self.assertEqual(self.titulos(em_branco)["UTIC-2026-0001"], "titulo UTIC-2026-0001")
        igual = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "B": "REDE", "G": "titulo UTIC-2026-0001"}]})
        self.assertEqual([g["celulas"] for g in igual.json()["linhas"]], [["B"]])

    def test_atualizar_mascara_o_titulo_g_e_nunca_o_deixa_virar_formula(self):
        self.importar(montar())
        url = "/api/sebrae/dashboard/atualizar"
        com_dados = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "G": "CPF 123.456.789-09 senha: Segredo123"}]})
        self.assertEqual(com_dados.status_code, 200, com_dados.text)
        titulo = self.titulos(com_dados)["UTIC-2026-0001"]
        self.assertIn("***.***.***-**", titulo)
        self.assertNotIn("123.456.789-09", titulo)
        self.assertNotIn("Segredo123", titulo)
        formula = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "G": "=1+1"}]})
        self.assertEqual(formula.status_code, 200, formula.text)
        self.assertNotIn("<f>", linha_xml(base64.b64decode(formula.json()["conteudo_base64"]), 2).split('<c r="G2"')[1].split("</c>")[0])

    def test_atualizar_recusa_titulo_g_longo_demais_com_422(self):
        self.importar(montar())
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        url = "/api/sebrae/dashboard/atualizar"
        longo = "x" * (sebrae_novos.MAX_TITULO + 1)
        self.assertEqual(self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "G": longo}]}).status_code, 422)
        self.assertEqual(self.post(url, json={"chamados": [{**MANUAL, "G": longo}]}).status_code, 422)
        self.assertEqual(self.post("/api/sebrae/exportar", json={"chamados": [{**MANUAL, "G": longo}]}).status_code, 422)
        limite = "x" * sebrae_novos.MAX_TITULO
        self.assertEqual(self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "G": limite}]}).status_code, 200)

    def descricoes(self, resposta):
        return {c.numero: c.descricao for c in G.chamados_para_editar(base64.b64decode(resposta.json()["conteudo_base64"]))}

    def lapis(self, numero, texto):
        resposta = self.cliente.put(f"/api/sebrae/chamados/{numero}/descricao", json={"descricao": texto})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta

    def importar_com_h(self, h="descricao antiga"):
        self.importar(_antes_da_coluna_p(montar(), 2, texto("H2", h, 112)))

    def test_atualizar_grava_na_coluna_h_a_descricao_editada_no_lapis_do_antigo_so_com_h_ja_basta(self):
        url = "/api/sebrae/dashboard/atualizar"
        for nome, importar in (("h_vazio", lambda: self.importar(montar())), ("h_preenchido", self.importar_com_h)):
            with self.subTest(h=nome):
                importar()
                self.lapis("UTIC-2026-0001", "  Cartucho trocado;   impressora voltou  ")
                resposta = self.post(url, json={})  # só a descrição editada: não pode ser 422 "nada a gravar"
                self.assertEqual(resposta.status_code, 200, resposta.text)
                self.assertEqual([(g["numero"], g["tipo"], g["celulas"]) for g in resposta.json()["linhas"]], [("UTIC-2026-0001", "alterado", ["H"])])
                self.assertEqual(self.descricoes(resposta)["UTIC-2026-0001"], "Cartucho trocado; impressora voltou")
                self.assertEqual(self.titulos(resposta)["UTIC-2026-0001"], "titulo UTIC-2026-0001")  # G untouched
                self.assertEqual(resposta.json()["fechar"]["numeros"], [])
                self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/descricao", json={"descricao": ""})

    def test_atualizar_h_em_branco_ou_igual_nao_apaga_nem_reescreve_e_restaurar_nao_desfaz(self):
        self.importar_com_h()
        url = "/api/sebrae/dashboard/atualizar"
        self.lapis("UTIC-2026-0001", "descricao antiga")  # same text the sheet already has
        igual = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "B": "REDE"}]})
        self.assertEqual([g["celulas"] for g in igual.json()["linhas"]], [["B"]])
        self.assertEqual(self.descricoes(igual)["UTIC-2026-0001"], "descricao antiga")
        restaurada = self.lapis("UTIC-2026-0001", "   ")  # restoring leaves nothing to send and shows the Dashboard text again
        self.assertEqual(restaurada.json()["descricao"], "descricao antiga")
        sem_lapis = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "B": "REDE"}]})
        self.assertEqual([g["celulas"] for g in sem_lapis.json()["linhas"]], [["B"]])
        self.assertEqual(self.descricoes(sem_lapis)["UTIC-2026-0001"], "descricao antiga")
        self.assertEqual(self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "H": "digitado pelo payload"}]}).status_code, 422)  # H só pelo lápis
        self.assertEqual(self.post(url, json={}).status_code, 422)  # nothing edited, nothing to write

    def test_atualizar_mascara_a_descricao_h_e_nunca_a_deixa_virar_formula(self):
        self.importar(montar())
        url = "/api/sebrae/dashboard/atualizar"
        self.lapis("UTIC-2026-0001", "CPF 123.456.789-09 senha: Segredo123")
        com_dados = self.post(url, json={})
        self.assertEqual(com_dados.status_code, 200, com_dados.text)
        descricao = self.descricoes(com_dados)["UTIC-2026-0001"]
        self.assertIn("***.***.***-**", descricao)
        self.assertIn("[DADO SENSÍVEL OMITIDO]", descricao)
        self.assertNotIn("123.456.789-09", descricao)
        self.assertNotIn("Segredo123", descricao)
        self.lapis("UTIC-2026-0001", "=1+1")
        formula = self.post(url, json={})
        self.assertEqual(formula.status_code, 200, formula.text)
        celula = linha_xml(base64.b64decode(formula.json()["conteudo_base64"]), 2).split('<c r="H2"')[1].split("</c>")[0]
        self.assertNotIn("<f>", celula)
        self.assertEqual(self.descricoes(formula)["UTIC-2026-0001"], "=1+1")

    def test_atualizar_grava_titulo_g_e_descricao_h_do_mesmo_antigo_juntos_e_o_novo_so_leva_o_h_do_lapis_na_linha(self):
        self.importar(montar())
        self.lapis("UTIC-2026-0001", "Descrição nova do lápis")
        resposta = self.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [{"numero": "UTIC-2026-0001", "B": "REDE", "G": "Título novo"}]})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual([(g["numero"], g["celulas"]) for g in resposta.json()["linhas"]], [("UTIC-2026-0001", ["B", "G", "H"])])
        self.assertEqual((self.titulos(resposta)["UTIC-2026-0001"], self.descricoes(resposta)["UTIC-2026-0001"]), ("Título novo", "Descrição nova do lápis"))
        self.assertEqual(sebrae_novos.ler_existentes(self.caminhos.existentes)["abertos"][0]["descricao"], "")  # the import is untouched

    def reimportar(self, resposta):
        self.importar(base64.b64decode(resposta.json()["conteudo_base64"]))

    def test_descricao_h_ja_gravada_nao_fica_pendente_para_sempre_depois_de_reimportar(self):
        url = "/api/sebrae/dashboard/atualizar"
        casos = {
            "enter_e_espacos": "linha 1\n\nlinha   2   fim",
            "inicio_de_formula": "-trocar toner",
            "inicio_de_igual": "=1+1 e depois texto",
            "acima_de_2000": "palavra " * 300,
        }
        for nome, digitado in casos.items():
            with self.subTest(caso=nome):
                self.importar(montar())
                self.lapis("UTIC-2026-0001", digitado)
                primeira = self.post(url, json={})
                self.assertEqual(primeira.status_code, 200, primeira.text)
                self.assertEqual([(g["numero"], g["celulas"]) for g in primeira.json()["linhas"]], [("UTIC-2026-0001", ["H"])])
                self.reimportar(primeira)  # the user re-imports the Dashboard that was just sent
                segunda = self.post(url, json={})
                self.assertEqual(segunda.status_code, 422, segunda.text)  # H already there: nothing pending, not even by the 2000-char cut
                self.assertEqual(self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "B": "REDE"}]}).json()["linhas"][0]["celulas"], ["B"])
                self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/descricao", json={"descricao": ""})

    def test_g_e_s_com_inicio_de_formula_nao_voltam_como_alterados_depois_de_reimportar(self):
        url = "/api/sebrae/dashboard/atualizar"
        self.importar(montar())
        edicao = {"numero": "UTIC-2026-0001", "G": "+titulo novo", "S": "-DISPONIBILIDADE"}  # A, B, D and J come from lists, so G and S are the free texts
        primeira = self.post(url, json={"edicoes": [edicao]})
        self.assertEqual(primeira.status_code, 200, primeira.text)
        self.assertEqual(primeira.json()["linhas"][0]["celulas"], ["G", "S"])
        self.reimportar(primeira)
        segunda = self.post(url, json={"edicoes": [edicao]})
        self.assertEqual((segunda.status_code, segunda.json()["linhas"]), (200, []))  # the same values again change nothing

    def test_descricao_editada_de_chamado_antigo_ainda_nao_lido_tambem_vale_e_nao_chega_ao_softexpert(self):
        self.importar_com_h("texto do dashboard")
        self.assertEqual(sebrae_novos.ler_antigos(sebrae_novos.caminho_antigos(self.caminhos)), {})  # never read in the SoftExpert
        resposta = self.lapis("UTIC-2026-0001", "texto do lápis")
        self.assertEqual(resposta.json()["descricao"], "texto do lápis")
        abertos = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}
        self.assertEqual(abertos["UTIC-2026-0001"]["softexpert"]["descricao_editada"], "texto do lápis")
        self.assertEqual(abertos["UTIC-2026-0001"]["descricao"], "texto do dashboard")

    def test_atualizar_recusa_pedido_vazio_sem_importacao_e_copia_adulterada(self):
        vazio = self.post("/api/sebrae/dashboard/atualizar", json={})
        self.assertEqual(vazio.status_code, 422)
        edicao = {"numero": "UTIC-2026-0001", "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        self.assertIn("Importe", self.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [edicao]}).json()["detail"])
        self.importar(montar())
        sebrae_novos.caminho_planilha(self.caminhos).write_bytes(b"outro conteudo")
        adulterada = self.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [edicao]})
        self.assertEqual(adulterada.status_code, 422)
        self.assertIn("importe o Dashboard de novo", adulterada.json()["detail"])

    def test_atualizar_valida_edicao_pela_regra_dos_manuais_e_pelas_listas(self):
        self.importar(montar())
        url = "/api/sebrae/dashboard/atualizar"
        # A, D and J may stay blank after merging (the stored ticket has no J); a filled invalid value is still refused
        sem_j = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "A": "CLIENTE", "D": "FINALIZADO"}]})
        self.assertEqual(sem_j.status_code, 200, sem_j.text)
        j_invalido = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "J": "OUTRO"}]})
        self.assertEqual(j_invalido.status_code, 422)
        self.assertIn("UTIC-2026-0001", j_invalido.json()["detail"])
        finalizado = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0002", "A": "CLIENTE", "D": "X", "J": "INCIDENTE"}]})
        self.assertEqual(finalizado.status_code, 422)
        self.assertIn("EM ABERTO", finalizado.json()["detail"])
        dados = sebrae_novos.ler_existentes(self.caminhos.existentes)
        sebrae_novos.salvar_existentes(
            self.caminhos.existentes, dados["numeros"], dados["arquivo"], sha256=dados["sha256"],
            listas={"A": ["CLIENTE"], "B": ["REDE"]}, abertos=dados["abertos"],
        )
        fora = self.post(url, json={"edicoes": [{"numero": "UTIC-2026-0001", "A": "OUTRO", "D": "FINALIZADO", "J": "INCIDENTE"}]})
        self.assertEqual(fora.status_code, 422)
        self.assertIn("lista do Dashboard", fora.json()["detail"])
        repetido = {"numero": "UTIC-2026-0001", "A": "CLIENTE", "D": "FINALIZADO", "J": "INCIDENTE"}
        self.assertEqual(self.post(url, json={"edicoes": [repetido, repetido]}).status_code, 422)

    def test_atualizar_recusa_novo_que_nao_esta_na_lista_de_novos(self):
        self.importar(montar())
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        resposta = self.post("/api/sebrae/dashboard/atualizar", json={"chamados": [{**MANUAL, "numero": "UTIC-2026-9999"}]})
        self.assertEqual(resposta.status_code, 422)
        self.assertIn("não está entre os chamados novos", resposta.json()["detail"])


class OrdemDaColunaCTest(RotasBase):
    """The F5 lists and the Assistant show the tickets in the order of the Tabela3 sorted by column C ascending."""

    def setUp(self):
        super().setUp()
        total = MAX_ITENS_LISTA + 5
        self.fora_de_ordem = [f"UTIC-2026-{n:04d}" for n in range(total, 0, -1)]  # stored descending
        self.esperados = [f"UTIC-2026-{n:04d}" for n in range(1, total + 1)]
        abertos = [G.ChamadoAberto(c, 2 + i, f"Antigo {c}", {}, chamado=c).como_dict() for i, c in enumerate(self.fora_de_ordem)]
        sebrae_novos.salvar_existentes(self.caminhos.existentes, self.fora_de_ordem, "Dashboard.xlsx", abertos=abertos)
        self.novos = [c.replace("2026", "2027") for c in self.fora_de_ordem]
        sebrae_novos.salvar_novos(self.caminhos.novos, [ChamadoSoftExpert(c, titulo=f"Novo {c}") for c in self.novos], [], 0, {})
        for n, c in enumerate(self.fora_de_ordem):  # the most recently finalized has the highest C
            fin._alterar(fin.pasta_estado(self.caminhos.existentes), f"UTIC-2025-{n:04d}", lambda item, n=n: item.update(
                finalizacao={"status": fin.STATUS_OK, "em": f"2026-10-30T10:00:{n:02d}", "encerrado_em": ""}))
        self.api = SimpressApi(lambda metodo, caminho, params, corpo: self._resposta(caminho))

    def _resposta(self, caminho):
        resposta = self.cliente.get(caminho)
        return resposta.status_code, resposta.json()

    def test_a_tela_recebe_antigos_e_novos_na_ordem_da_coluna_c_e_finalizados_pela_data(self):
        estado = self.cliente.get("/api/sebrae/novos").json()
        self.assertEqual([a["numero"] for a in estado["importado"]["abertos"]], self.esperados)
        self.assertEqual([f["numero"] for f in estado["novos"]["formulario"]], [c.replace("2026", "2027") for c in self.esperados])
        finalizados = [f["numero"] for f in estado["importado"]["finalizados"]]
        self.assertEqual(finalizados, sorted(finalizados, reverse=True))  # the most recently finalized first, not column C
        self.assertEqual(len(finalizados), len(self.esperados))

    def test_o_assistente_corta_as_listas_depois_da_ordem_da_coluna_c(self):
        antigos = self.api.chamados_antigos_abertos_sebrae()
        self.assertEqual([a["numero"] for a in antigos["abertos"]], self.esperados[:MAX_ITENS_LISTA])
        self.assertEqual((antigos["total_abertos"], antigos["omitidos"]), (len(self.esperados), len(self.esperados) - MAX_ITENS_LISTA))
        novos = self.api.chamados_novos_sebrae()
        self.assertEqual([c["numero"] for c in novos["chamados"]], [c.replace("2026", "2027") for c in self.esperados[:MAX_ITENS_LISTA]])

    def test_o_relatorio_de_abertos_do_assistente_segue_a_ordem_da_coluna_c(self):
        relatorio = assistant_relatorios.coletar(self.api, "chamados_sebrae_abertos", "")
        self.assertEqual([linha[0] for linha in relatorio.tabelas[0].linhas], self.esperados)


class ChavesDeLinhaAposOrdenarTest(RotasBase):
    """Atualizar Dashboard sorts by C, so after the sorted file is imported a ``linha:<n>`` ticket sits on another row:
    its observation and destaque must follow the ticket (same C, G, I, H), never a row number."""

    def base(self, g3="Impressora parada", g4="Monitor sem imagem", h3=""):
        """Rows 3 and 4 are "Sem chamado" (no UTIC, keys linha:3 and linha:4); the sort moves them up to rows 2 and 3."""
        conteudo = montar(("UTIC-2026-0003", "Sem chamado", "Sem chamado"), status=("EM ABERTO",) * 3)
        for linha, titulo in ((3, g3), (4, g4)):
            conteudo = _trocar_na_folha(conteudo, texto(f"G{linha}", "titulo Sem chamado"), texto(f"G{linha}", titulo))
        return _antes_da_coluna_p(conteudo, 3, texto("H3", h3)) if h3 else conteudo

    def pasta(self):
        return fin.pasta_estado(self.caminhos.existentes)

    def anotar(self, numero, observacao, destaque=False):
        self.assertEqual(self.cliente.put(f"/api/sebrae/chamados/{numero}/observacao", json={"observacao": observacao}).status_code, 200)
        if destaque:
            self.assertEqual(self.cliente.put(f"/api/sebrae/chamados/{numero}/destaque", json={"destaque": True}).status_code, 200)

    def abertos(self, resposta):
        return {a["titulo"]: a for a in resposta.json()["importado"]["abertos"]}

    def test_observacao_e_destaque_seguem_o_chamado_depois_de_ordenar_e_reimportar(self):
        base = self.base()
        antes = self.abertos(self.importar(base))
        self.assertEqual((antes["Impressora parada"]["numero"], antes["Monitor sem imagem"]["numero"]), ("linha:3", "linha:4"))
        self.anotar("linha:3", "Aguardando peça", destaque=True)
        self.anotar("linha:4", "Trocar o cabo")
        self.anotar("UTIC-2026-0003", "Fica onde está")
        resposta = self.importar(G.atualizar(base).conteudo)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertNotIn("aviso", resposta.json())
        depois = self.abertos(resposta)
        self.assertEqual((depois["Impressora parada"]["numero"], depois["Monitor sem imagem"]["numero"]), ("linha:2", "linha:3"))
        self.assertEqual((depois["Impressora parada"]["observacao"], depois["Impressora parada"]["destaque"]), ("Aguardando peça", True))
        self.assertEqual((depois["Monitor sem imagem"]["observacao"], depois["Monitor sem imagem"]["destaque"]), ("Trocar o cabo", False))
        self.assertEqual(depois["titulo UTIC-2026-0003"]["observacao"], "Fica onde está")
        self.assertEqual(sorted(obs.ler_observacoes(self.pasta())), ["UTIC-2026-0003", "linha:2", "linha:3"])  # nothing left on linha:4

    def test_titulo_editado_no_site_nao_faz_a_observacao_e_o_destaque_se_perderem(self):
        base = self.base(h3="Trava ao ligar")  # row 3 has its own H, so (C, I, H) is unique even after G changes
        self.importar(base)
        self.anotar("linha:3", "Aguardando peça", destaque=True)
        self.anotar("linha:4", "Trocar o cabo")
        editado = self.post("/api/sebrae/dashboard/atualizar", json={"edicoes": [{"numero": "linha:3", "G": "Impressora da sala 4"}]})
        self.assertEqual(editado.status_code, 200, editado.text)
        resposta = self.importar(base64.b64decode(editado.json()["conteudo_base64"]))
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertNotIn("aviso", resposta.json())
        depois = self.abertos(resposta)
        self.assertEqual((depois["Impressora da sala 4"]["numero"], depois["Monitor sem imagem"]["numero"]), ("linha:2", "linha:3"))
        self.assertEqual((depois["Impressora da sala 4"]["observacao"], depois["Impressora da sala 4"]["destaque"]), ("Aguardando peça", True))
        self.assertEqual(depois["Monitor sem imagem"]["observacao"], "Trocar o cabo")
        self.assertEqual(sorted(obs.ler_observacoes(self.pasta())), ["linha:2", "linha:3"])

    def test_mascara_do_cpf_na_descricao_nao_atrapalha_o_acompanhamento(self):
        base = self.base(h3="CPF 123.456.789-09 senha: Segredo123")
        self.importar(base)
        self.anotar("linha:3", "Com CPF na descrição")
        resposta = self.importar(G.atualizar(base).conteudo)
        self.assertNotIn("aviso", resposta.json())
        self.assertEqual(self.abertos(resposta)["Impressora parada"]["observacao"], "Com CPF na descrição")
        self.assertNotIn("123.456.789-09", self.caminhos.existentes.read_text(encoding="utf-8"))

    def test_chamado_repetido_nao_e_adivinhado_e_o_aviso_diz_qual(self):
        base = self.base(g3="Mesmo título", g4="Mesmo título")  # same C, G, I and H: no way to tell which is which
        self.importar(base)
        self.anotar("linha:3", "Não sei de qual dos dois")
        self.anotar("UTIC-2026-0003", "Fica onde está")
        resposta = self.importar(G.atualizar(base).conteudo)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertIn("linha:3", resposta.json()["aviso"])
        self.assertNotIn("linha:4", resposta.json()["aviso"])  # no entry there: nothing was lost
        self.assertEqual(sorted(obs.ler_observacoes(self.pasta())), ["UTIC-2026-0003", "linha:3"])  # left alone
        self.assertEqual(obs.ler_observacoes(self.pasta())["linha:3"]["observacao"], "Não sei de qual dos dois")

    def test_chamado_que_saiu_da_planilha_fica_com_aviso(self):
        base = self.base()
        self.importar(base)
        self.anotar("linha:4", "Era do monitor")
        sem_o_monitor = G.atualizar(self.base(g4="Outro chamado")).conteudo  # nothing in the new sheet has the old content of row 4
        resposta = self.importar(sem_o_monitor)
        self.assertIn("linha:4", resposta.json()["aviso"])
        self.assertEqual(obs.ler_observacoes(self.pasta())["linha:4"]["observacao"], "Era do monitor")

    def test_reimportar_sem_mudar_a_ordem_nao_mexe_nas_observacoes_nem_avisa(self):
        ordenada = G.atualizar(self.base()).conteudo
        self.assertNotIn("aviso", self.importar(ordenada).json())  # first import: nothing before it
        self.anotar("linha:2", "Impressora", destaque=True)
        antes = obs.caminho_observacoes(self.pasta()).read_bytes()
        resposta = self.importar(ordenada)
        self.assertNotIn("aviso", resposta.json())
        self.assertEqual(obs.caminho_observacoes(self.pasta()).read_bytes(), antes)

    def test_falha_ao_mover_nao_derruba_a_importacao_ja_guardada_e_avisa(self):
        for erro in (DomainBusyError("ocupado"), PermissionError("antivírus segurando o arquivo")):
            with self.subTest(erro=type(erro).__name__):
                self.setUp()  # a fresh state directory for each error
                base = self.base()
                self.importar(base)
                self.anotar("linha:3", "Aguardando peça")
                with patch.object(obs, "acompanhar_chaves", side_effect=erro):
                    resposta = self.importar(G.atualizar(base).conteudo)
                self.assertEqual(resposta.status_code, 200, resposta.text)
                self.assertIn("Não consegui mover", resposta.json()["aviso"])
                self.assertEqual(sebrae_novos.ler_existentes(self.caminhos.existentes)["abertos"][0]["numero"], "linha:2")  # the new Dashboard is the stored one
                self.assertEqual(obs.ler_observacoes(self.pasta())["linha:3"]["observacao"], "Aguardando peça")  # and the old entry is untouched


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

    def test_finalizado_no_softexpert_vai_para_finalizados_na_hora_com_a_ficha(self):
        from domains import sebrae_finalizacao as fin
        self.importar(montar())
        self.assertEqual(self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/ficha", json={"ficha": {"titulo": "T"}}).status_code, 200)
        fin.registrar_finalizacao(fin.pasta_estado(self.caminhos.existentes), "UTIC-2026-0001", fin.STATUS_OK, "30/10/2026 14:05")
        depois = self.cliente.get("/api/sebrae/novos").json()["importado"]  # D ainda EM ABERTO no Dashboard importado
        self.assertEqual([f["numero"] for f in depois["finalizados"]], ["UTIC-2026-0001"])
        self.assertEqual(depois["finalizados"][0]["ficha"], {"titulo": "T"})

    def test_abertos_trazem_leitura_softexpert_e_cruzam_pelo_que_ela_leu(self):
        self.importar(montar())
        antes = self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]
        self.assertTrue(antes)
        self.assertTrue(all(a["leitura_softexpert"] is None for a in antes))
        alvo = antes[0]["numero"]
        sebrae_novos.salvar_antigo(
            sebrae_novos.caminho_antigos(self.caminhos),
            ChamadoSoftExpert(alvo, titulo="Travando", descricao="Notebook de Camila Lopes", solicitante="API SEBRAE"), "agora",
        )
        depois = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}
        self.assertEqual(depois[alvo]["leitura_softexpert"], {
            "titulo": "Travando", "descricao": "Notebook de Camila Lopes", "solicitante": "API SEBRAE",
            "habilitada_em": "", "atendimento": "", "lido_em": "agora",
        })
        self.assertEqual(depois[alvo]["automaticos_sugeridos"].get("K"), "ABC123")
        self.assertEqual(depois[alvo]["nome_da_descricao"], "Camila Lopes")
        self.assertEqual(depois[alvo]["titulo"], antes[0]["titulo"])  # o título do Dashboard não é sobrescrito
        self.assertEqual(depois[alvo]["descricao"], antes[0]["descricao"])
        self.assertIn("softexpert", depois[alvo])  # estado de finalização, inalterado

    def test_atualizar_grava_o_mesmo_que_a_tela_sugere_pela_leitura_softexpert(self):
        # UTIC-2026-0833: title typed into H, G and I empty; SoftExpert has title, description and requester
        base = _trocar_na_folha(montar(("UTIC-2026-0001", "UTIC-2026-0002")), texto("G2", "titulo UTIC-2026-0001"), "")
        self.importar(_antes_da_coluna_p(base, 2, texto("H2", "Travando")))
        sebrae_novos.salvar_antigo(
            sebrae_novos.caminho_antigos(self.caminhos),
            ChamadoSoftExpert("UTIC-2026-0001", titulo="Travando", descricao="Notebook de Camila Lopes", solicitante="API SEBRAE"), "agora",
        )
        tela = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}["UTIC-2026-0001"]
        self.assertEqual(tela["automaticos_sugeridos"], {
            "G": "Travando", "H": "Notebook de Camila Lopes", "I": "API SEBRAE", "K": "ABC123", "L": "Dell", "N": "Curitiba", "E": "7303022",
        })
        resposta = self.post("/api/sebrae/dashboard/atualizar", json={})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual([(g["numero"], g["celulas"]) for g in resposta.json()["linhas"]], [("UTIC-2026-0001", sorted(tela["automaticos_sugeridos"]))])
        gravado = G.chamados_para_editar(base64.b64decode(resposta.json()["conteudo_base64"]))[0]
        self.assertEqual((gravado.titulo, gravado.descricao, gravado.usuario, gravado.automaticos["K"]),
                         ("Travando", "Notebook de Camila Lopes", "API SEBRAE", "ABC123"))

    def test_antigo_nao_encontrado_na_ultima_leitura_vem_marcado_ate_ser_lido(self):
        self.importar(montar())
        alvo = self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"][0]["numero"]
        sebrae_novos.salvar_resultado_antigos(self.caminhos, {"falhas": {alvo: "não está na lista"}, "nao_encontrados": [alvo]})
        abertos = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}
        self.assertTrue(abertos[alvo]["nao_encontrado_softexpert"])
        self.assertFalse(any(a["nao_encontrado_softexpert"] for n, a in abertos.items() if n != alvo))
        sebrae_novos.salvar_antigo(sebrae_novos.caminho_antigos(self.caminhos), ChamadoSoftExpert(alvo, titulo="Achou"), "agora")
        depois = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}
        self.assertFalse(depois[alvo]["nao_encontrado_softexpert"])  # lido depois: a marca some

    def test_ficha_recusa_corpo_invalido(self):
        self.importar(montar())
        self.assertEqual(self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/ficha", json={"ficha": "texto"}).status_code, 422)

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

    def test_observacoes_put_get_e_presenca_no_estado(self):
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        self.importar(montar())

        # Testar PUT com UTIC de chamado aberto
        resp1 = self.cliente.put(
            "/api/sebrae/chamados/UTIC-2026-0001/observacao",
            json={"observacao": "Aguardando retorno do usuário."},
        )
        self.assertEqual(resp1.status_code, 200)
        self.assertEqual(resp1.json()["numero"], "UTIC-2026-0001")
        self.assertEqual(resp1.json()["observacao"], "Aguardando retorno do usuário.")
        self.assertEqual(resp1.headers.get("cache-control"), "no-store")

        # Testar PUT com UTIC de chamado novo
        resp_novo = self.cliente.put(
            "/api/sebrae/chamados/UTIC-2026-1378/observacao",
            json={"observacao": "Chamado novo em triagem."},
        )
        self.assertEqual(resp_novo.status_code, 200)
        self.assertEqual(resp_novo.json()["numero"], "UTIC-2026-1378")
        self.assertEqual(resp_novo.json()["observacao"], "Chamado novo em triagem.")

        # Testar PUT com linha:N (antigo sem UTIC)
        resp2 = self.cliente.put(
            "/api/sebrae/chamados/linha:15/observacao",
            json={"observacao": "Chamado antigo sem UTIC."},
        )
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(resp2.json()["numero"], "linha:15")
        self.assertEqual(resp2.json()["observacao"], "Chamado antigo sem UTIC.")

        # Testar validações
        self.assertEqual(self.cliente.put("/api/sebrae/chamados/invalido/observacao", json={"observacao": "x"}).status_code, 422)
        self.assertEqual(self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/observacao", json={"observacao": "a" * 4001}).status_code, 422)

        # Testar GET /api/sebrae/observacoes
        resp_lista = self.cliente.get("/api/sebrae/observacoes")
        self.assertEqual(resp_lista.status_code, 200)
        obs_map = resp_lista.json()["observacoes"]
        self.assertEqual(obs_map["UTIC-2026-0001"]["observacao"], "Aguardando retorno do usuário.")
        self.assertEqual(obs_map["UTIC-2026-1378"]["observacao"], "Chamado novo em triagem.")
        self.assertEqual(obs_map["linha:15"]["observacao"], "Chamado antigo sem UTIC.")

        # Testar presença em GET /api/sebrae/novos
        estado = self.cliente.get("/api/sebrae/novos").json()
        abertos = estado["importado"]["abertos"]
        aberto_alvo = next((a for a in abertos if a["numero"] == "UTIC-2026-0001"), None)
        self.assertIsNotNone(aberto_alvo)
        self.assertEqual(aberto_alvo["observacao"], "Aguardando retorno do usuário.")

        formulario = estado["novos"]["formulario"]
        novo_alvo = next((n for n in formulario if n["numero"] == "UTIC-2026-1378"), None)
        self.assertIsNotNone(novo_alvo)
        self.assertEqual(novo_alvo["observacao"], "Chamado novo em triagem.")

        # Testar limpeza com string vazia
        resp_limpar = self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/observacao", json={"observacao": ""})
        self.assertEqual(resp_limpar.status_code, 200)
        self.assertEqual(resp_limpar.json()["observacao"], "")
        obs_depois = self.cliente.get("/api/sebrae/observacoes").json()["observacoes"]
        self.assertNotIn("UTIC-2026-0001", obs_depois)

    def test_destaque_put_listas_e_finalizado(self):
        from domains import sebrae_finalizacao as fin
        sebrae_novos.salvar_novos(self.caminhos.novos, [CHAMADO], [], 0, {})
        self.importar(montar())
        url = "/api/sebrae/chamados/{}/destaque"

        resp = self.cliente.put(url.format("UTIC-2026-0001"), json={"destaque": True})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("cache-control"), "no-store")
        corpo = resp.json()
        self.assertEqual(set(corpo), {"numero", "destaque", "destaque_em"})
        self.assertEqual((corpo["numero"], corpo["destaque"]), ("UTIC-2026-0001", True))
        self.assertTrue(corpo["destaque_em"])
        self.assertEqual(self.cliente.put(url.format("UTIC-2026-1378"), json={"destaque": True}).status_code, 200)

        mapa = self.cliente.get("/api/sebrae/observacoes").json()["observacoes"]
        self.assertEqual(mapa["UTIC-2026-0001"], {"observacao": "", "atualizado_em": "", "destaque": True, "destaque_em": corpo["destaque_em"]})

        # salvar e apagar o texto não derruba o destaque
        self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/observacao", json={"observacao": "Nota"})
        self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/observacao", json={"observacao": ""})
        self.assertTrue(self.cliente.get("/api/sebrae/observacoes").json()["observacoes"]["UTIC-2026-0001"]["destaque"])

        estado = self.cliente.get("/api/sebrae/novos").json()
        abertos = {a["numero"]: a for a in estado["importado"]["abertos"]}
        self.assertIs(abertos["UTIC-2026-0001"]["destaque"], True)
        self.assertTrue(all(isinstance(a["destaque"], bool) for a in abertos.values()))
        formulario = {n["numero"]: n for n in estado["novos"]["formulario"]}
        self.assertIs(formulario["UTIC-2026-1378"]["destaque"], True)

        # chamado finalizado também pode ser destacado
        self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/ficha", json={"ficha": {"titulo": "T"}})
        fin.registrar_finalizacao(fin.pasta_estado(self.caminhos.existentes), "UTIC-2026-0001", fin.STATUS_OK, "30/10/2026 14:05")
        finalizados = self.cliente.get("/api/sebrae/novos").json()["importado"]["finalizados"]
        self.assertEqual([(f["numero"], f["destaque"]) for f in finalizados], [("UTIC-2026-0001", True)])
        self.assertIs(self.cliente.put(url.format("UTIC-2026-0001"), json={"destaque": False}).json()["destaque"], False)
        finalizados = self.cliente.get("/api/sebrae/novos").json()["importado"]["finalizados"]
        self.assertEqual([(f["numero"], f["destaque"]) for f in finalizados], [("UTIC-2026-0001", False)])
        self.assertNotIn("UTIC-2026-0001", self.cliente.get("/api/sebrae/observacoes").json()["observacoes"])

    def test_destaque_recusa_numero_e_payload_invalidos(self):
        self.assertEqual(self.cliente.put("/api/sebrae/chamados/invalido/destaque", json={"destaque": True}).status_code, 422)
        for corpo in ({}, {"destaque": "sim"}, {"destaque": True, "extra": 1}):
            with self.subTest(corpo=corpo):
                self.assertEqual(self.cliente.put("/api/sebrae/chamados/UTIC-2026-0001/destaque", json=corpo).status_code, 422)
        self.assertEqual(self.cliente.get("/api/sebrae/observacoes").json()["observacoes"], {})


class DescricaoOpenApiTest(RotasBase):
    def test_rotas_de_gravacao_mantem_descricao_no_openapi(self):
        caminhos = self.cliente.app.openapi()["paths"]
        for url in ("/api/sebrae/dashboard/atualizar", "/api/sebrae/finalizar-softexpert"):
            with self.subTest(url=url):
                self.assertTrue(caminhos[url]["post"].get("description"))


class SugestaoDeCategoriaNosNovosTest(RotasBase):
    """``sugestao_categoria`` e ``sugestao_tipo`` de cada item de ``novos.formulario``: só exibição, nada é gravado."""

    LISTA_B = ["INSTALAÇÃO", "PERIFÉRICO", "OUTRO"]

    def novos(self, *chamados):
        with patch.object(G, "ler_listas", return_value={"B": self.LISTA_B}):
            self.assertEqual(self.importar(montar()).status_code, 200)
        (self.dir / sebrae_categoria.ARQUIVO_INDICE).unlink(missing_ok=True)  # a importação cria um índice mínimo: aqui só valem as regras
        sebrae_novos.salvar_novos(self.caminhos.novos, list(chamados), [], 0, {})

    def itens(self):
        resposta = self.cliente.get("/api/sebrae/novos")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return {item["numero"]: item for item in resposta.json()["novos"]["formulario"]}

    def test_mouse_que_parou_e_periferico_incidente(self):
        self.novos(ChamadoSoftExpert("UTIC-2026-1401", titulo="Mouse sem fio parou", descricao="", solicitante="Camila Lopes"))
        item = self.itens()["UTIC-2026-1401"]
        self.assertEqual((item["sugestao_categoria"], item["sugestao_tipo"]), ("PERIFÉRICO", "INCIDENTE"))

    def test_pedido_de_instalacao_e_solicitacao(self):
        self.novos(ChamadoSoftExpert("UTIC-2026-1402", titulo="Instalar Adobe Reader", descricao="", solicitante="Camila Lopes"))
        self.assertEqual(self.itens()["UTIC-2026-1402"]["sugestao_tipo"], "SOLICITAÇÃO")

    def test_b_ou_j_ja_preenchido_nao_recebe_sugestao(self):
        self.novos(ChamadoSoftExpert("UTIC-2026-1403", titulo="Mouse sem fio parou", descricao="", solicitante="Camila Lopes"))
        original = sebrae_novos.formulario

        def com_campos(preenchidos):
            return lambda *args, **kwargs: [{**item, "linha": {**item["linha"], **preenchidos}} for item in original(*args, **kwargs)]

        for preenchidos, esperado in (({"B": "REDE"}, (None, "INCIDENTE")), ({"J": "SOLICITAÇÃO"}, ("PERIFÉRICO", None))):
            with self.subTest(preenchidos=preenchidos), patch.object(sebrae_novos, "formulario", side_effect=com_campos(preenchidos)):
                item = self.itens()["UTIC-2026-1403"]
                self.assertEqual((item["sugestao_categoria"], item["sugestao_tipo"]), esperado)

    def test_solicitante_do_sistema_nunca_recebe_sugestao(self):
        self.novos(ChamadoSoftExpert("UTIC-2026-1404", titulo="Mouse sem fio parou", descricao="", solicitante="API SEBRAE"))
        item = self.itens()["UTIC-2026-1404"]
        self.assertEqual((item["sugestao_categoria"], item["sugestao_tipo"]), (None, None))

    def test_sem_arquivo_de_indice_a_lista_continua_e_as_regras_valem(self):
        self.novos(ChamadoSoftExpert("UTIC-2026-1405", titulo="Mouse sem fio parou", descricao="", solicitante="Camila Lopes"))
        self.assertFalse((self.dir / sebrae_categoria.ARQUIVO_INDICE).exists())
        self.assertEqual(self.itens()["UTIC-2026-1405"]["sugestao_categoria"], "PERIFÉRICO")

    def test_indice_corrompido_ou_ilegivel_nao_derruba_a_lista(self):
        self.novos(ChamadoSoftExpert("UTIC-2026-1408", titulo="Mouse sem fio parou", descricao="", solicitante="Camila Lopes"))
        caminho = self.dir / sebrae_categoria.ARQUIVO_INDICE
        caminho.write_text("{", encoding="utf-8")  # JSON inválido
        self.assertEqual(self.itens()["UTIC-2026-1408"]["sugestao_categoria"], "PERIFÉRICO")
        caminho.unlink()
        caminho.mkdir()  # "ler" uma pasta falha com OSError
        self.assertEqual(self.itens()["UTIC-2026-1408"]["sugestao_categoria"], "PERIFÉRICO")

    def test_categoria_nova_entra_nas_opcoes_mesmo_fora_da_lista_b(self):
        self.novos(ChamadoSoftExpert("UTIC-2026-1406", titulo="Impressora parou", descricao="", solicitante="Camila Lopes"))
        self.assertEqual(self.itens()["UTIC-2026-1406"]["sugestao_categoria"], "IMPRESSORA")

    def test_ia_conhece_solicitante_representante_e_usuario_dos_abertos_antes_de_perguntar(self):
        base = _antes_da_coluna_p(montar(("Sem chamado", "UTIC-2026-0002"), status=("EM ABERTO", "FINALIZADO")), 2, texto("I2", "Camila Lopes"))
        with patch.object(G, "ler_listas", return_value={"B": self.LISTA_B}):
            self.assertEqual(self.importar(base).status_code, 200)
        sebrae_novos.salvar_novos(self.caminhos.novos, [ChamadoSoftExpert("UTIC-2026-1409", titulo="Assunto", descricao="", solicitante="Bruno Tavares")], [], 0, {})
        registrados = []

        class Falso:
            def registrar_nomes(self, nomes):
                registrados.extend(nomes)

            def sugerir(self, *args):
                return None

        with patch.object(sebrae_categoria_ia, "criar", return_value=Falso()):
            self.itens()
        for nome in ("Bruno Tavares", "Camila Lopes", "Fernanda Colla Borretto"):
            self.assertIn(nome, registrados)

    def test_falha_da_sugestao_nao_derruba_a_lista_e_so_o_tipo_vai_ao_log(self):
        self.novos(ChamadoSoftExpert("UTIC-2026-1407", titulo="Mouse sem fio parou", descricao="texto-secreto-do-chamado", solicitante="Camila Lopes"))
        with patch.object(sebrae_categoria, "sugerir", side_effect=RuntimeError("texto-secreto-do-chamado")):
            with self.assertLogs("routers.sebrae_dashboard", level="WARNING") as registro:
                item = self.itens()["UTIC-2026-1407"]
        self.assertEqual((item["sugestao_categoria"], item["sugestao_tipo"]), (None, None))
        self.assertEqual(item["numero"], "UTIC-2026-1407")
        saida = "\n".join(registro.output)
        self.assertIn("RuntimeError", saida)
        self.assertNotIn("texto-secreto-do-chamado", saida)


class EncerramentoDeNaoEncontradoTest(RotasBase):
    """D=FINALIZADO à mão num antigo não encontrado no SoftExpert exige a DT ENCERRAMENTO (R) no "Atualizar"."""

    ALVO = "UTIC-2026-0001"
    ATUALIZAR = "/api/sebrae/dashboard/atualizar"
    MENSAGEM = "Informe a DT ENCERRAMENTO (coluna R) do chamado UTIC-2026-0001: ele não foi encontrado no SoftExpert."
    R_1405 = r'<c r="R\d+"[^>]*><v>46325\.586'

    def preparar(self, nao_encontrado=True, conteudo=None):
        self.assertEqual(self.importar(montar() if conteudo is None else conteudo).status_code, 200)
        if nao_encontrado:
            sebrae_novos.salvar_resultado_antigos(self.caminhos, {"falhas": {self.ALVO: "não está na lista"}, "nao_encontrados": [self.ALVO]})

    def atualizar(self, **campos):
        return self.post(self.ATUALIZAR, json={"edicoes": [{"numero": self.ALVO, **campos}]})

    def linha_gravada(self, resposta):
        return linha_xml(base64.b64decode(resposta.json()["conteudo_base64"]), 2)

    def test_recusa_finalizado_sem_r_num_antigo_nao_encontrado_e_nao_grava_a_saida(self):
        self.preparar()
        resposta = self.atualizar(D="FINALIZADO")
        self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertEqual(resposta.json()["detail"], self.MENSAGEM)
        self.assertFalse(sebrae_novos.caminho_saida(self.caminhos, "Dashboard Operacional_SEBRAE.xlsx").exists())

    def test_recusa_tambem_com_r_enviado_em_branco(self):
        self.preparar()
        self.assertEqual(self.atualizar(D="FINALIZADO", R="   ").status_code, 422)

    def test_aceita_e_grava_o_r_quando_ele_vem_junto(self):
        self.preparar()
        resposta = self.atualizar(D="FINALIZADO", R="30/10/2026 14:05")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertIn("FINALIZADO", self.linha_gravada(resposta))
        self.assertRegex(self.linha_gravada(resposta), self.R_1405)

    def test_aceita_sem_r_quando_a_linha_ja_guarda_o_r(self):
        base = _trocar_na_folha(montar(), '<c r="T2"', '<c r="R2" s="92"><v>46325.586</v></c><c r="T2"')
        self.preparar(conteudo=base)
        resposta = self.atualizar(D="FINALIZADO")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertRegex(self.linha_gravada(resposta), self.R_1405)

    def test_aceita_sem_r_quando_a_leitura_do_softexpert_achou_o_chamado(self):
        self.preparar()
        sebrae_novos.salvar_antigo(sebrae_novos.caminho_antigos(self.caminhos), ChamadoSoftExpert(self.ALVO, titulo="Achou"), "agora")
        self.assertEqual(self.atualizar(D="FINALIZADO").status_code, 200)

    def test_aceita_sem_r_quando_o_chamado_nunca_foi_lido(self):
        self.preparar(nao_encontrado=False)
        self.assertEqual(self.atualizar(D="FINALIZADO").status_code, 200)

    def test_aceita_sem_r_quando_d_nao_e_finalizado(self):
        self.preparar()
        self.assertEqual(self.atualizar(D="EM ABERTO", B="LENTIDÃO").status_code, 200)

    def test_so_o_chamado_nao_encontrado_e_barrado_numa_lista_com_outros(self):
        self.assertEqual(self.importar(montar(("UTIC-2026-0001", "UTIC-2026-0002"), status=("EM ABERTO", "EM ABERTO"))).status_code, 200)
        sebrae_novos.salvar_resultado_antigos(self.caminhos, {"falhas": {self.ALVO: "não está na lista"}, "nao_encontrados": [self.ALVO]})
        outro = self.post(self.ATUALIZAR, json={"edicoes": [{"numero": "UTIC-2026-0002", "D": "FINALIZADO"}]})
        self.assertEqual(outro.status_code, 200, outro.text)
        self.assertEqual(self.atualizar(D="FINALIZADO").status_code, 422)


if __name__ == "__main__":
    unittest.main()
