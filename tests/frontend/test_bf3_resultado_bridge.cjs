// Ponte do resultado da Comparação para as ações React: tudo no mesmo turno (síncrona), com valor de reserva sem o painel.
const assert = require("node:assert/strict");
const test = require("node:test");

const criarComparisonResult = require("../../frontend/src/legado/features/comparison-result.js");

const ACOES = [
  "renderizarResultadoComparacao", "renderizarSemUsuarioSemComparacao", "carregarSemUsuarioResumo",
  "invalidarSemUsuarioResumo", "navegarParaLinhaComparacao", "irParaSecaoComparacao", "atributosVersaoAnotacao",
  "renderizarAnotacaoOperacional", "conectarAnotacoesOperacionais", "selecionarAbaResumo", "limparAbasResumo",
];

function criarPontes() {
  const chamadas = [];
  const ponteReact = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async (...argumentos) => {
    chamadas.push({ tipo: "async", painel, nome, argumentos });
    return `async:${nome}`;
  }]));
  const ponteReactSincrona = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
    chamadas.push({ tipo: "sync", painel, nome, argumentos });
    return `sync:${nome}`;
  }]));
  return { chamadas, ponteReact, ponteReactSincrona };
}

test("a ponte expõe as 11 ações do resultado e encaminha todas ao painel resultado-comparacao", () => {
  const pontes = criarPontes();
  const acoes = criarComparisonResult(pontes);
  assert.deepEqual(Object.keys(acoes).sort(), [...ACOES].sort());

  const comparacao = { evento_id: "evento-1" };
  for (const nome of ACOES) assert.equal(acoes[nome](comparacao, "alvo"), `sync:${nome}`);

  assert.deepEqual(pontes.chamadas, ACOES.map(nome => ({
    tipo: "sync", painel: "resultado-comparacao", nome, argumentos: [comparacao, "alvo"],
  })));
});

test("a ponte não usa a ponte assíncrona: o código legado chama no mesmo turno e espera o valor na hora", () => {
  const pontes = criarPontes();
  const acoes = criarComparisonResult(pontes);
  for (const nome of ACOES) assert.equal(typeof acoes[nome]().then, "undefined", nome);
  assert.equal(pontes.chamadas.some(chamada => chamada.tipo === "async"), false);
});

test("sem o painel React as ações devolvem o valor de reserva e nenhuma lança", async () => {
  const acoes = criarComparisonResult({
    ponteReact: () => { throw new Error("a ponte assíncrona não deve ser usada"); },
    ponteReactSincrona: (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => undefined])),
  });
  assert.equal(acoes.atributosVersaoAnotacao({}), "");
  assert.equal(acoes.renderizarAnotacaoOperacional({ anotacao_id: "a" }, "ctx"), "");
  assert.equal(acoes.irParaSecaoComparacao("secao"), false);
  assert.equal(acoes.navegarParaLinhaComparacao({ serial: "SN-1" }), false);
  assert.equal(await acoes.carregarSemUsuarioResumo(), undefined);
  for (const nome of [
    "renderizarResultadoComparacao", "renderizarSemUsuarioSemComparacao", "invalidarSemUsuarioResumo",
    "conectarAnotacoesOperacionais", "selecionarAbaResumo", "limparAbasResumo",
  ]) assert.equal(acoes[nome]({}), undefined, nome);
});

test("com o painel, valores falsos legítimos do painel não são trocados pelo valor de reserva", async () => {
  const acoes = criarComparisonResult({
    ponteReact: () => ({}),
    ponteReactSincrona: (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => (
      nome === "carregarSemUsuarioResumo" ? Promise.resolve({ estado: "ok", items: [] }) : false
    )])),
  });
  assert.equal(acoes.irParaSecaoComparacao("secao"), false);
  assert.equal(acoes.navegarParaLinhaComparacao({}), false);
  assert.deepEqual(await acoes.carregarSemUsuarioResumo(), { estado: "ok", items: [] });
});

function comDocumento(corpo) {
  const conteudo = { filhos: ["Carregando comparação…"], dataset: { estado: "carregando" }, replaceChildren(...nos) { this.filhos = nos; } };
  const anteriores = { document: globalThis.document, react: globalThis.SimpressReact };
  globalThis.document = {
    getElementById: id => (id === "comparacao-planilhas-conteudo" ? conteudo : null),
    createElement: tag => ({ tag, className: "", textContent: "" }),
  };
  try {
    corpo(conteudo);
  } finally {
    globalThis.document = anteriores.document;
    globalThis.SimpressReact = anteriores.react;
  }
}
const pontesQueNaoDevolvem = () => ({
  ponteReact: () => ({}),
  ponteReactSincrona: (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => undefined])),
});

test("sem o painel React o resultado da Comparação sai de Carregando para o estado de erro", () => comDocumento(conteudo => {
  delete globalThis.SimpressReact;
  criarComparisonResult(pontesQueNaoDevolvem()).renderizarResultadoComparacao({ evento_id: "evento-1" });
  assert.equal(conteudo.dataset.estado, "erro");
  assert.deepEqual(conteudo.filhos, [{ tag: "p", className: "ck-nota ck-nota--erro", textContent: "Não foi possível abrir a comparação." }]);
}));

test("com o painel montado, o render que não devolve nada não troca o conteúdo", () => comDocumento(conteudo => {
  globalThis.SimpressReact = { "resultado-comparacao": {} };
  criarComparisonResult(pontesQueNaoDevolvem()).renderizarResultadoComparacao({ evento_id: "evento-1" });
  assert.equal(conteudo.dataset.estado, "carregando");
  assert.deepEqual(conteudo.filhos, ["Carregando comparação…"]);
}));
