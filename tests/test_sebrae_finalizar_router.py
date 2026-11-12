import base64
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import ValidationError

from core.errors import DomainBusyError, DomainConflictError, DomainError
from domains import os_marcas_finalizacao as marcas
from domains import sebrae_finalizacao as fin
from domains import sebrae_novos, sebrae_vinculos
from domains.assistant_api import SimpressApi, asgi_transport
from domains.sebrae_chamados import ChamadoSoftExpert
from routers.sebrae_dashboard import FichaPayload, SebraeDashboardServices, create_sebrae_dashboard_router
from tests.test_sebrae_dashboard_gravacao import linha_xml, montar

A, B, C = "UTIC-2026-0001", "UTIC-2026-0002", "UTIC-2026-0003"
PDF = b"%PDF-1.4\n%fake\n"
R_1405 = r'<c r="R\d+"[^>]*><v>46325\.586'
ATUALIZAR = "/api/sebrae/dashboard/atualizar"
FINALIZAR = "/api/sebrae/finalizar-softexpert"
REENVIAR = "/api/sebrae/dashboard/pendente/reenviar"


class FichaPayloadTest(unittest.TestCase):
    def test_post_reenvio_bloqueia_aviso_legado_antes_de_gravar_job(self):
        raiz = Path(tempfile.mkdtemp())
        caminhos = sebrae_novos.caminhos_padrao(raiz)
        fin.gravar_resultado(raiz, {"sharepoint": {"falhou": False, "limpeza_pendente": True}})
        runner = RunnerFalso()
        router = create_sebrae_dashboard_router(SebraeDashboardServices(
            caminhos=lambda: caminhos, max_upload_bytes=lambda: 1024, registros=lambda: [],
            relatorio_chamados=lambda: None, runner=lambda: runner,
        ))
        post = next(route.endpoint for route in router.routes if route.path == REENVIAR)
        with self.assertRaises(DomainConflictError):
            post()
        self.assertFalse(fin.caminho_job(raiz).exists())
        self.assertEqual(runner.iniciadas, [])

    def test_recusa_campos_incompativeis_com_o_cartao_sem_coagir_valores(self):
        for ficha in ({"detalhes": "texto"}, {"fatos": {}}, {"detalhes": [None]},
                      {"fatos": [["rótulo"]]}, {"detalhes": [["rótulo", 4]]},
                      {"titulo": {}}, {"solicitante": []}, {"manuais": []}, {"manuais": {"A": {}}}):
            with self.subTest(ficha=ficha), self.assertRaises(ValidationError):
                FichaPayload(ficha=ficha)

    def test_aceita_ficha_parcial_e_pares_textuais(self):
        ficha = {"titulo": "Teclado", "detalhes": [["Descrição", "Travando"]], "manuais": {"A": "CLIENTE"}}
        self.assertEqual(FichaPayload(ficha=ficha).ficha, ficha)


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


class RecuperacaoEnvioTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        caminhos = sebrae_novos.caminhos_padrao(self.dir)
        self.runner = RunnerFalso()
        self.router = create_sebrae_dashboard_router(SebraeDashboardServices(
            caminhos=lambda: caminhos, max_upload_bytes=lambda: 1024, registros=lambda: [],
            relatorio_chamados=lambda: None, runner=lambda: self.runner,
        ))
        sebrae_novos.salvar_existentes(caminhos.existentes, [], "Dashboard.xlsx", sha256="a" * 64)
        self.envio = fin.preparar_envio(self.dir, b"snapshot")
        fin.marcar_envio_incerto(self.dir, self.envio)

    def endpoint(self, path):
        return next(route.endpoint for route in self.router.routes if route.path == path)

    def test_rota_recusa_stale_worker_ativo_e_libera_so_por_declaracao_explicita(self):
        from routers.sebrae_dashboard import RecuperacaoEnvioPayload
        recuperar = self.endpoint("/api/sebrae/dashboard/envio/recuperar")
        def payload(envio):
            return RecuperacaoEnvioPayload(envio_id=envio, acao="declarar_nao_enviado", confirmacao="CONFIRMO NAO APLICADO")
        with self.assertRaises(DomainConflictError):
            recuperar(payload("a" * 32))
        self.runner.estado = {"estado": "em_andamento", "rotina": "enviar"}
        with self.assertRaises(DomainConflictError):
            recuperar(payload(self.envio))
        self.runner.estado = {"estado": "livre"}
        resposta = recuperar(payload(self.envio))
        self.assertEqual(json.loads(resposta.body)["status"], "falhou")
        self.assertEqual(self.runner.iniciadas, [])
        self.assertFalse(fin.caminho_job(self.dir).exists())

    def test_snapshot_local_exige_id_atual_e_hash_intacto(self):
        baixar = self.endpoint("/api/sebrae/dashboard/envio/{envio_id}/snapshot")
        self.assertEqual(baixar(self.envio).body, b"snapshot")
        with self.assertRaises(DomainConflictError):
            baixar("a" * 32)
        fin.snapshot_envio(self.dir, self.envio).write_bytes(b"alterado")
        with self.assertRaises(DomainConflictError):
            baixar(self.envio)

    def test_reenvio_separado_da_snapshot_nao_consulta_fila_e_exige_id_hash_e_clique(self):
        from routers.sebrae_dashboard import ReenvioSnapshotPayload
        sha = fin.ler_envio(self.dir)["sha256"]
        fin.recuperar_envio(self.dir, self.envio, "declarar_nao_enviado", confirmacao="CONFIRMO NAO APLICADO")
        enviar = self.endpoint("/api/sebrae/dashboard/envio/reenviar-snapshot")
        with self.assertRaises(DomainError):
            enviar(ReenvioSnapshotPayload(envio_id=self.envio, sha256=sha))
        with self.assertRaises(DomainConflictError):
            enviar(ReenvioSnapshotPayload(envio_id="a" * 32, sha256=sha, confirmado=True))
        self.runner.estado = {"estado": "em_andamento"}
        with self.assertRaises(DomainConflictError):
            enviar(ReenvioSnapshotPayload(envio_id=self.envio, sha256=sha, confirmado=True))
        self.runner.estado = {"estado": "livre"}
        with patch.object(fin, "pendente_mais_recente", side_effect=AssertionError("não consultar fila")):
            self.assertEqual(enviar(ReenvioSnapshotPayload(envio_id=self.envio, sha256=sha, confirmado=True)).status_code, 202)
        job = fin.consumir_job(self.dir)
        self.assertEqual((job["acao"], job["envio_id"], job["sha256"]), ("reenviar_snapshot", self.envio, sha))


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
            **self.servicos_extras(),
        )))
        self.app = app
        self.cliente = TestClient(app)

    def servicos_extras(self):
        return {}

    def post(self, url, **kwargs):
        if url in ("/api/sebrae/dashboard/atualizar", "/api/sebrae/finalizar-softexpert", "/api/sebrae/dashboard/conflitos") and isinstance(kwargs.get("json"), dict):
            atual = sebrae_novos.ler_existentes(self.caminhos.existentes)
            kwargs["json"].setdefault("versao_importacao", atual["versao"] if atual else "")
        return self.cliente.post(url, **kwargs)

    def importar(self, conteudo=None):
        conteudo = montar((A, B, C), ultima=9, status=("EM ABERTO", "EM ABERTO", "FINALIZADO")) if conteudo is None else conteudo
        resposta = self.post("/api/sebrae/dashboard", files={"file": ("Dashboard.xlsx", conteudo, "application/octet-stream")})
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

    def test_ficha_enviada_pela_api_e_mascarada_antes_de_persistir(self):
        resposta = self.cliente.put(f"/api/sebrae/chamados/{A}/ficha", json={"ficha": {"titulo": "password é Segredo123", "valores": {"A": "=1+1"}}})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        salvo = fin.ler_estado(self.dir)[A]["ficha"]
        self.assertNotIn("Segredo123", salvo["titulo"])
        self.assertEqual(salvo["valores"]["A"], "'=1+1")

    def test_descricao_fica_guardada_e_aparece_no_estado_do_chamado(self):
        resposta = self.put(A, "Troquei o cabo")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["descricao_finalizacao"], "Troquei o cabo")
        abertos = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}
        self.assertEqual(abertos[A]["softexpert"]["descricao_finalizacao"], "Troquei o cabo")
        self.assertEqual(abertos[B]["softexpert"], {"descricao_finalizacao": "", "descricao_definida": False, "descricao_editada": "", "pdf": None, "finalizacao": None})
        self.assertEqual(self.put(A, "").json()["descricao_finalizacao"], "")

    def test_descricao_apagada_conta_como_definida_e_so_o_campo_ausente_nao(self):
        # a tela só aplica "Revisado." (API SEBRAE) quando descricao_definida é False; apagar a descrição não pode reabrir isso
        self.assertIs(fin.publico(None)["descricao_definida"], False)
        self.assertIs(self.put(A, "Revisado.").json()["descricao_definida"], True)
        self.assertIs(self.put(A, "").json()["descricao_definida"], True)
        abertos = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}
        self.assertEqual((abertos[A]["softexpert"]["descricao_finalizacao"], abertos[A]["softexpert"]["descricao_definida"]), ("", True))
        self.assertIs(abertos[B]["softexpert"]["descricao_definida"], False)
        self.assertIs(self.post(f"/api/sebrae/chamados/{B}/anexo", files={"file": ("laudo.pdf", PDF, "application/pdf")}).json()["descricao_definida"], False)  # só PDF não define descrição

    def test_descricao_recusa_texto_grande_chamado_fechado_numero_ruim_e_campo_extra(self):
        self.assertEqual(self.put(A, "x" * 4001).status_code, 422)
        self.assertEqual(self.put(C, "x").status_code, 422)  # FINALIZADO no Dashboard: não está entre os abertos
        self.assertEqual(self.put("UTIC-2026-9999", "x").status_code, 422)
        self.assertEqual(self.put("abc", "x").status_code, 422)
        extra = self.cliente.put(f"/api/sebrae/chamados/{A}/finalizacao", json={"descricao_finalizacao": "x", "z": 1})
        self.assertEqual(extra.status_code, 422)
        self.assertEqual(fin.ler_estado(self.dir), {})

    def put_descricao(self, numero, texto):
        return self.cliente.put(f"/api/sebrae/chamados/{numero}/descricao", json={"descricao": texto})

    def test_descricao_editada_antigo_lido_vale_na_leitura_e_restaurar_volta_ao_original(self):
        sebrae_novos.salvar_antigo(sebrae_novos.caminho_antigos(self.caminhos), ChamadoSoftExpert(A, "Titulo", "Texto lido", "Maria"))
        resposta = self.put_descricao(A, "Texto lido CPF 123.456.789-09 senha: abc123 e mais info")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertNotIn("123.456.789-09", resposta.json()["descricao"])  # mascarado ao salvar
        abertos = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}
        self.assertEqual(abertos[A]["leitura_softexpert"]["descricao"], resposta.json()["descricao"])
        self.assertEqual(abertos[A]["softexpert"]["descricao_editada"], resposta.json()["descricao"])
        self.assertEqual(abertos[B]["softexpert"]["descricao_editada"], "")
        restaurada = self.put_descricao(A, "  ")
        self.assertEqual((restaurada.json()["descricao"], restaurada.json()["descricao_editada"]), ("Texto lido", ""))
        abertos = {a["numero"]: a for a in self.cliente.get("/api/sebrae/novos").json()["importado"]["abertos"]}
        self.assertEqual(abertos[A]["leitura_softexpert"]["descricao"], "Texto lido")

    def test_descricao_editada_novo_vira_a_coluna_h_da_linha_nova(self):
        novo = "UTIC-2026-0009"
        sebrae_novos.salvar_novos(self.caminhos.novos, [ChamadoSoftExpert(novo, "T", "Original", "Joao")], [], 0, {})
        self.assertEqual(self.put_descricao(novo, "Original + detalhe").json()["descricao"], "Original + detalhe")
        formulario = {f["numero"]: f for f in self.cliente.get("/api/sebrae/novos").json()["novos"]["formulario"]}
        self.assertEqual(formulario[novo]["linha"]["H"], "Original + detalhe")
        self.assertEqual(self.put_descricao(novo, "").json()["descricao"], "Original")

    def test_descricao_editada_recusa_texto_grande_chamado_fechado_numero_ruim_e_campo_extra(self):
        self.assertEqual(self.put_descricao(A, "x" * (fin.MAX_DESCRICAO * 2 + 1)).status_code, 422)
        self.assertEqual(self.put_descricao(C, "x").status_code, 422)  # FINALIZADO no Dashboard
        self.assertEqual(self.put_descricao("UTIC-2026-9999", "x").status_code, 422)
        self.assertEqual(self.put_descricao("abc", "x").status_code, 422)
        extra = self.cliente.put(f"/api/sebrae/chamados/{A}/descricao", json={"descricao": "x", "z": 1})
        self.assertEqual(extra.status_code, 422)
        self.assertEqual(fin.ler_estado(self.dir), {})

    def anexo(self, nome="laudo.pdf", dados=PDF, numero=A):
        return self.post(f"/api/sebrae/chamados/{numero}/anexo", files={"file": (nome, dados, "application/pdf")})

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

    def test_remocao_pdf_503_informa_estado_persistido_e_retry_preserva_pdf_novo(self):
        self.anexo()
        antigo = fin.dados_para_finalizar(self.dir, A)[1]
        url = f"/api/sebrae/chamados/{A}/anexo"
        with patch.object(fin.shutil, "rmtree", side_effect=PermissionError("ocupado")):
            resposta = self.cliente.delete(url)
        self.assertEqual(resposta.status_code, 503, resposta.text)
        dados = resposta.json()
        self.assertEqual(dados.get("numero"), A)
        self.assertIsNone(dados["pdf"])
        self.assertIs(dados["pdf_remocao_pendente"], True)
        self.assertIn("pendente", dados["detail"])
        self.assertEqual(resposta.headers["cache-control"], "no-store")
        self.assertNotIn("pdf", fin.ler_estado(self.dir)[A])
        self.assertTrue(antigo.exists())

        self.anexo("novo.pdf", PDF + b"novo")
        novo = fin.dados_para_finalizar(self.dir, A)[1]
        with patch.object(fin.shutil, "rmtree", side_effect=PermissionError("ocupado")):
            retry = self.cliente.delete(url + "?somente_pendentes=true")
        self.assertEqual(retry.status_code, 503, retry.text)
        self.assertEqual(retry.json()["pdf"], {"nome": "novo.pdf", "tamanho": len(PDF + b"novo")})
        self.assertIs(retry.json()["pdf_remocao_pendente"], True)
        concluido = self.cliente.delete(url + "?somente_pendentes=true")
        self.assertEqual(concluido.status_code, 200, concluido.text)
        self.assertEqual(concluido.json()["pdf"]["nome"], "novo.pdf")
        self.assertNotIn("pdf_remocao_pendente", concluido.json())
        self.assertFalse(antigo.exists())
        self.assertEqual(novo.read_bytes(), PDF + b"novo")

    def test_remocao_pdf_503_sem_pedido_persistido_nao_inventa_estado(self):
        self.anexo()
        with patch.object(fin, "remover_pdf", side_effect=DomainBusyError("estado indisponível")):
            resposta = self.cliente.delete(f"/api/sebrae/chamados/{A}/anexo")
        self.assertEqual(resposta.status_code, 503)
        self.assertEqual(resposta.json(), {"detail": "estado indisponível"})
        self.assertEqual(fin.dados_para_finalizar(self.dir, A)[1].read_bytes(), PDF)

    def test_nome_com_pasta_nunca_sai_da_pasta_do_chamado(self):
        resposta = self.anexo("../../../fora.pdf")
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["pdf"]["nome"], "fora.pdf")
        caminho = fin.dados_para_finalizar(self.dir, A)[1]
        self.assertIn(fin.pasta_anexos(self.dir, A).resolve(), caminho.resolve().parents)
        self.assertEqual(caminho.name, "fora.pdf")
        self.assertFalse((self.dir.parent / "fora.pdf").exists())


