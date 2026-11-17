// Boots the bootstrap (frontend/src/aplicacao/app.ts, iniciar()) on a fake window with a fake DOM, the way the feature-module tests need it.
const apiFetchTs = require("../../../frontend/src/api.ts");
const { iniciar } = require("../../../frontend/src/aplicacao/app.ts");
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
  // iniciar() e as features rodam no realm do Node: os mesmos falsos precisam existir como globais.
  instalarGlobaisNode({
    document, window, lucide: sandbox.lucide, HTMLElement: sandbox.HTMLElement,
    MutationObserver: sandbox.MutationObserver, requestAnimationFrame: sandbox.requestAnimationFrame,
  });
  // iniciar() publica as ações das features em `context`, como o antigo app.js as publicava no global da VM.
  const context = sandbox;
  const before = new Set(Object.keys(context));
  iniciar(context);
  const published = Object.keys(context).filter(name => !before.has(name));
  return { context, window, published };
}

module.exports = { bootPage };
