const test = require("node:test");
const { assert, createAppHarness, apiResponse, FakeElement } = require("./support/inventory-harness.cjs");

async function chat() {
  let finish;
  let signal;
  const timers = new Map();
  let nextTimer = 0;
  const h = createAppHarness((url, options) => {
    if (url === "/api/assistente/estado") return apiResponse({ online: true });
    if (url === "/api/assistente/anexos") return apiResponse({ anexos: [] });
    signal = options.signal;
    return new Promise((resolve, reject) => {
      finish = () => resolve(apiResponse({ texto: "Consulta Endpoint concluída.", ferramentas: ["consultar_endpoint"] }));
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  });
  h.context.AbortController = AbortController;
  h.context.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  h.context.clearTimeout = id => timers.delete(id);
  const original = h.context.document.getElementById;
  h.context.document.getElementById = id => {
    const element = original(id);
    element.querySelectorAll = () => [];
    element.querySelector = () => new FakeElement();
    element.contains = () => false;
    element.after = () => {};
    return element;
  };
  h.element("assistente-widget").hidden = true;
  await h.run("carregarAssistente()");
  h.element("assistente-texto").value = "Consulte ABC no Endpoint";
  const pending = h.run("enviarMensagemAssistente()");
  return { h, pending, signal: () => signal, finish: () => finish(), timers };
}

test("Assistant UI waits beyond Endpoint + model budget and accepts the eventual response", async () => {
  const c = await chat();
  assert.equal([...c.timers.values()][0].delay, 600000);
  assert.equal(c.signal().aborted, false);
  c.finish();
  await c.pending;
  assert.equal(c.h.element("assistente-anuncio").textContent, "Consulta Endpoint concluída.");
  assert.equal(c.timers.size, 0);
});

test("Assistant UI still permits manual cancellation during the extended wait", async () => {
  const c = await chat();
  c.h.run("cancelarEnvioAssistente()");
  await c.pending;
  assert.equal(c.signal().aborted, true);
  assert.match(c.h.element("assistente-status").textContent, /Envio cancelado/);
  assert.equal(c.h.element("assistente-texto").value, "Consulte ABC no Endpoint");
  assert.equal(c.timers.size, 0);
});

test("Assistant UI aborts at the extended timeout and restores the message", async () => {
  const c = await chat();
  [...c.timers.values()][0].callback();
  await c.pending;
  assert.equal(c.signal().aborted, true);
  assert.match(c.h.element("assistente-status").textContent, /demorou demais/);
  assert.equal(c.h.element("assistente-texto").value, "Consulte ABC no Endpoint");
});
