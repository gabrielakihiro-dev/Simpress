const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const transferUtils = require("../../../static/js/shared/transfer-utils.js");
const catalogSearch = require("../../../static/js/shared/catalog-search-utils.js");
const formDraftGuard = require("../../../static/js/shared/form-draft-guard.js");
const annotationAutosave = require("../../../static/js/shared/history-annotation-autosave.js");
const accessibleDialogs = require("../../../static/js/ui/accessible-dialogs.js");
const notifications = require("../../../static/js/ui/ui-notifications.js");

const { appScripts, appSource } = require("./app-sources.cjs");

const appScript = appSource();
const appHtml = fs.readFileSync(path.join(__dirname, "..", "..", "..", "static", "index.html"), "utf8");
const appCss = fs.readFileSync(path.join(__dirname, "..", "..", "..", "static", "app.css"), "utf8");

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
    this.disabled = false;
    this.checked = false;
    this.isConnected = true;
    this.files = [];
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.focused = false;
    this.clicked = false;
    this.isValid = true;
    this.scrollIntoViewOptions = null;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      },
    };
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(type) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this });
  }
  click() { this.clicked = true; }
  remove() { this.isConnected = false; }
  replaceChildren(...children) { this.children = children; }
  appendChild(child) { this.children.push(child); return child; }
  querySelector() { return null; }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrollIntoViewOptions = options; }
  checkValidity() { return this.isValid; }
  closest() { return null; }
  getClientRects() { return [1]; }
}

class FakeTemplate extends FakeElement {
  set innerHTML(value) { this.markup = String(value); }
  get innerHTML() { return this.markup || ""; }
  get content() {
    const markup = this.innerHTML;
    return {
      querySelector: selector => {
        if (selector !== "tr") return null;
        const cells = [...markup.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => {
          const html = match[1];
          return {
            innerHTML: html,
            textContent: html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim(),
            querySelector: () => null,
            hasAttribute: () => false,
          };
        });
        return { cells, dataset: {}, hasAttribute: () => false, getAttribute: () => null };
      },
    };
  }
}

class FakeFormData {
  constructor() { this.fields = []; }
  append(...args) { this.fields.push(args); }
}

function createAppHarness(fetchApi, { stubDisplay = true, confirmResult = true, localStorage = new Map() } = {}) {
  const elements = new Map();
  const effects = {
    comparisons: [],
    clipboardWrites: [],
    toasts: [],
    refreshes: [],
    displays: [],
    confirmations: [],
    focusedSelectors: [],
  };
  const document = {
    body: new FakeElement("body"),
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    createElement: tag => tag === "template" ? new FakeTemplate(tag) : new FakeElement(tag),
    querySelectorAll: () => [],
    querySelector(selector) {
      effects.focusedSelectors.push(selector);
      return new FakeElement(selector);
    },
  };
  const window = {
    document,
    SimpressDomUtils: require("../../../static/js/shared/dom-utils.js"),
    SimpressTransferUtils: transferUtils,
    SimpressCatalogSearch: catalogSearch,
    SimpressFormDraftGuard: formDraftGuard,
    HistoryAnnotationAutosave: annotationAutosave,
    SimpressAccessibleDialogs: accessibleDialogs,
    SimpressNotifications: notifications,
    URL: { createObjectURL: () => "blob:ficticio", revokeObjectURL() {} },
    localStorage: {
      getItem: key => localStorage.get(key) ?? null,
      setItem: (key, value) => localStorage.set(key, String(value)),
    },
    matchMedia: () => ({ matches: false }),
    confirm: message => { effects.confirmations.push(message); return confirmResult; },
    setTimeout,
    clearTimeout,
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    window,
    navigator: { clipboard: { writeText: async text => effects.clipboardWrites.push(text) } },
    fetch: (...args) => fetchApi(...args),
    navigator: { clipboard: { writeText: async text => effects.clipboardWrites.push(text) } },
    FormData: FakeFormData,
    HTMLElement: FakeElement,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: callback => callback(0),
    MutationObserver: class { observe() {} disconnect() {} },
    lucide: { createIcons() {} },
    console: { error() {}, warn() {}, log() {} },
    workflowEffects: effects,
  });

  for (const { file, source } of appScripts()) vm.runInContext(source, context, { filename: file });
  context.renderComparisonForTest = context.abrirModalComparacaoPlanilhas;
  vm.runInContext(`
    preencherRepresentanteRegional = () => {};
    showToast = (message, type) => workflowEffects.toasts.push({ message, type });
    abrirModalComparacaoPlanilhas = comparison => workflowEffects.comparisons.push(comparison);
    carregarEstatisticas = async () => workflowEffects.refreshes.push("estatisticas");
    carregarUnidades = async () => workflowEffects.refreshes.push("unidades");
    carregarContagemHistoricoComparacoes = async () => workflowEffects.refreshes.push("contagem-historico");
    carregarHistoricoComparacoes = async () => workflowEffects.refreshes.push("historico");
  `, context);
  if (stubDisplay) {
    vm.runInContext(`
      exibirEquipamento = equipment => {
        workflowEffects.displays.push(equipment);
        document.getElementById("card-equipamento").classList.remove("hidden");
        document.getElementById("retirada-endereco").value = equipment.retirada_endereco || "";
      };
    `, context);
  }

  return {
    context,
    effects,
    localStorage,
    element: id => document.getElementById(id),
    run: source => vm.runInContext(source, context),
    selectEquipment(equipment) {
      context.workflowEquipment = equipment;
      vm.runInContext(`
        definirEquipamentoAtual(workflowEquipment);
        SimpressApp.state.retiradaCidadeSelecionada = workflowEquipment.retirada_cidade || "";
      `, context);
      document.getElementById("input-serial").value = equipment.serial;
      document.getElementById("retirada-endereco").value = equipment.retirada_endereco || "";
      document.getElementById("card-equipamento").classList.remove("hidden");
    },
  };
}

function apiResponse(body, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { ok, status, json: async () => body };
}

function pendingTicketResponse() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function ticketSelectionHarness(fetchApi) {
  const harness = createAppHarness(fetchApi);
  harness.run(`
    renderizarAcompanhamentoChamados = () => {
      document.getElementById("lista-acompanhamento-chamados").innerHTML = SimpressApp.state.acompanhamentoChamadosAtual?.snapshot_id || "Importe as duas planilhas";
    };
    carregarEvolucaoChamados = async () => {};
  `);
  return harness;
}

function setButton(harness, button, label) {
  button.textContent = label;
  button.isConnected = true;
  harness.context.restoreButton = button;
}

const priorEquipment = {
  serial: "SERIE-ANTIGA",
  modelo: "Modelo anterior",
  retirada_cidade: "Maringá",
  retirada_endereco: "Rua antiga, 10",
};

module.exports = {
  setButton,
  priorEquipment,
  assert,
  fs,
  path,
  vm,
  transferUtils,
  catalogSearch,
  formDraftGuard,
  annotationAutosave,
  accessibleDialogs,
  notifications,
  appScript,
  appHtml,
  appCss,
  FakeElement,
  FakeTemplate,
  FakeFormData,
  createAppHarness,
  apiResponse,
  pendingTicketResponse,
  ticketSelectionHarness,
  appScripts,
  appSource,
};
