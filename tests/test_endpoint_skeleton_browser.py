"""Seleção de "Todos os computadores" do Endpoint contra uma página local com tela de esqueleto.

Usa o Chromium do Playwright, sem Chrome de automação nem login; é pulado se o navegador não existir.
"""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import automacao_rotinas_chrome as automacao

PLAYWRIGHT_AVAILABLE = importlib.util.find_spec("playwright") is not None

# O rádio existe, mas fica oculto (esqueleto) por 3 s; depois fica clicável e o rótulo ativo.
PAGINA = """<!doctype html><html><body>
<label id="rotulo"><input type="radio" name="vista" value="InvAllComputersSummary" style="display:none"> Todos os computadores</label>
<script>
setTimeout(() => {
  const r = document.querySelector('input[value=InvAllComputersSummary]');
  r.style.display = '';
  r.addEventListener('change', () => document.getElementById('rotulo').classList.add('ativo'));
}, 3000);
</script></body></html>"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "playwright não está instalado")
class SelecionarTodosComputadoresTests(unittest.TestCase):
    def test_marca_o_radio_depois_que_o_esqueleto_some(self):
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                self.skipTest(f"Chromium do Playwright indisponível (rode 'playwright install chromium'): {str(exc)[:120]}")
            try:
                with tempfile.TemporaryDirectory(prefix=".endpoint-esqueleto-") as tmp:
                    html = Path(tmp) / "endpoint.html"
                    html.write_text(PAGINA, encoding="utf-8")
                    page = browser.new_page()
                    page.goto(html.as_uri())
                    with patch.object(automacao, "verificar_cancelamento"):
                        automacao.selecionar_todos_computadores(page)
                    self.assertTrue(page.locator('input[value="InvAllComputersSummary"]').is_checked())
                    self.assertIn("ativo", page.locator("#rotulo").get_attribute("class") or "")
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
