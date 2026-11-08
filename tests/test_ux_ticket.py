from contextlib import contextmanager
import json
import logging
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains import ux_chamados, ux_ticket
from domains.ux_ticket import CNPJ_FATURAMENTO, TicketsUX, enderecos_correspondentes
from routers import ux_ticket as ux_ticket_router

PATO_BRANCO = "AV TUPI, 333 - BORTOT, Pato Branco - PR, 85504000"
OPCOES = [
    "AV TUPI, 3330 - BORTOT, Pato Branco - PR, 85504000",
    PATO_BRANCO,
    "AV TUPI, 333 - CENTRO, Pato Branco - PR, 85501000",
    "RUA TUPI, 333 - BORTOT, Pato Branco - PR, 85504000",
]


class Portal:
    def __init__(self):
        self.opcoes = list(OPCOES)
        self.abas = {}
        self.ceps = []
        self.escolhas = []
        self.formularios = []
        self.envios = 0
        self.falhar_envio = False
        self.falhar_antes = False
        self.fechadas = []
        self.ceps_escolha = []
        self.ceps_formulario = []

    @contextmanager
    def conectar(self):
        yield self

    def preparar(self, serial, aba, cep):
        self.abas[aba] = serial
        self.ceps.append(cep)
        return "HP 250R G9", list(self.opcoes)

    def escolher_endereco(self, serial, modelo, aba, endereco, cep):
        self.escolhas.append((aba, endereco))
        self.ceps_escolha.append(cep)

    def preencher(self, serial, modelo, aba, cep, formulario):
        if self.abas.get(aba) != serial or modelo != "HP 250R G9":
            raise ux_chamados.ErroUX(409, "Aba ou equipamento mudou.")
        self.formularios.append(formulario)
        self.ceps_formulario.append(cep)

    def enviar(self, aba, antes_do_clique):
        if self.falhar_antes:
            raise ux_chamados.ErroUX(409, "Conferência final falhou.", codigo="ux_tentativas_esgotadas")
        antes_do_clique()
        self.envios += 1
        if self.falhar_envio:
            raise TimeoutError("sem número")
        return "987654"

    def fechar(self, aba):
        self.fechadas.append(aba)


class EnderecoTests(unittest.TestCase):
    def test_real_pato_branco_case_matches_exactly_one_option(self):
        for endereco in (
            "Av. Tupi, 333 - Bortot - Pato Branco/PR - CEP 85504-000",
            "AV TUPI, 333 - BORTOT - Pato Branco/PR - CEP 85504-000",
            "Av Tupi, nº 333 - Bortot",
        ):
            with self.subTest(endereco=endereco):
                self.assertEqual(enderecos_correspondentes(OPCOES, endereco, "Pato Branco", "85504-000"), [PATO_BRANCO])

    def test_accents_and_case_are_ignored_but_nothing_is_inferred(self):
        opcoes = ["R JOSÉ DE ALENCAR, 10 - CENTRO, São José dos Pinhais - PR, 83005000"]
        self.assertEqual(enderecos_correspondentes(opcoes, "r jose de alencar, 10", "Sao Jose dos Pinhais", "83005000"), opcoes)
        # "Rua" is never mapped to "R": no inference, the user chooses.
        self.assertEqual(enderecos_correspondentes(opcoes, "Rua José de Alencar, 10", "São José dos Pinhais", "83005000"), [])
        self.assertEqual(enderecos_correspondentes(opcoes, "R José de Alencar, 10", "Curitiba", "83005000"), [])
        self.assertEqual(enderecos_correspondentes(opcoes, "R José de Alencar, 10", "São José dos Pinhais", "8300500"), [])


