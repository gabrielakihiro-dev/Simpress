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

test("the Histórico de Planilhas rows use the shared logged user lookup", () => {
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

test("a manual user shows when it was informed and old ones say the date was not recorded", () => {
  assert.equal(markers.tituloManual("2026-10-20T23:30:00-03:00"), "Informado manualmente em 20/10/2026");
  assert.equal(markers.tituloManual(""), "Informado manualmente (data não registrada)");
  assert.equal(markers.tituloManual("ontem"), "Informado manualmente (data não registrada)");
});

test("a series repeated in the Endpoint lists its users without choosing one", () => {
  assert.equal(markers.textoAmbiguo(["joao", " maria ", ""]), "Endpoint ambíguo: joao / maria");
  assert.equal(markers.textoAmbiguo([]), "");
  assert.equal(markers.textoAmbiguo(undefined), "");
});

function fakeMarkers(series) {
  const items = series.map(serie => ({
    dataset: { loggedUserSerie: serie },
    innerHTML: "",
    textContent: "",
    querySelector() { return null; },
  }));
  return { items, container: { querySelectorAll: () => items } };
}

async function renderWith(usuarios, series) {
  const { items, container } = fakeMarkers(series);
  const connected = createLoggedUserMarkers({
    app: { apiFetch: async () => ({ usuarios }), showToast() {} },
    appState: {},
    dom: createDomUtils({ createElement: () => ({ setAttribute() {} }) }),
  });
  connected.conectar(container);
  await new Promise(resolve => setImmediate(resolve));
  return items;
}

test("history rows and ticket cards show the manual date and the ambiguous Endpoint users", async () => {
  const [manual, ambiguous, ambiguousOutside, manualOverAmbiguous] = await renderWith({
    A: { usuario: "joao", origem: "manual", serial_cadastro: "A", informado_em: "2026-10-20T09:00:00-03:00", candidatos: [] },
    B: { usuario: "", origem: "", serial_cadastro: "B", informado_em: "", candidatos: ["ana", "bia"] },
    C: { usuario: "", origem: "", serial_cadastro: null, informado_em: "", candidatos: ["caio", "davi"] },
    D: { usuario: "pedro", origem: "manual", serial_cadastro: "D", informado_em: "", candidatos: ["eva", "fabio"] },
  }, ["A", "B", "C", "D"]);
  assert.match(manual.innerHTML, /title="Informado manualmente em 20\/10\/2026">Usuário: joao \(M\)<span class="sr-only">, informado manualmente em 20\/10\/2026<\/span>/);
  assert.doesNotMatch(manual.innerHTML, /data-logged-user-ambiguous/);
  // In the Simpress base the manual field stays available below the ambiguous notice.
  assert.match(ambiguous.innerHTML, /data-logged-user-ambiguous[^>]*>Endpoint ambíguo: ana \/ bia<\/span>/);
  assert.match(ambiguous.innerHTML, /data-logged-user-form/);
  assert.match(ambiguousOutside.innerHTML, /Endpoint ambíguo: caio \/ davi/);
  assert.doesNotMatch(ambiguousOutside.innerHTML, /data-logged-user-form/);
  assert.equal(ambiguousOutside.textContent, "");
  assert.match(manualOverAmbiguous.innerHTML, /Usuário: pedro \(M\).*data não registrada.*Endpoint ambíguo: eva \/ fabio/s);
});

test("search results carry the manual date in the title and an ambiguous chip with the candidates", () => {
  const dom = createDomUtils({ createElement: () => ({ setAttribute() {} }) });
  const renderers = require("../../static/js/ui/equipment-search-renderers.js")({ dom, loggedUserMarkers: markers });
  globalThis.document = { createElement: () => ({ attributes: {}, dataset: {}, addEventListener() {}, setAttribute(name, value) { this.attributes[name] = value; } }) };
  try {
    const base = { serial: "SN1", tipo: "Notebook", modelo: "X", apelido: "HOST-1" };
    const manual = renderers.criarLinhaPesquisaCompleta({ ...base, usuarios_logados: "joao", usuarios_logados_origem: "manual", usuarios_logados_informado_em: "2026-10-20T09:00:00-03:00" }, 0, "", () => {});
    assert.match(manual.innerHTML, /autocomplete-user [^"]*" title="Informado manualmente em 20\/10\/2026"/);
    const ambiguous = renderers.criarLinhaPesquisaCompleta({ ...base, usuarios_logados: "", usuarios_logados_candidatos: ["ana", "bia"] }, 1, "bia", () => {});
    assert.match(ambiguous.innerHTML, /autocomplete-user-ambiguous/);
    assert.match(ambiguous.innerHTML, /Endpoint ambíguo: ana \/ <span class="serial-match">bia<\/span>/);
    assert.match(ambiguous.attributes["aria-label"], /HOST-1, Endpoint ambíguo: ana \/ bia/);
    const plain = renderers.criarLinhaPesquisaCompleta({ ...base, usuarios_logados: "ana", usuarios_logados_origem: "endpoint" }, 2, "", () => {});
    assert.doesNotMatch(plain.innerHTML, /autocomplete-user-ambiguous/);
    assert.match(plain.innerHTML, /title="Usuário logado no Endpoint"/);
  } finally {
    delete globalThis.document;
  }
});
