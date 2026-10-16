/** Ticket tracking dialog: imports the Simpress and Oracle sheets, lists tickets by series, versions, timelines and export. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).ticketTracking = factory;
})(typeof window !== "undefined" ? window : globalThis, function createTicketTracking(context) {
  "use strict";
  const { app, appState, transferUtils, motion } = context;
  const { escapeHtml } = context.dom;
  const { formatarHorarioHistorico } = context.historyFormat;
  const {
    formatarListaChamados, compararOrdensServicoDecrescente, compararChamadosPorOrdemServicoDecrescente, formatarOrdensServico,
    renderizarResumoProcessoPedido, resumirDescricaoChamado, normalizarFiltroChamados, chamadosClienteInformados, valoresChamado,
    classificarAtencaoChamado, cidadesDoChamado, atendimentosDoChamado, idadeAtualizacaoChamado,
  } = context.ticketRules;

  const ticketSnapshotRequestGate = transferUtils.createRequestGate();
  const ticketEvolutionRequestGate = transferUtils.createRequestGate();
  const ticketTimelineRequests = new Map();

  const RELACOES_CHAMADO = {
    conferida: ["OS conferida", "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"],
    divergente: ["OS divergente", "border-amber-400/30 bg-amber-500/10 text-amber-100"],
    sem_os: ["OS ausente", "border-slate-600 bg-slate-800 text-slate-200"],
    somente_simpress: ["Sem registro no Oracle", "border-sky-400/30 bg-sky-500/10 text-sky-100"],
    somente_oracle: ["Sem pedido Simpress", "border-violet-400/30 bg-violet-500/10 text-violet-100"],
  };
  // Cards keep their open sections when the list is rendered again.
  const chaveSecaoCartao = (serial, section) => JSON.stringify([serial, section]);

  function fecharAcompanhamentoChamados() {
    ticketSnapshotRequestGate.invalidate();
    ticketEvolutionRequestGate.invalidate();
    cancelarLeiturasLinhasDoTempoChamados();
    app.fecharModalAcessivel("modal-acompanhamento-chamados");
  }

  function cancelarLeiturasLinhasDoTempoChamados() {
    ticketTimelineRequests.forEach(gate => gate.invalidate());
    ticketTimelineRequests.clear();
  }

  function obterFiltrosChamados() {
    return {
      search: document.getElementById("filtro-acompanhamento-chamados").value.trim(),
      stale_days: 3,
      attention_only: Boolean(document.getElementById("somente-atencao-chamados").checked),
    };
  }

  function renderizarHistoricoAcompanhamentoChamados(data) {
    const selector = document.getElementById("versao-acompanhamento-chamados");
    const events = Array.isArray(data.historico) ? data.historico : [];
    appState.historicoAcompanhamentoChamados = events;
    const selectedId = data.snapshot_id || "";
    const options = events.map(event => {
      const option = document.createElement("option");
      option.value = event.id || "";
      const sources = event.fontes || {};
      const simpressName = typeof sources.simpress === "string" ? sources.simpress : sources.simpress?.arquivo;
      const oracleName = typeof sources.oracle === "string" ? sources.oracle : sources.oracle?.arquivo;
      const files = [simpressName, oracleName].filter(Boolean).join(" + ");
      option.textContent = `${formatarHorarioHistorico(event.atualizado_em)}${files ? ` · ${files}` : ""}`;
      return option;
    });
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Nenhuma importação";
    selector.replaceChildren(empty, ...options);
    selector.value = selectedId;
    selector.disabled = events.length === 0;
    document.getElementById("btn-excluir-importacoes-antigas-chamados").disabled = events.length <= 1;
    if (!selectedId && events.length) selector.value = events[0].id;
  }

  function renderizarEvolucaoChamados(data) {
    const target = document.getElementById("evolucao-acompanhamento-chamados");
    const counts = data.contagens || {};
    const changes = data.mudancas || {};
    const changed = Array.isArray(changes.alterados) ? changes.alterados : [];
    const newRows = Array.isArray(changes.novos) ? changes.novos : [];
    const absent = Array.isArray(changes.ausentes_arquivo) ? changes.ausentes_arquivo : [];
    const details = [
      ...newRows.slice(0, 5).map(serial => `<li><strong>Nova série:</strong> ${escapeHtml(serial)}</li>`),
      ...changed.slice(0, 8).map(row => `<li><strong>${escapeHtml(row.serie)}:</strong> ${row.campos.map(field => escapeHtml(field.campo)).join(", ")}</li>`),
      ...absent.slice(0, 5).map(serial => `<li><strong>Não consta na planilha atual:</strong> ${escapeHtml(serial)}</li>`),
    ];
    target.innerHTML = `<p class="font-semibold text-white">Comparação com a versão anterior · ${Number(counts.novos) || 0} novas · ${Number(counts.alterados) || 0} alteradas · ${Number(counts.iguais) || 0} sem mudança · ${Number(counts.ausentes_arquivo) || 0} ausentes</p><p class="mt-1 text-[10px] text-amber-200">${escapeHtml(data.aviso_ausentes || "Ausência na planilha não confirma resolução.")}</p>${details.length ? `<ul class="mt-2 list-disc space-y-1 pl-5 text-[10px] text-slate-300">${details.join("")}</ul>` : ""}`;
  }

  async function carregarEvolucaoChamados(snapshotId) {
    const request = ticketEvolutionRequestGate.begin();
    const target = document.getElementById("evolucao-acompanhamento-chamados");
    const index = appState.historicoAcompanhamentoChamados.findIndex(event => event.id === snapshotId);
    const older = index >= 0 ? appState.historicoAcompanhamentoChamados[index + 1] : null;
    if (!older) {
      target.textContent = appState.historicoAcompanhamentoChamados.length > 1
        ? "Esta é a importação mais antiga disponível. Selecione uma versão mais recente para comparar."
        : "A primeira importação ficará registrada aqui para comparação com as próximas planilhas.";
      return;
    }
    target.textContent = "Comparando esta versão com a anterior…";
    try {
      const query = new URLSearchParams({ anterior: older.id, atual: snapshotId });
      const response = await fetch(`/api/operacoes/chamados/evolucao?${query.toString()}`, { signal: request.signal });
      const data = await response.json().catch(() => ({}));
      if (!ticketEvolutionRequestGate.isCurrent(request.id)) return;
      if (!response.ok) throw new Error(data.detail || "Não foi possível comparar as versões dos chamados.");
      app.renderizarEvolucaoChamados(data);
    } catch (error) {
      if (!ticketEvolutionRequestGate.isCurrent(request.id)) return;
      target.textContent = error.message || "Não foi possível comparar as versões dos chamados.";
    }
  }

  function renderizarLinhaDoTempoChamado(events) {
    const fields = [
      ["pedidos_simpress", "Pedido Simpress"],
      ["solicitacoes_oracle", "Solicitação Oracle"],
      ["ordens_venda_simpress", "OV Simpress"],
      ["ordens_servico_simpress", "OS Simpress"],
      ["ordens_servico_oracle", "OS Oracle"],
      ["status_simpress", "Status Simpress"],
      ["status_oracle", "Status Oracle"],
      ["filas_oracle", "Fila Oracle"],
      ["atualizacoes_oracle", "Última atualização Oracle"],
    ];
    const formatValue = value => Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value || "");
    if (!Array.isArray(events) || !events.length) return '<p class="py-3 text-xs text-slate-400">Não há versões anteriores para esta série.</p>';
    return `<div class="space-y-2 py-2">${events.map(event => {
      const state = event.estado || {};
      const values = fields.map(([key, label]) => [label, formatValue(state[key])]).filter(([, value]) => value);
      const changes = Array.isArray(event.mudancas) ? event.mudancas : [];
      return `<article class="rounded-lg border border-slate-800 bg-slate-950/70 p-3" data-ticket-timeline-event="${escapeHtml(event.item_id || "")}">
          <div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-xs text-white">${escapeHtml(event.tipo || "Atualização")}</strong><time class="text-[10px] text-slate-400">${escapeHtml(formatarHorarioHistorico(event.atualizado_em))}</time></div>
          <dl class="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">${values.map(([label, value]) => `<div class="min-w-0 text-[10px]"><dt class="inline font-semibold text-slate-400">${label}: </dt><dd class="inline break-words text-slate-200">${escapeHtml(value)}</dd></div>`).join("")}</dl>
          <div class="mt-2 text-[10px] text-slate-300"><span class="font-semibold text-cyan-200">Mudanças:</span> ${changes.length ? changes.map(change => `${escapeHtml(change.campo)}${change.anterior?.length ? ` (${escapeHtml(formatValue(change.anterior))} → ` : " ("}${escapeHtml(formatValue(change.atual))})`).join(" · ") : "sem alterações nos campos acompanhados"}</div>
          <label class="mt-3 block text-[10px] text-slate-400">Próxima ação ou o que já foi feito<textarea data-ticket-timeline-annotation ${app.atributosVersaoAnotacao(event)} data-event-id="${escapeHtml(event.snapshot_id || "")}" data-annotation-id="${escapeHtml(event.item_id || "")}" rows="2" maxlength="2000" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-2 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none" placeholder="Ex.: cobrar atualização do parceiro, OS concluída...">${escapeHtml(event.anotacao || "")}</textarea><span class="mt-1 block text-[10px] text-slate-500" data-annotation-status aria-live="polite">${event.anotacao ? "Anotação salva" : ""}</span><button type="button" class="mt-1 rounded-md border border-rose-400/40 px-2 py-1 text-[10px] text-rose-200 hover:bg-rose-500/10" data-annotation-retry hidden aria-label="Tentar novamente a sincronização desta anotação">Tentar sincronizar novamente</button></label>
        </article>`;
    }).join("")}</div>`;
  }

  function conectarAnotacoesLinhaDoTempo(root) {
    root.querySelectorAll("[data-ticket-timeline-annotation]").forEach(textarea => {
      const eventId = textarea.dataset.eventId;
      const itemId = textarea.dataset.annotationId;
      const status = textarea.parentElement.querySelector("[data-annotation-status]");
      const retryButton = textarea.parentElement.querySelector("[data-annotation-retry]");
      window.HistoryAnnotationAutosave.attachAnnotationAutosave({
        textarea,
        status,
        retryButton,
        eventId,
        itemId,
        send: ({ eventId: targetEventId, itemId: targetItemId, annotation, revisionId, baseRevisions, resolveConflict }) => fetch(
          `/api/operacoes/chamados/linha-do-tempo/${encodeURIComponent(targetEventId)}/${encodeURIComponent(targetItemId)}`,
          { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anotacao: annotation, revisao_id: revisionId, base_revisoes: baseRevisions, resolver_conflito: resolveConflict }) }
        ),
      });
    });
  }

  async function carregarLinhaDoTempoChamado(details) {
    if (!details?.open || details.dataset.ticketTimelineLoaded === "true" || ticketTimelineRequests.has(details)) return;
    const serial = details.dataset.timelineSerial || "";
    const snapshotId = details.dataset.snapshotId || appState.acompanhamentoChamadosAtual?.snapshot_id || "";
    const body = details.querySelector("[data-ticket-timeline-body]");
    if (!body) return;
    const gate = transferUtils.createRequestGate();
    const request = gate.begin();
    ticketTimelineRequests.set(details, gate);
    const isCurrent = () => ticketTimelineRequests.get(details) === gate && details.isConnected !== false;
    body.innerHTML = '<p class="py-3 text-xs text-slate-400" role="status">Carregando histórico da série…</p>';
    try {
      const params = new URLSearchParams({ snapshot_id: snapshotId });
      const response = await fetch(`/api/operacoes/chamados/linha-do-tempo/${encodeURIComponent(serial)}?${params.toString()}`, { signal: request.signal });
      const data = await response.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(data.detail || "Não foi possível carregar a linha do tempo.");
      body.innerHTML = app.renderizarLinhaDoTempoChamado(data.eventos);
      app.conectarAnotacoesLinhaDoTempo(body);
      details.dataset.ticketTimelineLoaded = "true";
    } catch (error) {
      if (!isCurrent()) return;
      body.innerHTML = `<p class="py-3 text-xs text-rose-300" role="alert">${escapeHtml(error.message || "Não foi possível carregar a linha do tempo.")}</p>`;
    } finally {
      if (ticketTimelineRequests.get(details) === gate) ticketTimelineRequests.delete(details);
    }
  }

  function capturarExpansoesCartoesChamados(list) {
    const expandedSections = new Set();
    list.querySelectorAll?.('article[data-ticket-serial]').forEach(card => {
      const serial = card.dataset.ticketSerial || "";
      card.querySelectorAll('details[data-ticket-section]').forEach(section => {
        if (section.open) expandedSections.add(JSON.stringify([serial, section.dataset.ticketSection || ""]));
      });
    });
    return expandedSections;
  }

  function renderizarAcompanhamentoChamados() {
    cancelarLeiturasLinhasDoTempoChamados();
    const data = appState.acompanhamentoChamadosAtual || {};
    const list = document.getElementById("lista-acompanhamento-chamados");
    const expandedSections = capturarExpansoesCartoesChamados(list);
    const managementPanel = document.getElementById("painel-dados-acompanhamento-chamados");
    const hasTickets = Array.isArray(data.chamados) && data.chamados.length > 0;
    if (!hasTickets) managementPanel.open = true;
    const currentVersion = document.getElementById("versao-atual-acompanhamento-chamados");
    currentVersion.textContent = data.atualizado_em
      ? `Atualizado ${formatarHorarioHistorico(data.atualizado_em)}`
      : hasTickets ? "Versão selecionada" : "Nenhuma importação";
    renderizarResumoChamados(data);

    const records = filtrarChamados(data.chamados);
    document.getElementById("contagem-acompanhamento-chamados").textContent = `Exibindo ${records.length} de ${Array.isArray(data.chamados) ? data.chamados.length : 0} séries · OS da maior para a menor, sem OS no final`;
    renderizarTriagemChamados(records);
    const exportButton = document.getElementById("btn-exportar-acompanhamento-chamados");
    const selectedSnapshotId = document.getElementById("versao-acompanhamento-chamados").value;
    exportButton.disabled = !selectedSnapshotId || data.snapshot_id !== selectedSnapshotId
      || !Array.isArray(data.chamados) || data.chamados.length === 0;
    if (!Array.isArray(data.chamados) || data.chamados.length === 0) {
      list.innerHTML = data.atualizado_em
        ? '<p class="py-8 text-center text-sm text-slate-400" role="status">Importação concluída. Nenhum chamado encontrado nas planilhas.</p>'
        : '<p class="py-8 text-center text-sm text-slate-400" role="status">Importe as duas planilhas para relacionar as séries com as OS.</p>';
      return;
    }
    if (records.length === 0) {
      list.innerHTML = '<p class="py-8 text-center text-sm text-slate-400" role="status">Nenhum chamado corresponde à busca.</p>';
      return;
    }

    // Cascade only when cards replace a message; re-filtering while typing must not replay it.
    const primeiraRenderizacao = !list.querySelector?.("article[data-ticket-serial]");
    list.innerHTML = records.map(record => renderizarCartaoChamado(record, data.snapshot_id, expandedSections)).join("");
    if (primeiraRenderizacao) motion?.stagger(list.children);
    list.querySelectorAll?.('details[data-ticket-section="timeline"], details[data-ticket-section="stages"]').forEach(section => {
      const card = section.closest("article[data-ticket-serial]");
      if (card && expandedSections.has(chaveSecaoCartao(card.dataset.ticketSerial || "", section.dataset.ticketSection))) section.open = true;
    });
  }

  function renderizarResumoChamados(data) {
    const summary = data.resumo || {};
    const sources = data.fontes || {};
    const summaryTarget = document.getElementById("resumo-acompanhamento-chamados");
    const summaryCards = [
      ["Séries", summary.series_total],
      ["OS conferidas", summary.conferidas],
      ["OS divergentes", summary.divergentes],
      ["Só na Simpress", summary.somente_simpress],
      ["Só no Oracle", summary.somente_oracle],
      ["Sem OS", summary.sem_os],
    ];
    summaryTarget.innerHTML = `<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">${summaryCards.map(([label, count]) => `<div class="rounded-md border border-slate-800 bg-slate-900/70 px-2.5 py-1.5"><p class="text-[9px] text-slate-400">${label}</p><p class="mt-0.5 text-sm font-semibold text-white">${Number(count) || 0}</p></div>`).join("")}</div>
        <p class="mt-2 break-words text-[10px] text-slate-500">Simpress: ${escapeHtml(sources.simpress?.arquivo || "aguardando importação")} · Oracle: ${escapeHtml(sources.oracle?.arquivo || "aguardando importação")}</p>`;
  }

  // Search and the attention filter, ordered by service order (highest first, without one last).
  function filtrarChamados(chamados) {
    const filters = obterFiltrosChamados();
    const query = normalizarFiltroChamados(filters.search);
    const records = (Array.isArray(chamados) ? chamados : []).filter(record => {
      const attention = classificarAtencaoChamado(record);
      if (filters.attention_only && !attention.em_atencao) return false;
      const searchable = normalizarFiltroChamados(valoresChamado(record).join(" "));
      return !query || searchable.includes(query);
    });
    records.sort(compararChamadosPorOrdemServicoDecrescente);
    return records;
  }

  function renderizarTriagemChamados(records) {
    const triageTarget = document.getElementById("triagem-diaria-acompanhamento-chamados");
    const activeRecords = records.filter(record => (Array.isArray(record.oracle) ? record.oracle : []).some(ticket => !idadeAtualizacaoChamado(ticket).encerrado));
    const attentionRecords = activeRecords.filter(record => classificarAtencaoChamado(record).em_atencao);
    const missingDateRecords = activeRecords.filter(record => classificarAtencaoChamado(record).dias_sem_atualizacao === null);
    const freshRecords = activeRecords.length - attentionRecords.length;
    const triageCards = [
      ["Chamados ativos", activeRecords.length, "text-white"],
      ["Sem atualização há 3+ dias", attentionRecords.length - missingDateRecords.length, "text-amber-200"],
      ["Sem data de atualização", missingDateRecords.length, "text-rose-200"],
      ["Atualizados há menos de 3 dias", freshRecords, "text-emerald-200"],
    ];
    triageTarget.innerHTML = `<div class="ticket-triage rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5"><div class="mb-1.5 flex flex-wrap items-baseline justify-between gap-2"><h4 class="text-[11px] font-semibold text-slate-200">Triagem diária</h4><p class="text-[10px] text-slate-500">Atenção: 3+ dias ou sem data.</p></div><div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4">${triageCards.map(([label, count, color]) => {
      const shortLabel = label === "Chamados ativos" ? "Ativos" : label === "Sem atualização há 3+ dias" ? "3+ dias" : label === "Sem data de atualização" ? "Sem data" : "Atualizados <3 dias";
      return `<div class="rounded-md border border-slate-800 bg-slate-900/70 px-2 py-1" aria-label="${escapeHtml(label)}"><p class="text-[9px] text-slate-400">${shortLabel}</p><p class="text-sm font-semibold ${color}">${count}</p></div>`;
    }).join("")}</div></div>`;
  }

  function renderizarCartaoChamado(record, snapshotId, expandedSections) {
    const [relationLabel, relationClass] = RELACOES_CHAMADO[record.relacao] || RELACOES_CHAMADO.sem_os;
    const attention = classificarAtencaoChamado(record);
    const simpress = record.simpress || {};
    const ordensVenda = Array.isArray(simpress.ordens_venda) ? simpress.ordens_venda : [];
    const ordensSimpress = Array.isArray(simpress.ordens_servico) ? simpress.ordens_servico : [];
    const currentSimpressOrder = [...ordensSimpress].filter(Boolean).sort(compararOrdensServicoDecrescente)[0] || "";
    const chamadosCliente = chamadosClienteInformados(simpress.chamados_cliente);
    const enderecosEntrega = Array.isArray(simpress.enderecos_entrega) ? simpress.enderecos_entrega : [];
    const mostrarEnderecoEntrega = simpress.pedido_em_andamento && enderecosEntrega.some(Boolean);
    const oracle = Array.isArray(record.oracle) ? record.oracle : [];
    const orderedOracle = [...oracle].sort((left, right) => compararOrdensServicoDecrescente(left.ordem_servico, right.ordem_servico));
    const currentOracle = orderedOracle[0] || {};
    const hasActiveOracle = orderedOracle.some(ticket => !idadeAtualizacaoChamado(ticket).encerrado);
    const updateAgeSummary = hasActiveOracle
      ? attention.ultima_atualizacao
        ? idadeAtualizacaoChamado({ ultima_atualizacao: attention.ultima_atualizacao }).rotulo
        : "Sem data de atualização"
      : currentOracle.ordem_servico ? "Chamado encerrado" : "Sem registro Oracle";
    const oracleRows = orderedOracle.length
      ? orderedOracle.map(ticket => renderizarSolicitacaoOracle(ticket)).join("")
      : '<p class="text-xs text-slate-500">Sem registro correspondente no Oracle.</p>';
    const attentionClass = attention.em_atencao ? "border-amber-400/20 bg-amber-500/5 text-amber-200" : "border-slate-700 bg-slate-900 text-slate-400";
    const attentionLabel = attention.em_atencao ? attention.motivo : hasActiveOracle ? "Em dia" : currentOracle.ordem_servico ? "Encerrado" : "Em acompanhamento";
    const cityLabels = cidadesDoChamado(record);
    const providerLabels = atendimentosDoChamado(record).filter(provider => provider !== "Não informado");
    const oracleStatus = [currentOracle.status, currentOracle.sub_status].filter(Boolean).join(" · ") || "Não informado";
    const openDetails = expandedSections.has(chaveSecaoCartao(record.serie, "details")) ? " open" : "";
    // Empty fields stay out of the card; the relation badge already says which source is missing.
    const temValor = values => Array.isArray(values) && values.some(Boolean);
    const identificador = (label, value, classes) => `<div class="ticket-card-identifier border ${classes}"><span>${label}</span>${value ? `<strong>${value}</strong>` : '<strong class="is-empty">Sem OS</strong>'}</div>`;
    const metaPedido = [
      temValor(simpress.pedidos) ? `<span><b>Pedido</b> ${formatarListaChamados(simpress.pedidos)}</span>` : "",
      temValor(ordensVenda) ? `<span>${formatarListaChamados(ordensVenda)}</span>` : "",
    ].join("");
    const statusLinhas = [
      temValor(simpress.status) ? `<p class="truncate text-xs text-cyan-100" title="Status Simpress: ${formatarListaChamados(simpress.status)}"><b>Simpress</b> · ${formatarListaChamados(simpress.status)}</p>` : "",
      orderedOracle.length ? `<p class="truncate text-xs text-violet-100" title="Status Oracle: ${escapeHtml(oracleStatus)}"><b>Oracle</b> · ${escapeHtml(oracleStatus)}</p>` : "",
    ].join("");
    const triagem = [
      currentOracle.fila ? `<span>Fila: ${escapeHtml(currentOracle.fila)}</span>` : "",
      cityLabels.length ? `<span>Cidade: ${escapeHtml(cityLabels.join(", "))}</span>` : "",
      providerLabels.length ? `<span>Atendimento: ${escapeHtml(providerLabels.join(", "))}</span>` : "",
    ].join("");
    const detalhesSimpress = [
      temValor(ordensSimpress) ? `<p class="mt-1 text-xs text-slate-300">OS na planilha: ${formatarOrdensServico(ordensSimpress)}</p>` : "",
      chamadosCliente.some(Boolean) ? `<p class="mt-1 text-xs text-slate-300">Chamado do cliente: ${formatarListaChamados(chamadosCliente)}</p>` : "",
      temValor(simpress.descricoes_produto) ? `<p class="mt-1 break-words text-xs text-slate-300">Descrição do produto: ${formatarListaChamados(simpress.descricoes_produto)}</p>` : "",
      temValor(simpress.cidades_entrega) ? `<p class="mt-1 text-xs text-slate-300">Cidade de entrega: ${formatarListaChamados(simpress.cidades_entrega)}</p>` : "",
      mostrarEnderecoEntrega ? `<p class="mt-1 break-words text-xs text-slate-300">Endereço de entrega: ${formatarListaChamados(enderecosEntrega)}</p>` : "",
    ].join("") || '<p class="mt-1 text-xs text-slate-500">Sem registro correspondente na Simpress.</p>';
    return `<article class="ticket-card rounded-xl border border-slate-800 bg-slate-950/70 p-3 sm:p-3.5" data-ticket-serial="${escapeHtml(record.serie)}">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <h4 class="min-w-0 break-all font-mono text-sm font-semibold text-white">${escapeHtml(record.serie)}</h4>
            <div class="flex flex-wrap items-center gap-1.5"><span class="rounded-full border px-2 py-1 text-[10px] font-semibold ${relationClass}">${relationLabel}</span><span class="rounded-full border px-2 py-1 text-[10px] ${attentionClass}" title="${escapeHtml(updateAgeSummary)}">${escapeHtml(attentionLabel)}</span></div>
          </div>
          <div class="ticket-card-identifiers mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            ${identificador("OS Simpress", currentSimpressOrder ? formatarOrdensServico([currentSimpressOrder]) : "", "border-cyan-400/20 bg-cyan-500/5")}
            ${identificador("OS Oracle", currentOracle.ordem_servico ? escapeHtml(currentOracle.ordem_servico) : "", "border-violet-400/20 bg-violet-500/5")}
          </div>
          ${renderizarResumoProcessoPedido(simpress)}
          ${metaPedido ? `<div class="ticket-card-meta mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-300">${metaPedido}</div>` : ""}
          ${statusLinhas ? `<div class="ticket-card-status mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">${statusLinhas}</div>` : ""}
          ${triagem ? `<div class="ticket-card-triage mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400">${triagem}</div>` : ""}
          <details class="ticket-disclosure mt-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-1.5" data-ticket-section="details"${openDetails}>
            <summary class="ticket-disclosure-summary cursor-pointer text-xs font-semibold text-slate-200">Detalhes do chamado</summary>
            <div class="ticket-detail-grid grid grid-cols-1 gap-2 pt-2 lg:grid-cols-2">
              <section class="rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
                <h5 class="text-[10px] font-semibold uppercase tracking-wide text-cyan-200">Simpress</h5>
                ${detalhesSimpress}
              </section>
              <section class="space-y-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
                <h5 class="text-[10px] font-semibold uppercase tracking-wide text-violet-200">Oracle · solicitações e OS</h5>${oracleRows}
              </section>
            </div>
          </details>
          <details class="ticket-disclosure mt-2 rounded-lg border border-cyan-400/20 bg-slate-900/50 px-3 py-1.5" data-ticket-section="timeline" data-ticket-timeline data-timeline-serial="${escapeHtml(record.serie)}" data-snapshot-id="${escapeHtml(snapshotId || "")}" data-on-toggle="carregarLinhaDoTempoChamado" data-args='["$this"]'><summary class="ticket-disclosure-summary cursor-pointer text-xs font-semibold text-cyan-100">Linha do tempo e anotações</summary><div data-ticket-timeline-body><p class="py-2 text-[10px] text-slate-500">Abra para ver as mudanças desta série em cada importação e registrar a próxima ação.</p></div></details>
        </article>`;
  }

  function renderizarSolicitacaoOracle(ticket) {
    const updateAge = idadeAtualizacaoChamado(ticket);
    const ageClass = updateAge.encerrado ? "text-slate-500" : updateAge.dias === null || updateAge.dias >= 3 ? "text-amber-200" : "text-emerald-200";
    const oracleAddress = [ticket.logradouro, ticket.numero_endereco, ticket.bairro, ticket.cidade]
      .map(value => String(value || "").trim())
      .filter(Boolean)
      .join(", ");
    // Only filled fields are listed, joined with " · ".
    const linha = (color, fields) => {
      const parts = fields.filter(([, value]) => String(value || "").trim())
        .map(([label, value]) => label === "Atualizado" ? `Atualizado ${escapeHtml(value)}` : `${label}: ${escapeHtml(value)}`);
      return parts.length ? `<p class="mt-1 text-[10px] ${color}">${parts.join(" · ")}</p>` : "";
    };
    return `<div class="rounded-lg border border-slate-800 bg-slate-900/80 p-2.5">
          <div class="flex flex-wrap items-center justify-between gap-2"><p class="text-xs font-semibold text-white">Solicitação Oracle ${escapeHtml(ticket.solicitacao || "Não informada")}</p><span class="inline-flex items-center gap-2 rounded-md border border-violet-400/30 bg-violet-500/10 px-2.5 py-1.5"><span class="text-[10px] font-semibold uppercase tracking-wide text-violet-200">OS Oracle</span><span class="font-mono text-lg font-bold leading-none text-violet-100">${escapeHtml(ticket.ordem_servico || "Não informada")}</span></span></div>
          <p class="mt-1 text-xs text-slate-300">${escapeHtml(ticket.status || "Status não informado")}${ticket.sub_status ? ` · ${escapeHtml(ticket.sub_status)}` : ""}</p>
          ${linha("text-slate-400", [["Fila", ticket.fila], ["Fase", ticket.fase_atendimento]])}
          ${oracleAddress ? `<p class="mt-1 break-words text-[10px] text-slate-400">Endereço: ${escapeHtml(oracleAddress)}</p>` : ""}
          ${linha("text-slate-400", [["Atendido pela inibição", ticket.atendido_pela_inibicao]])}
          ${linha("text-slate-400", [["Atendimento por", ticket.nome_filial]])}
          ${linha("text-slate-500", [["Entregas", ticket.status_entregas], ["Atividades", ticket.status_atividades], ["Atualizado", ticket.ultima_atualizacao && formatarHorarioHistorico(ticket.ultima_atualizacao)]])}
          <p class="mt-1 text-[10px] font-medium ${ageClass}">${escapeHtml(updateAge.rotulo)}</p>
          ${String(ticket.descricao || "").trim() ? `<details class="ticket-oracle-description"><summary><span class="shrink-0 font-semibold text-violet-200">Descrição do chamado</span><span class="ticket-oracle-description-preview">${escapeHtml(resumirDescricaoChamado(ticket.descricao))}</span><span class="ticket-oracle-description-toggle ticket-oracle-description-expand">⌄ Expandir</span><span class="ticket-oracle-description-toggle ticket-oracle-description-collapse">⌃ Recolher</span></summary><div class="ticket-oracle-description-content">${escapeHtml(String(ticket.descricao).trim())}</div></details>` : ""}
        </div>`;
  }

  function limparFiltrosAcompanhamentoChamados() {
    document.getElementById("filtro-acompanhamento-chamados").value = "";
    document.getElementById("somente-atencao-chamados").checked = false;
    app.renderizarAcompanhamentoChamados();
  }

  async function selecionarVersaoChamados() {
    const snapshotId = document.getElementById("versao-acompanhamento-chamados").value;
    const request = ticketSnapshotRequestGate.begin();
    ticketEvolutionRequestGate.invalidate();
    cancelarLeiturasLinhasDoTempoChamados();
    const exportButton = document.getElementById("btn-exportar-acompanhamento-chamados");
    const evolutionTarget = document.getElementById("evolucao-acompanhamento-chamados");
    exportButton.disabled = true;
    if (!snapshotId) {
      appState.acompanhamentoChamadosAtual = null;
      app.renderizarAcompanhamentoChamados();
      evolutionTarget.textContent = "Nenhuma importação selecionada.";
      return;
    }
    evolutionTarget.textContent = "Carregando comparação desta versão…";
    const target = document.getElementById("lista-acompanhamento-chamados");
    target.innerHTML = '<p class="py-8 text-center text-sm text-slate-400" role="status">Carregando versão selecionada…</p>';
    try {
      const response = await fetch(`/api/operacoes/chamados/snapshot/${encodeURIComponent(snapshotId)}`, { signal: request.signal });
      const data = await response.json().catch(() => ({}));
      if (!ticketSnapshotRequestGate.isCurrent(request.id)) return;
      if (!response.ok) throw new Error(data.detail || "Não foi possível abrir esta versão.");
      data.snapshot_id = snapshotId;
      appState.acompanhamentoChamadosAtual = data;
      app.renderizarAcompanhamentoChamados();
      await app.carregarEvolucaoChamados(snapshotId);
    } catch (error) {
      if (!ticketSnapshotRequestGate.isCurrent(request.id)) return;
      const message = error.message || "Não foi possível abrir esta versão.";
      target.innerHTML = `<p class="py-8 text-center text-sm text-rose-300" role="alert">${escapeHtml(message)}</p>`;
      evolutionTarget.textContent = message;
    }
  }

  async function excluirImportacoesAntigasChamados() {
    const button = document.getElementById("btn-excluir-importacoes-antigas-chamados");
    const olderCount = Math.max(0, appState.historicoAcompanhamentoChamados.length - 1);
    const olderLabel = olderCount === 1 ? "1 importação antiga" : `${olderCount} importações antigas`;
    if (!olderCount || !(await app.confirmarAcao({
      titulo: "Excluir importações antigas?",
      mensagem: `Excluir ${olderLabel} e manter somente a mais recente? Esta ação não poderá ser desfeita.`,
      confirmar: "Excluir",
    }))) return;

    button.disabled = true;
    button.textContent = "Excluindo…";
    try {
      const response = await fetch("/api/operacoes/chamados/historico/antigas", { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Não foi possível excluir as importações antigas.");
      await app.carregarAcompanhamentoChamados();
      const removedCount = Number(data.removidas) || 0;
      const removedLabel = removedCount === 1 ? "1 importação antiga removida" : `${removedCount} importações antigas removidas`;
      app.showToast(`${removedLabel}. A importação mais recente foi mantida.`, "success");
    } catch (error) {
      app.showToast(error.message || "Não foi possível excluir as importações antigas.", "error");
    } finally {
      button.textContent = "Excluir importações antigas";
      button.disabled = appState.historicoAcompanhamentoChamados.length <= 1;
    }
  }

  async function exportarAcompanhamentoChamados() {
    const button = document.getElementById("btn-exportar-acompanhamento-chamados");
    const selectedSnapshotId = document.getElementById("versao-acompanhamento-chamados").value;
    const loadedSnapshotId = appState.acompanhamentoChamadosAtual?.snapshot_id || "";
    if (!selectedSnapshotId || selectedSnapshotId !== loadedSnapshotId
      || !Array.isArray(appState.acompanhamentoChamadosAtual?.chamados) || appState.acompanhamentoChamadosAtual.chamados.length === 0) {
      app.showToast("Selecione e aguarde o carregamento de uma versão válida antes de exportar.", "error");
      return;
    }
    const originalText = button.textContent;
    const params = new URLSearchParams({ snapshot_id: selectedSnapshotId });
    Object.entries(obterFiltrosChamados()).forEach(([key, value]) => {
      if (value !== "" && value !== false) params.set(key, String(value));
    });
    button.disabled = true;
    button.textContent = "Preparando Excel…";
    try {
      const response = await fetch(`/api/operacoes/chamados/exportar?${params.toString()}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || "Não foi possível exportar os chamados filtrados.");
      }
      const disposition = response.headers?.get("Content-Disposition") || "";
      const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      const filename = match?.[1]?.replace(/["']/g, "") || "Acompanhamento_de_Chamados.xlsx";
      const url = window.URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      app.showToast("Excel dos chamados filtrados exportado.", "success");
    } catch (error) {
      app.showToast(error.message || "Não foi possível exportar os chamados filtrados.", "error");
    } finally {
      button.textContent = originalText;
      app.renderizarAcompanhamentoChamados();
    }
  }

  async function carregarAcompanhamentoChamados() {
    const request = ticketSnapshotRequestGate.begin();
    ticketEvolutionRequestGate.invalidate();
    cancelarLeiturasLinhasDoTempoChamados();
    const list = document.getElementById("lista-acompanhamento-chamados");
    list.innerHTML = '<p class="py-8 text-center text-sm text-slate-400" role="status">Carregando acompanhamento…</p>';
    try {
      const response = await fetch("/api/operacoes/chamados", { signal: request.signal });
      const data = await response.json().catch(() => ({}));
      if (!ticketSnapshotRequestGate.isCurrent(request.id)) return;
      if (!response.ok) throw new Error(data.detail || "Não foi possível carregar o acompanhamento de chamados.");
      appState.acompanhamentoChamadosAtual = data;
      app.renderizarHistoricoAcompanhamentoChamados(data);
      app.renderizarAcompanhamentoChamados();
      await app.carregarEvolucaoChamados(data.snapshot_id || "");
    } catch (error) {
      if (!ticketSnapshotRequestGate.isCurrent(request.id)) return;
      document.getElementById("painel-dados-acompanhamento-chamados").open = true;
      list.innerHTML = `<p class="py-8 text-center text-sm text-rose-300" role="alert">${escapeHtml(error.message || "Não foi possível carregar o acompanhamento de chamados.")}</p>`;
    }
  }

  async function importarPlanilhasChamados(event) {
    event.preventDefault();
    const form = document.getElementById("form-importar-acompanhamento-chamados");
    const simpressInput = document.getElementById("arquivo-chamados-simpress");
    const oracleInput = document.getElementById("arquivo-chamados-oracle");
    const button = document.getElementById("btn-importar-acompanhamento-chamados");
    const status = document.getElementById("status-importacao-chamados");
    if (!simpressInput.files?.[0] || !oracleInput.files?.[0]) {
      status.textContent = "Selecione as duas planilhas para importar.";
      return;
    }
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Importando…";
    form.setAttribute("aria-busy", "true");
    status.textContent = "Lendo as planilhas e relacionando as séries…";
    try {
      const payload = new FormData();
      payload.append("simpress_file", simpressInput.files[0]);
      payload.append("oracle_file", oracleInput.files[0]);
      const response = await fetch("/api/operacoes/chamados/importar", { method: "POST", body: payload });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Não foi possível importar as planilhas.");
      ticketSnapshotRequestGate.invalidate();
      ticketEvolutionRequestGate.invalidate();
      appState.acompanhamentoChamadosAtual = data;
      app.renderizarHistoricoAcompanhamentoChamados(data);
      simpressInput.value = "";
      document.getElementById("nome-arquivo-chamados-simpress").textContent = "Nenhum arquivo selecionado";
      oracleInput.value = "";
      document.getElementById("nome-arquivo-chamados-oracle").textContent = "Nenhum arquivo selecionado";
      status.textContent = "Planilhas importadas. As OS foram relacionadas pela série.";
      document.getElementById("painel-dados-acompanhamento-chamados").open = false;
      app.renderizarAcompanhamentoChamados();
      await app.carregarEvolucaoChamados(data.snapshot_id || "");
      await app.carregarProntidao();
      app.showToast("Acompanhamento de chamados atualizado.", "success");
    } catch (error) {
      status.textContent = error.message || "Não foi possível importar as planilhas.";
    } finally {
      button.disabled = false;
      button.textContent = originalText;
      form.removeAttribute("aria-busy");
    }
  }

  function abrirAcompanhamentoChamados(importar = false) {
    app.abrirModalAcessivel("modal-acompanhamento-chamados", importar ? '#arquivo-chamados-simpress' : '[aria-label="Fechar acompanhamento de chamados"]', "fecharAcompanhamentoChamados", "btn-acompanhamento-chamados");
    const form = document.getElementById("form-importar-acompanhamento-chamados");
    if (!form.dataset.bound) {
      form.addEventListener("submit", app.importarPlanilhasChamados);
      const simpressInput = document.getElementById("arquivo-chamados-simpress");
      const simpressFilename = document.getElementById("nome-arquivo-chamados-simpress");
      const oracleInput = document.getElementById("arquivo-chamados-oracle");
      const oracleFilename = document.getElementById("nome-arquivo-chamados-oracle");
      document.getElementById("btn-escolher-arquivo-chamados-simpress").addEventListener("click", () => simpressInput.click());
      simpressInput.addEventListener("change", () => {
        simpressFilename.textContent = simpressInput.files?.[0]?.name || "Nenhum arquivo selecionado";
      });
      document.getElementById("btn-escolher-arquivo-chamados-oracle").addEventListener("click", () => oracleInput.click());
      oracleInput.addEventListener("change", () => {
        oracleFilename.textContent = oracleInput.files?.[0]?.name || "Nenhum arquivo selecionado";
      });
      ["filtro-acompanhamento-chamados", "somente-atencao-chamados"].forEach(id => {
        const control = document.getElementById(id);
        control.addEventListener(id === "filtro-acompanhamento-chamados" ? "input" : "change", app.renderizarAcompanhamentoChamados);
      });
      form.dataset.bound = "true";
    }
    app.carregarAcompanhamentoChamados();
  }

  return {
    fecharAcompanhamentoChamados, renderizarHistoricoAcompanhamentoChamados, renderizarEvolucaoChamados,
    carregarEvolucaoChamados, renderizarLinhaDoTempoChamado, conectarAnotacoesLinhaDoTempo,
    carregarLinhaDoTempoChamado, renderizarAcompanhamentoChamados, limparFiltrosAcompanhamentoChamados,
    selecionarVersaoChamados, excluirImportacoesAntigasChamados, exportarAcompanhamentoChamados,
    carregarAcompanhamentoChamados, importarPlanilhasChamados, abrirAcompanhamentoChamados,
  };
});
