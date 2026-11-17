// Cobertura → Transporte: o Simpress só preenche o formulário e liga a planilha que o operador baixou.
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const transferUtils = require("../../frontend/src/comum/transfer-utils.ts");
const { criarFormularioTransferencia } = require("../../frontend/src/paineis/transporte/estado.ts");

function fakeElement() {
  return {
    value: "", textContent: "", innerHTML: "", dataset: {}, style: {}, disabled: false, hidden: false,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, click() {}, remove() {}, addEventListener() {},
    checkValidity() { return true; },
  };
}

function fakeDocument() {
  const elements = new Map();
  const listeners = {};
  const events = [];
  return {
    events,
    body: { classList: { toggle() {} }, appendChild() {} },
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
    SimpressFormDraftGuard: require("../../frontend/src/comum/form-draft-guard.ts"),
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
    preencherRepresentanteRegional: (tipo, cidade) => calls.push(["representante", tipo, cidade]),
    atualizarObrigatoriedadeDuracaoPausaEntrega() {},
    entregaAlmocoNaoFecha: () => false,
    formatarTelefoneBrasileiro: value => value,
    apiFetch: async () => ({ headers: { get: () => null }, blob: async () => ({}) }),
    copiarTextoParaAreaTransferencia: async () => {},
    fecharPainelCockpit() {},
    abrirModalAcessivel() {}, fecharModalAcessivel() {},
    confirmarAcao: async () => true,
    invalidarBuscasEquipamento() {}, limparSelecaoEquipamento() {},
  };
  const form = criarFormularioTransferencia({
    app, appState, motion: null, transferUtils, apiFetch: app.apiFetch,
    draftTracker: window.SimpressFormDraftGuard.createDraftTracker(),
  });
  return { form, app, appState, document, calls, toasts };
}

