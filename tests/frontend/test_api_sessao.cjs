// Sessão local no front (security/sessao_local.py): api.ts lê #sessao=<hex> ao carregar, limpa a barra, manda
// X-Simpress-Sessao só para a mesma origem e guarda o valor no localStorage depois do primeiro /api/* 2xx com ele.
// Arquivo próprio: os globais vêm antes do require.
const assert = require("node:assert/strict");
const test = require("node:test");

const VALOR = "a".repeat(64);
const armazenado = new Map();
const trocas = [];
globalThis.location = {
  hash: `#sessao=${VALOR}`, pathname: "/", search: "?aba=home",
  href: `http://127.0.0.1:8000/?aba=home#sessao=${VALOR}`, origin: "http://127.0.0.1:8000",
};
globalThis.history = { replaceState: (...args) => trocas.push(args) };
globalThis.localStorage = {
  getItem: chave => (armazenado.has(chave) ? armazenado.get(chave) : null),
  setItem: (chave, valor) => armazenado.set(chave, String(valor)),
};

const { apiFetch, apiRota } = require("../../frontend/src/api.ts");

function mockFetch(t) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { global.fetch = original; });
  return calls;
}

test("o valor de #sessao= sai da barra ao carregar e só vai ao localStorage depois de um /api/* 2xx", async t => {
  assert.deepEqual(trocas, [[null, "", "/?aba=home"]]);
  assert.equal(armazenado.has("simpress_sessao"), false);
  const calls = mockFetch(t);
  await apiFetch("/api/stats");
  assert.equal(calls[0][1].headers.get("X-Simpress-Sessao"), VALOR);
  assert.equal(armazenado.get("simpress_sessao"), VALOR);
});

test("mesma origem leva X-Simpress-Sessao; outra origem não", async t => {
  const calls = mockFetch(t);
  await apiFetch("/api/stats", { headers: { Accept: "application/json" } });
  await apiFetch("http://127.0.0.1:8000/api/stats");
  await apiFetch("http://127.0.0.1:8001/api/stats");
  await apiFetch("https://exemplo.invalid/api/stats", { headers: { Accept: "application/json" } });
  assert.equal(calls[0][1].headers.get("X-Simpress-Sessao"), VALOR);
  assert.equal(calls[0][1].headers.get("Accept"), "application/json");
  assert.equal(calls[1][1].headers.get("X-Simpress-Sessao"), VALOR);
  assert.equal(calls[2][1].headers, undefined);
  assert.deepEqual(calls[3][1].headers, { Accept: "application/json" });
});

test("apiRota com consulta continua levando X-Simpress-Sessao (passa pelo apiFetch)", async t => {
  const calls = mockFetch(t);
  await apiRota("GET /api/automacao/estado", { consulta: { offset: 3, arquivo: "x" } });
  assert.equal(calls[0][0], "/api/automacao/estado?offset=3&arquivo=x");
  assert.equal(calls[0][1].headers.get("X-Simpress-Sessao"), VALOR);
});

test("o valor é relido a cada pedido: um novo /bootstrap em outra aba vale na hora", async t => {
  const calls = mockFetch(t);
  armazenado.set("simpress_sessao", "b".repeat(64));
  await apiFetch("/api/stats");
  assert.equal(calls[0][1].headers.get("X-Simpress-Sessao"), "b".repeat(64));
  // Valor estragado no armazenamento: vale a reserva lida do endereço desta aba.
  armazenado.set("simpress_sessao", "nao-hex");
  await apiFetch("/api/stats");
  assert.equal(calls[1][1].headers.get("X-Simpress-Sessao"), VALOR);
  armazenado.set("simpress_sessao", VALOR);
});

test("FormData segue sem Content-Type, para o navegador pôr o boundary", async t => {
  const calls = mockFetch(t);
  const corpo = new FormData();
  corpo.append("file", new Blob(["x"]), "a.csv");
  await apiFetch("/api/usuarios-entra/importar", { method: "POST", body: corpo });
  const headers = calls[0][1].headers;
  assert.equal(headers.get("X-Simpress-Sessao"), VALOR);
  assert.equal(headers.has("Content-Type"), false);
  assert.equal(calls[0][1].body, corpo);
});
