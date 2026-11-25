// Ponte dos indicadores da Home para as ações React: boot assíncrono, chamadas do mesmo turno síncronas.
const assert = require("node:assert/strict");
const test = require("node:test");

const criarDashboard = require("../../frontend/src/aplicacao/registro.ts").fabricas.dashboard;

const ASSINCRONAS = [
  "carregarEstatisticas", "carregarProntidao", "inicializarProntidao",
  "inicializarAlertaBaseDesatualizada", "inicializarAlertasOsDivergencias",
];
const SINCRONAS = [
  "atualizarIndicadoresPosSalvamento", "renderizarAlertaBaseDesatualizada", "renderizarAlertaOsParadas",
  "renderizarAlertaDivergenciasNovas", "renderizarAlertaSemAcesso60", "renderizarAlertaChamadosOutroTecnico",
  "renderizarAlertaFalhasFinalizacao", "renderizarAlertaBackupsRegionais",
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

test("a ponte expõe as 12 ações dos indicadores e encaminha todas ao painel indicadores-home", async () => {
  const pontes = criarPontes();
  const acoes = criarDashboard(pontes);
  assert.deepEqual(Object.keys(acoes).sort(), [...ASSINCRONAS, ...SINCRONAS].sort());

  const info = { estado: "paradas", total: 1 };
  for (const nome of ASSINCRONAS) assert.equal(await acoes[nome](), `async:${nome}`);
  for (const nome of SINCRONAS) assert.equal(acoes[nome](info), `sync:${nome}`);

  const comLeitor = new Set(["inicializarAlertaBaseDesatualizada", "inicializarAlertasOsDivergencias"]);
  for (const chamada of pontes.chamadas.filter(c => comLeitor.has(c.nome))) {
    assert.equal(typeof chamada.argumentos[0], "function", chamada.nome);
    chamada.argumentos = [];
  }
  assert.deepEqual(pontes.chamadas, [
    ...ASSINCRONAS.map(nome => ({ tipo: "async", painel: "indicadores-home", nome, argumentos: [] })),
    ...SINCRONAS.map(nome => ({ tipo: "sync", painel: "indicadores-home", nome, argumentos: [info] })),
  ]);
});

test("as ações chamadas no mesmo turno devolvem na hora, sem promessa", () => {
  const acoes = criarDashboard(criarPontes());
  for (const nome of SINCRONAS) assert.equal(typeof acoes[nome]().then, "undefined", nome);
});

test("sem o painel React os carregadores devolvem promessa resolvida e só o console registra a falha", async () => {
  const falha = new Error('O painel React "indicadores-home" não carregou.');
  const acoes = criarDashboard({
    ponteReact: (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async () => { throw falha; }])),
    ponteReactSincrona: (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => undefined])),
  });
  const original = console.error;
  const registrados = [];
  console.error = erro => registrados.push(erro);
  try {
    for (const nome of ASSINCRONAS) assert.equal(await acoes[nome](), undefined, nome);
    for (const nome of SINCRONAS) assert.equal(acoes[nome]({}), undefined, nome);
  } finally {
    console.error = original;
  }
  assert.deepEqual(registrados, ASSINCRONAS.map(nome => `${nome}: ${falha.message}`));
});

test("um painel-atualizado disparado antes do React montar chega ao painel pelo leitor do último detalhe", async () => {
  const anterior = globalThis.document;
  globalThis.document = new EventTarget();
  try {
    const pontes = criarPontes();
    const acoes = criarDashboard(pontes);
    const detalhe = { base_desatualizada: { desatualizada: true } };
    globalThis.document.dispatchEvent(new CustomEvent("simpress:painel-atualizado", { detail: detalhe }));
    await acoes.inicializarAlertaBaseDesatualizada();
    await acoes.inicializarAlertasOsDivergencias();
    const leitores = pontes.chamadas.map(chamada => chamada.argumentos[0]);
    assert.equal(leitores.length, 2);
    for (const ler of leitores) assert.equal(ler(), detalhe);
  } finally {
    globalThis.document = anterior;
  }
});
