const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appScript = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const appCss = fs.readFileSync(path.join(__dirname, "..", "static", "app.css"), "utf8");

test("explains that history annotations belong to one row in one update", () => {
  assert.match(appScript, /As anotações continuam vinculadas a esta linha e atualização/);
  assert.match(appScript, /são reaplicadas somente quando os dados correspondem exatamente na mesma seção/);
  assert.match(appScript, /São salvas automaticamente/);
  assert.match(appScript, /sincronizadas pela pasta OneDrive/);
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
  const catalogScript = indexHtml.indexOf("/static/catalog-search-utils.js");
  const draftGuardScript = indexHtml.indexOf("/static/form-draft-guard.js");
  const retryScript = indexHtml.indexOf("/static/history-annotation-autosave.js");
  const appScriptTag = indexHtml.indexOf("/static/app.js");
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
    /@media \(max-width: 640px\)[\s\S]*?\.header-inner > \.header-base-summary\s*\{\s*display:\s*none\s*!important;/,
  );
  assert.match(
    appCss,
    /@media \(max-width: 900px\) and \(max-height: 500px\)[\s\S]*?\.header-inner > \.header-base-summary\s*\{\s*display:\s*none\s*!important;/,
  );
});
