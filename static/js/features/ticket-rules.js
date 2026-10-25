/** Ticket tracking rules: service-order ordering, order stages, staleness and the text shown on each ticket card. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.SimpressTicketRules = factory;
})(typeof window !== "undefined" ? window : globalThis, function createTicketRules(dom) {
  "use strict";
  const { escapeHtml, pluralize } = dom;

  function formatarListaChamados(values) {
    const items = Array.isArray(values) ? values.filter(Boolean) : [];
    return items.length ? items.map(escapeHtml).join(", ") : "Não informado";
  }

  function compararOrdensServicoDecrescente(left, right) {
    const leftText = String(left || "").trim();
    const rightText = String(right || "").trim();
    const numericValue = value => {
      const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      if (/[A-Za-z]/.test(normalized)) return null;
      const digits = normalized.replace(/\D/g, "");
      return digits ? BigInt(digits) : null;
    };
    const leftNumber = numericValue(leftText);
    const rightNumber = numericValue(rightText);
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
      return leftNumber > rightNumber ? -1 : 1;
    }
    if (leftNumber !== null && rightNumber === null) return -1;
    if (leftNumber === null && rightNumber !== null) return 1;
    return rightText.localeCompare(leftText, "pt-BR", { numeric: true, sensitivity: "base" });
  }

  function obterOrdemServicoPrincipalChamado(record) {
    const simpress = record?.simpress || {};
    const oracle = Array.isArray(record?.oracle) ? record.oracle : [];
    const values = [
      ...(Array.isArray(simpress.ordens_servico) ? simpress.ordens_servico : []),
      ...(Array.isArray(record?.ordens_servico_conferidas) ? record.ordens_servico_conferidas : []),
      ...oracle.map(ticket => ticket?.ordem_servico),
    ];
    const missingLabels = new Set(["nao informado", "nao informada", "sem os", "n/a", "na"]);
    const orders = values
      .map(value => String(value || "").trim())
      .filter(value => value && !missingLabels.has(normalizarFiltroChamados(value)));
    return orders.reduce((highest, value) => (
      !highest || compararOrdensServicoDecrescente(value, highest) < 0 ? value : highest
    ), "");
  }

  function compararChamadosPorOrdemServicoDecrescente(left, right) {
    const leftOrder = obterOrdemServicoPrincipalChamado(left);
    const rightOrder = obterOrdemServicoPrincipalChamado(right);
    if (!leftOrder && rightOrder) return 1;
    if (leftOrder && !rightOrder) return -1;
    return compararOrdensServicoDecrescente(leftOrder, rightOrder)
      || String(left?.serie || "").localeCompare(String(right?.serie || ""), "pt-BR");
  }

  function formatarOrdensServico(values) {
    const items = Array.isArray(values) ? values.filter(Boolean) : [];
    return formatarListaChamados(items.sort(compararOrdensServicoDecrescente));
  }

  function etapasProcessoPedido(simpress) {
    const rotulos = [
      ["data_pedido", "Data do pedido"], ["liberacao_pedido", "Liberação do pedido"],
      ["verificado_estoque", "Verificando estoque"], ["pedido_separacao", "Pedido em separação"],
      ["nota_fiscal_emitida", "Nota fiscal emitida"], ["a_caminho", "A caminho"], ["previsao_entrega", "Previsão de entrega"],
      ["entregue", "Pedido entregue"],
    ];
    if (Array.isArray(simpress.etapas_pedido) && simpress.etapas_pedido.length) {
      return simpress.etapas_pedido.map(etapa => ({ ...etapa, data: String(etapa.data || "").trim(), coluna: etapa.coluna_na_planilha !== false }));
    }
    // Versões antigas guardavam só a data do pedido e a previsão, em listas.
    const primeiro = valores => (Array.isArray(valores) ? valores.filter(Boolean) : [])[0] || "";
    return rotulos.map(([chave, rotulo]) => {
      const data = chave === "data_pedido" ? primeiro(simpress.datas_pedido) : chave === "previsao_entrega" ? primeiro(simpress.previsoes_entrega) : "";
      return { chave, rotulo, data, coluna: Boolean(data) };
    });
  }

  function formatarDataEtapa(value) {
    const parsed = dataAtualizacaoChamado(value);
    return parsed ? parsed.toLocaleDateString("pt-BR") : String(value || "");
  }

  function renderizarResumoProcessoPedido(simpress) {
    const etapas = etapasProcessoPedido(simpress);
    if (!etapas.some(etapa => etapa.data)) return "";
    const previsao = etapas.find(etapa => etapa.chave === "previsao_entrega" && etapa.data);
    const eventos = etapas.filter(etapa => etapa.chave !== "previsao_entrega");
    const atual = [...eventos].reverse().find(etapa => etapa.data);
    const proxima = atual ? eventos.slice(eventos.indexOf(atual) + 1).find(etapa => etapa.coluna && !etapa.data) : null;
    const previsaoData = previsao ? dataAtualizacaoChamado(previsao.data) : null;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const atrasada = Boolean(previsaoData && previsaoData < hoje && simpress.pedido_em_andamento);
    const partes = [];
    if (previsao) partes.push(`<span class="ticket-process-forecast${atrasada ? " is-late" : ""}"><b>Previsão de entrega</b> ${escapeHtml(formatarDataEtapa(previsao.data))}${atrasada ? " · prazo vencido" : ""}</span>`);
    if (atual) partes.push(`<span class="ticket-process-current"><b>Etapa atual</b> ${escapeHtml(atual.rotulo)} · ${escapeHtml(formatarDataEtapa(atual.data))}</span>`);
    if (proxima) partes.push(`<span class="ticket-process-next"><b>Próxima</b> ${escapeHtml(proxima.rotulo)} · sem data</span>`);
    return `<div class="ticket-process-summary mt-2" aria-label="Situação do pedido">${partes.join("")}</div>${renderizarLinhaProcessoPedido(simpress)}`;
  }

  function renderizarLinhaProcessoPedido(simpress) {
    const etapas = etapasProcessoPedido(simpress);
    const ultimaComData = etapas.reduce((indice, etapa, posicao) => (etapa.chave !== "previsao_entrega" && etapa.data ? posicao : indice), -1);
    const itens = etapas.map((etapa, posicao) => {
      const concluida = Boolean(etapa.data);
      const estado = etapa.chave === "previsao_entrega" ? (concluida ? "forecast" : "pending")
        : concluida ? (posicao === ultimaComData ? "current" : "done") : "pending";
      const texto = concluida ? formatarDataEtapa(etapa.data) : etapa.coluna ? "Pendente" : "Não informado na planilha";
      const marcador = concluida ? (estado === "forecast" ? "◆" : "✓") : "○";
      return `<li class="ticket-stage is-${estado}"><span class="ticket-stage-mark" aria-hidden="true">${marcador}</span><span class="ticket-stage-text"><span class="ticket-stage-label">${escapeHtml(etapa.rotulo)}</span> - <span class="ticket-stage-date">${escapeHtml(texto)}</span></span></li>`;
    });
    // The summary above already shows the forecast and current stage, so the full list starts closed.
    return `<details class="ticket-disclosure ticket-stages-disclosure mt-1.5" data-ticket-section="stages"><summary class="ticket-disclosure-summary cursor-pointer text-xs font-semibold text-fg-tertiary">Etapas do pedido</summary><ol class="ticket-stages" aria-label="Etapas do pedido">${itens.join("")}</ol></details>`;
  }

  function resumirDescricaoChamado(value, limit = 150) {
    const description = String(value || "").replace(/\s+/g, " ").trim();
    return description.length > limit ? `${description.slice(0, limit).trimEnd()}…` : description;
  }

  function normalizarFiltroChamados(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
  }

  function chamadosClienteInformados(values) {
    return (Array.isArray(values) ? values : []).filter(value => {
      const normalized = normalizarFiltroChamados(value);
      return normalized && normalized !== "nao informado";
    });
  }

  function valoresChamado(record) {
    if (Array.isArray(record)) return record.flatMap(valoresChamado);
    if (record && typeof record === "object") return Object.values(record).flatMap(valoresChamado);
    return record == null ? [] : [String(record)];
  }

  function dataAtualizacaoChamado(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    const isoDate = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (isoDate) return new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(text);
    if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4] || 0), Number(match[5] || 0));
    const direct = new Date(text);
    if (!Number.isNaN(direct.getTime())) return direct;
    return null;
  }

  function classificarAtencaoChamado(record) {
    const oracle = Array.isArray(record.oracle) ? record.oracle : [];
    const encerrados = ["conclu", "encerr", "finaliz", "cancel", "resolvid", "fechad", "closed", "complete"];
    const ativos = oracle.filter(ticket => !encerrados.some(token => normalizarFiltroChamados(`${ticket.status || ""} ${ticket.sub_status || ""}`).includes(token)));
    const datas = ativos.map(ticket => dataAtualizacaoChamado(ticket.ultima_atualizacao)).filter(Boolean);
    const ultima = datas.length ? new Date(Math.max(...datas.map(value => value.getTime()))) : null;
    const hoje = new Date();
    const hojeUtc = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    const ultimaUtc = ultima ? Date.UTC(ultima.getFullYear(), ultima.getMonth(), ultima.getDate()) : 0;
    const idade = ultima ? Math.max(0, Math.floor((hojeUtc - ultimaUtc) / 86400000)) : null;
    const desatualizado = ativos.length > 0 && (idade === null || idade >= 3);
    const prioridade = desatualizado ? 0 : 1;
    const motivos = desatualizado
      ? [idade === null ? "Sem data de atualização" : `Sem atualização há ${idade} ${pluralize(idade, "dia")}`]
      : [];
    return {
      prioridade,
      em_atencao: desatualizado,
      desatualizado,
      dias_sem_atualizacao: idade,
      ultima_atualizacao: ultima ? ultima.toISOString().slice(0, 10) : "",
      motivo: motivos.join(" · ") || "Em acompanhamento",
    };
  }

  function cidadesDoChamado(record) {
    const deliveryCities = record?.simpress?.cidades_entrega;
    const values = [
      ...(Array.isArray(deliveryCities) ? deliveryCities : deliveryCities ? [deliveryCities] : []),
      ...(Array.isArray(record?.oracle) ? record.oracle.map(ticket => ticket?.cidade) : []),
    ].map(value => String(value || "").trim()).filter(Boolean);
    return [...new Map(values.map(value => [normalizarFiltroChamados(value), value])).values()];
  }

  function atendimentosDoChamado(record) {
    const providers = new Set();
    (Array.isArray(record?.oracle) ? record.oracle : []).forEach(ticket => {
      const branch = normalizarFiltroChamados(ticket?.nome_filial || "");
      if (branch.includes("parceiro")) providers.add("Parceiro");
      else if (branch.includes("simpress")) providers.add("Simpress");
      else providers.add(branch ? "Outro" : "Não informado");
    });
    return [...providers].sort((left, right) => left.localeCompare(right, "pt-BR"));
  }

  function idadeAtualizacaoChamado(ticket) {
    const encerrar = ["conclu", "encerr", "finaliz", "cancel", "resolvid", "fechad", "closed", "complete"];
    if (encerrar.some(token => normalizarFiltroChamados(`${ticket?.status || ""} ${ticket?.sub_status || ""}`).includes(token))) {
      return { encerrado: true, dias: null, rotulo: "Chamado encerrado" };
    }
    const ultima = dataAtualizacaoChamado(ticket?.ultima_atualizacao);
    if (!ultima) return { encerrado: false, dias: null, rotulo: "Sem data de atualização" };
    const hoje = new Date();
    const hojeUtc = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    const ultimaUtc = Date.UTC(ultima.getFullYear(), ultima.getMonth(), ultima.getDate());
    const dias = Math.max(0, Math.floor((hojeUtc - ultimaUtc) / 86400000));
    return { encerrado: false, dias, rotulo: dias === 1 ? "Sem atualização há 1 dia" : `Sem atualização há ${dias} dias` };
  }

  return {
    formatarListaChamados, compararOrdensServicoDecrescente, obterOrdemServicoPrincipalChamado,
    compararChamadosPorOrdemServicoDecrescente, formatarOrdensServico, etapasProcessoPedido, formatarDataEtapa,
    renderizarResumoProcessoPedido, renderizarLinhaProcessoPedido, resumirDescricaoChamado, normalizarFiltroChamados,
    chamadosClienteInformados, valoresChamado, dataAtualizacaoChamado, classificarAtencaoChamado, cidadesDoChamado,
    atendimentosDoChamado, idadeAtualizacaoChamado,
  };
});
