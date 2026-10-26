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
    conferida: ["OS conferida", "chip-success"],
    divergente: ["OS divergente", "chip-warning"],
    sem_os: ["OS ausente", "chip-neutral"],
    somente_simpress: ["Sem registro no Oracle", "chip-info"],
    somente_oracle: ["Sem pedido Simpress", "chip-oracle"],
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
    target.innerHTML = `<p class="font-semibold text-white">Comparação com a versão anterior · ${Number(counts.novos) || 0} novas · ${Number(counts.alterados) || 0} alteradas · ${Number(counts.iguais) || 0} sem mudança · ${Number(counts.ausentes_arquivo) || 0} ausentes</p><p class="mt-1 text-xs text-amber-200">${escapeHtml(data.aviso_ausentes || "Ausência na planilha não confirma resolução.")}</p>${details.length ? `<ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-fg-tertiary">${details.join("")}</ul>` : ""}`;
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
      const data = await app.apiFetch(`/api/operacoes/chamados/evolucao?${query.toString()}`, { signal: request.signal, errorMessage: "Não foi possível comparar as versões dos chamados." });
      if (!ticketEvolutionRequestGate.isCurrent(request.id)) return;
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
    if (!Array.isArray(events) || !events.length) return '<p class="py-3 text-xs text-fg-subtle">Não há versões anteriores para esta série.</p>';
    return `<div class="space-y-2 py-2">${events.map(event => {
      const state = event.estado || {};
      const values = fields.map(([key, label]) => [label, formatValue(state[key])]).filter(([, value]) => value);
      const changes = Array.isArray(event.mudancas) ? event.mudancas : [];
      return `<article class="rounded-lg border border-line-quiet bg-surface/70 p-3" data-ticket-timeline-event="${escapeHtml(event.item_id || "")}">
          <div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-xs text-white">${escapeHtml(event.tipo || "Atualização")}</strong><time class="text-xs text-fg-subtle">${escapeHtml(formatarHorarioHistorico(event.atualizado_em))}</time></div>
          <dl class="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">${values.map(([label, value]) => `<div class="min-w-0 text-xs"><dt class="inline font-semibold text-fg-subtle">${label}: </dt><dd class="inline break-words text-fg-secondary">${escapeHtml(value)}</dd></div>`).join("")}</dl>
          <div class="mt-2 text-xs text-fg-tertiary"><span class="font-semibold text-cyan-200">Mudanças:</span> ${changes.length ? changes.map(change => `${escapeHtml(change.campo)}${change.anterior?.length ? ` (${escapeHtml(formatValue(change.anterior))} → ` : " ("}${escapeHtml(formatValue(change.atual))})`).join(" · ") : "sem alterações nos campos acompanhados"}</div>
          <label class="mt-3 block text-xs text-fg-subtle">Próxima ação ou o que já foi feito<textarea data-ticket-timeline-annotation ${app.atributosVersaoAnotacao(event)} data-event-id="${escapeHtml(event.snapshot_id || "")}" data-annotation-id="${escapeHtml(event.item_id || "")}" rows="2" maxlength="2000" class="mt-1 w-full rounded-lg border border-line-control bg-surface-overlay px-2.5 py-2 text-xs text-white placeholder:text-fg-weak focus:border-cyan-400 focus:outline-none" placeholder="Ex.: cobrar atualização do parceiro, OS concluída...">${escapeHtml(event.anotacao || "")}</textarea><span class="mt-1 block text-xs text-fg-muted" data-annotation-status aria-live="polite">${event.anotacao ? "Anotação salva" : ""}</span><button type="button" class="mt-1 rounded-md border border-rose-400/40 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/10" data-annotation-retry hidden aria-label="Tentar novamente a sincronização desta anotação">Tentar sincronizar novamente</button></label>
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
    body.innerHTML = '<p class="py-3 text-xs text-fg-subtle" role="status">Carregando histórico da série…</p>';
    try {
      const params = new URLSearchParams({ snapshot_id: snapshotId });
      const data = await app.apiFetch(`/api/operacoes/chamados/linha-do-tempo/${encodeURIComponent(serial)}?${params.toString()}`, { signal: request.signal, errorMessage: "Não foi possível carregar a linha do tempo." });
      if (!isCurrent()) return;
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
    const EventConstructor = document.defaultView?.CustomEvent;
    if (EventConstructor) {
      document.dispatchEvent(new EventConstructor("simpress:chamados-atualizados", {
        detail: { snapshot_id: data.snapshot_id || "" },
      }));
    }

    const records = filtrarChamados(data.chamados);
    const selectedOrder = appState.filtroChamadoSelecionado;
    const selectedSources = fontesDoFiltroOs(selectedOrder);
    const sourceDescription = selectedSources.map(source => source === "simpress" ? "Simpress" : "Oracle").join(" + ");
    const countDescription = selectedOrder ? " · Filtro: " + sourceDescription + " · OS " + selectedOrder.os : "";
    document.getElementById("contagem-acompanhamento-chamados").textContent = `${records.length} de ${Array.isArray(data.chamados) ? data.chamados.length : 0} séries${countDescription}`;
    renderizarTriagemChamados(data.chamados);
    const exportButton = document.getElementById("btn-exportar-acompanhamento-chamados");
    const selectedSnapshotId = document.getElementById("versao-acompanhamento-chamados").value;
    exportButton.disabled = !selectedSnapshotId || data.snapshot_id !== selectedSnapshotId
      || !Array.isArray(data.chamados) || data.chamados.length === 0;
    if (!Array.isArray(data.chamados) || data.chamados.length === 0) {
      list.innerHTML = '<p class="py-8 text-center text-sm text-fg-subtle" role="status">Nenhum chamado para exibir.</p>';
      return;
    }
    if (records.length === 0) {
      list.innerHTML = '<p class="py-8 text-center text-sm text-fg-subtle" role="status">Nenhum chamado corresponde aos filtros.</p>';
      return;
    }

    // Cascade only when cards replace a message; re-filtering while typing must not replay it.
    const primeiraRenderizacao = !list.querySelector?.("article[data-ticket-serial]");
    list.innerHTML = records.map(record => renderizarCartaoChamado(record, data.snapshot_id, expandedSections)).join("");
    if (primeiraRenderizacao) motion?.stagger(list.children);
    // Logged user under each series, with the Home rule (Endpoint first, then the manual one).
    context.loggedUserMarkers.conectar(list);
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
    summaryTarget.innerHTML = `<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">${summaryCards.map(([label, count]) => `<div class="rounded-md border border-line-quiet bg-surface-overlay/70 px-2.5 py-1.5"><p class="text-xs text-fg-subtle">${label}</p><p class="mt-0.5 text-sm font-semibold text-white">${Number(count) || 0}</p></div>`).join("")}</div>
        <p class="mt-2 break-words text-xs text-fg-muted">Simpress: ${escapeHtml(sources.simpress?.arquivo || "aguardando importação")} · Oracle: ${escapeHtml(sources.oracle?.arquivo || "aguardando importação")}</p>`;
  }

  // Search and the attention filter, ordered by service order (highest first, without one last).
  function filtrarChamados(chamados) {
    const filters = obterFiltrosChamados();
    const query = normalizarFiltroChamados(filters.search);
    const selectedOrder = appState.filtroChamadoSelecionado;
    const records = (Array.isArray(chamados) ? chamados : []).filter(record => {
      if (selectedOrder && !correspondeAoFiltroOsSelecionado(record, selectedOrder)) return false;
      const selectedRecord = selectedOrder
        ? {
          ...record,
          oracle: fontesDoFiltroOs(selectedOrder).includes("oracle")
            ? (Array.isArray(record?.oracle) ? record.oracle : [])
              .filter(ticket => normalizarOrdemServico(ticket?.ordem_servico) === normalizarOrdemServico(selectedOrder.os))
            : [],
        }
        : record;
      const attention = classificarAtencaoChamado(selectedRecord);
      if (filters.attention_only && !attention.em_atencao) return false;
      if (!correspondeTriagemChamado(selectedRecord, appState.filtroTriagemChamados)) return false;
      const searchable = normalizarFiltroChamados(valoresChamado(record).join(" "));
      return !query || searchable.includes(query);
    });
    records.sort(compararChamadosPorOrdemServicoDecrescente);
    return records;
  }

  function normalizarOrdemServico(value) {
    return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
  }

  function fontesDoFiltroOs(selectedOrder) {
    const sources = Array.isArray(selectedOrder?.fontes)
      ? selectedOrder.fontes : selectedOrder?.fonte ? [selectedOrder.fonte] : [];
    return [...new Set(sources.map(source => String(source || "").trim().toLowerCase())
      .filter(source => source === "oracle" || source === "simpress"))];
  }

  function correspondeAoFiltroOsSelecionado(record, selectedOrder) {
    if (normalizarFiltroChamados(record?.serie) !== normalizarFiltroChamados(selectedOrder?.serie)) return false;
    const target = normalizarOrdemServico(selectedOrder.os);
    if (!target) return false;
    const sources = fontesDoFiltroOs(selectedOrder);
    const oracleMatches = sources.includes("oracle")
      && (Array.isArray(record?.oracle) ? record.oracle : [])
        .some(ticket => normalizarOrdemServico(ticket?.ordem_servico) === target);
    const simpressMatches = sources.includes("simpress")
      && (Array.isArray(record?.simpress?.ordens_servico) ? record.simpress.ordens_servico : [])
        .some(order => normalizarOrdemServico(order) === target);
    return oracleMatches || simpressMatches;
  }

  // Daily triage groups: only series with an open Oracle ticket count as active.
  function grupoTriagemChamado(record) {
    const active = (Array.isArray(record.oracle) ? record.oracle : []).some(ticket => !idadeAtualizacaoChamado(ticket).encerrado);
    if (!active) return "";
    const attention = classificarAtencaoChamado(record);
    if (!attention.em_atencao) return "em_dia";
    return attention.dias_sem_atualizacao === null ? "sem_data" : "atrasados";
  }

  function correspondeTriagemChamado(record, filter) {
    if (!filter) return true;
    const group = grupoTriagemChamado(record);
    return filter === "ativos" ? Boolean(group) : group === filter;
  }

  function filtrarTriagemChamados(filter) {
    appState.filtroTriagemChamados = appState.filtroTriagemChamados === filter ? "" : filter;
    app.renderizarAcompanhamentoChamados();
  }

  // Counts come from the whole import so they stay put while the search or a triage filter narrows the list.
  function renderizarTriagemChamados(chamados) {
    const triageTarget = document.getElementById("triagem-diaria-acompanhamento-chamados");
    const allRecords = Array.isArray(chamados) ? chamados : [];
    const counts = { ativos: 0, atrasados: 0, sem_data: 0, em_dia: 0 };
    allRecords.forEach(record => {
      const group = grupoTriagemChamado(record);
      if (!group) return;
      counts.ativos += 1;
      counts[group] += 1;
    });
    const selected = appState.filtroTriagemChamados || "";
    const focused = typeof document.activeElement?.closest === "function"
      ? document.activeElement.closest("[data-ticket-triage-filter]")?.dataset.ticketTriageFilter || ""
      : "";
    const triageCards = [
      ["ativos", "Ativos", "Chamados ativos", "text-white"],
      ["atrasados", "3+ dias", "Sem atualização há 3+ dias", "text-amber-200"],
      ["sem_data", "Sem data", "Sem data de atualização", "text-rose-200"],
      ["em_dia", "Atualizados <3 dias", "Atualizados há menos de 3 dias", "text-emerald-200"],
    ];
    const inactive = allRecords.length - counts.ativos;
    const explanation = `${counts.ativos} ${counts.ativos === 1 ? "ativo" : "ativos"} de ${allRecords.length} ${allRecords.length === 1 ? "série" : "séries"}${inactive ? ` · ${inactive} sem chamado aberto no Oracle` : ""}`;
    triageTarget.innerHTML = `<div class="ticket-triage rounded-lg border border-line-quiet bg-surface/40 px-2 py-1.5"><div class="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3"><h4 class="text-xs font-semibold text-fg-secondary">Triagem diária</h4><p class="text-xs text-fg-subtle" data-ticket-triage-explanation>${escapeHtml(explanation)}</p></div><div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4" role="group" aria-label="Filtrar chamados pela triagem diária">${triageCards.map(([key, shortLabel, label, color]) => {
      const pressed = selected === key;
      return `<button type="button" class="ticket-triage-filter rounded-md border border-line-quiet bg-surface-overlay/70 px-2 py-1 text-left" data-ticket-triage-filter="${key}" data-on-click="filtrarTriagemChamados" data-args='["${key}"]' aria-pressed="${pressed}" aria-label="${escapeHtml(`${label}: ${counts[key]}`)}" title="${escapeHtml(pressed ? "Mostrar todos os chamados" : `Mostrar somente: ${label}`)}"><span class="block text-xs text-fg-subtle">${shortLabel}</span><span class="block text-sm font-semibold ${color}">${counts[key]}</span></button>`;
    }).join("")}</div></div>`;
    const escapeSelector = typeof globalThis.CSS?.escape === "function" ? globalThis.CSS.escape : value => value.replace(/["\\]/g, "\\$&");
    if (focused) triageTarget.querySelector?.(`[data-ticket-triage-filter="${escapeSelector(focused)}"]`)?.focus();
  }

  function renderizarCartaoChamado(record, snapshotId, expandedSections) {
    // Own keys only: an API value like "constructor" must not resolve to an inherited Object function.
    const [relationLabel, relationClass] = Object.hasOwn(RELACOES_CHAMADO, record.relacao) ? RELACOES_CHAMADO[record.relacao] : RELACOES_CHAMADO.sem_os;
    const selectedOrder = appState.filtroChamadoSelecionado
      && normalizarFiltroChamados(record.serie) === normalizarFiltroChamados(appState.filtroChamadoSelecionado.serie)
      ? appState.filtroChamadoSelecionado : null;
    const selectedOsKey = selectedOrder ? normalizarOrdemServico(selectedOrder.os) : "";
    const selectedSources = fontesDoFiltroOs(selectedOrder);
    const simpress = record.simpress || {};
    const ordensVenda = Array.isArray(simpress.ordens_venda) ? simpress.ordens_venda : [];
    const allOrdensSimpress = Array.isArray(simpress.ordens_servico) ? simpress.ordens_servico : [];
    const ordensSimpress = selectedOrder
      ? selectedSources.includes("simpress")
        ? allOrdensSimpress.filter(order => normalizarOrdemServico(order) === selectedOsKey) : []
      : allOrdensSimpress;
    const currentSimpressOrder = [...ordensSimpress].filter(Boolean).sort(compararOrdensServicoDecrescente)[0] || "";
    const chamadosCliente = chamadosClienteInformados(simpress.chamados_cliente);
    const enderecosEntrega = Array.isArray(simpress.enderecos_entrega) ? simpress.enderecos_entrega : [];
    const mostrarEnderecoEntrega = simpress.pedido_em_andamento && enderecosEntrega.some(Boolean);
    const allOracle = Array.isArray(record.oracle) ? record.oracle : [];
    const oracle = selectedOrder
      ? selectedSources.includes("oracle")
        ? allOracle.filter(ticket => normalizarOrdemServico(ticket?.ordem_servico) === selectedOsKey) : []
      : allOracle;
    const attention = classificarAtencaoChamado(selectedOrder ? { ...record, oracle } : record);
    const orderedOracle = [...oracle].sort((left, right) => compararOrdensServicoDecrescente(left.ordem_servico, right.ordem_servico));
    const currentOracle = orderedOracle[0] || {};
    const hasActiveOracle = orderedOracle.some(ticket => !idadeAtualizacaoChamado(ticket).encerrado);
    const updateAgeSummary = hasActiveOracle
      ? attention.ultima_atualizacao
        ? idadeAtualizacaoChamado({ ultima_atualizacao: attention.ultima_atualizacao }).rotulo
        : "Sem data de atualização"
      : currentOracle.ordem_servico ? "Chamado encerrado" : "Sem registro Oracle";
    const oracleRows = orderedOracle.length
      ? orderedOracle.map(ticket => renderizarSolicitacaoOracle(ticket, Boolean(selectedOrder))).join("")
      : '<p class="text-xs text-fg-muted">Sem registro correspondente no Oracle.</p>';
    const attentionClass = attention.em_atencao ? "border-amber-400/20 bg-amber-500/5 text-amber-200" : "border-line-control bg-surface-overlay text-fg-subtle";
    const attentionLabel = attention.em_atencao ? attention.motivo : hasActiveOracle ? "Em dia" : currentOracle.ordem_servico ? "Encerrado" : "Em acompanhamento";
    const cityLabels = cidadesDoChamado(record);
    const providerLabels = atendimentosDoChamado(record).filter(provider => provider !== "Não informado");
    const oracleStatus = [currentOracle.status, currentOracle.sub_status].filter(Boolean).join(" · ") || "Não informado";
    const openDetails = selectedOrder || expandedSections.has(chaveSecaoCartao(record.serie, "details")) ? " open" : "";
    // Empty fields stay out of the card; the relation badge already says which source is missing.
    const temValor = values => Array.isArray(values) && values.some(Boolean);
    const identificador = (label, value, classes) => `<div class="ticket-card-identifier border ${classes}"><span>${label}</span>${value ? `<strong>${value}</strong>` : '<strong class="is-empty">Sem OS</strong>'}</div>`;
    const metaPedido = [
      temValor(simpress.pedidos) ? `<span><b>Pedido</b> ${formatarListaChamados(simpress.pedidos)}</span>` : "",
      temValor(ordensVenda) ? `<span>${formatarListaChamados(ordensVenda)}</span>` : "",
    ].join("");
    const statusLinhas = [
      temValor(simpress.status) ? `<p class="truncate text-xs src-simpress-text" title="Status Simpress: ${formatarListaChamados(simpress.status)}"><b>Simpress</b> · ${formatarListaChamados(simpress.status)}</p>` : "",
      orderedOracle.length ? `<p class="truncate text-xs src-oracle-text" title="Status Oracle: ${escapeHtml(oracleStatus)}"><b>Oracle</b> · ${escapeHtml(oracleStatus)}</p>` : "",
    ].join("");
    const triagem = [
      currentOracle.fila ? `<span>Fila: ${escapeHtml(currentOracle.fila)}</span>` : "",
      cityLabels.length ? `<span>Cidade: ${escapeHtml(cityLabels.join(", "))}</span>` : "",
      providerLabels.length ? `<span>Atendimento: ${escapeHtml(providerLabels.join(", "))}</span>` : "",
    ].join("");
    const detalhesSimpress = [
      temValor(ordensSimpress) ? `<p class="mt-1 text-xs text-fg-tertiary">OS na planilha: ${formatarOrdensServico(ordensSimpress)}</p>` : "",
      chamadosCliente.some(Boolean) ? `<p class="mt-1 text-xs text-fg-tertiary">Chamado do cliente: ${formatarListaChamados(chamadosCliente)}</p>` : "",
      temValor(simpress.descricoes_produto) ? `<p class="mt-1 break-words text-xs text-fg-tertiary">Descrição do produto: ${formatarListaChamados(simpress.descricoes_produto)}</p>` : "",
      temValor(simpress.cidades_entrega) ? `<p class="mt-1 text-xs text-fg-tertiary">Cidade de entrega: ${formatarListaChamados(simpress.cidades_entrega)}</p>` : "",
      mostrarEnderecoEntrega ? `<p class="mt-1 break-words text-xs text-fg-tertiary">Endereço de entrega: ${formatarListaChamados(enderecosEntrega)}</p>` : "",
    ].join("") || '<p class="mt-1 text-xs text-fg-muted">Sem registro correspondente na Simpress.</p>';
    return `<article class="ticket-card rounded-xl border border-line-quiet bg-surface/70 p-3 sm:p-3.5" data-ticket-serial="${escapeHtml(record.serie)}">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0"><h4 class="break-all font-mono text-sm font-semibold text-white">${escapeHtml(record.serie)}</h4>${context.loggedUserMarkers.marcador(record.serie)}</div>
            <div class="flex flex-wrap items-center gap-1.5"><span class="rounded-full border px-2 py-1 text-xs font-semibold ${relationClass}">${relationLabel}</span><span class="rounded-full border px-2 py-1 text-xs ${attentionClass}" title="${escapeHtml(updateAgeSummary)}">${escapeHtml(attentionLabel)}</span></div>
          </div>
          <div class="ticket-card-identifiers mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            ${identificador("OS Simpress", currentSimpressOrder ? formatarOrdensServico([currentSimpressOrder]) : "", "src-simpress-soft")}
            ${identificador("OS Oracle", currentOracle.ordem_servico ? escapeHtml(currentOracle.ordem_servico) : "", "src-oracle-soft")}
          </div>
          ${renderizarResumoProcessoPedido(simpress)}
          ${metaPedido ? `<div class="ticket-card-meta mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-tertiary">${metaPedido}</div>` : ""}
          ${statusLinhas ? `<div class="ticket-card-status mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">${statusLinhas}</div>` : ""}
          ${triagem ? `<div class="ticket-card-triage mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">${triagem}</div>` : ""}
          <details class="ticket-disclosure mt-3 rounded-lg border border-line-quiet bg-surface-overlay/40 px-3 py-1.5" data-ticket-section="details"${openDetails}>
            <summary class="ticket-disclosure-summary cursor-pointer text-xs font-semibold text-fg-secondary">Detalhes do chamado</summary>
            <div class="ticket-detail-grid">
              <section class="ticket-detail-section">
                <h5 class="text-xs font-semibold uppercase tracking-wide src-simpress-text">Simpress</h5>
                ${detalhesSimpress}
              </section>
              <section class="ticket-detail-section">
                <h5 class="text-xs font-semibold uppercase tracking-wide src-oracle-text">Oracle · solicitações e OS</h5>${oracleRows}
              </section>
            </div>
          </details>
          <details class="ticket-disclosure mt-2 rounded-lg border border-cyan-400/20 bg-surface-overlay/50 px-3 py-1.5" data-ticket-section="timeline" data-ticket-timeline data-timeline-serial="${escapeHtml(record.serie)}" data-snapshot-id="${escapeHtml(snapshotId || "")}" data-on-toggle="carregarLinhaDoTempoChamado" data-args='["$this"]'><summary class="ticket-disclosure-summary cursor-pointer text-xs font-semibold text-cyan-100">Linha do tempo e anotações</summary><div data-ticket-timeline-body><p class="py-2 text-xs text-fg-subtle">Abra para ver as mudanças desta série em cada importação e registrar a próxima ação.</p></div></details>
        </article>`;
  }

  function renderizarSolicitacaoOracle(ticket, expandDescription = false) {
    const updateAge = idadeAtualizacaoChamado(ticket);
    const ageClass = updateAge.encerrado ? "text-fg-muted" : updateAge.dias === null || updateAge.dias >= 3 ? "text-amber-200" : "text-emerald-200";
    const oracleAddress = [ticket.logradouro, ticket.numero_endereco, ticket.bairro, ticket.cidade]
      .map(value => String(value || "").trim())
      .filter(Boolean)
      .join(", ");
    // Only filled fields are listed, joined with " · ".
    const linha = (color, fields) => {
      const parts = fields.filter(([, value]) => String(value || "").trim())
        .map(([label, value]) => label === "Atualizado" ? `Atualizado ${escapeHtml(value)}` : `${label}: ${escapeHtml(value)}`);
      return parts.length ? `<p class="mt-1 text-xs ${color}">${parts.join(" · ")}</p>` : "";
    };
    // The current OS is already highlighted at the top of the card, so each request lists it as plain text.
    return `<div class="ticket-oracle-request">
          <p class="flex flex-wrap items-baseline gap-x-3 text-xs"><span class="font-semibold text-white">Solicitação ${escapeHtml(ticket.solicitacao || "não informada")}</span><span class="text-fg-subtle">OS <span class="font-mono text-fg-secondary">${escapeHtml(ticket.ordem_servico || "não informada")}</span></span></p>
          <p class="mt-1 text-xs text-fg-tertiary">${escapeHtml(ticket.status || "Status não informado")}${ticket.sub_status ? ` · ${escapeHtml(ticket.sub_status)}` : ""}</p>
          ${linha("text-fg-subtle", [["Fila", ticket.fila], ["Fase", ticket.fase_atendimento]])}
          ${oracleAddress ? `<p class="mt-1 break-words text-xs text-fg-subtle">Endereço: ${escapeHtml(oracleAddress)}</p>` : ""}
          ${linha("text-fg-subtle", [["Atendido pela inibição", ticket.atendido_pela_inibicao]])}
          ${linha("text-fg-subtle", [["Atendimento por", ticket.nome_filial]])}
          ${linha("text-fg-subtle", [["Entregas", ticket.status_entregas], ["Atividades", ticket.status_atividades], ["Atualizado", ticket.ultima_atualizacao && formatarHorarioHistorico(ticket.ultima_atualizacao)]])}
          <p class="mt-1 text-xs font-medium ${ageClass}">${escapeHtml(updateAge.rotulo)}</p>
          ${String(ticket.descricao || "").trim() ? `<details class="ticket-oracle-description"${expandDescription ? " open" : ""}><summary class="text-xs"><span class="shrink-0 font-semibold src-oracle-text">Descrição do chamado</span><span class="ticket-oracle-description-preview">${escapeHtml(resumirDescricaoChamado(ticket.descricao))}</span><span class="ticket-oracle-description-toggle ticket-oracle-description-expand">⌄ Expandir</span><span class="ticket-oracle-description-toggle ticket-oracle-description-collapse">⌃ Recolher</span></summary><div class="ticket-oracle-description-content">${escapeHtml(String(ticket.descricao).trim())}</div></details>` : ""}
        </div>`;
  }

  function limparFiltrosAcompanhamentoChamados() {
    document.getElementById("filtro-acompanhamento-chamados").value = "";
    document.getElementById("somente-atencao-chamados").checked = false;
    appState.filtroTriagemChamados = "";
    appState.filtroChamadoSelecionado = null;
    app.renderizarAcompanhamentoChamados();
  }

  function abrirChamadoDaOs(fontes, serie, os) {
    const selectedSources = (Array.isArray(fontes) ? fontes : [fontes])
      .map(source => String(source || "").trim().toLowerCase())
      .filter(source => source === "oracle" || source === "simpress");
    const uniqueSources = [...new Set(selectedSources)];
    const selectedOrder = {
      fonte: uniqueSources.length === 1 ? uniqueSources[0] : "ambas",
      fontes: uniqueSources,
      serie: String(serie || "").trim(),
      os: String(os || "").trim(),
    };
    if (!uniqueSources.length || !selectedOrder.serie || !selectedOrder.os) return;
    app.abrirAcompanhamentoChamados(false, selectedOrder);
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
    target.innerHTML = '<p class="py-8 text-center text-sm text-fg-subtle" role="status">Carregando versão selecionada…</p>';
    try {
      const data = await app.apiFetch(`/api/operacoes/chamados/snapshot/${encodeURIComponent(snapshotId)}`, { signal: request.signal, errorMessage: "Não foi possível abrir esta versão." });
      if (!ticketSnapshotRequestGate.isCurrent(request.id)) return;
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
      const data = await app.apiFetch("/api/operacoes/chamados/historico/antigas", { method: "DELETE", errorMessage: "Não foi possível excluir as importações antigas." });
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
      const response = await app.apiFetch(`/api/operacoes/chamados/exportar?${params.toString()}`, {
        responseType: "response",
        errorMessage: "Não foi possível exportar os chamados filtrados.",
      });
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
      app.showToast("Planilha Exportada com Sucesso!", "success");
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
    list.innerHTML = '<p class="py-8 text-center text-sm text-fg-subtle" role="status">Carregando acompanhamento…</p>';
    try {
      const data = await app.apiFetch("/api/operacoes/chamados", { signal: request.signal, errorMessage: "Não foi possível carregar o acompanhamento de chamados." });
      if (!ticketSnapshotRequestGate.isCurrent(request.id)) return;
      appState.acompanhamentoChamadosAtual = data;
      chamadosRecentesHome = data;
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
      const data = await app.apiFetch("/api/operacoes/chamados/importar", { method: "POST", body: payload, errorMessage: "Não foi possível importar as planilhas." });
      if (appState.filtroChamadoSelecionado) document.getElementById("filtro-acompanhamento-chamados").value = "";
      appState.filtroChamadoSelecionado = null;
      ticketSnapshotRequestGate.invalidate();
      ticketEvolutionRequestGate.invalidate();
      appState.acompanhamentoChamadosAtual = data;
      chamadosRecentesHome = data;
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

  function abrirAcompanhamentoChamados(importar = false, selectedOrder = null) {
    const search = document.getElementById("filtro-acompanhamento-chamados");
    if (selectedOrder) {
      appState.filtroChamadoSelecionado = selectedOrder;
      search.value = selectedOrder.os;
      document.getElementById("somente-atencao-chamados").checked = false;
      appState.filtroTriagemChamados = "";
    } else if (appState.filtroChamadoSelecionado) {
      if (search.value === appState.filtroChamadoSelecionado.os) search.value = "";
      appState.filtroChamadoSelecionado = null;
    }
    const initialFocus = importar ? '#arquivo-chamados-simpress'
      : selectedOrder ? '#filtro-acompanhamento-chamados' : '[aria-label="Fechar acompanhamento de chamados"]';
    app.abrirModalAcessivel("modal-acompanhamento-chamados", initialFocus, "fecharAcompanhamentoChamados", "btn-acompanhamento-chamados");
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
        control.addEventListener(id === "filtro-acompanhamento-chamados" ? "input" : "change", () => {
          if (id === "filtro-acompanhamento-chamados") appState.filtroChamadoSelecionado = null;
          app.renderizarAcompanhamentoChamados();
        });
      });
      form.dataset.bound = "true";
    }
    app.carregarAcompanhamentoChamados();
  }

  // Home: Oracle tickets still open for the selected series, always from the latest import (not the version picked in Acompanhamento).
  const homeTicketsRequestGate = transferUtils.createRequestGate();
  // shortcut: refreshed only by imports made in this tab or by opening Acompanhamento; a folder import needs a page reload.
  let chamadosRecentesHome = null;
  function renderizarChamadosAbertosHome(abertos) {
    const dom = context.dom;
    const body = document.getElementById("home-open-tickets-body");
    const count = document.getElementById("home-open-tickets-count");
    body.setAttribute("aria-busy", "false");
    count.textContent = abertos.length ? `${abertos.length} ${abertos.length === 1 ? "aberto" : "abertos"}` : "";
    if (!abertos.length) {
      body.replaceChildren(dom.createTextElement("p", "ck-abertos__vazio", "Nenhum chamado aberto para esta série."));
      return;
    }
    const list = document.createElement("ul");
    list.className = "ck-abertos";
    abertos.forEach(ticket => {
      const item = document.createElement("li");
      item.className = "ck-aberto";
      item.append(
        dom.createTextElement("strong", "ck-aberto__numero", ticket.solicitacao || "Sem solicitação"),
        dom.createTextElement("span", "ck-badge", [ticket.status, ticket.sub_status].filter(Boolean).join(" · ") || "Status não informado"),
        dom.createTextElement("p", "ck-aberto__titulo", ticket.fila || "Fila não informada"),
        dom.createTextElement("p", "ck-aberto__meta", ticket.nome_filial || ticket.cidade || "Unidade não informada"),
        dom.createTextElement("p", "ck-aberto__meta", idadeAtualizacaoChamado(ticket).rotulo),
      );
      list.append(item);
    });
    body.replaceChildren(list);
  }

  async function atualizarChamadosAbertosHome(serial) {
    const body = document.getElementById("home-open-tickets-body");
    if (!body) return;
    const request = homeTicketsRequestGate.begin();
    body.setAttribute("aria-busy", "true");
    body.replaceChildren(context.dom.createTextElement("p", "ck-abertos__vazio", "Carregando chamados…"));
    document.getElementById("home-open-tickets-count").textContent = "";
    try {
      if (!chamadosRecentesHome) {
        const data = await app.apiFetch("/api/operacoes/chamados", { signal: request.signal, errorMessage: "Não foi possível carregar os chamados." });
        if (!homeTicketsRequestGate.isCurrent(request.id)) return;
        chamadosRecentesHome = data;
      }
      if (!homeTicketsRequestGate.isCurrent(request.id)) return;
      const chamados = Array.isArray(chamadosRecentesHome.chamados) ? chamadosRecentesHome.chamados : [];
      const record = chamados.find(item => normalizarFiltroChamados(item.serie) === normalizarFiltroChamados(serial));
      const abertos = (record?.oracle || []).filter(ticket => !idadeAtualizacaoChamado(ticket).encerrado)
        .sort((left, right) => compararOrdensServicoDecrescente(left.ordem_servico, right.ordem_servico));
      renderizarChamadosAbertosHome(abertos);
    } catch (error) {
      if (!homeTicketsRequestGate.isCurrent(request.id)) return;
      body.setAttribute("aria-busy", "false");
      const message = context.dom.createTextElement("p", "ck-abertos__vazio", error.message || "Não foi possível carregar os chamados.");
      message.setAttribute("role", "alert");
      body.replaceChildren(message);
    }
  }

  return {
    atualizarChamadosAbertosHome,
    fecharAcompanhamentoChamados, renderizarHistoricoAcompanhamentoChamados, renderizarEvolucaoChamados,
    carregarEvolucaoChamados, renderizarLinhaDoTempoChamado, conectarAnotacoesLinhaDoTempo,
    carregarLinhaDoTempoChamado, renderizarAcompanhamentoChamados, filtrarTriagemChamados, limparFiltrosAcompanhamentoChamados,
    selecionarVersaoChamados, excluirImportacoesAntigasChamados, exportarAcompanhamentoChamados,
    carregarAcompanhamentoChamados, importarPlanilhasChamados, abrirAcompanhamentoChamados, abrirChamadoDaOs,
  };
});
