// Estado do resultado da Comparação (frontend/src/paineis/resultado-comparacao/estado.ts): PUT do autosave de anotações
// pelo apiFetch (sucesso, 409 sem repetição, 5xx com repetição, falha de rede) e leitura dos notebooks sem usuário.
const assert = require("node:assert/strict");
const test = require("node:test");

const { criarResultadoComparacao } = require("../../frontend/src/paineis/resultado-comparacao/estado.ts");
const { requestWithRetries } = require("../../static/js/shared/history-annotation-autosave.js");

const erroApi = (status, data = {}) => Object.assign(new Error(`HTTP ${status}`), { status, data });
const respostaOk = corpo => ({ ok: true, status: 200, json: async () => corpo });

function criar({ apiFetch, attach = () => {} }) {
  return criarResultadoComparacao({
    app: {}, appState: {}, motion: null,
    dom: { escapeHtml: valor => String(valor) },
    comparisonResultRenderer: () => ({ RESUMO_ABAS: [] }),
    historyFormat: { formatarNomeFonteHistorico: valor => valor, formatarHorarioHistorico: valor => valor },
    loggedUserMarkers: { conectar() {} },
    annotationAutosave: { attachAnnotationAutosave: attach },
    apiFetch,
  });
}

function criarCampo({ itemId, eventId } = {}) {
  const status = {};
  const repetir = {};
  const pai = { querySelector: seletor => ({ "[data-annotation-status]": status, "[data-annotation-retry]": repetir })[seletor] || null };
  return { dataset: { annotationId: itemId, eventId }, parentElement: pai, status, repetir };
}

function conectar(apiFetch, campos, eventoPadrao) {
  const conectados = [];
  criar({ apiFetch, attach: opcoes => conectados.push(opcoes) })
    .conectarAnotacoesOperacionais({ querySelectorAll: () => campos }, eventoPadrao);
  return conectados;
}

const PEDIDO = { eventId: "ev 1/x", itemId: "item#1", annotation: "texto sintético", revisionId: "r1", baseRevisions: ["b0"], resolveConflict: false };

// Mesma passagem do autosave real (requestWithRetries), sem esperar os atrasos de 500/1000/2000 ms.
async function salvar(apiFetch) {
  const [opcoes] = conectar(apiFetch, [criarCampo({ itemId: "item#1" })], "ev 1/x");
  return requestWithRetries(() => opcoes.send(PEDIDO), { sleep: async () => {} });
}

test("o autosave conecta cada campo com o evento e o item certos, e o evento do campo vence o padrão", () => {
  const conectados = conectar(async () => respostaOk({}), [
    criarCampo({ itemId: "a" }), criarCampo({ itemId: "b", eventId: "ev-proprio" }),
  ], "ev-padrao");
  assert.deepEqual(conectados.map(opcoes => [opcoes.eventId, opcoes.itemId]), [["ev-padrao", "a"], ["ev-proprio", "b"]]);
  assert.ok(conectados.every(opcoes => typeof opcoes.send === "function" && opcoes.status && opcoes.retryButton));
});

test("o PUT da anotação vai pelo apiFetch com URL codificada, corpo e responseType response", async () => {
  const chamadas = [];
  const resultado = await salvar(async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return respostaOk({ sucesso: true });
  });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, "/api/historico-comparacoes/ev%201%2Fx/anotacoes/item%231");
  assert.equal(chamadas[0].opcoes.method, "PUT");
  assert.deepEqual(chamadas[0].opcoes.headers, { "Content-Type": "application/json" });
  assert.equal(chamadas[0].opcoes.responseType, "response");
  assert.deepEqual(JSON.parse(chamadas[0].opcoes.body), {
    anotacao: "texto sintético", revisao_id: "r1", base_revisoes: ["b0"], resolver_conflito: false,
  });
  assert.equal(resultado.stale, false);
  assert.equal(resultado.response.ok, true);
  assert.deepEqual(await resultado.response.json(), { sucesso: true });
});

