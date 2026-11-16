// Home: cartão "Chamados abertos" do equipamento. Desde o G8 a lista (OS abertas do Oracle, chamados do F5, consulta
// parcial, resposta atrasada, texto vazio, alerta de falha) é desenhada pelo painel React
// frontend/src/paineis/cockpit-chamados/ e testada no navegador (tests/e2e/react-g8.spec.cjs); a regra de quais
// chamados entram e como se contam está em test_cockpit_chamados_puro.cjs. Aqui ficam o HTML do cartão, quem chama a
// atualização e a ponte do código antigo.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assembledHtml, staticDir } = require("./support/assembled-html.cjs");
const createCockpitChamados = require("../../static/js/features/cockpit-chamados.js");

const lido = arquivo => fs.readFileSync(path.join(staticDir, arquivo), "utf8");

function featureComPonte(acao) {
  const context = {
    app: {},
    ponteReact: (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => acao(nome, ...argumentos)])),
  };
  return createCockpitChamados(context);
}

test("cartão da Home: título, contagem em região de status e corpo livre para o painel React", () => {
  const html = assembledHtml();
  const cartao = html.match(/<aside class="ck-cartao" aria-labelledby="home-open-tickets-title">[\s\S]*?<\/aside>/)?.[0];
  assert.ok(cartao, "cartão de Chamados abertos");
  assert.match(cartao, /<h2 id="home-open-tickets-title"[^>]*>Chamados abertos<\/h2>/);
  assert.match(cartao, /<span id="home-open-tickets-count"[^>]*role="status"[^>]*aria-live="polite"><\/span>/, "contagem nasce vazia; o React troca só o texto");
  assert.match(cartao, /<div id="home-open-tickets-body" aria-busy="false"><\/div>/, "corpo nasce vazio e sem espera; o React escreve o aria-busy");
});

test("busca de equipamento: a Home pede a atualização uma vez por equipamento, pela ação publicada", () => {
  const busca = lido("js/features/equipment-search.js");
  assert.equal(busca.split("app.atualizarChamadosAbertosHome(eq.serial)").length - 1, 1);
});

test("ponte: a Home repassa a série ao painel React e nunca rejeita, mesmo sem o React carregado", async () => {
  const recebido = [];
  const feature = featureComPonte(async (nome, ...argumentos) => { recebido.push([nome, ...argumentos]); });
  await feature.atualizarChamadosAbertosHome("5CG6051BVN");
  assert.deepEqual(recebido, [["atualizarChamadosAbertosHome", "5CG6051BVN"]]);

  const erros = [];
  const original = console.error;
  console.error = erro => erros.push(erro.message);
  try {
    const semReact = featureComPonte(() => Promise.reject(new Error('O painel React "cockpit-chamados" não carregou.')));
    assert.equal(await semReact.atualizarChamadosAbertosHome("S1"), undefined);
  } finally {
    console.error = original;
  }
  assert.deepEqual(erros, ['O painel React "cockpit-chamados" não carregou.']);
});
