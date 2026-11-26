// Relatório mensal (F8), sub-aba Tendências: frontend/src/paineis/relatorio-mensal/tendencias.ts (o Node carrega .ts direto).
// Render sobre o DOM falso de tests/frontend/support/fake-dom.cjs; dados sintéticos.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");

const t = require(path.resolve(__dirname, "../../frontend/src/paineis/relatorio-mensal/tendencias.ts"));

const cartao = (no, tom) => { no.dataset.tom = tom; return no; };
const base = (extra = {}) => ({
  dias: 30, inicio: "2026-10-28", data_corte: "2026-11-25",
  tempo_medio_os: { media_dias: 12.4, encerradas: 38, encerradas_sem_data: 2, media_dias_anterior: 14.1, encerradas_anterior: 30 },
  sem_acesso_7_dias: {
    pontos: [47, 44, 41].map((total, i) => ({ horario: `2026-11-${23 + i}T09:00:00`, data: `2026-11-${23 + i}`, total })),
    historico_desde: "2026-10-20",
  },
  ...extra,
});
const render = dados => {
  global.document = createFakeDocument();
  global.document.body = global.document.createElement("body");
  try { return t.montarCorpoTendencias(dados, cartao); } finally { /* o DOM falso fica para as leituras */ }
};
const texto = no => no.textContent;
const achar = (no, id) => no.querySelectorAll(`[id="${id}"]`)[0];
const limpar = () => { delete global.document; };

test("formatação: vírgula decimal, unidade dia/dias e datas", () => {
  assert.equal(t.formatarDias(12.35), "12,4");
  assert.equal(t.formatarDias(2), "2,0");
  assert.equal(t.unidadeDias(1.7), "dia");
  assert.equal(t.unidadeDias(2), "dias");
  assert.equal(t.unidadeDias(12.4), "dias");
  assert.equal(t.dataCurta("2026-11-25"), "25/11");
  assert.equal(t.dataLonga("2026-11-25"), "25/11/2026");
});

test("cartões: valores, variação com sinal (queda em verde), nota de sem data e sem selo quando o histórico cobre o período", () => {
  try {
    const raiz = render(base());
    const tempo = achar(raiz, "rel-tend-tempo");
    assert.equal(tempo.dataset.tom, "ciano");
    assert.match(texto(tempo), /^Tempo médio das OS.*12,4 dias/);
    assert.match(texto(tempo), /38OS encerradas/);
    assert.match(texto(tempo), /14,1 dias30 dias anteriores/);
    assert.match(texto(tempo), /−1,7 diaVariação/);
    assert.match(texto(tempo), /Encerradas sem data de conclusão ficam de fora: 2/);
    assert.equal(tempo.querySelectorAll(".nf8-tend__bom").length, 1);
    const acesso = achar(raiz, "rel-tend-acesso");
    assert.equal(acesso.dataset.tom, "fucsia");
    assert.match(texto(acesso), /41 na última atualização/);
    assert.match(texto(acesso), /47Primeira \(23\/11\)/);
    assert.match(texto(acesso), /−6Variação no período/);
    const grafico = acesso.querySelectorAll("svg")[0];
    assert.equal(grafico.getAttribute("role"), "img");
    assert.equal(grafico.getAttribute("aria-label"), "Sem acesso há 7 dias ou mais: de 47 em 23/11 para 41 em 25/11, 3 atualizações");
    assert.equal(grafico.querySelectorAll("circle").length, 3);
    assert.equal(grafico.querySelectorAll("line").length, 3);
    assert.doesNotMatch(texto(acesso), /Histórico desde/);
  } finally { limpar(); }
});

test("alta de tempo médio leva + sem cor de sucesso; sem média anterior mostra — e a nota, sem variação", () => {
  try {
    const alta = render(base({ tempo_medio_os: { media_dias: 16, encerradas: 5, encerradas_sem_data: 0, media_dias_anterior: 14, encerradas_anterior: 4 } }));
    const tempo = achar(alta, "rel-tend-tempo");
    assert.match(texto(tempo), /\+2,0 diasVariação/);
    assert.equal(tempo.querySelectorAll(".nf8-tend__bom").length, 0);
    assert.doesNotMatch(texto(tempo), /ficam de fora/);
    const sem = achar(render(base({ dias: 90, tempo_medio_os: { media_dias: 13.2, encerradas: 104, encerradas_sem_data: 0, media_dias_anterior: null, encerradas_anterior: 0 } })), "rel-tend-tempo");
    assert.match(texto(sem), /—90 dias anteriores/);
    assert.match(texto(sem), /Sem OS encerradas nos 90 dias anteriores para comparar\./);
    assert.doesNotMatch(texto(sem), /Variação/);
  } finally { limpar(); }
});

test("sem dados por cartão, com motivo e role=status; selo Histórico desde quando começa depois do início", () => {
  try {
    const vazio = render(base({
      tempo_medio_os: { media_dias: null, encerradas: 0, encerradas_sem_data: 0, media_dias_anterior: null, encerradas_anterior: 0 },
      sem_acesso_7_dias: { pontos: [{ horario: "2026-11-25T09:00:00", data: "2026-11-25", total: 3 }], historico_desde: "2026-11-25" },
    }));
    const tempo = achar(vazio, "rel-tend-tempo"), acesso = achar(vazio, "rel-tend-acesso");
    assert.match(texto(tempo), /Sem dados suficientes nos últimos 30 dias\.Nenhuma OS Oracle encerrada com data no período\./);
    assert.match(texto(acesso), /Sem dados suficientes nos últimos 30 dias\.Menos de 2 atualizações de inventário no período\./);
    assert.equal(tempo.querySelectorAll('[role="status"]').length, 1);
    assert.equal(acesso.querySelectorAll('[role="status"]').length, 1);
    const parcial = achar(render(base({ sem_acesso_7_dias: { ...base().sem_acesso_7_dias, historico_desde: "2026-11-23" } })), "rel-tend-acesso");
    assert.match(texto(parcial), /Histórico desde 23\/11\/2026/);
  } finally { limpar(); }
});

test("cabeçalho: segmentado Período com aria-pressed, aviso de carregando/erro e nada de série ou hostname", () => {
  try {
    global.document = createFakeDocument();
    const dias = [];
    const cab = t.montarCabecalhoTendencias(30, d => dias.push(d));
    assert.match(texto(cab), /^TendênciasAté hoje · não muda com o mêsPeríodo30 dias90 dias$/);
    const grupo = cab.querySelectorAll('[role="group"]')[0];
    assert.equal(grupo.getAttribute("aria-label"), "Período");
    const botoes = grupo.querySelectorAll("button");
    assert.deepEqual(botoes.map(b => b.getAttribute("aria-pressed")), ["true", "false"]);
    botoes[1].click();
    botoes[1].click();
    assert.deepEqual(dias, [90]);
    assert.deepEqual(botoes.map(b => b.getAttribute("aria-pressed")), ["false", "true"]);
    assert.equal(t.avisoTendencias("Carregando tendências…", "status").getAttribute("role"), "status");
    assert.equal(t.avisoTendencias("Falha ao carregar as tendências.", "alert").getAttribute("role"), "alert");
    const tudo = texto(cab) + texto(t.montarCorpoTendencias(base(), cartao));
    assert.doesNotMatch(tudo, /serie|série|hostname|PRNOTE/i);
  } finally { limpar(); }
});
