const test = require("node:test");
const { assert, createAppHarness, apiResponse } = require("./support/inventory-harness.cjs");

test("Home discards a prepared UX session after the selected equipment changes", async () => {
  const calls = [];
  let resolvePrepare;
  const harness = createAppHarness((url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    if (url.endsWith("/preparar")) return new Promise(resolve => { resolvePrepare = resolve; });
    return Promise.resolve(apiResponse({ status: "cancelado" }));
  });
  harness.run(`abrirModalAcessivel = () => {};
    fecharModalAcessivel = () => {};
    SimpressApp.state.currentEquipamento = { serial: "S1" };`);
  harness.element("btn-copiar-chamado-atual").dataset.args = '["texto-chamado-teclado-mouse"]';
  harness.element("texto-chamado-teclado-mouse").value = "O teclado apresenta defeito.";
  const preparation = harness.run("abrirChamadoUX()");
  harness.run("definirEquipamentoAtual({ serial: 'S2' })");
  resolvePrepare(apiResponse({ status: "preparado", serial: "S1", session_id: "opaque", modelo: "X", opcoes: ["Teclado"] }));
  await preparation;
  assert.deepEqual(calls, [
    ["/api/ux/abrir-chamado/preparar", { serial: "S1", conferido: false }],
    ["/api/ux/abrir-chamado/cancelar", { session_id: "opaque" }],
  ]);
  assert.equal(harness.element("ux-chamado-problema").children.length, 0);
});

test("Home sends the active ticket text only with an explicit final confirmation", async () => {
  const calls = [];
  const harness = createAppHarness((url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return Promise.resolve(apiResponse(url.endsWith("/preparar")
      ? { status: "preparado", serial: "S1", session_id: "opaque", modelo: "X", opcoes: ["Teclado"] }
      : { status: calls.at(-1)[1].enviar ? "enviado" : "preenchido", os: "12345" }));
  });
  harness.run(`abrirModalAcessivel = () => {};
    fecharModalAcessivel = () => {};
    showToast = () => {};
    confirmarAcao = async () => true;
    SimpressApp.state.currentEquipamento = { serial: "S1" };`);
  harness.element("btn-copiar-chamado-atual").dataset.args = '["texto-chamado-teclado-mouse"]';
  harness.element("texto-chamado-teclado-mouse").value = "O teclado apresenta defeito.";
  await harness.run("abrirChamadoUX()");
  harness.element("ux-chamado-problema").value = "Teclado";
  await harness.run("executarChamadoUX(false)");
  await harness.run("executarChamadoUX(true)");
  assert.deepEqual(calls.slice(1), [
    ["/api/ux/abrir-chamado/enviar", { session_id: "opaque", serial: "S1", problema: "Teclado", descricao: "O teclado apresenta defeito.", enviar: false, confirmado: false }],
    ["/api/ux/abrir-chamado/enviar", { session_id: "opaque", serial: "S1", problema: "Teclado", descricao: "O teclado apresenta defeito.", enviar: true, confirmado: true }],
  ]);
});

