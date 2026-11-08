"""Perfil de automação em "Continuar de onde parou" para o login sobreviver ao fechar pelo X."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import automacao_rotinas_chrome as automacao


class ManterLoginAoFecharTest(unittest.TestCase):
    def setUp(self):
        self.pasta = tempfile.TemporaryDirectory()
        self.addCleanup(self.pasta.cleanup)
        self.perfil = Path(self.pasta.name)
        (self.perfil / "Default").mkdir()
        patcher = patch.object(automacao, "CHROME_PROFILE_DIR", self.perfil)
        patcher.start()
        self.addCleanup(patcher.stop)

    def gravar(self, nome, dados):
        (self.perfil / "Default" / nome).write_text(json.dumps(dados) if not isinstance(dados, str) else dados, encoding="utf-8")

    def test_le_a_preferencia_em_qualquer_arquivo_do_perfil(self):
        self.assertFalse(automacao.continuar_de_onde_parou_gravado())
        self.gravar("Preferences", "{corrompido")
        self.gravar("Secure Preferences", {"session": {"restore_on_startup": 5}})
        self.assertFalse(automacao.continuar_de_onde_parou_gravado())
        self.gravar("Secure Preferences", {"session": {"restore_on_startup": 1}})
        self.assertTrue(automacao.continuar_de_onde_parou_gravado())

    def test_ja_gravada_nao_abre_processo(self):
        self.gravar("Preferences", {"session": {"restore_on_startup": 1}})
        with patch.object(automacao.subprocess, "run") as run:
            automacao.manter_login_ao_fechar()
        run.assert_not_called()

    def test_grava_pela_pagina_de_configuracoes_em_processo_proprio(self):
        with patch.object(automacao.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                patch.object(automacao, "log") as log:
            automacao.manter_login_ao_fechar()
        args = run.call_args.args[0]
        self.assertIn("chrome://settings/onStartup", args[2])
        self.assertIn("'session.restore_on_startup', 1", args[2])
        self.assertEqual(args[3], automacao.CDP_URL)
        self.assertIn("Continuar de onde parou", log.call_args.args[1])

    def test_falha_so_avisa_e_nao_interrompe(self):
        for efeito in (subprocess.CompletedProcess([], 1), subprocess.TimeoutExpired("x", 30), OSError("sem python")):
            kwargs = {"return_value": efeito} if isinstance(efeito, subprocess.CompletedProcess) else {"side_effect": efeito}
            with patch.object(automacao.subprocess, "run", **kwargs), patch.object(automacao, "log") as log:
                automacao.manter_login_ao_fechar()
            self.assertIn("Não foi possível", log.call_args.args[1])

    def test_so_roda_quando_o_chrome_e_aberto_agora(self):
        with patch.object(automacao, "cdp_ativo", return_value=True), \
                patch.object(automacao, "manter_login_ao_fechar") as manter, patch.object(automacao, "log"):
            automacao.garantir_chrome()
        manter.assert_not_called()
        with patch.object(automacao, "cdp_ativo", side_effect=[False, True]), \
                patch.object(automacao, "encerrar_chrome_do_perfil", return_value=0), \
                patch.object(automacao, "localizar_chrome", return_value=Path("chrome.exe")), \
                patch.object(automacao.subprocess, "Popen"), \
                patch.object(automacao, "manter_login_ao_fechar") as manter, patch.object(automacao, "log"):
            automacao.garantir_chrome()
        manter.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
