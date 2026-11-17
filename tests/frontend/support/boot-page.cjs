// Boots frontend/src/legado/app.js inside a VM with a fake DOM, the way the feature-module tests need it.
const vm = require("node:vm");
const { appScripts } = require("./app-sources.cjs");
const apiFetchTs = require("../../../frontend/src/api.ts");
const { fabricas } = require("../../../frontend/src/aplicacao/registro.ts");
const { createTicketRules } = require("../../../frontend/src/aplicacao/ticket-rules.ts");
const { instalarGlobaisNode } = require("./globais-node.cjs");

function fakeElement() {
  return {
    value: "", textContent: "", innerHTML: "", dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    addEventListener() {}, appendChild(child) { return child; }, replaceChildren() {}, querySelector: () => null,
    querySelectorAll: () => [], focus() {}, closest: () => null,
  };
}

function bootPage(extraWindow = {}) {
  const elements = new Map();
  const document = {
    readyState: "loading",
    body: fakeElement(),
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement: () => fakeElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = {
    document,
    SimpressDomUtils: require("../../../frontend/src/comum/dom-utils.ts").createDomUtils,
    SimpressTransferUtils: require("../../../frontend/src/comum/transfer-utils.ts"),
    SimpressCatalogSearch: require("../../../frontend/src/comum/catalog-search-utils.ts"),
    SimpressFormDraftGuard: require("../../../frontend/src/comum/form-draft-guard.ts"),
    HistoryAnnotationAutosave: require("../../../frontend/src/comum/history-annotation-autosave.ts"),
    SimpressAccessibleDialogs: require("../../../frontend/src/ui/accessible-dialogs.ts").createAccessibleDialogs,
    SimpressNotifications: require("../../../frontend/src/ui/ui-notifications.ts").createNotifications,
    // Antes rodavam na VM e se publicavam em window; agora são TypeScript e entram por require().
    SimpressApiErrors: require("../../../frontend/src/comum/api-errors.ts"),
    SimpressApiFetch: { apiFetch: apiFetchTs.apiFetch, isAbortError: apiFetchTs.isAbortError },
    SimpressHistoryFormat: require("../../../frontend/src/comum/history-format.ts"),
    SimpressSebraeDashboardModel: require("../../../frontend/src/comum/sebrae-dashboard-model.ts"),
    SimpressEquipmentSearchRenderers: require("../../../frontend/src/ui/equipment-search-renderers.ts").createEquipmentSearchRenderers,
    SimpressLoggedUserMarkers: require("../../../frontend/src/ui/logged-user-markers.ts").createLoggedUserMarkers,
    // As fábricas das features agora são TypeScript: app.js (VM) lê as duas daqui, como lia do bundle.
    SimpressFeatures: fabricas,
    SimpressTicketRules: createTicketRules,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    ...extraWindow,
  };
  const sandbox = {
    document, window, console, setTimeout, clearTimeout, URLSearchParams,
    requestAnimationFrame: () => 0,
    MutationObserver: class { observe() {} disconnect() {} },
    HTMLElement: function HTMLElement() {},
    lucide: { createIcons() {} },
  };
  // As features rodam no realm do Node durante a avaliação de app.js: os mesmos falsos precisam existir como globais.
  instalarGlobaisNode({
    document, window, lucide: sandbox.lucide, HTMLElement: sandbox.HTMLElement,
    MutationObserver: sandbox.MutationObserver, requestAnimationFrame: sandbox.requestAnimationFrame,
  });
  const context = vm.createContext(sandbox);
  const before = new Set(Object.keys(context));
  for (const { file, source } of appScripts()) vm.runInContext(source, context, { filename: file });
  const published = Object.keys(context).filter(name => !before.has(name));
  return { context, window, published };
}

module.exports = { bootPage };
