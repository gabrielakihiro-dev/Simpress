const assert = require("node:assert/strict");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createComparisonResultRenderer = require("../../static/js/ui/comparison-result-renderer.js");
const createLoggedUserMarkers = require("../../static/js/ui/logged-user-markers.js");

const dom = createDomUtils({ createElement: () => ({ setAttribute() {} }) });
const renderer = createComparisonResultRenderer({
  app: { atributosVersaoAnotacao: () => "" },
  dom,
  historyFormat,
  loggedUserMarkers: createLoggedUserMarkers({ dom }),
});

// The table renderer derives mobile cards through <template>; this markup check only needs the desktop rows.
globalThis.document = { createElement: () => ({ content: { querySelector: () => null } }) };

const REGISTRO = {
  computador: "PRNOTE-OLD / PRNOTE-NEW",
  serie: "SN-1",
  fontes: { Endpoint: "ambíguo", Simpress: "presente" },
  ultima_verificacao: "2026-10-19T10:00",
  motivo: "Há registros duplicados.",
  registros_endpoint: [
    { serie: "SN-1", computador: "PRNOTE-OLD", ultima_verificacao: "2026-09-01T10:00", linha_endpoint: 2, mais_antigo: true },
    { serie: "SN-1", computador: "PRNOTE-NEW", ultima_verificacao: "2026-10-19T10:00", linha_endpoint: 3, mais_antigo: false },
  ],
};

function renderizar(extra) {
  const comparison = { registros_ambiguos: [REGISTRO], ...extra };
  return renderer.conteudoResultadoComparacao(
    comparison,
    renderer.listasComparacao(comparison),
    renderer.criarColunasAnotacao(comparison),
  );
}

const SALVO = { evento_id: "evento-1", contexto_historico: true };

test("only the oldest duplicated hostname gets the remove button in a saved result", () => {
  const html = renderizar(SALVO);
  assert.equal((html.match(/data-hostname-remove(?!d)/g) || []).length, 1);
  const itemAntigo = html.match(/<li[^>]*data-hostname-nome="PRNOTE-OLD"[\s\S]*?<\/li>/)[0];
  const itemNovo = html.match(/<li[^>]*data-hostname-nome="PRNOTE-NEW"[\s\S]*?<\/li>/)[0];
  assert.match(itemAntigo, /data-hostname-remove/);
  assert.match(itemAntigo, /data-hostname-restore[^>]*\bhidden\b|hidden data-hostname-restore/);
  assert.doesNotMatch(itemNovo, /data-hostname-remove/);
  assert.match(itemAntigo, /data-hostname-serie="SN-1"/);
});

test("results that are not saved to the history list the hostnames without actions", () => {
  const html = renderizar({});
  assert.match(html, /data-hostname-nome="PRNOTE-OLD"/);
  assert.doesNotMatch(html, /data-hostname-remove/);
});

test("a single Endpoint row keeps the plain last verification", () => {
  const { registros_endpoint: _omitido, ...semLista } = REGISTRO;
  const comparison = { ...SALVO, registros_ambiguos: [semLista] };
  const html = renderer.conteudoResultadoComparacao(
    comparison,
    renderer.listasComparacao(comparison),
    renderer.criarColunasAnotacao(comparison),
  );
  assert.doesNotMatch(html, /data-hostname-item/);
  assert.doesNotMatch(html, /data-hostname-remove/);
});
