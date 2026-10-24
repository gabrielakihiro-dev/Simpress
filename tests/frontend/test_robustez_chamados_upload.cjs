const assert = require("node:assert/strict");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createTicketRules = require("../../static/js/features/ticket-rules.js");
const createTicketTracking = require("../../static/js/features/ticket-tracking.js");
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
const dom = createDomUtils(globalThis.document);

function criarAcompanhamento(appState) {
  const gate = { invalidate() {}, begin: () => ({ id: 1, signal: undefined }), isCurrent: () => true };
  return createTicketTracking({
    app: {}, appState, motion: null, dom, historyFormat,
    transferUtils: { createRequestGate: () => gate },
    ticketRules: createTicketRules(dom),
    loggedUserMarkers: { marcador: () => "", conectar() {} },
  });
}

test("relacao herdada do prototipo cai em 'OS ausente' sem quebrar a lista", () => {
  const appState = { filtroChamadoSelecionado: null, filtroTriagemChamados: "", acompanhamentoChamadosAtual: null };
  const acompanhamento = criarAcompanhamento(appState);
  appState.acompanhamentoChamadosAtual = {
    snapshot_id: "s1", fontes: {}, resumo: {},
    chamados: ["constructor", "__proto__", "toString", "conferida"].map((relacao, i) => ({
      serie: `SERIE${i}`, relacao, simpress: {}, oracle: [],
    })),
  };
  acompanhamento.renderizarAcompanhamentoChamados();
  const html = document.getElementById("lista-acompanhamento-chamados").innerHTML;
  assert.equal((html.match(/data-ticket-serial=/g) || []).length, 4, "os 4 cartões devem ser renderizados");
  assert.equal((html.match(/OS ausente/g) || []).length, 3, "chaves herdadas caem em sem_os");
  assert.equal((html.match(/OS conferida/g) || []).length, 1, "chave própria continua funcionando");
});

test("foco da triagem usa seletor escapado", () => {
  const appState = { filtroChamadoSelecionado: null, filtroTriagemChamados: "", acompanhamentoChamadosAtual: null };
  const acompanhamento = criarAcompanhamento(appState);
  const seletores = [];
  const alvo = document.getElementById("triagem-diaria-acompanhamento-chamados");
  alvo.querySelector = seletor => { seletores.push(seletor); return null; };
  const original = globalThis.document.activeElement;
  globalThis.document.activeElement = {
    closest: () => ({ dataset: { ticketTriageFilter: 'x"] , [data-evil="1' } }),
  };
  try {
    appState.acompanhamentoChamadosAtual = { snapshot_id: "s1", fontes: {}, resumo: {}, chamados: [] };
    acompanhamento.renderizarAcompanhamentoChamados();
  } finally {
    globalThis.document.activeElement = original;
  }
  assert.equal(seletores.length, 1);
  assert.ok(!seletores[0].includes('x"]'), `aspas não escapadas: ${seletores[0]}`);
  assert.ok(seletores[0].includes('\\"'), `aspas devem vir com barra: ${seletores[0]}`);
});

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
