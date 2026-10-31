const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const createTicketRules = require("../../static/js/features/ticket-rules.js");
const createCockpitChamados = require("../../static/js/features/cockpit-chamados.js");

const dom = { escapeHtml: value => String(value), pluralize: (count, one, many) => (count === 1 ? one : many), createTextElement: null };

function diasAtras(dias) {
  const data = new Date();
  data.setDate(data.getDate() - dias);
  return data.toISOString();
}

test("grupoTriagemChamado separa ativos em 3+ dias, sem data e atualizados, e ignora encerrados", () => {
  const rules = createTicketRules(dom);
  const aberto = ultima => ({ oracle: [{ status: "Em execução", ultima_atualizacao: ultima }] });
  assert.equal(rules.grupoTriagemChamado(aberto(diasAtras(1))), "em_dia");
  assert.equal(rules.grupoTriagemChamado(aberto(diasAtras(5))), "atrasados");
  assert.equal(rules.grupoTriagemChamado(aberto("")), "sem_data");
  assert.equal(rules.grupoTriagemChamado({ oracle: [{ status: "Concluído", ultima_atualizacao: diasAtras(9) }] }), "");
  assert.equal(rules.grupoTriagemChamado({ oracle: [] }), "", "sem chamado no Oracle não entra na triagem");
  const atrasado = aberto(diasAtras(5));
  assert.equal(rules.correspondeTriagemChamado(atrasado, "ativos"), true);
  assert.equal(rules.correspondeTriagemChamado(atrasado, "atrasados"), true);
  assert.equal(rules.correspondeTriagemChamado(atrasado, "em_dia"), false);
  assert.equal(rules.correspondeTriagemChamado({ oracle: [] }, ""), true);
});

function criarAmbiente({ respostas = {}, confirmar = true } = {}) {
  const doc = createFakeDocument();
  global.document = doc;
  global.window = { matchMedia: () => ({ matches: true }), URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} }, setTimeout: () => 0 };
  const el = {};
  for (const [id, tag] of [
    ["cockpit-tickets-version", "select"], ["cockpit-tickets-delete-old", "button"], ["cockpit-tickets-export", "button"],
    ["cockpit-tickets-manage-version", "span"], ["cockpit-tickets-sources", "p"], ["cockpit-tickets-evolution", "div"],
    ["cockpit-tickets-form", "form"], ["cockpit-tickets-import", "button"], ["cockpit-tickets-import-status", "p"],
    ["cockpit-tickets-file-simpress", "input"], ["cockpit-tickets-file-oracle", "input"], ["cockpit-tickets-manage-panel", "details"],
    ["cockpit-tickets-search", "input"], ["cockpit-tickets-attention", "input"],
  ]) {
    el[id] = doc.createElement(tag);
    el[id].setAttribute("id", id);
    doc.body.append(el[id]);
  }
  el["cockpit-tickets-delete-old"].textContent = "Excluir importações antigas";
  el["cockpit-tickets-export"].textContent = "Exportar Excel";
  el["cockpit-tickets-search"].value = "";
  el["cockpit-tickets-attention"].checked = false;
  const chamadas = [];
  const toasts = [];
  const eventos = [];
  doc.defaultView = { CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } };
  doc.dispatchEvent = evento => { eventos.push(evento); return true; };
  const app = {
    apiFetch: async (url, options = {}) => {
      chamadas.push([options.method || "GET", url]);
      const chave = Object.keys(respostas).find(prefixo => url.startsWith(prefixo));
      return chave ? respostas[chave] : {};
    },
    showToast: (mensagem, tipo) => toasts.push([mensagem, tipo]),
    confirmarAcao: async () => confirmar,
    carregarProntidao: async () => {},
  };
  const gate = { createRequestGate: () => { let atual = 0; return { begin: () => ({ id: ++atual }), isCurrent: id => id === atual }; } };
  const context = {
    app, transferUtils: gate, ticketRules: createTicketRules(dom),
    dom: { createTextElement: (tag, classe, texto) => { const no = doc.createElement(tag); no.className = classe || ""; no.textContent = texto; return no; } },
    historyFormat: { formatarHorarioHistorico: valor => `fmt(${valor})` },
  };
  const api = createCockpitChamados(context);
  Object.assign(app, api);
  return { api, app, el, chamadas, toasts, eventos };
}

