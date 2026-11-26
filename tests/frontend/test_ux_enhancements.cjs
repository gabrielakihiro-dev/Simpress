const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");
const ux = require("../../frontend/src/ui/ux-enhancements.ts");
const { createNotifications } = require("../../frontend/src/ui/ui-notifications.ts");

const staticDir = path.join(__dirname, "..", "..", "static");
const { appSource, arranqueDir } = require("./support/app-sources.cjs");
const appScript = appSource();
const appHtml = assembledHtml();
const appEntry = fs.readFileSync(path.join(arranqueDir, "entrada.ts"), "utf8");
const uxCss = fs.readFileSync(path.join(staticDir, "styles", "ux-refinements.css"), "utf8");
const tokensCss = fs.readFileSync(path.join(staticDir, "styles", "tokens.css"), "utf8");

function field(value, { type = "text", required = true, valid = true } = {}) {
  return { value, type, required, checkValidity: () => valid };
}

test("required-field list mirrors the generation gate in the transfer form", () => {
  const transfer = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "paineis", "transporte", "estado.ts"), "utf8");
  const gate = transfer.match(/function validarCamposObrigatoriosPlanilha\(\)\s*\{([\s\S]*?)\n\s*return true;/)?.[1] || "";
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
  assert.equal(ux.describeReadiness(0), "Pronto para emissão.");
  assert.equal(ux.describeReadiness(1), "Falta 1 campo obrigatório.");
  assert.equal(ux.describeReadiness(4), "Faltam 4 campos obrigatórios.");
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

test("function keys map to the four main tabs, the Cockpit tools and the Assistente", () => {
  const actions = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"]
    .map(key => ux.shortcutAction({ key }));
  assert.deepEqual(actions, [
    "tab-home", "tab-transferencia", "tool-resumo", "tab-automacao",
    "tool-sebrae-chamados", "tool-os", "tool-apelidos",
    "tool-relatorio", "tool-assistente", "tool-cobertura",
  ]);
  assert.equal(ux.shortcutAction({ key: "F11" }), null, "F11 não tem função");
});

test("modified function keys, typing and open dialogs keep their normal behavior", () => {
  assert.equal(ux.shortcutAction({ key: "F5", ctrlKey: true }), null);
  assert.equal(ux.shortcutAction({ key: "F6", shiftKey: true }), null);
  assert.equal(ux.shortcutAction({ key: "F8" }, { modalOpen: true }), null);
  assert.equal(ux.shortcutAction({ key: "F9" }, { modalOpen: true }), null);
});

test("F1 a F9 valem mesmo com o cursor num campo de texto (F5 não recarrega a página)", () => {
  assert.equal(ux.shortcutAction({ key: "F1" }, { typing: true }), "tab-home");
  assert.equal(ux.shortcutAction({ key: "F5" }, { typing: true }), "tool-sebrae-chamados");
  assert.equal(ux.shortcutAction({ key: "F3" }, { typing: true }), "tool-resumo");
  assert.equal(ux.shortcutAction({ key: "F7" }, { typing: true }), "tool-apelidos");
  assert.equal(ux.shortcutAction({ key: "F9" }, { typing: true }), "tool-assistente");
  assert.equal(ux.shortcutAction({ key: "F10" }, { typing: true }), "tool-cobertura");
  assert.equal(ux.shortcutAction({ key: "F10", shiftKey: true }, { typing: true }), null);
  assert.equal(ux.shortcutAction({ key: "F5", ctrlKey: true }, { typing: true }), null);
  assert.equal(ux.shortcutAction({ key: "F11" }, { typing: true }), null);
});

test("tools menu closes for outside clicks and item selection, not its trigger", () => {
  const trigger = { closest: () => null };
  const item = { closest: selector => selector === ".ck-menu__item" ? item : null };
  const insideMenu = target => ({ open: true, contains: candidate => candidate === target });
  assert.equal(ux.shouldCloseCockpitToolsMenu(insideMenu(trigger), trigger), false);
  assert.equal(ux.shouldCloseCockpitToolsMenu(insideMenu(item), item), true);
  assert.equal(ux.shouldCloseCockpitToolsMenu({ open: true, contains: () => false }, {}), true);
  assert.equal(ux.shouldCloseCockpitToolsMenu({ open: false, contains: () => false }, {}), false);
});

test("notifications dispatch simpress:notify without changing the toast", () => {
  const events = [];
  const appended = [];
  class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  const node = () => ({ setAttribute() {}, replaceChildren() {}, remove() {}, addEventListener() {}, className: "", textContent: "", dataset: {} });
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

test("toast pausa com o mouse em cima ou o foco dentro e some 4 s depois de sair (26/11/2026)", () => {
  // Relógio falso: o toast continua com os 4 s (17-termos.md conta com eles), só para enquanto alguém o lê.
  let agora = 0;
  const timers = new Map();
  let proximo = 1;
  const window = {
    setTimeout: (fn, ms) => { timers.set(proximo, { fn, em: agora + ms }); return proximo++; },
    clearTimeout: id => timers.delete(id),
    matchMedia: consulta => ({ matches: consulta === "(hover: hover)" && comMouse }),
  };
  let comMouse = true;
  const passar = ms => {
    agora += ms;
    for (const [id, t] of [...timers]) if (t.em <= agora) { timers.delete(id); t.fn(); }
  };
  const ouvintes = {};
  let removido = false;
  let remocoes = 0;
  const toast = {
    setAttribute() {}, replaceChildren() {}, remove() { removido = true; remocoes++; }, className: "", dataset: {},
    addEventListener: (tipo, fn) => { ouvintes[tipo] = fn; }, contains: alvo => alvo === "dentro",
  };
  const notifications = createNotifications({
    document: { getElementById: () => ({ appendChild() {} }), createElement: () => toast },
    window, lucide: { createIcons() {} }, motion: null, createIcon: () => ({}),
  });
  notifications.show("Falhou.", "error");
  passar(3000);
  ouvintes.mouseenter();
  passar(10000);
  assert.equal(removido, false, "com o mouse em cima não some");
  ouvintes.focusin();
  ouvintes.mouseleave();
  passar(10000);
  assert.equal(removido, false, "com o foco dentro não some");
  ouvintes.focusout({ relatedTarget: "dentro" });
  passar(10000);
  assert.equal(removido, false, "foco que anda dentro do toast não retoma");
  ouvintes.focusout({ relatedTarget: null });
  passar(3999);
  assert.equal(removido, false);
  passar(1);
  assert.equal(removido, true, "some 4 s depois de sair");
  ouvintes.mouseenter();
  ouvintes.mouseleave();
  passar(10000);
  assert.equal(remocoes, 1, "passar o mouse num toast que já está sumindo não agenda outro fim");

  removido = false;
  notifications.show("Salvo.");
  passar(4000);
  assert.equal(removido, true, "sem interação, segue os 4 s");

  // Tela de toque (sem hover): só o foco pausa; o toque não prende o toast sobre os botões.
  comMouse = false;
  for (const tipo of Object.keys(ouvintes)) delete ouvintes[tipo];
  removido = false;
  notifications.show("Cidade, endereço e CNPJ são campos obrigatórios.", "warning");
  assert.equal(ouvintes.mouseenter, undefined);
  assert.equal(typeof ouvintes.focusin, "function");
  passar(4000);
  assert.equal(removido, true, "no toque o toast some nos 4 s");
});

test("index loads the refinement layer last and links every transfer label", () => {
  const theme = appHtml.indexOf("/static/styles/theme.css");
  const refinements = appHtml.indexOf("/static/styles/ux-refinements.css");
  assert.ok(theme > 0 && refinements > theme, "ux-refinements.css must load after theme.css");
  const app = appEntry.indexOf('./iniciar-aplicacao.ts');
  const enhancements = appEntry.indexOf('./instalar-ux-enhancements.ts');
  assert.ok(app > 0 && enhancements > app, "instalar-ux-enhancements.ts (ux-enhancements.ts) must load after iniciar-aplicacao.ts (app.ts)");

  const start = appHtml.indexOf('id="tab-panel-retirada-entrega"');
  const end = appHtml.indexOf('id="tab-panel-automacao"', start);
  const transferPanel = appHtml.slice(start, end);
  const unlinked = transferPanel.match(/<label\b(?![^>]*\bfor=)[^>]*>/g) || [];
  assert.deepEqual(unlinked, []);
  for (const [, id] of transferPanel.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)) {
    assert.match(appHtml, new RegExp(`id="${id}"`), `label points to a missing control: ${id}`);
  }
});

test("Cockpit search announces Ctrl+K without showing the visual chip", () => {
  assert.doesNotMatch(appHtml, /title="Atalho: Ctrl\+K">Ctrl\+K<\/kbd>/);
  assert.match(appHtml, /id="input-serial"[^>]*aria-keyshortcuts="\/ Control\+K Meta\+K"/);
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

test("dismissInfoTips marks only the tips that are open", () => {
  const marked = [];
  const tip = { setAttribute: name => marked.push(name) };
  const doc = { querySelectorAll: selector => (selector.includes(":hover") && selector.includes(":not([data-tip-dismissed])") ? [tip] : []) };
  assert.equal(ux.dismissInfoTips(doc), 1);
  assert.deepEqual(marked, ["data-tip-dismissed"]);
  assert.equal(ux.dismissInfoTips({ querySelectorAll: () => [] }), 0);
});

test("every info tip trigger points to a tooltip with text", () => {
  const triggers = [...appHtml.matchAll(/<button[^>]*class="info-tip-trigger"[^>]*>/g)].map(match => match[0]);
  assert.ok(triggers.length > 0, "index.html should use info tips");
  for (const trigger of triggers) {
    assert.match(trigger, /aria-label="[^"]+"/);
    const id = trigger.match(/aria-describedby="([^"]+)"/)?.[1];
    assert.ok(id, `info tip without aria-describedby: ${trigger}`);
    assert.match(appHtml, new RegExp(`<span id="${id}" role="tooltip" class="info-tip-text">(?:[^<]|</?code>)*\\S(?:[^<]|</?code>)*</span>`));
  }
  assert.match(uxCss, /\.info-tip:is\(:hover, :focus-within\):not\(\[data-tip-dismissed\]\) \.info-tip-text/);
});

test("bottom-bar status follows the pending chip in every place that writes the default text", () => {
  const sources = {
    "index.html": appHtml,
    "transfer-form.ts": fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "paineis", "transporte", "estado.ts"), "utf8"),
    "equipment-search.ts": fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "paineis", "pesquisa-equipamento", "estado.ts"), "utf8"),
  };
  assert.match(sources["index.html"], /data-ux-ready-status>Pronto para emissão\./);
  assert.match(sources["transfer-form.ts"], /data-ux-ready-status>Pronto para emissão\./);
  assert.match(sources["equipment-search.ts"], /firstElementChild\?\.setAttribute\("data-ux-ready-status"/);
});

test("light theme keeps secondary text and the search count badge above 4.5:1 on tinted backgrounds", () => {
  const light = tokensCss.slice(tokensCss.indexOf('[data-theme="light"]'));
  assert.match(light, /--text-subtle: #5b6b80;/);
  // Desde a migração React (Dia 2, G10) o selo da contagem é desenhado pelo painel, não pelo HTML montado.
  const dialogo = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "paineis", "pesquisa-completa", "dialogo.tsx"), "utf8");
  assert.match(dialogo, /id="pesquisa-completa-contagem" className="[^"]*\btext-cyan-200\b/);
});


test("Home letter shortcuts respect typing and command modifiers", () => {
  assert.equal(ux.shortcutAction({ key: "t" }), "equipment-transport");
  assert.equal(ux.shortcutAction({ key: "E" }), "equipment-edit");
  assert.equal(ux.shortcutAction({ key: "c" }), "copy-ticket");
  assert.equal(ux.shortcutAction({ key: "e" }, { typing: true }), null);
  assert.equal(ux.shortcutAction({ key: "c", ctrlKey: true }), null);
});
