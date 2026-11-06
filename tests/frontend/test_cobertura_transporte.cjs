// Cobertura → Transporte: o Simpress só preenche o formulário e liga a planilha que o operador baixou.
const assert = require("node:assert/strict");
const test = require("node:test");

const transferUtils = require("../../static/js/shared/transfer-utils.js");
const history = require("../../static/js/ui/transfer-history.js");

function fakeElement() {
  return {
    value: "", textContent: "", innerHTML: "", dataset: {}, style: {}, disabled: false,
    setAttribute() {}, removeAttribute() {}, focus() {}, click() {}, remove() {}, addEventListener() {},
  };
}

function fakeDocument() {
  const elements = new Map();
  const listeners = {};
  const events = [];
  return {
    events,
    body: { appendChild() {} },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement: () => fakeElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(event) {
      events.push(event);
      for (const fn of listeners[event.type] || []) fn(event);
      return true;
    },
  };
}

class FakeCustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
}

const MOV = { id: "mov-1", rev: 2, chave: "chave-sint-001", serie: "SINT-001", destino_cidade: "Maringá", extra: "x" };

function bootTransferForm() {
  const document = fakeDocument();
  global.document = document;
  global.window = {
    CustomEvent: FakeCustomEvent,
    SimpressFormDraftGuard: require("../../static/js/shared/form-draft-guard.js"),
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  };
  global.lucide = { createIcons() {} };
  const calls = [];
  const toasts = [];
  const appState = {
    currentEquipamento: null,
    unidadesList: [{ id: 7, cidade: "Maringá", cnpj: "00.000.000/0001-91", endereco_completo: "Rua Sintética, 1" }],
  };
  const app = {
    showToast: (message, type) => toasts.push([message, type]),
    selecionarItemAutocomplete: async item => { calls.push(["selecionar", item.serial]); appState.currentEquipamento = { serial: item.serial }; },
    abrirAbaTransporteDoEquipamento: () => calls.push(["aba"]),
    selecionarUnidadePorCidade: cidade => {
      calls.push(["cidade", cidade]);
      document.getElementById("select-unidade-destino").value = "7";
      document.getElementById("entrega-cnpj").value = "00.000.000/0001-91";
      document.getElementById("entrega-endereco").value = "Rua Sintética, 1";
    },
    adicionarObsChamado: texto => calls.push(["obs", texto]),
    gerarPlanilhaExcel: () => { throw new Error("prepararTransporte não pode gerar planilha"); },
    validarCamposObrigatoriosPlanilha: () => true,
    formatarTelefoneBrasileiro: value => value,
    apiFetch: async () => ({ headers: { get: () => null }, blob: async () => ({}) }),
  };
  const form = require("../../static/js/features/transfer-form.js")({ app, appState, motion: null, transferUtils });
  return { form, app, appState, document, calls, toasts };
}

async function gerar(env, serial, cidadeUnidade) {
  env.appState.currentEquipamento = { serial };
  env.document.getElementById("input-serial").value = serial;
  env.document.getElementById("entrega-contato").value = "Destinatário Sintético";
  env.document.getElementById("entrega-cnpj").value = "00.000.000/0001-91";
  env.document.getElementById("entrega-endereco").value = "Rua Sintética, 1";
  env.appState.unidadesList[0].cidade = cidadeUnidade;
  env.document.getElementById("select-unidade-destino").value = "7";
  await env.form.gerarPlanilhaExcel();
  return env.document.events.filter(event => event.type === "simpress:transfer-generated");
}

test("prepararTransporte preenche o formulário e guarda a pendência sem gerar planilha", async () => {
  const env = bootTransferForm();
  await env.form.prepararTransporte({ serial: "SINT-001", cidade: "Maringá", obs: "Cobertura SINT", movimentacao: MOV });
  assert.deepEqual(env.calls, [["selecionar", "SINT-001"], ["aba"], ["cidade", "Maringá"], ["obs", "Cobertura SINT"]]);
  assert.deepEqual(env.appState.movimentacaoPendente,
    { id: "mov-1", rev: 2, chave: "chave-sint-001", serie: "SINT-001", destino_cidade: "Maringá" });
  assert.equal(env.document.events.some(event => event.type === "simpress:transfer-generated"), false);
});

test("prepararTransporte não recarrega o equipamento já selecionado", async () => {
  const env = bootTransferForm();
  env.appState.currentEquipamento = { serial: "sint-001" };
  await env.form.prepararTransporte({ serial: "SINT-001", cidade: "Maringá", movimentacao: MOV });
  assert.equal(env.calls.some(call => call[0] === "selecionar"), false);
});

test("o evento leva a movimentação quando série e destino batem (sem acento e sem caixa)", async () => {
  const env = bootTransferForm();
  env.appState.movimentacaoPendente = { ...MOV };
  const [event] = await gerar(env, "SINT-001", "MARINGA");
  assert.equal(event.detail.movimentacao.id, "mov-1");
  assert.equal(event.detail.payload.serial, "SINT-001");
  assert.equal(env.appState.movimentacaoPendente, null);
});

test("dados mudados: evento sem movimentação, aviso exato e pendência descartada", async () => {
  const env = bootTransferForm();
  env.appState.movimentacaoPendente = { ...MOV };
  const [event] = await gerar(env, "SINT-001", "Londrina");
  assert.equal("movimentacao" in event.detail, false);
  assert.ok(env.toasts.some(([message]) => message === "Os dados mudaram; a planilha não foi ligada à movimentação."));
  assert.equal(env.appState.movimentacaoPendente, null);
  const [segunda] = await gerar(env, "SINT-001", "Maringá");
  assert.equal("movimentacao" in segunda.detail, false);
});

