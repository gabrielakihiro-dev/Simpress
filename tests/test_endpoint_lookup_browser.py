"""Exercise the real Endpoint grid reader/filter against synthetic browser DOM."""
import unittest
import importlib.util
from types import SimpleNamespace

from domains.endpoint_lookup import consultar_grade
from scripts import verificar_usuarios_endpoint as grid


HTML = """<!doctype html><html><head><style>
.ember-table-table-row { display:flex } .ember-table-cell,.ember-table-header-cell { width:220px; flex:none }
</style></head><body>
<div class="ember-table-header-row ember-table-table-row">
<div class="ember-table-header-cell">Rótulo de serviço/Número de série</div>
<div class="ember-table-header-cell">Usuários logados</div>
<div class="ember-table-header-cell">Usuário do último logon</div></div>
<div style="display:flex"><input class="search-text-box" style="width:212px"><input class="search-text-box" style="width:212px"><input class="search-text-box" style="width:212px"></div>
<div id="rows"></div><p id="count"></p>
<input type="radio" name="view" value="InvAllComputersSummary" checked>
<script>
let records=[];
function render() {
 const value=document.querySelector('input').value.toLowerCase();
 const filtered=records.filter(r=>r[0].toLowerCase().includes(value));
 document.querySelector('#rows').replaceChildren(...filtered.map(record=>{
   const row=document.createElement('div'); row.className='ember-table-table-row';
   record.forEach(value=>{const cell=document.createElement('div');cell.className='ember-table-cell';cell.textContent=value;row.append(cell)});return row;
 }));
 document.querySelector('#count').textContent=filtered.length ? `1 - ${filtered.length} de ${filtered.length}` : 'Nenhum dado disponível';
}
document.querySelector('input').addEventListener('keydown', event=>{if(event.key==='Enter')render()});
</script></body></html>"""


@unittest.skipUnless(importlib.util.find_spec("playwright") is not None, "playwright não está instalado")
class BrowserLookupTests(unittest.TestCase):
    def test_real_grid_filter_exact_missing_duplicate_and_blank(self):
        from playwright.sync_api import sync_playwright
        automation = SimpleNamespace(
            verificar_cancelamento=lambda: None, log=lambda *args: None, RotinaErro=RuntimeError,
            EtapaInstavel=RuntimeError, etapa_resiliente=lambda etapa, descricao, **kwargs: etapa(),
            definir_pagina_ativa_para_recuperacao=lambda pagina: None, aguardar_estado=lambda *a, **k: None,
        )
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as exc:
                self.skipTest(f"Chromium do Playwright indisponível: {str(exc)[:120]}")
            try:
                page = browser.new_page(viewport={"width": 1100, "height": 700})
                page.set_content(HTML)
                cases = [
                    ([("ABC", "wrong", "last"), ("ABCD", "other", "other")], "found", "last"),
                    ([("ABC", "wrong", "")], "found", ""),
                    ([("ABC", "a", "x"), ("ABC", "b", "y")], "ambiguous", None),
                    ([("OTHER", "a", "x")], "not_found", None),
                ]
                for records, status, user in cases:
                    with self.subTest(status=status, user=user):
                        page.evaluate("items => {records=items; document.querySelector('input').value=''; render()}", records)
                        result = consultar_grade(page, automation, "ABC", False)
                        self.assertEqual(result["status"], status)
                        if user is not None:
                            self.assertEqual(result["ultimo_logon"], user)
                page.evaluate("document.querySelector('#count').textContent='1 - 1 de 2'")
                self.assertEqual(grid.ler_grade(page)["total"], 2)
            finally:
                browser.close()
