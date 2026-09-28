import asyncio
import copy
import io
import json
import tempfile
import time
import unittest
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
        make_model(self.model)
        make_endpoint(self.endpoint, [
            ("s-1", "HOST-NEW"),
            ("DUP", "HOST-DUP-A"),
            ("DUP", "HOST-DUP-B"),
            ("SAME", "HOST-SAME"),
            ("MISSING", "HOST-NOT-IN-MODEL"),
            ("FORMULA", "HOST-F"),
            ("OUTDUP", "HOST-OUTDUP"),
            ("", "HOST-BLANK-SERIAL"),
        ])
        self.overrides.write_text("{}", encoding="utf-8")
        source_before = self.model.read_bytes()
        original_workbook = openpyxl.load_workbook(self.model, data_only=False)
        original_snapshot = main.workbook_snapshot(original_workbook)
        original_workbook.close()

        response = main.exportar_equipamentos()
        output_bytes = asyncio.run(_collect_stream(response))
        output_path = self.root / "export-ficticio.xlsx"
        output_path.write_bytes(output_bytes)
        self.assertEqual(response.headers["x-total-alterados"], "1")
        self.assertGreater(int(response.headers["x-total-conferencia"]), 0)
        self.assertEqual(self.model.read_bytes(), source_before)

        updated_workbook = openpyxl.load_workbook(output_path, data_only=False)
        updated_snapshot = main.workbook_snapshot(updated_workbook)
        expected_snapshot = copy.deepcopy(original_snapshot)
        expected_snapshot["worksheets"]["Parque"]["cells"]["B2"] = (
            "HOST-NEW",
            expected_snapshot["worksheets"]["Parque"]["cells"]["B2"][1],
            expected_snapshot["worksheets"]["Parque"]["cells"]["B2"][2],
            expected_snapshot["worksheets"]["Parque"]["cells"]["B2"][3],
            expected_snapshot["worksheets"]["Parque"]["cells"]["B2"][4],
        )
        self.assertEqual(updated_snapshot, expected_snapshot)
        worksheet = updated_workbook["Parque"]
        self.assertEqual(worksheet["B2"].value, "HOST-NEW")
        self.assertEqual(worksheet["B3"].value, "DUP-ANTIGO")
        self.assertEqual(worksheet["B4"].value, "HOST-SAME")
        self.assertEqual(worksheet["B5"].value, '=CONCAT("HOST","-F")')
        self.assertEqual(worksheet["B6"].value, "DUP-OUT-A")
        self.assertEqual(worksheet["B7"].value, "DUP-OUT-B")
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

    def test_manual_undo_reverses_only_latest_manual_event_and_keeps_invall_display(self):
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
        self.assertEqual(saved["equipamento"]["apelido"], "HOST-INVALL")
        history_after_save = json.loads(self.manual_history.read_text(encoding="utf-8"))
        latest_event = history_after_save[-1]
        self.assertEqual(latest_event["apelido_anterior"], "ALIAS-ORIGINAL")
        self.assertEqual(latest_event["apelido_novo"], "ALIAS-MANUAL")

        # Excel metadata carries second-resolution timestamps; the second save
        # must remain valid even after openpyxl refreshes the modified field.
        time.sleep(1.1)
        undone = main.desfazer_alteracao_apelido(main.ApelidoUndoPayload(evento_id=latest_event["id"]))
        self.assertEqual(undone["equipamento"]["apelido"], "HOST-INVALL")
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
