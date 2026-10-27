const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { appSource } = require("./support/app-sources.cjs");

const appScript = appSource();
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "..", "static", "index.html"), "utf8");
const appEntry = fs.readFileSync(path.join(__dirname, "..", "..", "static", "app-entry.js"), "utf8");
const appCss = fs.readFileSync(path.join(__dirname, "..", "..", "static", "app.css"), "utf8");

test("explains that history annotations belong to one row in one update", () => {
  assert.match(appScript, /As anotações continuam vinculadas a esta linha e atualização/);
  assert.match(appScript, /são reaplicadas somente quando os dados correspondem exatamente na mesma seção/);
});

test("shows synchronized annotations on a clone without local comparison history", () => {
  assert.match(appScript, /somente_anotacoes_sincronizadas/);
  assert.match(appScript, /Consultar anotações/);
  assert.match(appScript, /Este clone contém as anotações sincronizadas/);
});

test("distinguishes annotations with an empty serial by hostname", () => {
  assert.ok(appScript.includes('`o hostname ${item.computador}, série ` : "a série "'));
  assert.ok(appScript.includes('item.serie || "vazia"'));
});

test("renders an annotation column in every requested comparison section", () => {
  assert.match(appScript, /const renderizarCampoAnotacao = \(item, contexto\)/);
  assert.match(appScript, /"Linha no endpoint", \.\.\.annotationHeaders/);
  assert.match(appScript, /"Sem correspondência em", \.\.\.annotationHeaders/);
  assert.match(appScript, /"Local na Simpress", \.\.\.annotationHeaders/);
  assert.match(appScript, /"Tratamento", \.\.\.annotationHeaders/);
  assert.match(appScript, /"Exemplos", \.\.\.annotationHeaders/);
  assert.match(appScript, /anotacoes_sincronizadas/);
});

test("loads the bounded autosave retry helper before the application", () => {
  const catalogScript = appEntry.indexOf('./js/shared/catalog-search-utils.js');
  const draftGuardScript = appEntry.indexOf('./js/shared/form-draft-guard.js');
  const retryScript = appEntry.indexOf('./js/shared/history-annotation-autosave.js');
  const appScriptTag = appEntry.indexOf('./app.js');
  assert.notEqual(catalogScript, -1);
  assert.notEqual(draftGuardScript, -1);
  assert.notEqual(retryScript, -1);
  assert.ok(catalogScript < appScriptTag);
  assert.ok(draftGuardScript < appScriptTag);
  assert.ok(retryScript < appScriptTag);
  assert.match(appScript, /attachAnnotationAutosave/);
  assert.match(appScript, /Tentar sincronizar novamente/);
  assert.match(appScript, /data-annotation-retry hidden/);
  assert.doesNotMatch(appScript, /class="hidden[^\"]*"[^>]*data-annotation-retry/);
});

test("mobile header summary rule overrides the header's accessible summary display rule", () => {
  assert.match(
    appCss,
    /@media \(max-width: 640px\)[\s\S]*?\.header-inner > \.header-base-summary\s*\{\s*display:\s*none;/,
  );
  assert.match(
    appCss,
    /@media \(max-width: 900px\) and \(max-height: 500px\)[\s\S]*?\.header-inner > \.header-base-summary\s*\{\s*display:\s*none;/,
  );
});

test("keeps the sidebar action groups neutral", () => {
  assert.doesNotMatch(appCss, /header-action-group\[data-action-group="(analysis|equipment)"\] > summary/);
});

test("places the ticket action in cockpit tools dropdown without legacy sidebar classes", () => {
  assert.doesNotMatch(indexHtml, /header-action-group|header-action-item--large|data-action-group="analysis"/);
  assert.match(indexHtml, /<details class="ck-ancora cockpit-tools-dropdown" id="cockpit-tools-dropdown">/);
  const ticketId = indexHtml.indexOf('id="btn-acompanhamento-chamados"');
  assert.ok(ticketId > -1);
  const ticketButton = indexHtml.lastIndexOf("<button", ticketId);
  const ticketActionEnd = indexHtml.indexOf("</button>", ticketId);
  const ticketMarkup = indexHtml.slice(ticketButton, ticketActionEnd);
  assert.match(ticketMarkup, /ck-aba ck-aba--painel/);
  assert.match(ticketMarkup, /data-on-click="abrirPainelCockpit"/);
  assert.match(ticketMarkup, /data-args='\["chamados"\]'/);
  assert.match(ticketMarkup, /title="Chamados \(F5\)"/);
  assert.doesNotMatch(ticketMarkup, /--orange|<br>/);
});
