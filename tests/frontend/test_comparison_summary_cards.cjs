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

function renderizar(comparison) {
  return renderer.conteudoResultadoComparacao(
    comparison,
    renderer.listasComparacao(comparison),
    renderer.criarColunasAnotacao(comparison),
  );
}

const cartoes = html => [...html.matchAll(/<(button|div) [^>]*data-metric-tone="[^"]*"[^>]*>\s*<p[^>]*>([^<]+)<\/p>/g)]
  .map(([tag, elemento, rotulo]) => ({ elemento, rotulo, tag, alvo: tag.match(/data-comparison-section-target="([^"]+)"/)?.[1] || "" }));

const COMPARACAO_COMPLETA = {
  total_endpoint: 12,
  ausentes_no_endpoint: [{ computador: "PRNOTE-A", serie: "SER-A" }],
  ausentes_em_detalhes: [{ computador: "PRNOTE-B", serie: "SER-B" }],
  divergencias_local: [{ computador: "PRNOTE-C", serie: "SER-C", local_previsto: "Curitiba", local_detalhes: "Londrina" }],
  correspondencias_ambiguas: [{ tipo: "Série duplicada", chave: "SER-D", fontes: [] }],
  series_sem_mapeamento: [{ serie: "XYZ", quantidade: 1, exemplos: ["XYZ1"] }],
  apelidos_atualizados: [{ serie: "SER-E", apelido_anterior: "A", apelido_novo: "B" }],
  apelidos_sem_atualizacao: [{ serie: "SER-F", hostname_endpoint: "PRNOTE-F", motivo: "Conferir" }],
  divergencias_apelidos_manuais: [{ serie: "SER-G", apelido_manual: "M" }],
};

// Card label -> visible title of the section it must reach.
const SECAO_ESPERADA = {
  "Sem correspondência — no endpoint": "Sem correspondência — Endpoint",
  "Sem correspondência — na Simpress": "Sem correspondência — Simpress",
  "Divergências de local": "Localidade divergente",
  "Duplicidades e ambiguidades": "Duplicidades e correspondências ambíguas",
  "Séries sem mapeamento": "Séries sem local definido",
  "Apelidos/hostnames atualizados": "Apelidos/hostnames atualizados — no endpoint",
  "Apelidos para conferência": "Linhas mantidas para conferência",
  "Divergências manuais pendentes": "Divergências com apelidos alterados manualmente",
};

test("summary cards with rows jump to the title of their own section", () => {
  const html = renderizar(COMPARACAO_COMPLETA);
  const encontrados = cartoes(html);
  assert.equal(encontrados.length, 9);

  for (const cartao of encontrados) {
    const esperado = SECAO_ESPERADA[cartao.rotulo];
    if (!esperado) {
      // "Notebooks comparados" has no section of its own.
      assert.equal(cartao.rotulo, "Notebooks comparados");
      assert.equal(cartao.elemento, "div");
      continue;
    }
    assert.equal(cartao.elemento, "button", cartao.rotulo);
    assert.match(cartao.tag, /type="button"/);
    assert.match(cartao.tag, /class="comparison-metric-link /);
    const titulo = html.match(new RegExp(`<h[45] id="${cartao.alvo}" tabindex="-1"[^>]*>(?:<span[^>]*></span>)?([^<(]+)`));
    assert.ok(titulo, `${cartao.rotulo} -> #${cartao.alvo} existe`);
    assert.equal(titulo[1].trim(), esperado, cartao.rotulo);
    assert.match(cartao.tag, new RegExp(`aria-label="${cartao.rotulo}: \\d+\\. Ir para ${esperado}"`));
  }
});

test("summary card targets are unique and every mapped section title is rendered once", () => {
  const html = renderizar(COMPARACAO_COMPLETA);
  const ids = Object.values(renderer.SECOES_CARTOES_RESUMO).map(secao => secao.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
});

test("summary cards stay static when the count is zero", () => {
  const html = renderizar({ total_endpoint: 0 });
  assert.doesNotMatch(html, /data-comparison-section-target/);
  assert.doesNotMatch(html, /comparison-metric-link/);
  assert.equal(cartoes(html).filter(cartao => cartao.elemento === "div").length, 9);
  // The section titles keep their ids so links from elsewhere still resolve.
  assert.match(html, /<h4 id="comparacao-secao-localidade-divergente" tabindex="-1"/);
});

test("pending manual alias card keeps its counter id inside the link", () => {
  const html = renderizar(COMPARACAO_COMPLETA);
  assert.match(html, /<button [^>]*data-comparison-section-target="comparacao-secao-apelidos-manuais"[^>]*>.*?<p id="comparacao-divergencias-manuais-pendentes"/s);
});
