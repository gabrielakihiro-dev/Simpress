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
    def test_legacy_review_item_id_survives_display_filtering(self):
        hidden_review = {
            "serie": "SERIE-LOCAL-1",
            "computador": "PRNOTE-LOCAL-1",
            "motivo": "Série não encontrada na InvAll; apelido atual preservado.",
        }
        visible_review = {
            "serie": "SERIE-DUP-1",
            "computador": "PRNOTE-DUP-1, PRNOTE-DUP-2",
            "motivo": "Série duplicada na InvAll; nenhum hostname foi escolhido.",
        }
        event = {
            "id": "evento-anotacao-filtro",
            "comparacao": {"apelidos_sem_atualizacao": [hidden_review, visible_review]},
        }

        displayed = main.comparison_history_for_display(event)
        displayed_reviews = displayed["comparacao"]["apelidos_sem_atualizacao"]

        self.assertEqual(len(displayed_reviews), 1)
        self.assertEqual(
            displayed_reviews[0]["anotacao_id"],
            main.comparison_review_item_id(event["id"], 1, visible_review),
        )
        self.assertNotIn("anotacao_id", visible_review)

    def test_review_rows_are_removed_only_when_the_same_series_is_shown_elsewhere(self):
        review_items = [
            {
                "serie": "BRJ-DUP-MATCH",
                "computador": "PRNOTE-DUP-MATCH",
                "motivo": "Série duplicada no Endpoint; nenhum hostname foi escolhido.",
            },
            {
                "serie": "BRJ-DUP-STANDALONE",
                "computador": "PRNOTE-DUP-STANDALONE",
                "motivo": "Série duplicada no Endpoint; nenhum hostname foi escolhido.",
            },
            {
                "serie": "BRJ-MISSING-MATCH",
                "computador": "PRNOTE-MISSING-MATCH",
                "motivo": "Série não encontrada no Endpoint; apelido atual preservado.",
            },
            {
                "serie": "BRJ-MISSING-STANDALONE",
                "computador": "PRNOTE-MISSING-STANDALONE",
                "motivo": "Série não encontrada no Endpoint; apelido atual preservado.",
            },
        ]
        event = {
            "id": "evento-series-sobrepostas",
            "comparacao": {
                "apelidos_sem_atualizacao": review_items,
                "ausentes_no_endpoint": [{
                    "serie": "BRJ-MISSING-MATCH",
                    "computador": "PRNOTE-MISSING-MATCH",
                }],
                "correspondencias_ambiguas": [{
                    "tipo": "Número de série duplicado",
                    "chave": "BRJ-DUP-MATCH",
                    "mensagem": "Série repetida no Endpoint.",
                }],
            },
        }

        displayed = main.comparison_history_for_display(event)["comparacao"]

        self.assertEqual(
            [item["serie"] for item in displayed["apelidos_sem_atualizacao"]],
            ["BRJ-DUP-STANDALONE", "BRJ-MISSING-STANDALONE"],
        )
        self.assertEqual(
            [item["serie"] for item in displayed["ausentes_no_endpoint"]],
            ["BRJ-MISSING-MATCH"],
        )
        self.assertEqual(
            [item["serie"] for item in displayed["registros_ambiguos"]],
            ["BRJ-DUP-MATCH"],
        )

    def test_pinned_comparison_review_rows_receive_annotation_ids(self):
        review = {
            "serie": "BRJ-PINNED-1",
            "computador": "PRNOTE-PINNED-1",
            "motivo": "Série não encontrada na InvAll; apelido atual preservado.",
        }
        event = {
            "id": main.PINNED_COMPARISON_EVENT_ID,
            "horario": main.PINNED_COMPARISON_EVENT_TIME,
            "comparacao": {"apelidos_sem_atualizacao": [review]},
        }

        displayed = main.comparison_history_for_display(event)
        displayed_review = displayed["comparacao"]["apelidos_sem_atualizacao"][0]

        self.assertEqual(
            displayed_review["anotacao_id"],
            main.comparison_review_item_id(event["id"], 0, review),
        )

    def test_all_history_detail_categories_receive_stable_event_scoped_annotation_ids(self):
        filtered_endpoint = {"serie": "SERIE-IGNORADA", "computador": "PRNOTE-IGNORADO"}
        endpoint_row = {"serie": "BRM-ENDPOINT-1", "computador": "PRNOTE-ENDPOINT"}
        filtered_details = {"serie": "S-IGNORADA", "computador": "PRNOTE-IGNORADO"}
        details_row = {"serie": "S-DETALHES-1", "computador": "PRMAC-DETALHES"}
        filtered_location = {"serie": "S-CURITIBA", "computador": "PRNOTESJP01"}
        location_row = {"serie": "S-LOCAL-1", "computador": "PRNOTEAPU01"}
        event = {
            "id": "evento-anotacoes-categorias",
            "comparacao": {
                "sem_acesso_14_dias": [{"serie": "S-ACESSO", "computador": "PRNOTE-ACESSO"}],
                "ausentes_no_endpoint": [filtered_endpoint, endpoint_row],
                "ausentes_em_detalhes": [filtered_details, details_row],
                "divergencias_local": [filtered_location, location_row],
                "correspondencias_ambiguas": [{"tipo": "Série duplicada", "chave": "S-DUP", "mensagem": "Revisar"}],
                "registros_ambiguos": [{"serie": "S-AMB", "computador": "PRNOTE-AMB", "motivo": "Sem correspondência única"}],
                "series_sem_mapeamento": [{"serie": "ZZ-SEM-LOCAL", "quantidade": 2, "exemplos": ["PRNOTE-X"]}],
            },
        }

        displayed = main.comparison_history_for_display(event)["comparacao"]
        visible_rows = [
            displayed["sem_acesso_14_dias"][0],
            displayed["ausentes_no_endpoint"][0],
            displayed["ausentes_em_detalhes"][0],
            displayed["divergencias_local"][0],
            displayed["correspondencias_ambiguas"][0],
            displayed["registros_ambiguos"][0],
            displayed["series_sem_mapeamento"][0],
        ]

        self.assertEqual(len({row["anotacao_id"] for row in visible_rows}), len(visible_rows))
        self.assertEqual(
            displayed["ausentes_no_endpoint"][0]["anotacao_id"],
            main.comparison_annotation_item_id(event["id"], "ausentes_no_endpoint", 1, endpoint_row),
        )
        self.assertEqual(
            displayed["ausentes_em_detalhes"][0]["anotacao_id"],
            main.comparison_annotation_item_id(event["id"], "ausentes_em_detalhes", 1, details_row),
        )
        self.assertEqual(
            displayed["divergencias_local"][0]["anotacao_id"],
            main.comparison_annotation_item_id(event["id"], "divergencias_local", 1, location_row),
        )
        self.assertNotIn("anotacao_id", endpoint_row)
        self.assertNotIn("anotacao_id", details_row)
        self.assertNotIn("anotacao_id", location_row)

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

    def test_duplicate_hostname_warnings_are_bounded_and_deterministic(self):
        endpoint = source_table([
            {
                "NOMEDOCOMPUTADOR": "PRNOTEAPU-HOST-DUPLICADO",
                "ROTULODESERVICONUMERODESERIE": f"END-{index:03d}",
            }
            for index in range(100)
        ])
        details = source_table([
            {
                "NUMEROSERIE": f"DET-{index:03d}",
                "APELIDO": "PRNOTEAPU-HOST-DUPLICADO",
                "CIDADE": "Apucarana",
            }
            for index in range(100)
        ])

        first_result = main.compare_uploaded_workbooks(endpoint, details, {})
        second_result = main.compare_uploaded_workbooks(endpoint, details, {})
        issues = first_result["correspondencias_ambiguas"]
        hostname_issues = [item for item in issues if item["tipo"] == "Hostname/Apelido duplicado"]
        divergent_issues = [
            item for item in issues
            if item["tipo"] == "Série divergente para o mesmo hostname/Apelido"
        ]

        self.assertEqual(issues, second_result["correspondencias_ambiguas"])
        self.assertEqual(len(issues), 2)
        self.assertEqual(len(hostname_issues), 1)
        self.assertEqual(
            hostname_issues[0]["fontes"],
            [
                {"fonte": "Endpoint", "quantidade": 100},
                {"fonte": "EquipamentosDetalhes", "quantidade": 100},
            ],
        )
        self.assertEqual(len(divergent_issues), 1)
        divergent_issue = divergent_issues[0]
        self.assertEqual(divergent_issue["fontes"], [
            {"fonte": "Endpoint", "quantidade": 100},
            {"fonte": "EquipamentosDetalhes", "quantidade": 100},
        ])
        self.assertIn("10000 combinações", divergent_issue["mensagem"])
        self.assertIn("END-000, END-001, END-002", divergent_issue["mensagem"])
        self.assertIn("DET-000, DET-001, DET-002", divergent_issue["mensagem"])
        self.assertLess(len(divergent_issue["mensagem"]), 400)

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
        self.assertEqual(
            [{key: value for key, value in item.items() if key != "anotacao_id"}
             for item in displayed_new["comparacao"]["ausentes_no_endpoint"]],
            [common_endpoint_item],
        )
        self.assertEqual(
            [{key: value for key, value in item.items() if key != "anotacao_id"}
             for item in displayed_new["comparacao"]["ausentes_em_detalhes"]],
            [common_detail_item],
        )
        self.assertEqual(displayed_new["resumo"]["ausentes_no_endpoint"], 1)
        self.assertEqual(displayed_new["resumo"]["ausentes_em_detalhes"], 1)
        self.assertNotIn("ausentes_na_base_principal", displayed_new["comparacao"])
        self.assertNotIn("divergencias_endereco", displayed_new["comparacao"])
        self.assertNotIn("local_base_principal", displayed_new["comparacao"]["divergencias_local"][0])
        self.assertEqual(displayed_new["comparacao"]["arquivos_enviados"], {"endpoint": "endpoint.xlsx", "detalhes": "detalhes.xlsx"})
        self.assertEqual(displayed_new["comparacao"]["correspondencias_ambiguas"][0]["fontes"], [{"fonte": "no endpoint"}])
        self.assertEqual(displayed_new["comparacao"]["registros_ambiguos"][0]["fontes"], {"no endpoint": "presente"})
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
        self.assertEqual(
            [{key: value for key, value in item.items() if key != "anotacao_id"}
             for item in displayed_old["comparacao"]["ausentes_no_endpoint"]],
            [common_endpoint_item],
        )
        self.assertEqual(
            [{key: value for key, value in item.items() if key != "anotacao_id"}
             for item in displayed_old["comparacao"]["ausentes_em_detalhes"]],
            [common_detail_item],
        )
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
