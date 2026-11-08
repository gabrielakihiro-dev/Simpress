import unittest
import unittest.mock
from pathlib import Path

from scripts import automacao_rotinas_chrome as automacao


class EtapaResilienteTests(unittest.TestCase):
    def test_succeeds_after_retrying_and_calls_recuperar_between_attempts(self):
        chamadas = []

        def etapa():
            chamadas.append(1)
            if len(chamadas) < 3:
                raise automacao.EtapaInstavel("instável")
            return "ok"

        recuperar = unittest.mock.Mock()
        resultado = automacao.etapa_resiliente(etapa, "passo de teste", tentativas=3, recuperar=recuperar)

        self.assertEqual(resultado, "ok")
        self.assertEqual(len(chamadas), 3)
        self.assertEqual(recuperar.call_count, 2)

    def test_reraises_original_exception_when_attempts_are_exhausted(self):
        chamadas = []

        def etapa():
            chamadas.append(1)
            raise automacao.EtapaInstavel("O Dashboard no SharePoint mudou depois da importação")

        with self.assertRaises(automacao.EtapaInstavel) as contexto:
            automacao.etapa_resiliente(etapa, "passo de teste", tentativas=3, recuperar=unittest.mock.Mock())

        self.assertEqual(str(contexto.exception), "O Dashboard no SharePoint mudou depois da importação")
        self.assertEqual(len(chamadas), 3)

    def test_does_not_retry_a_plain_rotina_erro(self):
        chamadas = []

        def etapa():
            chamadas.append(1)
            raise automacao.RotinaErro("erro irreversível, sem retry")

        recuperar = unittest.mock.Mock()
        with self.assertRaises(automacao.RotinaErro):
            automacao.etapa_resiliente(etapa, "passo de teste", tentativas=3, recuperar=recuperar)

        self.assertEqual(len(chamadas), 1)
        recuperar.assert_not_called()


class AguardarEstabilidadePreCliqueTests(unittest.TestCase):
    def test_raises_plain_rotina_erro_not_etapa_instavel_when_cursor_never_stabilizes(self):
        # Cursor instável nas 20 janelas (~12 s) seguidas: só aí levanta, sem EtapaInstavel (nunca repete o clique).
        with unittest.mock.patch.object(automacao, "obter_posicao_cursor", side_effect=[(0, 0), (50, 50)] * 20), \
                unittest.mock.patch.object(automacao.time, "sleep") as sleep, \
                unittest.mock.patch.object(automacao, "verificar_cancelamento"):
            with self.assertRaises(automacao.RotinaErro) as contexto:
                automacao.aguardar_estabilidade_pre_clique(lambda: True, "Clique de teste")
        self.assertNotIsInstance(contexto.exception, automacao.EtapaInstavel)
        self.assertEqual(sleep.call_count, 20)
        self.assertAlmostEqual(sum(chamada.args[0] for chamada in sleep.call_args_list), 12.0)

    def test_tolerates_about_twelve_seconds_of_moving_cursor_before_stabilizing(self):
        # Mouse em movimento por 19 janelas (~11,4 s) e parado na 20a: retorna sem levantar (o antigo limite de 3 abortava).
        posicoes = [(0, 0), (50, 50)] * 19 + [(10, 10), (10, 10)]
        with unittest.mock.patch.object(automacao, "obter_posicao_cursor", side_effect=posicoes), \
                unittest.mock.patch.object(automacao.time, "sleep") as sleep, \
                unittest.mock.patch.object(automacao, "verificar_cancelamento"):
            automacao.aguardar_estabilidade_pre_clique(lambda: True, "Clique de teste")
        self.assertEqual(sleep.call_count, 20)

    def test_raises_plain_rotina_erro_when_state_check_fails_in_every_window(self):
        with unittest.mock.patch.object(automacao, "obter_posicao_cursor", return_value=(0, 0)), \
                unittest.mock.patch.object(automacao.time, "sleep"), \
                unittest.mock.patch.object(automacao, "verificar_cancelamento"):
            with self.assertRaises(automacao.RotinaErro) as contexto:
                automacao.aguardar_estabilidade_pre_clique(lambda: False, "Clique de teste")
        self.assertNotIsInstance(contexto.exception, automacao.EtapaInstavel)

    def test_recovers_after_an_unstable_window_without_raising(self):
        # Tremor do mouse só na 1a janela: a 2a estabiliza e a espera retorna normal, sem levantar nada
        # (a repetição é só da espera, nunca do clique, que fica a cargo de quem chama, uma única vez).
        with unittest.mock.patch.object(automacao, "obter_posicao_cursor", side_effect=[(0, 0), (50, 50), (10, 10), (10, 10)]), \
                unittest.mock.patch.object(automacao.time, "sleep") as sleep, \
                unittest.mock.patch.object(automacao, "verificar_cancelamento"):
            automacao.aguardar_estabilidade_pre_clique(lambda: True, "Clique de teste")
        self.assertEqual(sleep.call_count, 2)


