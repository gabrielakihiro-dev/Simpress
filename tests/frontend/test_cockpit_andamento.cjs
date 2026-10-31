const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createTicketRules = require("../../static/js/features/ticket-rules.js");
const createCockpitToolPanels = require("../../static/js/features/cockpit-tool-panels.js");

// Regras de chamado (antes cobertas pelo modal de acompanhamento): vivem em ticket-rules e no Andamento da aba Chamados.
const rules = createTicketRules(createDomUtils(createFakeDocument()));

function dataLocal(diasAtras) {
  const valor = new Date();
  valor.setHours(12, 0, 0, 0);
  valor.setDate(valor.getDate() - diasAtras);
  return `${valor.getFullYear()}-${String(valor.getMonth() + 1).padStart(2, "0")}-${String(valor.getDate()).padStart(2, "0")}`;
}

test("dataAtualizacaoChamado entende ISO, ISO com hora e dia/mês/ano", () => {
  assert.equal(rules.dataAtualizacaoChamado("2026-10-09").getDate(), 9);
  assert.equal(rules.dataAtualizacaoChamado("2026-10-09T00:00:00Z").getDate(), 9);
  assert.equal(rules.dataAtualizacaoChamado("09/10/2026").getMonth(), 9);
});

test("regra de atenção: 3 dias ou mais em chamado ativo; encerrado, recente e sem Oracle ficam de fora", () => {
  const ativo = dias => ({ oracle: [{ status: "Em execução", ultima_atualizacao: dataLocal(dias) }] });
  assert.equal(rules.classificarAtencaoChamado(ativo(3), 30).em_atencao, true);
  assert.equal(rules.classificarAtencaoChamado(ativo(0), 30).em_atencao, false);
  assert.equal(rules.classificarAtencaoChamado({ oracle: [{ status: "Concluído", ultima_atualizacao: "2000-01-01" }] }, 30).em_atencao, false);
  assert.equal(rules.classificarAtencaoChamado({ oracle: [] }, 30).em_atencao, false);
});

test("formatarHorarioHistorico converte datas da planilha no formato local", () => {
  const esperado = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" });
  assert.equal(historyFormat.formatarHorarioHistorico("09/10/2026 14:15"), esperado.format(new Date(2026, 9, 9, 14, 15)));
  assert.equal(historyFormat.formatarHorarioHistorico("2026-10-09"), esperado.format(new Date(2026, 9, 9)));
});

async function abrirAndamento(chamados, respostaTempo = { eventos: [] }) {
  const doc = createFakeDocument();
  const antigoDocumento = global.document;
  // Cada id pedido vira um nó no corpo, como se o index.html já os tivesse.
  doc.getElementById = id => {
    let no = doc.root.querySelectorAll(`[id="${id}"]`)[0];
    if (!no) { no = doc.createElement("div"); no.setAttribute("id", id); doc.body.append(no); }
    return no;
  };
  doc.activeElement = null;
  global.document = doc;
  const app = { showToast() {}, ...rules };
  const api = createCockpitToolPanels({
    app, appState: {}, apiFetch: async () => respostaTempo, historyFormat,
  });
  let opcoes;
  global.SimpressDataPanels = {
    montarTabelaOs: (_host, opts) => { opcoes = opts; return {}; },
    filtrarTabelaOs() {}, atualizarTabelaOs: async () => {},
  };
  await api.abrirPainelCockpit("chamados");
  opcoes.aoCarregar({ snapshot_id: "s1", resumo: { series_total: chamados.length }, chamados });
  const celulas = {};
  chamados.forEach(chamado => {
    const celula = doc.createElement("td");
    doc.body.append(celula);
    opcoes.aoExpandirSerie(chamado.serie, celula);
    celulas[chamado.serie] = celula;
  });
  await new Promise(resolve => setImmediate(resolve));
  return { celulas, doc, restaurar() { global.document = antigoDocumento; delete global.SimpressDataPanels; } };
}

