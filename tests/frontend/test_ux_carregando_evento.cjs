// ux-enhancements.js trata tabelas e "Carregando…" por evento explícito (com debounce de 50 ms), sem observer no body.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ux = require("../../static/js/ui/ux-enhancements.js");
const { createFakeDocument } = require("./support/fake-dom.cjs");

const doc = createFakeDocument();
doc.readyState = "loading"; // start() fica para o DOMContentLoaded, que o teste não dispara
const listeners = new Map();
doc.addEventListener = (type, listener) => listeners.set(type, [...(listeners.get(type) || []), listener]);
doc.dispatchEvent = event => { (listeners.get(event.type) || []).forEach(listener => listener(event)); return true; };

const observados = [];
const timers = [];
const win = {
  document: doc,
  MutationObserver: class { constructor() {} observe(target) { observados.push(target); } disconnect() {} },
  CustomEvent: class { constructor(type) { this.type = type; } },
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearTimeout() {},
  matchMedia: () => ({ matches: false }),
  console: { warn() {} },
};
ux.install(win);

function paragrafoCarregando(texto) {
  const p = doc.createElement("p");
  p.className = "text-center";
  p.setAttribute("role", "status");
  p.textContent = texto;
  doc.body.appendChild(p);
  return p;
}

test("nenhum MutationObserver vigia o body", () => {
  assert.ok(!observados.includes(doc.body));
});

test("simpress:carregando-exibido marca o indicador depois de 50 ms, uma vez por rajada", () => {
  const p = paragrafoCarregando("Carregando histórico…");
  timers.length = 0;
  doc.dispatchEvent(new win.CustomEvent("simpress:carregando-exibido"));
  doc.dispatchEvent(new win.CustomEvent("simpress:tabelas-renderizadas"));
  assert.equal(timers.length, 1, "duas chamadas seguidas agendam uma só varredura");
  assert.equal(timers[0].ms, 50);
  assert.equal(p.dataset.uxLoading, undefined, "antes do debounce nada muda");
  timers[0].fn();
  assert.equal(p.dataset.uxLoading, "true");
  p.textContent = "Nenhum registro.";
  doc.dispatchEvent(new win.CustomEvent("simpress:carregando-exibido"));
  assert.equal(timers.length, 2, "depois da varredura um novo evento agenda outra");
  timers[1].fn();
  assert.equal(p.dataset.uxLoading, undefined);
});

test("produtores do indicador disparam o evento antes da busca", () => {
  const ler = arquivo => fs.readFileSync(path.join(__dirname, "..", "..", "static", "js", arquivo), "utf8");
  assert.match(ler("features/comparison-history.js"), /dispatchEvent\(new CustomEvent\("simpress:carregando-exibido"\)\)/);
  assert.match(ler("ui/transfer-history.js"), /dispatchEvent\(new win\.CustomEvent\("simpress:carregando-exibido"\)\)/);
});
