const assert = require("node:assert/strict");
const test = require("node:test");

const createEquipmentSearch = require("../../static/js/features/equipment-search.js");
const transferUtils = require("../../static/js/shared/transfer-utils.js");

function fakeElement(id) {
  const classes = new Set();
  return {
    id, value: "", innerHTML: "", textContent: "",
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name), toggle() {},
    },
    setAttribute() {}, removeAttribute() {}, replaceChildren() {}, appendChild() {}, append() {}, style: { setProperty() {} }, focus() {}, querySelector: () => fakeElement("child"),
    getBoundingClientRect: () => ({ top: 0 }),
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("a search without results offers the closest user name and clicking it searches again", async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  // The home list is not rendered here, so carregarListaHome returns right away.
  globalThis.document = { addEventListener() {}, getElementById: id => (id === "home-equipment-list" ? null : element(id)) };
  globalThis.window = { innerHeight: 800, localStorage: {}, matchMedia: () => ({ matches: false }), addEventListener() {}, visualViewport: null };
  globalThis.lucide = { createIcons() {} };
  globalThis.escapeHtml = value => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(url);
    const typo = url.includes("q=bpinheirp");
    return { ok: true, json: async () => ({ items: [], total: 0, has_more: false, sugestao: typo ? "bpinheiro" : "" }) };
  };
  const app = new Proxy({
    invalidarBuscasEquipamento() {}, limparSelecaoEquipamento() {}, fecharAutocomplete() {}, showToast() {},
  }, { get: (target, name) => target[name] ?? (() => {}) });
  const feature = createEquipmentSearch({
    app, appState: {}, motion: null, transferUtils, recentEquipment: null,
    dom: { createTextElement: () => ({}) },
    equipmentSearchRenderer: () => ({ criarLinhaAutocomplete: () => fakeElement("row") }),
  });

  element("input-serial").value = "bpinheirp";
  feature.handleSerialInput("bpinheirp");
  await wait(300);
  const html = element("autocomplete-empty-state").innerHTML;
  assert.match(html, /Você quis dizer/);
  assert.match(html, /data-on-click="aplicarSugestaoBusca"/);
  assert.match(html, /data-sugestao="bpinheiro"/);

  feature.aplicarSugestaoBusca({ dataset: { sugestao: "bpinheiro" } });
  await wait(300);
  assert.equal(element("input-serial").value, "bpinheiro");
  assert.ok(requests.some(url => url.includes("q=bpinheiro&")));
  assert.doesNotMatch(element("autocomplete-empty-state").innerHTML, /Você quis dizer/);
});
