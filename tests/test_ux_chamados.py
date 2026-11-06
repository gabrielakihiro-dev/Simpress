from contextlib import contextmanager
import json
import os
import unittest
from unittest import mock
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import HTTPException
from pydantic import ValidationError

from domains import ux_chamados
from routers.ux_chamados import EnviarPayload, PrepararPayload, create_ux_chamados_router


class Portal:
    def __init__(self):
        self.abas = {}
        self.fills = []
        self.envios = 0
        self.falhar_envio = False
        self.fechadas = []
        self.falhar_fechar = False

    def fechar(self, aba):
        if self.falhar_fechar:
            raise RuntimeError("aba já fechada")
        self.fechadas.append(aba)

    @contextmanager
    def conectar(self):
        yield self

    def preparar(self, serial, aba):
        self.abas[aba] = (serial, "Modelo X")
        return "Modelo X", ["Não liga", "Impressões escuras", "HARDWARE – placa", "Problema de hardware"]

    def validar(self, serial, modelo, aba):
        if self.abas.get(aba) != (serial, modelo):
            raise ux_chamados.ErroUX(409, "Aba ou equipamento mudou.")

    def preencher(self, serial, modelo, aba, problema, descricao, solicitante):
        self.fills.append((serial, problema, descricao, solicitante))

    def enviar(self, aba):
        self.envios += 1
        if self.falhar_envio:
            raise TimeoutError("resposta perdida")
        return "12345"


