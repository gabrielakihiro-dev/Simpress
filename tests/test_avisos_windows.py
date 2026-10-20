import os
import subprocess
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

from scripts import automacao_rotinas_chrome as automacao
from scripts import avisos_windows as avisos


class AvisosWindowsTests(unittest.TestCase):
    def _notificar(self, run, env=None, plataforma="win32"):
        mensagens = []
        with (
            patch.dict(os.environ, env or {"SIMPRESS_AVISOS": "1"}),
            patch.object(avisos.sys, "platform", plataforma),
            patch.object(avisos.subprocess, "run", run),
        ):
            enviado = avisos.notificar("Título", "Mensagem", log=mensagens.append)
        return enviado, mensagens

    def test_desligado_por_variavel_de_ambiente(self):
        def run(*_args, **_kwargs):
            raise AssertionError("o PowerShell não deveria ser chamado")

        enviado, mensagens = self._notificar(run, env={"SIMPRESS_AVISOS": "0"})
        self.assertFalse(enviado)
        self.assertEqual(mensagens, [])

    def test_fora_do_windows_so_registra(self):
        enviado, mensagens = self._notificar(lambda *a, **k: None, plataforma="linux")
        self.assertFalse(enviado)
        self.assertIn("só no Windows", mensagens[0])

    def test_falha_timeout_e_codigo_de_erro_sao_silenciosos(self):
        def estoura(*_args, **_kwargs):
            raise OSError("powershell.exe não encontrado")

        def demora(*_args, **kwargs):
            raise subprocess.TimeoutExpired("powershell.exe", kwargs["timeout"])

        def falha(*_args, **_kwargs):
            return subprocess.CompletedProcess([], 1, stdout="", stderr="Erro do WinRT\nlinha 2")

        for run, trecho in ((estoura, "OSError"), (demora, "não respondeu"), (falha, "Erro do WinRT")):
            enviado, mensagens = self._notificar(run)
            self.assertFalse(enviado)
            self.assertEqual(len(mensagens), 1)
            self.assertIn(trecho, mensagens[0])

    def test_texto_vai_escapado_por_variavel_de_ambiente_e_sem_janela(self):
        chamadas = []

        def run(comando, **kwargs):
            chamadas.append((comando, kwargs))
            return subprocess.CompletedProcess(comando, 0, stdout="", stderr="")

        texto = 'Erro "grave" <script> & $(Remove-Item x); \'fim\''
        with (
            patch.dict(os.environ, {"SIMPRESS_AVISOS": "1"}),
            patch.object(avisos.sys, "platform", "win32"),
            patch.object(avisos.subprocess, "run", run),
        ):
            self.assertTrue(avisos.notificar("Rotina <OS> & cia", texto, log=self.fail))
        comando, kwargs = chamadas[0]
        # O texto nunca entra no comando do PowerShell, só no XML da variável de ambiente.
        self.assertFalse(any("Remove-Item" in parte or "grave" in parte for parte in comando))
        self.assertIn("-EncodedCommand", comando)
        self.assertEqual(kwargs["timeout"], avisos.TIMEOUT_S)
        self.assertEqual(kwargs["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))
        xml = kwargs["env"]["SIMPRESS_AVISO_XML"]
        self.assertIn("&lt;script&gt; &amp; $(Remove-Item x)", xml)
        self.assertIn("&quot;grave&quot;", xml)
        textos = [t.text for t in ET.fromstring(xml).iter("text")]
        self.assertEqual(textos, ["Rotina <OS> & cia", texto])

    def test_texto_longo_e_quebras_de_linha_sao_encurtados(self):
        xml = avisos.montar_xml("t", "linha 1\nlinha 2 " + "x" * 1000)
        mensagem = [t.text for t in ET.fromstring(xml).iter("text")][1]
        self.assertTrue(mensagem.startswith("linha 1 linha 2 "))
        self.assertEqual(len(mensagem), avisos.LIMITE_MENSAGEM)


class AvisoFimDaRotinaTests(unittest.TestCase):
    def setUp(self):
        aviso = patch.object(automacao, "avisar")
        self.avisar = aviso.start()
        self.addCleanup(aviso.stop)

    def test_sucesso_informa_lotes_confirmados(self):
        def rotina(_context):
            automacao.LOTES_CONFIRMADOS.append("OS_20261020_1")
            return 0

        self.assertEqual(automacao.com_aviso("OS", rotina, object()), 0)
        titulo, mensagem = self.avisar.call_args.args
        self.assertIn("rotina de OS concluída", titulo)
        self.assertIn("OS_20261020_1", mensagem)

    def test_codigo_de_falha_avisa_nao_concluida(self):
        self.assertEqual(automacao.com_aviso("inventários", lambda _c: 1, object()), 1)
        self.assertIn("não concluída", self.avisar.call_args.args[0])

    def test_excecao_avisa_erro_curto_e_propaga(self):
        def rotina(_context):
            raise TimeoutError("Locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting")

        with self.assertRaises(TimeoutError):
            automacao.com_aviso("OS", rotina, object())
        titulo, mensagem = self.avisar.call_args.args
        self.assertIn("falhou", titulo)
        self.assertEqual(mensagem, "TimeoutError: Locator.click: Timeout 30000ms exceeded.")


if __name__ == "__main__":
    unittest.main()
