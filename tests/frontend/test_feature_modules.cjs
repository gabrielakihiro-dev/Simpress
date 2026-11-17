const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");
const { aplicacaoDir, appScriptFiles, srcDir } = require("./support/app-sources.cjs");
const { bootPage } = require("./support/boot-page.cjs");

const indexHtml = assembledHtml();
const bootstrapSource = fs.readFileSync(path.join(aplicacaoDir, "app.ts"), "utf8");
// app.ts é o arranque (iniciar), não uma feature.
const featureFiles = fs.readdirSync(aplicacaoDir).filter(file => file.endsWith(".ts") && file !== "app.ts").sort().map(file => path.join(aplicacaoDir, file));
const { fabricas } = require("../../frontend/src/aplicacao/registro.ts");
const { createTicketRules } = require("../../frontend/src/aplicacao/ticket-rules.ts");

// Actions the dispatcher resolves: data-on-* in the page and in markup the features render.
function declaredActions() {
  const sources = [indexHtml, ...featureFiles.map(file => fs.readFileSync(file, "utf8"))];
  const names = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/data-on-[a-z]+=\\?["']([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  }
  return names;
}

// Close handlers that accessible-dialogs.ts looks up on window by name.
function modalCloseHandlers() {
  const names = new Set();
  for (const file of featureFiles) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/abrirModalAcessivel\(\s*[^,]+,\s*(?:'[^']*'|"[^"]*"),\s*"([A-Za-z_$][\w$]*)"/g)) names.add(match[1]);
  }
  return names;
}

// Scripts loaded after the bootstrap (aplicacao/app.ts) install a few actions of their own; React panels publish theirs with
// Object.assign(window, { ... }) in paineis/<painel>/montar.tsx (e.g. transfer history).
function actionsInstalledByUiScripts() {
  const names = new Set();
  const uiDir = path.join(srcDir, "ui");
  for (const file of fs.readdirSync(uiDir)) {
    const source = fs.readFileSync(path.join(uiDir, file), "utf8");
    for (const match of source.matchAll(/\bwin\.([A-Za-z_$][\w$]*)\s*=\s*function/g)) names.add(match[1]);
  }
  const paineisDir = path.join(srcDir, "paineis");
  for (const painel of fs.readdirSync(paineisDir)) {
    const montar = path.join(paineisDir, painel, "montar.tsx");
    if (!fs.existsSync(montar)) continue;
    for (const match of fs.readFileSync(montar, "utf8").matchAll(/Object\.assign\(window,\s*\{([^}]*)\}\)/g)) {
      match[1].split(",").map(name => name.trim()).filter(Boolean).forEach(name => names.add(name));
    }
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
  // app.ts creates the features from the registry (the old window.SimpressFeatures) and the ticket rules from ticket-rules.ts.
  assert.deepEqual(Object.keys(fabricas).sort(), [...order].sort());
  assert.match(bootstrapSource, /import \{ fabricas \} from "\.\/registro\.ts";/);
  assert.match(bootstrapSource, /import \{ createTicketRules \} from "\.\/ticket-rules\.ts";/);
  assert.equal(typeof createTicketRules, "function");
  // arranque/entrada.ts loads the registry before the bootstrap and the page enhancements after it (appScriptFiles throws otherwise).
  assert.ok(appScriptFiles().length > 0);
  assert.equal(typeof window.SimpressHistoryFormat.formatarNomeFonteHistorico, "function");
});

test("shared state is exposed once and features publish no duplicate actions", () => {
  const { context, published } = bootPage();
  assert.deepEqual(Object.keys(context.SimpressApp.state).sort(), [
    "currentEquipamento", "equipamentoSelectionRevision", "previaPlanilhasAtual", "retiradaCidadeSelecionada", "unidadesList",
  ]);
  assert.equal(new Set(published).size, published.length);
  assert.ok(!published.includes("app") && !published.includes("appState"), "the bootstrap keeps its locals private");
});

test("feature modules only export factories and publish no page globals", () => {
  assert.ok(featureFiles.length >= 16, "frontend/src/aplicacao/ still holds the feature modules");
  for (const file of featureFiles) {
    const source = fs.readFileSync(file, "utf8");
    const nome = path.basename(file);
    // Nenhum módulo de aplicacao/ (nem o registro) toca em window.Simpress*: as ações saem por iniciar() em app.ts.
    assert.doesNotMatch(source, /window\.Simpress\w+\s*=[^=]|globalThis\.\w+\s*=[^=]/, `${nome} leaked a page global`);
    if (nome === "tipos.ts") continue;
    const exportados = Object.entries(require(file));
    assert.ok(exportados.length > 0, `${nome} should export something`);
    for (const [chave, valor] of exportados) {
      if (chave === "fabricas" || chave === "NOMES_PONTES") continue;
      assert.equal(typeof valor, "function", `${nome}: ${chave} should be a function`);
    }
  }
});

test("feature factories are also exported for Node", () => {
  for (const [nome, fabrica] of Object.entries(fabricas)) assert.equal(typeof fabrica, "function", nome);
  assert.equal(typeof require("../../frontend/src/aplicacao/ticket-rules.ts").createTicketRules, "function");
  const historyFormat = require("../../frontend/src/comum/history-format.ts");
  assert.equal(historyFormat.formatarNomeFonteHistorico("InvAll e EquipamentosDetalhes"), "no endpoint e na Simpress");
});
