"""Focused regression checks for low-severity audit findings."""

import io
import unittest

from core import config as app_config
import main
import openpyxl


class LowAuditFindingTests(unittest.TestCase):
    def test_mobile_does_not_autofocus_serial_input(self):
        script = (app_config.STATIC_DIR / "app.js").read_text(encoding="utf-8")

        self.assertIn('window.matchMedia("(hover: hover) and (pointer: fine)").matches', script)
        self.assertNotIn("// Focus serial input immediately", script)
        self.assertNotRegex(script, r"if \(inputSerial\) inputSerial\.focus\(\)")

    def test_statistics_start_unconfirmed_and_reject_missing_or_invalid_counts(self):
        html = (app_config.STATIC_DIR / "index.html").read_text(encoding="utf-8")
        script = (app_config.STATIC_DIR / "app.js").read_text(encoding="utf-8")

        self.assertIn('id="stat-equipamentos">Carregando…</strong>', html)
        self.assertIn('id="stat-unidades">Carregando…</strong>', html)
        self.assertNotIn('id="stat-equipamentos">1.364</strong>', html)
        self.assertIn("Number.isSafeInteger(count)", script)
        self.assertIn('definirEstatistica("stat-equipamentos", null)', script)
        self.assertIn('definirEstatistica("stat-unidades", null)', script)

    def test_comparison_diagnostics_keep_original_excel_rows_after_blank_rows(self):
        workbook = openpyxl.Workbook()
        worksheet = workbook.active
        worksheet.title = "EquipamentosDetalhes"
        worksheet.append(["NumeroSerie", "Apelido", "Modelo", "Cidade"])
        worksheet.append(["SN-1", "PRNOTE-1", "Modelo 1", "Maringá"])
        worksheet.append([None, None, None, None])
        worksheet.append(["SN-2", "PRNOTE-2", "Modelo 2", "Curitiba"])
        output = io.BytesIO()
        workbook.save(output)
        workbook.close()

        table = main.read_workbook_tables(output.getvalue())[0]
        rows = main._comparison_source_records(table, "detalhes")

        self.assertEqual([row["row_number"] for row in rows], [2, 4])
