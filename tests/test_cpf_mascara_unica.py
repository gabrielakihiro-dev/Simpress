"""Regra única de máscara de CPF: o Assistente e os textos de chamado Sebrae mascaram igual."""

import unittest

from domains import assistant_lgpd, sebrae_chamados
from domains.assistant_lgpd import CPF_MASCARA, limpar_texto_sensivel
from domains.sebrae_chamados import mascarar_cpfs

M = CPF_MASCARA

CASOS = [
    ("529.982.247-25", M),
    ("52998224725", M),
    ("CPF 12345678900", f"CPF {M}"),  # rótulo: mascara mesmo com dígitos inválidos
    ("CPF: 111.111.111-11", f"CPF: {M}"),
    ("cpf 52998224725", f"cpf {M}"),
    ("ABC52998224725", "ABC52998224725"),
    ("X-52998224725", "X-52998224725"),
    ("cpf_52998224725", "cpf_52998224725"),
    ("52998224725-1", "52998224725-1"),
    ("nº52998224725", "nº52998224725"),  # "º" é \w em Python unicode: borda rígida não mascara
    ("123 456 789 09", "123 456 789 09"),
    ("12.345.678/0001-95", "12.345.678/0001-95"),
    ("12345678000195", "12345678000195"),
    ("41999998888", "41999998888"),
    ("11111111111", "11111111111"),
    ("Usuário com CPF 52998224725 pediu troca", f"Usuário com CPF {M} pediu troca"),
    ("Pontuado 123.456.789-00 e solto 52998224725.", f"Pontuado {M} e solto {M}."),
    ("UTIC-2026-12345678901", "UTIC-2026-12345678901"),
]


class CpfMascaraUnicaTests(unittest.TestCase):
    def test_mesma_saida_nas_duas_entradas(self):
        for entrada, esperado in CASOS:
            with self.subTest(entrada=entrada):
                self.assertEqual(mascarar_cpfs(entrada), esperado)
                self.assertEqual(limpar_texto_sensivel(entrada), esperado)

    def test_implementacao_unica(self):
        self.assertIs(sebrae_chamados.mascarar_cpfs, assistant_lgpd.mascarar_cpfs)


if __name__ == "__main__":
    unittest.main()