class ExportarOracleRetryTests(unittest.TestCase):
    def test_reabre_a_gestao_de_solicitacoes_do_zero_em_cada_tentativa_de_pesquisa(self):
        # Caso relatado: algo fechado dentro do Oracle (não a aba) trava "Pesquisando..." sem erro
        # visível. A pesquisa precisa reabrir a Gestão de Solicitações e reaquirir o campo a cada
        # tentativa, nunca reusar o campo (possivelmente morto) da tentativa anterior.
        campo1, campo2 = unittest.mock.MagicMock(), unittest.mock.MagicMock()
        for campo in (campo1, campo2):
            campo.input_value.return_value = automacao.FILTRO_ORACLE
        page = unittest.mock.MagicMock()

        with (
            unittest.mock.patch.object(automacao, "nova_aba", return_value=page),
            unittest.mock.patch.object(automacao, "aguardar_login"),
            unittest.mock.patch.object(automacao, "definir_pagina_ativa_para_recuperacao"),
            unittest.mock.patch.object(automacao, "abrir_gestao_solicitacoes", side_effect=[campo1, campo2]) as abrir,
            unittest.mock.patch.object(automacao, "aguardar_estado", side_effect=[TimeoutError("travou"), None]),
            unittest.mock.patch.object(automacao, "visivel", return_value=True),
            unittest.mock.patch.object(automacao, "exportar_com_download", return_value=Path("Gestão de Solicitações.xlsx")),
            unittest.mock.patch.object(automacao, "verificar_cancelamento"),
            unittest.mock.patch.object(automacao.time, "sleep"),
            unittest.mock.patch.object(automacao, "log"),
        ):
            arquivo = automacao.exportar_oracle(unittest.mock.MagicMock())

        self.assertEqual(arquivo, Path("Gestão de Solicitações.xlsx"))
        self.assertEqual(abrir.call_count, 2)
        campo1.press_sequentially.assert_called_once()
        campo2.press_sequentially.assert_called_once()  # preenche o campo reaberto, não o antigo (campo1)
        page.close.assert_called_once()

    def test_volta_ao_link_do_oracle_com_goto_e_nunca_recarrega(self):
        # page.reload() na tela da Microsoft perde o SAMLRequest (AADSTS750054); a volta é sempre goto(ORACLE_URL).
        page = unittest.mock.MagicMock()
        with (
            unittest.mock.patch.object(automacao, "esperar_visivel", return_value=False),
            unittest.mock.patch.object(automacao, "reabrir_filtros_oracle", return_value=False),
            unittest.mock.patch.object(automacao, "abrir_pelo_menu_oracle"),
            unittest.mock.patch.object(automacao, "aguardar_login") as login,
            unittest.mock.patch.object(automacao, "log"),
        ):
            with self.assertRaises(automacao.RotinaErro):
                automacao.abrir_gestao_solicitacoes(page, tentativas=3)

        page.reload.assert_not_called()
        self.assertEqual(page.goto.call_count, 2)
        page.goto.assert_called_with(automacao.ORACLE_URL, wait_until="domcontentloaded", timeout=automacao.CARREGAMENTO_MS)
        self.assertEqual(login.call_count, 2)


if __name__ == "__main__":
    unittest.main()
