const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appScript = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");

test("explains that history annotations belong to one row in one update", () => {
  assert.match(appScript, /As anotações pertencem a esta linha desta atualização/);
  assert.match(appScript, /não são reaproveitadas em novas atualizações/);
  assert.match(appScript, /são salvas automaticamente/);
});

test("shows synchronized annotations on a clone without local comparison history", () => {
  assert.match(appScript, /somente_anotacoes_sincronizadas/);
  assert.match(appScript, /Consultar anotações/);
  assert.match(appScript, /Este clone contém as anotações sincronizadas/);
});

test("loads the bounded autosave retry helper before the application", () => {
  const retryScript = indexHtml.indexOf("/static/history-annotation-autosave.js");
  const appScriptTag = indexHtml.indexOf("/static/app.js");
  assert.notEqual(retryScript, -1);
  assert.ok(retryScript < appScriptTag);
  assert.match(appScript, /requestWithRetries/);
  assert.match(appScript, /Tentando salvar novamente/);
});
