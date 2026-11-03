const test = require("node:test");
const { assert, createAppHarness, apiResponse } = require("./support/inventory-harness.cjs");

for (const update of ['handleSerialInput("L")', 'carregarListaHome({ query: "L" })']) {
  test(`Home keeps the one-character hint after an older list response: ${update}`, async () => {
    let finish;
    let signal;
    const harness = createAppHarness((_url, options) => {
      signal = options.signal;
      // Resolve even after abort: the response may already be in flight.
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = harness.run('carregarListaHome({ query: "LE" })');
    await harness.run(update);
    finish(apiResponse({ items: [], total: 7, has_more: true }));
    await pending;

    assert.equal(harness.element("home-list-count").textContent, "Digite ao menos 2 caracteres para filtrar a lista.");
    assert.equal(harness.element("home-list-empty").hidden, false);
    assert.equal(harness.element("btn-home-list-more").hidden, true);
    assert.equal(harness.element("home-equipment-list").attributes.get("aria-busy"), "false");
    assert.equal(signal.aborted, true);
  });
}
