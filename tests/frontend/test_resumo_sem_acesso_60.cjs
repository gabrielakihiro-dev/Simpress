const assert = require("node:assert/strict");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createComparisonResultRenderer = require("../../static/js/ui/comparison-result-renderer.js");
const createLoggedUserMarkers = require("../../static/js/ui/logged-user-markers.js");

const dom = createDomUtils({ createElement: () => ({ setAttribute() {} }) });
const renderer = createComparisonResultRenderer({
  app: { atributosVersaoAnotacao: () => "" }, dom, historyFormat, loggedUserMarkers: createLoggedUserMarkers({ dom }),
});

// The table renderer derives mobile cards through <template>; the markup checks only need the desktop rows.
globalThis.document = { createElement: () => ({ content: { querySelector: () => null } }) };

function renderizar(extra) {
  const comparison = { total_endpoint: 3, sem_acesso_7_dias: [], mudancas_usuarios: [], ...extra };
  return renderer.conteudoResultadoComparacao(comparison, renderer.listasComparacao(comparison), renderer.criarColunasAnotacao(comparison));
}

test("Resumo lists notebooks past 60 days after the 7+ table, with estimated days marked", () => {
  const html = renderizar({
    sem_acesso_60_dias: [
      { serie: "X1", computador: "PRNOTE-X1", dias: 64, situacao: "saiu_endpoint" },
      { serie: "N1", computador: "<b>PRNOTE-N1</b>", dias: 61, situacao: "passou" },
    ],
  });
  assert.match(html, /Passou de 60 dias sem acesso \(2\)<\/h4>/);
  assert.ok(html.indexOf("Sem acesso há 7 dias ou mais") < html.indexOf("Passou de 60 dias sem acesso"));
  assert.match(html, /Hostname\/Apelido, Série, Dias sem acesso, Situação/);
  const linhas = [...html.matchAll(/<tr [^>]*data-sem-acesso-60-situacao="([^"]+)"[\s\S]*?<\/tr>/g)];
  assert.deepEqual(linhas.map(([, situacao]) => situacao), ["saiu_endpoint", "passou"]);
  assert.match(linhas[0][0], /~64[\s\S]*Saiu para Ausentes no Endpoint/);
  assert.match(linhas[1][0], />61<[\s\S]*Ainda em Sem acesso há 7 dias ou mais/);
  assert.match(linhas[1][0], /&lt;b&gt;PRNOTE-N1/);
  assert.match(html, /href="https:\/\/centralendpoint\.pr\.sebrae\.com\.br\/webclient#\/uems\/agent\/som\/staged-computers"[^>]*data-endpoint-staged-link/);
});

test("Empty list keeps the section with a message; without the field the section is left out", () => {
  assert.match(renderizar({ sem_acesso_60_dias: [] }), /Nenhum notebook passou de 60 dias sem acesso nesta atualização\./);
  assert.doesNotMatch(renderizar({}), /Passou de 60 dias sem acesso|data-sem-acesso-60-secao/);
});

test("Past-60-day rows get an annotation cell and a filter category only in a saved-history context", () => {
  const itens = [{ serie: "X1", computador: "PRNOTE-X1", dias: 64, situacao: "saiu_endpoint", anotacao_id: "id-x1", anotacao: "Conferir no Endpoint." }];
  const html = renderizar({ sem_acesso_60_dias: itens, evento_id: "evt-1", contexto_historico: true });
  const [linha] = [...html.matchAll(/<tr [^>]*data-sem-acesso-60-situacao="[^"]+"[\s\S]*?<\/tr>/g)].map(([trecho]) => trecho);
  assert.match(linha, /data-comparison-category="sem_acesso_60_dias"/);
  assert.match(linha, /data-comparison-item-id="id-x1"/);
  assert.match(linha, /<textarea[^>]*data-annotation-id="id-x1"[^>]*>Conferir no Endpoint\.<\/textarea>/);
  assert.match(html, /data-history-filter-group="sem_acesso_60_dias"/);
  assert.match(html, /Hostname\/Apelido, Série, Dias sem acesso, Situação, Anotações/);

  const semContexto = renderizar({ sem_acesso_60_dias: itens });
  assert.doesNotMatch(semContexto, /data-annotation-id="id-x1"/);
  assert.doesNotMatch(semContexto, /Situação, Anotações/);
});
