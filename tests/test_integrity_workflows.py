import asyncio
import copy
import io
import json
import tempfile
import threading
import time
import unittest
import warnings
import zipfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import openpyxl
from openpyxl.styles import Font, PatternFill
from starlette.datastructures import UploadFile

with patch("openpyxl.load_workbook", side_effect=RuntimeError("testes não acessam planilhas locais")):
    import main


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def make_details(path: Path, rows):
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = "EquipamentosDetalhes"
    worksheet.append(["NumeroSerie", "Apelido", "Modelo", "Cidade", "Tipo", "CEP"])
    for row in rows:
        worksheet.append(list(row))
    worksheet.freeze_panes = "A2"
    worksheet.column_dimensions["B"].width = 31
    worksheet["A1"].font = Font(bold=True, color="FFFFFF")
    worksheet["A1"].fill = PatternFill("solid", fgColor="17365D")
    metadata = workbook.create_sheet("Metadados")
    metadata["A1"] = "Fórmula e estilo devem permanecer"
    metadata["B1"] = "=1+1"
    metadata["B1"].number_format = "0.00"
    metadata.row_dimensions[1].height = 29
    workbook.save(path)
    workbook.close()


def make_endpoint(path: Path, rows):
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = "InvAllComputersSummary"
    worksheet.append(["ROTULODESERVICONUMERODESERIE", "NOMEDOCOMPUTADOR"])
    for row in rows:
        worksheet.append(list(row))
    workbook.save(path)
    workbook.close()


def make_model(path: Path):
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = "Parque"
    worksheet.append(["NumeroSerie", "Apelido", "Observacao", "Formula"])
    values = [
        ("S-1", "ANTIGO", "manter-a", "=1+1"),
        ("DUP", "DUP-ANTIGO", "manter-b", "=2+2"),
        ("SAME", "HOST-SAME", "manter-c", "=3+3"),
        ("FORMULA", "=CONCAT(\"HOST\",\"-F\")", "manter-d", "=4+4"),
        ("OUTDUP", "DUP-OUT-A", "manter-e", "=5+5"),
        ("OUTDUP", "DUP-OUT-B", "manter-f", "=6+6"),
    ]
    for row in values:
        worksheet.append(list(row))
    worksheet.freeze_panes = "A2"
    worksheet.auto_filter.ref = "A1:D7"
    worksheet.column_dimensions["B"].width = 37
    worksheet.row_dimensions[2].height = 27
    worksheet["A1"].font = Font(bold=True, color="FFFFFF")
    worksheet["A1"].fill = PatternFill("solid", fgColor="17365D")
    other = workbook.create_sheet("Outra aba")
    other["A1"] = "Não alterar"
    other["B1"] = "=SUM(1,2)"
    other["B1"].font = Font(italic=True)
    other.column_dimensions["A"].width = 24
    workbook.save(path)
    workbook.close()


def make_transfer_template(path: Path):
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = "Transferência"
    for address in (
        "B5", "J5", "B8", "F8", "B17", "F17", "B19", "F19", "J19",
        "B21", "J21", "B23", "F23", "J23", "B25", "J25", "B29", "F29",
        "B31", "F31", "J31", "B33", "J33", "B35", "F35", "J35", "B37", "J37",
    ):
        worksheet[address] = "MARCADOR FICTICIO"
        worksheet[address].fill = PatternFill("solid", fgColor="EAF2F8")
    worksheet.merge_cells("B8:E8")
    worksheet.freeze_panes = "B5"
    workbook.create_sheet("Instruções")
    workbook.save(path)
    workbook.close()
    return _add_threaded_comment_parts(path)


def make_transfer_payload(**overrides):
    values = {
        "serial": "SERIE-FICTICIA",
        "descricao_equipamento": "EQUIPAMENTO FICTICIO",
        "contrato": 12345,
        "retirada_endereco": "ORIGEM FICTICIA",
        "retirada_contato": "REMETENTE FICTICIO",
        "retirada_email": "remetente@example.invalid",
        "retirada_telefone": "41900000000",
        "retirada_obs": "OBSERVACAO FICTICIA",
        "entrega_cnpj": "00.000.000/0000-00",
        "entrega_endereco": "DESTINO FICTICIO",
        "entrega_contato": "DESTINATARIO FICTICIO",
        "entrega_email": "destinatario@example.invalid",
        "entrega_telefone": "41911112222",
        "entrega_obs": "OBSERVACAO FICTICIA",
        "entrega_almoco": "12:00:00",
        "entrega_pausa_duracao": "1h",
    }
    values.update(overrides)
    return main.TransferenciaPayload(**values)


