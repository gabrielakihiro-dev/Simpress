import base64
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from core.errors import DomainConflictError, DomainError
from domains import sebrae_finalizacao as fin
from domains import sebrae_novos
from domains.sebrae_chamados import ChamadoSoftExpert
from routers.sebrae_dashboard import SebraeDashboardServices, create_sebrae_dashboard_router
from tests.test_sebrae_dashboard_gravacao import linha_xml, montar

A, B, C = "UTIC-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003"
PDF = b"%PDF-1.4\n%fake\n"
R_1405 = r'<c r="R\d+"[^>]*><v>46325\.586'
ATUALIZAR = "/api/sebrae/dashboard/atualizar"
FINALIZAR = "/api/sebrae/finalizar-softexpert"
REENVIAR = "/api/sebrae/dashboard/pendente/reenviar"


class RunnerFalso:
    def __init__(self):
        self.iniciadas = []
        self.erro = None
        self.estado = {"estado": "livre"}

    def start(self, rotina):
        if self.erro is not None:
            raise self.erro
        self.iniciadas.append(rotina)
        return {"estado": "em_andamento", "rotina": rotina}

    def state(self):
        return self.estado


class FinalizarBase(unittest.TestCase):
    com_runner = True

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.caminhos = sebrae_novos.caminhos_padrao(self.dir)
        self.limite = 10 * 1024 * 1024
        self.runner = RunnerFalso()
        app = FastAPI()

        @app.exception_handler(DomainError)
        async def erro(_request, error):
            return JSONResponse({"detail": error.detail}, status_code=error.status_code)

        app.include_router(create_sebrae_dashboard_router(SebraeDashboardServices(
            caminhos=lambda: self.caminhos, max_upload_bytes=lambda: self.limite, registros=lambda: [],
            relatorio_chamados=lambda: {"chamados": []}, runner=(lambda: self.runner) if self.com_runner else None,
        )))
        self.cliente = TestClient(app)

    def importar(self, conteudo=None):
        conteudo = montar((A, B, C), ultima=9, status=("EM ABERTO", "EM ABERTO", "FINALIZADO")) if conteudo is None else conteudo
        resposta = self.cliente.post("/api/sebrae/dashboard", files={"file": ("Dashboard.xlsx", conteudo, "application/octet-stream")})
        self.assertEqual(resposta.status_code, 200, resposta.text)

    def descrever(self, *numeros):
        for numero in numeros:
            fin.definir_descricao(self.dir, numero, f"feito {numero}")

    def job(self):
        return fin.consumir_job(self.dir)