// ------------------------------------------------------------------ transfer-history: vínculo com a cobertura

function fakeStorage({ throws = false } = {}) {
  const data = new Map();
  const guard = () => { if (throws) throw new Error("bloqueado"); };
  return {
    data,
    getItem: key => (guard(), data.has(key) ? data.get(key) : null),
    setItem: (key, value) => (guard(), data.set(key, String(value))),
    removeItem: key => (guard(), data.delete(key)),
  };
}

function installHistory({ responses, storage = fakeStorage() }) {
  const document = fakeDocument();
  const requests = [];
  const toasts = [];
  const win = {
    document, CustomEvent: FakeCustomEvent, localStorage: storage, console: { warn() {} },
    setTimeout, clearTimeout,
    showToast: (message, type) => toasts.push([message, type]),
    fetch: async (url, init) => {
      requests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { ok: next.status < 400, status: next.status, json: async () => next.body };
    },
  };
  history.install(win);
  return { win, document, requests, toasts, storage };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const PAYLOAD = { serial: "SINT-001", entrega_cidade: "Maringá" };
const ROTA = "/api/cobertura/movimentacoes/mov-1/registrar-transferencia";

function emitir(env, detail) {
  env.document.dispatchEvent(new FakeCustomEvent("simpress:transfer-generated", { detail }));
}

test("sem movimentação o histórico genérico continua igual", async () => {
  const env = installHistory({ responses: [{ status: 201, body: {} }] });
  emitir(env, { payload: PAYLOAD });
  await tick();
  assert.deepEqual(env.requests.map(r => r.url), [history.ENDPOINT]);
  assert.deepEqual(env.requests[0].body, PAYLOAD);
});

test("com movimentação só a rota da cobertura é chamada e o sucesso avisa a tela", async () => {
  const env = installHistory({ responses: [{ status: 200, body: { repetido: false } }] });
  emitir(env, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.deepEqual(env.requests.map(r => r.url), [ROTA]);
  assert.deepEqual(env.requests[0].body, { payload: PAYLOAD, chave: "chave-sint-001", rev: 2 });
  assert.ok(env.document.events.some(event => event.type === "simpress:cobertura-atualizada"));
  assert.deepEqual(env.win.SimpressCoberturaVinculo.pendenciaSemVinculo(), []);
});

test("falha de rede guarda a pendência e a nova tentativa usa a MESMA chave", async () => {
  const env = installHistory({ responses: [new Error("offline"), { status: 503, body: {} }, { status: 200, body: {} }] });
  emitir(env, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.ok(env.toasts.some(([message]) => message === "Planilha baixada sem vínculo — Tentar de novo"));
  const [pendente] = env.win.SimpressCoberturaVinculo.pendenciaSemVinculo();
  assert.equal(pendente.chave, "chave-sint-001");
  assert.ok(env.storage.data.get("simpress:cobertura:sem-vinculo").includes("chave-sint-001"));

  const [falha] = await env.win.SimpressCoberturaVinculo.tentarVincularDeNovo("mov-1");
  assert.equal(falha.pendente, true);
  const [ok] = await env.win.SimpressCoberturaVinculo.tentarVincularDeNovo();
  assert.equal(ok.ok, true);
  assert.deepEqual(env.requests.map(r => r.body.chave), ["chave-sint-001", "chave-sint-001", "chave-sint-001"]);
  assert.equal(env.requests.every(r => r.url === ROTA), true);
  assert.deepEqual(env.win.SimpressCoberturaVinculo.pendenciaSemVinculo(), []);
  assert.equal(env.storage.data.has("simpress:cobertura:sem-vinculo"), false);
});

test("409 e 422 mostram a mensagem e não guardam pendência; arquivo ocupado guarda", async () => {
  const env = installHistory({ responses: [
    { status: 409, body: { detail: { codigo: "chave_diferente", mensagem: "Chave diferente." } } },
    { status: 409, body: { detail: { codigo: "arquivo_ocupado", mensagem: "Ocupado." } } },
  ] });
  emitir(env, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.ok(env.toasts.some(([message, type]) => message === "Chave diferente." && type === "error"));
  assert.deepEqual(env.win.SimpressCoberturaVinculo.pendenciaSemVinculo(), []);
  emitir(env, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.equal(env.win.SimpressCoberturaVinculo.pendenciaSemVinculo().length, 1);
});

test("localStorage que lança erro ou guarda lixo não quebra o vínculo", async () => {
  const quebrado = installHistory({ storage: fakeStorage({ throws: true }), responses: [new Error("offline"), { status: 200, body: {} }] });
  emitir(quebrado, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.equal(quebrado.win.SimpressCoberturaVinculo.pendenciaSemVinculo().length, 1);
  const [ok] = await quebrado.win.SimpressCoberturaVinculo.tentarVincularDeNovo("mov-1");
  assert.equal(ok.ok, true);

  const lixo = fakeStorage();
  lixo.data.set("simpress:cobertura:sem-vinculo", "{não é json");
  const env = installHistory({ storage: lixo, responses: [] });
  assert.deepEqual(env.win.SimpressCoberturaVinculo.pendenciaSemVinculo(), []);
});
