// #sessao= fora do formato (64 hex minúsculos) é ignorado: nada vai ao localStorage, a barra não muda e nenhum
// X-Simpress-Sessao é enviado. Arquivo próprio: api.ts lê o endereço uma vez, ao carregar.
const assert = require("node:assert/strict");
const test = require("node:test");

const armazenado = new Map();
const trocas = [];
globalThis.location = {
  hash: `#sessao=${"A".repeat(64)}`, pathname: "/", search: "",
  href: `http://127.0.0.1:8000/#sessao=${"A".repeat(64)}`, origin: "http://127.0.0.1:8000",
};
globalThis.history = { replaceState: (...args) => trocas.push(args) };
globalThis.localStorage = {
  getItem: chave => (armazenado.has(chave) ? armazenado.get(chave) : null),
  setItem: (chave, valor) => armazenado.set(chave, String(valor)),
};

const { apiFetch } = require("../../frontend/src/api.ts");

test("valor fora do formato não é guardado nem enviado", async t => {
  assert.equal(armazenado.size, 0);
  assert.deepEqual(trocas, []);
  const original = global.fetch;
  const calls = [];
  global.fetch = async (...args) => { calls.push(args); return new Response("{}", { status: 200 }); };
  t.after(() => { global.fetch = original; });
  await apiFetch("/api/stats", { headers: { Accept: "application/json" } });
  assert.deepEqual(calls[0][1].headers, { Accept: "application/json" });
});
