import unittest
import unittest.mock

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
        # Cursor instável nas 3 janelas (tentativas) seguidas: só aí levanta, sem EtapaInstavel (nunca repete o clique).
        with unittest.mock.patch.object(automacao, "obter_posicao_cursor", side_effect=[(0, 0), (50, 50)] * 3), \
                unittest.mock.patch.object(automacao.time, "sleep"), \
                unittest.mock.patch.object(automacao, "verificar_cancelamento"):
            with self.assertRaises(automacao.RotinaErro) as contexto:
                automacao.aguardar_estabilidade_pre_clique(lambda: True, "Clique de teste")
        self.assertNotIsInstance(contexto.exception, automacao.EtapaInstavel)

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


if __name__ == "__main__":
    unittest.main()
