const assert = require("node:assert/strict");
const test = require("node:test");
const createChromeAutomation = require("../../static/js/features/chrome-automation.js");

function elemento(id) {
  const filhos = [];
  return {
    id, hidden: false, textContent: "", disabled: false, dataset: {}, filhos,
    setAttribute() {}, removeAttribute() {},
    replaceChildren(...novos) { filhos.splice(0, filhos.length, ...novos); },
    append(...novos) { filhos.push(...novos); },
    appendChild(no) { filhos.push(no); return no; },
    querySelector: () => null, querySelectorAll: () => [],
  };
}

function criar(respostas) {
  const toasts = [];
  const chamadas = [];
  const elementos = new Map();
  const obter = id => { if (!elementos.has(id)) elementos.set(id, elemento(id)); return elementos.get(id); };
  global.document = {
    getElementById: obter, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => elemento(""), visibilityState: "visible",
  };
  global.window = { clearTimeout() {}, setTimeout: () => 0 };
  global.Node = class Node {};
  const app = {
    apiFetch: async (url, opcoes = {}) => {
      chamadas.push([opcoes.method || "GET", url, opcoes.body]);
      const resposta = respostas[`${opcoes.method || "GET"} ${url}`];
      if (resposta instanceof Error) throw resposta;
      return resposta;
    },
    showToast: (mensagem, tipo) => toasts.push([mensagem, tipo]),
  };
  const dom = { createTextElement: (_tag, _classe, texto) => ({ ...elemento(""), textContent: texto }) };
  return { feature: createChromeAutomation({ app, dom }), toasts, chamadas, obter };
}

const limpar = t => t.after(() => { delete global.document; delete global.window; delete global.Node; });

function resumo(extra = {}) {
  return {
    agendamento: { ativo: false, pronta: false, proxima_execucao: null, ultimo_disparo: null },
    ultima_execucao: { inicio: "2026-10-20T16:45:00-03:00", fim: "2026-10-20T16:49:00-03:00", situacao: "concluido", incluidos: 0, ignorados: 5, pendentes: 0 },
    pendencias: [],
    login_necessario: false,
    ...extra,
  };
}

test("a primeira consulta e um resumo igual ao anterior não geram aviso", t => {
  limpar(t);
  const { feature } = criar({});
  assert.deepEqual(feature.avisosSincronizacaoSebrae(null, resumo()), []);
  assert.deepEqual(feature.avisosSincronizacaoSebrae(resumo(), resumo()), []);
  // Uma execução nova sem nada de novo (só duplicados) também fica em silêncio.
  const nova = resumo({ ultima_execucao: { ...resumo().ultima_execucao, fim: "2026-10-20T17:19:00-03:00", ignorados: 7 } });
  assert.deepEqual(feature.avisosSincronizacaoSebrae(resumo(), nova), []);
});

test("avisa chamados incluídos por uma execução nova", t => {
  limpar(t);
  const { feature } = criar({});
  const nova = resumo({ ultima_execucao: { ...resumo().ultima_execucao, fim: "2026-10-20T17:19:00-03:00", incluidos: 2 } });
  assert.deepEqual(feature.avisosSincronizacaoSebrae(resumo(), nova),
    [{ tipo: "success", mensagem: "Sebrae: 2 chamados incluídos no Dashboard." }]);
  // A mesma execução consultada de novo não repete o aviso.
  assert.deepEqual(feature.avisosSincronizacaoSebrae(nova, nova), []);
});

test("avisa pendência nova ou alterada, mas não a mesma nem a que sumiu", t => {
  limpar(t);
  const { feature } = criar({});
  const uma = resumo({ pendencias: [{ numero: "UTIC-2026-1253", motivo: "a" }] });
  const duas = resumo({ pendencias: [{ numero: "UTIC-2026-1253", motivo: "a" }, { numero: "UTIC-2026-0412", motivo: "sem_indicios_de_tipo" }] });
  assert.deepEqual(feature.avisosSincronizacaoSebrae(resumo(), uma), [{ tipo: "warning", mensagem: "Sebrae: 1 pendência para conferir." }]);
  assert.deepEqual(feature.avisosSincronizacaoSebrae(uma, duas), [{ tipo: "warning", mensagem: "Sebrae: 2 pendências para conferir." }]);
  assert.deepEqual(feature.avisosSincronizacaoSebrae(duas, { ...duas, pendencias: [...duas.pendencias].reverse() }), []);
  assert.deepEqual(feature.avisosSincronizacaoSebrae(duas, resumo()), []);
});

