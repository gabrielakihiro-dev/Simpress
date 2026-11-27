// Loja da sub-aba Planilhas (planilhas-loja.ts) escrita por loadSheets (estado.ts): carga, pedido superado, painel fechado,
// erro e seleção mantida. apiFetch adiado e DOM falso; só dados sintéticos.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const historyFormat = require("../../frontend/src/comum/history-format.ts");
const { criarFerramentasCockpit } = require("../../frontend/src/paineis/ferramentas-cockpit/estado.ts");
const { criarLojaPlanilhas } = require("../../frontend/src/paineis/ferramentas-cockpit/planilhas-loja.ts");

const EVENTO = {
  id: "evt-1", tipo: "importacao", horario: "2026-11-20T12:00:00-03:00",
  arquivos_enviados: { endpoint: "endpoint_sintetico.xlsx", detalhes: "detalhes_sintetico.xlsx" },
  comparacao: { total_detalhes: 12, total_endpoint: 10 },
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function montar() {
  const doc = createFakeDocument();
  const antigo = global.document;
  doc.getElementById = id => {
    let no = doc.root.querySelectorAll(`[id="${id}"]`)[0];
    if (!no) { no = doc.createElement("div"); no.setAttribute("id", id); doc.body.append(no); }
    return no;
  };
  doc.activeElement = null;
  global.document = doc;
  const pedidos = [];
  const apiFetch = url => new Promise((resolve, reject) => pedidos.push({ url, resolve, reject }));
  const lojaPlanilhas = criarLojaPlanilhas();
  const api = criarFerramentasCockpit({ app: {}, appState: {}, apiFetch, historyFormat, lojaPlanilhas });
  return { api, pedidos, loja: lojaPlanilhas, restaurar() { global.document = antigo; } };
}

// Responde a lista e, em seguida, o detalhe do primeiro evento.
async function responderCarga(pedidos, indiceLista) {
  pedidos.splice(indiceLista, 1)[0].resolve({ eventos: [EVENTO] });
  await tick();
  const detalhe = pedidos.find(p => p.url.includes("/evt-1"));
  detalhe.resolve({ evento: EVENTO });
  pedidos.splice(pedidos.indexOf(detalhe), 1);
  await tick();
}

test("carga ok: status, 4 KPIs, 2 linhas, 'endpoint' selecionada e sem mensagem da lista", async () => {
  const { api, pedidos, loja, restaurar } = montar();
  try {
    const aberto = api.abrirPainelCockpit("planilhas");
    await tick();
    assert.equal(loja.ler().status, "Carregando…");
    await responderCarga(pedidos, 0);
    await aberto;
    const estado = loja.ler();
    assert.match(estado.status, /^Última atualização em .+/);
    assert.equal(estado.kpis.length, 4);
    assert.deepEqual(estado.kpis.map(k => k[0]), ["Última atualização", "Equipamentos na Simpress", "Equipamentos no Endpoint", "Atualizações no histórico"]);
    assert.deepEqual(estado.kpis.slice(1).map(k => k[1]), ["12", "10", "1"]);
    assert.deepEqual(estado.linhas.map(l => l.key), ["endpoint", "detalhes"]);
    assert.equal(estado.selecionada, "endpoint");
    assert.equal(estado.mensagemLista, null);
  } finally { restaurar(); }
});

test("pedido superado: resolver a 1ª carga depois de disparar a 2ª não muda a loja", async () => {
  const { api, pedidos, loja, restaurar } = montar();
  try {
    const primeira = api.abrirPainelCockpit("planilhas");
    await tick();
    const segunda = api.abrirPainelCockpit("planilhas");
    await tick();
    assert.equal(pedidos.length, 2);
    const antes = loja.ler();
    pedidos[0].resolve({ eventos: [EVENTO] });
    await primeira;
    assert.equal(loja.ler(), antes, "a loja não foi tocada pelo pedido velho");
    assert.equal(loja.ler().status, "Carregando…");
    assert.equal(loja.ler().linhas, null);
    await responderCarga(pedidos, 1);
    await segunda;
    assert.equal(loja.ler().linhas.length, 2);
  } finally { restaurar(); }
});

test("sair do painel antes de resolver deixa a loja em 'Carregando…'", async () => {
  const { api, pedidos, loja, restaurar } = montar();
  try {
    const aberto = api.abrirPainelCockpit("planilhas");
    await tick();
    api.fecharPainelCockpit(); // fecha o painel: activeTool deixa de ser "planilhas"
    pedidos[0].resolve({ eventos: [EVENTO] });
    await aberto;
    assert.equal(loja.ler().status, "Carregando…");
    assert.equal(loja.ler().linhas, null);
    assert.equal(loja.ler().mensagemLista, "Carregando…");
  } finally { restaurar(); }
});

test("erro: status e mensagemLista com a mensagem, linhas antigas preservadas", async () => {
  const { api, pedidos, loja, restaurar } = montar();
  try {
    const aberto = api.abrirPainelCockpit("planilhas");
    await tick();
    await responderCarga(pedidos, 0);
    await aberto;
    const antigas = loja.ler().linhas;
    assert.equal(antigas.length, 2);
    const recarga = api.abrirPainelCockpit("planilhas");
    await tick();
    pedidos[0].reject(new Error("Falha sintética do servidor."));
    await recarga;
    const estado = loja.ler();
    assert.equal(estado.status, "Falha sintética do servidor.");
    assert.equal(estado.mensagemLista, "Falha sintética do servidor.");
    assert.equal(estado.linhas, antigas);
  } finally { restaurar(); }
});

test("seleção mantida entre recargas quando a chave ainda existe", async () => {
  const { api, pedidos, loja, restaurar } = montar();
  try {
    const aberto = api.abrirPainelCockpit("planilhas");
    await tick();
    await responderCarga(pedidos, 0);
    await aberto;
    loja.atualizar({ selecionada: "detalhes" });
    const recarga = api.abrirPainelCockpit("planilhas");
    await tick();
    await responderCarga(pedidos, 0);
    await recarga;
    assert.equal(loja.ler().selecionada, "detalhes");
    assert.equal(loja.ler().mensagemLista, null);
  } finally { restaurar(); }
});