test("Andamento mostra cidade, fila, atendimento e endereço de entrega só com pedido em andamento", async () => {
  const { celulas, restaurar } = await abrirAndamento([
    {
      serie: "SN-ATIVO", relacao: "conferida", alertas_relacao: [],
      oracle: [{
        solicitacao: "REQ-77", ordem_servico: "7134662", status: "Em execução", fila: "Fila A", fase_atendimento: "Em campo",
        logradouro: "R Caeté", numero_endereco: "150", bairro: "Prado Velho", cidade: "Curitiba", nome_filial: "SIMPRESS - PR",
        ultima_atualizacao: "09/10/2026 14:15", descricao: "Solicito suporte. <script>alert('x')</script>",
      }, { solicitacao: "REQ-76", ordem_servico: "7124895", status: "Concluído", fila: "Fila A" }],
      simpress: {
        pedidos: ["48076976"], ordens_servico: ["7124895", "7134662"], status: ["Verificação de estoque"],
        cidades_entrega: ["Curitiba"], enderecos_entrega: ["Rua das Flores, 123, Curitiba - PR"], pedido_em_andamento: true,
        chamados_cliente: ["Não informado", "INC-1"],
      },
    },
    {
      serie: "SN-ENTREGUE", relacao: "somente_simpress", oracle: [],
      simpress: {
        pedidos: ["48076977"], ordens_servico: ["7232036"], status: ["Pedido entregue"],
        cidades_entrega: ["Maringá"], enderecos_entrega: ["Rua que não deve aparecer"], pedido_em_andamento: false,
      },
    },
  ]);
  try {
    const ativo = celulas["SN-ATIVO"];
    const texto = ativo.textContent;
    assert.match(texto, /^Conferida/, "a relação aparece como selo");
    assert.match(texto, /Pedido Simpress.*48076976/);
    assert.match(texto, /Fila.*Fila A/);
    assert.match(texto, /Atendimento.*Simpress/);
    assert.match(texto, /Endereço Oracle.*R Caeté, 150, Prado Velho, Curitiba/);
    assert.match(texto, /Endereço de entrega.*Rua das Flores, 123, Curitiba - PR/);
    assert.match(texto, /Última atualização Oracle.*Sem atualização há/);
    assert.match(texto, /Chamado do cliente.*INC-1/);
    assert.doesNotMatch(texto, /Chamado do cliente.*Não informado/);
    assert.ok(texto.includes("<script>alert('x')</script>"), "a descrição entra como texto, sem virar tag");
    assert.equal(ativo.querySelectorAll("script").length, 0, "nenhuma tag viva vinda da descrição");
    assert.ok(texto.indexOf("7134662") < texto.indexOf("7124895"), "OS Oracle em ordem decrescente");
    assert.match(texto, /Andamento registrado/);

    const entregue = celulas["SN-ENTREGUE"].textContent;
    assert.doesNotMatch(entregue, /Rua que não deve aparecer/);
    assert.match(entregue, /Ordens no Oracle.*Nenhuma ordem informada/);
  } finally { restaurar(); }
});

test("linha do tempo mostra as mudanças e a anotação de até 2000 caracteres por versão", async () => {
  const { celulas, restaurar } = await abrirAndamento(
    [{ serie: "SN-1", relacao: "conferida", oracle: [], simpress: {} }],
    { eventos: [{
      snapshot_id: "import-1", item_id: "ticket-row-1", atualizado_em: "2026-10-10T10:00:00", tipo: "Dados alterados",
      mudancas: [{ campo: "OS Oracle", anterior: ["7124895"], atual: ["7279287"] }], anotacao: "Acompanhar parceiro",
    }] },
  );
  try {
    const texto = celulas["SN-1"].textContent;
    assert.match(texto, /Dados alterados/);
    assert.match(texto, /OS Oracle: 7124895 → 7279287/);
    const campo = celulas["SN-1"].querySelector("textarea");
    assert.equal(campo.maxLength, 2000);
    assert.equal(campo.value, "Acompanhar parceiro");
  } finally { restaurar(); }
});
