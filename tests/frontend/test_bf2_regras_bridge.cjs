// BF2: a ponte static/js/features/ticket-rules.js só encaminha para window.SimpressReact["regras-chamados"].
// Dados sintéticos; a lógica das regras é testada em test_cockpit_andamento, test_cockpit_chamados e test_renderers_xss.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const { criarRegrasChamados } = require("../../frontend/src/paineis/regras-chamados/regras.ts");
const createTicketRules = require("../../static/js/features/ticket-rules.js");
const createCockpitToolPanels = require("../../static/js/features/cockpit-tool-panels.js");

const MENSAGEM = 'O painel React "regras-chamados" não carregou.';
const NOMES = [
  "formatarListaChamados", "compararOrdensServicoDecrescente", "obterOrdemServicoPrincipalChamado",
  "compararChamadosPorOrdemServicoDecrescente", "formatarOrdensServico", "etapasProcessoPedido", "formatarDataEtapa",
  "renderizarResumoProcessoPedido", "renderizarLinhaProcessoPedido", "resumirDescricaoChamado", "normalizarFiltroChamados",
  "chamadosClienteInformados", "valoresChamado", "dataAtualizacaoChamado", "classificarAtencaoChamado", "cidadesDoChamado",
  "atendimentosDoChamado", "idadeAtualizacaoChamado", "grupoTriagemChamado", "correspondeTriagemChamado",
];
const dom = createDomUtils(createFakeDocument());

function comJanela(janela, executar) {
  const antiga = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (janela === undefined) delete globalThis.window; else globalThis.window = janela;
  try { return executar(); } finally {
    if (antiga) Object.defineProperty(globalThis, "window", antiga); else delete globalThis.window;
  }
}

function capturarErros(executar) {
  const original = console.error;
  const erros = [];
  console.error = erro => erros.push(erro);
  try { return { resultado: executar(), erros }; } finally { console.error = original; }
}

test("ponte publica as 20 regras, com os mesmos nomes de regras.ts", () => {
  const ponte = createTicketRules(dom);
  assert.deepEqual(Object.keys(ponte).sort(), [...NOMES].sort());
  assert.deepEqual(Object.keys(ponte).sort(), Object.keys(criarRegrasChamados(dom)).sort());
  NOMES.forEach(nome => assert.equal(typeof ponte[nome], "function", nome));
});

test("ponte encaminha cada regra de forma síncrona, com os argumentos e o retorno do painel", () => {
  const chamadas = [];
  const painel = Object.fromEntries(NOMES.map(nome => [nome, (...argumentos) => {
    chamadas.push([nome, argumentos]);
    return { nome, argumentos };
  }]));
  comJanela({ SimpressReact: { "regras-chamados": painel } }, () => {
    const ponte = createTicketRules(dom);
    const entrada = { serie: "SN-FICTICIA", oracle: [] };
    NOMES.forEach(nome => {
      const retorno = ponte[nome](entrada, 7, "texto");
      assert.ok(!(retorno instanceof Promise), `${nome} devolve o valor na hora, sem Promise`);
      assert.deepEqual(retorno, { nome, argumentos: [entrada, 7, "texto"] });
      assert.equal(retorno.argumentos[0], entrada, `${nome} repassa o mesmo objeto`);
    });
  });
  assert.deepEqual(chamadas.map(([nome]) => nome), NOMES);
});

test("ponte lê o painel a cada chamada: o painel pode chegar depois da criação da ponte", () => {
  const ponte = createTicketRules(dom);
  const janela = {};
  comJanela(janela, () => {
    const { resultado, erros } = capturarErros(() => ponte.normalizarFiltroChamados("Atenção"));
    assert.equal(resultado, undefined);
    assert.equal(erros.length, 1);
    janela.SimpressReact = { "regras-chamados": criarRegrasChamados(dom) };
    assert.equal(ponte.normalizarFiltroChamados("Atenção"), "atencao");
  });
});

