import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from core.errors import DomainError
from domains import sebrae_novos
from domains.sebrae_chamados import ChamadoSoftExpert
from routers.sebrae_dashboard import SebraeDashboardServices, create_sebrae_dashboard_router
from tests.test_sebrae_dashboard import CABECALHO, planilha

CHAMADO = ChamadoSoftExpert(
    "UTIC-2026-1378", titulo="Travando", descricao="Meu notebook trava", solicitante="Camila Lopes",
    habilitada_em="26/10/2026, 17:25:23", detalhes_atendimento_realizado="Encaminhado",
)
REGISTROS = [{"nome": "Camila Lopes", "serie": "ABC123", "modelo": "Dell", "cidade": "Curitiba"}]
MANUAL = {"numero": "UTIC-2026-1378", "A": "CLIENTE", "B": "LENTIDÃO", "D": "EM ABERTO", "J": "INCIDENTE", "R": "", "S": "DISPONIBILIDADE"}


class RotasSebraeTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
