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

test("Resumo panel holds both cards and Home no longer does", () => {
  const homePanel = appHtml.indexOf('id="tab-panel-home"');
  const transferPanel = appHtml.indexOf('id="tab-panel-retirada-entrega"');
  const resumoPanel = appHtml.indexOf('id="tab-panel-resumo"');
  const cards = appHtml.indexOf('id="resumo-cards"');
  const usage = appHtml.indexOf('id="uso-30-dias"');

  assert.ok(resumoPanel > transferPanel, "Resumo panel must come after the Transporte panel");
  assert.ok(cards > resumoPanel && usage > cards, "usage card must be inside #resumo-cards in the Resumo panel");
  assert.ok(!(usage > homePanel && usage < transferPanel), "usage card must not remain inside the Home panel");
  assert.match(appHtml.slice(resumoPanel, resumoPanel + 200), /hidden>/, "Resumo panel starts hidden");
});

test("panel scripts target the Resumo tab", () => {
  assert.match(dataPanelsJs, /getElementById\("resumo-cards"\)/);
  assert.match(dataPanelsJs, /let panelExpanded = true;/, "Resumo do parque starts maximized");
  assert.match(dataPanelsJs, /\["tab-home", "tab-resumo"\]/);
  assert.match(transferFormJs, /tab-resumo/);
  assert.match(transferFormJs, /alvo === "transferencia"/, "quick actions and serial summary belong to Transporte only");
});

test("opening a data tab retries the panel when it is not filled yet", () => {
  assert.match(dataPanelsJs, /refresh\(!panel \|\| panel\.hidden\)/);
});

test("tablist label covers all tabs and the first Resumo card has no top gap", () => {
  assert.match(appHtml, /role="tablist" aria-label="Navegação principal"/);
  const css = fs.readFileSync(path.join(root, "static", "styles", "ux-refinements.css"), "utf8");
  assert.match(css, /#resumo-cards > :first-child \{ margin-top: 0; \}/);
});
