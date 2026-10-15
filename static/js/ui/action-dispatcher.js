// Declarative event wiring that replaces inline on* attributes, so the page runs under a
// Content-Security-Policy without 'unsafe-inline' scripts.
//
//   data-on-click="nomeDaFuncao"          calls window.nomeDaFuncao()
//   data-args='["home", "$value"]'         JSON arguments; "$event", "$this" and "$value" are resolved
//   data-on-self-only                      runs only when the event target is the element itself
//   data-click-target="element-id"         forwards the click to another element (e.g. a hidden file input)
//
// Handlers run from the innermost element outwards, like bubbling inline handlers.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressActionDispatcher = api;
  if (typeof document !== "undefined" && typeof window !== "undefined") api.install(document, window);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const EVENTS = Object.freeze(["click", "change", "input", "keydown", "submit", "toggle"]);
  // These do not bubble: they are captured at the document and run only on their target.
  const NON_BUBBLING = new Set(["toggle"]);
  const TOKENS = Object.freeze({
    $event: (event) => event,
    $this: (_event, element) => element,
    $value: (_event, element) => element.value,
  });

  function parseArgs(element) {
    const raw = element.getAttribute("data-args");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (_error) {
      return [];
    }
  }

  function resolveArgs(element, event) {
    return parseArgs(element).map(arg => (typeof arg === "string" && TOKENS[arg] ? TOKENS[arg](event, element) : arg));
  }

  function runHandler(element, event, type, scope) {
    if (element.hasAttribute("data-on-self-only") && event.target !== element) return;
    const name = element.getAttribute(`data-on-${type}`);
    const handler = name && scope[name];
    if (typeof handler !== "function") {
      scope.console?.warn?.(`Ação "${name}" não encontrada para o evento ${type}.`);
      return;
    }
    if (type === "submit") event.preventDefault();
    handler(...resolveArgs(element, event));
  }

  function dispatch(event, scope) {
    const type = event.type;
    let element = event.target;
    while (element && element.nodeType === 1) {
      if (type === "click" && element.hasAttribute("data-click-target")) {
        scope.document.getElementById(element.getAttribute("data-click-target"))?.click();
      }
      if (element.hasAttribute(`data-on-${type}`)) runHandler(element, event, type, scope);
      if (event.cancelBubble || NON_BUBBLING.has(type)) break;
      element = element.parentElement;
    }
  }

  function install(doc, scope) {
    if (doc.__simpressActionsInstalled) return;
    doc.__simpressActionsInstalled = true;
    EVENTS.forEach(type => doc.addEventListener(type, event => dispatch(event, scope), NON_BUBBLING.has(type)));
  }

  return { EVENTS, dispatch, install, resolveArgs };
});
