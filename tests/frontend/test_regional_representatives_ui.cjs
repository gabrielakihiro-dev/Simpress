const assert = require("node:assert/strict");
const test = require("node:test");
const apiErrors = require("../../static/js/shared/api-errors.js");
const transferUtils = require("../../static/js/shared/transfer-utils.js");
const createRegionalContacts = require("../../static/js/features/regional-contacts.js");

function fakeElement() {
  const attrs = {};
  return {
    value: "", textContent: "", disabled: false, checked: false, dataset: {}, options: [], attrs,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(name, value) { attrs[name] = value; }, removeAttribute(name) { delete attrs[name]; },
    getAttribute: name => attrs[name] ?? null, addEventListener() {}, focus() {},
    replaceChildren(...children) { this.options = [...children]; }, appendChild(child) { this.options.push(child); return child; },
  };
}

// A slice of GET /api/config/representantes-regionais `padroes` (the backend owns the full list of 22).
const PADROES = [
  { cidade: "Cascavel", nome: "Carla Exemplo Teste", email: "carla.exemplo@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" },
  { cidade: "Londrina", nome: "Rita Exemplo de Oliveira Teste", email: "rita.exemplo@pr.sebrae.com.br", telefone: "(41) 90000-0000", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" },
  { cidade: "Maringá", nome: "Tereza Exemplar Santos", email: "tereza.exemplar@pr.sebrae.com.br", telefone: "(41) 90000-0001", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" },
  { cidade: "Foz do Iguaçu", nome: "Marlene Modelo", email: "marlene.modelo@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "1h30" },
  { cidade: "Toledo", nome: "Tania da Costa Fictícia", email: "tania.ficticia@pr.sebrae.com.br", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "1h30" },
  { cidade: "Arapongas", nome: "", nomeOpcao: "Não definido ainda", email: "", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" },
];

// Boots the feature with a fake DOM and a fetch stub; `saved` is the server-side edit store.
// `manualTimers`: the retry delay waits for `env.timers.shift().fn()`; otherwise it fires at once (no real 2 s wait).
function setup({ saved = {}, fetchImpl, manualTimers = false } = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, fakeElement()); return elements.get(id); };
  const toasts = [];
  const calls = [];
  const app = {
    createApiError: apiErrors.create,
    formatarTelefoneBrasileiro: transferUtils.formatBrazilPhone,
    atualizarObrigatoriedadeDuracaoPausaEntrega() {},
    abrirModalAcessivel() {}, fecharModalAcessivel() {},
    showToast: (message, kind) => toasts.push([message, kind]),
    confirmarAcao: async () => true,
  };
  const timers = [];
  const previous = { document: global.document, fetch: global.fetch, setTimeout: global.setTimeout };
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); if (!manualTimers) queueMicrotask(() => timers.shift().fn()); };
  global.document = { getElementById: get, createElement: fakeElement };
  global.fetch = fetchImpl || (async () => ({ ok: true, json: async () => ({ alteracoes: saved, padroes: PADROES, arquivo_invalido: false }) }));
  const feature = createRegionalContacts({ app, transferUtils });
  Object.assign(app, feature);
  const restore = () => { global.document = previous.document; global.fetch = previous.fetch; global.setTimeout = previous.setTimeout; };
  return { feature, get, toasts, calls, timers, restore };
}

const nomeNaLista = (select, cidade) => select.options.find(o => o.value === cidade)?.textContent;

