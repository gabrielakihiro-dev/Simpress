const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appScript = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");

test("explains that history annotations belong to one row in one update", () => {
  assert.match(appScript, /As anotações pertencem a esta linha desta atualização/);
  assert.match(appScript, /não são reaproveitadas em novas atualizações/);
  assert.match(appScript, /são salvas automaticamente/);
});
