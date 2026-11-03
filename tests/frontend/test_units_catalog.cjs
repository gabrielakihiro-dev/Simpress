const assert = require("node:assert/strict");
const test = require("node:test");
const createUnitsCatalog = require("../../static/js/features/units-catalog.js");

function setup(t, fetch) {
  const originals = { document: global.document, fetch: global.fetch, consoleError: console.error };
  t.after(() => {
    global.document = originals.document;
    global.fetch = originals.fetch;
    console.error = originals.consoleError;
  });
  const select = {
    value: "7",
    innerHTML: '<option value="7">Catálogo anterior</option>',
    options: [],
    appendChild(option) { this.options.push(option); },
  };
  const count = { textContent: "1 filial catalogada" };
  const elements = { "select-unidade-destino": select, "filiais-count": count };
  global.document = {
    getElementById: id => elements[id],
    createElement: () => ({}),
  };
  global.fetch = fetch;
  console.error = () => {};
  const messages = [];
  const updates = [];
  const appState = { unidadesList: [{ id: 7, label: "Catálogo anterior" }] };
  const feature = createUnitsCatalog({
    appState,
    app: {
      showToast: (message, level) => messages.push({ message, level }),
      handleUnidadeDestinoChange: (id, manual) => updates.push([id, manual]),
      atualizarEstadoCopiaCnpjEntrega: () => updates.push("cnpj"),
      atualizarChipsUnidade: () => updates.push("chips"),
    },
    dom: { pluralize: (count, singular, plural) => count === 1 ? singular : plural },
  });
  return { feature, appState, select, count, messages, updates };
}

for (const status of [404, 503]) {
  test(`unit catalog reports HTTP ${status} without replacing the previous catalog or selection`, async t => {
    const harness = setup(t, async url => {
      assert.equal(url, "/api/unidades");
      return new Response("Service unavailable", { status });
    });
    const previousList = harness.appState.unidadesList;

    await harness.feature.carregarUnidades();

    assert.deepEqual(harness.messages, [{
      message: "Não foi possível carregar o catálogo de unidades. Recarregue a página e tente de novo.",
      level: "error",
    }]);
    assert.equal(harness.appState.unidadesList, previousList);
    assert.equal(harness.select.value, "7");
    assert.equal(harness.select.innerHTML, '<option value="7">Catálogo anterior</option>');
    assert.equal(harness.count.textContent, "1 filial catalogada");
    assert.deepEqual(harness.updates, []);
  });
}

test("unit catalog reports a network failure and preserves its previous data", async t => {
  const harness = setup(t, async () => { throw new TypeError("Failed to fetch"); });
  const previousList = harness.appState.unidadesList;

  await harness.feature.carregarUnidades();

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].level, "error");
  assert.match(harness.messages[0].message, /Não foi possível carregar o catálogo/);
  assert.equal(harness.appState.unidadesList, previousList);
  assert.equal(harness.select.value, "7");
  assert.deepEqual(harness.updates, []);
});

test("unit catalog refreshes its options and count while keeping a valid selection", async t => {
  const units = [{ id: 7, label: "Curitiba · Sede" }, { id: 9, cidade: "Londrina", endereco: "Rua A", cnpj: "123" }];
  const harness = setup(t, async () => Response.json(units));

  await harness.feature.carregarUnidades();

  assert.deepEqual(harness.appState.unidadesList, units);
  assert.deepEqual(harness.select.options, [
    { value: 7, textContent: "Curitiba · Sede" },
    { value: 9, textContent: "Londrina - Rua A (123)" },
  ]);
  assert.equal(String(harness.select.value), "7");
  assert.equal(harness.count.textContent, "2 filiais catalogadas");
  assert.deepEqual(harness.updates, [[7, false], "cnpj", "chips"]);
  assert.deepEqual(harness.messages, []);
});