class FinalizarUmTest(FinalizarBase):
    def setUp(self):
        super().setUp()
        self.importar()

    def test_dispara_a_rotina_fechar_com_o_pedido_de_um_chamado(self):
        self.descrever(A)
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 202, resposta.text)
        self.assertEqual(resposta.json(), {"iniciado": True, "numeros": [A]})
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        job = self.job()
        self.assertEqual((job["acao"], job["numeros"], job["confirmar_final"]), (fin.ACAO_FINALIZAR, [A], True))

    def test_campos_manuais_do_chamado_entram_na_copia_de_saida_antes_da_rotina(self):
        self.descrever(A)
        manuais = {"numero": A, "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True, "edicoes": [manuais]})
        self.assertEqual(resposta.status_code, 202, resposta.text)
        saida = sebrae_novos.caminho_saida(self.caminhos, "Dashboard Operacional_SEBRAE.xlsx").read_bytes()
        for valor in ("CLIENTE", "REDE", "FINALIZADO", "INCIDENTE"):
            self.assertIn(valor, linha_xml(saida, 2))
        self.assertEqual(self.runner.iniciadas, ["fechar"])

    def test_edicoes_de_outros_chamados_seguem_na_copia_e_o_horario_do_softexpert_substitui_o_r_manual(self):
        self.descrever(A)
        manuais = [
            {"numero": A, "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE", "R": "01/01/2026 09:00"},
            {"numero": B, "A": "OUTRO CLIENTE", "D": "EM ABERTO", "J": "INCIDENTE"},
        ]
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True, "edicoes": manuais})
        self.assertEqual(resposta.status_code, 202, resposta.text)
        saida = sebrae_novos.caminho_saida(self.caminhos, "Dashboard Operacional_SEBRAE.xlsx").read_bytes()
        self.assertIn("OUTRO CLIENTE", linha_xml(saida, 3))
        self.assertIn("46023.375", linha_xml(saida, 2))  # 01/01/2026 09:00; a rotina fechar troca o R depois, aqui só a cópia antes dela

    def test_campos_manuais_invalidos_recusam_sem_disparar(self):
        self.descrever(A)
        invalido = {"numero": A, "A": "CLIENTE", "D": "TALVEZ", "J": "INCIDENTE"}
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True, "edicoes": [invalido]})
        self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertEqual(self.runner.iniciadas, [])
        self.assertIsNone(self.job())

    def test_sem_confirmado_nada_e_disparado(self):
        self.descrever(A)
        for corpo in ({"numero": A},{"numero": A, "confirmado": False}):
            resposta = self.post(FINALIZAR, json=corpo)
            self.assertEqual(resposta.status_code, 422, resposta.text)
            self.assertIn("Confirme", resposta.json()["detail"])
        self.assertEqual(self.runner.iniciadas, [])
        self.assertIsNone(self.job())

    def test_recusa_sem_descricao_chamado_fechado_numero_ruim_e_campo_extra_sem_disparar(self):
        self.assertEqual(self.post(FINALIZAR, json={"numero": A, "confirmado": True}).status_code, 422)  # no description
        self.descrever(C)
        self.assertEqual(self.post(FINALIZAR, json={"numero": C, "confirmado": True}).status_code, 422)
        self.assertEqual(self.post(FINALIZAR, json={"numero": "linha:2", "confirmado": True}).status_code, 422)
        self.assertEqual(self.post(FINALIZAR, json={"numero": A, "confirmado": True, "forcar": True}).status_code, 422)
        self.assertEqual(self.post(FINALIZAR, json={}).status_code, 422)
        self.assertEqual(self.runner.iniciadas, [])
        self.assertIsNone(self.job())

    def test_chamado_ja_finalizado_responde_409_sem_disparar(self):
        self.descrever(A)
        fin.registrar_finalizacao(self.dir, A, fin.STATUS_OK, "30/10/2026 14:05")
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 409)
        self.assertEqual(self.runner.iniciadas, [])

    def test_rotina_em_andamento_responde_409_e_o_pedido_nao_fica_guardado(self):
        self.descrever(A)
        self.runner.erro = DomainConflictError("Já há uma rotina em execução.")
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 409)
        self.assertIn("rotina", resposta.json()["detail"])
        self.assertFalse(fin.caminho_job(self.dir).exists())

    def test_pedido_anterior_ainda_nao_consumido_responde_409_e_nao_e_sobrescrito(self):
        self.descrever(A, B)
        fin.gravar_job(self.dir, [B])
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 409)
        self.assertEqual(self.job()["numeros"], [B])
        self.assertEqual(self.runner.iniciadas, [])

    def test_rotina_em_andamento_recusa_com_409_antes_de_refazer_a_copia_de_saida(self):
        self.descrever(A)
        self.assertEqual(self.post(ATUALIZAR, json={"edicoes": [{"numero": B, "A": "ANTES", "D": "EM ABERTO", "J": "INCIDENTE"}]}).status_code, 200)
        saida = sebrae_novos.caminho_saida(self.caminhos, "Dashboard Operacional_SEBRAE.xlsx")
        antes = saida.read_bytes()
        self.runner.estado = {"estado": "em_andamento", "rotina": "sebrae"}
        manuais = {"numero": A, "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True, "edicoes": [manuais]})
        self.assertEqual(resposta.status_code, 409, resposta.text)
        self.assertIn("rotina", resposta.json()["detail"])
        self.assertEqual(saida.read_bytes(), antes)
        self.assertEqual(self.runner.iniciadas, [])
        self.assertFalse(fin.caminho_job(self.dir).exists())

    def test_pedido_pendente_recusa_com_409_antes_de_refazer_a_copia_de_saida(self):
        self.descrever(A, B)
        self.assertEqual(self.post(ATUALIZAR, json={"edicoes": [{"numero": B, "A": "ANTES", "D": "EM ABERTO", "J": "INCIDENTE"}]}).status_code, 200)
        saida = sebrae_novos.caminho_saida(self.caminhos, "Dashboard Operacional_SEBRAE.xlsx")
        antes = saida.read_bytes()
        fin.gravar_job(self.dir, [B])
        manuais = {"numero": A, "A": "CLIENTE", "D": "FINALIZADO", "J": "INCIDENTE"}
        self.assertEqual(self.post(FINALIZAR, json={"numero": A, "confirmado": True, "edicoes": [manuais]}).status_code, 409)
        self.assertEqual(saida.read_bytes(), antes)
        self.assertEqual(self.job()["numeros"], [B])

    def test_pedido_velho_nao_trava_um_novo(self):
        self.descrever(A)
        antigo = (fin.agora_local() - fin.JOB_VALIDADE - timedelta(minutes=5)).isoformat(timespec="seconds")
        fin.caminho_job(self.dir).write_text(json.dumps({
            "criado_em": antigo, "acao": fin.ACAO_FINALIZAR, "numeros": [B], "confirmar_final": True, "pulados": [],
        }), encoding="utf-8")
        self.assertEqual(self.post(FINALIZAR, json={"numero": A, "confirmado": True}).status_code, 202)
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
        anexo = self.post(f"/api/sebrae/chamados/{self.N}/anexo", files={"file": ("laudo.pdf", PDF, "application/pdf")})
        self.assertEqual(anexo.status_code, 200, anexo.text)
        self.descrever(self.N)
        resposta = self.post(FINALIZAR, json={"numero": self.N, "confirmado": True})
        self.assertEqual(resposta.status_code, 202, resposta.text)
        self.assertEqual(self.job()["numeros"], [self.N])
        self.assertEqual(self.put("UTIC-2026-9999", "x").status_code, 422)
        self.assertEqual(self.post(FINALIZAR, json={"numero": "UTIC-2026-9999", "confirmado": True}).status_code, 422)

    def test_assistente_anexa_o_pdf_pelo_transporte_na_rota_real(self):
        # 08/11/2026: the Assistant sends the PDF through the same route as the screen, via the in-process transport.
        api = SimpressApi(asgi_transport(lambda: self.app, 8000))
        for numero, nome, dados in ((self.N, "laudo.pdf", PDF), (self.N, 'ou"tro\r\n.pdf', PDF + b"\x00\xff1")):
            self.assertEqual(api.anexar_pdf_chamado_sebrae(numero, nome, dados)["sucesso"], True)
            guardado = fin.dados_para_finalizar(self.dir, numero)[1]
            self.assertEqual(guardado.read_bytes(), dados)
        self.assertTrue(guardado.name.endswith(".pdf") and "\n" not in guardado.name)
        recusado = api.anexar_pdf_chamado_sebrae(self.N, "laudo.pdf", b"MZ not a pdf")
        self.assertEqual((recusado["sucesso"], recusado["erro"].startswith("Erro 422")), (False, True))
        self.assertEqual(api.anexar_pdf_chamado_sebrae("UTIC-2026-9999", "laudo.pdf", PDF)["sucesso"], False)

    def test_em_massa_chamado_novo_marcado_finalizado_com_descricao_vai_para_a_rotina(self):
        self.descrever(self.N)
        novo = {"numero": self.N, "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        resposta = self.post(ATUALIZAR, json={"chamados": [novo], "finalizar_softexpert": True})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["fechar"]["numeros"], [self.N])
        self.assertEqual(self.runner.iniciadas, ["fechar"])


    def test_atualizar_com_dois_novos_e_depois_finalizar_um_antigo_deixa_os_tres_na_saida(self):
        outro = "UTIC-2026-1379"
        sebrae_novos.salvar_novos(self.caminhos.novos, [
            ChamadoSoftExpert(self.N, titulo="Travando", descricao="Meu notebook trava", solicitante="Camila Lopes", habilitada_em="26/10/2026, 17:25:23"),
            ChamadoSoftExpert(outro, titulo="Sem rede", descricao="Sem internet", solicitante="Camila Lopes", habilitada_em="26/10/2026, 17:30:00"),
        ], [], 0, {})
        novos = [{"numero": n, "A": "NOVO CLIENTE", "B": "REDE", "D": "EM ABERTO", "J": "INCIDENTE"} for n in (self.N, outro)]
        resposta = self.post(ATUALIZAR, json={"chamados": novos})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.descrever(A)
        terceiro = {"numero": A, "A": "TERCEIRO", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True, "chamados": novos, "edicoes": [terceiro]})
        self.assertEqual(resposta.status_code, 202, resposta.text)
        saida = sebrae_novos.caminho_saida(self.caminhos, "Dashboard Operacional_SEBRAE.xlsx").read_bytes()
        self.assertIn("TERCEIRO", linha_xml(saida, 2))
        self.assertIn(self.N, linha_xml(saida, 5))
        self.assertIn(outro, linha_xml(saida, 6))
        self.assertEqual(self.runner.iniciadas, ["fechar"])


class SemRunnerTest(FinalizarBase):
    com_runner = False

    def test_sem_automacao_no_servidor_responde_503_e_nao_deixa_pedido(self):
        self.importar()
        self.descrever(A)
        self.assertEqual(self.post(FINALIZAR, json={"numero": A, "confirmado": True}).status_code, 503)
        self.assertFalse(fin.caminho_job(self.dir).exists())


class AtualizarBase(FinalizarBase):
    def setUp(self):
        super().setUp()
        self.importar()

    def edicao(self, numero, d="FINALIZADO", **extra):
        return {"numero": numero, "A": "CLIENTE", "B": "REDE", "D": d, "J": "INCIDENTE", **extra}

    def atualizar(self, *edicoes, finalizar_softexpert=True, enviar_sharepoint=None):
        corpo = {"edicoes": list(edicoes), "finalizar_softexpert": finalizar_softexpert}
        if enviar_sharepoint is not None:
            corpo["enviar_sharepoint"] = enviar_sharepoint
        resposta = self.post(ATUALIZAR, json=corpo)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        return resposta.json()


class AtualizarEnviaTest(AtualizarBase):
    """"Atualizar Dashboard" inicia a rotina enviar sozinho (pedido de 09/11/2026), exceto quando a fechar já roda."""

    def test_a_com_pedido_e_copia_gravada_inicia_so_a_enviar(self):
        corpo = self.atualizar(self.edicao(A, d="EM ABERTO"), finalizar_softexpert=False, enviar_sharepoint=True)
        self.assertEqual(corpo["enviar"], {"iniciado": True, "motivo": ""})
        self.assertFalse(corpo["fechar"]["iniciado"])
        self.assertEqual(self.runner.iniciadas, ["enviar"])
        self.assertTrue(sebrae_novos.caminho_saida(self.caminhos, corpo["arquivo"]).is_file())  # a rotina lê esta cópia
        self.assertFalse(fin.caminho_job(self.dir).exists())

    def test_b_copia_nao_gravada_nao_inicia_nada_e_a_atualizacao_segue(self):
        with patch.object(sebrae_novos, "salvar_planilha", side_effect=OSError("disco")):
            corpo = self.atualizar(self.edicao(A, d="EM ABERTO"), enviar_sharepoint=True)
        self.assertEqual(corpo["enviar"], {"iniciado": False, "motivo": "A cópia de saída não foi gravada; nada foi enviado."})
        self.assertFalse(corpo["fechar"]["iniciado"])
        self.assertTrue(corpo["conteudo_base64"])  # o download do usuário segue
        self.assertEqual(self.runner.iniciadas, [])

    def test_c_com_chamado_a_finalizar_so_a_fechar_roda_e_nao_a_enviar(self):
        self.descrever(A)
        corpo = self.atualizar(self.edicao(A), enviar_sharepoint=True)
        self.assertTrue(corpo["fechar"]["iniciado"])
        self.assertEqual(corpo["enviar"], {"iniciado": False, "motivo": "a rotina fechar já envia ao SharePoint"})
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        self.assertEqual(self.job()["numeros"], [A])

    def test_d_finalizar_pedido_com_tudo_pulado_nao_envia(self):
        # Enviaria D=FINALIZADO sem SoftExpert e geraria marca falsa de "outro técnico".
        corpo = self.atualizar(self.edicao(A), enviar_sharepoint=True)  # sem descrição: pulado
        self.assertEqual(corpo["fechar"]["pulados"], [{"numero": A, "motivo": "sem_descricao"}])
        self.assertEqual(corpo["enviar"], {"iniciado": False, "motivo": "nenhum chamado foi finalizado no SoftExpert"})
        self.assertEqual(self.runner.iniciadas, [])
        self.assertFalse(fin.caminho_job(self.dir).exists())

    def test_d_sem_finalizar_com_pedido_inicia_a_enviar(self):
        corpo = self.atualizar(self.edicao(A), finalizar_softexpert=False, enviar_sharepoint=True)  # confirmado na tela
        self.assertEqual(corpo["enviar"], {"iniciado": True, "motivo": ""})
        self.assertEqual(self.runner.iniciadas, ["enviar"])
        self.runner.iniciadas.clear()
        corpo = self.atualizar(self.edicao(B, d="EM ABERTO"), finalizar_softexpert=False, enviar_sharepoint=True)  # nenhum D virou FINALIZADO
        self.assertFalse(corpo["fechar"]["iniciado"])
        self.assertEqual(corpo["fechar"]["numeros"], [])
        self.assertEqual(corpo["enviar"], {"iniciado": True, "motivo": ""})
        self.assertEqual(self.runner.iniciadas, ["enviar"])

    def test_e_rotina_ocupada_responde_200_com_o_motivo_e_nao_inicia(self):
        self.runner.estado = {"estado": "em_andamento", "rotina": "dashboard"}
        corpo = self.atualizar(self.edicao(A, d="EM ABERTO"), finalizar_softexpert=False, enviar_sharepoint=True)
        self.assertFalse(corpo["enviar"]["iniciado"])
        self.assertIn("rotina em execução", corpo["enviar"]["motivo"])
        self.assertEqual(self.runner.iniciadas, [])
        self.assertTrue(corpo["conteudo_base64"])
        self.runner.estado = {"estado": "livre"}
        self.runner.erro = DomainConflictError("Já há uma rotina em execução (o .bat).")
        corpo = self.atualizar(self.edicao(A, d="EM ABERTO"), finalizar_softexpert=False, enviar_sharepoint=True)
        self.assertEqual(corpo["enviar"], {"iniciado": False, "motivo": "Já há uma rotina em execução (o .bat)."})

    def test_e_envio_anterior_incerto_ou_falha_ao_iniciar_nao_derrubam_a_atualizacao(self):
        envio = fin.preparar_envio(self.dir, b"snapshot")
        fin.marcar_envio_incerto(self.dir, envio)
        corpo = self.atualizar(self.edicao(A, d="EM ABERTO"), finalizar_softexpert=False, enviar_sharepoint=True)
        self.assertFalse(corpo["enviar"]["iniciado"])
        self.assertTrue(corpo["enviar"]["motivo"])
        self.assertEqual(self.runner.iniciadas, [])
        fin.recuperar_envio(self.dir, envio, "declarar_nao_enviado", confirmacao="CONFIRMO NAO APLICADO")
        self.runner.erro = RuntimeError("segredo interno")
        corpo = self.atualizar(self.edicao(A, d="EM ABERTO"), finalizar_softexpert=False, enviar_sharepoint=True)
        self.assertEqual(corpo["enviar"], {"iniciado": False, "motivo": "Não foi possível iniciar o envio ao SharePoint."})
        self.assertNotIn("segredo", json.dumps(corpo["enviar"]))

    def test_f_sem_pedido_o_comportamento_antigo_segue_intacto(self):
        for pedido in (None, False):
            corpo = self.atualizar(self.edicao(A, d="EM ABERTO"), finalizar_softexpert=False, enviar_sharepoint=pedido)
            self.assertEqual(corpo["enviar"], {"iniciado": False, "motivo": ""})
            self.assertTrue(corpo["conteudo_base64"])
        self.assertEqual(self.runner.iniciadas, [])
        self.descrever(A)
        corpo = self.atualizar(self.edicao(A))  # finalizar sem pedido de envio: só a fechar
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        self.assertEqual(corpo["enviar"]["iniciado"], False)


class AtualizarEnviaSemRunnerTest(AtualizarBase):
    com_runner = False

    def test_sem_automacao_no_servidor_o_motivo_vai_na_resposta(self):
        corpo = self.atualizar(self.edicao(A, d="EM ABERTO"), finalizar_softexpert=False, enviar_sharepoint=True)
        self.assertEqual(corpo["enviar"], {"iniciado": False, "motivo": "A automação não está disponível neste servidor."})
        self.assertTrue(corpo["conteudo_base64"])


class AtualizarDispara(AtualizarBase):

    def test_chamado_marcado_finalizado_com_descricao_vai_para_a_rotina_e_sem_descricao_e_pulado(self):
        self.descrever(A)
        corpo = self.atualizar(self.edicao(A), self.edicao(B))
        self.assertEqual(corpo["fechar"], {
            "iniciado": True, "motivo": "", "numeros": [A], "pulados": [{"numero": B, "motivo": "sem_descricao"}],
        })
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        self.assertEqual(self.job()["numeros"], [A])
        self.assertTrue(sebrae_novos.caminho_saida(self.caminhos, corpo["arquivo"]).is_file())  # the routine reads this file

    def test_titulo_g_editado_nao_muda_o_pedido_de_finalizacao_que_a_rotina_recebe(self):
        # The SoftExpert routines find a ticket by its UTIC number only: a typed title must not change who is finalized or skipped.
        self.descrever(A)
        sem_g = self.atualizar(self.edicao(A), self.edicao(B))
        job_sem_g = self.job()
        com_g = self.atualizar(self.edicao(A, G="Título totalmente diferente"), self.edicao(B, G="Outro título editado"))
        job_com_g = self.job()
        self.assertEqual((com_g["fechar"], job_com_g), (sem_g["fechar"], job_sem_g))
        self.assertEqual((com_g["fechar"]["numeros"], com_g["fechar"]["pulados"]), ([A], [{"numero": B, "motivo": "sem_descricao"}]))
        self.assertEqual(job_com_g["numeros"], [A])
        saida = sebrae_novos.caminho_saida(self.caminhos, com_g["arquivo"]).read_bytes()
        self.assertIn("Título totalmente diferente", linha_xml(saida, 2))  # the title reached the Dashboard copy...
        self.assertEqual(self.runner.iniciadas, ["fechar", "fechar"])  # ...and the routine still ran for the same ticket

    def test_titulo_g_e_descricao_h_editados_nao_mudam_o_pedido_nem_os_dados_que_a_rotina_recebe(self):
        # The pencil text goes to column H of the Dashboard copy only: the job and the text/PDF the routine reads stay the same.
        self.descrever(A)
        sem = self.atualizar(self.edicao(A), self.edicao(B))
        job_sem, dados_sem = self.job(), fin.dados_para_finalizar(self.dir, A)
        for numero, texto in ((A, "Descrição editada no lápis de A"), (B, "Descrição editada no lápis de B")):
            self.assertEqual(self.cliente.put(f"/api/sebrae/chamados/{numero}/descricao", json={"descricao": texto}).status_code, 200)
        com = self.atualizar(self.edicao(A, G="Título editado de A"), self.edicao(B, G="Título editado de B"))
        pedido_gravado = fin.caminho_job(self.dir).read_text(encoding="utf-8")
        job_com, dados_com = self.job(), fin.dados_para_finalizar(self.dir, A)
        self.assertEqual((com["fechar"], job_com, dados_com), (sem["fechar"], job_sem, dados_sem))
        self.assertEqual((com["fechar"]["numeros"], com["fechar"]["pulados"]), ([A], [{"numero": B, "motivo": "sem_descricao"}]))
        self.assertEqual(dados_com, ("feito " + A, None))  # only descricao_finalizacao, never descricao_editada
        for editado in ("lápis", "l\u00e1pis", "Título editado", "T\u00edtulo editado"):
            self.assertNotIn(editado, pedido_gravado)
        saida = sebrae_novos.caminho_saida(self.caminhos, com["arquivo"]).read_bytes()
        self.assertIn("Descrição editada no lápis de A", linha_xml(saida, 2))  # the Dashboard copy has the H...
        self.assertIn("Título editado de A", linha_xml(saida, 2))  # ...and the G
        self.assertEqual(self.runner.iniciadas, ["fechar", "fechar"])

    def test_titulo_g_nao_e_guardado_no_pedido_da_rotina(self):
        self.descrever(A)
        self.atualizar(self.edicao(A, G="Título que não pode ir ao pedido"))
        self.assertNotIn("Título que não", fin.caminho_job(self.dir).read_text(encoding="utf-8"))

    def test_sem_finalizar_softexpert_atualiza_o_dashboard_mas_nao_dispara_a_rotina(self):
        self.descrever(A)
        for corpo in ({"edicoes": [self.edicao(A)]}, {"edicoes": [self.edicao(A)], "finalizar_softexpert": False}):
            resposta = self.post(ATUALIZAR, json=corpo)
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
        self.assertEqual(self.cliente.get(FINALIZAR).json(), {"em_andamento": False, "resultado": None, "sharepoint": None, "conflitos": 0})
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
        self.assertEqual(self.post(REENVIAR).status_code, 422)
        self.assertEqual(self.runner.iniciadas, [])

    def test_reenviar_grava_pedido_de_reenvio_e_dispara_a_rotina(self):
        self.pendente()
        resposta = self.post(REENVIAR)
        self.assertEqual((resposta.status_code, resposta.json()), (202, {"iniciado": True}))
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        self.assertEqual(self.job()["acao"], fin.ACAO_REENVIAR)

    def test_reenviar_com_rotina_ocupada_responde_409(self):
        self.pendente()
        self.runner.erro = DomainConflictError("Já há uma rotina em execução.")
        self.assertEqual(self.post(REENVIAR).status_code, 409)
        self.assertFalse(fin.caminho_job(self.dir).exists())


ANTIGOS = "/api/sebrae/antigos/ler"


class LerAntigosTest(FinalizarBase):
    def test_dispara_a_rotina_antigos_com_202(self):
        self.importar()
        resposta = self.post(ANTIGOS)
        self.assertEqual((resposta.status_code, resposta.json()), (202, {"iniciado": True}))
        self.assertEqual(self.runner.iniciadas, ["antigos"])

    def test_rotina_ocupada_responde_409(self):
        self.importar()
        self.runner.erro = DomainConflictError("Já há uma rotina em execução.")
        self.assertEqual(self.post(ANTIGOS).status_code, 409)

    def test_sem_dashboard_importado_responde_422_sem_iniciar(self):
        self.assertEqual(self.post(ANTIGOS).status_code, 422)
        self.assertEqual(self.runner.iniciadas, [])

    def test_estado_traz_em_andamento_e_o_resumo_da_ultima_leitura(self):
        self.assertEqual(self.cliente.get(ANTIGOS).json(), {"em_andamento": False, "resultado": None})
        sebrae_novos.salvar_resultado_antigos(self.caminhos, {"concluido": True, "lidos": ["UTIC-2026-0001"], "falhas": {}})
        self.runner.estado = {"estado": "em_andamento", "rotina": "antigos"}
        corpo = self.cliente.get(ANTIGOS).json()
        self.assertTrue(corpo["em_andamento"])
        self.assertEqual(corpo["resultado"]["lidos"], ["UTIC-2026-0001"])
        self.runner.estado = {"estado": "em_andamento", "rotina": "sebrae"}
        self.assertFalse(self.cliente.get(ANTIGOS).json()["em_andamento"])


class LerAntigosSemRunnerTest(FinalizarBase):
    com_runner = False

    def test_sem_runner_responde_503(self):
        self.importar()
        self.assertEqual(self.post(ANTIGOS).status_code, 503)


def vinculo_manual(chamado, os, serie="BRX0001", fonte="simpress"):
    return {"fonte": fonte, "serie": serie, "os": os, "chamado": chamado}


class OsVinculadaCongeladaTest(FinalizarBase):
    """Foto da OS vinculada ao chamado, tirada quando a finalização é pedida (marca de OS finalizada da aba OS)."""

    def setUp(self):
        self.vinculos = []
        super().setUp()
        self.importar()
        self.descrever(A)

    def servicos_extras(self):
        return {"vinculos_os": lambda: self.vinculos}

    def finalizar_um(self):
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 202, resposta.text)

    def atualizar_finalizando(self):
        edicao = {"numero": A, "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        resposta = self.post(ATUALIZAR, json={"edicoes": [edicao], "finalizar_softexpert": True})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertTrue(resposta.json()["fechar"]["iniciado"])

    def congelada(self):
        return fin.ler_estado(self.dir)[A]["os_vinculada"]

    def test_finalizar_um_congela_o_vinculo_manual_e_a_foto_vale_mesmo_se_o_vinculo_mudar_depois(self):
        self.vinculos = [vinculo_manual(A, "1234", serie="BRX9")]
        self.finalizar_um()
        foto = self.congelada()
        self.assertEqual({k: foto[k] for k in ("fonte", "serie", "os", "origem")}, {"fonte": "simpress", "serie": "BRX9", "os": "1234", "origem": "manual"})
        self.assertTrue(foto["em"])
        self.vinculos = [vinculo_manual(A, "9999")]
        self.assertEqual(self.congelada(), foto)

    def test_atualizar_dashboard_com_finalizar_softexpert_congela_o_vinculo(self):
        self.vinculos = [vinculo_manual(A, "1234")]
        self.atualizar_finalizando()
        self.assertEqual((self.congelada()["os"], self.congelada()["origem"]), ("1234", "manual"))
        self.assertEqual(self.job()["numeros"], [A])

    def test_atualizar_sem_finalizar_softexpert_nao_congela_nada(self):
        self.vinculos = [vinculo_manual(A, "1234")]
        edicao = {"numero": A, "A": "CLIENTE", "B": "REDE", "D": "FINALIZADO", "J": "INCIDENTE"}
        resposta = self.post(ATUALIZAR, json={"edicoes": [edicao], "finalizar_softexpert": False})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertNotIn("os_vinculada", fin.ler_estado(self.dir).get(A, {}))

    def test_vinculo_derivado_vale_quando_nao_ha_manual_e_o_manual_vence_o_derivado(self):
        derivados = [{"fonte": "oracle", "serie": "BRX2", "os": "20", "chamado": A, "origem": "dashboard"}]
        with patch.object(sebrae_vinculos, "vinculos_derivados", return_value=derivados):
            self.finalizar_um()
        self.assertEqual({k: self.congelada()[k] for k in ("fonte", "serie", "os", "origem")}, {"fonte": "oracle", "serie": "BRX2", "os": "20", "origem": "dashboard"})
        fin.consumir_job(self.dir)  # a rotina já leu o pedido: um novo pode ser gravado
        self.vinculos = [vinculo_manual(A, "10")]
        with patch.object(sebrae_vinculos, "vinculos_derivados", return_value=derivados):
            self.finalizar_um()
        self.assertEqual((self.congelada()["os"], self.congelada()["origem"]), ("10", "manual"))

    def test_varias_os_no_mesmo_chamado_congela_a_maior(self):
        self.vinculos = [vinculo_manual(A, "10"), vinculo_manual(A, "12", serie="BRX7"), vinculo_manual(A, "11")]
        self.finalizar_um()
        self.assertEqual((self.congelada()["os"], self.congelada()["serie"]), ("12", "BRX7"))

    def test_sem_vinculo_congela_nulo_e_a_finalizacao_segue(self):
        self.finalizar_um()
        self.assertIn("os_vinculada", fin.ler_estado(self.dir)[A])
        self.assertIsNone(self.congelada())
        self.assertEqual(self.runner.iniciadas, ["fechar"])

    def test_vinculos_derivados_quebrados_nunca_bloqueiam_a_finalizacao(self):
        with patch.object(sebrae_vinculos, "vinculos_derivados", side_effect=RuntimeError("falha simulada")):
            self.finalizar_um()  # só valem os manuais (nenhum): a finalização segue
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        self.assertEqual(self.job()["numeros"], [A])

    def test_falha_no_congelamento_deixa_o_job_gravado_e_sem_foto(self):
        with patch.object(fin, "congelar_os_vinculada", side_effect=RuntimeError("falha simulada")):
            self.finalizar_um()
        self.assertEqual(self.runner.iniciadas, ["fechar"])
        self.assertNotIn("os_vinculada", fin.ler_estado(self.dir).get(A, {}))
        self.assertEqual(self.job()["numeros"], [A])

    def test_pedido_anterior_ainda_nao_consumido_responde_409_e_nao_refaz_a_foto(self):
        self.vinculos = [vinculo_manual(A, "1234")]
        self.finalizar_um()
        foto = self.congelada()
        self.vinculos = [vinculo_manual(A, "5678")]
        resposta = self.post(FINALIZAR, json={"numero": A, "confirmado": True})
        self.assertEqual(resposta.status_code, 409, resposta.text)
        self.assertEqual(self.congelada(), foto)


class MarcaSaiuDoDashboardTest(FinalizarBase):
    """Fonte c da marca: chamado aberto na importação anterior que sumiu da nova, sem finalização pelo site."""

    def setUp(self):
        self.vinculos = [vinculo_manual(A, "1234", serie="BRX1"), vinculo_manual(B, "2222", serie="BRX2")]
        super().setUp()
        self.arquivo = marcas.caminho_marcas(self.dir)
        self.importar()  # abertos: A e B (C já vem FINALIZADO)

    def servicos_extras(self):
        return {"vinculos_os": lambda: self.vinculos}

    def importar_so(self, *numeros, status=None):
        status = status or tuple("EM ABERTO" for _ in numeros)
        self.importar(montar(numeros, ultima=9, status=status))

    def registros(self):
        if not self.arquivo.exists():
            return {}
        return json.loads(self.arquivo.read_text(encoding="utf-8"))["marcas"]

    def test_chamado_que_sumiu_dos_abertos_gera_registro_congelado_com_a_os_do_vinculo(self):
        self.importar_so(B)
        registros = list(self.registros().values())
        self.assertEqual(len(registros), 1)
        registro = registros[0]
        self.assertEqual(
            {k: registro[k] for k in ("serie", "os", "chamado", "origem", "motivo")},
            {"serie": "BRX1", "os": "1234", "chamado": A, "origem": "outro_tecnico", "motivo": "saiu_do_dashboard"},
        )
        self.assertTrue(registro["detectado_em"])

    def test_chamado_que_segue_aberto_nao_gera_registro(self):
        self.importar_so(A, B)
        self.assertEqual(self.registros(), {})

    def test_chamado_finalizado_pelo_site_nao_vira_marca_de_outro_tecnico(self):
        fin.registrar_finalizacao(self.dir, A, fin.STATUS_OK, "30/10/2026 14:05")
        self.importar_so(B)
        self.assertEqual(self.registros(), {})

    def test_finalizado_no_novo_dashboard_sem_ok_do_site_conta_como_saida(self):
        self.importar_so(A, B, status=("FINALIZADO", "EM ABERTO"))
        self.assertEqual([r["chamado"] for r in self.registros().values()], [A])

    def test_sem_vinculo_nenhum_registro_e_gravado(self):
        self.vinculos = []
        with patch.object(sebrae_vinculos, "vinculos_derivados", return_value=[]):
            self.importar_so(B)
        self.assertEqual(self.registros(), {})

    def test_vinculo_derivado_e_calculado_com_os_abertos_antigos(self):
        vistos = []

        def derivados(abertos, relatorio, indice=None):
            vistos.append(sorted(a["numero"] for a in abertos))
            return [{"fonte": "oracle", "serie": "BRX3", "os": "30", "chamado": A, "origem": "dashboard"}]

        self.vinculos = []
        with patch.object(sebrae_vinculos, "vinculos_derivados", side_effect=derivados):
            self.importar_so(B)
        self.assertEqual(vistos, [[A, B]])  # os abertos ANTIGOS: a linha de A já saiu do novo Dashboard
        self.assertEqual([(r["serie"], r["os"]) for r in self.registros().values()], [("BRX3", "30")])

    def test_marcas_ilegiveis_param_a_importacao_antes_de_gravar_e_preservam_o_arquivo(self):
        self.arquivo.write_text("{quebrado", encoding="utf-8")
        antes = sebrae_novos.ler_existentes(self.caminhos.existentes)
        conteudo = montar((B,), ultima=9, status=("EM ABERTO",))
        resposta = self.post("/api/sebrae/dashboard", files={"file": ("Dashboard.xlsx", conteudo, "application/octet-stream")})
        self.assertEqual(resposta.status_code, 503, resposta.text)
        self.assertEqual(self.arquivo.read_text(encoding="utf-8"), "{quebrado")
        self.assertEqual(sebrae_novos.ler_existentes(self.caminhos.existentes), antes)  # a importação anterior segue valendo

    def test_falha_inesperada_ao_detectar_nao_bloqueia_a_importacao_e_so_registra_o_tipo_no_log(self):
        antes = sebrae_novos.ler_existentes(self.caminhos.existentes)
        conteudo = montar((B,), ultima=9, status=("EM ABERTO",))
        with patch.object(marcas, "detectar_saidas", side_effect=RuntimeError("falha simulada")):
            with self.assertLogs("routers.sebrae_dashboard", level="WARNING") as log:
                resposta = self.post("/api/sebrae/dashboard", files={"file": ("Dashboard.xlsx", conteudo, "application/octet-stream")})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertNotIn("falha simulada", resposta.text)
        self.assertTrue(any("RuntimeError" in r.getMessage() and "falha simulada" not in r.getMessage() for r in log.records))
        self.assertNotEqual(sebrae_novos.ler_existentes(self.caminhos.existentes), antes)  # o novo Dashboard foi importado
        self.assertEqual(self.registros(), {})

    def test_saida_com_serie_que_normaliza_para_vazio_nao_bloqueia_a_importacao_e_as_demais_sao_gravadas(self):
        self.vinculos = [vinculo_manual(A, "1234", serie="-"), vinculo_manual(B, "2222", serie="BRX2")]
        with self.assertLogs(marcas.logger, level="WARNING") as log:  # prova que a saída de A chegou ao tratamento novo
            self.importar(montar((C,), ultima=9, status=("FINALIZADO",)))  # ``importar`` exige 200; A e B saíram
        self.assertTrue(any("erro=DomainValidationError" in r.getMessage() and A not in r.getMessage() for r in log.records))
        self.assertEqual([(r["chamado"], r["serie"]) for r in self.registros().values()], [(B, "BRX2")])


class ConflitosRotasTest(FinalizarBase):
    URL = "/api/sebrae/dashboard/conflitos"
    CONFLITOS = [
        {"id": "aaaaaaaaaaaa", "chamado": A, "coluna": "J", "sharepoint": "valor do SP", "site": "valor do site", "tipo": "celula", "aceita_site": True},
        {"id": "bbbbbbbbbbbb", "chamado": B, "coluna": "", "sharepoint": "", "site": "", "tipo": "linha_apagada"},  # conflito antigo, sem ``aceita_site``: aceita os dois
        {"id": "dddddddddddd", "chamado": "linha:2", "coluna": "J", "sharepoint": "", "site": "valor do site", "tipo": "celula", "aceita_site": False},
    ]

    def setUp(self):
        super().setUp()
        self.importar()
        self.versao = sebrae_novos.ler_existentes(self.caminhos.existentes)["versao"]

    def gravar(self, escolhas=None):
        fin.gravar_conflitos(self.dir, base_sha256="a" * 64, sharepoint_sha256="b" * 64, gerado_sha256="c" * 64, conflitos=self.CONFLITOS)
        if escolhas:
            dados = fin.ler_conflitos(self.dir)
            fin.caminho_conflitos(self.dir).write_text(json.dumps({**dados, "escolhas": escolhas}), encoding="utf-8")

    def test_get_sem_arquivo_responde_vazio_e_sem_cache(self):
        resposta = self.cliente.get(self.URL)
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json(), {"conflitos": [], "escolhas": {}, "criado_em": "", "versao_importacao": self.versao})
        self.assertEqual(resposta.headers["cache-control"], "no-store")
        self.caminhos.existentes.unlink()
        self.assertEqual(self.cliente.get(self.URL).json()["versao_importacao"], "")  # sem importação

    def test_get_com_arquivo_devolve_conflitos_escolhas_e_data(self):
        self.gravar({"aaaaaaaaaaaa": "site"})
        corpo = self.cliente.get(self.URL).json()
        self.assertEqual(corpo["conflitos"], self.CONFLITOS)
        self.assertEqual(corpo["escolhas"], {"aaaaaaaaaaaa": "site"})
        self.assertTrue(corpo["criado_em"])
        self.assertEqual(corpo["versao_importacao"], self.versao)

    def test_estado_da_finalizacao_traz_a_contagem_de_conflitos(self):
        self.assertEqual(self.cliente.get(FINALIZAR).json()["conflitos"], 0)
        self.gravar()
        self.assertEqual(self.cliente.get(FINALIZAR).json()["conflitos"], 3)
        fin.concluir_conflitos(self.dir)
        self.assertEqual(self.cliente.get(FINALIZAR).json()["conflitos"], 0)

    def test_post_grava_escolhas_somando_as_anteriores_e_mantem_os_outros_campos(self):
        self.gravar({"aaaaaaaaaaaa": "site"})
        antes = fin.ler_conflitos(self.dir)
        resposta = self.post(self.URL, json={"escolhas": {"bbbbbbbbbbbb": "sharepoint"}})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        esperado = {"aaaaaaaaaaaa": "site", "bbbbbbbbbbbb": "sharepoint"}
        self.assertEqual(resposta.json(), {"escolhas": esperado, "enviar": {"iniciado": False, "motivo": ""}})
        depois = fin.ler_conflitos(self.dir)
        self.assertEqual(depois["escolhas"], esperado)
        self.assertEqual({k: v for k, v in depois.items() if k != "escolhas"}, {k: v for k, v in antes.items() if k != "escolhas"})
        self.assertEqual(self.runner.iniciadas, [])

    def test_post_recusa_id_inexistente_valor_invalido_campo_extra_e_sem_conflitos(self):
        self.assertEqual(self.post(self.URL, json={"escolhas": {"aaaaaaaaaaaa": "site"}}).status_code, 422)  # sem arquivo
        self.gravar()
        antes = fin.caminho_conflitos(self.dir).read_bytes()
        for corpo in (
            {"escolhas": {"cccccccccccc": "site"}},
            {"escolhas": {"aaaaaaaaaaaa": "site", "cccccccccccc": "sharepoint"}},
            {"escolhas": {"aaaaaaaaaaaa": "outro"}},
            {"escolhas": {"aaaaaaaaaaaa": "site"}, "enviar": "sim"},
            {"escolhas": {"aaaaaaaaaaaa": "site"}, "extra": 1},
            {},
        ):
            with self.subTest(corpo=corpo):
                self.assertEqual(self.post(self.URL, json=corpo).status_code, 422)
        self.assertEqual(fin.caminho_conflitos(self.dir).read_bytes(), antes)
        self.assertEqual(self.runner.iniciadas, [])
        fin.concluir_conflitos(self.dir)  # lista vazia: nada a escolher
        self.assertEqual(self.post(self.URL, json={"escolhas": {"aaaaaaaaaaaa": "site"}}).status_code, 422)

    def test_post_sem_versao_ou_com_versao_antiga_responde_409_e_nao_grava_nem_inicia_o_envio(self):
        self.gravar()
        antes = fin.caminho_conflitos(self.dir).read_bytes()
        for versao in ("", "0" * 32):
            for enviar in (False, True):
                with self.subTest(versao=versao, enviar=enviar):
                    resposta = self.post(self.URL, json={"escolhas": {"aaaaaaaaaaaa": "sharepoint"}, "enviar": enviar, "versao_importacao": versao})
                    self.assertEqual(resposta.status_code, 409, resposta.text)
        self.assertEqual(fin.caminho_conflitos(self.dir).read_bytes(), antes)
        self.assertEqual(self.runner.iniciadas, [])
        self.caminhos.existentes.unlink()  # sem importação nenhuma
        self.assertEqual(self.post(self.URL, json={"escolhas": {"aaaaaaaaaaaa": "sharepoint"}, "versao_importacao": self.versao}).status_code, 422)

    def test_post_recusa_site_em_conflito_que_nao_aceita_o_site_sem_mostrar_valores_e_aceita_sharepoint(self):
        self.gravar()
        antes = fin.caminho_conflitos(self.dir).read_bytes()
        resposta = self.post(self.URL, json={"escolhas": {"aaaaaaaaaaaa": "site", "dddddddddddd": "site"}, "enviar": True})
        self.assertEqual(resposta.status_code, 422, resposta.text)
        self.assertEqual(resposta.json()["detail"], "Esse conflito só pode manter o valor do SharePoint.")
        self.assertNotIn("valor do site", resposta.text)
        self.assertEqual(fin.caminho_conflitos(self.dir).read_bytes(), antes)
        self.assertEqual(self.runner.iniciadas, [])
        certo = self.post(self.URL, json={"escolhas": {"aaaaaaaaaaaa": "site", "bbbbbbbbbbbb": "site", "dddddddddddd": "sharepoint"}, "versao_importacao": self.versao})
        self.assertEqual(certo.status_code, 200, certo.text)  # ``site`` vale no conflito comum e no antigo sem a chave
        self.assertEqual(fin.escolhas_dos_conflitos(self.dir), {"aaaaaaaaaaaa": "site", "bbbbbbbbbbbb": "site", "dddddddddddd": "sharepoint"})

    def test_post_com_enviar_inicia_a_rotina_enviar_depois_de_gravar(self):
        self.gravar()
        resposta = self.post(self.URL, json={"escolhas": {"aaaaaaaaaaaa": "sharepoint"}, "enviar": True})
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["enviar"], {"iniciado": True, "motivo": ""})
        self.assertEqual(self.runner.iniciadas, ["enviar"])
        self.assertEqual(fin.escolhas_dos_conflitos(self.dir), {"aaaaaaaaaaaa": "sharepoint"})

    def test_post_com_enviar_e_rotina_ocupada_grava_a_escolha_e_explica_sem_iniciar(self):
        self.gravar()
        self.runner.estado = {"estado": "em_andamento", "rotina": "sebrae"}
        corpo = self.post(self.URL, json={"escolhas": {"aaaaaaaaaaaa": "site"}, "enviar": True}).json()
        self.assertFalse(corpo["enviar"]["iniciado"])
        self.assertIn("rotina em execução", corpo["enviar"]["motivo"])
        self.assertEqual(self.runner.iniciadas, [])
        self.assertEqual(fin.escolhas_dos_conflitos(self.dir), {"aaaaaaaaaaaa": "site"})


class ConflitosSemRunnerTest(FinalizarBase):
    com_runner = False
    URL = ConflitosRotasTest.URL
    CONFLITOS = ConflitosRotasTest.CONFLITOS
    gravar = ConflitosRotasTest.gravar

    def setUp(self):
        super().setUp()
        self.importar()

    def test_post_com_enviar_sem_automacao_so_grava(self):
        self.gravar()
        corpo = self.post(self.URL, json={"escolhas": {"aaaaaaaaaaaa": "site"}, "enviar": True}).json()
        self.assertEqual(corpo["enviar"], {"iniciado": False, "motivo": "A automação não está disponível neste servidor."})
        self.assertEqual(fin.escolhas_dos_conflitos(self.dir), {"aaaaaaaaaaaa": "site"})


if __name__ == "__main__":
    unittest.main()
