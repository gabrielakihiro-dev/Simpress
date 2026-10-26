const assert = require("node:assert/strict");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createTicketRules = require("../../static/js/features/ticket-rules.js");
const createTicketTracking = require("../../static/js/features/ticket-tracking.js");
const createComparisonResultRenderer = require("../../static/js/ui/comparison-result-renderer.js");
const createEquipmentSearchRenderers = require("../../static/js/ui/equipment-search-renderers.js");
const createLoggedUserMarkers = require("../../static/js/ui/logged-user-markers.js");

// Every text field gets its own tagged payload, so a failure names the field that leaked or was never rendered.
const carga = campo => `"><img src=x onerror=alert(1)>#${campo}`;

function criarElementoFalso() {
  return {
    value: "", checked: false, open: false, disabled: false, textContent: "", innerHTML: "", children: [], dataset: {},
    content: { querySelector: () => null },
    setAttribute() {}, addEventListener() {}, replaceChildren() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
}
const elementos = new Map();
globalThis.document = {
  createElement: () => criarElementoFalso(),
  getElementById: id => {
    if (!elementos.has(id)) elementos.set(id, criarElementoFalso());
    return elementos.get(id);
  },
};

const dom = createDomUtils(globalThis.document);
const { escapeHtml } = dom;
const loggedUserMarkers = createLoggedUserMarkers({ dom });

// Live markup is a real tag or an attribute breakout; escaped text may still spell `onerror=`.
function afirmarSemHtmlVivo(html, contexto) {
  assert.doesNotMatch(html, /<img\b/i, `${contexto}: tag <img> viva`);
  assert.ok(!html.includes('"><img'), `${contexto}: escape de atributo`);
}
function afirmarCamposEscapados(html, campos, contexto) {
  afirmarSemHtmlVivo(html, contexto);
  for (const campo of campos) {
    assert.ok(html.includes(escapeHtml(carga(campo))), `${contexto}: campo "${campo}" ausente ou sem escape`);
  }
}

test("comparison result renderer escapes every text field", () => {
  const renderer = createComparisonResultRenderer({
    app: { atributosVersaoAnotacao: () => "" }, dom, historyFormat, loggedUserMarkers,
  });
  const anotacao = { anotacao: carga("anotacao"), anotacao_id: carga("anotacao_id") };
  const comparison = {
    historico_salvo: false, contexto_historico: true, evento_id: "e1",
    aviso_historico: carga("aviso_historico"), backup_diretorio: carga("backup_diretorio"),
    horario_comparacao: carga("horario_comparacao"),
    ausentes_no_endpoint: [{
      computador: carga("end_computador"), serie: carga("end_serie"), local_previsto: carga("end_local"),
      ausente_em: [carga("end_ausente_em")], ...anotacao,
      anotacoes_associadas: [{ anotacao: carga("end_anterior"), anotacao_id: carga("end_anterior_id") }],
    }],
    ausentes_em_detalhes: [{
      computador: carga("det_computador"), serie: carga("det_serie"), local_previsto: carga("det_local"),
      fonte_ausente: carga("det_fonte"),
    }],
    divergencias_local: [{
      computador: carga("loc_computador"), serie: carga("loc_serie"),
      local_previsto: carga("loc_previsto"), local_detalhes: carga("loc_detalhes"),
    }],
    sem_acesso_7_dias: [{
      computador: carga("acesso_computador"), serie: carga("acesso_serie"), dias_sem_verificacao: 9,
      ultima_verificacao: carga("acesso_ultima"), linha_endpoint: carga("acesso_linha"),
    }],
    series_sem_mapeamento: [{ serie: carga("mapa_serie"), quantidade: 2, exemplos: [carga("mapa_exemplo")] }],
    correspondencias_ambiguas: [{
      tipo: carga("amb_tipo"), chave: carga("amb_chave"), mensagem: carga("amb_mensagem"),
      fontes: [{ fonte: carga("amb_fonte"), quantidade: 0, serie: carga("amb_fonte_serie") }],
      registros_endpoint: [
        { computador: carga("amb_host_a"), serie: carga("amb_serie_a"), ultima_verificacao: carga("amb_verif_a"), mais_antigo: true },
        { computador: carga("amb_host_b"), serie: carga("amb_serie_b") },
      ],
    }],
    registros_ambiguos: [{
      computador: carga("reg_computador"), serie: carga("reg_serie"), motivo: carga("reg_motivo"),
      fontes: { [carga("reg_fonte")]: "ambíguo" },
    }],
    apelidos_atualizados: [{
      serie: carga("atu_serie"), apelido_anterior: carga("atu_anterior"), apelido_novo: carga("atu_novo"),
      horario: carga("atu_horario"), arquivos_origem: { a: carga("atu_arquivo") },
    }],
    apelidos_sem_atualizacao: [{ serie: carga("conf_serie"), computador: carga("conf_computador"), motivo: carga("conf_motivo") }],
    divergencias_apelidos_manuais: [{
      serie: carga("man_serie"), apelido_manual: carga("man_manual"),
      apelido_equipamentos_detalhes: carga("man_detalhes"), apelido_invall: carga("man_invall"),
    }],
    mudancas_usuarios: [{
      tipo: carga("mud_tipo"), serie: carga("mud_serie"), computador: carga("mud_computador"),
      usuario_anterior: carga("mud_usuario_ant"), origem_anterior: "manual", nome_pessoa_anterior: carga("mud_pessoa_ant"),
      usuario_novo: carga("mud_usuario_novo"), origem_nova: "endpoint", nome_pessoa_novo: carga("mud_pessoa_novo"),
      motivo: carga("mud_motivo"), usuario_manual_arquivado: carga("mud_sugestao"),
      pendencia_tipo: "substituicao_manual", pendencia_id: carga("mud_pendencia"),
    }],
    anotacoes_sincronizadas: [{
      categoria: carga("sinc_categoria"), computador: carga("sinc_computador"), serie: carga("sinc_serie"), motivo: carga("sinc_motivo"),
    }],
  };
  const html = renderer.conteudoResultadoComparacao(
    comparison, renderer.listasComparacao(comparison), renderer.criarColunasAnotacao(comparison),
  );

  // `tipo` of user changes only picks a label and `ausente_em`/dates go through formatters: only the live-markup check applies.
  const soSemHtmlVivo = new Set([
    "mud_tipo", "acesso_ultima", "atu_horario", "amb_verif_a", "horario_comparacao", "amb_fonte", "amb_fonte_serie",
    "reg_fonte", "end_ausente_em", "det_fonte", "atu_arquivo", "mud_sugestao", "mud_pendencia",
  ]);
  const campos = [
      "aviso_historico", "backup_diretorio", "end_computador", "end_serie", "end_local", "anotacao", "anotacao_id",
      "end_anterior", "det_computador", "det_serie", "det_local", "loc_computador", "loc_serie", "loc_previsto",
      "loc_detalhes", "acesso_computador", "acesso_serie", "acesso_linha", "mapa_serie", "mapa_exemplo",
      "amb_tipo", "amb_chave", "amb_mensagem", "amb_host_a", "reg_motivo", "atu_serie", "atu_anterior",
      "atu_novo", "conf_serie", "conf_computador", "conf_motivo", "man_serie", "man_manual", "man_detalhes",
      "man_invall", "mud_serie", "mud_computador", "mud_usuario_ant", "mud_pessoa_ant", "mud_usuario_novo",
      "mud_pessoa_novo", "mud_motivo",
    ].filter(campo => !soSemHtmlVivo.has(campo));
  afirmarCamposEscapados(html, campos, "conteudoResultadoComparacao");

  const sincronizadas = renderer.conteudoAnotacoesSincronizadas(comparison, renderer.criarColunasAnotacao(comparison));
  afirmarSemHtmlVivo(sincronizadas, "conteudoAnotacoesSincronizadas");
  assert.ok(sincronizadas.includes(escapeHtml(carga("sinc_computador"))), "conteudoAnotacoesSincronizadas: hostname");
});

test("ticket card escapes Simpress and Oracle fields", () => {
  const appState = { filtroChamadoSelecionado: null, filtroTriagemChamados: "", acompanhamentoChamadosAtual: null };
  const gate = { invalidate() {}, begin: () => ({ id: 1, signal: undefined }), isCurrent: () => true };
  const ticketTracking = createTicketTracking({
    app: {}, appState, motion: null, dom, historyFormat,
    transferUtils: { createRequestGate: () => gate },
    ticketRules: createTicketRules(dom),
    loggedUserMarkers: { marcador: loggedUserMarkers.marcador, conectar() {} },
  });
  appState.acompanhamentoChamadosAtual = {
    snapshot_id: carga("snapshot"),
    atualizado_em: carga("atualizado_em"),
    fontes: { simpress: { arquivo: carga("arquivo_simpress") }, oracle: { arquivo: carga("arquivo_oracle") } },
    resumo: {},
    chamados: [{
      serie: carga("serie"),
      relacao: carga("relacao"),
      simpress: {
        pedidos: [carga("pedido")], ordens_venda: [carga("ordem_venda")], ordens_servico: [carga("os_simpress")],
        status: [carga("status_simpress")], chamados_cliente: [carga("chamado_cliente")],
        descricoes_produto: [carga("descricao_produto")], cidades_entrega: [carga("cidade_entrega")],
        enderecos_entrega: [carga("endereco_entrega")], pedido_em_andamento: true,
      },
      oracle: [{
        solicitacao: carga("solicitacao"), ordem_servico: carga("os_oracle"), status: carga("status_oracle"),
        sub_status: carga("sub_status"), fila: carga("fila"), fase_atendimento: carga("fase"),
        logradouro: carga("logradouro"), numero_endereco: carga("numero"), bairro: carga("bairro"), cidade: carga("cidade"),
        atendido_pela_inibicao: carga("inibicao"), nome_filial: carga("filial"), status_entregas: carga("entregas"),
        status_atividades: carga("atividades"), descricao: carga("descricao"),
      }],
    }],
  };
  ticketTracking.renderizarAcompanhamentoChamados();
  const html = document.getElementById("lista-acompanhamento-chamados").innerHTML;

  assert.match(html, /data-ticket-serial=/, "o cartão deve ter sido renderizado");
  afirmarCamposEscapados(html, [
    "serie", "pedido", "ordem_venda", "os_simpress", "status_simpress", "chamado_cliente", "descricao_produto",
    "cidade_entrega", "endereco_entrega", "solicitacao", "os_oracle", "status_oracle", "sub_status", "fila", "fase",
    "inibicao", "entregas", "atividades", "snapshot",
  ], "renderizarCartaoChamado");
  const resumo = document.getElementById("resumo-acompanhamento-chamados").innerHTML;
  afirmarCamposEscapados(resumo, ["arquivo_simpress", "arquivo_oracle"], "renderizarResumoChamados");
});

test("equipment search rows escape every field, with and without highlighting", () => {
  const renderers = createEquipmentSearchRenderers({ dom, loggedUserMarkers });
  const item = {
    serial: carga("serial"), tipo: carga("tipo"), modelo: carga("modelo"), apelido: carga("apelido"),
    usuarios_logados: carga("usuario"), usuarios_logados_origem: "manual", usuarios_logados_informado_em: carga("informado_em"),
    usuarios_logados_pendencia: true, nome_pessoa: carga("nome_pessoa"), nome_pessoa_origem: "manual",
    usuarios_logados_candidatos: [carga("candidato_a"), carga("candidato_b")],
    invall_alias_status: "pendente", invall_alias_detail: carga("alias_detalhe"), retirada_cidade: carga("cidade"),
  };
  const campos = ["serial", "tipo", "modelo", "apelido", "usuario", "nome_pessoa", "candidato_a", "alias_detalhe", "cidade"];
  // The autocomplete dropdown shows a compact row (serial, modelo, usuário, cidade); the full search keeps every field.
  const camposAutocomplete = ["serial", "modelo", "usuario", "cidade"];
  // A query inside the payload makes highlightMatch split the text around the match.
  for (const query of ["", "img", "<img", "#serial", '">']) {
    for (const [nome, linha, camposDaLinha] of [
      ["autocomplete", renderers.criarLinhaAutocomplete(item, 0, query, {}), camposAutocomplete],
      ["busca completa", renderers.criarLinhaPesquisaCompleta(item, 0, query, () => {}), campos],
    ]) {
      const contexto = `conteudoLinhaResultado (${nome}, consulta ${JSON.stringify(query)})`;
      afirmarSemHtmlVivo(linha.innerHTML, contexto);
      if (!query) afirmarCamposEscapados(linha.innerHTML, camposDaLinha, contexto);
    }
  }
});
