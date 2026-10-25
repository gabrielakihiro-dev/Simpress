const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "static/index.html"), "utf8");
const feature = fs.readFileSync(path.join(root, "static/js/features/chrome-automation.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "static/styles/ux-refinements.css"), "utf8");

test("Automação keeps its actions grouped and user verification manual", () => {
  const mainGroup = html.match(/<div class="automation-actions automation-actions--primary"[\s\S]*?<\/div>/)?.[0];
  const userGroup = html.match(/<div class="automation-action-independent"[\s\S]*?<\/div>/)?.[0];
  const utilityGroup = html.match(/<div class="automation-actions automation-actions--utility"[\s\S]*?<\/div>/)?.[0];
  assert.ok(mainGroup);
  assert.ok(userGroup);
  assert.ok(utilityGroup);
  for (const id of ["btn-automacao-os", "btn-automacao-inventarios", "btn-automacao-ambas"]) {
    assert.match(mainGroup, new RegExp(`id="${id}"`));
  }
  assert.match(userGroup, /id="btn-automacao-usuarios"[\s\S]*?data-args='\["usuarios"\]'/);
  assert.doesNotMatch(mainGroup, /btn-automacao-usuarios/);
  assert.match(utilityGroup, /id="btn-automacao-login"/);
  assert.match(html, /id="btn-automacao-cancelar"/);
  assert.match(userGroup, /role="group" aria-label="Verificação manual de usuários"/);
});

test("Automação starts with Andamento and Últimas execuções available", () => {
  assert.match(html, /id="automacao-andamento-conteudo"(?![^>]*\bhidden\b)/);
  assert.match(html, /id="automacao-historico-conteudo"(?![^>]*\bhidden\b)/);
  assert.match(html, /aria-expanded="true" aria-controls="automacao-historico-conteudo" aria-label="Recolher Últimas execuções"/);
});

test("A sincronização Sebrae continua disponível na área de Automação", () => {
  assert.match(html, /<details class="cockpit-sebrae-details">[\s\S]*?id="sebrae-painel"/);
  assert.match(html, /Sincronizar chamados Sebrae/);
  assert.match(feature, /\/api\/automacao\/sebrae\/resumo/);
  assert.match(feature, /\/api\/automacao\/sebrae\/agendamento/);
});

test("Automation action layout keeps a responsive support group", () => {
  assert.match(styles, /\.automation-action-layout/);
  assert.match(styles, /\.automation-action-support/);
  assert.match(styles, /\.automation-action-independent/);
  assert.match(styles, /@media \(max-width: 40rem\)[\s\S]*?\.automation-action-support/);
});
