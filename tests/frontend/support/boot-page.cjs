// Boots static/app.js inside a VM with a fake DOM, the way the feature-module tests need it.
const vm = require("node:vm");
const { appScripts } = require("./app-sources.cjs");

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
    SimpressDomUtils: require("../../../static/js/shared/dom-utils.js"),
    SimpressTransferUtils: require("../../../static/js/shared/transfer-utils.js"),
    SimpressCatalogSearch: require("../../../static/js/shared/catalog-search-utils.js"),
    SimpressFormDraftGuard: require("../../../static/js/shared/form-draft-guard.js"),
    HistoryAnnotationAutosave: require("../../../static/js/shared/history-annotation-autosave.js"),
    SimpressAccessibleDialogs: require("../../../static/js/ui/accessible-dialogs.js"),
    SimpressNotifications: require("../../../static/js/ui/ui-notifications.js"),
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    ...extraWindow,
  };
  const context = vm.createContext({
    document, window, console, setTimeout, clearTimeout, URLSearchParams,
    requestAnimationFrame: () => 0,
    MutationObserver: class { observe() {} disconnect() {} },
    HTMLElement: function HTMLElement() {},
    lucide: { createIcons() {} },
  });
  const before = new Set(Object.keys(context));
  for (const { file, source } of appScripts()) vm.runInContext(source, context, { filename: file });
  const published = Object.keys(context).filter(name => !before.has(name));
  return { context, window, published };
}

module.exports = { bootPage };
