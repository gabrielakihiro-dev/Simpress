const assert = require("node:assert/strict");
const test = require("node:test");
const { criarImportacaoPlanilhas, ler } = require("../../frontend/src/paineis/importacao-planilhas/estado.ts");

function criarElementoFalso() {
  return {
    value: "", checked: false, textContent: "", innerHTML: "", className: "", children: [], dataset: {}, attributes: {},
    setAttribute(nome, valor) { this.attributes[nome] = String(valor); },
    removeAttribute(nome) { delete this.attributes[nome]; },
    replaceChildren(...filhos) { this.children = filhos; },
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  };
}
const elementos = new Map();
globalThis.document = {
  createElement: () => criarElementoFalso(),
  getElementById: id => {
    if (!elementos.has(id)) elementos.set(id, criarElementoFalso());
    return elementos.get(id);
  },
  activeElement: null,
};

// O spinner (svg lucide-loader-2 + <span>) agora é desenhado pelo React a partir de estado.ocupado; o DOM real é conferido em
// tests/e2e/react-bf2.spec.cjs. Aqui: o estado de ocupado, nenhuma escrita no botão e a trava síncrona contra clique duplo.
test("botão de envio mostra spinner e mensagem pelo estado, sem tocar no DOM, e recusa o segundo clique na hora", async () => {
  const botao = criarElementoFalso();
  botao.innerHTML = "Pré-visualizar";
  const endpoint = Object.assign(criarElementoFalso(), { files: [{ name: "e.xlsx" }] });
  const detalhes = Object.assign(criarElementoFalso(), { files: [{ name: "d.xlsx" }] });
  elementos.set("modal-atualizar-planilhas", criarElementoFalso());
  elementos.set("btn-previsualizar-planilhas", botao);
  elementos.set("upload-endpoint-file", endpoint);
  elementos.set("upload-details-file", detalhes);
  globalThis.lucide = { createIcons() { throw new Error("createIcons não roda mais aqui"); } };
  globalThis.FormData = class { append() {} };
  let falhar;
  let pedidos = 0;
  const apiFetch = () => { pedidos += 1; return new Promise((_, rejeitar) => { falhar = rejeitar; }); };
  const upload = criarImportacaoPlanilhas({ app: {}, appState: {}, apiFetch, inventoryOperationKey: () => "k" });
  const emAndamento = upload.previsualizarPlanilhas();

  assert.deepEqual(ler().ocupado, { botao: "previa", mensagem: "Validando arquivos..." });
  assert.equal(botao.innerHTML, "Pré-visualizar", "innerHTML não é reescrito durante o envio");
  assert.equal(botao.attributes["aria-busy"], undefined, "aria-busy do botão é do React");
  await upload.previsualizarPlanilhas(); // duplo clique antes do commit do React
  assert.equal(pedidos, 1, "a trava é síncrona: um POST só");

  falhar(new Error("falha fictícia"));
  await emAndamento;
  assert.equal(ler().ocupado, null);
  assert.equal(botao.innerHTML, "Pré-visualizar");
});
