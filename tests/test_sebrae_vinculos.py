import unittest

from domains.sebrae_vinculos import os_do_chamado, vinculos_derivados

RELATORIO = {"chamados": [
    {"serie": "ABC-123", "simpress": {"ordens_servico": ["7303022"]}, "oracle": [{"ordem_servico": "7303022"}]},
    {"serie": "DUO1", "simpress": {"ordens_servico": ["10", "20"]}, "oracle": []},
]}


def aberto(numero="UTIC-2026-0094", K="abc123", E=""):
    return {"numero": numero, "automaticos": {"K": K, "E": E}}


class DerivadosTest(unittest.TestCase):
    def test_serie_com_os_unica_gera_um_vinculo_por_fonte(self):
        vinculos = vinculos_derivados([aberto()], RELATORIO)
        self.assertEqual({v["fonte"] for v in vinculos}, {"simpress", "oracle"})
        self.assertEqual(vinculos[0], {
            "fonte": "simpress", "serie": "ABC-123", "os": "7303022", "ano": 2026, "numero": "0094",
            "chamado": "UTIC-2026-0094", "origem": "dashboard",
        })

    def test_duas_os_sem_e_e_ambiguo_e_com_e_escolhe_a_dela(self):
        self.assertEqual(vinculos_derivados([aberto(K="DUO1")], RELATORIO), [])
        escolhido = vinculos_derivados([aberto(K="DUO1", E="10")], RELATORIO)
        self.assertEqual([(v["fonte"], v["os"]) for v in escolhido], [("simpress", "10")])

    def test_linha_sem_utic_completo_ou_sem_serie_e_ignorada(self):
        self.assertEqual(vinculos_derivados([aberto("linha:2"), aberto(K=""), aberto("27371 / UTIC-2026-0094")], RELATORIO), [])

    def test_mesma_chave_pedida_por_dois_utic_nao_gera_nenhum(self):
        self.assertEqual(vinculos_derivados([aberto("UTIC-2026-1"), aberto("UTIC-2026-2")], RELATORIO), [])

    def test_sem_relatorio(self):
        self.assertEqual(vinculos_derivados([aberto()], None), [])


class OsDoChamadoTest(unittest.TestCase):
    def test_maior_os_do_chamado_ignorando_caixa(self):
        vinculos = [{"chamado": "UTIC-2026-0094", "os": "9"}, {"chamado": "utic-2026-0094", "os": "100"}, {"chamado": "UTIC-2026-1", "os": "500"}]
        self.assertEqual(os_do_chamado(vinculos, "UTIC-2026-0094"), "100")
        self.assertEqual(os_do_chamado(vinculos, "UTIC-2026-7"), "")
        self.assertEqual(os_do_chamado(vinculos, "linha:2"), "")


if __name__ == "__main__":
    unittest.main()
