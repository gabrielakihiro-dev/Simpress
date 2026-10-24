const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { appScriptFiles, staticDir } = require("./support/app-sources.cjs");
const { bootPage } = require("./support/boot-page.cjs");

const indexHtml = fs.readFileSync(path.join(staticDir, "index.html"), "utf8");
const bootstrapSource = fs.readFileSync(path.join(staticDir, "app.js"), "utf8");
const featureFiles = appScriptFiles().filter(file => file.startsWith("js/features/"));

// Actions the dispatcher resolves: data-on-* in the page and in markup the features render.
function declaredActions() {
  const sources = [indexHtml, ...featureFiles.map(file => fs.readFileSync(path.join(staticDir, file), "utf8"))];
  const names = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/data-on-[a-z]+=\\?["']([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  }
  return names;
}

// Close handlers that accessible-dialogs.js looks up on window by name.
function modalCloseHandlers() {
  const names = new Set();
  for (const file of featureFiles) {
    const source = fs.readFileSync(path.join(staticDir, file), "utf8");
    for (const match of source.matchAll(/abrirModalAcessivel\(\s*[^,]+,\s*(?:'[^']*'|"[^"]*"),\s*"([A-Za-z_$][\w$]*)"/g)) names.add(match[1]);
  }
  return names;
}

// Scripts loaded after app.js install a few actions of their own (e.g. transfer history).
function actionsInstalledByUiScripts() {
  const names = new Set();
  const uiDir = path.join(staticDir, "js", "ui");
  for (const file of fs.readdirSync(uiDir)) {
    const source = fs.readFileSync(path.join(uiDir, file), "utf8");
    for (const match of source.matchAll(/\bwin\.([A-Za-z_$][\w$]*)\s*=\s*function/g)) names.add(match[1]);
  }
  return names;
}

test("every data-on-* action and modal close handler is published on window", () => {
  const { context } = bootPage();
  const fromUiScripts = actionsInstalledByUiScripts();
  const actions = [...declaredActions(), ...modalCloseHandlers()];
  assert.ok(actions.length > 60, "the page should still declare its actions");
  const missing = actions.filter(name => typeof context[name] !== "function" && !fromUiScripts.has(name));
  assert.deepEqual([...new Set(missing)], []);
});

test("the bootstrap creates every feature module the page loads, in a declared order", () => {
  const { window } = bootPage();
  const order = [...bootstrapSource.matchAll(/^\s+"([A-Za-z]+)",$/gm)].map(match => match[1]);
  assert.deepEqual(Object.keys(window.SimpressFeatures).sort(), [...order].sort());
  assert.equal(typeof window.SimpressTicketRules, "function");
  assert.equal(typeof window.SimpressHistoryFormat.formatarNomeFonteHistorico, "function");
});

test("shared state is exposed once and features publish no duplicate actions", () => {
  const { context, published } = bootPage();
  assert.deepEqual(Object.keys(context.SimpressApp.state).sort(), [
    "acompanhamentoChamadosAtual", "currentEquipamento", "equipamentoSelectionRevision", "filtroChamadoSelecionado", "filtroTriagemChamados", "historicoAcompanhamentoChamados",
    "previaPlanilhasAtual", "retiradaCidadeSelecionada", "unidadesList",
  ]);
  assert.equal(new Set(published).size, published.length);
  assert.ok(!published.includes("app") && !published.includes("appState"), "the bootstrap keeps its locals private");
});

test("feature scripts only register a factory and declare no page globals", () => {
  for (const file of featureFiles) {
    const window = {};
    const context = vm.createContext({ window });
    vm.runInContext(fs.readFileSync(path.join(staticDir, file), "utf8"), context, { filename: file });
    assert.deepEqual(Object.keys(context), ["window"], `${file} leaked globals`);
    const registered = [...Object.values(window.SimpressFeatures || {}), window.SimpressTicketRules].filter(Boolean);
    assert.equal(registered.length, 1, `${file} should register exactly one factory`);
    assert.equal(typeof registered[0], "function");
  }
});

test("feature factories are also exported for Node", () => {
  for (const file of featureFiles) {
    assert.equal(typeof require(path.join(staticDir, file)), "function", file);
  }
  const historyFormat = require("../../static/js/shared/history-format.js");
  assert.equal(historyFormat.formatarNomeFonteHistorico("InvAll e EquipamentosDetalhes"), "no endpoint e na Simpress");
});