test("merges the saved edit over the immutable default per city", async t => {
  const env = setup({ saved: { Londrina: { nome: "Nova Pessoa", email: "nova@pr.sebrae.com.br", telefone: "", horario: "09:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "1h" } } });
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  const londrina = env.get("retirada-representante");
  assert.equal(nomeNaLista(londrina, "Londrina"), "Nova Pessoa — Londrina");
  assert.equal(nomeNaLista(londrina, "Maringá"), "Tereza Exemplar Santos — Maringá");
  env.feature.preencherRepresentanteRegional("retirada", "Londrina", true);
  assert.equal(env.get("retirada-contato").value, "Nova Pessoa");
  assert.equal(env.get("retirada-horario").value, "09:00:00 às 17:00:00");
});

test("Arapongas shows the placeholder only while the merged name is empty", async t => {
  const env = setup();
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  assert.equal(nomeNaLista(env.get("entrega-representante"), "Arapongas"), "Não definido ainda — Arapongas");
  const maria = { nome: "Maria Teste", email: "", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" };
  global.fetch = async () => ({ ok: true, json: async () => ({ alteracoes: { Arapongas: maria }, padroes: PADROES, arquivo_invalido: false }) });
  await env.feature.carregarRepresentantesRegionais();
  assert.equal(nomeNaLista(env.get("entrega-representante"), "Arapongas"), "Maria Teste — Arapongas");
});

test("saving keeps each chosen city, re-fills only the form showing the edited city and composes the expediente", async t => {
  const env = setup();
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  env.feature.preencherRepresentanteRegional("retirada", "Londrina", true);
  env.feature.preencherRepresentanteRegional("entrega", "Maringá", true);
  env.get("entrega-contato").value = "Digitado a mão";
  env.feature.abrirEdicaoRepresentanteRegional("retirada");
  assert.equal(env.get("representante-regional-inicio").value, "08:00:00");
  assert.equal(env.get("representante-regional-almoco-nao-fecha").checked, true);
  env.get("representante-regional-nome").value = "Editada";
  env.get("representante-regional-inicio").value = "09:30";
  env.get("representante-regional-fim").value = "17:45:10";
  env.get("representante-regional-almoco-nao-fecha").checked = false;
  env.get("representante-regional-almoco").value = "12:15";
  env.get("representante-regional-pausa").value = "1h30";
  global.fetch = async (url, init) => {
    env.calls.push([init.method, url, JSON.parse(init.body)]);
    return { ok: true, json: async () => ({ alteracoes: { Londrina: JSON.parse(init.body) }, arquivo_invalido: false }) };
  };
  await env.feature.salvarRepresentanteRegional();
  assert.deepEqual(env.calls.at(-1), ["PUT", "/api/config/representantes-regionais/Londrina", {
    nome: "Editada", email: "rita.exemplo@pr.sebrae.com.br", telefone: "(41) 90000-0000",
    horario: "09:30:00 às 17:45:10", almoco: "12:15:00", pausaDuracao: "1h30",
  }]);
  assert.equal(env.get("retirada-representante").value, "Londrina");
  assert.equal(env.get("entrega-representante").value, "Maringá");
  assert.equal(env.get("retirada-contato").value, "Editada");
  assert.equal(env.get("entrega-contato").value, "Digitado a mão");
  assert.deepEqual(env.toasts, [["Representante salvo.", "success"]]);
});

test("encodes the city and removes the Value error prefix from validation messages", async t => {
  const env = setup();
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  env.feature.preencherRepresentanteRegional("retirada", "Foz do Iguaçu", true);
  env.feature.abrirEdicaoRepresentanteRegional("retirada");
  global.fetch = async url => {
    env.calls.push(["PUT", url]);
    return { ok: false, json: async () => ({ detail: [{ msg: "Value error, Informe um e-mail válido." }, { msg: "Value error, Telefone inválido." }] }) };
  };
  await env.feature.salvarRepresentanteRegional();
  assert.equal(env.calls.at(-1)[1], "/api/config/representantes-regionais/Foz%20do%20Igua%C3%A7u");
  assert.equal(env.get("status-representante-regional").textContent, "Informe um e-mail válido.; Telefone inválido.");
  assert.equal(env.get("status-representante-regional").attrs.role, "alert");
  assert.deepEqual(env.toasts, []);
  assert.equal(env.get("btn-salvar-representante-regional").disabled, false);
});

test("Editar is disabled without a city and enabled once one is chosen", async t => {
  const env = setup();
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  env.feature.preencherRepresentanteRegional("entrega", "", false);
  assert.equal(env.get("btn-editar-representante-entrega").disabled, true);
  env.feature.handleRepresentanteRegionalChange("entrega", "Toledo");
  assert.equal(env.get("btn-editar-representante-entrega").disabled, false);
  env.feature.abrirEdicaoRepresentanteRegional("retirada");
  assert.equal(env.get("representante-regional-nome").value, "", "no city selected: dialog stays untouched");
});

test("Restaurar padrão is disabled without a saved edit and sends DELETE when there is one", async t => {
  const edit = { nome: "X", email: "", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "1h" };
  const env = setup({ saved: { Toledo: edit } });
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  env.feature.preencherRepresentanteRegional("retirada", "Cascavel", true);
  env.feature.abrirEdicaoRepresentanteRegional("retirada");
  assert.equal(env.get("btn-restaurar-representante-regional").disabled, true);
  env.feature.preencherRepresentanteRegional("retirada", "Toledo", true);
  env.feature.abrirEdicaoRepresentanteRegional("retirada");
  assert.equal(env.get("btn-restaurar-representante-regional").disabled, false);
  global.fetch = async (url, init) => {
    env.calls.push([init.method, url]);
    return { ok: true, json: async () => ({ alteracoes: {}, arquivo_invalido: false }) };
  };
  await env.feature.restaurarRepresentanteRegional();
  assert.deepEqual(env.calls.at(-1), ["DELETE", "/api/config/representantes-regionais/Toledo"]);
  assert.equal(env.get("retirada-contato").value, "Tania da Costa Fictícia");
  assert.deepEqual(env.toasts, [["Padrão restaurado.", "success"]]);
});

function quietWarn(t) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = warn; });
  return warnings;
}

test("a failed first load leaves the selectors empty, shows one toast and does not break the form", async t => {
  const env = setup({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  const warnings = quietWarn(t);
  t.after(env.restore);
  env.feature.popularSeletoresRepresentantesRegionais();
  await env.feature.carregarRepresentantesRegionais();
  assert.equal(warnings.length, 2, "first attempt and the single retry");
  assert.deepEqual(env.toasts, [["Não foi possível carregar os representantes regionais. Recarregue a página.", "warning"]]);
  assert.deepEqual(env.get("retirada-representante").options.map(o => o.value), [""]);
  assert.equal(env.feature.preencherRepresentanteRegional("retirada", "Londrina", true), null);
  assert.equal(env.get("retirada-contato").value, "");
  assert.equal(env.get("btn-editar-representante-retirada").disabled, true);
  env.feature.abrirEdicaoRepresentanteRegional("retirada");
  assert.equal(env.get("representante-regional-nome").value, "", "no defaults: the dialog stays untouched");
});

test("a first answer without the defaults counts as a failed load", async t => {
  const env = setup({ fetchImpl: async () => ({ ok: true, json: async () => ({ alteracoes: {}, arquivo_invalido: false }) }) });
  const warnings = quietWarn(t);
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  assert.equal(warnings.length, 2);
  assert.equal(env.toasts.length, 1);
  assert.equal(env.feature.preencherRepresentanteRegional("retirada", "Londrina", true), null);
});

test("a failed first load is retried once after 2 s; the second success shows no toast and replays pendentes", async t => {
  const answers = [async () => { throw new TypeError("Failed to fetch"); }, async () => ({ ok: true, json: async () => ({ alteracoes: {}, padroes: PADROES, arquivo_invalido: false }) })];
  let requests = 0;
  const env = setup({ manualTimers: true, fetchImpl: () => answers[requests++]() });
  const warnings = quietWarn(t);
  t.after(env.restore);
  env.feature.preencherRepresentanteRegional("retirada", "Londrina");
  const carga = env.feature.carregarRepresentantesRegionais();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.deepEqual(env.timers.map(timer => timer.ms), [2000]);
  assert.equal(env.feature.carregarRepresentantesRegionais(), carga, "a load in progress is reused, not duplicated");
  assert.equal(requests, 1);
  assert.deepEqual(env.toasts, []);
  env.timers.shift().fn();
  await carga;
  assert.equal(requests, 2);
  assert.equal(warnings.length, 1);
  assert.deepEqual(env.toasts, []);
  assert.equal(env.get("retirada-representante").value, "Londrina");
  assert.equal(env.get("retirada-contato").value, "Rita Exemplo de Oliveira Teste");
  assert.equal(env.get("btn-editar-representante-retirada").disabled, false);
});

test("two failed attempts show the toast only once and make no third request", async t => {
  let requests = 0;
  const env = setup({ fetchImpl: async () => { requests += 1; return { ok: false, json: async () => ({}) }; } });
  quietWarn(t);
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  assert.equal(requests, 2);
  assert.deepEqual(env.toasts, [["Não foi possível carregar os representantes regionais. Recarregue a página.", "warning"]]);
  assert.deepEqual(env.timers, []);
});

test("a successful first load makes a single request and sets no timer", async t => {
  let requests = 0;
  const env = setup({ fetchImpl: async () => { requests += 1; return { ok: true, json: async () => ({ alteracoes: {}, padroes: PADROES, arquivo_invalido: false }) }; } });
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  assert.equal(requests, 1);
  assert.deepEqual(env.timers, []);
  assert.deepEqual(env.toasts, []);
});

test("a later failed reload keeps the loaded defaults and only warns", async t => {
  const env = setup();
  const warnings = quietWarn(t);
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  await env.feature.carregarRepresentantesRegionais(true);
  assert.equal(warnings.length, 1);
  assert.deepEqual(env.toasts, []);
  assert.equal(nomeNaLista(env.get("retirada-representante"), "Londrina"), "Rita Exemplo de Oliveira Teste — Londrina");
});

test("fills requested before the defaults arrive are replayed once they load", async t => {
  const env = setup();
  t.after(env.restore);
  // Equipment search / destination unit ran before the first GET answered: nothing to match yet.
  assert.equal(env.feature.preencherRepresentanteRegional("retirada", "Londrina"), null);
  env.feature.preencherRepresentanteRegional("entrega", "Maringá");
  env.feature.preencherRepresentanteRegional("entrega", "");
  assert.equal(env.get("retirada-contato").value, "");
  await env.feature.carregarRepresentantesRegionais();
  assert.equal(env.get("retirada-representante").value, "Londrina");
  assert.equal(env.get("retirada-contato").value, "Rita Exemplo de Oliveira Teste");
  assert.equal(env.get("retirada-telefone").value, "(41) 90000-0000");
  assert.equal(env.get("entrega-representante").value, "", "a city cleared meanwhile is not replayed");
  assert.equal(env.get("entrega-contato").value, "");
  assert.equal(env.get("btn-editar-representante-retirada").disabled, false);
});

test("a reload requested by the assistant re-fills only the form showing the city that changed", async t => {
  const env = setup();
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  env.feature.preencherRepresentanteRegional("retirada", "Londrina", true);
  env.feature.preencherRepresentanteRegional("entrega", "Maringá", true);
  env.get("entrega-contato").value = "Digitado a mão";
  const londrina = { nome: "Nova Pessoa", email: "nova@pr.sebrae.com.br", telefone: "", horario: "09:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "1h" };
  global.fetch = async () => ({ ok: true, json: async () => ({ alteracoes: { Londrina: londrina }, arquivo_invalido: false }) });
  await env.feature.carregarRepresentantesRegionais(true);
  assert.equal(env.get("retirada-contato").value, "Nova Pessoa");
  assert.equal(env.get("retirada-horario").value, "09:00:00 às 17:00:00");
  assert.equal(env.get("entrega-contato").value, "Digitado a mão");
});

const londrinaPadrao = { nome: "Rita Exemplo de Oliveira Teste", email: "rita.exemplo@pr.sebrae.com.br", telefone: "(41) 90000-0000", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" };

async function recarregarComo(env, londrina) {
  global.fetch = async () => ({ ok: true, json: async () => ({ alteracoes: { Londrina: londrina }, arquivo_invalido: false }) });
  await env.feature.carregarRepresentantesRegionais(true);
}

test("a reload by the assistant updates untouched fields and keeps silent when nothing was typed", async t => {
  const env = setup();
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  env.feature.preencherRepresentanteRegional("retirada", "Londrina", true);
  await recarregarComo(env, { ...londrinaPadrao, nome: "Nova Pessoa", horario: "09:00:00 às 17:00:00" });
  assert.equal(env.get("retirada-contato").value, "Nova Pessoa");
  assert.equal(env.get("retirada-horario").value, "09:00:00 às 17:00:00");
  assert.equal(env.get("retirada-telefone").value, "(41) 90000-0000");
  assert.deepEqual(env.toasts, []);
});

test("a hand-typed field is kept without warning when the representative did not change that field", async t => {
  const env = setup();
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  env.feature.preencherRepresentanteRegional("retirada", "Londrina", true);
  env.get("retirada-telefone").value = "(43) 90000-0000";
  await recarregarComo(env, { ...londrinaPadrao, horario: "09:00:00 às 17:00:00" });
  assert.equal(env.get("retirada-horario").value, "09:00:00 às 17:00:00");
  assert.equal(env.get("retirada-telefone").value, "(43) 90000-0000");
  assert.deepEqual(env.toasts, []);
});

test("a hand-typed field that the assistant also changed is kept and a short warning names it; the others still update", async t => {
  const env = setup();
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  env.feature.preencherRepresentanteRegional("retirada", "Londrina", true);
  env.get("retirada-telefone").value = "(43) 90000-0000";
  await recarregarComo(env, { ...londrinaPadrao, nome: "Nova Pessoa", telefone: "(43) 98888-7777" });
  assert.equal(env.get("retirada-contato").value, "Nova Pessoa");
  assert.equal(env.get("retirada-telefone").value, "(43) 90000-0000");
  assert.deepEqual(env.toasts, [["O campo Celular de Londrina (Retirada) foi mantido porque foi editado à mão.", "warning"]]);
  // The next reload changing only another field does not repeat the warning, and the typed value stays.
  env.toasts.length = 0;
  await recarregarComo(env, { ...londrinaPadrao, nome: "Outra Pessoa", telefone: "(43) 98888-7777" });
  assert.equal(env.get("retirada-contato").value, "Outra Pessoa");
  assert.equal(env.get("retirada-telefone").value, "(43) 90000-0000");
  assert.deepEqual(env.toasts, []);
});

test("saving in the dialog follows the same rule: edited fields are kept with a warning", async t => {
  const env = setup();
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  env.feature.preencherRepresentanteRegional("retirada", "Londrina", true);
  env.get("retirada-email").value = "extra@exemplo.com";
  env.get("retirada-horario").value = "07:00:00 às 16:00:00";
  env.feature.abrirEdicaoRepresentanteRegional("retirada");
  env.get("representante-regional-nome").value = "Editada";
  env.get("representante-regional-email").value = "editada@pr.sebrae.com.br";
  env.get("representante-regional-inicio").value = "09:00:00";
  env.get("representante-regional-fim").value = "17:00:00";
  global.fetch = async (url, init) => ({ ok: true, json: async () => ({ alteracoes: { Londrina: JSON.parse(init.body) }, arquivo_invalido: false }) });
  await env.feature.salvarRepresentanteRegional();
  assert.equal(env.get("retirada-contato").value, "Editada");
  assert.equal(env.get("retirada-email").value, "extra@exemplo.com");
  assert.equal(env.get("retirada-horario").value, "07:00:00 às 16:00:00");
  assert.deepEqual(env.toasts, [
    ["Os campos E-mail e Expediente de Londrina (Retirada) foram mantidos porque foram editados à mão.", "warning"],
    ["Representante salvo.", "success"],
  ]);
});
