// Resumo (painel "comparacao"): cartão "Ativos por regional". Desde o Bloco 3 (piloto React) o cartão vive em
// frontend/src/paineis/resumo-ativos/ e o comportamento (barras, filtros, "Ver menos", avisos, esqueleto,
// data-estado) é testado no navegador: tests/e2e/react-piloto.spec.cjs. Aqui ficam o registro, a ponte do
// código antigo e o HTML montado.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = assembledHtml();
const appSource = fs.readFileSync(path.join(root, "frontend/src/aplicacao/app.ts"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "frontend/src/arranque/entrada.ts"), "utf8");
const createResumoAtivos = require("../../frontend/src/aplicacao/registro.ts").fabricas.resumoAtivos;

function ponteFalsa(acao) {
  const chamadas = [];
  const context = {
    ponteReact(painel, nomes) {
      chamadas.push([painel, nomes]);
      return { carregarResumoAtivos: acao };
    },
  };
  return { chamadas, feature: createResumoAtivos(context) };
}

test("registro: módulo importado no arranque e publicado no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\.\/aplicacao\/registro\.ts";/);
  assert.equal(typeof require("../../frontend/src/aplicacao/registro.ts").fabricas.resumoAtivos, "function");
  assert.match(appSource, /"resumoAtivos",/);
  assert.ok(fs.existsSync(path.join(root, "frontend/src/paineis/resumo-ativos/montar.tsx")));
});

test("ponte: carregarResumoAtivos repassa ao painel React resumo-ativos", async () => {
  let chamou = 0;
  const { chamadas, feature } = ponteFalsa(async () => { chamou += 1; });
  assert.deepEqual(chamadas, [["resumo-ativos", ["carregarResumoAtivos"]]]);
  assert.equal(chamou, 0, "criar o módulo não chama o React");
  await feature.carregarResumoAtivos();
  assert.equal(chamou, 1);
});

test("ponte: se o React não carregou, carregarResumoAtivos registra o erro e não rejeita (o Resumo abre)", async () => {
  const erros = [];
  const original = console.error;
  console.error = erro => erros.push(erro);
  try {
    const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "resumo-ativos" não carregou.')));
    assert.equal(await feature.carregarResumoAtivos(), undefined);
  } finally {
    console.error = original;
  }
  assert.deepEqual(erros, ['carregarResumoAtivos: O painel React "resumo-ativos" não carregou.']);
});

test("index.html: seção do cartão React no painel comparacao, sem a tabela Total de ativos e sem IDs duplicados", () => {
  const painel = html.match(/<section[^>]*data-cockpit-tool-panel="comparacao"[\s\S]*?\n        <\/section>/)[0];
  const secao = painel.match(/<section id="resumo-ativos-secao"[^>]*><\/section>/);
  assert.ok(secao, "a seção fica vazia no HTML: o React desenha o cartão dentro dela");
  assert.match(secao[0], /class="ck-resumo-secao"/);
  assert.match(secao[0], /aria-labelledby="resumo-regionais-titulo"/);
  assert.match(secao[0], /data-react-painel="resumo-ativos"/);
  assert.ok(painel.indexOf('id="comparacao-planilhas-conteudo"') < painel.indexOf('id="resumo-ativos-secao"'));
  assert.doesNotMatch(painel, /resumo-total|Total de ativos/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicados = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(duplicados, []);
});
