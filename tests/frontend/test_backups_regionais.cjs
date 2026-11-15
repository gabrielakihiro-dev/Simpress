// Resumo (F3), sub-aba Backups. Desde a migração React (Dia 2, G5) o painel vive em
// frontend/src/paineis/backups-regionais/ e o comportamento (estados, tabela, Confirmar/Desfazer, foco, toasts,
// "Atualizado em", mínimo no ⓘ, escape de HTML, apelido fora do console) é testado no navegador:
// tests/e2e/react-g5.spec.cjs e tests/e2e/backups-regionais.spec.cjs. Aqui ficam o registro, o módulo antigo (só o
// intervalo de 5 min, que não depende do bundle) e o HTML montado.
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

test("módulo antigo: não desenha nem ouve eventos; só pede o painel a cada 5 min com a aba visível", () => {
  const ouvintes = [];
  const intervalos = [];
  const pedidos = [];
  const original = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { setInterval: (...args) => intervalos.push(args) };
  globalThis.document = {
    hidden: false,
    addEventListener: (...args) => ouvintes.push(args),
    dispatchEvent: evento => pedidos.push(evento.type),
  };
  try {
    assert.deepEqual(createBackupsRegionais({}), {});
    assert.deepEqual(ouvintes, []);
    assert.equal(intervalos.length, 1);
    assert.equal(intervalos[0][1], 5 * 60 * 1000);
    globalThis.document.hidden = true;
    intervalos[0][0]();
    assert.deepEqual(pedidos, [], "aba escondida: não pede o painel");
    globalThis.document.hidden = false;
    intervalos[0][0]();
    assert.deepEqual(pedidos, ["simpress:atualizar-notificacoes"]);
  } finally {
    globalThis.window = original.window;
    globalThis.document = original.document;
  }
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
