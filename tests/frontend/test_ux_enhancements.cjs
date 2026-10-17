const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ux = require("../../static/js/ui/ux-enhancements.js");
const createNotifications = require("../../static/js/ui/ui-notifications.js");

const staticDir = path.join(__dirname, "..", "..", "static");
const { appSource } = require("./support/app-sources.cjs");
const appScript = appSource();
const appHtml = fs.readFileSync(path.join(staticDir, "index.html"), "utf8");
const uxCss = fs.readFileSync(path.join(staticDir, "styles", "ux-refinements.css"), "utf8");
const tokensCss = fs.readFileSync(path.join(staticDir, "styles", "tokens.css"), "utf8");

function field(value, { type = "text", required = true, valid = true } = {}) {
  return { value, type, required, checkValidity: () => valid };
}

test("required-field list mirrors the generation gate in the transfer form", () => {
  const gate = appScript.match(/function validarCamposObrigatoriosPlanilha\(\)\s*\{([\s\S]*?)\n\s*return true;/)?.[1] || "";
  const gateIds = [...gate.matchAll(/id: "([^"]+)"/g)].map(match => match[1]);
  assert.ok(gateIds.length >= 9, "the generation gate should still list its required fields");
  assert.deepEqual([...ux.REQUIRED_FIELDS.map(item => item.id)].sort(), [...new Set(gateIds)].sort());
});

test("fieldProblem distinguishes empty, malformed e-mail and valid values", () => {
  assert.equal(ux.fieldProblem(field("   ")), "required");
  assert.equal(ux.fieldProblem(field("ana@", { type: "email", valid: false })), "email");
  assert.equal(ux.fieldProblem(field("ana@pr.sebrae.com.br", { type: "email" })), null);
  assert.equal(ux.fieldProblem(null), null);
});

test("pending list honors the conditional lunch-break duration and keeps gate order", () => {
  const values = Object.fromEntries(ux.REQUIRED_FIELDS.map(({ id }) => [id, field("ok")]));
  values["retirada-email"] = field("", { type: "email" });
  values["entrega-pausa-duracao"] = field("", { required: false });
  values["entrega-obs"] = field(" ");
  const pending = ux.listPendingFields(id => values[id]);
  assert.deepEqual(pending.map(item => [item.id, item.problem]), [
    ["retirada-email", "required"],
    ["entrega-obs", "required"],
  ]);
  values["entrega-pausa-duracao"].required = true;
  assert.equal(ux.listPendingFields(id => values[id]).length, 3);
  assert.equal(ux.describePending(0), "Campos obrigatórios completos");
  assert.equal(ux.describePending(1), "1 campo pendente");
  assert.equal(ux.describePending(4), "4 campos pendentes");
  assert.equal(ux.shortPendingLabel(0), "Campos completos");
  assert.equal(ux.shortPendingLabel(1), "pendente");
  assert.equal(ux.shortPendingLabel(4), "pendentes");
});

test("copy triggers are recognized only on copy buttons", () => {
  const button = (onclick, extra = {}) => ({
    tagName: "BUTTON",
    getAttribute: name => (name === "data-on-click" ? onclick : null),
    hasAttribute: name => Boolean(extra[name]),
    classList: { contains: name => (extra.classes || []).includes(name) },
  });
  assert.equal(ux.isCopyTrigger(button("copiarDadoLocalAtual")), true);
  assert.equal(ux.isCopyTrigger(button("copiarSerieAtual")), true);
  assert.equal(ux.isCopyTrigger(button("", { "data-copy-field": true })), true);
  assert.equal(ux.isCopyTrigger(button("", { classes: ["ticket-template-copy"] })), true);
  assert.equal(ux.isCopyTrigger(button("gerarPlanilhaExcel")), false);
  assert.equal(ux.isCopyTrigger({ ...button("copiarSerieAtual"), tagName: "A" }), false);
  assert.equal(ux.copyStateFor("success"), "copied");
  assert.equal(ux.copyStateFor("warning"), "warning");
  assert.equal(ux.copyStateFor("error"), "error");
  assert.equal(ux.copyStateFor("info"), null);
});

test("horizontal overflow state drives the table edge fade", () => {
  assert.equal(ux.overflowState(0, 500, 500), null);
  assert.equal(ux.overflowState(0, 500, 900), "end");
  assert.equal(ux.overflowState(200, 500, 900), "both");
  assert.equal(ux.overflowState(400, 500, 900), "start");
});

test("notifications dispatch simpress:notify without changing the toast", () => {
  const events = [];
  const appended = [];
  class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  const node = () => ({ setAttribute() {}, replaceChildren() {}, remove() {}, className: "", textContent: "" });
  const document = {
    getElementById: () => ({ appendChild: child => appended.push(child) }),
    createElement: node,
    dispatchEvent: event => events.push(event),
  };
  const window = { CustomEvent: FakeCustomEvent, setTimeout: () => 0 };
  const notifications = createNotifications({
    document, window, lucide: { createIcons() {} }, motion: null, createIcon: node,
  });
  notifications.show("CEP copiado para a área de transferência.", "success");
  assert.equal(appended.length, 1);
  assert.deepEqual(events.map(event => [event.type, event.detail.type]), [["simpress:notify", "success"]]);

  const legacy = createNotifications({
    document: { ...document, dispatchEvent: undefined }, window: { setTimeout: () => 0 },
    lucide: { createIcons() {} }, motion: null, createIcon: node,
  });
  assert.doesNotThrow(() => legacy.show("ok", "info"));
});

test("index loads the refinement layer last and links every transfer label", () => {
  const theme = appHtml.indexOf("/static/styles/theme.css");
  const refinements = appHtml.indexOf("/static/styles/ux-refinements.css");
  assert.ok(theme > 0 && refinements > theme, "ux-refinements.css must load after theme.css");
  const app = appHtml.indexOf('<script src="/static/app.js">');
  const enhancements = appHtml.indexOf('<script src="/static/js/ui/ux-enhancements.js">');
  assert.ok(app > 0 && enhancements > app, "ux-enhancements.js must load after app.js");

  const start = appHtml.indexOf('id="tab-panel-retirada-entrega"');
  const end = appHtml.indexOf('<aside aria-label="Painel de Ações Rápidas"');
  const transferPanel = appHtml.slice(start, end);
  const unlinked = transferPanel.match(/<label\b(?![^>]*\bfor=)[^>]*>/g) || [];
  assert.deepEqual(unlinked, []);
  for (const [, id] of transferPanel.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) {
    assert.match(appHtml, new RegExp(`id="${id}"`), `label points to a missing control: ${id}`);
  }
});

test("refinement layer defines both themes and respects reduced motion", () => {
  for (const token of ["--ux-success-fg", "--ux-pending-fg", "--ux-warning-fg", "--ux-critical-fg", "--ux-neutral-fg"]) {
    assert.equal((tokensCss.match(new RegExp(`${token}:`, "g")) || []).length, 2, `${token} must exist in dark and light`);
  }
  assert.match(tokensCss, /html\[data-theme="light"\]\s*\{/);
  assert.doesNotMatch(uxCss, /^\s*--ux-[\w-]+:/m, "tokens are defined once, in tokens.css");
  assert.match(uxCss, /\.accessible-table-wrap thead th\s*\{[^}]*position: sticky/);
  assert.match(uxCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(uxCss, /@import|https?:\/\//, "the layer must stay offline");
});