async function gerar(env, serial, cidadeUnidade) {
  env.appState.currentEquipamento = { serial };
  env.document.getElementById("input-serial").value = serial;
  env.document.getElementById("entrega-contato").value = "Destinatário Sintético";
  env.document.getElementById("entrega-email").value = "destinatario@example.test";
  env.document.getElementById("entrega-telefone").value = "(41) 90000-0000";
  env.document.getElementById("entrega-horario").value = "09:00 às 18:00";
  env.document.getElementById("entrega-almoco").value = "12:00";
  env.document.getElementById("entrega-pausa-duracao").value = "1h";
  env.document.getElementById("entrega-obs").value = "Observação sintética";
  env.document.getElementById("retirada-contato").value = "Contato sintético";
  env.document.getElementById("retirada-email").value = "retirada@example.test";
  env.document.getElementById("retirada-telefone").value = "(41) 90000-0001";
  env.document.getElementById("retirada-obs").value = "Observação sintética";
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
  assert.deepEqual(env.calls, [["selecionar", "SINT-001"], ["representante", "entrega", "Maringá"]]);
  assert.equal(env.document.getElementById("select-unidade-destino").value, "7");
  assert.equal(env.document.getElementById("entrega-endereco").value, "Rua Sintética, 1");
  assert.equal(env.document.getElementById("entrega-obs").value, "Cobertura SINT");
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

test("selecionarUnidadePorCidade compara a cidade inteira, sem acento e sem caixa", () => {
  const env = bootTransferForm();
  const escolhidas = [];
  env.app.preencherRepresentanteRegional = (tipo, cidade) => escolhidas.push([tipo, cidade]);
  const select = env.document.getElementById("select-unidade-destino");
  env.appState.unidadesList = [{ id: 1, cidade: "Campo Grande" }, { id: 2, cidade: "Campo" }, { id: 3, cidade: "São Paulo" }];
  env.form.selecionarUnidadePorCidade("Campo");
  env.form.selecionarUnidadePorCidade("  sao  PAULO ");
  assert.deepEqual(escolhidas, [["entrega", "Campo"], ["entrega", "São Paulo"]]);

  env.appState.unidadesList = [{ id: 1, cidade: "Campo Grande" }, { id: 4, cidade: "" }];
  select.value = "";
  env.form.selecionarUnidadePorCidade("Campo");
  env.form.selecionarUnidadePorCidade("   ");
  assert.equal(select.value, "");
  assert.deepEqual(escolhidas, [["entrega", "Campo"], ["entrega", "São Paulo"]]);
});

// ------------------------------------------------------------------ historico-transferencias/vinculo.ts: vínculo com a cobertura

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

// vinculo.ts guarda estado no módulo (pendências em memória e o ouvinte já registrado): cada teste importa uma
// instância nova (query diferente) e o apiFetch vira o fake publicado em globalThis.
const VINCULO = path.resolve(__dirname, "../../frontend/src/paineis/historico-transferencias/vinculo.ts");
Module.registerHooks({
  resolve(especificador, contexto, proximo) {
    const doVinculo = /historico-transferencias[\/]vinculo\.ts(\?.*)?$/.test(contexto.parentURL || "");
    if (doVinculo && especificador === "../../api") return { url: "simpress-teste:api", format: "module", shortCircuit: true };
    if (doVinculo && especificador === "./historico-transferencias-puro") return proximo(`${especificador}.ts`, contexto);
    return proximo(especificador, contexto);
  },
  load(url, contexto, proximo) {
    if (url === "simpress-teste:api") {
      return { format: "module", shortCircuit: true, source: "export const apiFetch = (...argumentos) => globalThis.__apiFetchFalso(...argumentos);" };
    }
    return proximo(url, contexto);
  },
});
const { ENDPOINT } = require("../../frontend/src/paineis/historico-transferencias/historico-transferencias-puro.ts");

let instancias = 0;
async function installHistory({ responses, storage = fakeStorage() }) {
  const document = fakeDocument();
  const requests = [];
  const toasts = [];
  const warns = [];
  Object.defineProperty(globalThis, "CustomEvent", { value: FakeCustomEvent, configurable: true, writable: true });
  global.document = document;
  global.window = { localStorage: storage, showToast: (message, type) => toasts.push([message, type]) };
  console.warn = (...argumentos) => warns.push(argumentos);
  // Resposta 2xx vira uma Response falsa; 4xx e 5xx viram o erro do apiFetch (status e data); Error puro é queda de rede.
  globalThis.__apiFetchFalso = async (url, opcoes = {}) => {
    requests.push({ url, body: opcoes.body ? JSON.parse(opcoes.body) : null });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next.status >= 400) throw Object.assign(new Error("erro"), { status: next.status, data: next.body });
    return { ok: true, status: next.status, text: async () => JSON.stringify(next.body) };
  };
  const vinculo = await import(`${pathToFileURL(VINCULO).href}?instancia=${instancias += 1}`);
  vinculo.registrarOuvinteTransferencia();
  return { vinculo, document, requests, toasts, warns, storage };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const PAYLOAD = { serial: "SINT-001", entrega_cidade: "Maringá" };
const ROTA = "/api/cobertura/movimentacoes/mov-1/registrar-transferencia";

function emitir(env, detail) {
  env.document.dispatchEvent(new FakeCustomEvent("simpress:transfer-generated", { detail }));
}

test("sem movimentação o histórico genérico continua igual", async () => {
  const env = await installHistory({ responses: [{ status: 201, body: {} }] });
  emitir(env, { payload: PAYLOAD });
  await tick();
  assert.deepEqual(env.requests.map(r => r.url), [ENDPOINT]);
  assert.deepEqual(env.requests[0].body, PAYLOAD);
});

test("com movimentação só a rota da cobertura é chamada e o sucesso avisa a tela", async () => {
  const env = await installHistory({ responses: [{ status: 200, body: { repetido: false } }] });
  emitir(env, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.deepEqual(env.requests.map(r => r.url), [ROTA]);
  assert.deepEqual(env.requests[0].body, { payload: PAYLOAD, chave: "chave-sint-001", rev: 2 });
  assert.ok(env.document.events.some(event => event.type === "simpress:cobertura-atualizada"));
  assert.deepEqual(env.vinculo.pendenciaSemVinculo(), []);
});

test("falha de rede guarda a pendência e a nova tentativa usa a MESMA chave", async () => {
  const env = await installHistory({ responses: [new Error("offline"), { status: 503, body: {} }, { status: 200, body: {} }] });
  emitir(env, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.ok(env.toasts.some(([message]) => message === "Planilha baixada sem vínculo — Tentar de novo"));
  const [pendente] = env.vinculo.pendenciaSemVinculo();
  assert.equal(pendente.chave, "chave-sint-001");
  assert.ok(env.storage.data.get("simpress:cobertura:sem-vinculo").includes("chave-sint-001"));

  const [falha] = await env.vinculo.tentarVincularDeNovo("mov-1");
  assert.equal(falha.pendente, true);
  const [ok] = await env.vinculo.tentarVincularDeNovo();
  assert.equal(ok.ok, true);
  assert.deepEqual(env.requests.map(r => r.body.chave), ["chave-sint-001", "chave-sint-001", "chave-sint-001"]);
  assert.equal(env.requests.every(r => r.url === ROTA), true);
  assert.deepEqual(env.vinculo.pendenciaSemVinculo(), []);
  assert.equal(env.storage.data.has("simpress:cobertura:sem-vinculo"), false);
});

test("repetido (200) de movimentação já cancelada limpa a pendência, avisa a tela e não grava no histórico genérico", async () => {
  const env = await installHistory({ responses: [new Error("offline"), { status: 200, body: { repetido: true } }] });
  emitir(env, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.equal(env.vinculo.pendenciaSemVinculo().length, 1);
  assert.ok(env.storage.data.has("simpress:cobertura:sem-vinculo"));

  const [ok] = await env.vinculo.tentarVincularDeNovo("mov-1");
  assert.equal(ok.ok, true);
  assert.deepEqual(env.vinculo.pendenciaSemVinculo(), []);
  assert.equal(env.storage.data.has("simpress:cobertura:sem-vinculo"), false);
  const avisos = env.document.events.filter(event => event.type === "simpress:cobertura-atualizada");
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].detail.repetido, true);
  assert.equal(env.requests.some(r => r.url === ENDPOINT), false);
});

for (const recusa of [
  { status: 409, body: { detail: { codigo: "chave_diferente", mensagem: "Chave diferente." } } },
  { status: 422, body: { detail: { codigo: "dados_divergentes", mensagem: "Série diferente." } } },
  { status: 404, body: { detail: { codigo: "nao_encontrado", mensagem: "Movimentação não encontrada." } } },
]) {
  test(`recusa definitiva ${recusa.status}: a planilha vai ao histórico genérico, o operador é avisado e a pendência some`, async () => {
    const env = await installHistory({ responses: [recusa, { status: 201, body: {} }] });
    emitir(env, { payload: PAYLOAD, movimentacao: MOV });
    for (let i = 0; i < 5; i += 1) await tick();
    assert.deepEqual(env.requests.map(r => r.url), [ROTA, ENDPOINT]);
    assert.deepEqual(env.requests[1].body, PAYLOAD);
    const aviso = env.toasts.find(([, type]) => type === "error");
    assert.ok(aviso[0].startsWith(recusa.body.detail.mensagem), aviso[0]);
    assert.ok(aviso[0].includes("Vincular transferência já gerada"), aviso[0]);
    assert.deepEqual(env.vinculo.pendenciaSemVinculo(), []);
  });
}

test("arquivo ocupado (409) guarda a pendência com a mesma chave e não grava no histórico genérico", async () => {
  const env = await installHistory({ responses: [{ status: 409, body: { detail: { codigo: "arquivo_ocupado", mensagem: "Ocupado." } } }] });
  emitir(env, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.deepEqual(env.requests.map(r => r.url), [ROTA]);
  const [pendente] = env.vinculo.pendenciaSemVinculo();
  assert.equal(pendente.chave, "chave-sint-001");
});

test("localStorage que lança erro ou guarda lixo não quebra o vínculo", async () => {
  const quebrado = await installHistory({ storage: fakeStorage({ throws: true }), responses: [new Error("offline"), { status: 200, body: {} }] });
  emitir(quebrado, { payload: PAYLOAD, movimentacao: MOV });
  await tick(); await tick();
  assert.equal(quebrado.vinculo.pendenciaSemVinculo().length, 1);
  const [ok] = await quebrado.vinculo.tentarVincularDeNovo("mov-1");
  assert.equal(ok.ok, true);

  const lixo = fakeStorage();
  lixo.data.set("simpress:cobertura:sem-vinculo", "{não é json");
  const env = await installHistory({ storage: lixo, responses: [] });
  assert.deepEqual(env.vinculo.pendenciaSemVinculo(), []);
});

test("Alterar Endereço: texto com os endereços reais e botão aceso só com série e os dois endereços", () => {
  const env = bootTransferForm();
  const botao = env.document.getElementById("btn-alterar-endereco");
  env.document.getElementById("retirada-endereco").value = "Rua Retirada, 10";
  env.form.atualizarBotaoAlterarEndereco();
  assert.equal(botao.disabled, true);
  assert.match(env.form.montarTextoAlterarEndereco().aviso, /Selecione o equipamento de origem/);

  env.document.getElementById("entrega-endereco").value = " Rua Entrega, 20 ";
  env.appState.retiradaCidadeSelecionada = "Curitiba";
  env.document.getElementById("select-unidade-destino").value = "7";
  env.form.atualizarBotaoAlterarEndereco();
  assert.equal(botao.disabled, true, "sem série o botão fica apagado");

  env.appState.currentEquipamento = { serial: "SINT-001" };
  env.document.getElementById("input-serial").value = "SINT-001";
  env.form.atualizarBotaoAlterarEndereco();
  assert.equal(botao.disabled, false, "não precisa de representante, telefone nem e-mail");
  assert.equal(env.form.serialAlterarEndereco(), "SINT-001");
  assert.equal(env.form.montarTextoAlterarEndereco().texto,
    "Prezados,\n\nSolicito alteração do endereço do equipamento da Unidade de Curitiba/PR para Maringá/PR.");
});
