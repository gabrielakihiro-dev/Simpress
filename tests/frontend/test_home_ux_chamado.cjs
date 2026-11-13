const test = require("node:test");
const { assert, createAppHarness, apiResponse } = require("./support/inventory-harness.cjs");

const SOLICITANTE = {
  nome: "Pessoa Exemplo", email: "nome.exemplo@pr.sebrae.com.br",
  telefone: "(41) 90000-0000", departamento_cargo: "Setor Exemplo / Cargo Exemplo",
};

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
      ? { status: "preparado", serial: "S1", session_id: "opaque", modelo: "X", opcoes: ["Teclado"], solicitante: SOLICITANTE }
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
  // The default Solicitante is prefilled and editable before Simular / Revisar e enviar.
  assert.equal(harness.element("ux-solicitante-nome").value, SOLICITANTE.nome);
  assert.equal(harness.element("ux-solicitante-email").value, SOLICITANTE.email);
  assert.equal(harness.element("ux-solicitante-telefone").value, SOLICITANTE.telefone);
  assert.equal(harness.element("ux-solicitante-cargo").value, SOLICITANTE.departamento_cargo);
  assert.equal(harness.element("ux-chamado-solicitante").disabled, false);
  harness.element("ux-solicitante-cargo").value = " Setor Exemplo / Cargo Novo ";
  await harness.run("executarChamadoUX(false)");
  await harness.run("executarChamadoUX(true)");
  const solicitante = { ...SOLICITANTE, departamento_cargo: "Setor Exemplo / Cargo Novo" };
  assert.deepEqual(calls.slice(1), [
    ["/api/ux/abrir-chamado/enviar", { session_id: "opaque", serial: "S1", problema: "Teclado", descricao: "O teclado apresenta defeito.", solicitante, enviar: false, confirmado: false }],
    ["/api/ux/abrir-chamado/enviar", { session_id: "opaque", serial: "S1", problema: "Teclado", descricao: "O teclado apresenta defeito.", solicitante, enviar: true, confirmado: true }],
  ]);
});

test("Home blocks Simular and Revisar e enviar while a Solicitante field is empty", async () => {
  const calls = [];
  const harness = createAppHarness((url, options) => {
    calls.push(url);
    return Promise.resolve(apiResponse({ status: "preparado", serial: "S1", session_id: "opaque", modelo: "X", opcoes: ["Teclado"], solicitante: SOLICITANTE }));
  });
  harness.run(`abrirModalAcessivel = () => {};
    fecharModalAcessivel = () => {};
    SimpressApp.state.currentEquipamento = { serial: "S1" };`);
  harness.element("btn-copiar-chamado-atual").dataset.args = '["texto-chamado-teclado-mouse"]';
  harness.element("texto-chamado-teclado-mouse").value = "O teclado apresenta defeito.";
  await harness.run("abrirChamadoUX()");
  harness.element("ux-chamado-problema").value = "Teclado";
  harness.run("atualizarProblemaChamadoUX()");
  assert.equal(harness.element("ux-chamado-simular").disabled, false);
  harness.element("ux-solicitante-telefone").value = "  ";
  harness.run("atualizarProblemaChamadoUX()");
  for (const id of ["ux-chamado-simular", "ux-chamado-enviar"]) assert.equal(harness.element(id).disabled, true);
  assert.match(harness.element("ux-chamado-motivo").textContent, /campos do solicitante/);
  await harness.run("executarChamadoUX(false)");
  assert.deepEqual(calls, ["/api/ux/abrir-chamado/preparar"]);
});


test("Home opens the UX modal with empty Solicitante fields when no local profile exists and keeps both actions disabled", async () => {
  const calls = [];
  const vazio = { nome: "", email: "", telefone: "", departamento_cargo: "" };  // what the backend returns without data/state/ux_solicitante.json
  const harness = createAppHarness(url => {
    calls.push(url);
    return Promise.resolve(apiResponse({ status: "preparado", serial: "S1", session_id: "opaque", modelo: "X", opcoes: ["Teclado"], solicitante: vazio }));
  });
  harness.run(`abrirModalAcessivel = () => {};
    fecharModalAcessivel = () => {};
    SimpressApp.state.currentEquipamento = { serial: "S1" };`);
  harness.element("btn-copiar-chamado-atual").dataset.args = '["texto-chamado-teclado-mouse"]';
  harness.element("texto-chamado-teclado-mouse").value = "O teclado apresenta defeito.";
  await harness.run("abrirChamadoUX()");
  harness.element("ux-chamado-problema").value = "Teclado";
  harness.run("atualizarProblemaChamadoUX()");
  for (const id of ["ux-solicitante-nome", "ux-solicitante-email", "ux-solicitante-telefone", "ux-solicitante-cargo"]) assert.equal(harness.element(id).value, "", id);
  assert.equal(harness.element("ux-chamado-solicitante").disabled, false);  // the fields stay editable
  for (const id of ["ux-chamado-simular", "ux-chamado-enviar"]) assert.equal(harness.element(id).disabled, true, id);
  assert.match(harness.element("ux-chamado-motivo").textContent, /campos do solicitante/);
  await harness.run("executarChamadoUX(false)");
  await harness.run("executarChamadoUX(true)");
  assert.deepEqual(calls, ["/api/ux/abrir-chamado/preparar"]);  // neither action reaches the server
  for (const [campo, id] of [["nome", "ux-solicitante-nome"], ["email", "ux-solicitante-email"], ["telefone", "ux-solicitante-telefone"], ["departamento_cargo", "ux-solicitante-cargo"]]) harness.element(id).value = SOLICITANTE[campo];
  harness.run("atualizarProblemaChamadoUX()");
  for (const id of ["ux-chamado-simular", "ux-chamado-enviar"]) assert.equal(harness.element(id).disabled, false, id);
});


test("Home keeps the description and explains why the actions stay disabled after a failed UX preparation", async () => {
  const aviso = "Não foi possível abrir ou conectar o Chrome de automação. Feche as janelas desse Chrome e tente de novo.";
  const harness = createAppHarness(() => Promise.resolve(apiResponse({ detail: aviso, codigo: "chrome_indisponivel" }, { status: 503 })));
  harness.run(`abrirModalAcessivel = () => {};
    fecharModalAcessivel = () => {};
    SimpressApp.state.currentEquipamento = { serial: "S1" };`);
  harness.element("btn-copiar-chamado-atual").dataset.args = '["texto-chamado-teclado-mouse"]';
  harness.element("texto-chamado-teclado-mouse").value = "O teclado apresenta defeito.";
  await harness.run("abrirChamadoUX()");
  assert.equal(harness.element("ux-chamado-status").textContent, aviso);
  assert.equal(harness.element("ux-chamado-descricao").textContent, "O teclado apresenta defeito.");
  const motivo = harness.element("ux-chamado-motivo");
  assert.equal(motivo.hidden, false);
  assert.match(motivo.textContent, /preparação no UX não foi concluída/);
  for (const id of ["ux-chamado-simular", "ux-chamado-enviar"]) {
    assert.equal(harness.element(id).disabled, true);
    assert.equal(harness.element(id).title, motivo.textContent);
  }
});
