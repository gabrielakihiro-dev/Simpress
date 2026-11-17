import unittest

from domains.sebrae_vinculos import (
    candidatas_de_troca, cita_chamado, os_cita_chamado, os_do_chamado, textos_da_os, vinculos_da_finalizacao, vinculos_derivados,
)

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


def relatorio_serie(*ordens):
    """Uma série ``SER1`` com OS da Oracle; cada item é ``(os, assunto)``."""
    return {"chamados": [{"serie": "SER1", "simpress": {"ordens_servico": []}, "oracle": [
        {"ordem_servico": os_, "assunto": assunto, "descricao": "", "data_criacao": "2026-11-01T10:00:00"} for os_, assunto in ordens
    ]}]}


class DerivadosChaveForteTest(unittest.TestCase):
    def alvo(self, relatorio, E="", recusadas=None, numero="UTIC-2026-0094"):
        return sorted({(v["fonte"], v["os"]) for v in vinculos_derivados([aberto(numero, K="SER1", E=E)], relatorio, None, recusadas)})

    def test_e_na_serie_e_os_mais_nova_com_o_numero_do_chamado_no_texto_vira_o_alvo(self):
        relatorio = relatorio_serie(("100", ""), ("200", "UTIC-2026-0094"), ("300", ""))
        self.assertEqual(self.alvo(relatorio, E="100"), [("oracle", "200")])

    def test_os_mais_nova_sem_chave_forte_e_so_sugestao_e_nao_vira_vinculo(self):
        self.assertEqual(self.alvo(relatorio_serie(("100", ""), ("200", "Outro assunto")), E="100"), [("oracle", "100")])

    def test_chave_forte_so_de_os_mais_velha_que_e_nao_puxa_o_vinculo(self):
        self.assertEqual(self.alvo(relatorio_serie(("100", "UTIC-2026-0094"), ("200", "")), E="200"), [("oracle", "200")])

    def test_chave_forte_de_outro_chamado_nao_serve(self):
        self.assertEqual(self.alvo(relatorio_serie(("100", ""), ("200", "UTIC-2026-0940")), E="100"), [("oracle", "100")])

    def test_os_recusada_para_o_chamado_e_ignorada_mesmo_com_chave_forte(self):
        relatorio = relatorio_serie(("100", ""), ("200", "UTIC-2026-0094"), ("300", "UTIC-2026-0094"))
        self.assertEqual(self.alvo(relatorio, E="100", recusadas={"UTIC-2026-0094": ["300"]}), [("oracle", "200")])
        self.assertEqual(self.alvo(relatorio, E="100", recusadas={"UTIC-2026-0094": ["300", "200"]}), [("oracle", "100")])
        self.assertEqual(self.alvo(relatorio, E="100", recusadas={"UTIC-2026-0001": ["300"]}), [("oracle", "300")])

    def test_e_fora_da_serie_so_vincula_com_chave_forte(self):
        self.assertEqual(self.alvo(relatorio_serie(("100", "UTIC-2026-0094")), E="999"), [("oracle", "100")])
        self.assertEqual(self.alvo(relatorio_serie(("100", "Sem chave")), E="999"), [])

    def test_chave_forte_so_na_chamados_cliente_do_ux(self):
        relatorio = {"chamados": [{"serie": "SER1", "simpress": {"ordens_servico": ["10", "20"], "chamados_cliente": ["UTIC-2026-94"]}}]}
        self.assertEqual(self.alvo(relatorio, E="10"), [("simpress", "20")])

    def test_os_na_e_de_outro_chamado_aberto_nunca_e_alvo_de_troca(self):
        relatorio = relatorio_serie(("100", ""), ("200", "UTIC-2026-0001"))
        a, b = aberto("UTIC-2026-0001", K="SER1", E="100"), aberto("UTIC-2026-0002", K="SER1", E="200")
        achados = {(v["chamado"], v["os"]) for v in vinculos_derivados([a, b], relatorio)}
        self.assertEqual(achados, {("UTIC-2026-0001", "100"), ("UTIC-2026-0002", "200")})  # a 200 fica com o chamado 2
        sozinho = {(v["chamado"], v["os"]) for v in vinculos_derivados([a], relatorio)}
        self.assertEqual(sozinho, {("UTIC-2026-0001", "200")})  # sem o chamado 2 a chave forte troca

    def test_os_em_vinculo_manual_de_outro_chamado_aberto_nunca_e_alvo_de_troca(self):
        relatorio = relatorio_serie(("100", ""), ("200", "UTIC-2026-0001"))
        a, b = aberto("UTIC-2026-0001", K="SER1", E="100"), aberto("UTIC-2026-0002", K="OUTRA", E="")
        manual = [{"chamado": "UTIC-2026-0002", "os": "200", "fonte": "oracle", "serie": "SER1"}]
        achados = {(v["chamado"], v["os"]) for v in vinculos_derivados([a, b], relatorio, manuais=manual)}
        self.assertEqual(achados, {("UTIC-2026-0001", "100")})  # a 200 é do chamado 2 pelo vínculo manual

    def test_sem_chave_forte_vale_a_regra_antiga_da_cobertura_f10(self):
        def alvo(relatorio, E):
            return sorted({v["os"] for v in vinculos_derivados([aberto(K="SER1", E=E)], relatorio, chave_forte=False)})
        self.assertEqual(alvo(relatorio_serie(("100", "Sem chave")), "999"), ["100"])  # E fora da série e uma só OS: vincula
        self.assertEqual(alvo(relatorio_serie(("100", ""), ("200", "UTIC-2026-0094")), "100"), ["100"])  # nunca troca a E
        self.assertEqual(alvo(relatorio_serie(("100", ""), ("200", "")), "999"), [])  # duas OS e E fora: ambíguo