test("avisa login necessário uma vez e falha diferente da anterior", t => {
  limpar(t);
  const { feature } = criar({});
  const login = resumo({ login_necessario: true });
  assert.equal(feature.avisosSincronizacaoSebrae(resumo(), login)[0].mensagem, "Sebrae: login necessário no Chrome de automação.");
  assert.deepEqual(feature.avisosSincronizacaoSebrae(login, login), []);
  const falha = resumo({ ultima_execucao: { ...resumo().ultima_execucao, fim: "2026-10-20T17:19:00-03:00", situacao: "falha", detalhes: "Sessão expirada" } });
  assert.deepEqual(feature.avisosSincronizacaoSebrae(resumo(), falha).map(a => a.tipo), ["error"]);
  const mesmaFalha = { ...falha, ultima_execucao: { ...falha.ultima_execucao, fim: "2026-10-20T17:49:00-03:00" } };
  assert.deepEqual(feature.avisosSincronizacaoSebrae(falha, mesmaFalha), []);
  const outraFalha = { ...falha, ultima_execucao: { ...mesmaFalha.ultima_execucao, detalhes: "Excel indisponível" } };
  assert.deepEqual(feature.avisosSincronizacaoSebrae(falha, outraFalha).map(a => a.tipo), ["error"]);
});

test("ativar o agendamento antes da rotina estar pronta mostra o 409 como aviso", async t => {
  limpar(t);
  const erro = new Error("A sincronização ainda não está completa.");
  erro.status = 409;
  const { feature, toasts, chamadas } = criar({
    "GET /api/automacao/sebrae/resumo": resumo(),
    "PUT /api/automacao/sebrae/agendamento": erro,
  });
  await feature.carregarResumoSebrae();
  await feature.alternarAgendamentoSebrae();
  assert.deepEqual(toasts, [["A sincronização ainda não está completa.", "warning"]]);
  assert.deepEqual(chamadas.find(([metodo]) => metodo === "PUT").slice(0, 3), ["PUT", "/api/automacao/sebrae/agendamento", JSON.stringify({ ativo: true })]);
});

test("ativa e pausa o agendamento e atualiza o cartão", async t => {
  limpar(t);
  const ativo = resumo({ agendamento: { ativo: true, pronta: true, proxima_execucao: "2026-10-21T10:15:00-03:00", ultimo_disparo: null } });
  const { feature, toasts, obter } = criar({
    "GET /api/automacao/sebrae/resumo": resumo({ agendamento: { ativo: false, pronta: true, proxima_execucao: null, ultimo_disparo: null } }),
    "PUT /api/automacao/sebrae/agendamento": ativo,
  });
  await feature.carregarResumoSebrae();
  assert.equal(obter("sebrae-estado-titulo").textContent, "Agendamento pausado");
  await feature.alternarAgendamentoSebrae();
  assert.equal(obter("sebrae-estado-titulo").textContent, "Agendamento ativo");
  assert.equal(obter("sebrae-estado").dataset.state, "livre");
  assert.equal(obter("sebrae-agendamento").textContent, "Ativo");
  assert.deepEqual(toasts, [["Agendamento ativado: de segunda a sexta, a cada 30 minutos.", "success"]]);
});

test("o cartão mostra contadores, pendências e o aviso de login", async t => {
  limpar(t);
  const { feature, toasts, obter } = criar({
    "GET /api/automacao/sebrae/resumo": resumo({
      ultima_execucao: { inicio: "2026-10-20T16:45:00-03:00", fim: "2026-10-20T16:49:00-03:00", situacao: "concluido", incluidos: 2, ignorados: 31, pendentes: 1 },
      pendencias: [{ numero: "UTIC-2026-0412", motivo: "sem_indicios_de_tipo" }],
      login_necessario: true,
    }),
  });
  await feature.carregarResumoSebrae();
  assert.equal(obter("sebrae-incluidos").textContent, "2");
  assert.equal(obter("sebrae-ignorados").textContent, "31");
  assert.equal(obter("sebrae-pendentes").textContent, "1");
  assert.equal(obter("sebrae-login-aviso").hidden, false);
  assert.equal(obter("sebrae-agendamento-aviso").hidden, false);
  const tabela = obter("sebrae-pendencias").filhos[0];
  assert.ok(tabela, "a tabela de pendências foi desenhada");
  // A primeira consulta só define a referência: nenhum aviso.
  assert.deepEqual(toasts, []);
});
