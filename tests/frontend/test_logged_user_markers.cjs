const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const createLoggedUserMarkers = require("../../static/js/ui/logged-user-markers.js");

const staticDir = path.join(__dirname, "..", "..", "static");
const markers = createLoggedUserMarkers({ dom: createDomUtils({ createElement: () => ({ setAttribute() {} }) }) });

test("the logged user marker carries the trimmed, escaped series and is skipped without one", () => {
  assert.equal(
    markers.marcador("  SN<1>  "),
    '<span class="logged-user" data-logged-user data-logged-user-serie="SN&lt;1&gt;"></span>',
  );
  assert.equal(markers.marcador(""), "");
  assert.equal(markers.marcador(null), "");
});

test("ticket cards and the Histórico de Planilhas rows share the same logged user lookup", () => {
  const tickets = fs.readFileSync(path.join(staticDir, "js", "features", "ticket-tracking.js"), "utf8");
  assert.match(tickets, /loggedUserMarkers\.marcador\(record\.serie\)/);
  assert.match(tickets, /loggedUserMarkers\.conectar\(list\)/);
  const comparison = fs.readFileSync(path.join(staticDir, "js", "features", "comparison-result.js"), "utf8");
  assert.match(comparison, /loggedUserMarkers\.conectar\(content\)/);
});

test("search results show the logged user to the right of the hostname, with (M) for a manual one", () => {
  const renderers = require("../../static/js/ui/equipment-search-renderers.js")({
    dom: createDomUtils({ createElement: () => ({ setAttribute() {} }) }),
  });
  const rows = [];
  globalThis.document = { createElement: () => {
    const row = { attributes: {}, dataset: {}, addEventListener() {}, setAttribute(name, value) { this.attributes[name] = value; } };
    rows.push(row);
    return row;
  } };
  try {
    const base = { serial: "SCXC9F072K1", tipo: "Notebook", modelo: "MacBook", apelido: "PRMACUMC005" };
    const endpoint = renderers.criarLinhaPesquisaCompleta({ ...base, usuarios_logados: "DDrodrigues", usuarios_logados_origem: "endpoint" }, 0, "drod", () => {});
    assert.ok(endpoint.innerHTML.indexOf("autocomplete-user") > endpoint.innerHTML.indexOf("PRMACUMC005"));
    assert.match(endpoint.innerHTML, /D<span class="serial-match">Drod<\/span>rigues/);
    assert.match(endpoint.attributes["aria-label"], /PRMACUMC005, usuário DDrodrigues/);
    const manual = renderers.criarLinhaPesquisaCompleta({ ...base, usuarios_logados: "joao", usuarios_logados_origem: "manual" }, 1, "", () => {});
    assert.match(manual.innerHTML, /joao \(M\)/);
    const empty = renderers.criarLinhaPesquisaCompleta({ ...base, usuarios_logados: "" }, 2, "", () => {});
    assert.doesNotMatch(empty.innerHTML, /autocomplete-user/);
  } finally {
    delete globalThis.document;
  }
});
