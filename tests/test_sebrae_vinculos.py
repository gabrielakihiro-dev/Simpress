import unittest

from domains.sebrae_vinculos import os_do_chamado, vinculos_da_finalizacao, vinculos_derivados

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

    def test_macbook_com_ou_sem_s_liga_pela_equivalencia_so_com_resultado_unico(self):
        relatorio = {"chamados": [{"serie": "CXC9F072K1", "simpress": {"ordens_servico": ["77"]}}]}
        indice = {"unique": {"CXC9F072K1": "PRMAC001"}, "details_serials": {"SCXC9F072K1"}}
        self.assertEqual(vinculos_derivados([aberto(K="SCXC9F072K1")], relatorio), [])
        achado = vinculos_derivados([aberto(K="SCXC9F072K1")], relatorio, indice)
        self.assertEqual([(v["serie"], v["os"], v["chamado"]) for v in achado], [("CXC9F072K1", "77", "UTIC-2026-0094")])
        relatorio_s = {"chamados": [{"serie": "SCXC9F072K1", "simpress": {"ordens_servico": ["88"]}}]}
        achado = vinculos_derivados([aberto(K="CXC9F072K1")], relatorio_s, indice)
        self.assertEqual([(v["serie"], v["os"]) for v in achado], [("SCXC9F072K1", "88")])
        ambiguo = {**indice, "details_serials": {"SCXC9F072K1", "CXC9F072K1"}}
        self.assertEqual(vinculos_derivados([aberto(K="SCXC9F072K1")], relatorio, ambiguo), [])
        duas = {"chamados": [{"serie": "CXC9F072K1", "simpress": {"ordens_servico": ["1", "2"]}}]}
        self.assertEqual(vinculos_derivados([aberto(K="SCXC9F072K1")], duas, indice), [])  # two OS stay ambiguous
        self.assertEqual([v["os"] for v in vinculos_derivados([aberto(K="SCXC9F072K1", E="2")], duas, indice)], ["2"])

    def test_linha_sem_utic_completo_ou_sem_serie_e_ignorada(self):
        self.assertEqual(vinculos_derivados([aberto("linha:2"), aberto(K=""), aberto("27371 / UTIC-2026-0094")], RELATORIO), [])

    def test_mesma_chave_pedida_por_dois_utic_nao_gera_nenhum(self):
        self.assertEqual(vinculos_derivados([aberto("UTIC-2026-1"), aberto("UTIC-2026-2")], RELATORIO), [])

    def test_sem_relatorio(self):
        self.assertEqual(vinculos_derivados([aberto()], None), [])


def marca(chamado="UTIC-2025-77", serie="abc 123", os="7303022", ativa=True, em="2025-12-30T10:00:00"):
    return {"chamado": chamado, "serie": serie, "os": os, "ativa": ativa, "finalizado_em": em}


class DaFinalizacaoTest(unittest.TestCase):
    def test_marca_ativa_gera_um_vinculo_por_fonte_com_ano_do_chamado_e_grafia_do_relatorio(self):
        vinculos = vinculos_da_finalizacao([marca()], RELATORIO)
        self.assertEqual(vinculos[0], {
            "fonte": "simpress", "serie": "ABC-123", "os": "7303022", "ano": 2025, "numero": "77",
            "chamado": "UTIC-2025-77", "origem": "finalizacao", "finalizado_em": "2025-12-30T10:00:00",
        })
        self.assertEqual([v["fonte"] for v in vinculos], ["simpress", "oracle"])

    def test_marca_desfeita_chamado_invalido_e_os_fora_do_relatorio_nao_geram_nada(self):
        for ruim in (marca(ativa=False), marca("linha:2"), marca("UTIC-1999-1"), marca("UTIC-2025-" + "1" * 25), marca(os="999"), marca(serie="ZZZ"), marca(os="")):
            self.assertEqual(vinculos_da_finalizacao([ruim], RELATORIO), [], ruim)
        self.assertEqual(vinculos_da_finalizacao([marca()], None), [])

    def test_primeira_marca_ativa_da_chave_vence_e_desfeita_mais_nova_nao_a_derruba(self):
        marcas = [marca("UTIC-2026-9", ativa=False), marca("UTIC-2025-77"), marca("UTIC-2024-5")]  # mais recente primeiro
        self.assertEqual({v["chamado"] for v in vinculos_da_finalizacao(marcas, RELATORIO)}, {"UTIC-2025-77"})

    def test_serie_so_na_grafia_exata_sem_troca_macbook(self):
        # A F6 decide a sub-aba pela série exata; o vínculo automático segue a mesma regra.
        relatorio = {"chamados": [{"serie": "CXC9F072K1", "simpress": {"ordens_servico": ["77"]}}]}
        self.assertEqual(vinculos_da_finalizacao([marca(serie="SCXC9F072K1", os="77")], relatorio), [])


class OsDoChamadoTest(unittest.TestCase):
    def test_maior_os_do_chamado_ignorando_caixa(self):
        vinculos = [{"chamado": "UTIC-2026-0094", "os": "9"}, {"chamado": "utic-2026-0094", "os": "100"}, {"chamado": "UTIC-2026-1", "os": "500"}]
        self.assertEqual(os_do_chamado(vinculos, "UTIC-2026-0094"), "100")
        self.assertEqual(os_do_chamado(vinculos, "UTIC-2026-7"), "")
        self.assertEqual(os_do_chamado(vinculos, "linha:2"), "")


if __name__ == "__main__":
    unittest.main()
