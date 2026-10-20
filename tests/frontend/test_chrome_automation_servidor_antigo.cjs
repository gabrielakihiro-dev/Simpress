const assert = require("node:assert/strict");
const test = require("node:test");
const createChromeAutomation = require("../../static/js/features/chrome-automation.js");

function criar(apiFetch) {
  const toasts = [];
  const elemento = { setAttribute() {}, removeAttribute() {}, hidden: false, textContent: "", replaceChildren() {}, append() {}, appendChild() {}, disabled: false };
  global.document = { getElementById: () => elemento, querySelector: () => elemento, querySelectorAll: () => [], visibilityState: "visible" };
  global.window = { clearTimeout() {}, setTimeout: () => 0 };
  const app = { apiFetch, showToast: (mensagem, tipo) => toasts.push([mensagem, tipo]) };
  const dom = { createTextElement: () => elemento };
  return { feature: createChromeAutomation({ app, dom }), toasts };
}

function naoEncontrado() {
  const erro = new Error("Not Found");
  erro.status = 404;
  erro.detail = "Not Found";
  return erro;
}

test("404 em /api/automacao mostra um único aviso de servidor desatualizado", async t => {
  t.after(() => { delete global.document; delete global.window; });
  const { feature, toasts } = criar(async () => { throw naoEncontrado(); });
  await feature.iniciarRotinaAutomacao("os");
  await feature.iniciarRotinaAutomacao("os");
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][0], /^Servidor desatualizado: reinicie o Simpress/);
  assert.equal(toasts[0][1], "error");
  assert.ok(!toasts.some(([m]) => m === "Not Found"));
});

test("outros erros continuam exibindo a mensagem original", async t => {
  t.after(() => { delete global.document; delete global.window; });
  const erro = new Error("Rotina ocupada.");
  erro.status = 409;
  erro.detail = "Rotina ocupada.";
  const { feature, toasts } = criar(async () => { throw erro; });
  await feature.iniciarRotinaAutomacao("os");
  await feature.iniciarRotinaAutomacao("os");
  assert.deepEqual(toasts.map(([m]) => m), ["Rotina ocupada.", "Rotina ocupada."]);
});
