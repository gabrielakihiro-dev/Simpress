const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = assembledHtml();
const feature = fs.readFileSync(path.join(root, "static/js/features/chrome-automation.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "static/styles/ux-refinements.css"), "utf8");

test("Automação agrupa as quatro rotinas na grade, na ordem, e a verificação de usuários é manual", () => {
  const rotinas = html.match(/<div class="ck-rotinas"[\s\S]*?<\/section>/)?.[0];
  assert.ok(rotinas);
  assert.doesNotMatch(html, /ck-linha-acao/);
  const ids = ["os", "inventarios", "usuarios", "ambas"];
  const posicoes = ids.map(id => {
    assert.match(rotinas, new RegExp(`<article class="ck-cartao ck-rotina" data-rotina="${id}" data-estado="ocioso">`));
    const botao = rotinas.match(new RegExp(`<button[^>]*id="btn-automacao-${id}"[^>]*>`))?.[0];
    assert.ok(botao, `botão de ${id} dentro de .ck-rotinas`);
    assert.ok(botao.includes(`data-args='["${id}"]'`));
    assert.match(botao, /class="[^"]*ck-btn--icone[^"]*"/);
    assert.match(botao, /aria-label="Executar [^"]+"/);
    assert.match(rotinas, new RegExp(`id="btn-automacao-${id}"[^>]*>[\\s\\S]*?<span class="ck-sr">Executar</span>`));
    return rotinas.indexOf(`id="btn-automacao-${id}"`);
  });
  assert.deepEqual(posicoes, [...posicoes].sort((x, y) => x - y));
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
