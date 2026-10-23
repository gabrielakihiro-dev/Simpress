"""Regressões no Chromium isolado, sem perfil do usuário ou acesso aos sistemas reais.

Executar: python -m unittest tests.browser_sebrae_excel -v
Requer Playwright e o Chromium de teste instalado. Não faz parte da descoberta sem navegador.
"""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from playwright.sync_api import sync_playwright
from scripts import sebrae_excel as xl


class ExcelBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.addCleanup(self.context.close)
        fixture = (Path(__file__).parent / "fixtures/sebrae_excel_browser.html").read_text(encoding="utf-8")
        def serve(route):
            if route.request.url == "https://dashboard.example/":
                route.fulfill(body='<title>Dashboard Operacional_SEBRAE.xlsx</title><iframe src="https://excel.example/frame" allow="clipboard-read; clipboard-write" style="width:100%;height:900px"></iframe>', content_type="text/html")
            elif route.request.url == "https://excel.example/frame":
                route.fulfill(body=fixture, content_type="text/html")
            else:
                route.abort()
        self.context.route("**/*", serve)
        self.context.grant_permissions(["clipboard-read", "clipboard-write"], origin="https://excel.example")
        self.page = self.context.new_page()
        self.page.goto("https://dashboard.example/")
        self.frame = self.page.frames[1]
        self.frame.locator(xl.Seletores.caixa_nome).wait_for()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.logs = []
        self.excel = xl.ExcelOnlinePlaywright(self.page, colunas_formula=(), diario=xl.DiarioGravacao(Path(self.temp.name)/"diario.json"), log=self.logs.append)

    def state(self):
        return self.frame.evaluate("() => ({filtered:fixture.filtered, view:fixture.view, events:fixture.events, writes:fixture.writes})")

    def test_home_is_not_the_selected_worksheet(self):
        self.excel.garantir_sessao()
        self.assertEqual(self.excel._aba_selecionada(), "CHAMADOS")

    def test_selects_worksheet_with_prefixed_accessible_name(self):
        self.frame.get_by_role("tab", name="Worksheet LISTAS", exact=True).click()
        self.excel.garantir_sessao()
        self.assertEqual(self.excel._aba_selecionada(), "CHAMADOS")

    def test_waits_for_selection_and_focus_before_next_key(self):
        self.excel._ir_para("C1:C5")
        self.assertEqual(self.frame.evaluate("() => fixture.selected"), "C1:C5")
        self.assertEqual(self.frame.evaluate("() => document.activeElement.id"), "gridKeyboardContentEditable_textElement")
        self.assertEqual(self.excel._ultima_linha_usada(), 5)

    def test_padroniza_e_confirma_altura_da_linha_sem_autofit(self):
        self.excel.padronizar_altura_linha(12)
        self.assertEqual(self.frame.evaluate("() => fixture.rowHeight"), 14.25)
        self.assertIn("height:14.25", self.state()["events"])
        self.assertTrue(self.frame.locator("#rowHeightDialog").is_hidden())

    def test_rejects_stale_formula_bar_when_hidden_cell_cannot_be_selected(self):
        with self.assertRaises(xl.ExcelErro):
            self.excel._ir_para("C3")
        self.assertEqual(self.state()["writes"], [])

    def test_menu_copy_works_in_cross_origin_frame(self):
        self.excel.garantir_sessao()
        self.excel._copiar_intervalo("C1:C5")
        self.assertIn("copy", self.state()["events"])
        self.assertTrue(any("faixa" in line for line in self.logs))

    def test_filtered_copy_restores_filter_before_discarding_temporary_view(self):
        leitura = self.excel._ler_validada()
        self.assertIn("UTIC-2026-0094", leitura.numeros)
        self.assertEqual(leitura.linhas_cobertas, 5)
        state = self.state()
        self.assertTrue(state["filtered"])
        self.assertEqual(state["view"], "Default")
        self.assertLess(state["events"].index("undo"), state["events"].index("exit"))
        self.assertFalse(self.excel._exibicao_temporaria_criada)
        self.assertEqual(state["writes"], [])

    def test_copy_failure_still_restores_original_view_and_filter(self):
        with patch.object(self.excel, "_copiar_coluna_c", side_effect=["CHAMADO\nUTIC-2026-0002\n", RuntimeError("cópia falhou")]):
            with self.assertRaisesRegex(RuntimeError, "cópia falhou"):
                self.excel.ler_coluna_c()
        self.assertEqual(self.state()["view"], "Default")
        self.assertTrue(self.state()["filtered"])

    def test_filtered_tail_is_not_ignored_when_visible_copy_looks_complete(self):
        with patch.object(self.excel, "_ultima_linha_usada", side_effect=[2, 5]), patch.object(
            self.excel, "_copiar_coluna_c", side_effect=["CHAMADO\nUTIC-2026-0002\n", "CHAMADO\nUTIC-2026-0002\nUTIC-2026-0094\n\nUTIC-2026-0005\n"]
        ):
            leitura = self.excel._ler_validada()
        self.assertIn("UTIC-2026-0005", leitura.numeros)
        self.assertIn("new", self.state()["events"])
        self.assertTrue(self.state()["filtered"])

    def test_failure_to_restore_filter_blocks_read_and_keeps_view_for_inspection(self):
        self.frame.evaluate("() => { fixture.failUndo = true; }")
        with patch.object(self.excel, "_copiar_coluna_c", side_effect=["CHAMADO\n", "CHAMADO\nA\nB\n\nC\n"]):
            with self.assertRaises(xl.FiltroNaoRestauradoErro):
                self.excel._ler_validada()
        self.assertTrue(self.excel._exibicao_temporaria_criada)
        self.assertEqual(self.state()["writes"], [])

    def test_does_not_replace_existing_personal_view(self):
        self.frame.evaluate("() => {fixture.view='Minha exibição'; document.querySelector('#NamedSheetViewSelect-input').value=fixture.view;}")
        with patch.object(self.excel, "_copiar_coluna_c", return_value="CHAMADO\n"):
            with self.assertRaisesRegex(xl.LeituraIncompletaErro, "exibição pessoal"):
                self.excel.ler_coluna_c()
        self.assertNotIn("new", self.state()["events"])

    def test_saved_status_uses_button_accessible_name_and_rejects_saving(self):
        status = self.frame.locator("#SaveStatusButton")
        for label in ("Saved Click the cloud icon", "Last saved: Just now", "Salvo"):
            status.evaluate("(e, label) => e.setAttribute('aria-label', label)", label)
            with patch.object(xl.time, "sleep"):
                self.assertTrue(self.excel.aguardar_salvo(1))
        status.evaluate("(e) => e.setAttribute('aria-label', 'Saving... Last saved: Just now')")
        with patch.object(xl.time, "sleep"):
            self.assertFalse(self.excel.aguardar_salvo(0.05))


if __name__ == "__main__":
    unittest.main(verbosity=2)