class UxChamadosTests(unittest.TestCase):
    def setUp(self):
        # Hermetic: the real-send kill switch of the developer's shell must not change these tests.
        sem_trava = mock.patch.dict(os.environ)
        sem_trava.start()
        self.addCleanup(sem_trava.stop)
        os.environ.pop(ux_chamados.VAR_SEM_ENVIO, None)
        pasta = TemporaryDirectory()
        self.addCleanup(pasta.cleanup)
        self.state = Path(pasta.name)
        self.perfil = {"nome": "Pessoa Fictícia", "telefone": "41999990000", "email": "teste@example.test", "ramal": "", "departamento_cargo": "Suporte"}
        (self.state / "ux_solicitante.json").write_text(json.dumps(self.perfil), encoding="utf-8")
        self.portal = Portal()
        self.relogio = 10.0
        self.servico = ux_chamados.ChamadosUX(self.state, self.portal.conectar, clock=lambda: self.relogio)
        self.descricao = "O notebook não liga mesmo com o carregador conectado."

    def preparar(self):
        return self.servico.preparar("S123")

    def executar(self, sessao, **alteracoes):
        return self.servico.executar(**{
            "session_id": sessao["session_id"], "serial": "S123", "problema": "Não liga",
            "descricao": self.descricao, "enviar": False, "confirmado": False, **alteracoes,
        })

    def test_preparar_reads_valid_options_without_filling_or_writing(self):
        resultado = self.preparar()
        self.assertEqual(resultado["modelo"], "Modelo X")
        self.assertEqual(resultado["opcoes"], ["Não liga", "Problema de hardware"])
        self.assertEqual(self.portal.fills, [])
        self.assertEqual(self.portal.envios, 0)
        self.assertEqual(list(self.state.glob("*")), [self.state / "ux_solicitante.json"])

    def test_dry_run_then_confirmed_send_records_only_minimum_history(self):
        sessao = self.preparar()
        self.assertEqual(self.executar(sessao)["status"], "preenchido")
        self.assertEqual(self.portal.fills, [("S123", "Não liga", self.descricao, self.perfil)])
        self.assertEqual(self.portal.envios, 0)
        with self.assertRaises(ux_chamados.ErroUX):
            self.executar(sessao, enviar=True)
        self.assertEqual(self.portal.envios, 0)
        self.assertEqual(self.executar(sessao, enviar=True, confirmado=True)["os"], "12345")
        registro, = json.loads((self.state / "ux_chamados_historico.json").read_text(encoding="utf-8"))
        self.assertEqual(set(registro), {"serie", "data", "os", "estado"})
        self.assertEqual((registro["serie"], registro["os"], registro["estado"]), ("S123", "12345", "enviado"))
        with self.assertRaises(ux_chamados.ErroUX):
            self.executar(sessao, enviar=True, confirmado=True)
        self.assertEqual(self.portal.envios, 1)

    def test_test_serial_and_kill_switch_refuse_real_send_but_allow_dry_run(self):
        casos = [("BRM551RN1Y", {}, ux_chamados.MSG_SERIE_TESTE),
                 ("S123", {ux_chamados.VAR_SEM_ENVIO: "1"}, ux_chamados.MSG_SEM_ENVIO)]
        for serial, ambiente, mensagem in casos:
            with self.subTest(serial=serial), mock.patch.dict(os.environ, ambiente):
                sessao = self.servico.preparar(serial)
                dados = {"session_id": sessao["session_id"], "serial": serial, "problema": "Não liga", "descricao": self.descricao}
                with self.assertRaises(ux_chamados.ErroUX) as erro:
                    self.servico.executar(**dados, enviar=True, confirmado=True)
                self.assertEqual((erro.exception.status, str(erro.exception)), (422, mensagem))
                self.assertEqual(self.servico.executar(**dados, enviar=False, confirmado=False)["status"], "preenchido")
        self.assertEqual(self.portal.envios, 0)
        self.assertFalse((self.state / "ux_chamados_historico.json").exists())

    def test_timeout_cannot_retry_until_explicit_review(self):
        sessao = self.preparar()
        self.portal.falhar_envio = True
        self.assertEqual(self.executar(sessao, enviar=True, confirmado=True)["status"], "incerto")
        with self.assertRaises(ux_chamados.ErroUX):
            self.executar(sessao, enviar=True, confirmado=True)
        with self.assertRaises(ux_chamados.ErroUX):
            self.preparar()
        primeira_tentativa, = self.servico._historico()
        conferida = self.servico.preparar("S123", conferido=True)
        self.assertEqual(conferida["modelo"], "Modelo X")
        self.portal.falhar_envio = False
        self.assertEqual(self.executar(conferida, enviar=True, confirmado=True)["status"], "enviado")
        # A conferência continua valendo após reiniciar o serviço, sem apagar a tentativa incerta.
        self.servico = ux_chamados.ChamadosUX(self.state, self.portal.conectar, clock=lambda: self.relogio)
        sessao = self.preparar()
        incerto, sucesso = self.servico._historico()
        self.assertEqual({chave: incerto[chave] for chave in primeira_tentativa}, primeira_tentativa)
        self.assertTrue(incerto["conferido_em"])
        self.assertEqual(sucesso["estado"], "enviado")
        self.portal.falhar_envio = True
        self.assertEqual(self.executar(sessao, enviar=True, confirmado=True)["status"], "incerto")
        with self.assertRaisesRegex(ux_chamados.ErroUX, "Confira se o chamado foi criado"):
            self.preparar()
        self.assertEqual(self.portal.envios, 3)

    def test_mismatched_expired_cancelled_and_modified_sessions_never_fill(self):
        sessao = self.preparar()
        with self.assertRaises(ux_chamados.ErroUX):
            self.executar(sessao, serial="S456")
        self.servico.cancelar(sessao["session_id"])
        with self.assertRaises(ux_chamados.ErroUX):
            self.executar(sessao)
        sessao = self.preparar()
        self.portal.abas[next(reversed(self.portal.abas))] = ("S123", "Outro modelo")
        with self.assertRaises(ux_chamados.ErroUX):
            self.executar(sessao)
        sessao = self.preparar()
        self.relogio += 1800
        with self.assertRaises(ux_chamados.ErroUX):
            self.executar(sessao)
        self.assertEqual(self.portal.fills, [])

    def test_session_tab_is_closed_on_cancel_expiry_replacement_and_send_result(self):
        sessao = self.preparar()
        primeira = list(self.portal.abas)[-1]
        self.servico.cancelar(sessao["session_id"])
        self.assertEqual(self.portal.fechadas, [primeira])

        self.preparar()
        segunda = list(self.portal.abas)[-1]
        self.preparar()  # replaces the previous session
        terceira = list(self.portal.abas)[-1]
        self.assertEqual(self.portal.fechadas, [primeira, segunda])

        self.relogio += 1800  # expired: the next request closes the tab
        with self.assertRaises(ux_chamados.ErroUX):
            self.servico.executar(session_id="0" * 32, serial="S123", problema="Não liga",
                                  descricao=self.descricao, enviar=False, confirmado=False)
        self.assertEqual(self.portal.fechadas, [primeira, segunda, terceira])

        sessao = self.preparar()
        quarta = list(self.portal.abas)[-1]
        self.executar(sessao)  # dry run keeps the tab for the confirmed send
        self.assertNotIn(quarta, self.portal.fechadas)
        self.assertEqual(self.executar(sessao, enviar=True, confirmado=True)["status"], "enviado")
        self.assertEqual(self.portal.fechadas[-1], quarta)

        self.portal.falhar_envio = True
        sessao = self.servico.preparar("S123", conferido=True)
        quinta = list(self.portal.abas)[-1]
        self.assertEqual(self.executar(sessao, enviar=True, confirmado=True)["status"], "incerto")
        self.assertEqual(self.portal.fechadas[-1], quinta)
        self.assertEqual(self.portal.envios, 2)  # closing never clicks again

    def test_failing_to_close_the_tab_never_masks_the_result(self):
        sessao = self.preparar()
        self.portal.falhar_fechar = True
        self.assertEqual(self.executar(sessao, enviar=True, confirmado=True)["os"], "12345")
        sessao = self.preparar()
        self.assertEqual(self.servico.cancelar(sessao["session_id"]), {"status": "cancelado"})

    def test_refuses_unavailable_problem_and_description_with_unfilled_prompt(self):
        sessao = self.preparar()
        for mudanca in (
            {"problema": "Impressões escuras"},
            {"descricao": " "},
            {"descricao": "Solicito o kit, pois [descrever o motivo da solicitação]."},
            {"descricao": "Solicito o kit.\nNome do(a) Colaborador(a):\nHorário de funcionamento:"},
        ):
            with self.subTest(mudanca=mudanca), self.assertRaises(ux_chamados.ErroUX):
                self.executar(sessao, **mudanca)
        self.assertEqual(self.portal.fills, [])


    def test_unexpected_failure_returns_503_and_logs_only_the_class_name(self):
        class Falha(Exception):
            pass

        def explode(_serial, **_kwargs):
            raise Falha("valor secreto do formulário")

        self.servico.preparar = explode
        router = create_ux_chamados_router(self.servico, lambda _serial: {})
        rotas = {rota.path.rsplit("/", 1)[-1]: rota.endpoint for rota in router.routes}
        with self.assertLogs("routers.ux_chamados", "WARNING") as logs, self.assertRaises(HTTPException) as erro:
            rotas["preparar"](PrepararPayload(serial="s123"))
        self.assertEqual(erro.exception.status_code, 503)
        self.assertEqual(logs.output, ["WARNING:routers.ux_chamados:UX: Falha"])

    def test_invalid_or_unconfirmed_writes_never_reach_the_portal(self):
        router = create_ux_chamados_router(self.servico, lambda _serial: {})
        rotas = {rota.path.rsplit("/", 1)[-1]: rota.endpoint for rota in router.routes}
        preparo = rotas["preparar"](PrepararPayload(serial="s123"))
        self.assertEqual(preparo["serial"], "S123")
        dados = {"session_id": preparo["session_id"], "serial": "S123", "problema": "Não liga", "descricao": self.descricao}
        with self.assertRaises(ValidationError):
            EnviarPayload(**dados, enviar="true", confirmado=True)
        self.assertEqual(rotas["enviar"](EnviarPayload(**dados, enviar=True)).status_code, 422)
        self.assertEqual(self.portal.fills, [])
        self.assertEqual(self.portal.envios, 0)
        self.assertEqual(rotas["enviar"](EnviarPayload(**dados))["status"], "preenchido")
        self.assertEqual(self.portal.envios, 0)
