// #sessao= que o servidor recusa (401: qualquer site pode abrir /#sessao=<inventado>) não sobrescreve a sessão guardada:
// o valor é descartado e os pedidos seguintes voltam ao localStorage. Arquivo próprio: api.ts lê o endereço ao carregar.
const assert = require("node:assert/strict");
const test = require("node:test");

const BOM = "c".repeat(64);
const INVENTADO = "d".repeat(64);
const armazenado = new Map([["simpress_sessao", BOM]]);
globalThis.location = {
  hash: `#sessao=${INVENTADO}`, pathname: "/", search: "",
  href: `http://127.0.0.1:8000/#sessao=${INVENTADO}`, origin: "http://127.0.0.1:8000",
};
globalThis.history = { replaceState() {} };
globalThis.localStorage = {
  getItem: chave => (armazenado.has(chave) ? armazenado.get(chave) : null),
  setItem: (chave, valor) => armazenado.set(chave, String(valor)),
};

const { apiFetch } = require("../../frontend/src/api.ts");

test("401 com o valor do endereço não grava nem apaga o valor guardado; o pedido seguinte usa o guardado", async t => {
  const original = global.fetch;
  const calls = [];
  const respostas = [401, 200];
  global.fetch = async (...args) => {
    calls.push(args);
    const status = respostas.shift();
    return new Response(JSON.stringify(status === 401 ? { detail: "Sessão local ausente ou expirada." } : {}), { status });
  };
  t.after(() => { global.fetch = original; });
  await assert.rejects(apiFetch("/api/stats"), { status: 401 });
  assert.equal(calls[0][1].headers.get("X-Simpress-Sessao"), INVENTADO);
  assert.equal(armazenado.get("simpress_sessao"), BOM);
  await apiFetch("/api/stats");
  assert.equal(calls[1][1].headers.get("X-Simpress-Sessao"), BOM);
  assert.equal(armazenado.get("simpress_sessao"), BOM);
});
