const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./assembled-html.cjs");
const vm = require("node:vm");
const transferUtils = require("../../../frontend/src/comum/transfer-utils.ts");
const { apiFetch: requestApi, isAbortError } = require("../../../frontend/src/api.ts");
const catalogSearch = require("../../../frontend/src/comum/catalog-search-utils.ts");
const formDraftGuard = require("../../../frontend/src/comum/form-draft-guard.ts");
const annotationAutosave = require("../../../frontend/src/comum/history-annotation-autosave.ts");
const { createAccessibleDialogs: accessibleDialogs } = require("../../../frontend/src/ui/accessible-dialogs.ts");
const { createNotifications: notifications } = require("../../../frontend/src/ui/ui-notifications.ts");
const { criarPesquisaEquipamento } = require("../../../frontend/src/paineis/pesquisa-equipamento/estado.ts");
const { criarFormularioTransferencia } = require("../../../frontend/src/paineis/transporte/estado.ts");
const { criarContatosRegionais } = require("../../../frontend/src/paineis/contatos-regionais/estado.ts");
const { criarAcoesCartaoEquipamento } = require("../../../frontend/src/paineis/cartao-equipamento/estado.ts");
const { criarIndicadoresHome } = require("../../../frontend/src/paineis/indicadores-home/estado.ts");
// estado.ts importa "./renderizador" sem extensão: o hook completa ".ts" antes do require.
require("./resolver-ts-sem-extensao.cjs");
const { criarResultadoComparacao } = require("../../../frontend/src/paineis/resultado-comparacao/estado.ts");
const { criarRegrasChamados } = require("../../../frontend/src/paineis/regras-chamados/regras.ts");
const { criarImportacaoPlanilhas } = require("../../../frontend/src/paineis/importacao-planilhas/estado.ts");
const { criarFerramentasCockpit } = require("../../../frontend/src/paineis/ferramentas-cockpit/estado.ts");

const { appScripts, appSource } = require("./app-sources.cjs");

