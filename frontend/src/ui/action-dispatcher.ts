/* eslint-disable @typescript-eslint/no-explicit-any */
// Declarative event wiring that replaces inline on* attributes, so the page runs under a
// Content-Security-Policy without 'unsafe-inline' scripts.
//
//   data-on-click="nomeDaAcao"            calls window.nomeDaAcao(), only if the name was registered with allow()
//   data-args='["home", "$value"]'         JSON arguments; "$event", "$this" and "$value" are resolved
//   data-args-keydown='["$event"]'         same, only for that event (needed when one element has two handlers)
//   data-on-self-only                      runs only when the event target is the element itself
//   data-click-target="element-id"         forwards the click to another element (e.g. a hidden file input)
//
// Handlers run from the innermost element outwards, like bubbling inline handlers.
// Closed list: frontend/src/aplicacao/app.ts registers the feature actions through allow(); any other name
// (alert, constructor...) only logs a warning. The function itself is still read from the scope
// at event time, so actions replaced on window (tests, enhancements) keep working.
//
// Módulo puro: quem o publica em window.SimpressActionDispatcher e liga no document é
// frontend/src/arranque/instalar-action-dispatcher.ts.
type Qualquer = any;

export const EVENTS = Object.freeze(["click", "change", "input", "keydown", "submit", "toggle"]);
// These do not bubble: they are captured at the document and run only on their target.
const NON_BUBBLING = new Set(["toggle"]);
const TOKENS: Record<string, (event: Qualquer, element: Qualquer) => Qualquer> = Object.freeze({
  $event: (event: Qualquer) => event,
  $this: (_event: Qualquer, element: Qualquer) => element,
  $value: (_event: Qualquer, element: Qualquer) => element.value,
});

const allowed = new Set<string>();

export function allow(names: Iterable<string>): void {
  for (const name of names) allowed.add(name);
}

function parseArgs(element: Qualquer, type: string): Qualquer[] {
  // data-args-<evento> vale só para aquele evento (um atributo data-args repetido é descartado pelo HTML)
  const raw = element.getAttribute(`data-args-${type}`) ?? element.getAttribute("data-args");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_error) {
    return [];
  }
}

export function resolveArgs(element: Qualquer, event: Qualquer): Qualquer[] {
  return parseArgs(element, event.type).map(arg => (typeof arg === "string" && TOKENS[arg] ? TOKENS[arg](event, element) : arg));
}

function runHandler(element: Qualquer, event: Qualquer, type: string, scope: Qualquer): void {
  if (element.hasAttribute("data-on-self-only") && event.target !== element) return;
  const name = element.getAttribute(`data-on-${type}`);
  const handler = name && allowed.has(name) ? scope[name] : undefined;
  if (typeof handler !== "function") {
    scope.console?.warn?.(`Ação "${name}" não encontrada para o evento ${type}.`);
    return;
  }
  if (type === "submit") event.preventDefault();
  handler(...resolveArgs(element, event));
}

export function dispatch(event: Qualquer, scope: Qualquer): void {
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

export function install(doc: Qualquer, scope: Qualquer): void {
  if (doc.__simpressActionsInstalled) return;
  doc.__simpressActionsInstalled = true;
  EVENTS.forEach(type => doc.addEventListener(type, (event: Qualquer) => dispatch(event, scope), NON_BUBBLING.has(type)));
}
