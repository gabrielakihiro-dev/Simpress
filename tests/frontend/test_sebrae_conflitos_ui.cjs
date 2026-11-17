// Chamados (F5): conflitos de edição do Dashboard. Desde a migração do G1 (Sebrae) a seção vive em
// frontend/src/paineis/sebrae-conflitos/ e o comportamento (escolhas, POST só no clique com enviar e
// versao_importacao, aceita_site, 422/409, acompanhamento do envio, texto sem HTML) é testado no navegador:
// tests/e2e/react-g1.spec.cjs. Aqui ficam o registro, a ponte do código antigo e o HTML montado.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const createSebraeConflitos = require("../../static/js/features/sebrae-conflitos.js");
const { assembledHtml, staticDir } = require("./support/assembled-html.cjs");

const root = path.resolve(__dirname, "../..");
const painelReact = path.join(root, "frontend/src/paineis/sebrae-conflitos");
const lido = arquivo => fs.readFileSync(path.join(staticDir, arquivo), "utf8");

function ponteFalsa(acao) {
  const chamadas = [];
  const context = {
    ponteReact(painel, nomes) {
      chamadas.push([painel, nomes]);
      return { carregarConflitosSebrae: acao };
    },
  };
  return { chamadas, feature: createSebraeConflitos(context) };
}

test("registro: módulo importado no app-entry, publicado no FEATURE_ORDER e um gancho no Dashboard", () => {
  assert.match(lido("app-entry.js"), /^import "\.\/js\/features\/sebrae-conflitos\.js";$/m);
  assert.match(lido("app.js"), /"sebraeConflitos",/);
  assert.ok(fs.existsSync(path.join(painelReact, "montar.tsx")));
  const dashboard = fs.readFileSync(path.join(root, "frontend/src/paineis/sebrae-dashboard/estado.ts"), "utf8");
  assert.equal(dashboard.split("app.carregarConflitosSebrae").length - 1, 1, "um só gancho no Dashboard");
});

test("ponte: carregarConflitosSebrae repassa ao painel React sebrae-conflitos", async () => {
  let chamou = 0;
  const { chamadas, feature } = ponteFalsa(async () => { chamou += 1; });
  assert.deepEqual(chamadas, [["sebrae-conflitos", ["carregarConflitosSebrae"]]]);
  assert.equal(chamou, 0, "criar o módulo não chama o React");
  await feature.carregarConflitosSebrae();
  assert.equal(chamou, 1);
});

test("ponte: se o React não carregou, carregarConflitosSebrae registra o erro e não rejeita (o Dashboard segue)", async () => {
  const erros = [];
  const original = console.error;
  console.error = erro => erros.push(erro.message);
  try {
    const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "sebrae-conflitos" não carregou.')));
    assert.equal(await feature.carregarConflitosSebrae(), undefined);
  } finally {
    console.error = original;
  }
  assert.deepEqual(erros, ['O painel React "sebrae-conflitos" não carregou.']);
});

test("index.html: seção vazia e escondida logo depois do aviso do SharePoint, sem IDs duplicados", () => {
  const html = assembledHtml();
  const secao = html.match(/<section id="sebrae-conflitos"[^>]*><\/section>/);
  assert.ok(secao, "a seção fica vazia no HTML: o React desenha os filhos dentro dela");
  assert.match(secao[0], /class="sebrae-conflitos"/);
  assert.match(secao[0], /aria-labelledby="sebrae-conflitos-titulo"/);
  assert.match(secao[0], /data-react-painel="sebrae-conflitos"/);
  assert.match(secao[0], /\bhidden\b/, "nasce escondida");
  assert.ok(html.indexOf('id="sebrae-sharepoint-aviso"') < html.indexOf('id="sebrae-conflitos"'), "logo depois do aviso do SharePoint");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test("painel React: valor vindo do SharePoint entra só como texto (sem dangerouslySetInnerHTML nem innerHTML)", () => {
  for (const arquivo of fs.readdirSync(painelReact)) {
    assert.doesNotMatch(fs.readFileSync(path.join(painelReact, arquivo), "utf8"), /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|outerHTML/, arquivo);
  }
});