class DescricaoEAnexoTest(FinalizarBase):
    def setUp(self):
        super().setUp()
        self.importar()

    def put(self, numero, texto):
        return self.cliente.put(f"/api/sebrae/chamados/{numero}/finalizacao", json={"descricao_finalizacao": texto})

    def test_descricao_fica_guardada_e_aparece_no_estado_do_chamado(self):
        resposta = self.put(A, "Troquei o cabo")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["descricao_finalizacao"], "Troquei o cabo")
        abertos = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}
        self.assertEqual(abertos[A]["softexpert"]["descricao_finalizacao"], "Troquei o cabo")
        self.assertEqual(abertos[B]["softexpert"], {"descricao_finalizacao": "", "pdf": None, "finalizacao": None})
        self.assertEqual(self.put(A, "").json()["descricao_finalizacao"], "")

    def test_descricao_recusa_texto_grande_chamado_fechado_numero_ruim_e_campo_extra(self):
        self.assertEqual(self.put(A, "x" * 4001).status_code, 422)
        self.assertEqual(self.put(C, "x").status_code, 422)  # FINALIZADO no Dashboard: não está entre os abertos
        self.assertEqual(self.put("UTIC-2026-9999", "x").status_code, 422)
        self.assertEqual(self.put("abc", "x").status_code, 422)
        extra = self.cliente.put(f"/api/sebrae/chamados/{A}/finalizacao", json={"descricao_finalizacao": "x", "z": 1})
        self.assertEqual(extra.status_code, 422)
        self.assertEqual(fin.ler_estado(self.dir), {})

    def anexo(self, nome="laudo.pdf", dados=PDF, numero=A):
        return self.cliente.post(f"/api/sebrae/chamados/{numero}/anexo", files={"file": (nome, dados, "application/pdf")})

    def test_anexo_pdf_e_guardado_substituido_e_removido(self):
        resposta = self.anexo()
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["pdf"], {"nome": "laudo.pdf", "tamanho": len(PDF)})
        self.assertEqual(fin.dados_para_finalizar(self.dir, A)[1].read_bytes(), PDF)
        self.anexo("outro.pdf", PDF + b"1")
        self.assertEqual(fin.dados_para_finalizar(self.dir, A)[1].name, "outro.pdf")
        apagado = self.cliente.delete(f"/api/sebrae/chamados/{A}/anexo")
        self.assertEqual(apagado.status_code, 200)
        self.assertIsNone(apagado.json()["pdf"])
        self.assertIsNone(fin.dados_para_finalizar(self.dir, A)[1])

    def test_anexo_recusa_assinatura_extensao_vazio_tamanho_e_chamado_fechado(self):
        self.assertEqual(self.anexo(dados=b"MZ not a pdf").status_code, 422)
        self.assertEqual(self.anexo("a.txt").status_code, 422)
        self.assertEqual(self.anexo(dados=b"").status_code, 422)
        self.assertEqual(self.anexo(numero=C).status_code, 422)
        self.limite = 8
        self.assertEqual(self.anexo().status_code, 413)
        self.assertIsNone(fin.dados_para_finalizar(self.dir, A)[1])

    def test_nome_com_pasta_nunca_sai_da_pasta_do_chamado(self):
        resposta = self.anexo("../../../fora.pdf")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["pdf"]["nome"], "fora.pdf")
        caminho = fin.dados_para_finalizar(self.dir, A)[1]
        self.assertEqual(caminho.parent, fin.pasta_anexos(self.dir, A))
        self.assertFalse((self.dir.parent / "fora.pdf").exists())


class FinalizarUmTest(FinalizarBase):
    def setUp(self):
        super().setUp()
        self.importar()

    def test_dispara_a_rotina_fechar_com_o_pedido_de_um_chamado(self):
        self.descrever(A)
        resposta = self.cliente.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 202, resposta.text)
        self.assertEqual(resposta.json(), {"iniciado": True, "numeros": [A]})
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        job = self.job()
        self.assertEqual((job["acao"], job["numeros"], job["confirmar_final"]), (fin.ACAO_FINALIZAR, [A], True))

    def test_sem_confirmado_nada_e_disparado(self):
        self.descrever(A)
        for corpo in ({"numero": A}, {"numero": A, "confirmado": False}):
            resposta = self.cliente.post(FINALIZAR, json=corpo)
            self.assertEqual(resposta.status_code, 422, resposta.text)
            self.assertIn("Confirme", resposta.json()["detail"])
        self.assertEqual(self.runner.iniciadas, [])
        self.assertIsNone(self.job())

    def test_recusa_sem_descricao_chamado_fechado_numero_ruim_e_campo_extra_sem_disparar(self):
        self.assertEqual(self.cliente.post(FINALIZAR, json={"numero": A, "confirmado": True}).status_code, 422)  # no description
        self.descrever(C)
        self.assertEqual(self.cliente.post(FINALIZAR, json={"numero": C, "confirmado": True}).status_code, 422)
        self.assertEqual(self.cliente.post(FINALIZAR, json={"numero": "linha:2", "confirmado": True}).status_code, 422)
        self.assertEqual(self.cliente.post(FINALIZAR, json={"numero": A, "confirmado": True, "forcar": True}).status_code, 422)
        self.assertEqual(self.cliente.post(FINALIZAR, json={}).status_code, 422)
        self.assertEqual(self.runner.iniciadas, [])
        self.assertIsNone(self.job())

    def test_chamado_ja_finalizado_responde_409_sem_disparar(self):
        self.descrever(A)
        fin.registrar_finalizacao(self.dir, A, fin.STATUS_OK, "30/10/2026 14:05")
        resposta = self.cliente.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 409)
        self.assertEqual(self.runner.iniciadas, [])

    def test_rotina_em_andamento_responde_409_e_o_pedido_nao_fica_guardado(self):
        self.descrever(A)
        self.runner.erro = DomainConflictError("Já há uma rotina em execução.")
        resposta = self.cliente.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 409)
        self.assertIn("rotina", resposta.json()["detail"])
        self.assertFalse(fin.caminho_job(self.dir).exists())

    def test_pedido_anterior_ainda_nao_consumido_responde_409_e_nao_e_sobrescrito(self):
        self.descrever(A, B)
        fin.gravar_job(self.dir, [B])
        resposta = self.cliente.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 409)
        self.assertEqual(self.job()["numeros"], [B])
        self.assertEqual(self.runner.iniciadas, [])

    def test_pedido_velho_nao_trava_um_novo(self):
        self.descrever(A)
        antigo = (fin.agora_local() - fin.JOB_VALIDADE - timedelta(minutes=5)).isoformat(timespec="seconds")
        fin.caminho_job(self.dir).write_text(json.dumps({
            "criado_em": antigo, "acao": fin.ACAO_FINALIZAR, "numeros": [B], "confirmar_final": True, "pulados": [],
        }), encoding="utf-8")
        self.assertEqual(self.cliente.post(FINALIZAR, json={"numero": A, "confirmado": True}).status_code, 202)
        self.assertEqual(self.job()["numeros"], [A])


