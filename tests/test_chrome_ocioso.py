"""Idle close of the automation Chrome: clock, lock stamp, live sessions and the close itself."""

import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from domains import chrome_ocioso, endpoint_lookup
from domains.chrome_ocioso import FechamentoOcioso
from domains.ux_chamados import ChamadosUX
from domains.ux_ticket import TicketsUX

automation = endpoint_lookup.automation


class Relogio:
    def __init__(self, agora: float = 1000.0) -> None:
        self.agora = agora

    def __call__(self) -> float:
        return self.agora


def fechamento(relogio, **kwargs):
    fechar = kwargs.pop("fechar", MagicMock())
    padrao = {"ultimo_uso": lambda: None, "ocupado": lambda: False, "cdp_ativo": lambda: True}
    padrao.update(kwargs)
    return FechamentoOcioso(limite=600, fechar=fechar, relogio=relogio, **padrao), fechar


class FechamentoOciosoTests(unittest.TestCase):
    def test_closes_only_after_ten_idle_minutes_counted_from_server_start(self):
        relogio = Relogio()
        verificador, fechar = fechamento(relogio)
        relogio.agora += 599
        self.assertFalse(verificador.verificar())
        relogio.agora += 1
        self.assertTrue(verificador.verificar())
        fechar.assert_called_once_with()
        relogio.agora += 60
        self.assertFalse(verificador.verificar())  # the next close needs another full idle stretch

    def test_lock_use_resets_the_clock(self):
        relogio = Relogio()
        uso = {"mtime": None}
        verificador, fechar = fechamento(relogio, ultimo_uso=lambda: uso["mtime"])
        relogio.agora += 500
        uso["mtime"] = relogio.agora  # a 10 s Endpoint lookup between two ticks
        relogio.agora += 500
        self.assertFalse(verificador.verificar())
        relogio.agora += 100
        self.assertTrue(verificador.verificar())
        fechar.assert_called_once_with()

    def test_busy_lock_or_live_session_never_closes(self):
        relogio = Relogio()
        ocupado = {"valor": True}
        verificador, fechar = fechamento(relogio, ocupado=lambda: ocupado["valor"])
        for _ in range(30):
            relogio.agora += 60
            self.assertFalse(verificador.verificar())
        ocupado["valor"] = False
        relogio.agora += 599
        self.assertFalse(verificador.verificar())  # the clock restarts when the session ends
        relogio.agora += 1
        self.assertTrue(verificador.verificar())
        fechar.assert_called_once_with()

    def test_closed_chrome_is_left_alone(self):
        relogio = Relogio()
        verificador, fechar = fechamento(relogio, cdp_ativo=lambda: False)
        relogio.agora += 3600
        self.assertFalse(verificador.verificar())
        fechar.assert_not_called()

    def test_limit_comes_from_the_environment(self):
        for valor, esperado in (("", 600), ("120", 120.0), ("0", 0.0), ("x", 600)):
            with self.subTest(valor=valor), patch.dict(os.environ, {"SIMPRESS_CHROME_OCIOSO_S": valor}):
                self.assertEqual(chrome_ocioso.limite_configurado(), esperado)


