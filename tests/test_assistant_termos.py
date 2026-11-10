import unittest

from domains.assistant_chat import SYSTEM_PROMPT


class AssistenteTermosTests(unittest.TestCase):
    def test_regra_37_explica_termos_sem_ferramenta(self):
        regra = SYSTEM_PROMPT[SYSTEM_PROMPT.index("37. Termos de entrega e devolução"):]
        regra = regra.split("\n\n", 1)[0]
        for trecho in (
            "Ferramentas",
            "sem atalho",
            "Termo Entrega",
            "Termo Devolução",
            "Gerar PDF",
            "<série> - <nome completo>",
            "Não existe ferramenta",
        ):
            self.assertIn(trecho, regra)
        self.assertNotIn("\n38.", regra)


if __name__ == "__main__":
    unittest.main()