test("ponte com o painel real devolve o mesmo que regras.ts", () => {
  const regras = criarRegrasChamados(dom);
  comJanela({ SimpressReact: { "regras-chamados": regras } }, () => {
    const ponte = createTicketRules(dom);
    assert.equal(ponte.compararOrdensServicoDecrescente("7134662", "7124895"), -1);
    assert.deepEqual(ponte.idadeAtualizacaoChamado({ status: "Concluído" }), { encerrado: true, dias: null, rotulo: "Chamado encerrado" });
    assert.equal(ponte.formatarListaChamados(["<b>x</b>", "B"]), regras.formatarListaChamados(["<b>x</b>", "B"]));
    assert.equal(ponte.formatarListaChamados(["<b>x</b>"]), "&lt;b&gt;x&lt;/b&gt;");
    assert.equal(ponte.formatarListaChamados([]), "Não informado");
    const registro = { oracle: [{ status: "Em execução", ultima_atualizacao: "2000-01-01" }] };
    assert.deepEqual(ponte.classificarAtencaoChamado(registro), regras.classificarAtencaoChamado(registro));
    assert.equal(ponte.grupoTriagemChamado(registro), regras.grupoTriagemChamado(registro));
  });
});

test("sem o painel, cada regra registra o erro, devolve undefined e não lança", () => {
  [undefined, {}, { SimpressReact: {} }, { SimpressReact: { "regras-chamados": {} } },
    { SimpressReact: { "regras-chamados": { formatarListaChamados: "não é função" } } }].forEach(janela => {
    comJanela(janela, () => {
      const ponte = createTicketRules(dom);
      const { resultado, erros } = capturarErros(() => NOMES.map(nome => ponte[nome]({ serie: "SN-FICTICIA" })));
      assert.deepEqual(resultado, NOMES.map(() => undefined));
      assert.equal(erros.length, NOMES.length);
      erros.forEach(erro => {
        assert.ok(erro instanceof Error);
        assert.equal(erro.message, MENSAGEM);
      });
    });
  });
});

// Com a ponte e sem o bundle React, o Andamento da aba Chamados abre sem lançar: os campos que dependem das regras
// ficam vazios (os helpers devolvem undefined) e cada consulta registra o erro no console.
async function abrirAndamentoSemBundle(chamado) {
  const doc = createFakeDocument();
  const antigoDocumento = global.document;
  doc.getElementById = id => {
    let no = doc.root.querySelectorAll(`[id="${id}"]`)[0];
    if (!no) { no = doc.createElement("div"); no.setAttribute("id", id); doc.body.append(no); }
    return no;
  };
  doc.activeElement = null;
  global.document = doc;
  try {
    const app = { showToast() {}, ...createTicketRules(dom) };
    const api = createCockpitToolPanels({ app, appState: {}, apiFetch: async () => ({ eventos: [] }), historyFormat });
    let opcoes;
    global.SimpressDataPanels = {
      montarTabelaOs: (_host, opts) => { opcoes = opts; return {}; },
      filtrarTabelaOs() {}, atualizarTabelaOs: async () => {},
    };
    await api.abrirPainelCockpit("chamados");
    opcoes.aoCarregar({ snapshot_id: "s1", resumo: { series_total: 1 }, chamados: [chamado] });
    const celula = doc.createElement("td");
    doc.body.append(celula);
    opcoes.aoExpandirSerie(chamado.serie, celula);
    await new Promise(resolve => setImmediate(resolve));
    return celula;
  } finally { global.document = antigoDocumento; delete global.SimpressDataPanels; }
}

test("Andamento com a ponte e sem o bundle não lança e registra o erro em cada consulta", async () => {
  const chamado = {
    serie: "SN-SEM-BUNDLE", relacao: "conferida", alertas_relacao: [],
    oracle: [{
      solicitacao: "REQ-1", ordem_servico: "7134662", status: "Em execução", fila: "Fila A", cidade: "Curitiba",
      ultima_atualizacao: "09/10/2026 14:15", descricao: "Descrição fictícia",
    }],
    simpress: { pedidos: ["48076976"], status: ["Verificação de estoque"], pedido_em_andamento: true },
  };
  const original = console.error;
  const erros = [];
  console.error = erro => erros.push(erro);
  let texto;
  try { texto = (await comJanelaAsync(undefined, () => abrirAndamentoSemBundle(chamado))).textContent; } finally { console.error = original; }
  assert.match(texto, /Fila.*Fila A/);
  assert.match(texto, /Pedido Simpress.*48076976/);
  assert.match(texto, /Descrição do chamado.*Descrição fictícia/);
  assert.doesNotMatch(texto, /Sem atualização há/);
  assert.ok(erros.length > 0, "cada regra consultada sem o painel registra o erro");
  erros.forEach(erro => assert.equal(erro.message, MENSAGEM));
});

async function comJanelaAsync(janela, executar) {
  const antiga = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (janela === undefined) delete globalThis.window; else globalThis.window = janela;
  try { return await executar(); } finally {
    if (antiga) Object.defineProperty(globalThis, "window", antiga); else delete globalThis.window;
  }
}