class CarimboDaTravaTests(unittest.TestCase):
    def test_acquire_and_release_touch_the_usage_stamp(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(automation, "TRAVA_PATH", Path(tmp) / "automacao_chrome.lock"):
            self.assertIsNone(automation.ultimo_uso())
            with automation.trava_execucao("teste"):
                no_meio = automation.ultimo_uso()
                self.assertIsNotNone(no_meio)
                os.utime(automation.caminho_ultimo_uso(), (1, 1))
            self.assertGreater(automation.ultimo_uso(), 1)
            self.assertEqual(automation.caminho_ultimo_uso().parent, Path(tmp))


class SessoesVivasTests(unittest.TestCase):
    def setUp(self):
        endpoint_lookup._abas_de_sessao.clear()
        self.addCleanup(endpoint_lookup._abas_de_sessao.clear)

    def test_no_registered_tab_needs_no_cdp_call(self):
        with patch("urllib.request.urlopen") as urlopen:
            self.assertFalse(endpoint_lookup.sessao_viva())
        urlopen.assert_not_called()

    def test_registered_tab_lives_until_it_leaves_the_cdp_list(self):
        aba = MagicMock()
        aba.context.new_cdp_session.return_value.send.return_value = {"targetInfo": {"targetId": "T1"}}
        endpoint_lookup._registrar_sessao(aba)
        resposta = lambda alvos: io.BytesIO(json.dumps(alvos).encode())
        with patch("urllib.request.urlopen", return_value=resposta([{"id": "T1"}, {"id": "T2"}])):
            self.assertTrue(endpoint_lookup.sessao_viva())
        with patch("urllib.request.urlopen", return_value=resposta([{"id": "T2"}])):
            self.assertFalse(endpoint_lookup.sessao_viva())
        self.assertEqual(endpoint_lookup._abas_de_sessao, set())

    def test_unreadable_cdp_list_counts_as_alive(self):
        endpoint_lookup._abas_de_sessao.add("T1")
        with patch("urllib.request.urlopen", side_effect=OSError("down")):
            self.assertTrue(endpoint_lookup.sessao_viva())

    def test_prepared_ux_sessions_count_until_they_expire(self):
        for classe in (ChamadosUX, TicketsUX):
            with self.subTest(classe=classe.__name__), tempfile.TemporaryDirectory() as tmp:
                relogio = Relogio()
                servico = classe(Path(tmp), MagicMock(), clock=relogio)
                self.assertFalse(servico.tem_sessao_viva())
                servico._sessoes["s"] = SimpleNamespace(expira=relogio.agora + 10, aba="simpress-aba")
                self.assertTrue(servico.tem_sessao_viva())
                relogio.agora += 10
                self.assertFalse(servico.tem_sessao_viva())
                self.assertEqual(servico._a_fechar, ["simpress-aba"])


class FecharChromeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for alvo, valor in ((automation, {"TRAVA_PATH": Path(tmp.name) / "lock"}), (chrome_ocioso, {"ESPERA_FECHAR_S": 0})):
            for nome, novo in valor.items():
                patcher = patch.object(alvo, nome, novo)
                patcher.start()
                self.addCleanup(patcher.stop)
        self.pw = MagicMock()
        fabrica = MagicMock()
        fabrica.return_value.__enter__.return_value = self.pw
        patcher = patch("playwright.sync_api.sync_playwright", fabrica)
        patcher.start()
        self.addCleanup(patcher.stop)

    def enviado(self):
        return self.pw.chromium.connect_over_cdp.return_value.new_browser_cdp_session.return_value.send

    def test_graceful_close_skips_the_process_kill(self):
        with patch.object(automation, "cdp_ativo", return_value=False), patch.object(automation, "encerrar_chrome_do_perfil") as matar:
            chrome_ocioso.fechar_chrome_de_automacao(lambda: False)
        self.enviado().assert_called_once_with("Browser.close")
        matar.assert_not_called()
        self.assertFalse(automation.TRAVA_PATH.exists())

    def test_port_still_open_falls_back_to_the_profile_processes(self):
        with patch.object(automation, "cdp_ativo", return_value=True), patch.object(automation, "encerrar_chrome_do_perfil") as matar:
            chrome_ocioso.fechar_chrome_de_automacao(lambda: False)
        matar.assert_called_once_with()

    def test_session_opened_meanwhile_or_busy_lock_keeps_chrome(self):
        with patch.object(automation, "encerrar_chrome_do_perfil") as matar:
            chrome_ocioso.fechar_chrome_de_automacao(lambda: True)
            with patch.object(automation, "adquirir_trava", side_effect=automation.TravaOcupada("ocupada")):
                chrome_ocioso.fechar_chrome_de_automacao(lambda: False)
        self.pw.chromium.connect_over_cdp.assert_not_called()
        matar.assert_not_called()


class EndpointReabreChromeTests(unittest.TestCase):
    def test_endpoint_tab_reopens_chrome_before_connecting(self):
        ordem = []
        pw = MagicMock()
        pw.chromium.connect_over_cdp.side_effect = lambda *a, **k: ordem.append("conectar") or MagicMock(contexts=[])
        with patch.object(automation, "garantir_chrome", side_effect=lambda: ordem.append("garantir")), self.assertRaises(RuntimeError):
            endpoint_lookup._preparar_aba(pw)
        self.assertEqual(ordem, ["garantir", "conectar"])



class AssistenteExplicaTests(unittest.TestCase):
    def test_assistant_explains_the_idle_close(self):
        from domains.assistant_chat import SYSTEM_PROMPT

        regra = SYSTEM_PROMPT[SYSTEM_PROMPT.index("35. Chrome de automação fechado sozinho"):].splitlines()[0]
        for trecho in ("10 minutos", "PowerShell", "Navegar à mão", "reabre o Chrome sozinha"):
            self.assertIn(trecho, regra)


if __name__ == "__main__":
    unittest.main()