def _add_threaded_comment_parts(source: Path) -> Path:
    """Add synthetic threaded-comment package parts without touching source fixtures."""
    destination = source.with_name(f"{source.stem}-comentarios-ficticios.xlsx")
    comments_path = "xl/threadedComments/threadedComment1.xml"
    persons_path = "xl/persons/person.xml"
    sheet_path = "xl/worksheets/sheet1.xml"
    sheet_relationships_path = "xl/worksheets/_rels/sheet1.xml.rels"
    comment_id = "{00000000-0000-0000-0000-000000000001}"
    with zipfile.ZipFile(source, "r") as original, zipfile.ZipFile(destination, "w") as output:
        output.comment = original.comment
        for item in original.infolist():
            content = original.read(item.filename)
            if item.filename == "[Content_Types].xml":
                content = content.replace(
                    b"</Types>",
                    b'<Default Extension="threadedcomments" ContentType="application/vnd.ms-excel.threadedcomments+xml"/>'
                    b'<Override PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"/>'
                    b"</Types>",
                )
            elif item.filename == sheet_path:
                content = content.replace(
                    b"</worksheet>",
                    b'<extLst><ext uri="{00000000-0000-0000-0000-000000000002}">'
                    b'<threadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" '
                    b'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
                    b'r:id="rIdThreadedComments"/></ext></extLst></worksheet>',
                )
            elif item.filename == sheet_relationships_path:
                content = content.replace(
                    b"</Relationships>",
                    b'<Relationship Id="rIdThreadedComments" '
                    b'Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" '
                    b'Target="../threadedComments/threadedComment1.xml"/></Relationships>',
                )
            output.writestr(item, content)

        if sheet_relationships_path not in original.namelist():
            output.writestr(
                sheet_relationships_path,
                b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                b'<Relationship Id="rIdThreadedComments" '
                b'Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" '
                b'Target="../threadedComments/threadedComment1.xml"/></Relationships>',
            )
        output.writestr(
            comments_path,
            b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            b'<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">'
            b'<threadedComment ref="A1" dT="2026-01-01T00:00:00Z" personId="'
            + comment_id.encode("ascii")
            + b'"><text><r><t>Comentario ficticio</t></r></text></threadedComment></ThreadedComments>',
        )
        output.writestr(
            persons_path,
            b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            b'<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">'
            b'<person displayName="Pessoa Ficticia" id="'
            + comment_id.encode("ascii")
            + b'" userId="pessoa@example.invalid" providerId="None"/></personList>',
        )
    return destination


class WorkflowIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".workflow-test-", dir=PROJECT_ROOT)
        self.root = Path(self.temp_context.name)
        self.input_dir = self.root / "planilhas_entrada"
        self.input_dir.mkdir()
        self.details = self.input_dir / "EquipamentosDetalhes_atual.xlsx"
        self.endpoint = self.input_dir / "InvAllComputersSummary_atual.xlsx"
        self.baseline = self.input_dir / ".EquipamentosDetalhes_atual.export-baseline.xlsx"
        self.model = self.input_dir / "modelo-ficticio.xlsx"
        self.backups = self.input_dir / "_backups"
        self.overrides = self.root / "apelidos_modificados.json"
        self.manual_history = self.root / "historico_alteracoes.json"
        self.comparison_history = self.root / "historico_comparacoes.json"
        self.custom_units = self.root / "unidades_custom.json"
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(main, "BASE_DIR", self.root))
        self.stack.enter_context(patch.object(main, "INPUT_DIR", self.input_dir))
        self.stack.enter_context(patch.object(main, "DETAILS_UPLOAD_FILE", self.details))
        self.stack.enter_context(patch.object(main, "ENDPOINT_UPLOAD_FILE", self.endpoint))
        self.stack.enter_context(patch.object(main, "DETAILS_EXPORT_BASELINE_FILE", self.baseline))
        self.stack.enter_context(patch.object(main, "EXPORT_MODEL_FILE", self.model))
        self.stack.enter_context(patch.object(main, "UPLOAD_BACKUPS_DIR", self.backups))
        self.stack.enter_context(patch.object(main, "MODIFIED_APELIDOS_FILE", self.overrides))
        self.stack.enter_context(patch.object(main, "ALIAS_HISTORY_FILE", self.manual_history))
        self.stack.enter_context(patch.object(main, "COMPARISON_HISTORY_FILE", self.comparison_history))
        self.stack.enter_context(patch.object(main, "CUSTOM_UNIDADES_FILE", self.custom_units))
        self.stack.enter_context(patch.object(main, "TRANSACTION_ROOT", self.root))
        self.old_state = (
            copy.deepcopy(main.equipamentos_cache),
            copy.deepcopy(main.unidades_cache),
            copy.deepcopy(main.stats_cache),
        )
        main.equipamentos_cache = {}
        main.unidades_cache = []
        main.stats_cache = {}
        self.overrides.write_text("{}", encoding="utf-8")
        self.custom_units.write_text("[]", encoding="utf-8")

    def tearDown(self):
        main.equipamentos_cache, main.unidades_cache, main.stats_cache = self.old_state
        self.stack.close()
        self.temp_context.cleanup()

    def test_invall_is_joined_by_normalized_serial_for_site_and_search_without_rewriting_details(self):
        make_details(self.details, [
            ("S-1", "ALIAS-LOCAL", "Modelo A", "Maringá", "Notebook", "87000000"),
            ("DUP", "ALIAS-DUP", "Modelo B", "Londrina", "Notebook", "86000000"),
            ("NO-SOURCE", "ALIAS-KEEP", "Modelo C", "Ponta Grossa", "Notebook", "84000000"),
            ("DETAIL-DUP", "ALIAS-DETAIL-DUP-A", "Modelo D", "Pato Branco", "Notebook", "85500000"),
            ("detail dup", "ALIAS-DETAIL-DUP-B", "Modelo E", "Pato Branco", "Notebook", "85500000"),
        ])
        make_endpoint(self.endpoint, [
            (" s 1 ", "HOST-UNICO"),
            ("DUP", "HOST-DUP-A"),
            ("dup", "HOST-DUP-B"),
            ("DETAIL DUP", "HOST-DETAIL-DUP"),
            ("", "HOST-SEM-SERIE"),
        ])
        before = self.details.read_bytes()

        self.assertTrue(main.load_database())
        self.assertEqual(main.equipamentos_cache["S-1"]["apelido"], "HOST-UNICO")
        self.assertEqual(main.equipamentos_cache["S-1"]["invall_alias_status"], "aplicado")
        self.assertEqual(main.equipamentos_cache["DUP"]["apelido"], "ALIAS-DUP")
        self.assertEqual(main.equipamentos_cache["DUP"]["invall_alias_status"], "serie_invall_duplicada")
        self.assertEqual(main.equipamentos_cache["NO-SOURCE"]["apelido"], "ALIAS-KEEP")
        self.assertEqual(main.equipamentos_cache["NO-SOURCE"]["invall_alias_status"], "serie_nao_encontrada")
        self.assertEqual(main.equipamentos_cache["DETAIL-DUP"]["invall_alias_status"], "serie_detalhes_duplicada")
        self.assertEqual(main.equipamentos_cache["DETAIL DUP"]["invall_alias_status"], "serie_detalhes_duplicada")
        self.assertEqual(main.equipamentos_cache["DETAIL-DUP"]["apelido"], "ALIAS-DETAIL-DUP-A")
        self.assertEqual(main.get_equipamento("s-1")["apelido"], "HOST-UNICO")
        quick_results = main.buscar_seriais("HOST-UNICO")
        self.assertEqual(quick_results[0]["apelido"], "HOST-UNICO")
        review = main.endpoint_alias_review_items(
            main.read_endpoint_alias_index(), {"S1", "DUP", "NOSOURCE", "DETAILDUP"}, {"DETAILDUP"}
        )
        self.assertTrue(any(item["motivo"].startswith("Série duplicada") for item in review))
        self.assertTrue(any(item["serie"] == "" for item in review))
        self.assertTrue(any(item["serie"] == "NOSOURCE" and "não encontrada na InvAll" in item["motivo"] for item in review))
        self.assertEqual(self.details.read_bytes(), before)

    def test_export_changes_only_unique_changed_apelido_cells_and_keeps_other_content(self):
        make_details(self.details, [
            ("S-1", "LOCAL-ATUAL", "Modelo atual", "Maringá", "Notebook", "87000000"),
            ("S-2", "LOCAL-DOIS", "Modelo dois", "Curitiba", "Notebook", "80000000"),
        ])
        workbook = openpyxl.Workbook()
        worksheet = workbook.active
        worksheet.title = "Parque"
        worksheet.append(["NumeroSerie", "Apelido", "Modelo", "Cidade", "Tipo", "CEP"])
        worksheet.append(["S-1", "ANTIGO", "Modelo antigo", "Londrina", "Notebook", "87000000"])
        worksheet.append(["S-2", "LOCAL-DOIS", "Modelo dois", "Curitiba", "Notebook", "80000000"])
        worksheet["B2"].fill = PatternFill("solid", fgColor="17365D")
        worksheet.freeze_panes = "A2"
        workbook.save(self.model)
        workbook.close()
        make_endpoint(self.endpoint, [("s-1", "HOST-NEW")])
        source_before = self.model.read_bytes()
        original_workbook = openpyxl.load_workbook(self.model, data_only=False)
        original_snapshot = main.workbook_snapshot(original_workbook)
        original_workbook.close()
        self.comparison_history.write_text(
            json.dumps([
                {
                    "id": "older-update",
                    "horario": "2026-10-01T14:00:00-03:00",
                    "comparacao": {"apelidos_atualizados": [{}, {}]},
                },
                {
                    "id": "restoration-with-type",
                    "tipo": "restauracao",
                    "horario": "2026-10-01T18:00:00-03:00",
                    "comparacao": {"tipo_operacao": "restauracao"},
                },
                {
                    "id": "restoration-legacy",
                    "horario": "2026-10-01T17:30:00-03:00",
                    "comparacao": {"tipo_operacao": "restauracao"},
                },
                {
                    "id": "latest-update",
                    "horario": "2026-10-01T16:30:00-03:00",
                    "comparacao": {"apelidos_atualizados": [{}, {}, {}]},
                },
            ]),
            encoding="utf-8",
        )

        response = main.exportar_equipamentos()
        output_bytes = asyncio.run(_collect_stream(response))
        output_path = self.root / "export-ficticio.xlsx"
        output_path.write_bytes(output_bytes)
        self.assertEqual(response.headers["x-total-alterados"], "1")
        self.assertEqual(response.headers["x-historico-apelidos-atualizados"], "3")
        self.assertEqual(response.headers["x-historico-horario"], "2026-10-01T16:30:00-03:00")
        self.assertIn(
            "x-historico-apelidos-atualizados",
            response.headers["access-control-expose-headers"].lower(),
        )
        self.assertEqual(self.model.read_bytes(), source_before)
        with zipfile.ZipFile(self.model) as original_package, zipfile.ZipFile(output_path) as exported_package:
            self.assertEqual(original_package.namelist(), exported_package.namelist())
            changed_parts = {
                name for name in original_package.namelist()
                if original_package.read(name) != exported_package.read(name)
            }
        self.assertEqual(changed_parts, {"xl/worksheets/sheet1.xml"})

        updated_workbook = openpyxl.load_workbook(output_path, data_only=False)
        updated_snapshot = main.workbook_snapshot(updated_workbook)
        expected_snapshot = copy.deepcopy(original_snapshot)
        old_alias_cell = expected_snapshot["worksheets"]["Parque"]["cells"]["B2"]
        expected_snapshot["worksheets"]["Parque"]["cells"]["B2"] = ("HOST-NEW", *old_alias_cell[1:])
        self.assertEqual(updated_snapshot, expected_snapshot)
        worksheet = updated_workbook["Parque"]
        self.assertEqual(worksheet["B2"].value, "HOST-NEW")
        self.assertEqual(worksheet["B2"].fill.fgColor.rgb, "0017365D")
        self.assertEqual(worksheet["C2"].value, "Modelo antigo")
        self.assertEqual(worksheet["D2"].value, "Londrina")
        self.assertEqual(worksheet["B3"].value, "LOCAL-DOIS")
        updated_workbook.close()

        make_details(self.details, [
            ("S-1", "LOCAL-ATUAL", "Modelo atual", "Maringá", "Notebook", "87000000"),
            ("S-3", "NOVO", "Modelo novo", "Curitiba", "Notebook", "80000000"),
        ])
        with self.assertRaises(main.HTTPException) as raised:
            main.exportar_equipamentos()
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.model.read_bytes(), source_before)

    def test_official_transfer_preserves_threaded_comments_and_changes_only_form_cells(self):
        template = make_transfer_template(self.input_dir / "modelo-transferencia-ficticio.xlsx")
        with self.assertRaises(main.WorkbookSafetyError):
            main.load_workbook_safely(template)
        payload = main.TransferenciaPayload(
            serial="SERIE-FICTICIA",
            descricao_equipamento="EQUIPAMENTO FICTICIO",
            contrato=12345,
            retirada_endereco="ORIGEM FICTICIA",
            retirada_contato="REMETENTE FICTICIO",
            retirada_email="remetente@example.invalid",
            retirada_telefone="41900000000",
            retirada_obs="OBSERVACAO FICTICIA",
            entrega_cnpj="00.000.000/0000-00",
            entrega_endereco="DESTINO FICTICIO",
            entrega_contato="DESTINATARIO FICTICIO",
            entrega_email="destinatario@example.invalid",
            entrega_telefone="41911112222",
            entrega_obs="OBSERVACAO FICTICIA",
            entrega_almoco="12:00:00",
            entrega_pausa_duracao="1h",
        )

        with patch.object(main, "TEMPLATE_FILE", template):
            response = main.gerar_planilha(payload)

        output_bytes = asyncio.run(_collect_stream(response))
        output_path = self.root / "transferencia-ficticia.xlsx"
        output_path.write_bytes(output_bytes)
        with zipfile.ZipFile(template) as original_package, zipfile.ZipFile(output_path) as generated_package:
            self.assertEqual(original_package.namelist(), generated_package.namelist())
            changed_parts = {
                name for name in original_package.namelist()
                if original_package.read(name) != generated_package.read(name)
            }
            for part in ("xl/threadedComments/threadedComment1.xml", "xl/persons/person.xml"):
                self.assertEqual(original_package.read(part), generated_package.read(part))
        self.assertEqual(changed_parts, {"xl/worksheets/sheet1.xml"})

        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="Unknown extension is not supported and will be removed")
            generated_workbook = openpyxl.load_workbook(output_path, data_only=False)
        self.assertEqual(generated_workbook["Transferência"]["B8"].value, "SERIE-FICTICIA")
        self.assertEqual(generated_workbook["Transferência"]["B37"].value, "OBSERVACAO FICTICIA")
        self.assertEqual(generated_workbook["Transferência"]["J21"].value, "")
        self.assertEqual(generated_workbook["Transferência"]["J31"].value, "1h")
        generated_workbook.close()

    def test_delivery_pause_duration_is_required_except_when_office_stays_open(self):
        template = make_transfer_template(self.input_dir / "modelo-pausa-ficticio.xlsx")
        missing_pause = make_transfer_payload(entrega_pausa_duracao="")
        with patch.object(main, "TEMPLATE_FILE", template):
            with self.assertRaises(main.HTTPException) as raised:
                main.gerar_planilha(missing_pause)
        self.assertEqual(raised.exception.status_code, 422)
        self.assertIn("Duração da pausa da unidade de entrega", raised.exception.detail)

        office_stays_open = make_transfer_payload(
            entrega_almoco="Escritório não fecha",
            entrega_pausa_duracao="",
        )
        with patch.object(main, "TEMPLATE_FILE", template):
            response = main.gerar_planilha(office_stays_open)

        output_path = self.root / "pausa-opcional-ficticia.xlsx"
        output_path.write_bytes(asyncio.run(_collect_stream(response)))
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="Unknown extension is not supported and will be removed")
            generated_workbook = openpyxl.load_workbook(output_path, data_only=False)
        self.assertEqual(generated_workbook["Transferência"]["F31"].value, "Escritório não fecha")
        self.assertEqual(generated_workbook["Transferência"]["J31"].value, "")
        generated_workbook.close()

    def test_saving_a_new_equipment_row_grows_dimensions_and_ignores_legacy_location_fields(self):
        path = self.input_dir / "equipamentos-novos-ficticio.xlsx"
        workbook = openpyxl.Workbook()
        worksheet = workbook.active
        worksheet.title = "EquipamentosDetalhes"
        worksheet.append(["NumeroSerie", "Apelido", "Modelo", "Cidade", "Tipo", "CEP"])
        workbook.save(path)
        workbook.close()
        payload = main.EquipamentoUpdatePayload(
            serial="SERIE-NOVA-FICTICIA",
            apelido="APELIDO FICTICIO",
            modelo="MODELO FICTICIO",
            cidade="CURITIBA",
            tipo="Notebook",
            cep="80220000",
        )

        self.assertTrue(main.update_equipment_in_workbook_file(path, payload))

        updated_workbook = openpyxl.load_workbook(path, data_only=False)
        updated_sheet = updated_workbook["EquipamentosDetalhes"]
        self.assertEqual(updated_sheet.max_row, 2)
        self.assertEqual(updated_sheet.calculate_dimension(), "A1:F2")
        self.assertEqual(updated_sheet["A2"].value, "SERIE-NOVA-FICTICIA")
        self.assertEqual(updated_sheet["B2"].value, "APELIDO FICTICIO")
        self.assertIsNone(updated_sheet["D2"].value)
        self.assertIsNone(updated_sheet["F2"].value)
        updated_workbook.close()

    def test_upload_appends_invall_alias_change_to_comparison_history_only(self):
        make_details(self.details, [("SN-1", "ALIAS-DETALHES", "Modelo A", "Maringá", "Notebook", "87000000")])
        make_endpoint(self.endpoint, [("SN-1", "PRNOTE-OLD")])
        make_model(self.model)
        self.comparison_history.write_text(json.dumps([{"id": "anterior", "comparacao": {}}]), encoding="utf-8")
        self.manual_history.write_text(json.dumps([{"id": "manual-antigo", "tipo": "apelido", "serial": "OUTRO"}]), encoding="utf-8")
        self.assertTrue(main.load_database())
        details_before_upload_alias = "ALIAS-DETALHES"
        comparison_before = json.loads(self.comparison_history.read_text(encoding="utf-8"))
        manual_before = json.loads(self.manual_history.read_text(encoding="utf-8"))

        endpoint_bytes = _endpoint_bytes([("SN-1", "PRNOTE-NEW")])
        details_bytes = _details_bytes([
            ("SN-1", details_before_upload_alias, "Modelo A", "Maringá", "Notebook", "87000000"),
            ("", "ALIAS-SEM-SERIE", "Modelo B", "Londrina", "Notebook", "86000000"),
        ])
        result = asyncio.run(main.atualizar_planilhas(
            UploadFile(filename="InvAll_nova.xlsx", file=io.BytesIO(endpoint_bytes)),
            UploadFile(filename="Detalhes_novos.xlsx", file=io.BytesIO(details_bytes)),
        ))

        self.assertTrue(result["sucesso"])
        self.assertEqual(main.equipamentos_cache["SN-1"]["apelido"], "PRNOTE-NEW")
        saved_details = openpyxl.load_workbook(self.details, data_only=True)
        self.assertEqual(saved_details["EquipamentosDetalhes"]["B2"].value, details_before_upload_alias)
        saved_details.close()
        comparison_after = json.loads(self.comparison_history.read_text(encoding="utf-8"))
        manual_after = json.loads(self.manual_history.read_text(encoding="utf-8"))
        self.assertEqual(comparison_after[0], comparison_before[0])
        self.assertEqual(manual_after, manual_before)
        recorded = comparison_after[-1]["comparacao"]["apelidos_atualizados"]
        self.assertEqual(len(recorded), 1)
        self.assertEqual(recorded[0]["serie"], "SN-1")
        self.assertEqual(recorded[0]["apelido_anterior"], "PRNOTE-OLD")
        self.assertEqual(recorded[0]["apelido_novo"], "PRNOTE-NEW")
        self.assertEqual(recorded[0]["arquivos_origem"], {
            "endpoint": "InvAll_nova.xlsx",
            "detalhes": "Detalhes_novos.xlsx",
        })
        self.assertTrue(recorded[0]["horario"])
        self.assertTrue(any(
            item["serie"] == "" and "EquipamentosDetalhes" in item["motivo"]
            for item in comparison_after[-1]["comparacao"]["apelidos_sem_atualizacao"]
        ))

        repeated = asyncio.run(main.atualizar_planilhas(
            UploadFile(filename="InvAll_repetida.xlsx", file=io.BytesIO(endpoint_bytes)),
            UploadFile(filename="Detalhes_repetidos.xlsx", file=io.BytesIO(details_bytes)),
        ))
        self.assertTrue(repeated["sucesso"])
        comparison_after_repeat = json.loads(self.comparison_history.read_text(encoding="utf-8"))
        self.assertEqual(len(comparison_after_repeat[-1]["comparacao"]["apelidos_atualizados"]), 0)
        self.assertEqual(len(comparison_after_repeat), len(comparison_before) + 2)
        self.assertEqual(json.loads(self.manual_history.read_text(encoding="utf-8")), manual_before)

    def test_upload_replaces_inventory_snapshot_and_keeps_duplicate_source_rows(self):
        make_details(self.details, [
            ("SN-REMOVER", "ALIAS-ANTIGO", "Modelo antigo", "Maringá", "Notebook", "87000000"),
            ("SN-MANTER", "ALIAS-ANTIGO", "Modelo A", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint(self.endpoint, [
            ("SN-REMOVER", "HOST-ANTIGO"),
            ("SN-MANTER", "HOST-ANTIGO"),
        ])
        make_model(self.model)
        self.comparison_history.write_text("[]", encoding="utf-8")
        self.assertTrue(main.load_database())

        endpoint_bytes = _endpoint_bytes([
            ("SN-MANTER", "HOST-NOVO"),
            ("SN-DUP", "HOST-DUPLICADO"),
        ])
        details_bytes = _details_bytes([
            ("SN-MANTER", "ALIAS-DA-FONTE", "Modelo A", "Maringá", "Notebook", "87000000"),
            ("SN-DUP", "ALIAS-DUP-A", "Modelo B", "Londrina", "Notebook", "86000000"),
            ("SN-DUP", "ALIAS-DUP-B", "Modelo C", "Londrina", "Notebook", "86000000"),
        ])
        result = asyncio.run(main.atualizar_planilhas(
            UploadFile(filename="InvAll_retrato.xlsx", file=io.BytesIO(endpoint_bytes)),
            UploadFile(filename="Detalhes_retrato.xlsx", file=io.BytesIO(details_bytes)),
        ))

        self.assertTrue(result["sucesso"])
        saved_details = openpyxl.load_workbook(self.details, data_only=False)
        details_sheet = saved_details["EquipamentosDetalhes"]
        details_rows = [
            (row[0], row[1])
            for row in details_sheet.iter_rows(min_row=2, values_only=True)
            if any(value is not None for value in row)
        ]
        self.assertEqual(details_rows, [
            ("SN-MANTER", "ALIAS-DA-FONTE"),
            ("SN-DUP", "ALIAS-DUP-A"),
            ("SN-DUP", "ALIAS-DUP-B"),
        ])
        self.assertEqual(saved_details["Metadados"]["B1"].value, "=1+1")
        saved_details.close()

        saved_endpoint = openpyxl.load_workbook(self.endpoint, data_only=True)
        endpoint_rows = list(saved_endpoint["InvAllComputersSummary"].iter_rows(min_row=2, values_only=True))
        self.assertEqual(endpoint_rows, [("SN-MANTER", "HOST-NOVO"), ("SN-DUP", "HOST-DUPLICADO")])
        saved_endpoint.close()

        self.assertNotIn("SN-REMOVER", main.equipamentos_cache)
        self.assertEqual(main.equipamentos_cache["SN-MANTER"]["apelido"], "HOST-NOVO")
        self.assertEqual(main.equipamentos_cache["SN-DUP"]["invall_alias_status"], "serie_detalhes_duplicada")
        self.assertNotEqual(main.equipamentos_cache["SN-DUP"]["apelido"], "HOST-DUPLICADO")

    def test_upload_history_failure_rolls_back_workbooks_history_and_memory(self):
        make_details(self.details, [("SN-1", "ALIAS-DETALHES", "Modelo A", "Maringá", "Notebook", "87000000")])
        make_endpoint(self.endpoint, [("SN-1", "PRNOTE-OLD")])
        make_model(self.model)
        self.comparison_history.write_text("[]", encoding="utf-8")
        self.assertTrue(main.load_database())
        before_bytes = {path: path.read_bytes() for path in (self.details, self.endpoint)}
        before_cache = copy.deepcopy(main.equipamentos_cache)
        endpoint_bytes = _endpoint_bytes([("SN-1", "PRNOTE-NEW")])
        details_bytes = _details_bytes([("SN-1", "ALIAS-DETALHES", "Modelo A", "Maringá", "Notebook", "87000000")])
        original_update = main.AtomicFileTransaction.update_json

        def fail_comparison_history(transaction, path, updater, default):
            if Path(path) == self.comparison_history:
                raise OSError("falha fictícia no histórico")
            return original_update(transaction, path, updater, default)

        with patch.object(main.AtomicFileTransaction, "update_json", fail_comparison_history):
            with self.assertRaises(main.HTTPException) as raised:
                asyncio.run(main.atualizar_planilhas(
                    UploadFile(filename="InvAll_falha.xlsx", file=io.BytesIO(endpoint_bytes)),
                    UploadFile(filename="Detalhes_falha.xlsx", file=io.BytesIO(details_bytes)),
                ))
        self.assertEqual(raised.exception.status_code, 500)
        self.assertIn("restaurados", raised.exception.detail)
        self.assertEqual({path: path.read_bytes() for path in before_bytes}, before_bytes)
        self.assertEqual(self.comparison_history.read_text(encoding="utf-8"), "[]")
        self.assertEqual(main.equipamentos_cache, before_cache)

    def test_upload_failure_preserves_alias_committed_while_upload_waited_for_lock(self):
        make_details(self.details, [("SN-1", "ALIAS-DETALHES", "Modelo A", "Maringá", "Notebook", "87000000")])
        make_endpoint(self.endpoint, [("SN-1", "PRNOTE-OLD")])
        self.comparison_history.write_text("[]", encoding="utf-8")
        self.assertTrue(main.load_database())

        original_transaction = main.AtomicFileTransaction
        upload_waiting = threading.Event()
        allow_upload = threading.Event()

        class PausingTransaction(original_transaction):
            def __enter__(self):
                required = {self.details_path, self.endpoint_path}
                if required.issubset(set(self.targets)):
                    upload_waiting.set()
                    if not allow_upload.wait(10):
                        raise TimeoutError("o teste não liberou a transação pausada")
                return super().__enter__()

        PausingTransaction.details_path = self.details.resolve()
        PausingTransaction.endpoint_path = self.endpoint.resolve()
        original_update = original_transaction.update_json

        def fail_comparison_history(transaction, path, updater, default):
            if Path(path).resolve() == self.comparison_history.resolve():
                raise OSError("falha fictícia no histórico")
            return original_update(transaction, path, updater, default)

        upload_outcome = {}

        def run_upload():
            try:
                upload_outcome["result"] = asyncio.run(main.atualizar_planilhas(
                    UploadFile(filename="InvAll_nova.xlsx", file=io.BytesIO(_endpoint_bytes([("SN-1", "PRNOTE-NEW")]))),
                    UploadFile(filename="Detalhes_novos.xlsx", file=io.BytesIO(_details_bytes([
                        ("SN-1", "ALIAS-DETALHES", "Modelo A", "Maringá", "Notebook", "87000000"),
                    ]))),
                ))
            except BaseException as error:
                upload_outcome["error"] = error

        with (
            patch.object(main, "AtomicFileTransaction", PausingTransaction),
            patch.object(original_transaction, "update_json", fail_comparison_history),
        ):
            worker = threading.Thread(target=run_upload)
            worker.start()
            try:
                self.assertTrue(upload_waiting.wait(10), "o upload não chegou ao bloqueio esperado")
                main.aplicar_alteracao_apelido("SN-1", "MANUAL-COMMITTED")
                committed_workbooks = {path: path.read_bytes() for path in (self.details, self.endpoint)}
                committed_overrides = self.overrides.read_text(encoding="utf-8")
                self.assertEqual(main.equipamentos_cache["SN-1"]["apelido"], "MANUAL-COMMITTED")
            finally:
                allow_upload.set()
                worker.join(10)

        self.assertFalse(worker.is_alive(), "a transação de upload não terminou")
        self.assertIsInstance(upload_outcome.get("error"), main.HTTPException)
        self.assertEqual(upload_outcome["error"].status_code, 500)
        self.assertEqual({path: path.read_bytes() for path in committed_workbooks}, committed_workbooks)
        self.assertEqual(self.overrides.read_text(encoding="utf-8"), committed_overrides)
        self.assertEqual(self.comparison_history.read_text(encoding="utf-8"), "[]")
        self.assertEqual(main.equipamentos_cache["SN-1"]["apelido"], "MANUAL-COMMITTED")

    def test_stale_restore_preview_does_not_revert_concurrent_alias_commit_in_cache(self):
        make_details(self.details, [("SN-1", "ALIAS-ATUAL", "Modelo A", "Maringá", "Notebook", "87000000")])
        make_endpoint(self.endpoint, [("SN-1", "PRNOTE-ATUAL")])
        backup_dir = self.backups / "restore-source"
        (backup_dir / "endpoint").mkdir(parents=True)
        (backup_dir / "detalhes").mkdir()
        make_endpoint(backup_dir / "endpoint" / self.endpoint.name, [("SN-1", "PRNOTE-ANTIGO")])
        make_details(backup_dir / "detalhes" / self.details.name, [
            ("SN-1", "ALIAS-ANTIGO", "Modelo A", "Maringá", "Notebook", "87000000"),
        ])
        self.comparison_history.write_text(json.dumps([{
            "id": "restore-source-event",
            "horario": "2026-10-01T12:00:00-03:00",
            "comparacao": {"backup_diretorio": str(backup_dir.relative_to(self.input_dir))},
        }]), encoding="utf-8")
        self.assertTrue(main.load_database())
        preview = main.visualizar_restauracao_comparacao("restore-source-event")

        original_transaction = main.AtomicFileTransaction
        restore_waiting = threading.Event()
        allow_restore = threading.Event()

        class PausingTransaction(original_transaction):
            def __enter__(self):
                required = {self.details_path, self.endpoint_path}
                if required.issubset(set(self.targets)):
                    restore_waiting.set()
                    if not allow_restore.wait(10):
                        raise TimeoutError("o teste não liberou a transação pausada")
                return super().__enter__()

        PausingTransaction.details_path = self.details.resolve()
        PausingTransaction.endpoint_path = self.endpoint.resolve()
        restore_outcome = {}

        def run_restore():
            try:
                restore_outcome["result"] = main.restaurar_comparacao_historica(
                    "restore-source-event",
                    main.ComparisonRestorePayload(preview_token=preview["preview_token"]),
                )
            except BaseException as error:
                restore_outcome["error"] = error

        with patch.object(main, "AtomicFileTransaction", PausingTransaction):
            worker = threading.Thread(target=run_restore)
            worker.start()
            try:
                self.assertTrue(restore_waiting.wait(10), "a restauração não chegou ao bloqueio esperado")
                main.aplicar_alteracao_apelido("SN-1", "MANUAL-COMMITTED")
                committed_workbooks = {path: path.read_bytes() for path in (self.details, self.endpoint)}
                self.assertEqual(main.equipamentos_cache["SN-1"]["apelido"], "MANUAL-COMMITTED")
            finally:
                allow_restore.set()
                worker.join(10)

        self.assertFalse(worker.is_alive(), "a restauração não terminou")
        self.assertIsInstance(restore_outcome.get("error"), main.HTTPException)
        self.assertEqual(restore_outcome["error"].status_code, 409)
        self.assertEqual({path: path.read_bytes() for path in committed_workbooks}, committed_workbooks)
        self.assertEqual(main.equipamentos_cache["SN-1"]["apelido"], "MANUAL-COMMITTED")

    def test_manual_undo_reverses_latest_event_and_preserves_manual_override_priority(self):
        make_details(self.details, [("SN-1", "ALIAS-ORIGINAL", "Modelo A", "Maringá", "Notebook", "87000000")])
        make_endpoint(self.endpoint, [("SN-1", "HOST-INVALL")])
        make_model(self.model)
        self.comparison_history.write_text(json.dumps([{"id": "planilha-antiga"}]), encoding="utf-8")
        self.manual_history.write_text(json.dumps([{
            "id": "manual-anterior",
            "tipo": "apelido",
            "serial": "SN-1",
            "apelido_anterior": "VALOR-ANTES",
            "apelido_novo": "ALIAS-ORIGINAL",
        }]), encoding="utf-8")
        self.assertTrue(main.load_database())

        saved = main.atualizar_apelido(main.ApelidoUpdatePayload(serial="SN-1", apelido="ALIAS-MANUAL"))
        self.assertEqual(saved["equipamento"]["apelido"], "ALIAS-MANUAL")
        history_after_save = json.loads(self.manual_history.read_text(encoding="utf-8"))
        latest_event = history_after_save[-1]
        self.assertEqual(latest_event["apelido_anterior"], "ALIAS-ORIGINAL")
        self.assertEqual(latest_event["apelido_novo"], "ALIAS-MANUAL")

        # Excel metadata carries second-resolution timestamps; the second save
        # must remain valid even after openpyxl refreshes the modified field.
        time.sleep(1.1)
        undone = main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=latest_event["id"]))
        self.assertEqual(undone["equipamento"]["apelido"], "ALIAS-ORIGINAL")
        self.assertEqual(len(json.loads(self.manual_history.read_text(encoding="utf-8"))), 3)
        self.assertEqual(json.loads(self.comparison_history.read_text(encoding="utf-8")), [{"id": "planilha-antiga"}])
        saved_details = openpyxl.load_workbook(self.details, data_only=True)
        self.assertEqual(saved_details["EquipamentosDetalhes"]["B2"].value, "ALIAS-ORIGINAL")
        saved_details.close()

        # A stale in-memory cache must not authorize undo if the workbook value changed elsewhere.
        latest_undo = json.loads(self.manual_history.read_text(encoding="utf-8"))[-1]
        workbook = openpyxl.load_workbook(self.details)
        workbook["EquipamentosDetalhes"]["B2"] = "VALOR-EXTERNO"
        workbook.save(self.details)
        workbook.close()
        with self.assertRaises(main.HTTPException) as raised:
            main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=latest_undo["id"]))
        self.assertEqual(raised.exception.status_code, 409)


async def _collect_stream(response):
    return b"".join([chunk async for chunk in response.body_iterator])


def _endpoint_bytes(rows):
    with tempfile.TemporaryDirectory(prefix=".upload-bytes-test-", dir=PROJECT_ROOT) as directory:
        path = Path(directory) / "endpoint-ficticio.xlsx"
        make_endpoint(path, rows)
        return path.read_bytes()


def _details_bytes(rows):
    with tempfile.TemporaryDirectory(prefix=".upload-bytes-test-", dir=PROJECT_ROOT) as directory:
        path = Path(directory) / "detalhes-ficticio.xlsx"
        make_details(path, rows)
        return path.read_bytes()


if __name__ == "__main__":
    unittest.main()