class TicketsUXTests(unittest.TestCase):
    def setUp(self):
        sem_trava = mock.patch.dict(os.environ)
        sem_trava.start()
        self.addCleanup(sem_trava.stop)
        os.environ.pop(ux_chamados.VAR_SEM_ENVIO, None)
        pasta = TemporaryDirectory()
        self.addCleanup(pasta.cleanup)
        self.state = Path(pasta.name)
        self.portal = Portal()
        self.relogio = 10.0
        self.servico = TicketsUX(self.state, self.portal.conectar, clock=lambda: self.relogio)
        self.solicitante = dict(nome="Pessoa Fictícia", email="teste@example.test", telefone="(41) 99999-0000")

    def preparar(self, **alteracoes):
        return self.servico.preparar(**{
            "serial": "abc123", "entrega_endereco": "Av. Tupi, 333 - Bortot - Pato Branco/PR - CEP 85504-000",
            "entrega_cidade": "Pato Branco", "entrega_cep": "85504-000", "entrega_cnpj": "75.110.585/0005-25",
            "arquivo_nome": "Transferencia_ABC123_Curitiba-Pato_Branco.xlsx", "arquivo": b"xlsx", **alteracoes,
        })

    def executar(self, sessao, **alteracoes):
        return self.servico.executar(**{
            "session_id": sessao["session_id"], "serial": "ABC123", "descricao": "Atualizar o endereço do equipamento.",
            "solicitante": self.solicitante, "chamado_interno": "", "enviar": False, "confirmado": False, **alteracoes,
        })

    def historico(self):
        return json.loads((self.state / ux_ticket.HISTORY_NAME).read_text(encoding="utf-8"))

    def test_prepare_picks_the_single_matching_address_and_returns_the_billing_cnpj(self):
        sessao = self.preparar()
        self.assertEqual(sessao["status"], "preparado")
        self.assertEqual(sessao["endereco"], PATO_BRANCO)
        self.assertEqual(sessao["cnpj_faturamento"], "75.110.585/0001-00")
        self.assertEqual(sessao["cnpj_instalacao"], "75.110.585/0005-25")
        self.assertEqual(sessao["solicitante"], {
            "nome": "Gabriel Akihiro Noda Souza", "email": "gansouza@simpress.com.br", "telefone": "(41)98751-2389",
        })
        self.assertEqual(self.portal.ceps, ["85504-000"])
        self.assertEqual([e for _, e in self.portal.escolhas], [PATO_BRANCO])
        self.assertEqual(self.portal.ceps_escolha, ["85504-000"])  # the adapter can redo the flow from scratch
        self.executar(sessao)
        self.assertEqual(self.portal.ceps_formulario, ["85504-000"])

    def test_ambiguous_address_returns_the_list_and_requires_an_exact_choice(self):
        self.portal.opcoes = [PATO_BRANCO, PATO_BRANCO.replace("BORTOT", "BORTOT II")]
        sessao = self.preparar()
        self.assertEqual(sessao["status"], "endereco_ambiguo")
        self.assertIsNone(sessao["endereco"])
        self.assertEqual(self.portal.escolhas, [])
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.executar(sessao)
        self.assertEqual((erro.exception.status, erro.exception.codigo), (409, "endereco_ambiguo"))
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.servico.escolher_endereco(session_id=sessao["session_id"], serial="ABC123", endereco="AV TUPI, 333")
        self.assertEqual(erro.exception.status, 422)
        escolha = self.servico.escolher_endereco(session_id=sessao["session_id"], serial="abc123", endereco=self.portal.opcoes[1])
        self.assertEqual(escolha["status"], "preparado")
        self.assertEqual(self.executar(sessao)["status"], "preenchido")
        self.assertEqual(self.portal.formularios[-1].endereco, self.portal.opcoes[1])

    def test_prepare_validations_never_reach_the_portal(self):
        for alteracoes in (
            {"entrega_cep": "8550400"},
            {"entrega_cep": "85501-000"},  # differs from the CEP inside the unit address
            {"entrega_cnpj": "123"},
            {"arquivo": b"x" * (5 * 1024 * 1024 + 1)},
        ):
            with self.subTest(alteracoes=list(alteracoes)), self.assertRaises(ux_chamados.ErroUX) as erro:
                self.preparar(**alteracoes)
            self.assertEqual(erro.exception.status, 422)
        self.assertEqual(self.portal.ceps, [])

    def test_simulation_fills_the_form_without_writing_history(self):
        sessao = self.preparar()
        resultado = self.executar(sessao, chamado_interno="AB-123")
        self.assertEqual(resultado, {"status": "preenchido", "serial": "ABC123"})
        formulario = self.portal.formularios[-1]
        self.assertEqual(formulario.cnpj_faturamento, CNPJ_FATURAMENTO)
        self.assertEqual(formulario.cnpj_instalacao, "75.110.585/0005-25")
        self.assertEqual((formulario.nome, formulario.chamado_interno), ("Pessoa Fictícia", "AB-123"))
        self.assertEqual(formulario.arquivo_nome, "Transferencia_ABC123_Curitiba-Pato_Branco.xlsx")
        self.assertEqual(self.portal.envios, 0)
        self.assertFalse((self.state / ux_ticket.HISTORY_NAME).exists())
        self.assertEqual(self.executar(sessao)["status"], "preenchido")  # Simular twice on the same session

    def test_invalid_form_data_is_refused_before_the_portal(self):
        sessao = self.preparar()
        for alteracoes in (
            {"descricao": "Novo endereço: [preencher]"},
            {"descricao": "Endereço novo:"},
            {"descricao": "   "},
            {"descricao": "x" * 2501},
            {"solicitante": {**self.solicitante, "telefone": " "}},
            {"chamado_interno": "12345678901"},
        ):
            with self.subTest(alteracoes=list(alteracoes)), self.assertRaises(ux_chamados.ErroUX) as erro:
                self.executar(sessao, **alteracoes)
            self.assertEqual(erro.exception.status, 422)
            self.assertNotIn("preencher", str(erro.exception))
        self.assertEqual(self.portal.formularios, [])

    def test_real_send_barriers(self):
        sessao = self.preparar()
        for alteracoes, mensagem in (
            ({"enviar": True}, "confirmação"),
            ({"enviar": True, "confirmado": True, "serial": "BRM551RN1Y"}, "BRM551RN1Y"),
        ):
            with self.subTest(mensagem=mensagem), self.assertRaises(ux_chamados.ErroUX) as erro:
                self.executar(sessao, **alteracoes)
            self.assertEqual(erro.exception.status, 422)
        os.environ[ux_chamados.VAR_SEM_ENVIO] = "1"
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.executar(sessao, enviar=True, confirmado=True)
        self.assertEqual(erro.exception.status, 422)
        self.assertEqual(self.portal.formularios, [])
        self.assertEqual(self.portal.envios, 0)
        del os.environ[ux_chamados.VAR_SEM_ENVIO]
        self.assertEqual(self.executar(sessao)["status"], "preenchido")  # simulation keeps working

    def test_confirmed_send_records_only_the_minimal_history_and_closes_the_tab(self):
        sessao = self.preparar()
        resultado = self.executar(sessao, enviar=True, confirmado=True)
        self.assertEqual(resultado, {"status": "enviado", "serial": "ABC123", "ticket": "987654"})
        self.assertEqual(self.portal.envios, 1)
        self.assertEqual(len(self.portal.fechadas), 1)
        [registro] = self.historico()
        self.assertEqual(set(registro), {"serie", "data", "ticket", "estado"})
        self.assertEqual((registro["serie"], registro["ticket"], registro["estado"]), ("ABC123", "987654", "enviado"))
        texto = (self.state / ux_ticket.HISTORY_NAME).read_text(encoding="utf-8")
        for dado in ("Pessoa", "75.110", "TUPI", "Atualizar"):
            self.assertNotIn(dado, texto)
        with self.assertRaises(ux_chamados.ErroUX):
            self.executar(sessao, enviar=True, confirmado=True)  # the session is gone: never clicks twice
        self.assertEqual(self.preparar()["ultimo_envio"]["ticket"], "987654")

    def test_uncertain_send_requires_manual_check_before_the_next_preparation(self):
        self.portal.falhar_envio = True
        sessao = self.preparar()
        resultado = self.executar(sessao, enviar=True, confirmado=True)
        self.assertEqual(resultado["status"], "incerto")
        self.assertEqual(self.portal.envios, 1)
        self.assertEqual(len(self.portal.fechadas), 1)
        self.assertEqual(self.historico()[0]["estado"], "incerto")
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.preparar()
        self.assertEqual((erro.exception.status, erro.exception.codigo), (409, "envio_incerto"))
        self.assertEqual(self.preparar(conferido=True)["status"], "preparado")
        [registro] = self.historico()
        self.assertEqual(registro["estado"], "incerto")
        self.assertIn("conferido_em", registro)

    def test_failure_before_the_click_is_not_uncertain_and_keeps_the_session(self):
        self.portal.falhar_antes = True
        sessao = self.preparar()
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.executar(sessao, enviar=True, confirmado=True)
        self.assertEqual(erro.exception.codigo, "ux_tentativas_esgotadas")
        self.assertEqual(self.portal.envios, 0)
        self.assertEqual(self.portal.fechadas, [])
        self.assertFalse((self.state / ux_ticket.HISTORY_NAME).exists())
        self.portal.falhar_antes = False
        self.assertEqual(self.executar(sessao, enviar=True, confirmado=True)["status"], "enviado")  # same session

    def test_pending_uncertain_send_blocks_the_click_without_a_new_record(self):
        sessao = self.preparar()
        (self.state / ux_ticket.HISTORY_NAME).write_text(json.dumps([
            {"serie": "ABC123", "data": "2026-11-07T10:00:00-03:00", "ticket": None, "estado": "incerto"},
        ]), encoding="utf-8")
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.executar(sessao, enviar=True, confirmado=True)
        self.assertEqual(erro.exception.codigo, "envio_incerto")
        self.assertEqual(self.portal.envios, 0)
        self.assertEqual(len(self.historico()), 1)

    def test_cancel_and_expiry_close_the_session_tab(self):
        primeira = self.preparar()
        self.servico.cancelar(primeira["session_id"])
        self.assertEqual(len(self.portal.fechadas), 1)
        with self.assertRaises(ux_chamados.ErroUX):
            self.servico.cancelar(primeira["session_id"])
        segunda = self.preparar()
        self.relogio += ux_ticket.SESSION_TTL
        with self.assertRaises(ux_chamados.ErroUX) as erro:
            self.executar(segunda)
        self.assertEqual(erro.exception.status, 409)
        self.assertEqual(len(self.portal.fechadas), 2)


