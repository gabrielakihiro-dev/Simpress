// Catálogo de unidades (Novo layout, 18/11/2026): busca sem acento, CNPJ só por dígitos e trechos para o <mark>.
// Dados sintéticos; estado.ts não importa nada, então o Node carrega o .ts direto.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const carregar = () => import(pathToFileURL(path.join(__dirname, "../../frontend/src/paineis/unidades/estado.ts")).href);

const unidades = [
  { id: 1, label: "Curitiba Sede", cidade: "Curitiba", cnpj: "00.000.000/0001-91" },
  { id: 2, label: "", cidade: "Maringá", cnpj: "00.000.000/0002-72" },
];

test("filtrarUnidades acha sem acento e acha o CNPJ só pelos dígitos", async () => {
  const { filtrarUnidades } = await carregar();
  assert.deepEqual(filtrarUnidades(unidades, "maringa").map(u => u.chave), ["2"]);
  assert.deepEqual(filtrarUnidades(unidades, "000272").map(u => u.chave), ["2"]);
  assert.deepEqual(filtrarUnidades(unidades, "0001-91").map(u => u.chave), ["1"]);
  assert.deepEqual(filtrarUnidades(unidades, "sede curitiba").map(u => u.chave), ["1"]);
  assert.deepEqual(filtrarUnidades(unidades, "nada").map(u => u.chave), []);
});

test("trechosBusca marca a letra original com acento e junta trechos vizinhos", async () => {
  const { trechosBusca } = await carregar();
  assert.deepEqual(trechosBusca("Maringá", "ringa"), [{ texto: "Ma", achou: false }, { texto: "ringá", achou: true }]);
  assert.deepEqual(trechosBusca("Curitiba Sede", "sede cur"), [
    { texto: "Cur", achou: true }, { texto: "itiba ", achou: false }, { texto: "Sede", achou: true },
  ]);
  assert.deepEqual(trechosBusca("Londrina", ""), [{ texto: "Londrina", achou: false }]);
  assert.deepEqual(trechosBusca("", "x"), []);
});
