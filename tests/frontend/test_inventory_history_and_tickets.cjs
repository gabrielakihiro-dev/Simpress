const test = require("node:test");
const {
  assert,
  appScript,
  appHtml,
} = require("./support/inventory-harness.cjs");

test("filters comparison history while preserving row-level annotation autosave", () => {
  assert.doesNotMatch(appHtml, /id="modal-central-pendencias"/);
  assert.match(appScript, /data-history-filter-search/);
  assert.match(appScript, /data-history-filter-category/);
  assert.match(appScript, /data-history-filter-annotated/);
  assert.match(appScript, /history-row-annotated/);
  assert.match(appScript, /\/anotacoes\/\$\{encodeURIComponent\(targetItemId\)\}/);
});

test("Chamados keeps the Oracle and Simpress shortcuts and has no standalone tracking modal", () => {
  assert.doesNotMatch(appHtml, /modal-acompanhamento-chamados|lista-acompanhamento-chamados|abrirAcompanhamentoChamados/);
  assert.match(appHtml, /href="https:\/\/simpress\.custhelp\.com\/AgentWeb\/" target="_blank" rel="noopener noreferrer"[^>]*aria-label="Abrir portal Oracle AgentWeb"/);
  assert.match(appHtml, /href="https:\/\/ux\.simpress\.com\.br\/equipamentos\/acompanhamento" target="_blank" rel="noopener noreferrer"[^>]*aria-label="Abrir acompanhamento de chamados Simpress"/);
  // Os dois atalhos existem só no bloco "Importação e versões" do painel Chamados.
  assert.equal((appHtml.match(/class="ckp-sistema"[^>]*aria-label="Abrir (portal Oracle|acompanhamento de chamados)/g) || []).length, 2);
  assert.match(appHtml, /id="cockpit-tickets-os"/);
  assert.match(appHtml, /id="cockpit-tickets-evolution"/);
  assert.match(appHtml, /id="cockpit-tickets-version"/);
  assert.match(appScript, /\/api\/operacoes\/chamados\/evolucao\?/);
});

test("provides Endpoint and Simpress shortcuts in the spreadsheet update dialog", () => {
  assert.match(appHtml, /id="modal-atualizar-planilhas"/);
  assert.ok(appHtml.includes('href="https://centralendpoint.pr.sebrae.com.br/webclient#/uems/inventory/computers" target="_blank" rel="noopener noreferrer"'));
  assert.ok(appHtml.includes('href="https://ux.simpress.com.br/MeusEquipamentos/Index" target="_blank" rel="noopener noreferrer"'));
  assert.match(appHtml, /class="ckp-sistema"[^>]*aria-label="Abrir inventário de computadores do Endpoint Central"/);
  assert.match(appHtml, /class="ckp-sistema"[^>]*aria-label="Abrir Meus Equipamentos da Simpress"/);
  assert.equal((appHtml.match(/class="ckp-sistema"[^>]*aria-label="Abrir (inventário de computadores|Meus Equipamentos)/g) || []).length, 2);
});

test("groups secondary actions under cockpit tools dropdown", () => {
  assert.doesNotMatch(appHtml, /header-action-item--primary|sidebar-related-links|header-action-group/);
  assert.match(appHtml, /<details class="ck-ancora cockpit-tools-dropdown" id="cockpit-tools-dropdown">/);
  assert.match(appHtml, /<button(?=[^>]*data-on-click="abrirPainelCockpit")(?=[^>]*data-args='\["chamados"\]')[^>]*id="btn-acompanhamento-chamados"/);
  assert.match(appHtml, /<button(?=[^>]*data-on-click="abrirPainelCockpit")(?=[^>]*data-args='\["apelidos"\]')[^>]*id="btn-historico-apelidos"/);
  assert.match(appHtml, /<button(?=[^>]*data-on-click="abrirPainelCockpit")(?=[^>]*data-args='\["relatorio"\]')[^>]*id="btn-relatorio-mensal"/);
  assert.match(appHtml, /data-on-click="abrirModalAtualizarPlanilhas"/);
  assert.match(appHtml, /id="cockpit-comparison-legacy"/); // abre o modal do histórico (listener em cockpit-tool-panels.js)
  // 31/10/2026: a tela "Evolução das atualizações" saiu; o alerta "Ver evolução" da Home abre Comparações.
  assert.doesNotMatch(appHtml, /btn-evolucao-atualizacoes|modal-evolucao-atualizacoes|data-cockpit-tool-panel="evolucao"/);
  assert.match(appHtml, /<button(?=[^>]*id="btn-alerta-divergencias-novas")(?=[^>]*data-on-click="abrirPainelCockpit")(?=[^>]*data-args='\["comparacao"\]')[^>]*>/);
  assert.doesNotMatch(appScript, /\/api\/operacoes\/evolucao\?/);
  assert.doesNotMatch(appHtml, /id="btn-relatorio-mensal"[^>]*data-on-click="abrirRelatorioMensal"/);
  // 31/10/2026: o modal "Gerenciar unidades" e o "Fluxo completo" saíram; o painel do catálogo traz o formulário.
  assert.doesNotMatch(appHtml, /modal-gerenciar-unidades|cockpit-units-legacy|cockpit-units-edit/);
  assert.match(appHtml, /id="cockpit-units-new"[^>]*data-on-click="toggleFormNovaUnidade"/);
  assert.equal((appHtml.match(/id="form-unidade-titulo"/g) || []).length, 1);
  assert.equal((appHtml.match(/id="btn-salvar-unidade"/g) || []).length, 1);
  assert.doesNotMatch(appHtml, /id="badge-total-historico-comparacoes"/);
  assert.match(appHtml, /id="total-historico-comparacoes"/);
  assert.doesNotMatch(appHtml, /Acompanhamento de transportes/);
  assert.doesNotMatch(appScript, /\/api\/transferencias/);
});