class ChaveForteTest(unittest.TestCase):
    def test_separadores_e_zeros_a_esquerda_livres_e_numero_com_mais_digitos_nao_casa(self):
        for texto in ("UTIC-2026-0094", "utic 2026 94", "Ref.: UTIC/2026/00094.", "xUTIC2026094"):
            self.assertTrue(cita_chamado(texto, 2026, "0094"), texto)
        for texto in ("UTIC-2026-0940", "UTIC-2025-0094", "UTIC-2026-9", "", None, "2026-0094"):
            self.assertFalse(cita_chamado(texto, 2026, "0094"), texto)

    def test_ano_ou_numero_nao_numerico_nunca_casa(self):
        self.assertFalse(cita_chamado("UTIC-2026-0094", "20x6", "94"))
        self.assertFalse(cita_chamado("UTIC-2026-0094", 2026, ""))
        self.assertFalse(cita_chamado("UTIC-2026-0094", None, "94"))

    def test_os_cita_chamado_olha_assunto_descricao_e_chamados_cliente_da_propria_os(self):
        chamados = [
            {"serie": "A", "oracle": [{"ordem_servico": "1", "assunto": "x", "descricao": "ver UTIC-2026-0094"}, {"ordem_servico": "2", "assunto": "UTIC-2026-0094", "descricao": ""}]},
            {"serie": "B", "simpress": {"ordens_servico": ["3"], "chamados_cliente": ["UTIC-2026-0094"]}},
        ]
        self.assertEqual([os_cita_chamado(chamados, os_, 2026, "0094") for os_ in ("1", "2", "3", "9")], [True, True, True, False])
        self.assertEqual(os_cita_chamado(chamados, " 2 ", 2026, "94"), True)


class TextosDaOsTest(unittest.TestCase):
    def test_oracle_da_texto_e_data_em_ddmmaaaa_e_simpress_sem_texto_vem_vazia(self):
        chamados = [
            {"serie": "A", "oracle": [{"ordem_servico": "10", "assunto": " Teclado ", "descricao": "Trocar", "data_criacao": "2026-11-05T09:30:00"}]},
            {"serie": " B ", "simpress": {"ordens_servico": ["20"]}},
        ]
        self.assertEqual(textos_da_os(chamados, "10"), {"assunto": "Teclado", "descricao": "Trocar", "data": "05/11/2026", "serie": "A", "fonte": "oracle"})
        self.assertEqual(textos_da_os(chamados, "20"), {"assunto": "", "descricao": "", "data": "", "serie": "B", "fonte": "simpress"})
        self.assertEqual(textos_da_os(chamados, "999"), {"assunto": "", "descricao": "", "data": "", "serie": "", "fonte": ""})

    def test_data_em_formatos_do_oracle_e_data_invalida_fica_vazia(self):
        def data(valor):
            return textos_da_os([{"serie": "A", "oracle": [{"ordem_servico": "1", "data_criacao": valor}]}], "1")["data"]

        self.assertEqual([data(v) for v in ("2026-11-05", "05/11/2026 14:30:15", "05/11/2026 14:30", "05/11/2026", "ontem", None)],
                         ["05/11/2026", "05/11/2026", "05/11/2026", "05/11/2026", "", ""])

    def test_oracle_vale_antes_da_simpress_quando_a_os_esta_nas_duas(self):
        chamados = [
            {"serie": "A", "simpress": {"ordens_servico": ["10"]}},
            {"serie": "A", "oracle": [{"ordem_servico": "10", "assunto": "Do Oracle", "descricao": "", "data_criacao": ""}]},
        ]
        self.assertEqual(textos_da_os(chamados, "10")["fonte"], "oracle")


class CandidatasDeTrocaTest(unittest.TestCase):
    ORDENS = {"100": {"oracle": ("100", "S")}, "200": {"oracle": ("200", "S")}, "300": {"simpress": ("300", "S")}}

    def test_com_e_na_serie_so_numero_maior_mais_nova_primeiro(self):
        self.assertEqual(candidatas_de_troca(self.ORDENS, "100"), ["300", "200"])
        self.assertEqual(candidatas_de_troca(self.ORDENS, "200"), ["300"])
        self.assertEqual(candidatas_de_troca(self.ORDENS, "300"), [])

    def test_com_e_fora_da_serie_ou_vazia_toda_os_nao_recusada_vale(self):
        self.assertEqual(candidatas_de_troca(self.ORDENS, "999"), ["300", "200", "100"])
        self.assertEqual(candidatas_de_troca(self.ORDENS, "", ["200"]), ["300", "100"])

    def test_recusada_sai_ignorando_caixa_e_espacos(self):
        ordens = {"AB1": {"oracle": ("ab1", "S")}, "AB2": {"oracle": ("ab2", "S")}}
        self.assertEqual(candidatas_de_troca(ordens, "ZZ", [" ab2 "]), ["AB1"])


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
