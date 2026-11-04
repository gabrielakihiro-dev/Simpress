const test = require("node:test");
const { assert, createAppHarness, apiResponse, appHtml } = require("./support/inventory-harness.cjs");

test("Home provides an accessible Endpoint action for the selected equipment", () => {
  assert.match(appHtml, /id="btn-consultar-endpoint"[^>]*data-on-click="consultarEndpoint"/);
  assert.match(appHtml, /id="endpoint-lookup-result"[^>]*role="status"/);
  const h = createAppHarness();
  h.selectEquipment({ serial: "ABC" });
  assert.equal(h.element("btn-consultar-endpoint").disabled, false);
  h.run("definirEquipamentoAtual(null)");
  assert.equal(h.element("btn-consultar-endpoint").disabled, true);
});

for (const [response, expected] of [
  [{ status: "found", serial: "ABC", ultimo_logon: "person" }, "Usuário do último logon: person"],
  [{ status: "found", serial: "ABC", ultimo_logon: "" }, "Equipamento encontrado no Endpoint, sem usuário do último logon informado."],
  [{ status: "not_found", serial: "ABC" }, "Equipamento não encontrado no Endpoint"],
  [{ status: "ambiguous", serial: "ABC" }, "Mais de um equipamento encontrado no Endpoint para esta série. Confira as duplicidades."],
  [{ status: "ambiguous", serial: "ABC", origem: "base_local" }, "A série alternativa do MacBook é ambígua na base local. Nenhum usuário foi associado."],
  [{ status: "ambiguous", serial: "ABC", origem: "correspondencia_mac" }, "Não foi possível confirmar a correspondência única do MacBook no Endpoint. Nenhum usuário foi associado."],
]) {
  test(`Home renders Endpoint result: ${response.status} / ${response.ultimo_logon || "blank"}`, async () => {
    const h = createAppHarness((url, options) => {
      assert.equal(url, "/api/endpoint/consultar");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { serial: "ABC" });
      return apiResponse(response);
    });
    h.selectEquipment({ serial: "ABC" });
    await h.run("consultarEndpoint()");
    assert.equal(h.element("endpoint-lookup-result").textContent, expected);
    assert.equal(h.element("btn-consultar-endpoint").disabled, false);
  });
}

test("Home keeps errors distinct from a missing computer", async () => {
  const h = createAppHarness(() => apiResponse({ detail: "Chrome ocupado" }, { status: 409 }));
  h.selectEquipment({ serial: "ABC" });
  await h.run("consultarEndpoint()");
  assert.match(h.element("endpoint-lookup-result").textContent, /Chrome ocupado/);
});

test("Home discards an old result even when the same serial is selected again", async () => {
  let finish;
  const h = createAppHarness(() => new Promise(resolve => { finish = resolve; }));
  h.selectEquipment({ serial: "ABC" });
  const pending = h.run("consultarEndpoint()");
  assert.equal(h.element("btn-consultar-endpoint").disabled, true);
  h.selectEquipment({ serial: "OTHER" });
  h.selectEquipment({ serial: "ABC" });
  finish(apiResponse({ status: "found", serial: "ABC", ultimo_logon: "stale" }));
  await pending;
  assert.equal(h.element("endpoint-lookup-result").textContent, "");
  assert.equal(h.element("btn-consultar-endpoint").disabled, false);
});
