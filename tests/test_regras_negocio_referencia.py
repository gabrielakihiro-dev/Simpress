"""Regras de negócio de referência (AGENTS.md), com dados fictícios.

- MacBook: série do Endpoint sem ``S`` inicial só equivale à do cadastro com ``S`` se o resultado for único.
- Hostname de Curitiba (``PRNOTESJP``/``PRNOTERL``/``PRNOTEARC``) com hífen, espaço ou marcador ``(M)``.
"""

import unittest

from domains.coverage import cidade_do_cadastro
from domains.inventory_comparison import (
    compare_uploaded_workbooks,
    is_curitiba_hostname_exception,
    location_for_computer_name,
)
from domains.regras_negocio import (
    cadastro_e_macbook,
    e_serie_sebrae,
    hostname_de_curitiba,
    hostname_e_macbook,
)
from domains.sebrae_cruzamento import registros_de_equipamentos


def source_table(records, sheet="Inventario"):
    return {"sheet": sheet, "headers": set(), "records": records}


def _cidade_cobertura(apelido):
    return cidade_do_cadastro({"apelido": apelido, "retirada_cidade": "Cidade Fictícia"})


def _cidade_cruzamento(apelido):
    registros = registros_de_equipamentos([
        {"nome_pessoa": "Pessoa Teste", "apelido": apelido, "retirada_cidade": "Cidade Fictícia", "serial": "X"},
    ])
    return registros[0]["cidade"]


class MacbookSerialCollisionTests(unittest.TestCase):
    def test_endpoint_serial_matching_two_details_rows_stays_ambiguous(self):
        endpoint = source_table([{"NOMEDOCOMPUTADOR": "PRMACEND01", "ROTULODESERVICONUMERODESERIE": "XYZ0001"}])
        details = source_table([
            {"NUMEROSERIE": "SXYZ0001", "APELIDO": "PRMACAAA01", "CIDADE": "Cidade Fictícia"},
            {"NUMEROSERIE": "XYZ0001", "APELIDO": "PRMACBBB01", "CIDADE": "Cidade Fictícia"},
        ])

        result = compare_uploaded_workbooks(endpoint, details, {})

        self.assertEqual(result["equipamentos_sincronizados"], 0)
        self.assertEqual(len(result["registros_ambiguos"]), 1)
        item = result["registros_ambiguos"][0]
        self.assertIn("XYZ0001", item["serie"])
        self.assertIn("SXYZ0001", item["serie"])
        self.assertEqual(item["fontes"]["EquipamentosDetalhes"], "ambíguo")
        self.assertEqual(item["fontes"]["no endpoint"], "presente")
        self.assertEqual([entry["chave"] for entry in result["correspondencias_ambiguas"]], ["XYZ0001"])
        self.assertEqual(result["ausentes_no_endpoint"], [])
        self.assertEqual(result["ausentes_em_detalhes"], [])


class CuritibaHostnameVariantsTests(unittest.TestCase):
    # `PRNOTE-SJP01` e `PRNOTE SJP01` são Curitiba; o marcador `(M)` no fim não muda isso.

    def test_comparison_treats_hyphen_space_and_manual_marker_as_curitiba(self):
        for hostname in ("PRNOTE-SJP01", "PRNOTE SJP01", "PRNOTESJP01 (M)"):
            with self.subTest(hostname=hostname):
                self.assertTrue(is_curitiba_hostname_exception(hostname))
                self.assertEqual(location_for_computer_name(hostname), "Curitiba")

    def test_coverage_and_crossing_treat_manual_marker_as_curitiba(self):
        self.assertEqual(_cidade_cobertura("PRNOTESJP01 (M)"), "Curitiba")
        self.assertEqual(_cidade_cruzamento("PRNOTESJP01 (M)"), "Curitiba")

    def test_coverage_and_crossing_treat_hyphen_and_space_as_curitiba(self):
        for hostname in ("PRNOTE-SJP01", "PRNOTE SJP01"):
            with self.subTest(hostname=hostname):
                self.assertEqual(_cidade_cobertura(hostname), "Curitiba")
                self.assertEqual(_cidade_cruzamento(hostname), "Curitiba")


class RegrasNegocioTests(unittest.TestCase):
    def test_hostname_de_curitiba(self):
        for hostname in ("PRNOTESJP01", "PRNOTE-RL02", "PRNOTEARC3", "prnote sjp01", "PRNOTESJP01 (M)"):
            with self.subTest(hostname=hostname):
                self.assertTrue(hostname_de_curitiba(hostname))
        for hostname in ("PRNOTECWB01", "PRMACSJP01", "PRNOTE", "", None):
            with self.subTest(hostname=hostname):
                self.assertFalse(hostname_de_curitiba(hostname))

    def test_hostname_e_macbook_olha_o_hostname_do_endpoint(self):
        for hostname in ("PRMACEND01", "PRMAC-END01", "prmac end01"):
            with self.subTest(hostname=hostname):
                self.assertTrue(hostname_e_macbook(hostname))
        for hostname in ("PRNOTEEND01", "MACBOOK01", "", None):
            with self.subTest(hostname=hostname):
                self.assertFalse(hostname_e_macbook(hostname))

    def test_cadastro_e_macbook_olha_os_campos_do_cadastro(self):
        self.assertTrue(cadastro_e_macbook("Notebook", "MacBook Air 13"))
        self.assertTrue(cadastro_e_macbook(None, "macbook pro"))
        self.assertFalse(cadastro_e_macbook("Notebook", "Modelo Fictício 14"))
        self.assertFalse(cadastro_e_macbook("Mac", "Book"))
        self.assertFalse(cadastro_e_macbook())
        # O hostname não é campo de cadastro: `PRMAC` sozinho não torna o equipamento MacBook.
        self.assertFalse(cadastro_e_macbook("PRMACEND01"))

    def test_e_serie_sebrae_ignora_caixa_hifen_e_espaco(self):
        for serie in ("BRJ135P5XS", "brj135p5xs", "brj-135p5xs", " BRJ 9435VMR "):
            with self.subTest(serie=serie):
                self.assertTrue(e_serie_sebrae(serie))
        for serie in ("BRJ135P5XT", "", None):
            with self.subTest(serie=serie):
                self.assertFalse(e_serie_sebrae(serie))


if __name__ == "__main__":
    unittest.main()
