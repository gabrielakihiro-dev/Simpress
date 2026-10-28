import unittest

from domains import sebrae_cruzamento as cruz


class RegistrosTest(unittest.TestCase):
    def test_so_equipamentos_com_nome_e_regra_de_curitiba_pelo_apelido(self):
        itens = [
            {"serial": "A1", "modelo": "Dell", "nome_pessoa": "Ana", "retirada_cidade": "Colombo", "apelido": "PRNOTESJP123"},
            {"serial": "B2", "modelo": "HP", "nome_pessoa": "", "retirada_cidade": "Curitiba"},
            {"serial": "C3", "modelo": "Dell", "nome_pessoa": "Bia", "retirada_cidade": "Londrina", "apelido": "PRNOTE001"},
        ]
        self.assertEqual(
            cruz.registros_de_equipamentos(itens),
            [
                {"nome": "Ana", "serie": "A1", "modelo": "Dell", "cidade": "Curitiba"},
                {"nome": "Bia", "serie": "C3", "modelo": "Dell", "cidade": "Londrina"},
            ],
        )


class OsDaSerieTest(unittest.TestCase):
    RELATORIO = {"chamados": [
        {"serie": "ABC 123", "simpress": {"ordens_servico": ["7303022"]}, "oracle": [{"ordem_servico": "7300001"}]},
        {"serie": "OUTRA", "simpress": {"ordens_servico": ["9"]}},
    ]}

    def test_ultima_os_da_serie_ignora_caixa_e_separadores(self):
        self.assertEqual(cruz.os_da_serie(self.RELATORIO, "abc123"), "7303022")

    def test_serie_sem_vinculo_relatorio_ausente_ou_serie_vazia_devolvem_vazio(self):
        self.assertEqual(cruz.os_da_serie(self.RELATORIO, "ZZZ"), "")
        self.assertEqual(cruz.os_da_serie(None, "ABC123"), "")
        self.assertEqual(cruz.os_da_serie(self.RELATORIO, ""), "")


if __name__ == "__main__":
    unittest.main()