const historico = [{ id: "s2", atualizado_em: "2026-10-30", fontes: { simpress: "a.xlsx", oracle: "b.xlsx" } }, { id: "s1", atualizado_em: "2026-10-29" }];

test("sincronizar monta versões, fontes e botões a partir do relatório da tabela", async () => {
  const { api, el } = criarAmbiente({ respostas: { "/api/operacoes/chamados/evolucao": { contagens: { novos: 1, alterados: 2, iguais: 3, ausentes_arquivo: 0 }, mudancas: { novos: ["SN-1"] } } } });
  try {
    api.sincronizarGestaoChamadosCockpit({ snapshot_id: "s2", atualizado_em: "2026-10-30", historico, fontes: { simpress: { arquivo: "a.xlsx" } } });
    const opcoes = el["cockpit-tickets-version"].children;
    assert.deepEqual(opcoes.map(opcao => opcao.value), ["", "s2", "s1"]);
    assert.equal(el["cockpit-tickets-version"].value, "s2");
    assert.equal(el["cockpit-tickets-manage-version"].textContent, "Atualizado fmt(2026-10-30)");
    assert.equal(el["cockpit-tickets-sources"].textContent, "Simpress: a.xlsx · Oracle: aguardando importação");
    assert.equal(el["cockpit-tickets-delete-old"].disabled, false, "com 2 versões dá para excluir as antigas");
    assert.equal(el["cockpit-tickets-export"].disabled, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(el["cockpit-tickets-evolution"].textContent, /1 novas · 2 alteradas · 3 sem mudança/);

    api.sincronizarGestaoChamadosCockpit({ snapshot_id: "s1", atualizado_em: "2026-10-29", historico: [historico[1]] });
    assert.equal(el["cockpit-tickets-delete-old"].disabled, true, "uma versão só: nada a excluir");
    api.sincronizarGestaoChamadosCockpit({ historico: [] });
    assert.equal(el["cockpit-tickets-manage-version"].textContent, "Nenhuma importação");
    assert.equal(el["cockpit-tickets-export"].disabled, true);
  } finally { delete global.document; delete global.window; }
});

test("exportar envia versão, busca e atenção; sem versão avisa e não chama a API", async () => {
  const { api, el, chamadas, toasts } = criarAmbiente();
  try {
    await api.exportarChamadosCockpit();
    assert.deepEqual(toasts.at(-1), ["Selecione e aguarde o carregamento de uma versão válida antes de exportar.", "error"]);
    assert.equal(chamadas.length, 0);
    api.sincronizarGestaoChamadosCockpit({ snapshot_id: "s2", historico });
    el["cockpit-tickets-search"].value = " SN-9 ";
    el["cockpit-tickets-attention"].checked = true;
    await api.exportarChamadosCockpit().catch(() => {});
    const url = chamadas.map(([, endereco]) => endereco).find(endereco => endereco.includes("/exportar"));
    assert.match(url, /snapshot_id=s2/);
    assert.match(url, /search=SN-9/);
    assert.match(url, /attention_only=true/);
    assert.match(url, /stale_days=3/);
  } finally { delete global.document; delete global.window; }
});

test("excluir importações antigas confirma, chama DELETE e pede recarga da tabela", async () => {
  const { api, chamadas, toasts, eventos } = criarAmbiente({ respostas: { "/api/operacoes/chamados/historico/antigas": { removidas: 1 } } });
  try {
    api.sincronizarGestaoChamadosCockpit({ snapshot_id: "s2", historico });
    await api.excluirImportacoesAntigasChamadosCockpit();
    assert.deepEqual(chamadas.find(([metodo]) => metodo === "DELETE"), ["DELETE", "/api/operacoes/chamados/historico/antigas"]);
    assert.equal(toasts.at(-1)[0], "1 importação antiga removida. A importação mais recente foi mantida.");
    assert.equal(eventos.at(-1).type, "simpress:chamados-atualizados");
  } finally { delete global.document; delete global.window; }
});

test("excluir importações antigas não chama a API quando o usuário cancela", async () => {
  const { api, chamadas } = criarAmbiente({ confirmar: false });
  try {
    api.sincronizarGestaoChamadosCockpit({ snapshot_id: "s2", historico });
    await api.excluirImportacoesAntigasChamadosCockpit();
    assert.equal(chamadas.some(([metodo]) => metodo === "DELETE"), false);
  } finally { delete global.document; delete global.window; }
});

test("Importar e gerenciar abre o bloco e leva o foco ao primeiro arquivo", () => {
  const { api, el } = criarAmbiente();
  let foco = null;
  el["cockpit-tickets-file-simpress"].focus = opcoes => { foco = opcoes; };
  el["cockpit-tickets-manage-panel"].scrollIntoView = () => {};
  try {
    api.abrirGestaoChamadosCockpit();
    assert.equal(el["cockpit-tickets-manage-panel"].open, true);
    assert.deepEqual(foco, { preventScroll: true });
  } finally { delete global.document; delete global.window; }
});

function enviarFormulario(api, el) {
  api.sincronizarGestaoChamadosCockpit({ historico: [] });
  const evento = { type: "submit", prevented: false, preventDefault() { this.prevented = true; } };
  el["cockpit-tickets-form"].dispatchEvent(evento);
  return evento;
}

test("importar sem as duas planilhas avisa no formulário e não chama a API", async () => {
  const { api, el, chamadas, toasts } = criarAmbiente();
  try {
    el["cockpit-tickets-file-simpress"].files = [{ name: "pedidos.xlsx" }];
    el["cockpit-tickets-file-oracle"].files = [];
    const evento = enviarFormulario(api, el);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(evento.prevented, true);
    assert.equal(el["cockpit-tickets-import-status"].textContent, "Selecione as duas planilhas para importar.");
    assert.equal(chamadas.some(([metodo]) => metodo === "POST"), false);
    assert.equal(toasts.length, 0);
  } finally { delete global.document; delete global.window; }
});

test("importar envia as duas planilhas, fecha o bloco, atualiza a tabela, a prontidão e a Home", async () => {
  const relatorio = { snapshot_id: "novo", atualizado_em: "2026-10-31", historico: [{ id: "novo", atualizado_em: "2026-10-31" }], fontes: { simpress: { arquivo: "pedidos.xlsx" }, oracle: { arquivo: "solicitacoes.xlsx" } } };
  const { api, el, chamadas, toasts, eventos, app } = criarAmbiente({ respostas: { "/api/operacoes/chamados/importar": relatorio } });
  let prontidao = 0;
  app.carregarProntidao = async () => { prontidao += 1; };
  try {
    el["cockpit-tickets-file-simpress"].files = [{ name: "pedidos.xlsx" }];
    el["cockpit-tickets-file-oracle"].files = [{ name: "solicitacoes.xlsx" }];
    el["cockpit-tickets-manage-panel"].open = true;
    enviarFormulario(api, el);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(chamadas.find(([metodo]) => metodo === "POST"), ["POST", "/api/operacoes/chamados/importar"]);
    assert.equal(el["cockpit-tickets-version"].value, "novo");
    assert.equal(el["cockpit-tickets-sources"].textContent, "Simpress: pedidos.xlsx · Oracle: solicitacoes.xlsx");
    assert.equal(el["cockpit-tickets-import-status"].textContent, "Planilhas importadas. As OS foram relacionadas pela série.");
    assert.equal(el["cockpit-tickets-manage-panel"].open, false);
    assert.equal(el["cockpit-tickets-file-simpress"].value, "");
    assert.equal(eventos.at(-1).type, "simpress:chamados-atualizados");
    assert.equal(prontidao, 1);
    assert.deepEqual(toasts.at(-1), ["Acompanhamento de chamados atualizado.", "success"]);
    assert.equal(el["cockpit-tickets-import"].disabled, false);
    assert.equal(el["cockpit-tickets-form"].getAttribute("aria-busy"), null);
  } finally { delete global.document; delete global.window; }
});

test("importar mostra o erro da API no formulário e libera o botão", async () => {
  const { api, el, app } = criarAmbiente();
  app.apiFetch = async () => { throw new Error("Planilha inválida."); };
  try {
    el["cockpit-tickets-file-simpress"].files = [{ name: "a.xlsx" }];
    el["cockpit-tickets-file-oracle"].files = [{ name: "b.xlsx" }];
    enviarFormulario(api, el);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(el["cockpit-tickets-import-status"].textContent, "Planilha inválida.");
    assert.equal(el["cockpit-tickets-import"].disabled, false);
  } finally { delete global.document; delete global.window; }
});

test("evolução ignora o erro tardio de uma comparação antiga depois que outra deu certo", async () => {
  const { api, app, el } = criarAmbiente();
  try {
    const tres = [{ id: "s3", atualizado_em: "2026-10-31" }, ...historico];
    let falharAntiga;
    const sinais = [];
    app.apiFetch = (url, options = {}) => {
      sinais.push(options.signal);
      if (url.includes("atual=s3")) return new Promise((_, rejeitar) => { falharAntiga = rejeitar; });
      return Promise.resolve({ contagens: { novos: 4, alterados: 0, iguais: 0, ausentes_arquivo: 0 }, mudancas: {} });
    };
    api.sincronizarGestaoChamadosCockpit({ snapshot_id: "s3", atualizado_em: "2026-10-31", historico: tres });
    el["cockpit-tickets-version"].value = "s2";
    api.selecionarVersaoChamadosCockpit();
    await new Promise(resolve => setImmediate(resolve));
    falharAntiga(new Error("falha antiga"));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(el["cockpit-tickets-evolution"].textContent, /4 novas/);
    assert.doesNotMatch(el["cockpit-tickets-evolution"].textContent, /falha antiga/);
  } finally { delete global.document; delete global.window; }
});

test("Home ignora a resposta tardia de uma série trocada e mostra só os chamados abertos da atual", async () => {
  const doc = createFakeDocument();
  global.document = doc;
  try {
    const corpo = doc.createElement("div"); corpo.setAttribute("id", "home-open-tickets-body");
    const contagem = doc.createElement("span"); contagem.setAttribute("id", "home-open-tickets-count");
    doc.body.append(corpo, contagem);
    const pendentes = [];
    const app = { apiFetch: () => new Promise(resolve => pendentes.push(resolve)) };
    const api = createCockpitChamados({
      app, transferUtils: { createRequestGate: () => { let atual = 0; return { begin: () => ({ id: ++atual }), isCurrent: id => id === atual }; } },
      ticketRules: createTicketRules(dom),
      dom: { createTextElement: (tag, classe, texto) => { const no = doc.createElement(tag); no.className = classe || ""; no.textContent = texto; return no; } },
      historyFormat: { formatarHorarioHistorico: valor => valor },
    });
    const antiga = api.atualizarChamadosAbertosHome("SN-A");
    const atual = api.atualizarChamadosAbertosHome("SN-B");
    const relatorio = { snapshot_id: "s1", chamados: [
      { serie: "SN-A", oracle: [{ solicitacao: "R-A", ordem_servico: "1", status: "Aberto" }] },
      { serie: "SN-B", oracle: [{ solicitacao: "R-B", ordem_servico: "2", status: "Aberto" }] },
    ] };
    pendentes[1](relatorio); await atual;
    pendentes[0](relatorio); await antiga;
    assert.match(corpo.textContent, /R-B/);
    assert.doesNotMatch(corpo.textContent, /R-A/);
    assert.equal(contagem.textContent, "1 aberto");
  } finally { delete global.document; }
});