test("409 (conflito) não repete e mantém status e mensagem do servidor", async () => {
  let chamadas = 0;
  await assert.rejects(
    salvar(async () => { chamadas += 1; throw erroApi(409, { detail: "Conflito de anotação preservado." }); }),
    erro => erro.status === 409 && erro.message === "Conflito de anotação preservado.",
  );
  assert.equal(chamadas, 1);
});

test("4xx sem detalhe usa a mensagem padrão e também não repete", async () => {
  let chamadas = 0;
  await assert.rejects(
    salvar(async () => { chamadas += 1; throw erroApi(400); }),
    erro => erro.status === 400 && erro.message === "Não foi possível salvar a anotação.",
  );
  assert.equal(chamadas, 1);
});

test("500 repete e o salvamento conclui quando a tentativa seguinte passa", async () => {
  let chamadas = 0;
  const resultado = await salvar(async () => {
    chamadas += 1;
    if (chamadas < 3) throw erroApi(500, { detail: "Erro interno." });
    return respostaOk({ sucesso: true });
  });
  assert.equal(chamadas, 3);
  assert.equal(resultado.response.ok, true);
});

test("500 em todas as tentativas esgota as três repetições e devolve o erro do servidor", async () => {
  let chamadas = 0;
  await assert.rejects(
    salvar(async () => { chamadas += 1; throw erroApi(500, { detail: "Erro interno." }); }),
    erro => erro.status === 500 && erro.message === "Erro interno.",
  );
  assert.equal(chamadas, 4);
});

test("falha de rede passa intacta, sem status (o autosave mostra a mensagem de conexão), e é repetida três vezes", async () => {
  let chamadas = 0;
  const falha = new TypeError("Failed to fetch");
  await assert.rejects(
    salvar(async () => { chamadas += 1; throw falha; }),
    erro => erro === falha && erro.status === undefined,
  );
  assert.equal(chamadas, 4);
});

test("carregarSemUsuarioResumo lê pelo apiFetch com a mensagem de erro e devolve estado ok", async () => {
  const chamadas = [];
  const acoes = criar({ apiFetch: async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return { items: [{ serial: "SN-1" }], total: 1, has_more: false };
  } });
  assert.deepEqual(await acoes.carregarSemUsuarioResumo(), { estado: "ok", items: [{ serial: "SN-1" }] });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, "/api/buscar-expandida?listar_todos=true&usuario=sem&limit=100&offset=0");
  assert.equal(chamadas[0].opcoes.errorMessage, "Não foi possível consultar os notebooks sem usuário.");
  await acoes.carregarSemUsuarioResumo();
  assert.equal(chamadas.length, 1, "leitura bem-sucedida fica em cache");
});

test("carregarSemUsuarioResumo nunca lança: falha vira estado erro e não fica em cache", async () => {
  let chamadas = 0;
  const acoes = criar({ apiFetch: async () => {
    chamadas += 1;
    if (chamadas === 1) throw erroApi(500);
    return { items: [], has_more: false };
  } });
  assert.deepEqual(await acoes.carregarSemUsuarioResumo(), { estado: "erro", items: [] });
  assert.deepEqual(await acoes.carregarSemUsuarioResumo(), { estado: "ok", items: [] });
  assert.equal(chamadas, 2);
});

test("leitura antiga de sem usuário não sobrescreve o cache depois de invalidar", async () => {
  const pendentes = [];
  const acoes = criar({ apiFetch: () => new Promise(resolver => pendentes.push(resolver)) });
  const antiga = acoes.carregarSemUsuarioResumo();
  acoes.invalidarSemUsuarioResumo();
  pendentes[0]({ items: [{ serial: "ANTIGO" }], has_more: false });
  assert.deepEqual(await antiga, { estado: "ok", items: [{ serial: "ANTIGO" }] });

  const nova = acoes.carregarSemUsuarioResumo();
  assert.equal(pendentes.length, 2, "a leitura antiga não ficou em cache");
  pendentes[1]({ items: [{ serial: "NOVO" }], has_more: false });
  assert.deepEqual(await nova, { estado: "ok", items: [{ serial: "NOVO" }] });
});
