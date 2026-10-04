import asyncio
import copy
import io
import json
import os
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
from openpyxl.worksheet.table import Table, TableStyleInfo
from starlette.datastructures import UploadFile

with patch("openpyxl.load_workbook", side_effect=RuntimeError("testes não acessam planilhas locais")):
    import main


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PHONE_FORMAT_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "phone_format_cases.json").read_text(encoding="utf-8")
)


def make_details(path: Path, rows, headers=None):
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = "EquipamentosDetalhes"
    worksheet.append(headers or ["NumeroSerie", "Apelido", "Modelo", "Cidade", "Tipo", "CEP"])
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


def add_structured_table(path: Path, reference="A1:F2", name="EquipmentInventory"):
    workbook = openpyxl.load_workbook(path)
    worksheet = workbook["EquipamentosDetalhes"]
    table = Table(displayName=name, ref=reference)
    table.tableStyleInfo = TableStyleInfo(
        name="TableStyleMedium2", showFirstColumn=False, showLastColumn=False,
        showRowStripes=True, showColumnStripes=False,
    )
    worksheet.add_table(table)
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
        "retirada_cnpj": "00.000.000/0000-00",
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

    def test_partial_equipment_search_does_not_return_an_arbitrary_exact_lookup(self):
        main.equipamentos_cache = {
            "SERIE-ABC-001": {"serial": "SERIE-ABC-001", "modelo": "MODELO A"},
            "SERIE-ABC-002": {"serial": "SERIE-ABC-002", "modelo": "MODELO B"},
        }

        with self.assertRaises(main.HTTPException) as raised:
            main.get_equipamento("ABC")

        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(
            [item["serial"] for item in main._buscar_equipamentos_por_termo("ABC")],
            ["SERIE-ABC-001", "SERIE-ABC-002"],
        )
        self.assertEqual(main.get_equipamento("serie-abc-002")["serial"], "SERIE-ABC-002")

    def test_unit_ids_survive_sorting_edits_additions_and_database_reload(self):
        make_details(self.details, [
            ("SERIE-LONDRINA", "HOST-LONDRINA", "MODELO A", "Londrina", "Notebook", "86000000"),
            ("SERIE-MARINGA", "HOST-MARINGA", "MODELO B", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint(self.endpoint, [
            ("SERIE-LONDRINA", "HOST-LONDRINA"),
            ("SERIE-MARINGA", "HOST-MARINGA"),
        ])
        saved_zeta = {
            "id": 47,
            "cidade": "Zeta",
            "endereco": "Rua Fictícia, 47",
            "uf": "PR",
            "cep": "85000-000",
            "cnpj": "47.000.000/0000-47",
            "is_sede": False,
            "endereco_completo": "Rua Fictícia, 47 - Zeta/PR - CEP 85000-000",
            "label": "Zeta - Rua Fictícia, 47 (47.000.000/0000-47)",
        }
        self.custom_units.write_text(json.dumps([saved_zeta]), encoding="utf-8")

        self.assertTrue(main.load_database())
        zeta = next(unit for unit in main.unidades_cache if unit["cidade"] == "Zeta")
        self.assertEqual(zeta["id"], 47)
        ids_before = {unit["cidade"]: unit["id"] for unit in main.unidades_cache}
        self.assertEqual(len(set(ids_before.values())), len(ids_before))

        main.salvar_unidade(main.UnidadePayload(
            cidade="Arapongas",
            endereco="Rua Nova, 8",
            uf="PR",
            cep="86700-000",
            cnpj="08.000.000/0000-08",
        ))
        ids_after_add = {unit["cidade"]: unit["id"] for unit in main.unidades_cache}
        for city, unit_id in ids_before.items():
            self.assertEqual(ids_after_add[city], unit_id)
        self.assertIn("Arapongas", ids_after_add)
        self.assertEqual(len(set(ids_after_add.values())), len(ids_after_add))

        main.salvar_unidade(main.UnidadePayload(
            id=47,
            cidade="Zeta",
            endereco="Rua Fictícia, 48",
            uf="PR",
            cep="85000-001",
            cnpj="47.000.000/0000-47",
        ))
        saved_units = json.loads(self.custom_units.read_text(encoding="utf-8"))
        self.assertEqual(len(saved_units), 2)
        edited_zeta = next(unit for unit in saved_units if unit["id"] == 47)
        self.assertEqual(edited_zeta["endereco"], "Rua Fictícia, 48")
        self.assertEqual(
            next(unit for unit in main.unidades_cache if unit["cidade"] == "Zeta")["id"],
            47,
        )

        before_stale_edit = self.custom_units.read_bytes()
        with self.assertRaises(main.HTTPException) as raised:
            main.salvar_unidade(main.UnidadePayload(
                id=999,
                cidade="Duplicata",
                endereco="Rua que não deve ser incluída",
                uf="PR",
                cep="80000-000",
                cnpj="99.000.000/0000-99",
            ))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.custom_units.read_bytes(), before_stale_edit)

    def test_concurrent_unit_saves_preserve_both_catalog_updates(self):
        make_details(
            self.details,
            [("SN-1", "HOST-1", "Modelo A", "Maringá", "Notebook", "87000000")],
        )
        make_endpoint(self.endpoint, [("SN-1", "HOST-1")])
        self.custom_units.write_text("[]", encoding="utf-8")
        self.assertTrue(main.load_database())

        start_together = threading.Barrier(3)
        legacy_saves_together = threading.Barrier(2)
        results = []
        original_save = main.save_custom_units

        def force_legacy_writers_to_share_one_snapshot(units):
            legacy_saves_together.wait(timeout=5)
            original_save(units)

        def save_unit(city, cep):
            start_together.wait(timeout=5)
            try:
                results.append(main.salvar_unidade(main.UnidadePayload(
                    cidade=city,
                    endereco="Rua Fictícia, 10",
                    uf="PR",
                    cep=cep,
                    cnpj=f"{city[-1]}0.000.000/0000-00",
                )))
            except Exception as error:
                results.append(error)

        with patch.object(main, "save_custom_units", side_effect=force_legacy_writers_to_share_one_snapshot):
            workers = [
                threading.Thread(target=save_unit, args=("Unidade Concorrente A", "80000-001")),
                threading.Thread(target=save_unit, args=("Unidade Concorrente B", "80000-002")),
            ]
            for worker in workers:
                worker.start()
            start_together.wait(timeout=5)
            for worker in workers:
                worker.join(timeout=10)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(len(results), 2)
        self.assertFalse([result for result in results if isinstance(result, Exception)])
        persisted = json.loads(self.custom_units.read_text(encoding="utf-8"))
        saved_cities = {unit["cidade"] for unit in persisted}
        self.assertEqual(saved_cities, {"Unidade Concorrente A", "Unidade Concorrente B"})
        saved_ids = [unit["id"] for unit in persisted]
        self.assertEqual(len(saved_ids), len(set(saved_ids)))
        self.assertTrue({"Unidade Concorrente A", "Unidade Concorrente B"}.issubset(
            {unit["cidade"] for unit in main.unidades_cache}
        ))

    def test_unit_save_transaction_failure_preserves_catalog_and_cache(self):
        make_details(
            self.details,
            [("SN-1", "HOST-1", "Modelo A", "Maringá", "Notebook", "87000000")],
        )
        make_endpoint(self.endpoint, [("SN-1", "HOST-1")])
        self.custom_units.write_text("[]", encoding="utf-8")
        self.assertTrue(main.load_database())
        catalog_before = self.custom_units.read_bytes()
        units_before = copy.deepcopy(main.unidades_cache)

        with patch.object(
            main.AtomicFileTransaction,
            "update_json",
            side_effect=main.FileTransactionError("falha fictícia de gravação"),
        ):
            with self.assertRaises(main.HTTPException) as raised:
                main.salvar_unidade(main.UnidadePayload(
                    cidade="Unidade Não Persistida",
                    endereco="Rua Fictícia, 11",
                    uf="PR",
                    cep="80000-003",
                    cnpj="110.000.000/0000-00",
                ))

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(self.custom_units.read_bytes(), catalog_before)
        self.assertEqual(main.unidades_cache, units_before)

    def test_detail_upload_headers_and_active_reader_share_normalization(self):
        variants = ("NumeroSerie", "numero_serie", "NÚMERO-SERIE", "Número de Série")
        for index, serial_header in enumerate(variants):
            with self.subTest(serial_header=serial_header):
                path = self.input_dir / f"EquipamentosDetalhes_variante_{index}.xlsx"
                make_details(
                    path,
                    [("SERIE-FICTICIA", "ALIAS-FICTICIO", "Modelo A", "Maringá", "Notebook", "87000000")],
                    headers=[serial_header, "HOSTNAME", "Modelo", "Cidade", "Tipo", "CEP"],
                )

                uploaded = main.validate_uploaded_workbook(path.read_bytes(), "detalhes")

                self.assertEqual(uploaded["populated_rows"], 1)
                self.assertEqual(main.find_details_sheet(path), "EquipamentosDetalhes")

    def test_uploaded_details_loads_text_serial_without_coercing_other_columns(self):
        headers = ["nÚmero_de_Série", "hOsT-name", "mÓde-lo", "Cidade", "Tipo", "CEP", "IdCliente"]
        make_details(
            self.details,
            [
                ("001234", "HOST-TEXTO", "Modelo A", "Maringá", "Notebook", "87000000", 101),
                (None, "HOST-SEM-SERIE", "Modelo B", "Londrina", "Notebook", "86000000", 102),
                (1234, "HOST-NUMERICO", "Modelo C", "Ponta Grossa", "Notebook", "84000000", 103),
            ],
            headers=headers,
        )
        make_endpoint(self.endpoint, [("OUTRA-SERIE", "HOST-OUTRO")])

        uploaded = main.validate_uploaded_workbook(self.details.read_bytes(), "detalhes")
        self.assertEqual(uploaded["populated_rows"], 2)
        dataframe = main._read_details_sheet_dataframe(self.details, "EquipamentosDetalhes")
        self.assertEqual(dataframe.iloc[0][headers[0]], "001234")
        self.assertEqual(dataframe.iloc[2][headers[0]], 1234)
        self.assertTrue(main.pd.api.types.is_integer_dtype(dataframe["IdCliente"].dtype))

        self.assertTrue(main.load_database())
        self.assertIn("001234", main.equipamentos_cache)
        self.assertIn("1234", main.equipamentos_cache)
        self.assertNotIn("HOST-SEM-SERIE", main.equipamentos_cache)
        self.assertEqual(main.equipamentos_cache["001234"]["apelido"], "HOST-TEXTO")
        self.assertEqual(main.equipamentos_cache["1234"]["apelido"], "HOST-NUMERICO")

    def test_equipment_edit_changes_only_loaded_source_and_keeps_other_active_records(self):
        archived = self.input_dir / "EquipamentosDetalhes_arquivo_antigo.xlsx"
        make_details(self.details, [
            ("SN-EDITAR", "ALIAS-EDITAR", "Modelo antes", "Maringá", "Notebook", "87000000"),
            ("SN-MANTER", "ALIAS-MANTER", "Modelo manter", "Londrina", "Notebook", "86000000"),
        ])
        make_details(archived, [
            ("SN-ARQUIVO", "ALIAS-ARQUIVO", "Modelo arquivo", "Ponta Grossa", "Notebook", "84000000"),
        ])
        make_endpoint(self.endpoint, [("OUTRA-SERIE", "HOST-OUTRO")])
        make_model(self.model)
        timestamp = time.time()
        os.utime(archived, (timestamp - 60, timestamp - 60))
        os.utime(self.details, (timestamp, timestamp))
        archived_before = archived.read_bytes()

        self.assertTrue(main.load_database())
        self.assertEqual(main.get_primary_equipment_file().resolve(), self.details.resolve())
        selected = main.get_equipamento("SN-EDITAR")
        self.assertEqual(selected["modelo"], "Modelo antes")

        result = main.salvar_equipamento(main.EquipamentoUpdatePayload(
            serial=selected["serial"],
            modelo="Modelo atualizado",
            tipo="Notebook",
            idCliente="CLIENTE-ATUALIZADO",
        ))

        self.assertTrue(result["sucesso"])
        self.assertEqual(archived.read_bytes(), archived_before)
        self.assertEqual(main.get_primary_equipment_file().resolve(), self.details.resolve())
        self.assertTrue(main.load_database())
        self.assertIn("SN-EDITAR", main.equipamentos_cache)
        self.assertIn("SN-MANTER", main.equipamentos_cache)
        self.assertEqual(main.equipamentos_cache["SN-EDITAR"]["modelo"], "Modelo atualizado")
        self.assertEqual(main.equipamentos_cache["SN-MANTER"]["modelo"], "Modelo manter")

    def test_equipment_edit_refuses_duplicate_serial_without_writing(self):
        make_details(self.details, [
            ("SN-DUP", "ALIAS-PRIMEIRO", "Modelo A", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint(self.endpoint, [("OUTRA-SERIE", "HOST-OUTRO")])
        make_model(self.model)
        self.assertTrue(main.load_database())

        workbook = openpyxl.load_workbook(self.details)
        workbook["EquipamentosDetalhes"].append(
            ["SN-DUP", "ALIAS-SEGUNDO", "Modelo B", "Londrina", "Notebook", "86000000"]
        )
        workbook.save(self.details)
        workbook.close()
        before = self.details.read_bytes()
        cache_before = copy.deepcopy(main.equipamentos_cache)

        with self.assertRaises(main.HTTPException) as raised:
            main.salvar_equipamento(main.EquipamentoUpdatePayload(
                serial="SN-DUP", modelo="Modelo incorreto", tipo="Notebook"
            ))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("mais de uma vez", raised.exception.detail)
        self.assertEqual(self.details.read_bytes(), before)
        self.assertEqual(main.equipamentos_cache, cache_before)

        self.assertTrue(main.load_database())
        cache_before = copy.deepcopy(main.equipamentos_cache)
        with self.assertRaises(main.HTTPException) as raised:
            main.salvar_equipamento(main.EquipamentoUpdatePayload(
                serial="SN-DUP", modelo="Modelo incorreto", tipo="Notebook"
            ))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("duplicada", raised.exception.detail)
        self.assertEqual(self.details.read_bytes(), before)
        self.assertEqual(main.equipamentos_cache, cache_before)

    def test_equipment_edit_refuses_a_new_active_source_after_cache_load(self):
        make_details(self.details, [
            ("SN-CACHE", "ALIAS-CACHE", "Modelo A", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint(self.endpoint, [("OUTRA-SERIE", "HOST-OUTRO")])
        make_model(self.model)
        self.assertTrue(main.load_database())
        cache_before = copy.deepcopy(main.equipamentos_cache)
        source_before = self.details.read_bytes()

        newer_source = self.input_dir / "EquipamentosDetalhes_mais_novo.xlsx"
        make_details(newer_source, [
            ("SN-NOVO", "ALIAS-NOVO", "Modelo B", "Londrina", "Notebook", "86000000"),
        ])
        timestamp = time.time() + 60
        os.utime(newer_source, (timestamp, timestamp))
        newer_before = newer_source.read_bytes()

        with self.assertRaises(main.HTTPException) as raised:
            main.salvar_equipamento(main.EquipamentoUpdatePayload(
                serial="SN-CACHE", modelo="Modelo alterado", tipo="Notebook"
            ))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("base ativa mudou", raised.exception.detail)
        self.assertEqual(self.details.read_bytes(), source_before)
        self.assertEqual(newer_source.read_bytes(), newer_before)
        self.assertEqual(main.equipamentos_cache, cache_before)

    def test_equipment_edit_failure_preserves_workbook_and_cache(self):
        make_details(self.details, [
            ("SN-FALHA", "ALIAS-ORIGINAL", "Modelo original", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint(self.endpoint, [("OUTRA-SERIE", "HOST-OUTRO")])
        make_model(self.model)
        self.assertTrue(main.load_database())
        before = self.details.read_bytes()
        cache_before = copy.deepcopy(main.equipamentos_cache)

        with patch.object(main, "stage_workbook_update", side_effect=main.FileTransactionError("falha fictícia")):
            with self.assertRaises(main.HTTPException) as raised:
                main.salvar_equipamento(main.EquipamentoUpdatePayload(
                    serial="SN-FALHA", modelo="Modelo alterado", tipo="Notebook"
                ))

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(self.details.read_bytes(), before)
        self.assertEqual(main.equipamentos_cache, cache_before)

    def test_equipment_edit_refuses_to_recreate_a_record_removed_after_load(self):
        make_details(self.details, [
            ("SN-REMOVIDO", "ALIAS-ORIGINAL", "Modelo original", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint(self.endpoint, [("OUTRA-SERIE", "HOST-OUTRO")])
        make_model(self.model)
        self.assertTrue(main.load_database())
        cache_before = copy.deepcopy(main.equipamentos_cache)

        make_details(self.details, [
            ("SN-ATUAL", "ALIAS-ATUAL", "Modelo atual", "Londrina", "Notebook", "86000000"),
        ])
        source_before = self.details.read_bytes()

        with self.assertRaises(main.HTTPException) as raised:
            main.salvar_equipamento(main.EquipamentoUpdatePayload(
                serial="SN-REMOVIDO", modelo="Modelo alterado", tipo="Notebook"
            ))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("não está mais", raised.exception.detail)
        self.assertEqual(self.details.read_bytes(), source_before)
        self.assertEqual(main.equipamentos_cache, cache_before)

    def test_new_equipment_is_appended_only_when_marked_as_new(self):
        make_details(self.details, [
            ("SN-BASE", "ALIAS-BASE", "Modelo base", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint(self.endpoint, [("OUTRA-SERIE", "HOST-OUTRO")])
        make_model(self.model)
        self.assertTrue(main.load_database())

        result = main.salvar_equipamento(main.EquipamentoUpdatePayload(
            serial="SN-NOVO", novo=True, modelo="Modelo novo", tipo="Notebook",
            apelido="ALIAS-NOVO", idCliente="CLIENTE-NOVO",
        ))

        self.assertTrue(result["sucesso"])
        self.assertIn("SN-NOVO", main.equipamentos_cache)
        self.assertTrue(main.load_database())
        self.assertIn("SN-BASE", main.equipamentos_cache)
        self.assertIn("SN-NOVO", main.equipamentos_cache)

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
        self.assertEqual(response.headers["x-total-idcliente-alterados"], "0")
        self.assertEqual(response.headers["x-total-alteracoes-exportadas"], "1")
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

    def test_export_availability_and_output_track_alias_and_idcliente_changes(self):
        cases = [
            ("nenhuma", "HOST-SAME", "HOST-SAME", "ID-SAME", "ID-SAME", 0, 0),
            ("somente-apelido", "HOST-NEW", "HOST-OLD", "ID-SAME", "ID-SAME", 1, 0),
            ("somente-idcliente", "HOST-SAME", "HOST-SAME", "ID-NEW", "ID-OLD", 0, 1),
            ("ambas", "HOST-NEW", "HOST-OLD", "ID-NEW", "ID-OLD", 1, 1),
        ]
        detail_headers = [
            "NumeroSerie", "Apelido", "Modelo", "Cidade", "Tipo", "CEP", "IdCliente", "Observacao"
        ]
        model_headers = ["NumeroSerie", "Apelido", "IdCliente", "Observacao"]

        for name, current_alias, model_alias, current_id, model_id, expected_aliases, expected_ids in cases:
            with self.subTest(case=name):
                make_details(self.details, [
                    ("S-1", current_alias, "Modelo A", "Maringá", "Notebook", "87000000", current_id, "KEEP-UNRELATED")
                ], headers=detail_headers)
                make_endpoint(self.endpoint, [("S-1", current_alias)])
                workbook = openpyxl.Workbook()
                worksheet = workbook.active
                worksheet.title = "Parque"
                worksheet.append(model_headers)
                worksheet.append(["S-1", model_alias, model_id, "KEEP-UNRELATED"])
                workbook.save(self.model)
                workbook.close()
                source_before = self.model.read_bytes()

                expected_counts = {
                    "apelidos": expected_aliases,
                    "id_clientes": expected_ids,
                    "total": expected_aliases + expected_ids,
                }
                self.assertEqual(main.count_export_changes(), expected_counts)
                self.assertEqual(main.get_stats()["total_alteracoes_exportaveis"], expected_counts["total"])

                response = main.exportar_equipamentos()
                output_bytes = asyncio.run(_collect_stream(response))
                self.assertEqual(int(response.headers["x-total-alterados"]), expected_aliases)
                self.assertEqual(int(response.headers["x-total-idcliente-alterados"]), expected_ids)
                self.assertEqual(
                    int(response.headers["x-total-alteracoes-exportadas"]),
                    expected_aliases + expected_ids,
                )
                self.assertIn(
                    "x-total-idcliente-alterados",
                    response.headers["access-control-expose-headers"].lower(),
                )

                output_workbook = openpyxl.load_workbook(io.BytesIO(output_bytes), data_only=False)
                output_sheet = output_workbook["Parque"]
                self.assertEqual(output_sheet["B2"].value, current_alias)
                self.assertEqual(output_sheet["C2"].value, current_id)
                self.assertEqual(output_sheet["D2"].value, "KEEP-UNRELATED")
                output_workbook.close()
                self.assertEqual(self.model.read_bytes(), source_before)

    def test_official_transfer_preserves_threaded_comments_and_changes_only_form_cells(self):
        template = make_transfer_template(self.input_dir / "modelo-transferencia-ficticio.xlsx")
        with self.assertRaises(main.WorkbookSafetyError):
            main.load_workbook_safely(template)
        payload = main.TransferenciaPayload(
            serial="SERIE-FICTICIA",
            descricao_equipamento="EQUIPAMENTO FICTICIO",
            contrato=12345,
            retirada_cnpj="00.000.000/0000-00",
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

    def test_transfer_rejects_empty_essential_fields_before_opening_the_template(self):
        template = make_transfer_template(self.input_dir / "modelo-validacao-ficticio.xlsx")
        invalid_fields = (
            ("serial", " ", "Número de série do equipamento"),
            ("retirada_cnpj", "  ", "CNPJ da unidade de retirada"),
            ("retirada_endereco", "", "Endereço da unidade de retirada"),
            ("entrega_cnpj", " ", "CNPJ da unidade de entrega"),
            ("entrega_endereco", "  ", "Endereço da unidade de entrega"),
        )

        with patch.object(main, "TEMPLATE_FILE", template):
            for field, empty_value, label in invalid_fields:
                with self.subTest(field=field):
                    with self.assertRaises(main.HTTPException) as raised:
                        main.gerar_planilha(make_transfer_payload(**{field: empty_value}))
                    self.assertEqual(raised.exception.status_code, 422)
                    self.assertIn(label, raised.exception.detail)

    def test_transfer_phone_formatting_handles_fixed_mobile_and_country_prefixes(self):
        for original, expected in PHONE_FORMAT_CASES:
            with self.subTest(original=original):
                self.assertEqual(main.formatar_telefone_brasileiro(original), expected)

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

    def test_upload_validation_and_transaction_do_not_block_the_event_loop(self):
        make_details(self.details, [
            ("SN-1", "ALIAS-OLD", "Modelo A", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint(self.endpoint, [("SN-1", "PRNOTE-OLD")])
        make_model(self.model)
        self.comparison_history.write_text("[]", encoding="utf-8")
        self.assertTrue(main.load_database())

        validation_started = threading.Event()
        allow_validation = threading.Event()
        transaction_started = threading.Event()
        allow_transaction = threading.Event()
        original_validator = main.validate_uploaded_workbook
        original_loader = main.load_database
        worker_threads = {}

        def pause_validation(file_bytes, role):
            if role == "endpoint":
                worker_threads["validation"] = threading.get_ident()
                validation_started.set()
                if not allow_validation.wait(3):
                    raise TimeoutError("o teste não liberou a validação pausada")
            return original_validator(file_bytes, role)

        def pause_transaction_reload(*args, **kwargs):
            worker_threads["transaction"] = threading.get_ident()
            transaction_started.set()
            if not allow_transaction.wait(3):
                raise TimeoutError("o teste não liberou a transação pausada")
            return original_loader(*args, **kwargs)

        upload_endpoint = UploadFile(
            filename="InvAll_nova.xlsx",
            file=io.BytesIO(_endpoint_bytes([("SN-1", "PRNOTE-NEW")])),
        )
        upload_details = UploadFile(
            filename="Detalhes_novos.xlsx",
            file=io.BytesIO(_details_bytes([
                ("SN-1", "ALIAS-NEW", "Modelo A", "Maringá", "Notebook", "87000000"),
            ])),
        )

        async def run_upload_with_heartbeats():
            loop = asyncio.get_running_loop()
            loop_thread = threading.get_ident()
            task = asyncio.create_task(main.atualizar_planilhas(upload_endpoint, upload_details))

            async def wait_for_event(event, description):
                deadline = loop.time() + 2
                while not event.is_set() and loop.time() < deadline:
                    await asyncio.sleep(0.005)
                self.assertTrue(event.is_set(), f"não iniciou {description}")

            try:
                await wait_for_event(validation_started, "a validação")
                await asyncio.wait_for(asyncio.sleep(0.025), timeout=0.25)
                self.assertFalse(task.done(), "a validação pausada bloqueou ou encerrou a atualização")
                allow_validation.set()

                await wait_for_event(transaction_started, "a recarga transacional")
                await asyncio.wait_for(asyncio.sleep(0.025), timeout=0.25)
                self.assertFalse(task.done(), "a recarga pausada bloqueou ou encerrou a atualização")
            finally:
                allow_validation.set()
                allow_transaction.set()

            result = await task
            return loop_thread, result

        with (
            patch.object(main, "validate_uploaded_workbook", pause_validation),
            patch.object(main, "load_database", pause_transaction_reload),
        ):
            loop_thread, result = asyncio.run(run_upload_with_heartbeats())

        self.assertTrue(result["sucesso"])
        self.assertNotEqual(worker_threads["validation"], loop_thread)
        self.assertNotEqual(worker_threads["transaction"], loop_thread)
        self.assertEqual(main.equipamentos_cache["SN-1"]["apelido"], "PRNOTE-NEW")

    def test_interrupted_upload_finishes_atomic_transaction_before_closing_request(self):
        make_details(self.details, [
            ("SN-1", "ALIAS-OLD", "Modelo A", "Maringá", "Notebook", "87000000"),
        ])
        make_endpoint(self.endpoint, [("SN-1", "PRNOTE-OLD")])
        make_model(self.model)
        self.comparison_history.write_text("[]", encoding="utf-8")
        self.assertTrue(main.load_database())

        transaction_started = threading.Event()
        allow_transaction = threading.Event()
        original_loader = main.load_database

        def pause_transaction_reload(*args, **kwargs):
            transaction_started.set()
            if not allow_transaction.wait(3):
                raise TimeoutError("o teste não liberou a transação pausada")
            return original_loader(*args, **kwargs)

        endpoint_bytes = _endpoint_bytes([("SN-1", "PRNOTE-NEW")])
        details_bytes = _details_bytes([
            ("SN-1", "ALIAS-NEW", "Modelo A", "Maringá", "Notebook", "87000000"),
        ])
        upload_endpoint = UploadFile(filename="InvAll_cancelada.xlsx", file=io.BytesIO(endpoint_bytes))
        upload_details = UploadFile(filename="Detalhes_cancelados.xlsx", file=io.BytesIO(details_bytes))

        async def cancel_and_release_upload():
            task = asyncio.create_task(main.atualizar_planilhas(upload_endpoint, upload_details))
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 2
            try:
                while not transaction_started.is_set() and loop.time() < deadline:
                    await asyncio.sleep(0.005)
                self.assertTrue(transaction_started.is_set(), "a atualização não entrou na transação")

                task.cancel()
                await asyncio.sleep(0.025)
                self.assertFalse(task.done(), "o cancelamento liberou recursos antes da transação")
            finally:
                allow_transaction.set()

            with self.assertRaises(asyncio.CancelledError):
                await task

        with patch.object(main, "load_database", pause_transaction_reload):
            asyncio.run(cancel_and_release_upload())

        self.assertTrue(upload_endpoint.file.closed)
        self.assertTrue(upload_details.file.closed)
        self.assertEqual(self.endpoint.read_bytes(), endpoint_bytes)
        self.assertEqual(self.details.read_bytes(), details_bytes)
        history = json.loads(self.comparison_history.read_text(encoding="utf-8"))
        self.assertEqual(len(history), 1)
        self.assertEqual(main.equipamentos_cache["SN-1"]["apelido"], "PRNOTE-NEW")

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

    def test_manual_alias_writer_uses_supported_columns_at_different_positions(self):
        layouts = (
            {
                "serial": "SN-1",
                "headers": ["NumeroSerie", "Hostname", "Modelo", "Cidade", "Tipo", "CEP"],
                "row": ["SN-1", "HOST-ORIGINAL", "Modelo A", "Maringá", "Notebook", "87000000"],
                "alias_cell": "B2",
                "type_cell": "E2",
            },
            {
                "serial": "SN-2",
                "headers": ["Hostname", "Tipo", "Modelo", "Cidade", "CEP", "Serial"],
                "row": ["HOST-ORIGINAL", "Notebook", "Modelo B", "Londrina", "86000000", "SN-2"],
                "alias_cell": "A2",
                "type_cell": "B2",
            },
        )
        make_endpoint(self.endpoint, [("SN-1", "HOST-INVALL-1"), ("SN-2", "HOST-INVALL-2")])

        for layout in layouts:
            with self.subTest(serial=layout["serial"]):
                self.overrides.write_text("{}", encoding="utf-8")
                self.manual_history.write_text("[]", encoding="utf-8")
                make_details(self.details, [layout["row"]], headers=layout["headers"])
                self.assertTrue(main.load_database())

                result = main.atualizar_apelido(main.ApelidoUpdatePayload(
                    serial=layout["serial"], apelido="HOST-MANUAL"
                ))

                self.assertTrue(result["salvo_no_disco"])
                workbook = openpyxl.load_workbook(self.details, data_only=True)
                worksheet = workbook["EquipamentosDetalhes"]
                self.assertEqual(worksheet[layout["alias_cell"]].value, "HOST-MANUAL")
                self.assertEqual(worksheet[layout["type_cell"]].value, "Notebook")
                workbook.close()

    def test_manual_alias_rejects_changed_active_source_without_mutating_state(self):
        make_details(
            self.details,
            [("SN-1", "HOST-ORIGINAL", "Modelo A", "Maringá", "Notebook", "87000000")],
        )
        make_endpoint(self.endpoint, [("SN-1", "HOST-ENDPOINT")])
        self.overrides.write_text("{}", encoding="utf-8")
        self.manual_history.write_text("[]", encoding="utf-8")
        self.assertTrue(main.load_database())
        cached_before = copy.deepcopy(main.equipamentos_cache)
        original_source = Path(cached_before["SN-1"]["_source_file"]).resolve()

        older_mtime = time.time_ns() - 10_000_000_000
        os.utime(self.details, ns=(older_mtime, older_mtime))
        replacement_source = self.input_dir / "EquipamentosDetalhes_replacement.xlsx"
        make_details(
            replacement_source,
            [("SN-1", "HOST-REPLACEMENT", "Modelo A", "Maringá", "Notebook", "87000000")],
        )
        replacement_before = replacement_source.read_bytes()
        original_before = self.details.read_bytes()
        overrides_before = self.overrides.read_bytes()
        history_before = self.manual_history.read_bytes()

        self.assertEqual(main.get_primary_equipment_file().resolve(), replacement_source.resolve())
        self.assertEqual(original_source, self.details.resolve())
        with self.assertRaises(main.HTTPException) as raised:
            main.atualizar_apelido(main.ApelidoUpdatePayload(serial="SN-1", apelido="HOST-MANUAL"))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(replacement_source.read_bytes(), replacement_before)
        self.assertEqual(self.details.read_bytes(), original_before)
        self.assertEqual(self.overrides.read_bytes(), overrides_before)
        self.assertEqual(self.manual_history.read_bytes(), history_before)
        self.assertEqual(main.equipamentos_cache, cached_before)

    def test_manual_alias_writer_rejects_workbooks_without_supported_alias_column(self):
        workbook = openpyxl.Workbook()
        worksheet = workbook.active
        worksheet.title = "EquipamentosDetalhes"
        worksheet.append(["NumeroSerie", "Modelo", "Cidade", "Tipo", "CEP"])
        worksheet.append(["SN-1", "Modelo A", "Maringá", "Notebook", "87000000"])
        with self.assertRaises(main.HTTPException) as raised:
            main._edit_alias_workbook(workbook, "SN-1", "HOST-MANUAL")

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("Apelido ou Hostname", raised.exception.detail)
        self.assertEqual(worksheet["D2"].value, "Notebook")
        workbook.close()

    def test_manual_alias_can_be_removed_after_inventory_refresh_with_hostname_table(self):
        details_headers = ["NumeroSerie", "Hostname", "Modelo", "Cidade", "Tipo", "CEP"]
        make_details(
            self.details,
            [("SN-1", "HOST-DETAILS-OLD", "Modelo A", "Maringá", "Notebook", "87000000")],
            headers=details_headers,
        )
        add_structured_table(self.details)
        make_endpoint(self.endpoint, [("SN-1", "HOST-INVALL-OLD")])
        make_model(self.model)
        self.comparison_history.write_text("[]", encoding="utf-8")
        self.assertTrue(main.load_database())

        manual_result = main.atualizar_apelido(main.ApelidoUpdatePayload(
            serial="SN-1", apelido="HOST-MANUAL"
        ))
        self.assertTrue(manual_result["salvo_no_disco"])
        workbook = openpyxl.load_workbook(self.details, data_only=True)
        self.assertEqual(workbook["EquipamentosDetalhes"]["B2"].value, "HOST-MANUAL")
        self.assertEqual(workbook["EquipamentosDetalhes"]["E2"].value, "Notebook")
        self.assertEqual(workbook["EquipamentosDetalhes"].tables["EquipmentInventory"].ref, "A1:F2")
        workbook.close()

        incoming_details = self.root / "detalhes-atualizados-ficticios.xlsx"
        make_details(
            incoming_details,
            [("SN-1", "HOST-DETAILS-NEW", "Modelo A", "Maringá", "Notebook", "87000000")],
            headers=details_headers,
        )
        add_structured_table(incoming_details)
        upload_result = asyncio.run(main.atualizar_planilhas(
            UploadFile(
                filename="InvAll_atualizada.xlsx",
                file=io.BytesIO(_endpoint_bytes([("SN-1", "HOST-INVALL-NEW")])),
            ),
            UploadFile(filename="Detalhes_atualizados.xlsx", file=io.BytesIO(incoming_details.read_bytes())),
        ))
        event_id = upload_result["comparacao"]["evento_id"]
        divergence = upload_result["comparacao"]["divergencias_apelidos_manuais"][0]
        self.assertEqual(divergence["apelido_manual"], "HOST-MANUAL")
        self.assertEqual(divergence["apelido_equipamentos_detalhes"], "HOST-DETAILS-NEW")
        self.assertEqual(divergence["apelido_invall"], "HOST-INVALL-NEW")

        resolution = main.resolver_divergencia_apelido_manual(
            event_id,
            "SN-1",
            main.ManualAliasConflictResolutionPayload(acao="excluir"),
        )

        self.assertEqual(resolution["resolucao"], "excluir")
        self.assertEqual(resolution["equipamento"]["apelido"], "HOST-INVALL-NEW")
        self.assertEqual(main.load_modified_apelidos(), {})
        saved_workbook = openpyxl.load_workbook(self.details, data_only=True)
        saved_sheet = saved_workbook["EquipamentosDetalhes"]
        self.assertEqual(saved_sheet["B2"].value, "HOST-INVALL-NEW")
        self.assertEqual(saved_sheet["E2"].value, "Notebook")
        self.assertEqual(saved_sheet.tables["EquipmentInventory"].ref, "A1:F2")
        saved_workbook.close()

        history = json.loads(self.comparison_history.read_text(encoding="utf-8"))
        stored_event = next(item for item in history if item["id"] == event_id)
        stored_divergence = stored_event["comparacao"]["divergencias_apelidos_manuais"][0]
        self.assertEqual(stored_divergence["resolucao"], "excluir")

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
