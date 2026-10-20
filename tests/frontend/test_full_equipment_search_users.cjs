const assert = require("node:assert/strict");
const test = require("node:test");

const createFullEquipmentSearch = require("../../static/js/features/full-equipment-search.js");

function fakeElement(id) {
  const classes = new Set();
  return {
    id, value: "", textContent: "", disabled: false, scrollTop: 0, options: [],
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, force) => (force ?? !classes.has(name)) ? classes.add(name) : classes.delete(name),
      contains: name => classes.has(name),
    },
    setAttribute() {}, removeAttribute() {},
    replaceChildren(...children) { this.options = children; this.children = children; },
    add(option) { this.options.push(option); },
    appendChild(child) { (this.children = this.children || []).push(child); return child; },
  };
}

function setup(page) {
  const elements = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
  };
  globalThis.Option = function Option(text, value) { return { text, value }; };
  globalThis.lucide = { createIcons() {} };
  const requests = [];
  const toasts = [];
  const app = {
    apiFetch: async url => { requests.push(url); return page(url); },
    showToast: (message, type) => toasts.push({ message, type }),
    abrirModalAcessivel() {}, fecharAutocomplete() {}, fecharModalAcessivel() {},
  };
  const feature = createFullEquipmentSearch({
    app,
    motion: null,
    dom: { pluralize: (count, word) => (count === 1 ? word : `${word}s`) },
    equipmentSearchRenderer: () => ({ criarLinhaPesquisaCompleta: item => ({ item }) }),
  });
  app.alterarFiltrosPesquisaCompleta = feature.alterarFiltrosPesquisaCompleta;
  return { feature, requests, toasts, el: id => globalThis.document.getElementById(id) };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const pageWith = (items, users = { sem: items.length, com: 3 }) => () => ({
  items, total: items.length, has_more: false, filters: { categories: [], cities: [], users },
});

test("the Home shortcut lists the base without a term, filtered to equipment without a user", async () => {
  const { feature, requests, el } = setup(pageWith([{ serial: "BRJ002" }, { serial: "BRJ004" }]));
  feature.abrirEquipamentosSemUsuario();
  await flush();

  const params = new URL(requests[0], "http://local").searchParams;
  assert.equal(params.get("q"), "");
  assert.equal(params.get("usuario"), "sem");
  assert.equal(el("pesquisa-completa-termo").textContent, "Todos os equipamentos");
  assert.equal(el("pesquisa-completa-contagem").textContent, "2 resultados");
  assert.deepEqual(el("filtro-pesquisa-usuario").options.map(option => option.text),
    ["Todos os usuários", "Sem usuário (2)", "Com usuário (3)"]);
  assert.equal(el("filtro-pesquisa-usuario").value, "sem");
  assert.equal(el("filtro-pesquisa-usuario").disabled, false);
  // "Sem usuário" is the listing itself here, so there is nothing to clear.
  assert.equal(el("btn-limpar-filtros-pesquisa").classList.contains("hidden"), true);
});

test("without a term the user filter cannot switch away from the without-user listing", async () => {
  const { feature, requests, toasts, el } = setup(pageWith([]));
  feature.abrirEquipamentosSemUsuario();
  await flush();
  assert.equal(el("pesquisa-completa-status").textContent, "Nenhum equipamento a listar: notebooks sem usuário e demais equipamentos (exceto fones e micro computador).");

  el("filtro-pesquisa-usuario").value = "com";
  feature.alterarFiltrosPesquisaCompleta();
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(el("filtro-pesquisa-usuario").value, "sem");
  assert.equal(toasts.at(-1).type, "warning");
});

test("a search with a term sends the chosen user filter and can clear it", async () => {
  const { feature, requests, el } = setup(pageWith([{ serial: "BRJ001" }]));
  el("input-serial").value = "BRJ";
  feature.abrirPesquisaCompleta();
  await flush();
  assert.equal(new URL(requests[0], "http://local").searchParams.get("usuario"), null);

  el("filtro-pesquisa-usuario").value = "sem";
  feature.alterarFiltrosPesquisaCompleta();
  await flush();
  const params = new URL(requests[1], "http://local").searchParams;
  assert.equal(params.get("q"), "BRJ");
  assert.equal(params.get("usuario"), "sem");
  assert.equal(el("btn-limpar-filtros-pesquisa").classList.contains("hidden"), false);

  feature.limparFiltrosPesquisaCompleta();
  await flush();
  assert.equal(new URL(requests[2], "http://local").searchParams.get("usuario"), null);
  assert.equal(el("btn-limpar-filtros-pesquisa").classList.contains("hidden"), true);
});