class ChamadoNovoTest(FinalizarBase):
    """Chamado novo da última busca (ainda fora do Dashboard) também tem descrição, PDF e finalização."""
    N = "UTIC-2026-1378"

    def setUp(self):
        super().setUp()
        self.importar()
        sebrae_novos.salvar_novos(self.caminhos.novos, [ChamadoSoftExpert(
            self.N, titulo="Travando", descricao="Meu notebook trava", solicitante="Camila Lopes",
            habilitada_em="26/10/2026, 17:25:23", detalhes_atendimento_realizado="Encaminhado",
        )], [], 0, {})

    def put(self, numero, texto):
        return self.cliente.put(f"/api/sebrae/chamados/{numero}/finalizacao", json={"descricao_finalizacao": texto})

    def test_descricao_aparece_no_item_do_formulario(self):
        self.assertEqual(self.put(self.N, "Troquei o cabo").status_code, 200)
        item = self.cliente.get("/api/sebrae/novos").json()["novos"]["formulario"][0]
        self.assertEqual(item["softexpert"]["descricao_finalizacao"], "Troquei o cabo")

    def test_anexo_e_finalizacao_individual_aceitam_chamado_novo_e_numero_desconhecido_segue_recusado(self):
        anexo = self.cliente.post(f"/api/sebrae/chamados/{self.N}/anexo", files={"file": ("laudo.pdf", PDF, "application/pdf")})
        self.assertEqual(anexo.status_code, 200, anexo.text)
        self.descrever(self.N)
        resposta = self.cliente.post(FINALIZAR, json={"numero": self.N, "confirmado": True})
        self.assertEqual(resposta.status_code, 202, resposta.text)
        self.assertEqual(self.job()["numeros"], [self.N])
        self.assertEqual(self.put("UTIC-2026-9999", "x").status_code, 422)
        self.assertEqual(self.cliente.post(FINALIZAR, json={"numero": "UTIC-2026-9999", "confirmado": True}).status_code, 422)

    def test_em_massa_chamado_novo_marcado_finalizado_com_descricao_vai_para_a_rotina(self):
        self.descrever(self.N)
        novo = {"numero": self.N, "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        resposta = self.cliente.post(ATUALIZAR, json={"chamados": [novo], "finalizar_softexpert": True})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["fechar"]["numeros"], [self.N])
        self.assertEqual(self.runner.iniciadas, ["fechar"])


class SemRunnerTest(FinalizarBase):
    com_runner = False

    def test_sem_automacao_no_servidor_responde_503_e_nao_deixa_pedido(self):
        self.importar()
        self.descrever(A)
        self.assertEqual(self.cliente.post(FINALIZAR, json={"numero": A, "confirmado": True}).status_code, 503)
        self.assertFalse(fin.caminho_job(self.dir).exists())


class AtualizarDispara(FinalizarBase):
    def setUp(self):
        super().setUp()
        self.importar()

    def edicao(self, numero, d="FINALIZADO", **extra):
        return {"numero": numero, "A": "CLIENTE", "B": "REDE", "D": d, "J": "INCIDENTE", **extra}

    def atualizar(self, *edicoes, finalizar_softexpert=True):
        resposta = self.cliente.post(ATUALIZAR, json={"edicoes": list(edicoes), "finalizar_softexpert": finalizar_softexpert})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()

    def test_chamado_marcado_finalizado_com_descricao_vai_para_a_rotina_e_sem_descricao_e_pulado(self):
        self.descrever(A)
        corpo = self.atualizar(self.edicao(A), self.edicao(B))
        self.assertEqual(corpo["fechar"], {
            "iniciado": True, "motivo": "", "numeros": [A], "pulados": [{"numero": B, "motivo": "sem_descricao"}],
        })
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        self.assertEqual(self.job()["numeros"], [A])
        self.assertTrue(sebrae_novos.caminho_saida(self.caminhos, corpo["arquivo"]).is_file())  # the routine reads this file

    def test_sem_finalizar_softexpert_atualiza_o_dashboard_mas_nao_dispara_a_rotina(self):
        self.descrever(A)
        for corpo in ({"edicoes": [self.edicao(A)]}, {"edicoes": [self.edicao(A)], "finalizar_softexpert": False}):
            resposta = self.cliente.post(ATUALIZAR, json=corpo)
            self.assertEqual(resposta.status_code, 200, resposta.text)
            self.assertEqual(resposta.json()["fechar"], {
                "iniciado": False, "motivo": "finalização no SoftExpert não confirmada", "numeros": [], "pulados": [],
            })
            self.assertTrue(resposta.json()["conteudo_base64"])
        self.assertEqual(self.runner.iniciadas, [])
        self.assertFalse(fin.caminho_job(self.dir).exists())

    def test_so_dispara_quando_d_vira_finalizado(self):
        self.descrever(A)
        corpo = self.atualizar(self.edicao(A, d="EM ABERTO"))
        self.assertEqual(corpo["fechar"], {"iniciado": False, "motivo": "", "numeros": [], "pulados": []})
        self.assertEqual(self.runner.iniciadas, [])

    def test_chamado_ja_finalizado_no_softexpert_nao_e_refeito(self):
        self.descrever(A)
        fin.registrar_finalizacao(self.dir, A, fin.STATUS_OK, "30/10/2026 14:05")
        corpo = self.atualizar(self.edicao(A))
        self.assertEqual(corpo["fechar"]["pulados"], [{"numero": A, "motivo": "ja_finalizado"}])
        self.assertEqual(self.runner.iniciadas, [])

    def test_linha_sem_utic_nunca_chega_ao_softexpert(self):
        self.importar(montar(("Sem chamado", A), ultima=9, status=("EM ABERTO", "EM ABERTO")))
        corpo = self.atualizar({"numero": "linha:2", "D": "FINALIZADO"})
        self.assertEqual(corpo["fechar"]["pulados"], [{"numero": "linha:2", "motivo": "sem_numero"}])
        self.assertEqual(self.runner.iniciadas, [])

    def test_rotina_ocupada_nao_derruba_a_atualizacao_e_o_motivo_vai_na_resposta(self):
        self.descrever(A)
        self.runner.erro = DomainConflictError("Já há uma rotina em execução.")
        corpo = self.atualizar(self.edicao(A))
        self.assertFalse(corpo["fechar"]["iniciado"])
        self.assertIn("rotina", corpo["fechar"]["motivo"])
        self.assertFalse(fin.caminho_job(self.dir).exists())
        self.assertTrue(corpo["conteudo_base64"])

    def test_encerramento_ja_gravado_volta_para_a_coluna_r_quando_a_saida_e_refeita(self):
        fin.registrar_finalizacao(self.dir, A, fin.STATUS_OK, "30/10/2026 14:05")
        corpo = self.atualizar({"numero": B, "B": "REDE"})
        saida = sebrae_novos.caminho_saida(self.caminhos, corpo["arquivo"]).read_bytes()
        self.assertRegex(linha_xml(saida, 2), R_1405)
        self.assertNotRegex(linha_xml(saida, 3), R_1405)
        self.assertEqual(saida, base64.b64decode(corpo["conteudo_base64"]))

    def test_encerramento_so_de_nao_encontrado_nao_vira_data(self):
        fin.registrar_finalizacao(self.dir, A, fin.STATUS_NAO_ENCONTRADO)
        saida = base64.b64decode(self.atualizar({"numero": B, "B": "REDE"})["conteudo_base64"])
        self.assertNotRegex(linha_xml(saida, 2), R_1405)


class ResultadoEReenvioTest(FinalizarBase):
    def setUp(self):
        super().setUp()
        self.importar()

    def pendente(self):
        origem = self.dir / "origem.xlsx"
        origem.write_bytes(montar())
        return fin.guardar_pendente(self.dir, origem, datetime(2026, 10, 30, 17, 5, tzinfo=timezone.utc), motivo="sem login", tickets=[A])

    def test_sem_nada_o_resultado_vem_vazio(self):
        self.assertEqual(self.cliente.get(FINALIZAR).json(), {"em_andamento": False, "resultado": None, "sharepoint": None})
        self.assertNotIn("fechar", self.cliente.get("/api/sebrae/novos").json())

    def test_resultado_e_aviso_do_sharepoint_aparecem_e_em_andamento_segue_o_runner(self):
        fin.gravar_resultado(self.dir, {"em_andamento": False, "resultados": [{"numero": A, "status": "ok"}]})
        pendente = self.pendente()
        self.runner.estado = {"estado": "em_andamento", "rotina": "fechar"}
        corpo = self.cliente.get(FINALIZAR).json()
        self.assertTrue(corpo["em_andamento"])
        self.assertEqual(corpo["resultado"]["resultados"][0]["numero"], A)
        self.assertEqual((corpo["sharepoint"]["falhou"], corpo["sharepoint"]["copia_local"]), (True, str(pendente)))
        self.assertEqual(len(corpo["sharepoint"]["sugestoes"]), 3)
        self.runner.estado = {"estado": "em_andamento", "rotina": "sebrae"}
        self.assertFalse(self.cliente.get(FINALIZAR).json()["em_andamento"])
        estado = self.cliente.get("/api/sebrae/novos").json()
        self.assertIn("fechar", estado)
        self.assertTrue(estado["sharepoint"]["falhou"])

    def test_reenviar_sem_copia_pendente_responde_422(self):
        self.assertEqual(self.cliente.post(REENVIAR).status_code, 422)
        self.assertEqual(self.runner.iniciadas, [])

    def test_reenviar_grava_pedido_de_reenvio_e_dispara_a_rotina(self):
        self.pendente()
        resposta = self.cliente.post(REENVIAR)
        self.assertEqual((resposta.status_code, resposta.json()), (202, {"iniciado": True}))
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        self.assertEqual(self.job()["acao"], fin.ACAO_REENVIAR)

    def test_reenviar_com_rotina_ocupada_responde_409(self):
        self.pendente()
        self.runner.erro = DomainConflictError("Já há uma rotina em execução.")
        self.assertEqual(self.cliente.post(REENVIAR).status_code, 409)
        self.assertFalse(fin.caminho_job(self.dir).exists())


if __name__ == "__main__":
    unittest.main()
