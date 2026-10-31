const assert = require("node:assert/strict");
const test = require("node:test");
const createInventoryUpload = require("../../static/js/features/inventory-upload.js");

function criarElementoFalso() {
  return {
    value: "", checked: false, textContent: "", innerHTML: "", className: "", children: [], dataset: {}, attributes: {},
    setAttribute(nome, valor) { this.attributes[nome] = String(valor); },
    removeAttribute(nome) { delete this.attributes[nome]; },
    replaceChildren(...filhos) { this.children = filhos; },
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

test("botão de envio monta ícone e mensagem como nós, sem innerHTML", async () => {
  const botao = criarElementoFalso();
  botao.innerHTML = "Pré-visualizar";
  const endpoint = Object.assign(criarElementoFalso(), { files: [{ name: "e.xlsx" }] });
  const detalhes = Object.assign(criarElementoFalso(), { files: [{ name: "d.xlsx" }] });
  elementos.set("modal-atualizar-planilhas", criarElementoFalso());
  elementos.set("btn-previsualizar-planilhas", botao);
  elementos.set("upload-endpoint-file", endpoint);
  elementos.set("upload-details-file", detalhes);
  const chamadasIcones = [];
  globalThis.lucide = { createIcons: opcoes => chamadasIcones.push(opcoes) };
  globalThis.FormData = class { append() {} };
  let falhar;
  const app = {
    apiFetch: () => new Promise((_, rejeitar) => { falhar = rejeitar; }),
    limparPreviaUploadPlanilhas() {},
  };
  const upload = createInventoryUpload({ app, appState: {}, inventoryOperationKey: () => "k" });
  const emAndamento = upload.previsualizarPlanilhas();

  const [icone, texto] = botao.children;
  assert.equal(icone.attributes["data-lucide"], "loader-2");
  assert.equal(icone.className, "w-3.5 h-3.5 animate-spin");
  assert.equal(texto.textContent, "Validando arquivos...");
  assert.equal(botao.innerHTML, "Pré-visualizar", "innerHTML não é reescrito durante o envio");
  assert.equal(botao.attributes["aria-busy"], "true");
  assert.deepEqual(chamadasIcones, [{ root: botao }]);

  falhar(new Error("falha fictícia"));
  await emAndamento;
  assert.equal(botao.innerHTML, "Pré-visualizar");
  assert.equal(botao.attributes["aria-busy"], undefined);
});
