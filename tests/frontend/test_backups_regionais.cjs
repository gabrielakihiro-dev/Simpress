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
const createBackupsRegionais = require("../../frontend/src/aplicacao/registro.ts").fabricas.backupsRegionais;

const root = path.resolve(__dirname, "../..");
const appSource = fs.readFileSync(path.join(root, "frontend/src/aplicacao/app.ts"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "frontend/src/arranque/entrada.ts"), "utf8");

test("registro: módulo importado no arranque, publicado no FEATURE_ORDER e painel React presente", () => {
  assert.match(entrySource, /import "\.\.\/aplicacao\/registro\.ts";/);
  assert.equal(typeof require("../../frontend/src/aplicacao/registro.ts").fabricas.backupsRegionais, "function");
  assert.match(appSource, /"backupsRegionais",/);
  assert.ok(fs.existsSync(path.join(root, "frontend/src/paineis/backups-regionais/montar.tsx")));
});

test("módulo antigo: não desenha; guarda o último painel para o React e pede o painel a cada 5 min com a aba visível", async () => {
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
    const repetidos = [];
    const contexto = { ponteReact: (painel, nomes) => ({ repetirPainel: ultimo => { repetidos.push([painel, nomes, ultimo]); return Promise.resolve(); } }) };
    assert.deepEqual(createBackupsRegionais(contexto), {});
    assert.deepEqual(ouvintes.map(([tipo]) => tipo), ["simpress:painel-atualizado", "simpress:painel-indisponivel"]);
    assert.equal(repetidos.length, 1);
    const [painel, nomes, ultimo] = repetidos[0];
    assert.deepEqual([painel, nomes], ["backups-regionais", ["repetirPainel"]]);
    ouvintes[0][1]({ detail: { backups_regionais: null } });
    ouvintes[1][1]();
    assert.deepEqual(ultimo, { painel: { backups_regionais: null }, indisponivel: true }, "a ponte entrega o mesmo objeto, sempre com o último evento");
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