const appScript = appSource();
const appHtml = assembledHtml();
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
  dispatchEvent(event) {
    const type = typeof event === "string" ? event : event.type;
    for (const listener of this.listeners.get(type) || []) listener({ target: this });
  }
  click() { this.clicked = true; }
  remove() { this.isConnected = false; }
  replaceChildren(...children) { this.children = children.flatMap(child => child.isDocumentFragment ? child.children : [child]); }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) {
    if (child.isDocumentFragment) this.children.push(...child.children);
    else this.children.push(child);
    return child;
  }
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
    dispatchEvent() { return true; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    createElement: tag => tag === "template" ? new FakeTemplate(tag) : new FakeElement(tag),
    createDocumentFragment() {
      const fragment = new FakeElement("#document-fragment");
      fragment.isDocumentFragment = true;
      return fragment;
    },
    querySelectorAll: () => [],
    querySelector(selector) {
      effects.focusedSelectors.push(selector);
      return new FakeElement(selector);
    },
  };
  const window = {
    document,
    SimpressDomUtils: require("../../../frontend/src/comum/dom-utils.ts").createDomUtils,
    SimpressTransferUtils: transferUtils,
    SimpressCatalogSearch: catalogSearch,
    SimpressFormDraftGuard: formDraftGuard,
    HistoryAnnotationAutosave: annotationAutosave,
    SimpressAccessibleDialogs: accessibleDialogs,
    SimpressNotifications: notifications,
    // Antes rodavam na VM e se publicavam em window; agora são TypeScript e entram por require().
    SimpressApiErrors: require("../../../frontend/src/comum/api-errors.ts"),
    SimpressApiFetch: { apiFetch: requestApi, isAbortError },
    SimpressHistoryFormat: require("../../../frontend/src/comum/history-format.ts"),
    SimpressSebraeDashboardModel: require("../../../frontend/src/comum/sebrae-dashboard-model.ts"),
    SimpressEquipmentSearchRenderers: require("../../../frontend/src/ui/equipment-search-renderers.ts").createEquipmentSearchRenderers,
    SimpressLoggedUserMarkers: require("../../../frontend/src/ui/logged-user-markers.ts").createLoggedUserMarkers,
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
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    HTMLElement: FakeElement,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: callback => callback(0),
    MutationObserver: class { observe() {} disconnect() {} },
    lucide: { createIcons() {} },
    console: { error() {}, warn() {}, info() {}, log() {} },
    workflowEffects: effects,
  });

  for (const { file, source } of appScripts()) vm.runInContext(source, context, { filename: file });
  vm.runInContext(`
    preencherRepresentanteRegional = () => {};
    showToast = (message, type) => workflowEffects.toasts.push({ message, type });
    mostrarResultadoNaAbaComparacao = comparison => workflowEffects.comparisons.push(comparison);
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

  mountReactPanels(context, document, window, effects, fetchApi);
  mountReactPanelsBf2(context, window);
  mountReactPanelsBf4(context, window);

  function syncAppToWindow() {
    for (const name of Object.keys(context)) {
      if (name !== "window") window[name] = context[name];
    }
    window.apiFetch = requestApi;
    globalThis.document = document;
    globalThis.window = window;
    globalThis.HTMLElement = FakeElement;
    globalThis.CSS = context.CSS || { escape: value => String(value) };
  }

  return {
    context,
    effects,
    localStorage,
    element: id => document.getElementById(id),
    run(source) {
      const result = vm.runInContext(source, context);
      syncAppToWindow();
      return result;
    },
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

function mountReactPanels(context, document, window, effects, fetchApi) {
  globalThis.document = document;
  globalThis.window = window;
  globalThis.lucide = context.lucide;
  globalThis.HTMLElement = FakeElement;
  if (typeof fetchApi === "function") globalThis.fetch = (...args) => fetchApi(...args);
  Object.assign(window, context);
  window.showToast = (message, type) => effects.toasts.push({ message, type });
  window.apiFetch = requestApi;
  window.SimpressApp = context.SimpressApp;
  window.SimpressReact = {};

  const sideEffectsOutsideBf1 = new Set([
    "atualizarEmailOutlook", "atualizarDossieEquipamento", "atualizarChamadosAbertosHome",
    "atualizarPreviaTransporteCockpit", "recolherVisualizacoesModelosChamado", "termosPreencherDoEquipamento",
  ]);
  const app = new Proxy(context, {
    get(target, name) {
      if (sideEffectsOutsideBf1.has(name)) return () => {};
      return Reflect.get(target, name);
    },
  });
  const appReact = new Proxy(window, {
    get(target, name) {
      if (sideEffectsOutsideBf1.has(name)) return () => {};
      return Reflect.get(target, name);
    },
  });
  const appState = context.SimpressApp.state;

  window.SimpressReact.transporte = criarFormularioTransferencia({
    app: appReact,
    appState,
    motion: null,
    transferUtils,
    apiFetch: requestApi,
    draftTracker: formDraftGuard.createDraftTracker(),
  });
  window.SimpressReact["contatos-regionais"] = criarContatosRegionais({
    app: appReact,
    transferUtils,
    apiFetch: requestApi,
  });

  window.SimpressReact["indicadores-home"] = criarIndicadoresHome({
    app: appReact,
    transferUtils,
    motion: null,
    dom: window.SimpressDomUtils(document),
    apiFetch: requestApi,
  });

  // BF3: resultado da comparação (o mesmo contexto que frontend/src/paineis/resultado-comparacao/montar.tsx monta no navegador).
  window.SimpressReact["resultado-comparacao"] = criarResultadoComparacao({
    app: appReact,
    appState,
    motion: null,
    dom: window.SimpressDomUtils(document),
    historyFormat: window.SimpressHistoryFormat,
    loggedUserMarkers: window.SimpressLoggedUserMarkers({ app: appReact, appState, dom: window.SimpressDomUtils(document) }),
    annotationAutosave,
    apiFetch: requestApi,
  });

  const actions = criarPesquisaEquipamento({
    app,
    appState,
    motion: null,
    transferUtils,
    recentEquipment: null,
    dom: window.SimpressDomUtils(document),
    equipmentSearchRenderer: window.SimpressEquipmentSearchRenderers,
    apiFetch: requestApi,
  });
  window.SimpressReact["pesquisa-equipamento"] = actions;
  const loggedUserMarkers = window.SimpressLoggedUserMarkers?.({ app: appReact, appState, dom: window.SimpressDomUtils(document) });
  window.SimpressReact["cartao-equipamento"] = criarAcoesCartaoEquipamento({
    app: appReact,
    appState,
    ponteReact(painel, nomes) {
      return Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
        const acao = window.SimpressReact?.[painel]?.[nome];
        if (typeof acao !== "function") return Promise.reject(new Error(`O painel React "${painel}" não carregou.`));
        return Promise.resolve(acao(...argumentos));
      }]));
    },
    loggedUserMarkers,
  });
}

// Painéis do BF2 (regras-chamados e importacao-planilhas): o main.tsx real publica o retorno de cada montar(); aqui
// o harness chama as mesmas fábricas de regras.ts e estado.ts, sem o JSX.
function mountReactPanelsBf2(context, window) {
  // O código React roda no global do Node, não no vm: o FormData falso precisa estar aqui para os testes lerem os campos.
  globalThis.FormData = FakeFormData;
  window.SimpressReact["regras-chamados"] = criarRegrasChamados(window.SimpressDomUtils(window.document));
  window.SimpressReact["importacao-planilhas"] = criarImportacaoPlanilhas({
    app: window,
    appState: context.SimpressApp.state,
    apiFetch: requestApi,
  });
}

// Painel do BF4 (ferramentas-cockpit): o main.tsx real publica o retorno de montar(); aqui o harness chama a mesma fábrica de estado.ts, sem o JSX.
function mountReactPanelsBf4(context, window) {
  window.SimpressReact["ferramentas-cockpit"] = criarFerramentasCockpit({
    app: window,
    appState: context.SimpressApp.state,
    apiFetch: requestApi,
    historyFormat: window.SimpressHistoryFormat,
  });
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
  appScripts,
  appSource,
};
