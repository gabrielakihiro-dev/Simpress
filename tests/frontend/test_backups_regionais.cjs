// Resumo (F3), sub-aba Backups. Desde a migração React (Dia 2, G5) o painel vive em
// frontend/src/paineis/backups-regionais/ e o comportamento (estados, tabela, Confirmar/Desfazer, foco, toasts,
// "Atualizado em", mínimo no ⓘ, intervalo de 5 min, escape de HTML, apelido fora do console) é testado no navegador:
// tests/e2e/react-g5.spec.cjs e tests/e2e/backups-regionais.spec.cjs. Aqui ficam o registro, o módulo antigo vazio e
// o HTML montado.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");
const createBackupsRegionais = require("../../static/js/features/backups-regionais.js");

const root = path.resolve(__dirname, "../..");
const appSource = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "static/app-entry.js"), "utf8");

test("registro: módulo importado no app-entry, publicado no FEATURE_ORDER e painel React presente", () => {
  assert.match(entrySource, /import "\.\/js\/features\/backups-regionais\.js";/);
  assert.match(appSource, /"backupsRegionais",/);
  assert.ok(fs.existsSync(path.join(root, "frontend/src/paineis/backups-regionais/montar.tsx")));
});

test("módulo antigo vazio: não desenha, não ouve eventos e não cria intervalo", () => {
  const ouvintes = [];
  const intervalos = [];
  const original = { document: globalThis.document, setInterval: globalThis.setInterval };
  globalThis.document = { addEventListener: (...args) => ouvintes.push(args) };
  globalThis.setInterval = (...args) => intervalos.push(args);
  try {
    assert.deepEqual(createBackupsRegionais({}), {});
  } finally {
    globalThis.document = original.document;
    globalThis.setInterval = original.setInterval;
  }
  assert.deepEqual(ouvintes, []);
  assert.deepEqual(intervalos, []);
});

test("index.html: painel Backups vazio, com data-react-painel e os atributos de sub-aba de antes", () => {
  const painel = assembledHtml().match(/<div role="tabpanel" id="resumo-painel-backups"[^>]*><\/div>/);
  assert.ok(painel, "o painel fica vazio no HTML: o React desenha dentro dele");
  assert.match(painel[0], /class="ck-comparacao-resultado ck-backups"/);
  assert.match(painel[0], /aria-labelledby="resumo-aba-backups"/);
  assert.match(painel[0], /data-resumo-painel="backups"/);
  assert.match(painel[0], /data-react-painel="backups-regionais"/);
  assert.match(painel[0], / hidden>/);
});
