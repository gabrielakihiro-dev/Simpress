import unittest
import io
from contextlib import redirect_stdout
from unittest.mock import patch

from fastapi import HTTPException

with patch("openpyxl.load_workbook", side_effect=RuntimeError("testes não acessam planilhas locais")):
    with redirect_stdout(io.StringIO()):
        import main


def source_table(records, sheet="Inventario"):
    return {"sheet": sheet, "headers": set(), "records": records}


class InventoryComparisonTests(unittest.TestCase):
    def test_two_sources_report_absence_and_location_without_comparing_ip(self):
        endpoint = source_table([
            {"NOMEDOCOMPUTADOR": "PRNOTEAPU01", "ROTULODESERVICONUMERODESERIE": "S-001", "IP": "10.0.0.1"},
            {"NOMEDOCOMPUTADOR": "PRNOTESJP02", "ROTULODESERVICONUMERODESERIE": "S-002", "IP": "10.0.0.2"},
            {"NOMEDOCOMPUTADOR": "PRNOTETI03", "ROTULODESERVICONUMERODESERIE": "S-003", "IP": "10.0.0.3"},
            {"NOMEDOCOMPUTADOR": "PRNOTELON04", "ROTULODESERVICONUMERODESERIE": "", "IP": "10.0.0.4"},
            {"NOMEDOCOMPUTADOR": "PRNOTECAS05", "ROTULODESERVICONUMERODESERIE": "S-005", "IP": "10.0.0.5"},
        ])
        details = source_table([
            {"NUMEROSERIE": "S-001", "APELIDO": "Nome alterado", "CIDADE": "Araucária", "IP": "10.0.0.99"},
            {"NUMEROSERIE": "S-002", "APELIDO": "PRNOTESJP02", "CIDADE": "São José dos Pinhais", "IP": "10.0.0.2"},
            {"NUMEROSERIE": "S-003", "APELIDO": "PRNOTETI03", "CIDADE": "Curitiba UTIC", "IP": "10.0.0.3"},
            {"NUMEROSERIE": "S-004", "APELIDO": "PRNOTELON04", "CIDADE": "Londrina", "IP": "10.0.0.4"},
            {"NUMEROSERIE": "S-006", "APELIDO": "PRNOTEFOZ06", "CIDADE": "Foz do Iguaçu", "IP": "10.0.0.6"},
        ])
        result = main.compare_uploaded_workbooks(endpoint, details, {
            "endpoint": "endpoint-teste.xlsx",
            "detalhes": "detalhes-teste.xlsx",
        })

        self.assertEqual({item["serie"] for item in result["ausentes_no_endpoint"]}, {"S-006"})
        self.assertEqual({item["serie"] for item in result["ausentes_em_detalhes"]}, {"S-005"})
        self.assertEqual(len(result["divergencias_local"]), 1)
        self.assertEqual(result["divergencias_local"][0]["serie"], "S-001")
        self.assertNotIn("divergencias_endereco", result)
        self.assertNotIn("ausentes_na_base_principal", result)
        self.assertNotIn("S-001", {item["serie"] for item in result["ausentes_em_detalhes"]})
        self.assertNotIn("S-002", {item["serie"] for item in result["divergencias_local"]})

    def test_unique_alias_can_match_when_serial_is_missing(self):
        endpoint = source_table([
            {"NOMEDOCOMPUTADOR": "PRNOTELON04", "ROTULODESERVICONUMERODESERIE": ""},
        ])
        details = source_table([
            {"NUMEROSERIE": "S-004", "APELIDO": "PRNOTELON04", "CIDADE": "Londrina"},
        ])
        result = main.compare_uploaded_workbooks(endpoint, details, {})

        self.assertEqual(result["ausentes_no_endpoint"], [])
        self.assertEqual(result["ausentes_em_detalhes"], [])

    def test_duplicate_serial_is_flagged_and_not_selected_as_a_single_row(self):
        endpoint = source_table([
            {"NOMEDOCOMPUTADOR": "PRNOTEFOZ08", "ROTULODESERVICONUMERODESERIE": "S-008"},
        ])
        details = source_table([
            {"NUMEROSERIE": "S-008", "APELIDO": "PRNOTEFOZ08", "CIDADE": "Foz do Iguaçu"},
            {"NUMEROSERIE": "S-008", "APELIDO": "PRNOTEFOZ08-ALT", "CIDADE": "Foz do Iguaçu"},
        ])
        result = main.compare_uploaded_workbooks(endpoint, details, {})

        self.assertTrue(any(issue["tipo"] == "Número de série duplicado" for issue in result["correspondencias_ambiguas"]))
        self.assertTrue(any(item["fontes"]["EquipamentosDetalhes"] == "ambíguo" for item in result["registros_ambiguos"]))
        self.assertEqual(result["ausentes_em_detalhes"], [])

    def test_duplicate_alias_is_ambiguous_when_it_is_the_only_match(self):
        endpoint = source_table([
            {"NOMEDOCOMPUTADOR": "PRNOTEMAR09", "ROTULODESERVICONUMERODESERIE": ""},
        ])
        details = source_table([
            {"NUMEROSERIE": "S-091", "APELIDO": "PRNOTEMAR09", "CIDADE": "Maringá"},
            {"NUMEROSERIE": "S-092", "APELIDO": "PRNOTEMAR09", "CIDADE": "Maringá"},
        ])
        result = main.compare_uploaded_workbooks(endpoint, details, {})

        self.assertTrue(any(issue["tipo"] == "Hostname/Apelido duplicado" for issue in result["correspondencias_ambiguas"]))
        self.assertEqual(result["ausentes_em_detalhes"], [])
        self.assertTrue(any(item["fontes"]["EquipamentosDetalhes"] == "ambíguo" for item in result["registros_ambiguos"]))

    def test_sebrae_owned_serials_are_filtered_from_old_and_new_history_without_rewriting_events(self):
        owned_serials = [
            "BRJ135P5XS",
            "BRJ142QKBQ",
            "BRJ9435VMR",
            "BRJ9435VMF",
            "BRJ149SCJG",
        ]
        result = main.compare_uploaded_workbooks(
            source_table([{"NOMEDOCOMPUTADOR": "PRNOTEAPU01", "ROTULODESERVICONUMERODESERIE": "BRJ135P5XS"}]),
            source_table([]),
            {},
        )
        self.assertEqual(result["ausentes_no_endpoint"], [])
        self.assertEqual(result["ausentes_em_detalhes"], [])

        owned_endpoint_items = [
            {"computador": f"PRNOTESEBRAE{index}", "serie": serial}
            for index, serial in enumerate(owned_serials, start=1)
        ]
        owned_detail_items = [
            {"computador": f"PRMAC-SEBRAE{index}", "serie": serial}
            for index, serial in enumerate(owned_serials, start=1)
        ]
        common_endpoint_item = {"computador": "PRNOTECOMUM01", "serie": "BRJ00000001"}
        common_detail_item = {"computador": "PRMAC-COMUM01", "serie": "BRJ00000002"}
        expected_endpoint_items = owned_endpoint_items + [common_endpoint_item]
        expected_detail_items = owned_detail_items + [common_detail_item]

        new_event = {
            "id": "evento-novo-ficticio",
            "horario": "2026-09-29T10:00:00-03:00",
            "arquivos_enviados": {"endpoint": "endpoint.xlsx", "detalhes": "detalhes.xlsx", "base_principal": "base.xlsx"},
            "resumo": {"ausentes_no_endpoint": 6, "ausentes_em_detalhes": 6, "ausentes_na_base_principal": 1, "divergencias_endereco": 1},
            "comparacao": {
                "ausentes_no_endpoint": expected_endpoint_items,
                "ausentes_em_detalhes": expected_detail_items,
                "ausentes_na_base_principal": [owned_endpoint_items[0]],
                "divergencias_endereco": [{"ip_endpoint": "10.0.0.1"}],
                "divergencias_local": [{"local_base_principal": "Apucarana", "local_detalhes": "Araucária"}],
                "arquivos_enviados": {"endpoint": "endpoint.xlsx", "detalhes": "detalhes.xlsx", "base_principal": "base.xlsx"},
                "correspondencias_ambiguas": [{"fontes": [{"fonte": "Endpoint"}, {"fonte": "Base principal"}]}],
                "registros_ambiguos": [{"fontes": {"Endpoint": "presente", "Base principal": "ambíguo"}}],
            },
        }
        displayed_new = main.comparison_history_for_display(new_event)
        self.assertEqual(displayed_new["comparacao"]["ausentes_no_endpoint"], [common_endpoint_item])
        self.assertEqual(displayed_new["comparacao"]["ausentes_em_detalhes"], [common_detail_item])
        self.assertEqual(displayed_new["resumo"]["ausentes_no_endpoint"], 1)
        self.assertEqual(displayed_new["resumo"]["ausentes_em_detalhes"], 1)
        self.assertNotIn("ausentes_na_base_principal", displayed_new["comparacao"])
        self.assertNotIn("divergencias_endereco", displayed_new["comparacao"])
        self.assertNotIn("local_base_principal", displayed_new["comparacao"]["divergencias_local"][0])
        self.assertEqual(displayed_new["comparacao"]["arquivos_enviados"], {"endpoint": "endpoint.xlsx", "detalhes": "detalhes.xlsx"})
        self.assertEqual(displayed_new["comparacao"]["correspondencias_ambiguas"][0]["fontes"], [{"fonte": "Endpoint"}])
        self.assertEqual(displayed_new["comparacao"]["registros_ambiguos"][0]["fontes"], {"Endpoint": "presente"})
        self.assertEqual(displayed_new["arquivos_enviados"], {"endpoint": "endpoint.xlsx", "detalhes": "detalhes.xlsx"})
        self.assertEqual(new_event["comparacao"]["ausentes_no_endpoint"], expected_endpoint_items)
        self.assertEqual(new_event["comparacao"]["ausentes_em_detalhes"], expected_detail_items)

        old_event = {
            "id": main.PINNED_COMPARISON_EVENT_ID,
            "horario": main.PINNED_COMPARISON_EVENT_TIME,
            "resumo": {"ausentes_no_endpoint": 6, "ausentes_em_detalhes": 6},
            "comparacao": {
                "ausentes_no_endpoint": expected_endpoint_items,
                "ausentes_em_detalhes": expected_detail_items,
            },
        }
        displayed_old = main.comparison_history_for_display(old_event)
        self.assertEqual(displayed_old["comparacao"]["ausentes_no_endpoint"], [common_endpoint_item])
        self.assertEqual(displayed_old["comparacao"]["ausentes_em_detalhes"], [common_detail_item])
        self.assertEqual(displayed_old["resumo"]["ausentes_no_endpoint"], 1)
        self.assertEqual(displayed_old["resumo"]["ausentes_em_detalhes"], 1)
        self.assertEqual(old_event["comparacao"]["ausentes_no_endpoint"], expected_endpoint_items)
        self.assertEqual(old_event["comparacao"]["ausentes_em_detalhes"], expected_detail_items)

    def test_existing_hostname_classification_and_specific_prefix_order_are_preserved(self):
        self.assertEqual(main.location_for_computer_name("PRNOTEBACKUP123"), "Curitiba")
        self.assertEqual(main.location_for_computer_name("PRNOTEBACKUPSJP123"), "São José dos Pinhais")
        self.assertEqual(main.location_for_computer_name("PRNOTEBKPSJP123"), "São José dos Pinhais")
        self.assertEqual(main.location_for_computer_name("PRNOTETI123"), "Curitiba UTIC")
        self.assertEqual(main.location_for_computer_name("PRNOTESJP123"), "Curitiba")

        original_map = dict(main.SERIE_LOCAL_MAP)
        try:
            main.SERIE_LOCAL_MAP["AB"] = "Local curto"
            main.SERIE_LOCAL_MAP["ABCD"] = "Local específico"
            self.assertEqual(main.location_for_computer_name("PRNOTEABCD123"), "Local específico")
        finally:
            main.SERIE_LOCAL_MAP.clear()
            main.SERIE_LOCAL_MAP.update(original_map)

    def test_multiple_matching_sheets_return_a_clear_error(self):
        tables = [
            {"sheet": "Endpoint 1", "headers": {"NOMEDOCOMPUTADOR", "SERIAL"}, "records": [{"SERIAL": "S1"}]},
            {"sheet": "Endpoint 2", "headers": {"HOSTNAME", "SERVICETAG"}, "records": [{"SERVICETAG": "S2"}]},
        ]

        with self.assertRaises(HTTPException) as raised:
            main.select_upload_table(tables, "endpoint")

        self.assertIn("Endpoint 1", raised.exception.detail)
        self.assertIn("Endpoint 2", raised.exception.detail)
        self.assertIn("seleção automática foi cancelada", raised.exception.detail)


if __name__ == "__main__":
    unittest.main()
