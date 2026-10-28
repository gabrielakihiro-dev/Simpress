const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "static/index.html"), "utf8");
const feature = fs.readFileSync(path.join(root, "static/js/features/chrome-automation.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "static/styles/ux-refinements.css"), "utf8");

test("Automação keeps its actions grouped and user verification manual", () => {
  const rotinas = html.match(/<div class="ck-rotinas"[\s\S]*?<\/div>\s*<div class="ck-cartao ck-linha-acao"/)?.[0] || html.match(/class="ck-rotinas"[\s\S]{0,4000}/)?.[0];
  const userGroup = html.match(/<section class="[^"]*ck-linha-acao[^"]*"[^>]*data-rotina="usuarios"[\s\S]*?<\/section>/)?.[0];
  assert.ok(rotinas);
  assert.ok(userGroup);
  for (const id of ["btn-automacao-os", "btn-automacao-inventarios", "btn-automacao-ambas"]) {
    assert.match(rotinas, new RegExp(`id="${id}"`));
  }
  assert.match(userGroup, /id="btn-automacao-usuarios"[\s\S]*?data-args='\["usuarios"\]'/);
  assert.doesNotMatch(rotinas.split('data-rotina="usuarios"')[0], /btn-automacao-usuarios/);
  assert.match(html, /id="btn-automacao-login"/);
  assert.match(html, /id="btn-automacao-cancelar"/);
});

test("Automação mostra o histórico e o console sem painéis recolhíveis", () => {
  assert.match(html, /id="automacao-andamento-painel"/);
  assert.match(html, /id="automacao-historico"/);
  assert.doesNotMatch(html, /Recolher Últimas execuções|Ampliar Andamento/);
  assert.doesNotMatch(feature, /recolherPainelAutomacao|ampliarPainelAutomacao/);
});

test("Os chamados novos do Sebrae ficam na área de Automação e o cartão antigo de sincronização saiu", () => {
  assert.match(html, /id="sebrae-novos-painel"/);
  assert.doesNotMatch(html, /id="sebrae-painel"/);
  assert.doesNotMatch(feature, /api\/automacao\/sebrae/);
});

test("Automation action layout keeps a responsive support group", () => {
  assert.match(styles, /\.automation-action-layout/);
  assert.match(styles, /\.automation-action-support/);
  assert.match(styles, /\.automation-action-independent/);
  assert.match(styles, /@media \(max-width: 40rem\)[\s\S]*?\.automation-action-support/);
});
