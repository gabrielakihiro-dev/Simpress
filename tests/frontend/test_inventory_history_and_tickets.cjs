const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  assert,
  appScript,
  appHtml,
} = require("./support/inventory-harness.cjs");

// "Importação e versões" é desenhada pelo React desde o G8: atalhos, IDs e a rota da comparação ficam no painel.
const pastaChamados = path.resolve(__dirname, "../../frontend/src/paineis/cockpit-chamados");
const painelChamados = fs.readFileSync(path.join(pastaChamados, "painel.tsx"), "utf8");
const estadoChamados = fs.readFileSync(path.join(pastaChamados, "estado.ts"), "utf8");
// O resultado da Comparação (filtros do Histórico e autosave das anotações) vive no painel React desde o BF3.
const estadoComparacao = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/paineis/resultado-comparacao/estado.ts"), "utf8");
// O markup dos filtros do Histórico é do renderizador TS desde o react-final-b.
const renderizadorComparacao = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/paineis/resultado-comparacao/renderizador.ts"), "utf8");

test("filters comparison history while preserving row-level annotation autosave", () => {
  assert.doesNotMatch(appHtml, /id="modal-central-pendencias"/);
  assert.match(renderizadorComparacao, /data-history-filter-search/);
  assert.match(renderizadorComparacao, /data-history-filter-category/);
  assert.match(renderizadorComparacao, /data-history-filter-annotated/);
  assert.match(estadoComparacao, /history-row-annotated/);
  assert.match(estadoComparacao, /\/anotacoes\/\$\{encodeURIComponent\(itemId\)\}/);
});

test("Chamados keeps the Oracle and Simpress shortcuts and has no standalone tracking modal", () => {
  assert.doesNotMatch(appHtml, /modal-acompanhamento-chamados|lista-acompanhamento-chamados|abrirAcompanhamentoChamados/);
  assert.match(painelChamados, /href="https:\/\/simpress\.custhelp\.com\/AgentWeb\/" target="_blank" rel="noopener noreferrer" aria-label="Abrir portal Oracle AgentWeb"/);
  assert.match(painelChamados, /href="https:\/\/ux\.simpress\.com\.br\/equipamentos\/acompanhamento" target="_blank" rel="noopener noreferrer" aria-label="Abrir acompanhamento de chamados Simpress"/);
  // Os dois atalhos existem só no bloco "Importação e versões" do painel Chamados.
  assert.equal((painelChamados.match(/className="ckp-sistema"[^>]*aria-label="Abrir (portal Oracle|acompanhamento de chamados)/g) || []).length, 2);
  assert.doesNotMatch(appHtml, /aria-label="Abrir (portal Oracle AgentWeb|acompanhamento de chamados Simpress)"/);
  assert.match(painelChamados, /<nav className="ckp-sistemas" aria-label="Abrir sistemas">/);
  assert.match(appHtml, /id="cockpit-tickets-os"/);
  assert.doesNotMatch(painelChamados, /id="cockpit-tickets-evolution"/, "o acordeão de comparação saiu da aba OS");
  assert.match(painelChamados, /id="cockpit-tickets-version"/);
  assert.doesNotMatch(estadoChamados, /\/api\/operacoes\/chamados\/evolucao\?/, "sem acordeão, a aba não busca mais a comparação");
});

test("provides Endpoint and Simpress shortcuts in the spreadsheet update dialog", () => {
  assert.match(appHtml, /id="modal-atualizar-planilhas"/);
  // /api/* exige o X-Simpress-Sessao: o link não aponta para a API; o clique pede a URL (comum/links-endpoint.ts).
  assert.ok(appHtml.includes('<a class="ckp-sistema" href="#" data-endpoint-tela="computadores" aria-label="Abrir inventário de computadores do Endpoint Central">'));
  assert.doesNotMatch(appHtml, /href="\/api\//);
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
  assert.match(appHtml, /<button(?=[^>]*id="btn-alerta-divergencias-novas")(?=[^>]*data-on-click="abrirPainelCockpit")(?=[^>]*data-args='\["comparacao","divergencias"\]')[^>]*>/);
  assert.doesNotMatch(appScript, /\/api\/operacoes\/evolucao\?/);
  assert.doesNotMatch(appHtml, /id="btn-relatorio-mensal"[^>]*data-on-click="abrirRelatorioMensal"/);
  // 31/10/2026: o modal "Gerenciar unidades" e o "Fluxo completo" saíram; o painel do catálogo traz o formulário.
  assert.doesNotMatch(appHtml, /modal-gerenciar-unidades|cockpit-units-legacy|cockpit-units-edit/);
  // 15/11/2026: o conteúdo do painel é React (frontend/src/paineis/unidades/corpo.tsx, checado em test_cockpit_tool_panels.cjs).
  assert.match(appHtml, /data-cockpit-tool-panel="unidades"[^>]*data-react-painel="unidades"/);
  assert.doesNotMatch(appHtml, /id="badge-total-historico-comparacoes"/);
  assert.match(appHtml, /id="total-historico-comparacoes"/);
  assert.doesNotMatch(appHtml, /Acompanhamento de transportes/);
  assert.doesNotMatch(appScript, /\/api\/transferencias/);
});
