const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const appHtml = fs.readFileSync(path.join(root, "static", "index.html"), "utf8");
const dataPanelsJs = fs.readFileSync(path.join(root, "static", "js", "ui", "data-panels.js"), "utf8");
const transferFormJs = fs.readFileSync(path.join(root, "static", "js", "features", "transfer-form.js"), "utf8");

test("Resumo tab sits right below Transporte in the navigation", () => {
  const transporte = appHtml.indexOf('id="tab-retirada-entrega"');
  const resumo = appHtml.indexOf('id="tab-resumo"');
  const nav = appHtml.indexOf('class="app-tabs sidebar-tabs"');
  const navEnd = appHtml.indexOf("</nav>", nav);
  assert.ok(transporte > nav && resumo > transporte && resumo < navEnd, "tab-resumo must follow tab-retirada-entrega inside the tab nav");
  assert.match(appHtml, /id="tab-resumo"[^>]*aria-controls="tab-panel-resumo"/);
  assert.match(appHtml, /id="tab-resumo"[^>]*data-args='\["resumo"\]'/);
});

test("Resumo panel keeps the inventory summary and removes the usage panel", () => {
  const transferPanel = appHtml.indexOf('id="tab-panel-retirada-entrega"');
  const resumoPanel = appHtml.indexOf('id="tab-panel-resumo"');
  const cards = appHtml.indexOf('id="resumo-cards"');
  const automacaoPanel = appHtml.indexOf('id="tab-panel-automacao"');

  assert.ok(resumoPanel > transferPanel, "Resumo panel must come after the Transporte panel");
  assert.ok(cards > resumoPanel && cards < automacaoPanel, "inventory summary stays inside the Resumo panel");
  assert.doesNotMatch(appHtml, /Uso nos últimos 30 dias|id="uso-30-dias"/);
  assert.match(appHtml.slice(resumoPanel, resumoPanel + 200), /hidden>/, "Resumo panel starts hidden");
});

test("panel scripts target the Resumo tab", () => {
  assert.doesNotMatch(dataPanelsJs, /getElementById\("ck-transp"\)|resumo-os-equipamento|transfer-serial/, "a tabela de OS não depende mais da aba Transporte");
  assert.match(dataPanelsJs, /function montarTabelaOs\(host, opcoes = \{\}\)/, "a tabela de OS é montada onde o host pedir (Chamados)");
  assert.match(appHtml, /id="cockpit-tickets-os"/);
  assert.doesNotMatch(appHtml, /resumo-os-equipamento/);
  assert.doesNotMatch(appHtml, /ck-parque|Resumo do parque/, "Resumo do parque panel is removed from the Resumo tab");
  assert.doesNotMatch(dataPanelsJs, /ux-home-panel/, "legacy parque panel is gone");
  assert.match(dataPanelsJs, /\["tab-home", "tab-resumo", "tab-retirada-entrega"\]/);
  assert.match(transferFormJs, /tab-resumo/);
  assert.match(transferFormJs, /alvo === "transferencia"/, "quick actions and serial summary belong to Transporte only");
});

test("opening a data tab retries the panel when it is not filled yet", () => {
  assert.doesNotMatch(dataPanelsJs, /parqueOk|renderParque/);
});

test("tablist label covers all tabs and the first Resumo card has no top gap", () => {
  assert.match(appHtml, /role="tablist" aria-label="Navegação principal"/);
  const css = fs.readFileSync(path.join(root, "static", "styles", "ux-refinements.css"), "utf8");
  assert.match(css, /#resumo-cards > :first-child \{ margin-top: 0; \}/);
});
