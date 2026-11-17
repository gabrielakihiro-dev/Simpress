// Estatísticas e disponibilidade da Home com apiFetch injetado: 409 mantém os números, resposta antiga é ignorada.
const assert = require("node:assert/strict");
const test = require("node:test");

const { criarIndicadoresHome } = require("../../frontend/src/paineis/indicadores-home/estado.ts");
const transferUtils = require("../../frontend/src/comum/transfer-utils.ts");
const { createFakeDocument } = require("./support/fake-dom.cjs");

function montarPagina() {
  const doc = createFakeDocument();
  doc.createDocumentFragment = () => doc.createElement("fragment");
  const nos = {};
  for (const [tag, id] of [
    ["details", "readiness-panel"], ["span", "readiness-summary"], ["span", "readiness-summary-short"],
    ["ul", "readiness-details-content"], ["span", "stat-equipamentos"], ["span", "stat-base-dot"],
    ["span", "stat-equipamentos-rotulo"], ["span", "stat-unidades"],
  ]) {
    nos[id] = doc.createElement(tag);
    nos[id].setAttribute("id", id);
    doc.body.appendChild(nos[id]);
  }
  return { doc, nos };
}

function comPagina(corpo) {
  return async () => {
    const { doc, nos } = montarPagina();
    const anterior = global.document;
    const avisos = [];
    const avisoOriginal = console.warn;
    global.document = doc;
    console.warn = (...argumentos) => avisos.push(argumentos);
    try {
      await corpo({ nos, avisos });
    } finally {
      global.document = anterior;
      console.warn = avisoOriginal;
    }
  };
}

const criar = apiFetch => criarIndicadoresHome({
  app: {}, transferUtils, motion: null, dom: { pluralize: n => `${n} equipamentos` }, apiFetch,
});
const erroApi = status => Object.assign(new Error(`HTTP ${status}`), { status });

test("estatísticas: 409 de importação em andamento mantém os últimos números", comPagina(async ({ nos, avisos }) => {
  const respostas = [{ total_equipamentos: 20, total_unidades: 3 }, erroApi(409)];
  const chamadas = [];
  const acoes = criar(async (url, opcoes) => {
    chamadas.push({ url, signal: opcoes.signal });
    const resposta = respostas.shift();
    if (resposta instanceof Error) throw resposta;
    return resposta;
  });
  await acoes.carregarEstatisticas();
  assert.equal(nos["stat-equipamentos"].textContent, "20");
  assert.equal(nos["stat-base-dot"].dataset.state, "ready");
  await acoes.carregarEstatisticas();
  assert.equal(nos["stat-equipamentos"].textContent, "20");
  assert.equal(nos["stat-unidades"].textContent, "3");
  assert.equal(nos["stat-base-dot"].dataset.state, "ready");
  assert.deepEqual(avisos, []);
  assert.deepEqual(chamadas.map(chamada => chamada.url), ["/api/stats", "/api/stats"]);
  assert.ok(chamadas.every(chamada => chamada.signal instanceof AbortSignal));
}));

// Comportamento herdado de dashboard.js: o erro passa null, e Number(null) vale 0.
test("estatísticas: outro erro da API zera os indicadores e marca a base como vazia", comPagina(async ({ nos, avisos }) => {
  const respostas = [{ total_equipamentos: 20, total_unidades: 3 }, erroApi(500)];
  const acoes = criar(async () => {
    const resposta = respostas.shift();
    if (resposta instanceof Error) throw resposta;
    return resposta;
  });
  await acoes.carregarEstatisticas();
  await acoes.carregarEstatisticas();
  assert.equal(nos["stat-equipamentos"].textContent, "0");
  assert.equal(nos["stat-unidades"].textContent, "0");
  assert.equal(nos["stat-base-dot"].dataset.state, "empty");
  assert.equal(avisos.length, 1);
}));

const relatorio = disponivel => ({
  functions: {},
  files: Object.fromEntries([
    "inventario_equipamentos", "inventario_detalhes_atualizacao", "inventario_endpoint", "modelo_exportacao", "historico_chamados",
  ].map(chave => [chave, { available: disponivel }])),
});

test("disponibilidade: resposta antiga que chega depois da nova é ignorada", comPagina(async ({ nos }) => {
  const pendentes = [];
  const chamadas = [];
  const acoes = criar((url, opcoes) => {
    chamadas.push({ url, cache: opcoes.cache, signal: opcoes.signal });
    return new Promise(resolve => pendentes.push(resolve));
  });
  const antiga = acoes.carregarProntidao();
  const nova = acoes.carregarProntidao();
  pendentes[1](relatorio(true));
  await nova;
  assert.equal(nos["readiness-summary"].textContent, "Todos os 5 arquivos estão disponíveis.");
  assert.equal(nos["readiness-panel"].dataset.state, "ready");
  assert.equal(nos["readiness-panel"].getAttribute("aria-busy"), "false");
  pendentes[0](relatorio(false));
  await antiga;
  assert.equal(nos["readiness-summary"].textContent, "Todos os 5 arquivos estão disponíveis.");
  assert.equal(nos["readiness-panel"].dataset.state, "ready");
  assert.equal(nos["readiness-summary-short"].textContent, "Tudo disponível");
  assert.deepEqual(chamadas.map(chamada => [chamada.url, chamada.cache]), [["/api/prontidao", "no-store"], ["/api/prontidao", "no-store"]]);
  assert.ok(chamadas.every(chamada => chamada.signal instanceof AbortSignal));
}));

test("disponibilidade: falha da API mostra o estado de erro e a orientação aprovada", comPagina(async ({ nos }) => {
  const acoes = criar(async () => { throw new Error("falha"); });
  await acoes.carregarProntidao();
  assert.equal(nos["readiness-panel"].dataset.state, "error");
  assert.equal(nos["readiness-summary"].textContent, "Não foi possível consultar a disponibilidade das funções.");
  assert.equal(nos["readiness-summary-short"].textContent, "Indisponível");
  assert.equal(nos["readiness-details-content"].textContent, "Confira se o servidor está em execução e recarregue a página para tentar novamente.");
  assert.equal(nos["readiness-panel"].getAttribute("aria-busy"), "false");
}));

test("alerta da base: o detalhe que chegou antes do painel montar aparece já na inicialização", comPagina(async () => {
  const card = global.document.createElement("section");
  card.setAttribute("id", "alerta-base-desatualizada");
  card.hidden = true;
  global.document.body.appendChild(card);
  const acoes = criar(async () => ({}));
  acoes.inicializarAlertaBaseDesatualizada(() => ({ base_desatualizada: { estado: "sem_base" } }));
  assert.equal(card.hidden, false);
  assert.equal(card.dataset.state, "sem_base");
}));
