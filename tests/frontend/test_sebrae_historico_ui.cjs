// Automação: resumo das últimas entradas do histórico do Dashboard Sebrae. Desde a migração do G1 (Sebrae) a
// mini-lista vive em frontend/src/paineis/sebrae-historico/ e os textos (rótulos, singular e plural,
// reimportado, data inválida, erro, lista vazia, tipo sem HTML) são testados no navegador:
// tests/e2e/react-g1.spec.cjs. Aqui ficam o registro, a ponte do código antigo e o HTML montado.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const createSebraeHistorico = require("../../frontend/src/aplicacao/registro.ts").fabricas.sebraeHistorico;
const { assembledHtml } = require("./support/assembled-html.cjs");
const { legadoDir } = require("./support/app-sources.cjs");

const root = path.resolve(__dirname, "../..");
const painelReact = path.join(root, "frontend/src/paineis/sebrae-historico");
const lido = arquivo => fs.readFileSync(path.join(legadoDir, arquivo), "utf8");

function ponteFalsa(acao) {
  const chamadas = [];
  const context = {
    ponteReact(painel, nomes) {
      chamadas.push([painel, nomes]);
      return { carregarResumoHistoricoSebrae: acao };
    },
  };
  return { chamadas, feature: createSebraeHistorico(context) };
}

test("registro: módulo importado no app-entry, publicado no FEATURE_ORDER e um gancho no Dashboard", () => {
  assert.match(lido("app-entry.js"), /^import "\.\.\/aplicacao\/registro\.ts";$/m);
  assert.equal(typeof require("../../frontend/src/aplicacao/registro.ts").fabricas.sebraeHistorico, "function");
  assert.match(lido("app.js"), /"sebraeHistorico",/);
  assert.ok(fs.existsSync(path.join(painelReact, "montar.tsx")));
  const dashboard = fs.readFileSync(path.join(root, "frontend/src/paineis/sebrae-dashboard/estado.ts"), "utf8");
  assert.equal(dashboard.split("app.carregarResumoHistoricoSebrae").length - 1, 1, "um só gancho no Dashboard");
});

test("ponte: carregarResumoHistoricoSebrae repassa ao painel React sebrae-historico", async () => {
  let chamou = 0;
  const { chamadas, feature } = ponteFalsa(async () => { chamou += 1; });
  assert.deepEqual(chamadas, [["sebrae-historico", ["carregarResumoHistoricoSebrae"]]]);
  assert.equal(chamou, 0, "criar o módulo não chama o React");
  await feature.carregarResumoHistoricoSebrae();
  assert.equal(chamou, 1);
});

test("ponte: se o React não carregou, carregarResumoHistoricoSebrae registra o erro e não rejeita (o Dashboard segue)", async () => {
  const erros = [];
  const original = console.error;
  console.error = erro => erros.push(erro);
  try {
    const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "sebrae-historico" não carregou.')));
    assert.equal(await feature.carregarResumoHistoricoSebrae(), undefined);
  } finally {
    console.error = original;
  }
  assert.deepEqual(erros, ['carregarResumoHistoricoSebrae: O painel React "sebrae-historico" não carregou.']);
});

test("index.html: contêiner vazio do resumo no cartão de chamados novos, sem IDs duplicados", () => {
  const html = assembledHtml();
  const host = html.match(/<div id="sebrae-historico-resumo"[^>]*><\/div>/);
  assert.ok(host, "o contêiner fica vazio no HTML: o React desenha a lista dentro dele");
  assert.match(host[0], /class="sebrae-historico-resumo"/);
  assert.match(host[0], /data-react-painel="sebrae-historico"/);
  assert.ok(html.indexOf('id="sebrae-novos-resumo"') < html.indexOf('id="sebrae-historico-resumo"'), "logo depois do resumo dos chamados novos");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test("painel React: texto do histórico entra só como texto (sem dangerouslySetInnerHTML nem innerHTML)", () => {
  for (const arquivo of fs.readdirSync(painelReact)) {
    assert.doesNotMatch(fs.readFileSync(path.join(painelReact, arquivo), "utf8"), /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|outerHTML/, arquivo);
  }
});