class RouterTests(unittest.TestCase):
    def setUp(self):
        sem_trava = mock.patch.dict(os.environ)
        sem_trava.start()
        self.addCleanup(sem_trava.stop)
        os.environ.pop(ux_chamados.VAR_SEM_ENVIO, None)
        pasta = TemporaryDirectory()
        self.addCleanup(pasta.cleanup)
        self.portal = Portal()
        self.servico = TicketsUX(Path(pasta.name), self.portal.conectar)
        app = FastAPI()
        app.include_router(ux_ticket_router.create_ux_ticket_router(self.servico, lambda: Path("modelo.xlsx")))
        self.client = TestClient(app)
        planilha = mock.patch.object(
            ux_ticket_router, "gerar_planilha_transferencia_bytes", return_value=("Transferencia_ABC123_A-B.xlsx", b"xlsx"),
        )
        self.gerar = planilha.start()
        self.addCleanup(planilha.stop)
        self.corpo = {
            "serial": "ABC123", "entrega_cidade": "Pato Branco", "entrega_cnpj": "75.110.585/0005-25",
            "entrega_endereco": "Av. Tupi, 333 - Bortot - Pato Branco/PR - CEP 85504-000", "entrega_contato": "Pessoa",
            "entrega_cep": "85504-000",
        }

    def enviar(self, sessao, **alteracoes):
        return self.client.post("/api/ux/gerar-ticket/enviar", json={
            "session_id": sessao["session_id"], "serial": "ABC123", "descricao": "Atualizar endereço.",
            "solicitante": {"nome": "Pessoa", "email": "p@example.test", "telefone": "41999990000"}, **alteracoes,
        })

    def test_default_solicitante_route_serves_the_backend_constant_without_touching_chrome(self):
        resposta = self.client.get("/api/ux/gerar-ticket/solicitante")
        self.assertEqual(resposta.status_code, 200)
        self.assertEqual(resposta.json(), {campo: ux_chamados.SOLICITANTE_PADRAO[campo] for campo in ("nome", "email", "telefone")})

    def test_routes_prepare_simulate_and_cancel(self):
        resposta = self.client.post("/api/ux/gerar-ticket/preparar", json=self.corpo)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        sessao = resposta.json()
        self.assertEqual((sessao["status"], sessao["arquivo"]), ("preparado", "Transferencia_ABC123_A-B.xlsx"))
        self.assertEqual(self.gerar.call_args.args[1], Path("modelo.xlsx"))
        self.assertEqual(self.enviar(sessao).json()["status"], "preenchido")
        self.assertEqual(self.enviar(sessao, enviar="true", confirmado=True).status_code, 422)  # strict booleans
        self.assertEqual(self.enviar(sessao, chamado_interno="12345678901").status_code, 422)
        self.assertEqual(self.enviar(sessao, solicitante={"nome": "", "email": "p@example.test", "telefone": "1"}).status_code, 422)
        resposta = self.client.post("/api/ux/gerar-ticket/cancelar", json={"session_id": sessao["session_id"]})
        self.assertEqual(resposta.json(), {"status": "cancelado"})

    def test_transport_request_text_is_accepted_as_the_ticket_description_unchanged(self):
        # Default Registro of "Gerar ticket no UX" = the F2 "Texto para Transporte" (montarTextoSolicitacaoTransporte).
        texto = (
            "Prezados,\n\nSolicito o transporte do equipamento da unidade do Sebrae de Curitiba/PR para a unidade do Sebrae"
            " de Pato Branco/PR\n\nO transporte dos equipamentos é previsto em edital e de responsabilidade da Simpress.\n\n"
            "Endereço para Retirada: Rua Fictícia, 1 - Centro - Curitiba/PR\n"
            "Endereço para Entrega: Av. Tupi, 333 - Bortot - Pato Branco/PR - CEP 85504-000"
        )
        sessao = self.client.post("/api/ux/gerar-ticket/preparar", json=self.corpo).json()
        resposta = self.enviar(sessao, descricao=texto)
        self.assertEqual(resposta.status_code, 200, resposta.text)
        self.assertEqual(resposta.json()["status"], "preenchido")
        self.assertEqual(self.portal.formularios[-1].descricao, texto)
        # Without the delivery address the text ends in ":" and stays blocked, as in the modal.
        self.assertEqual(self.enviar(sessao, descricao=texto.split("\nEndereço para Entrega")[0] + "\nEndereço para Entrega:").status_code, 422)

    def test_test_series_real_send_is_refused_with_422(self):
        sessao = self.client.post("/api/ux/gerar-ticket/preparar", json={**self.corpo, "serial": "BRM551RN1Y"}).json()
        resposta = self.enviar(sessao, serial="BRM551RN1Y", enviar=True, confirmado=True)
        self.assertEqual(resposta.status_code, 422)
        self.assertEqual(self.portal.envios, 0)

    def test_unexpected_playwright_error_becomes_plain_message_and_logs_only_the_class(self):
        def falhar(*_args):
            raise RuntimeError("selector input#nome value=Pessoa CNPJ 75.110.585/0005-25")
        self.portal.preparar = falhar
        with self.assertLogs("routers.ux_chamados", level=logging.WARNING) as logs:
            resposta = self.client.post("/api/ux/gerar-ticket/preparar", json=self.corpo)
        self.assertEqual(resposta.status_code, 503)
        self.assertEqual(resposta.json()["codigo"], "ux_falha")
        self.assertNotIn("75.110", resposta.text + "".join(logs.output))
        self.assertEqual(logs.output, ["WARNING:routers.ux_chamados:UX: RuntimeError"])

    def test_busy_chrome_and_unavailable_chrome_keep_their_status(self):
        for status, codigo in ((409, None), (503, "chrome_indisponivel")):
            @contextmanager
            def ocupado():
                raise ux_chamados.ErroUX(status, "Chrome", codigo=codigo)
                yield
            self.servico._conectar = ocupado
            resposta = self.client.post("/api/ux/gerar-ticket/preparar", json=self.corpo)
            self.assertEqual((resposta.status_code, resposta.json()["codigo"]), (status, codigo))


if __name__ == "__main__":
    unittest.main()
