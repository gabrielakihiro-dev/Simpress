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

// Boots the feature with a fake DOM and a fetch stub; `saved` is the server-side edit store.
function setup({ saved = {}, fetchImpl } = {}) {
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
  const previous = { document: global.document, fetch: global.fetch };
  global.document = { getElementById: get, createElement: fakeElement };
  global.fetch = fetchImpl || (async () => ({ ok: true, json: async () => ({ alteracoes: saved, arquivo_invalido: false }) }));
  const feature = createRegionalContacts({ app, transferUtils });
  Object.assign(app, feature);
  const restore = () => { global.document = previous.document; global.fetch = previous.fetch; };
  return { feature, get, toasts, calls, restore };
}

const nomeNaLista = (select, cidade) => select.options.find(o => o.value === cidade)?.textContent;

test("merges the saved edit over the immutable default per city", async t => {
  const env = setup({ saved: { Londrina: { nome: "Nova Pessoa", email: "nova@pr.sebrae.com.br", telefone: "", horario: "09:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "1h" } } });
  t.after(env.restore);
  await env.feature.carregarRepresentantesRegionais();
  const londrina = env.get("retirada-representante");
  assert.equal(nomeNaLista(londrina, "Londrina"), "Nova Pessoa — Londrina");
  assert.equal(nomeNaLista(londrina, "Maringá"), "Tatiane Matsuguma Sanches — Maringá");
  env.feature.preencherRepresentanteRegional("retirada", "Londrina", true);
  assert.equal(env.get("retirada-contato").value, "Nova Pessoa");
  assert.equal(env.get("retirada-horario").value, "09:00:00 às 17:00:00");
});

test("Arapongas shows the placeholder only while the merged name is empty", async t => {
  const env = setup({ saved: { Arapongas: { nome: "Maria Teste", email: "", telefone: "", horario: "08:00:00 às 18:00:00", almoco: "12:00:00", pausaDuracao: "2h" } } });
  t.after(env.restore);
  env.feature.popularSeletoresRepresentantesRegionais();
  assert.equal(nomeNaLista(env.get("entrega-representante"), "Arapongas"), "Não definido ainda — Arapongas");
  await env.feature.carregarRepresentantesRegionais();
  assert.equal(nomeNaLista(env.get("entrega-representante"), "Arapongas"), "Maria Teste — Arapongas");
});

test("saving keeps each chosen city, re-fills only the form showing the edited city and composes the expediente", async t => {
  const env = setup();
  t.after(env.restore);
  env.feature.popularSeletoresRepresentantesRegionais();
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
    nome: "Editada", email: "rvarasquim@pr.sebrae.com.br", telefone: "(43) 99643-8754",
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
  env.feature.popularSeletoresRepresentantesRegionais();
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

test("Editar is disabled without a city and enabled once one is chosen", t => {
  const env = setup();
  t.after(env.restore);
  env.feature.popularSeletoresRepresentantesRegionais();
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
  assert.equal(env.get("retirada-contato").value, "Fernanda da Costa Goldacker");
  assert.deepEqual(env.toasts, [["Padrão restaurado.", "success"]]);
});

test("a failed load keeps the default list and only warns", async t => {
  const env = setup({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = warn; env.restore(); });
  env.feature.popularSeletoresRepresentantesRegionais();
  await env.feature.carregarRepresentantesRegionais();
  assert.equal(warnings.length, 1);
  assert.equal(nomeNaLista(env.get("retirada-representante"), "Londrina"), "Renata Custodio de Oliveira Varasquim — Londrina");
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
