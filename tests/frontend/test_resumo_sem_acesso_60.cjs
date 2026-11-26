const assert = require("node:assert/strict");
const test = require("node:test");
const { createDomUtils } = require("../../frontend/src/comum/dom-utils.ts");
const historyFormat = require("../../frontend/src/comum/history-format.ts");
const { criarRenderizadorResultado } = require("../../frontend/src/paineis/resultado-comparacao/renderizador.ts");
const { createLoggedUserMarkers } = require("../../frontend/src/ui/logged-user-markers.ts");

const dom = createDomUtils({ createElement: () => ({ setAttribute() {} }) });
const renderer = criarRenderizadorResultado({
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
  assert.ok(html.indexOf("Sem acesso de 7 a 59 dias") < html.indexOf("Passou de 60 dias sem acesso"));
  assert.match(html, /Hostname\/Apelido, Série, Dias sem acesso, Situação/);
  const linhas = [...html.matchAll(/<tr [^>]*data-sem-acesso-60-situacao="([^"]+)"[\s\S]*?<\/tr>/g)];
  assert.deepEqual(linhas.map(([, situacao]) => situacao), ["saiu_endpoint", "passou"]);
  assert.match(linhas[0][0], /~64[\s\S]*Saiu para Ausentes no Endpoint/);
  assert.match(linhas[1][0], />61<[\s\S]*Ainda no Endpoint, sem acesso/);
  assert.match(linhas[1][0], /&lt;b&gt;PRNOTE-N1/);
  assert.match(html, /href="\/api\/config\/local\/endpoint\/staged-computers"[^>]*data-endpoint-staged-link/);
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

test("7 a 59 dias exclui as séries que já estão na de 60+ (decisão do usuário, 26/11/2026)", () => {
  const comparison = {
    sem_acesso_7_dias: [
      { serie: "A1", computador: "PRNOTE-A1", dias_sem_verificacao: 9 },
      { serie: "N1", computador: "PRNOTE-N1", dias_sem_verificacao: 61 },
    ],
    sem_acesso_60_dias: [
      { serie: "N1", computador: "PRNOTE-N1", dias: 61, situacao: "passou" },
      { serie: "X1", computador: "PRNOTE-X1", dias: 64, situacao: "saiu_endpoint" },
    ],
  };
  // A lista de 60+ é derivada da 7+ de origem: ela continua inteira, só a de 7 a 59 perde a sobreposição.
  assert.deepEqual(renderer.listasComparacao(comparison).semAcesso7DiasOrdenados.map(item => item.serie), ["A1"]);
  assert.equal(comparison.sem_acesso_7_dias.length, 2);
  const html = renderizar(comparison);
  assert.match(html, /Sem acesso de 7 a 59 dias/);
  assert.equal([...html.matchAll(/data-comparison-category="sem_acesso_7_dias"/g)].length, 1);
  assert.equal([...html.matchAll(/data-comparison-category="sem_acesso_60_dias"/g)].length, 2);
  // Sem a lista de 60+ (resultado antigo), nada é tirado.
  assert.equal(renderer.listasComparacao({ sem_acesso_7_dias: comparison.sem_acesso_7_dias }).semAcesso7DiasOrdenados.length, 2);
});

test("A anotação da linha de 7+ que saiu da tela continua editável na linha de 60+ da mesma série", () => {
  const html = renderizar({
    evento_id: "evt-1", contexto_historico: true,
    sem_acesso_7_dias: [{ serie: "N1", computador: "PRNOTE-N1", dias_sem_verificacao: 61, anotacao_id: "id-7", anotacao: "Usuário de férias." }],
    sem_acesso_60_dias: [{ serie: "N1", computador: "PRNOTE-N1", dias: 61, situacao: "passou", anotacao_id: "id-60" }],
  });
  assert.doesNotMatch(html, /data-comparison-category="sem_acesso_7_dias"/);
  const [linha] = [...html.matchAll(/<tr [^>]*data-sem-acesso-60-situacao="[^"]+"[\s\S]*?<\/tr>/g)].map(([trecho]) => trecho);
  assert.match(linha, /data-annotation-id="id-60"/);
  assert.match(linha, /Anotação anterior[\s\S]*data-annotation-id="id-7"[^>]*>Usuário de férias\.<\/textarea>/);
});
