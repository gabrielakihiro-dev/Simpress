/** Dedicated Cockpit workspaces for the tools in the nine-dot menu. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).cockpitToolPanels = factory;
})(typeof window !== "undefined" ? window : globalThis, function createCockpitToolPanels(context) {
  "use strict";
  const { app, apiFetch } = context;
  const toolKeys = { "sebrae-chamados": "F5", chamados: "F6", comparacao: "F7", apelidos: "F8", relatorio: "F9" };
  const toolInfo = {
    chamados: ["OS", "Acompanhamento local de ordens relacionadas por série."],
    comparacao: ["Comparação", "Resultados salvos da comparação entre as bases locais."],
    apelidos: ["Histórico de apelidos", "Alterações registradas para equipamentos e usuários."],
    relatorio: ["Relatório mensal", "Consolidação do mês usando os dados locais disponíveis."],
    planilhas: ["Atualizar planilhas", "Última atualização das bases locais de equipamentos."],
    unidades: ["Catálogo de unidades", "Unidades Sebrae cadastradas para entrega e retirada."],
    // Sem loader em openPanel: recarregar a lista zeraria as edições dos chamados antigos (sebrae-dashboard.js).
    "sebrae-chamados": ["Chamados", "Preencha os chamados novos e antigos, exporte as linhas e atualize o Dashboard."],
  };
  const relationLabels = {
    conferida: "Conferida", divergente: "Divergente", somente_simpress: "Só Simpress",
    somente_oracle: "Só Oracle",
  };
  const relationTones = { conferida: "success", divergente: "error", somente_simpress: "warning", somente_oracle: "warning" };
  let eventsBound = false;
  let activeTool = "";
  let previousTool = "";
  let goingBack = false;
  let sheetsRequest = 0;
  let sheetsRows = [];
  let selectedSheetKey = "";
  let unitsRequest = 0;
  let unitsList = [];
  let selectedUnitKey = "";
  let returnTarget = null;
  let ticketData = null;
  let ticketTriage = "";
  let comparisonEvents = [];
  let selectedComparisonId = "";
  let selectedComparison = null;
  let aliasEvents = [];
  let selectedAliasId = "";
  let selectedAliasPeriod = "todos";
  let aliasLatest = new Map();
  const aliasEquipmentCache = new Map();
  let aliasEquipmentRequest = 0;
  let monthlyRequest = 0;
  let comparisonRequest = 0;
  let comparisonDetailRequest = 0;
  let aliasRequest = 0;
  let skipLinkHref = null;
  let pendingComparisonTarget = null;
  let pendingFreshComparison = null;
  const HIGHLIGHT_MS = 1500;

  function normalize(value) {
    return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
  }

  function filterTicketRecords(records, query, relationFilter = "todos") {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    return (Array.isArray(records) ? records : []).filter(record => {
      if (relationFilter !== "todos" && record?.relacao !== relationFilter) return false;
      const searchable = normalize(JSON.stringify(record || {}));
      return terms.every(term => searchable.includes(term));
    });
  }

  function countValue(value) { return Number.isFinite(value) ? value : null; }

  function comparisonMetrics(event) {
    const comparison = event?.comparacao || {};
    const userChanges = comparison.divergencias_usuario;
    return {
      simpress: countValue(comparison.total_detalhes),
      endpoint: countValue(comparison.total_endpoint),
      iguais: countValue(comparison.equipamentos_sincronizados),
      divergenciaLocal: Array.isArray(comparison.divergencias_local) ? uniqueComparisonCount(comparison.divergencias_local) : null,
      divergenciaUsuario: Array.isArray(userChanges) ? uniqueComparisonCount(userChanges) : countValue(userChanges),
      soSimpress: Array.isArray(comparison.ausentes_no_endpoint) ? uniqueComparisonCount(comparison.ausentes_no_endpoint) : null,
      soEndpoint: Array.isArray(comparison.ausentes_em_detalhes) ? uniqueComparisonCount(comparison.ausentes_em_detalhes) : null,
    };
  }

  function uniqueComparisonCount(rows) {
    const records = new Set();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const serial = normalize(row?.serie);
      records.add(serial || JSON.stringify(row));
    });
    return records.size;
  }

  function aliasMetrics(events, now = new Date()) {
    const month = now.getMonth();
    const year = now.getFullYear();
    const current = (Array.isArray(events) ? events : []).filter(event => {
      const timestamp = Date.parse(event?.horario || "");
      if (!Number.isFinite(timestamp)) return false;
      const date = new Date(timestamp);
      return date.getFullYear() === year && date.getMonth() === month;
    });
    return {
      changesThisMonth: current.length,
      equipmentAffected: new Set(current.map(event => String(event.serial || "").trim()).filter(Boolean)).size,
      outOfPattern: null,
      duplicateAliases: null,
    };
  }

  function displayCount(value) { return Number.isFinite(value) ? new Intl.NumberFormat("pt-BR").format(value) : "—"; }

  function monthlyPreviewText(report) {
    const month = report?.mes?.label || report?.mes?.key || "mês selecionado";
    const inventory = report?.inventario || {};
    const comparison = report?.comparacao || {};
    const tickets = report?.os || {};
    const oracle = tickets.oracle || {};
    const simpress = tickets.simpress || {};
    const counts = comparison.contagens || {};
    const topUnits = Array.isArray(inventory.por_unidade) ? inventory.por_unidade.slice(0, 3) : [];
    const lines = [
      `Relatório mensal Simpress · ${month}`,
      "",
      `Equipamentos na base atual: ${displayCount(inventory.total)}`,
      `Unidades na base atual: ${displayCount(inventory.unidades)}`,
      `Atualizações de inventário no mês: ${displayCount(comparison.atualizacoes_no_mes)}`,
      `OS Oracle abertas: ${displayCount(oracle.abertas)}`,
      `OS Oracle concluídas: ${displayCount(oracle.concluidas)}`,
      `OS Oracle pendentes no fim do mês: ${displayCount(oracle.pendentes)}`,
      `Pedidos Simpress abertos: ${displayCount(simpress.abertas)}`,
      `Pedidos Simpress concluídos: ${displayCount(simpress.concluidas)}`,
      `Pedidos Simpress em andamento no fim do mês: ${displayCount(simpress.pendentes)}`,
      `Sem correspondência — no endpoint: ${displayCount(counts["Sem correspondência — no endpoint"])}`,
      `Sem correspondência — na Simpress: ${displayCount(counts["Sem correspondência — na Simpress"])}`,
      `Localidade divergente: ${displayCount(counts["Localidade divergente"])}`,
      "Transportes solicitados: indisponível nesta fonte de dados",
      "Tempo médio até fechar: indisponível nesta fonte de dados",
      "Alterações de apelido: indisponível nesta fonte de dados",
      "",
      "Unidades com mais equipamentos (base atual):",
      ...(topUnits.length ? topUnits.map(([city, address, total]) => `- ${[city, address].filter(Boolean).join(" · ")}: ${displayCount(total)}`) : ["- Sem dados de unidade."]),
    ];
    if (Array.isArray(tickets.dados_insuficientes) && tickets.dados_insuficientes.length) {
      lines.push(`Registros com dados insuficientes: ${tickets.dados_insuficientes.length}`);
    }
    return lines.join("\n");
  }

  function byId(id) { return document.getElementById(id); }

  function element(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  const badgeStatus = { success: "ok", warning: "alerta", error: "erro" };

  function badge(text, tone = "neutral") {
    const node = element("span", "ck-badge", text);
    if (badgeStatus[tone]) node.dataset.status = badgeStatus[tone];
    return node;
  }

  function renderEmpty(target, message) {
    const node = element("p", "ck-lista__vazio", message);
    if (target.getAttribute("role") === "list") node.setAttribute("role", "listitem");
    target.replaceChildren(node);
  }

  function renderKpis(target, entries) {
    target.replaceChildren(...entries.map(([label, value, note]) => {
      const card = element("div", "ck-kpi");
      const shown = typeof value === "string" ? value : displayCount(value);
      card.append(element("span", "ck-kpi__rotulo", label), element("strong", "ck-kpi__valor", shown));
      if (note) card.append(element("small", "ck-kpi__sub", note));
      return card;
    }));
  }

  function renderDetails(target, entries) {
    const list = element("dl", "ck-det-campos");
    entries.filter(([, value]) => value !== null && value !== undefined && value !== "")
      .forEach(([label, value]) => list.append(element("dt", "", label), element("dd", "", value)));
    target.replaceChildren(list);
  }

  function renderError(target, error, fallback) {
    const message = error?.message || fallback;
    const node = element("p", "ck-nota ck-nota--erro", message);
    if (target.getAttribute("role") === "list") node.setAttribute("role", "listitem");
    target.replaceChildren(node);
  }

  // Object.hasOwn: uma relação como "constructor" não pode herdar entradas do protótipo.
  const ownEntry = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);
  function relationText(record) { return ownEntry(relationLabels, record?.relacao) || String(record?.relacao || "Relação indisponível"); }

  function ticketOrders(record) {
    const oracle = (Array.isArray(record?.oracle) ? record.oracle : [])
      .map(item => item?.ordem_servico || item?.solicitacao).filter(Boolean).map(String);
    const simpress = (Array.isArray(record?.simpress?.ordens_servico) ? record.simpress.ordens_servico : []).map(String);
    return { oracle, simpress };
  }

  // Campos do Andamento da série: fila, fase, endereço, atendimento, etapa e previsão do pedido.
  // Os helpers vêm de SimpressTicketRules (publicados em app); sem eles o campo simplesmente não aparece.
  function ticketExtraFields(record) {
    const rules = name => (typeof app?.[name] === "function" ? app[name] : null);
    const list = values => (Array.isArray(values) ? values : []).filter(Boolean).join(", ");
    const compare = rules("compararOrdensServicoDecrescente");
    const oracle = [...(Array.isArray(record.oracle) ? record.oracle : [])];
    if (compare) oracle.sort((left, right) => compare(left.ordem_servico, right.ordem_servico));
    const current = oracle[0] || {};
    const simpress = record.simpress || {};
    const address = [current.logradouro, current.numero_endereco, current.bairro, current.cidade]
      .map(value => String(value || "").trim()).filter(Boolean).join(", ");
    const providers = (rules("atendimentosDoChamado")?.(record) || []).filter(name => name !== "Não informado");
    const stages = rules("etapasProcessoPedido")?.(simpress) || [];
    const formatDate = rules("formatarDataEtapa") || (value => value);
    const forecast = stages.find(stage => stage.chave === "previsao_entrega" && stage.data);
    const lastStage = [...stages].reverse().find(stage => stage.chave !== "previsao_entrega" && stage.data);
    const format = context.historyFormat?.formatarHorarioHistorico;
    const age = oracle.length ? rules("idadeAtualizacaoChamado")?.(current)?.rotulo : "";
    const updated = current.ultima_atualizacao ? (format ? format(current.ultima_atualizacao) : current.ultima_atualizacao) : "";
    return [
      ["Solicitações Oracle", list(oracle.map(item => item.solicitacao))],
      ["Fila", current.fila], ["Fase", current.fase_atendimento],
      ["Atendimento", providers.join(", ")],
      ["Cidade", list(rules("cidadesDoChamado")?.(record))],
      ["Endereço Oracle", address],
      ["Pedido Simpress", list(simpress.pedidos)],
      ["Endereço de entrega", simpress.pedido_em_andamento ? list(simpress.enderecos_entrega) : ""],
      ["Etapa atual", lastStage ? `${lastStage.rotulo} · ${formatDate(lastStage.data)}` : ""],
      ["Previsão de entrega", forecast ? formatDate(forecast.data) : ""],
      ["Última atualização Oracle", [updated, age].filter(Boolean).join(" · ")],
      ["Chamado do cliente", list(rules("chamadosClienteInformados")?.(simpress.chamados_cliente))],
      ["Descrição do chamado", current.descricao ? (rules("resumirDescricaoChamado")?.(current.descricao) || String(current.descricao)) : ""],
    ];
  }

  // Conteúdo da linha "Andamento" de uma série (callback aoExpandirSerie da tabela de OS).
  function renderTicketDetail(record, target) {
    if (!record) return renderEmpty(target, "Série não encontrada na importação atual.");
    const { oracle, simpress } = ticketOrders(record);
    const oracleRecords = Array.isArray(record.oracle) ? record.oracle : [];
    const simpressRecord = record.simpress || {};
    const attention = app.classificarAtencaoChamado?.(record);
    const relation = element("p", "ck-nota", "Relação: ");
    relation.append(badge(relationText(record), ownEntry(relationTones, record.relacao)));
    if (attention?.em_atencao) relation.append(" ", badge(attention.motivo || "Atenção", "warning"));
    const fields = element("div", "");
    renderDetails(fields, [
      ["Ordens no Oracle", oracle.length ? oracle.join(", ") : "Nenhuma ordem informada"],
      ["Ordens na Simpress", simpress.length ? simpress.join(", ") : "Nenhuma ordem informada"],
      ["Status Oracle", oracleRecords.map(item => [item.status, item.sub_status].filter(Boolean).join(" · ")).filter(Boolean).join(" / ")],
      ["Status Simpress", (Array.isArray(simpressRecord.status) ? simpressRecord.status : []).filter(Boolean).join(" / ")],
      ...ticketExtraFields(record),
    ]);
    const note = element("p", "ck-nota", "Os dados vêm da importação mais recente. A próxima ação de cada versão pode ser registrada na linha do tempo.");
    const timeline = element("section", "ck-det-bloco");
    timeline.append(element("h3", "", "Andamento registrado"));
    const events = element("div", "");
    timeline.append(events);
    target.replaceChildren(relation, fields, note, timeline);
    loadTicketTimeline(record, events);
  }

  function expandTicketSeries(serie, target) {
    const records = Array.isArray(ticketData?.chamados) ? ticketData.chamados : [];
    renderTicketDetail(records.find(record => String(record.serie || "") === serie), target);
  }

  function timelineValue(value) {
    return Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value ?? "");
  }

  function renderTicketTimeline(target, events) {
    if (!events.length) return renderEmpty(target, "Não há versões anteriores para esta série.");
    const list = element("ol", "ck-tempo");
    events.forEach(event => {
      const item = element("li", "ck-tempo__item");
      const body = element("div", "ck-tempo__corpo");
      item.append(element("span", "ck-tempo__marca"), body);
      body.append(element("strong", "ck-tempo__titulo", event.tipo || "Atualização"));
      body.append(element("time", "ck-tempo__meta", event.atualizado_em || "Data indisponível"));
      const changes = Array.isArray(event.mudancas) ? event.mudancas : [];
      if (changes.length) body.append(element("p", "ck-tempo__meta", changes.map(change =>
        `${change.campo || "Campo"}: ${timelineValue(change.anterior) || "(vazio)"} → ${timelineValue(change.atual) || "(vazio)"}`,
      ).join(" · ")));
      body.append(ticketAnnotationField(event));
      list.append(item);
    });
    target.replaceChildren(list);
  }

  // Anotação por versão da linha do tempo (próxima ação ou o que já foi feito), salva sozinha com o limite de 2.000 caracteres.
  function ticketAnnotationField(event) {
    const field = element("label", "ck-chamados-anotacao");
    field.append(element("span", "ck-chamados-anotacao__rotulo", "Próxima ação ou o que já foi feito"));
    const textarea = element("textarea", "annotation-field");
    textarea.rows = 2;
    textarea.maxLength = 2000;
    textarea.value = event.anotacao || "";
    textarea.placeholder = "Ex.: cobrar atualização do parceiro, OS concluída...";
    textarea.dataset.annotationVersion = JSON.stringify({
      anotacao_revisoes: event.anotacao_revisoes || [],
      anotacao_conflito: Boolean(event.anotacao_conflito),
      anotacao_conflitos: event.anotacao_conflitos || [],
      anotacao_bases_ausentes: event.anotacao_bases_ausentes || [],
      anotacao_integridade_invalida: Boolean(event.anotacao_integridade_invalida),
    });
    const status = element("span", `annotation-status${event.anotacao ? " is-saved" : ""}`, event.anotacao ? "Anotação salva" : "");
    status.setAttribute("aria-live", "polite");
    const retry = element("button", "annotation-retry", "Tentar sincronizar novamente");
    retry.type = "button";
    retry.hidden = true;
    retry.setAttribute("aria-label", "Tentar novamente a sincronização desta anotação");
    field.append(textarea, status, retry);
    const autosave = globalThis.HistoryAnnotationAutosave;
    if (autosave && event.snapshot_id && event.item_id) {
      autosave.attachAnnotationAutosave({
        textarea, status, retryButton: retry, eventId: event.snapshot_id, itemId: event.item_id,
        send: ({ eventId, itemId, annotation, revisionId, baseRevisions, resolveConflict }) => fetch(
          `/api/operacoes/chamados/linha-do-tempo/${encodeURIComponent(eventId)}/${encodeURIComponent(itemId)}`,
          { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anotacao: annotation, revisao_id: revisionId, base_revisoes: baseRevisions, resolver_conflito: resolveConflict }) },
        ),
      });
    } else {
      textarea.readOnly = true;
    }
    return field;
  }

  async function loadTicketTimeline(record, target) {
    const serial = String(record.serie || "");
    const snapshotId = String(ticketData?.snapshot_id || "");
    renderEmpty(target, "Carregando histórico da série…");
    if (!serial || !snapshotId) return renderEmpty(target, "O histórico desta série não está disponível nesta importação.");
    // Cada linha aberta tem o próprio destino; recolher/recriar a tabela o desconecta e descarta a resposta.
    const stale = () => !target.isConnected || activeTool !== "chamados";
    try {
      const params = new URLSearchParams({ snapshot_id: snapshotId });
      const data = await apiFetch(`/api/operacoes/chamados/linha-do-tempo/${encodeURIComponent(serial)}?${params}`, {
        errorMessage: "Não foi possível carregar o histórico desta série.",
      });
      if (!stale()) renderTicketTimeline(target, Array.isArray(data.eventos) ? data.eventos : []);
    } catch (error) {
      if (!stale()) renderError(target, error, "Não foi possível carregar o histórico desta série.");
    }
  }

  function renderTicketKpis() {
    const summary = ticketData?.resumo || {};
    renderKpis(byId("cockpit-tickets-kpis"), [
      ["Séries", summary.series_total], ["Conferidas", summary.conferidas], ["Divergentes", summary.divergentes],
      ["Só Simpress", summary.somente_simpress], ["Só Oracle", summary.somente_oracle],
    ]);
  }

  const ticketTriageGroups = [["ativos", "Ativos", ""], ["atrasados", "3+ dias", "alerta"], ["sem_data", "Sem data", "alerta"], ["em_dia", "Atualizados <3 dias", "ok"]];

  // Triagem pelo grupo da série (regra em ticket-rules): os números contam a importação inteira, não só o filtro atual.
  function renderTicketTriage() {
    const host = byId("cockpit-tickets-triage");
    if (!host) return;
    const records = Array.isArray(ticketData?.chamados) ? ticketData.chamados : [];
    const groupOf = app.grupoTriagemChamado;
    if (typeof groupOf !== "function" || !records.length) { host.hidden = true; return; }
    const counts = { ativos: 0, atrasados: 0, sem_data: 0, em_dia: 0 };
    records.forEach(record => {
      const group = groupOf(record);
      if (!group) return;
      counts.ativos += 1;
      counts[group] += 1;
    });
    const head = element("div", "ckp-triagem__cab");
    const title = element("h3", "ckp-triagem__titulo", "Triagem por atualização no Oracle");
    title.id = "cockpit-tickets-triage-title";
    head.append(title, element("span", "ck-chamados-triagem__resumo",
      `${counts.ativos} de ${records.length} séries com chamado aberto no Oracle · ${records.length - counts.ativos} sem chamado aberto`));
    const buttons = element("div", "ckp-triagem__nums");
    ticketTriageGroups.forEach(([key, label, status]) => {
      const button = element("button", "ckp-triagem__num ck-chamados-triagem__botao");
      button.type = "button";
      button.dataset.triagem = key;
      if (status) button.dataset.status = status;
      button.setAttribute("aria-pressed", String(ticketTriage === key));
      button.append(element("span", "ck-chamados-triagem__rotulo", label), element("span", "ck-chamados-triagem__valor", counts[key]));
      buttons.append(button);
    });
    host.replaceChildren(head, buttons);
    host.hidden = false;
  }

  // Busca, Relação, Atenção e Triagem só filtram as linhas já montadas pela tabela de OS (data-panels).
  function filterTicketTable() {
    const relation = byId("cockpit-tickets-relation").value;
    dataPanels()?.filtrarTabelaOs({
      busca: byId("cockpit-tickets-search").value, relacao: relation === "todos" ? "" : relation,
      triagem: ticketTriage, atencao: Boolean(byId("cockpit-tickets-attention")?.checked),
    });
  }

  function selectTicketTriage(event) {
    const button = event.target.closest?.("[data-triagem]");
    if (!button) return;
    ticketTriage = ticketTriage === button.dataset.triagem ? "" : button.dataset.triagem;
    renderTicketTriage();
    filterTicketTable();
    byId("cockpit-tickets-triage").querySelector(`[data-triagem="${ticketTriage}"]`)?.focus();
  }

  function clearTicketFilters() {
    byId("cockpit-tickets-search").value = "";
    byId("cockpit-tickets-relation").value = "todos";
    byId("cockpit-tickets-attention").checked = false;
    ticketTriage = "";
    renderTicketTriage();
    filterTicketTable();
  }

  const dataPanels = () => globalThis.SimpressDataPanels;

  // A tabela já busca /api/operacoes/chamados: reaproveita a resposta (KPIs e snapshot_id) em vez de pedir de novo.
  async function loadTickets() {
    const host = byId("cockpit-tickets-os");
    const panels = dataPanels();
    const mounted = host.querySelector(".ck-os");
    const section = mounted || panels?.montarTabelaOs(host, {
      titulo: "Ordens de serviço por série", semBusca: true,
      aoExpandirSerie: expandTicketSeries,
      grupoSerie: app.grupoTriagemChamado,
      aoCarregar: report => {
        ticketData = report;
        renderTicketKpis();
        renderTicketTriage();
        app.sincronizarGestaoChamadosCockpit?.(report);
      },
    });
    if (!section) return renderError(host, null, "A tabela de ordens de serviço não está disponível.");
    filterTicketTable();
    // Recém-montada já está carregando; só recarrega à força se já existia.
    if (mounted) await panels.atualizarTabelaOs(true);
  }

  function destacarLinhaCockpit(element) {
    if (!element?.isConnected) return;
    element.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    element.classList.add("ck-linha-destaque");
    setTimeout(() => element.classList.remove("ck-linha-destaque"), HIGHLIGHT_MS);
  }

  // Serial-only target: navegarParaLinhaComparacao finds the row in the rendered result (S-prefix rule included).
  async function abrirComparacaoDaSerie(serial) {
    const value = String(serial || "").trim();
    pendingComparisonTarget = value ? { serial: value } : null;
    selectedComparisonId = "";
    await openPanel("comparacao");
    pendingComparisonTarget = null;
  }

  // Shows a result in the Comparação tab. With evento_id that event is selected; a fresh result (no evento_id)
  // is rendered at once and then replaced by the newest saved event, since annotations need evento_id.
  async function mostrarResultadoNaAbaComparacao(comparison, navigationTarget = null) {
    const eventId = String(comparison?.evento_id || "");
    pendingComparisonTarget = navigationTarget;
    pendingFreshComparison = eventId ? null : comparison;
    selectedComparisonId = eventId;
    await openPanel("comparacao");
    pendingComparisonTarget = null;
    pendingFreshComparison = null;
  }

  async function openSerialInHome(serial) {
    const input = byId("input-serial");
    if (!serial || !input) return;
    input.value = serial;
    closePanel(false);
    app.ativarAbaTransferencia("home");
    await app.buscarSerial();
  }

  function renderDetailsInto(target, entries) {
    const list = element("dl", "ck-det-campos");
    entries.forEach(([label, value]) => list.append(element("dt", "", label), element("dd", "", value)));
    target.append(list);
  }

  function renderComparisonSelect() {
    const select = byId("cockpit-comparison-event");
    select.replaceChildren(...comparisonEvents.map(event => {
      const option = element("option", "", `${event.horario || "Data indisponível"} · ${event.tipo || "Atualização"}`);
      option.value = String(event.id || "");
      return option;
    }));
    select.value = selectedComparisonId;
    select.disabled = comparisonEvents.length === 0;
  }

  function updateComparisonStatus() {
    const status = byId("cockpit-comparison-status");
    if (!selectedComparison) {
      status.textContent = `${comparisonEvents.length} ${comparisonEvents.length === 1 ? "registro" : "registros"} no histórico local`;
      return;
    }
    status.textContent = `${selectedComparison.tipo || "comparação local"} · ${selectedComparison.horario || "data indisponível"}`;
  }

  function openNewComparison() {
    app.abrirModalAtualizarPlanilhas();
  }

  async function exportSelectedComparison(event = selectedComparison) {
    const eventDate = String(event?.horario || "").slice(0, 10);
    const button = byId("btn-exportar-resultado-comparacao");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !button || typeof app.exportarResultadoComparacaoPlanilhas !== "function") {
      app.showToast("Este resultado não tem uma data de histórico válida para exportar.", "warning");
      return;
    }
    const previousDate = button.dataset.historyDate;
    button.dataset.historyDate = eventDate;
    button.disabled = false;
    try {
      await app.exportarResultadoComparacaoPlanilhas();
    } finally {
      if (previousDate) button.dataset.historyDate = previousDate;
      else delete button.dataset.historyDate;
      button.disabled = !button.dataset.historyDate;
    }
  }

  function comparisonFromEvent(event) {
    return {
      ...(event.comparacao || {}),
      evento_id: event.id,
      horario_comparacao: event.horario || event.comparacao?.horario_comparacao,
      historico_salvo: true,
      contexto_historico: true,
    };
  }

  // Empties the result area (and the export button) while a result loads or is unavailable.
  function clearComparisonResult(message) {
    byId("comparacao-planilhas-fontes").textContent = "";
    const exportButton = byId("btn-exportar-resultado-comparacao");
    exportButton.dataset.historyDate = "";
    exportButton.disabled = true;
    renderEmpty(byId("comparacao-planilhas-conteudo"), message);
  }

  // keepContent: a freshly generated result is already on screen; this load only swaps in the saved event (it has evento_id).
  async function loadComparisonDetail(eventId, { keepContent = false } = {}) {
    const request = ++comparisonDetailRequest;
    selectedComparison = null;
    if (!eventId) {
      if (!keepContent) clearComparisonResult("Não há comparação de inventários disponível neste histórico.");
      return updateComparisonStatus();
    }
    if (!keepContent) clearComparisonResult("Carregando comparação…");
    try {
      const data = await apiFetch(`/api/historico-comparacoes/${encodeURIComponent(eventId)}`, { errorMessage: "Não foi possível abrir esta comparação." });
      if (request !== comparisonDetailRequest || activeTool !== "comparacao") return;
      selectedComparison = data.evento || null;
      if (!selectedComparison) return clearComparisonResult("Comparação não encontrada.");
      const target = pendingComparisonTarget;
      pendingComparisonTarget = null;
      app.renderizarResultadoComparacao(comparisonFromEvent(selectedComparison), target);
      updateComparisonStatus();
    } catch (error) {
      if (request !== comparisonDetailRequest || activeTool !== "comparacao") return;
      if (!keepContent) renderError(byId("comparacao-planilhas-conteudo"), error, "Não foi possível abrir a comparação.");
      byId("cockpit-comparison-status").textContent = error.message || "Não foi possível abrir a comparação.";
    }
  }

  async function loadComparisons() {
    const request = ++comparisonRequest;
    const status = byId("cockpit-comparison-status");
    const fresh = pendingFreshComparison;
    pendingFreshComparison = null;
    status.textContent = "Carregando histórico local…";
    comparisonDetailRequest += 1;
    selectedComparison = null;
    byId("cockpit-comparison-event").disabled = true;
    if (fresh) app.renderizarResultadoComparacao(fresh, pendingComparisonTarget);
    else clearComparisonResult("Carregando histórico local…");
    try {
      const data = await apiFetch("/api/historico-comparacoes", { errorMessage: "Não foi possível carregar o histórico de comparações." });
      if (request !== comparisonRequest || activeTool !== "comparacao") return;
      comparisonEvents = (Array.isArray(data.eventos) ? data.eventos : [])
        .filter(event => event.id && event.tipo !== "restauracao" && !event.somente_anotacoes_sincronizadas);
      selectedComparisonId = comparisonEvents.some(event => String(event.id) === selectedComparisonId)
        ? selectedComparisonId : String(comparisonEvents[0]?.id || "");
      status.textContent = `${comparisonEvents.length} ${comparisonEvents.length === 1 ? "registro" : "registros"}`;
      renderComparisonSelect();
      await loadComparisonDetail(selectedComparisonId, { keepContent: Boolean(fresh) });
    } catch (error) {
      if (request !== comparisonRequest || activeTool !== "comparacao") return;
      status.textContent = error.message || "Não foi possível carregar o histórico.";
      if (!fresh) renderError(byId("comparacao-planilhas-conteudo"), error, "Falha ao carregar o histórico.");
    }
  }

  function aliasValue(event, old = false) {
    if (event.tipo === "usuario") {
      const login = old ? event.usuario_anterior : event.usuario_novo;
      const name = old ? event.nome_pessoa_anterior : event.nome_pessoa_novo;
      return [login, name].filter(Boolean).join(" — ");
    }
    if (event.tipo === "endereco") {
      const address = old ? event.endereco_anterior : event.endereco_novo;
      if (!address || typeof address !== "object") return "";
      return [address.endereco, address.cidade, address.uf, address.cep, address.cnpj].filter(Boolean).join(" · ");
    }
    return String(old ? event.apelido_anterior || event.valor_anterior || "" : event.apelido_novo || event.valor_novo || "");
  }

  function aliasTypeLabel(type) {
    return ({ apelido: "Apelido", usuario: "Usuário", endereco: "Endereço", aviso_endpoint: "Aviso do Endpoint" })[type]
      || (type ? "Alteração" : "Apelido");
  }

  function aliasActions(event) {
    return app.acoesEventoHistorico(event, aliasEvents, aliasLatest);
  }

  const ALIAS_WARNING_REASONS = {
    usuario_removido: "Usuário logado removido no Endpoint",
    hostname_removido: "Hostname removido no Endpoint",
  };

  function aliasReason(event) {
    return event.tipo === "aviso_endpoint" ? ALIAS_WARNING_REASONS[event.motivo] || "" : "";
  }

  function aliasTimeline(event) {
    const serial = String(event?.serial || "").trim().toUpperCase();
    return aliasEvents.filter(item => String(item.serial || "").trim().toUpperCase() === serial)
      .slice().sort((left, right) => (Date.parse(left.horario || "") || 0) - (Date.parse(right.horario || "") || 0));
  }

  function renderAliasCurrent(section, equipment, error = "") {
    section.replaceChildren(element("h3", "", "Cadastro atual"));
    if (equipment === undefined) {
      section.append(element("p", "ck-nota", "Carregando os dados atuais do cadastro local…"));
      return;
    }
    if (error) {
      section.append(element("p", "ck-nota", `Dados atuais indisponíveis: ${error}`));
      return;
    }
    if (!equipment) {
      section.append(element("p", "ck-nota", "Esta série não foi encontrada na base atual."));
      return;
    }
    renderDetailsInto(section, [
      ["Modelo", equipment.modelo || equipment.tipo || "Não informado"],
      ["Local", equipment.retirada_cidade || "Não informado"],
      ["Apelido atual", equipment.apelido || "Sem apelido"],
    ]);
    if (equipment.apelido) {
      const copy = element("button", "ck-btn ck-btn--secundario ck-btn--sm", "Copiar apelido atual");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        copy.disabled = true;
        try {
          await app.copiarTextoParaAreaTransferencia(equipment.apelido);
          app.showToast("Apelido copiado.", "success");
        } catch (error) {
          app.showToast(error.message || "Não foi possível copiar o apelido.", "error");
        } finally { copy.disabled = false; }
      });
      const actions = element("div", "ck-det__rodape");
      actions.append(copy);
      section.append(actions);
    }
  }

  async function loadAliasCurrentEquipment(event, section, request) {
    const serial = String(event?.serial || "").trim();
    const key = normalize(serial);
    if (!key) return renderAliasCurrent(section, null);
    if (aliasEquipmentCache.has(key)) return renderAliasCurrent(section, aliasEquipmentCache.get(key));
    try {
      const data = await apiFetch(`/api/buscar-expandida?q=${encodeURIComponent(serial)}&limit=20`, {
        errorMessage: "Não foi possível consultar o cadastro atual.",
      });
      const equipment = (Array.isArray(data.items) ? data.items : []).find(item => normalize(item.serial) === key) || null;
      aliasEquipmentCache.set(key, equipment);
      if (request === aliasEquipmentRequest && activeTool === "apelidos" && selectedAliasId === String(event.id || "")) {
        renderAliasCurrent(section, equipment);
      }
    } catch (error) {
      if (request === aliasEquipmentRequest && activeTool === "apelidos" && selectedAliasId === String(event.id || "")) {
        renderAliasCurrent(section, null, error.message || "Não foi possível consultar o cadastro.");
      }
    }
  }

  function renderAliasDetail(event) {
    const target = byId("cockpit-alias-detail");
    const request = ++aliasEquipmentRequest;
    if (!event) return renderEmpty(target, "Selecione uma alteração do histórico.");
    const fields = [
      ["Data", event.horario], ["Série", event.serial], ["Equipamento", event.equipamento],
      ["Tipo", aliasTypeLabel(event.tipo)], ["Campo", event.acao], ["Valor anterior", aliasValue(event, true)],
      ["Valor novo", aliasValue(event)], ["Usuário relacionado", event.usuario_endpoint],
      ["Origem", event.origem], ["Motivo", aliasReason(event) || event.motivo],
    ];
    renderDetails(target, fields);
    const current = element("section", "ck-det-bloco");
    renderAliasCurrent(current, undefined);
    target.append(current);
    const timeline = element("section", "ck-det-bloco");
    timeline.append(element("h3", "", "Histórico deste equipamento"));
    const events = aliasTimeline(event);
    if (!events.length) timeline.append(element("p", "ck-lista__vazio", "Não há outros eventos para esta série."));
    else {
      const list = element("ol", "ck-tempo");
      events.forEach(item => {
        const entry = element("li", "ck-tempo__item");
        const body = element("div", "ck-tempo__corpo");
        const change = element("span", "ck-alteracao");
        if (item.tipo === "aviso_endpoint") change.textContent = `${aliasReason(item) || item.motivo || "Aviso"} ·${item.valor_anterior || "valor não informado"}`;
        else change.append(
          element("span", "ck-alteracao__antes", aliasValue(item, true) || "(vazio)"),
          document.createTextNode("→"),
          element("span", "", aliasValue(item) || "(vazio)"),
        );
        body.append(
          element("strong", "ck-tempo__titulo", `${aliasTypeLabel(item.tipo)} · ${item.acao || "registro"}`),
          element("time", "ck-tempo__meta", item.horario || "Data indisponível"),
          element("span", "ck-tempo__meta", `Autor: ${item.autor || "não informado"} · Origem: ${item.origem || "não informada"}`),
          change,
        );
        entry.append(element("span", "ck-tempo__marca"), body);
        list.append(entry);
      });
      timeline.append(list);
    }
    const actions = element("div", "ck-det__rodape");
    if (event.serial) {
      const openHome = element("button", "ck-btn ck-btn--secundario ck-btn--sm", "Abrir na Home");
      openHome.type = "button";
      openHome.addEventListener("click", () => { void openSerialInHome(event.serial); });
      actions.append(openHome);
    }
    const allowed = aliasActions(event);
    const runAction = (button, action) => async () => {
      actions.querySelectorAll("button").forEach(item => { item.disabled = true; });
      const done = await action(event, button);
      if (done && activeTool === "apelidos") await loadAliases();
      else actions.querySelectorAll("button").forEach(item => { item.disabled = false; });
    };
    if (allowed.desfazer) {
      const undo = element("button", "ck-btn ck-btn--primario ck-btn--sm", "Restaurar anterior");
      undo.type = "button";
      undo.addEventListener("click", runAction(undo, app.desfazerEventoHistoricoApelidos));
      actions.append(undo);
    }
    if (allowed.excluir) {
      const remove = element("button", "ck-btn ck-btn--perigo ck-btn--sm", allowed.rotuloExcluir);
      remove.type = "button";
      remove.addEventListener("click", runAction(remove, app.excluirRegistroHistorico));
      actions.append(remove);
    }
    if (!allowed.desfazer && !allowed.excluir) {
      const reason = event.tipo === "endereco"
        ? "Endereços são atualizados pela planilha Simpress e não podem ser restaurados manualmente."
        : "Há uma alteração mais recente para este campo, ou nenhuma ação está disponível para este registro.";
      actions.append(element("p", "ck-nota", reason));
    }
    target.append(timeline);
    if (actions.childElementCount) target.append(actions);
    void loadAliasCurrentEquipment(event, current, request);
  }

  function filteredAliases() {
    const terms = normalize(byId("cockpit-alias-search").value).split(/\s+/).filter(Boolean);
    const type = byId("cockpit-alias-type").value;
    const actionsOnly = byId("cockpit-alias-actions-only").checked;
    const cutoff = selectedAliasPeriod === "7dias" ? Date.now() - (7 * 24 * 60 * 60 * 1000) : null;
    return aliasEvents.filter(event => {
      if (type !== "todos" && (event.tipo || "apelido") !== type) return false;
      if (actionsOnly) {
        const actions = aliasActions(event);
        if (!actions.desfazer && !actions.excluir) return false;
      }
      if (cutoff !== null) {
        const timestamp = Date.parse(event.horario || "");
        if (!Number.isFinite(timestamp) || timestamp < cutoff) return false;
      }
      const searchable = normalize([event.serial, event.equipamento, event.tipo, event.acao, event.usuario_endpoint, event.horario,
        event.motivo, aliasReason(event), event.origem, aliasValue(event, true), aliasValue(event)].join(" "));
      return terms.every(term => searchable.includes(term));
    });
  }

  function renderAliases() {
    const filtered = filteredAliases();
    const metrics = aliasMetrics(aliasEvents);
    renderKpis(byId("cockpit-alias-kpis"), [
      ["Alterações neste mês", metrics.changesThisMonth], ["Equipamentos afetados", metrics.equipmentAffected],
      ["Fora do padrão", metrics.outOfPattern], ["Apelidos duplicados", metrics.duplicateAliases],
    ]);
    byId("cockpit-alias-count-all").textContent = displayCount(aliasEvents.length);
    const sevenDayCount = aliasEvents.filter(event => {
      const timestamp = Date.parse(event.horario || "");
      return Number.isFinite(timestamp) && timestamp >= Date.now() - (7 * 24 * 60 * 60 * 1000);
    }).length;
    byId("cockpit-alias-count-7days").textContent = displayCount(sevenDayCount);
    byId("cockpit-alias-filters").querySelectorAll("[data-alias-period]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.aliasPeriod === selectedAliasPeriod));
    });
    const target = byId("cockpit-alias-list");
    if (!filtered.length) {
      renderEmpty(target, aliasEvents.length ? "Nenhuma alteração corresponde aos filtros." : "O histórico não contém alterações.");
      renderAliasDetail(null);
      return;
    }
    const selected = filtered.find(event => String(event.id || "") === selectedAliasId) || filtered[0];
    selectedAliasId = String(selected?.id || "");
    target.replaceChildren(...filtered.map(event => {
      const row = element("div", "ck-ferr-item");
      row.setAttribute("role", "listitem");
      const button = element("button", "ck-item ck-ferr-botao");
      button.type = "button";
      button.setAttribute("aria-pressed", String(String(event.id || "") === selectedAliasId));
      button.append(Object.assign(element("strong", "ck-item__serie", event.serial || "Série indisponível"), { title: event.serial || "Série indisponível" }));
      button.append(badge(aliasTypeLabel(event.tipo), "info"));
      button.append(element("small", "ck-item__sub", `${event.horario || "Data indisponível"} · ${event.tipo === "aviso_endpoint"
        ? aliasReason(event) || event.motivo || "Aviso do Endpoint" : `${aliasValue(event, true) || "(vazio)"} → ${aliasValue(event) || "(vazio)"}`}`));
      button.addEventListener("click", () => { selectedAliasId = String(event.id || ""); renderAliases(); });
      row.append(button);
      return row;
    }));
    renderAliasDetail(selected);
  }

  async function loadAliases() {
    const request = ++aliasRequest;
    const target = byId("cockpit-alias-list");
    target.setAttribute("aria-busy", "true");
    renderEmpty(target, "Carregando histórico local…");
    try {
      const data = await apiFetch("/api/historico-alteracoes", { errorMessage: "Não foi possível carregar o histórico de alterações." });
      if (request !== aliasRequest || activeTool !== "apelidos") return;
      aliasEvents = Array.isArray(data.eventos) ? data.eventos : [];
      aliasLatest = app.ultimoRegistroPorCampo(aliasEvents);
      aliasEquipmentCache.clear();
      if (!aliasEvents.some(event => String(event.id || "") === selectedAliasId)) selectedAliasId = String(aliasEvents[0]?.id || "");
      renderAliases();
    } catch (error) {
      if (request === aliasRequest && activeTool === "apelidos") renderError(target, error, "Falha ao carregar o histórico.");
    }
    finally { target.removeAttribute("aria-busy"); }
  }

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function exportAliasesCsv() {
    const rows = [["Data", "Série", "Equipamento", "Tipo", "Ação", "Origem", "Usuário relacionado", "Valor anterior", "Valor novo", "Motivo"], ...filteredAliases().map(event => [
      event.horario, event.serial, event.equipamento, aliasTypeLabel(event.tipo), event.acao,
      event.origem, event.usuario_endpoint, aliasValue(event, true), aliasValue(event), aliasReason(event) || event.motivo,
    ])];
    const blob = new Blob([`\uFEFF${rows.map(row => row.map(csvCell).join(";")).join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download = "historico-de-apelidos.csv";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function recentMonthKeys(count = 3) {
    const now = new Date();
    return Array.from({ length: count }, (_unused, index) => {
      const month = new Date(now.getFullYear(), now.getMonth() - index, 1);
      return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
    });
  }

  function monthLabel(key) {
    const [year, month] = key.split("-").map(Number);
    return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
  }

  function renderMonthlyPeriods(selectedMonth) {
    const target = byId("cockpit-monthly-periods");
    const current = currentMonth();
    target.replaceChildren(...recentMonthKeys().map(key => {
      const button = element("button", "ck-pilula");
      button.type = "button";
      button.setAttribute("aria-pressed", String(key === selectedMonth));
      const label = element("strong", "", monthLabel(key));
      const status = element("small", "", key === current
        ? `Parcial · até ${new Intl.DateTimeFormat("pt-BR").format(new Date())}`
        : "Mês encerrado");
      button.append(label, status);
      button.addEventListener("click", () => {
        const input = byId("cockpit-monthly-month");
        input.value = key;
        renderMonthlyPeriods(key);
        void loadMonthlyReport(key);
      });
      return button;
    }));
  }

  function reportRows(title, rows, labels) {
    const section = element("section", "ck-det-bloco");
    section.append(element("h3", "", title));
    if (!Array.isArray(rows) || !rows.length) {
      section.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return section;
    }
    const list = element("ul", "ck-det-lista");
    rows.forEach(row => list.append(element("li", "", labels(row))));
    section.append(list);
    return section;
  }

  // Barras do gráfico: altura proporcional ao maior valor real (0–100); sem valores, fica tudo em 0.
  function monthlyChartBars(oracle = {}, simpress = {}) {
    const bars = [
      ["Oracle", "abertos", oracle.abertas], ["Oracle", "concluidos", oracle.concluidas],
      ["Simpress", "abertos", simpress.abertas], ["Simpress", "concluidos", simpress.concluidas],
    ].map(([source, kind, value]) => ({ source, kind, value: Number.isFinite(Number(value)) ? Number(value) : 0 }));
    const max = Math.max(1, ...bars.map(bar => bar.value));
    return bars.map(bar => ({ ...bar, height: Math.round((bar.value / max) * 100) }));
  }

  function monthlyChart(bars) {
    const section = element("section", "ck-det-bloco ck-rel__largo");
    section.append(element("h3", "ck-det__titulo", "Ordens do mês"));
    const legend = element("div", "ck-legenda");
    [["abertos", "Abertas"], ["concluidos", "Concluídas"]].forEach(([kind, label]) => {
      const item = element("span", "ck-legenda__item");
      item.append(element("span", `ck-legenda__cor ck-legenda__cor--${kind}`), document.createTextNode(label));
      legend.append(item);
    });
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "ck-graf");
    svg.setAttribute("viewBox", "0 0 400 150");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Ordens do mês: ${bars.map(bar => `${bar.source} ${bar.kind === "abertos" ? "abertas" : "concluídas"} ${bar.value}`).join(", ")}`);
    bars.forEach((bar, index) => {
      const height = Math.max(bar.value > 0 ? 2 : 0, (bar.height / 100) * 140);
      const rect = document.createElementNS(svgNs, "rect");
      rect.setAttribute("class", `ck-graf__${bar.kind}`);
      rect.setAttribute("x", String(index * 100 + 25));
      rect.setAttribute("y", String(145 - height));
      rect.setAttribute("width", "50");
      rect.setAttribute("height", String(height));
      svg.append(rect);
    });
    const base = document.createElementNS(svgNs, "line");
    base.setAttribute("class", "ck-graf__base");
    ["x1", "x2"].forEach((attr, index) => base.setAttribute(attr, index ? "400" : "0"));
    ["y1", "y2"].forEach(attr => base.setAttribute(attr, "145"));
    svg.append(base);
    const labels = element("div", "ck-graf__rotulos");
    bars.forEach(bar => {
      const label = element("span", "", `${bar.source} · ${bar.kind === "abertos" ? "abertas" : "concluídas"}`);
      label.prepend(element("strong", "", displayCount(bar.value)));
      labels.append(label);
    });
    section.append(legend, svg, labels);
    return section;
  }

  function unitsTable(rows) {
    const section = element("section", "ck-det-bloco ck-rel__largo");
    section.append(element("h3", "ck-det__titulo", "Inventário por unidade · base atual"));
    if (!Array.isArray(rows) || !rows.length) {
      section.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return section;
    }
    const table = element("table", "ck-tabela");
    const head = element("tr");
    ["Cidade", "Endereço", "Equipamentos"].forEach((label, index) => head.append(element("th", index === 2 ? "ck-th--dir" : "", label)));
    const thead = element("thead");
    thead.append(head);
    table.append(thead);
    const body = element("tbody");
    rows.forEach(row => {
      const line = element("tr");
      line.append(element("td", "", row[0]), element("td", "", row[1] || "—"), element("td", "ck-td--dir", displayCount(row[2])));
      body.append(line);
    });
    table.append(body);
    section.append(table);
    return section;
  }

  // Cartão compacto: número grande + rótulo por par [rótulo, valor]; `extra` anexa um bloco opcional.
  function statCard(title, pairs, extra) {
    const section = element("section", "ck-det-bloco ck-rel__cartao");
    section.append(element("h3", "", title));
    if (!pairs.length) section.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
    else {
      const grid = element("dl", "ck-rel__numeros");
      pairs.forEach(([label, value]) => {
        const cell = element("div", "ck-rel__numero");
        cell.append(element("dt", "ck-rel__rotulo", label), element("dd", "ck-rel__valor", displayCount(value)));
        grid.append(cell);
      });
      section.append(grid);
    }
    if (extra && extra.querySelector("li")) section.append(extra);
    return section;
  }

  function renderMonthly(report) {
    const inventory = report.inventario || {};
    const comparison = report.comparacao || {};
    const tickets = report.os || {};
    const oracle = tickets.oracle || {};
    const simpress = tickets.simpress || {};
    renderKpis(byId("cockpit-monthly-kpis"), [
      ["Ordens abertas", `${displayCount(oracle.abertas)} / ${displayCount(simpress.abertas)}`, "Oracle / Simpress"],
      ["Ordens concluídas", `${displayCount(oracle.concluidas)} / ${displayCount(simpress.concluidas)}`, "Oracle / Simpress · percentual indisponível"],
      ["Tempo médio até fechar", "—", "Não calculado sem datas individuais compatíveis"],
      ["Transportes", "—", "Esta fonte não fornece a contagem mensal"],
    ]);
    const details = byId("cockpit-monthly-details");
    const counts = comparison.contagens || {};
    const insufficient = Array.isArray(tickets.dados_insuficientes) ? tickets.dados_insuficientes : [];
    const left = element("div", "ck-rel__col");
    left.append(monthlyChart(monthlyChartBars(oracle, simpress)), unitsTable(inventory.por_unidade));
    const right = element("div", "ck-rel__col");
    right.append(
      statCard("Resumo da base atual", [
        ["Equipamentos", inventory.total], ["Unidades", inventory.unidades], ["Atualizações no mês", comparison.atualizacoes_no_mes],
      ]),
      statCard("Inventário por tipo", Array.isArray(inventory.por_tipo) ? inventory.por_tipo : []),
      statCard("Divergências", Object.entries(counts), reportRows("Linhas da comparação", comparison.linhas, row => `${row.secao} · ${row.serie || "Série indisponível"} · ${row.hostname || "Hostname indisponível"}`)),
      statCard("Ordens do mês", [
        ["Oracle abertas", oracle.abertas], ["Oracle concluídas", oracle.concluidas], ["Oracle pendentes", oracle.pendentes],
        ["Simpress abertas", simpress.abertas], ["Simpress concluídas", simpress.concluidas], ["Simpress pendentes", simpress.pendentes],
      ], reportRows("Linhas das ordens", tickets.linhas, row => `${row.fonte} · ${row.identificador || "Identificador indisponível"} · ${row.serie || "Série indisponível"} · ${(row.situacao || []).join(", ") || "Sem classificação no período"}`)),
    );
    const parts = [];
    if (insufficient.length) {
      const notice = element("p", "ck-rel__aviso ck-rel__largo", `${insufficient.length} registro(s) com dados insuficientes nas ordens do mês.`);
      notice.setAttribute("role", "status");
      notice.title = insufficient.map(row => `${row.fonte} · ${row.serie || "Série indisponível"} · ${(row.identificadores || []).join(", ")} · ${row.motivo || "Motivo indisponível"}`).join("\n");
      parts.push(notice);
    }
    details.replaceChildren(...parts, left, right);
    byId("cockpit-monthly-preview").textContent = monthlyPreviewText(report);
    const cutoff = report.mes?.data_corte;
    const cutoffLabel = /^\d{4}-\d{2}-\d{2}$/.test(cutoff || "")
      ? new Intl.DateTimeFormat("pt-BR").format(new Date(`${cutoff}T00:00:00`)) : "data indisponível";
    const period = report.mes?.parcial ? `Parcial até ${cutoffLabel}` : "Mês encerrado";
    byId("cockpit-monthly-status").textContent = `Relatório de ${report.mes?.label || report.mes?.key || "mês selecionado"} · ${period} · gerado ${report.gerado_em || "data indisponível"}`;
  }

  async function loadMonthlyReport(month) {
    const current = ++monthlyRequest;
    const target = byId("cockpit-monthly-details");
    byId("cockpit-monthly-preview").textContent = "";
    byId("cockpit-monthly-kpis").replaceChildren();
    byId("cockpit-monthly-copy").disabled = true;
    renderMonthlyPeriods(month);
    byId("cockpit-monthly-status").textContent = "Carregando dados do relatório…";
    renderEmpty(target, "Carregando relatório mensal local…");
    try {
      const report = await apiFetch(`/api/relatorio-mensal/dados?mes=${encodeURIComponent(month)}`, { errorMessage: "Não foi possível carregar o relatório mensal." });
      if (current !== monthlyRequest || activeTool !== "relatorio") return;
      renderMonthly(report);
      byId("cockpit-monthly-copy").disabled = false;
    } catch (error) {
      if (current !== monthlyRequest || activeTool !== "relatorio") return;
      byId("cockpit-monthly-status").textContent = error.message || "Falha ao carregar o relatório.";
      renderError(target, error, "Falha ao carregar o relatório.");
      byId("cockpit-monthly-preview").textContent = "";
    }
  }

  async function copyMonthlyPreview() {
    const text = byId("cockpit-monthly-preview").textContent;
    if (!text) return;
    try {
      await app.copiarTextoParaAreaTransferencia(text);
      byId("cockpit-monthly-status").textContent = "Prévia mensal copiada para a área de transferência.";
      app.showToast("Resumo mensal copiado.", "success");
    } catch (error) {
      byId("cockpit-monthly-status").textContent = error.message || "Não foi possível copiar o resumo.";
      app.showToast(error.message || "Não foi possível copiar o resumo.", "error");
    }
  }

  async function exportMonthlyWorkbook() {
    const month = byId("cockpit-monthly-month").value;
    const input = byId("relatorio-mensal-mes");
    if (!input || !month) return;
    input.value = month;
    const button = byId("cockpit-monthly-export");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      await app.exportarRelatorioMensal();
      const legacyStatus = byId("status-relatorio-mensal")?.textContent?.trim();
      byId("cockpit-monthly-status").textContent = legacyStatus || "Planilha Exportada com Sucesso!";
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  // ---- Telas v2: Atualizar planilhas e Unidades ----
  const historyFormat = context.historyFormat || globalThis.SimpressHistoryFormat || {};

  function displayDate(value) {
    return typeof historyFormat.formatarHorarioHistorico === "function" ? historyFormat.formatarHorarioHistorico(value) : String(value || "—");
  }

  function displaySource(value) {
    const text = String(value || "");
    return text && typeof historyFormat.formatarNomeFonteHistorico === "function" ? historyFormat.formatarNomeFonteHistorico(text) : text;
  }

  function renderPares(target, entries) {
    target.replaceChildren(...entries.map(([label, value]) => {
      const pair = element("div", "ck-par");
      const description = element("dd");
      if (value instanceof Node) description.append(value); // o nó do CNPJ leva o lápis de edição
      else description.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
      pair.append(element("dt", "", label), description);
      return pair;
    }));
  }

  // Linha de tabela; com onSelect vira selecionável por clique, Enter ou Espaço.
  function tableRow(cells, { selected = false, onSelect = null } = {}) {
    const row = element("tr");
    if (onSelect) {
      row.tabIndex = 0;
      row.setAttribute("aria-selected", String(selected));
      row.addEventListener("click", onSelect);
      row.addEventListener("keydown", event => {
        // Botões dentro da linha (ex.: lápis do CNPJ) tratam Enter e Espaço sozinhos.
        if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onSelect();
      });
    }
    cells.forEach(([label, content, className]) => {
      const cell = element("td", className || "");
      cell.dataset.label = label;
      cell.append(content instanceof Node ? content : document.createTextNode(String(content ?? "—")));
      row.append(cell);
    });
    return row;
  }

  function tableEmpty(body, columns, message) {
    const cell = element("td", "ck-lista__vazio", message);
    cell.colSpan = columns;
    const row = element("tr");
    row.append(cell);
    body.replaceChildren(row);
  }

  async function fetchUpdateEvents() {
    const data = await apiFetch("/api/historico-comparacoes", { errorMessage: "Não foi possível carregar o histórico de planilhas." });
    return (Array.isArray(data.eventos) ? data.eventos : []).filter(event => event.id && !event.somente_anotacoes_sincronizadas);
  }

  function inventoryUpdates(events) { return events.filter(event => event.tipo !== "restauracao"); }

  function eventFiles(event) {
    const files = event?.arquivos_enviados || event?.comparacao?.arquivos_enviados || {};
    return { endpoint: displaySource(files.endpoint), detalhes: displaySource(files.detalhes) };
  }

  // Planilhas
  function renderSheetDetail() {
    const row = sheetsRows.find(item => item.key === selectedSheetKey);
    byId("cockpit-sheets-detail-title").textContent = row ? row.label : "—";
    byId("cockpit-sheets-detail-sub").textContent = row ? (row.file || "Arquivo não informado") : "Selecione uma planilha.";
    byId("cockpit-sheets-detail-badge").replaceChildren(...(row ? [badge(row.situation, row.file ? "success" : "warning")] : []));
  }

  function renderSheetRows() {
    const body = byId("cockpit-sheets-list-body");
    if (!sheetsRows.length) return tableEmpty(body, 5, "Nenhuma atualização no histórico local.");
    body.replaceChildren(...sheetsRows.map(row => tableRow([
      ["Planilha", row.label], ["Arquivo atual", row.file || "—"], ["Linhas", displayCount(row.total), "ck-td--dir"],
      ["Atualizado", displayDate(row.updatedAt)], ["Situação", badge(row.situation, row.file ? "success" : "warning")],
    ], { selected: row.key === selectedSheetKey, onSelect: () => { selectedSheetKey = row.key; renderSheetRows(); renderSheetDetail(); } })));
  }

  async function loadSheets() {
    const request = ++sheetsRequest;
    const status = byId("cockpit-sheets-status");
    status.textContent = "Carregando…";
    renderKpis(byId("cockpit-sheets-kpis"), []);
    tableEmpty(byId("cockpit-sheets-list-body"), 5, "Carregando…");
    try {
      const events = inventoryUpdates(await fetchUpdateEvents());
      if (request !== sheetsRequest || activeTool !== "planilhas") return;
      if (!events.length) {
        sheetsRows = [];
        status.textContent = "Nenhuma atualização no histórico local.";
        renderSheetRows();
        renderSheetDetail();
        return;
      }
      const data = await apiFetch(`/api/historico-comparacoes/${encodeURIComponent(events[0].id)}`, { errorMessage: "Não foi possível abrir a última atualização." });
      if (request !== sheetsRequest || activeTool !== "planilhas") return;
      const latest = data.evento || events[0];
      const metrics = comparisonMetrics(latest);
      const files = eventFiles(latest);
      sheetsRows = [
        { key: "endpoint", label: "No Endpoint", file: files.endpoint, total: metrics.endpoint },
        { key: "detalhes", label: "na Simpress", file: files.detalhes, total: metrics.simpress },
      ].map(row => ({ ...row, updatedAt: latest.horario, situation: row.file ? "Atualizada" : "Sem arquivo" }));
      if (!sheetsRows.some(row => row.key === selectedSheetKey)) selectedSheetKey = sheetsRows[0].key;
      renderKpis(byId("cockpit-sheets-kpis"), [
        ["Última atualização", displayDate(latest.horario)], ["Equipamentos na Simpress", metrics.simpress],
        ["Equipamentos no Endpoint", metrics.endpoint], ["Atualizações no histórico", events.length],
      ]);
      status.textContent = `Última atualização em ${displayDate(latest.horario)}`;
      renderSheetRows();
      renderSheetDetail();
    } catch (error) {
      if (request !== sheetsRequest || activeTool !== "planilhas") return;
      status.textContent = error.message || "Não foi possível carregar as planilhas.";
      tableEmpty(byId("cockpit-sheets-list-body"), 5, status.textContent);
    }
  }

  // Unidades
  function unitName(unit) { return unit?.label || unit?.cidade || "Unidade sem nome"; }

  function filteredUnits() {
    const terms = normalize(byId("cockpit-units-search").value).split(/\s+/).filter(Boolean);
    return unitsList.map((unit, index) => ({ unit, key: String(unit?.id ?? index) })).filter(({ unit }) => {
      const searchable = normalize([unitName(unit), unit.cidade, unit.cnpj, unit.endereco].join(" "));
      return terms.every(term => searchable.includes(term));
    });
  }

  function selectedUnit() { return unitsList.find((unit, index) => String(unit?.id ?? index) === selectedUnitKey); }

  // Lápis ao fim do CNPJ: abre o formulário preenchido com o foco no campo CNPJ.
  function cnpjWithPencil(unit) {
    const wrap = element("span", "ck-det__linha", "");
    // Sem id numérico o formulário não acha a unidade: mostra só o CNPJ.
    if (unit.id === null || unit.id === undefined || !Number.isFinite(Number(unit.id))) { wrap.append(element("span", "", unit.cnpj || "—")); return wrap; }
    const edit = element("button", "ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm");
    const label = `Editar CNPJ da unidade ${unit.cidade || unitName(unit)}`;
    edit.type = "button";
    edit.title = label;
    edit.setAttribute("aria-label", label);
    const svgNs = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(svgNs, "svg");
    icon.setAttribute("class", "ck-ico ck-ico--sm");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    icon.appendChild(document.createElementNS(svgNs, "use")).setAttribute("href", "#i-pencil");
    edit.append(icon, element("span", "ck-sr", label));
    edit.addEventListener("click", () => app.editarUnidade(Number(unit.id), "form-unidade-cnpj"));
    wrap.append(element("span", "", unit.cnpj || "—"), edit);
    return wrap;
  }

  function unitNameCell(unit) {
    const wrap = element("span", "ck-det__linha", unitName(unit));
    if (unit.is_sede) wrap.append(badge("SEDE", "success"));
    return wrap;
  }

  function renderUnits() {
    const visible = filteredUnits();
    const body = byId("cockpit-units-list-body");
    if (!visible.some(({ key }) => key === selectedUnitKey)) selectedUnitKey = visible[0]?.key || "";
    if (!visible.length) tableEmpty(body, 3, unitsList.length ? "Nenhuma unidade corresponde à busca." : "O catálogo não contém unidades.");
    else {
      body.replaceChildren(...visible.map(({ unit, key }) => tableRow([
        ["Unidade", unitNameCell(unit)], ["Cidade", unit.cidade || "—"], ["CNPJ", cnpjWithPencil(unit)],
      ], { selected: key === selectedUnitKey, onSelect: () => { selectedUnitKey = key; renderUnits(); } })));
    }
    byId("cockpit-units-status").textContent = `${visible.length} de ${unitsList.length} ${unitsList.length === 1 ? "unidade" : "unidades"}`;
    const selected = visible.find(({ key }) => key === selectedUnitKey)?.unit;
    byId("cockpit-units-detail-title").textContent = selected ? unitName(selected) : "—";
    byId("cockpit-units-detail-sub").textContent = selected ? ([selected.cidade, selected.uf].filter(Boolean).join("/") || "Cidade não informada") : "Selecione uma unidade.";
    byId("cockpit-units-detail-badge").replaceChildren(...(selected?.is_sede ? [badge("SEDE", "success")] : []));
    byId("cockpit-units-copy-cnpj").disabled = !selected;
    byId("cockpit-units-copy-cep").disabled = !selected;
    renderPares(byId("cockpit-units-detail-pares"), selected ? [
      ["Cidade", selected.cidade], ["UF", selected.uf], ["Endereço", selected.endereco], ["CEP", selected.cep], ["CNPJ", cnpjWithPencil(selected)],
    ] : []);
  }

  async function loadUnits() {
    const request = ++unitsRequest;
    const status = byId("cockpit-units-status");
    status.textContent = "Carregando…";
    renderKpis(byId("cockpit-units-kpis"), []);
    tableEmpty(byId("cockpit-units-list-body"), 3, "Carregando…");
    try {
      const data = await apiFetch("/api/unidades", { errorMessage: "Não foi possível carregar o catálogo de unidades." });
      if (request !== unitsRequest || activeTool !== "unidades") return;
      unitsList = Array.isArray(data) ? data : [];
      renderKpis(byId("cockpit-units-kpis"), [
        ["Unidades", unitsList.length], ["Cidades", new Set(unitsList.map(unit => normalize(unit.cidade)).filter(Boolean)).size],
        ["Com CNPJ", unitsList.filter(unit => unit.cnpj).length],
      ]);
      renderUnits();
    } catch (error) {
      if (request !== unitsRequest || activeTool !== "unidades") return;
      status.textContent = error.message || "Não foi possível carregar as unidades.";
      tableEmpty(byId("cockpit-units-list-body"), 3, status.textContent);
    }
  }

  function ensureEvents() {
    if (eventsBound || typeof document === "undefined") return;
    const root = byId("cockpit-tool-panels");
    if (!root) return;
    byId("cockpit-tickets-search").addEventListener("input", filterTicketTable);
    byId("cockpit-tickets-relation").addEventListener("change", filterTicketTable);
    byId("cockpit-tickets-attention").addEventListener("change", filterTicketTable);
    byId("cockpit-tickets-clear").addEventListener("click", clearTicketFilters);
    byId("cockpit-tickets-triage").addEventListener("click", selectTicketTriage);
    byId("cockpit-comparison-new").addEventListener("click", openNewComparison);
    byId("cockpit-comparison-event").addEventListener("change", event => {
      selectedComparisonId = String(event.currentTarget.value || "");
      void loadComparisonDetail(selectedComparisonId);
    });
    byId("cockpit-comparison-legacy").addEventListener("click", app.abrirModalHistoricoComparacoes);
    byId("cockpit-alias-search").addEventListener("input", renderAliases);
    byId("cockpit-alias-type").addEventListener("change", renderAliases);
    byId("cockpit-alias-filters").addEventListener("click", event => {
      const button = event.target.closest("[data-alias-period]");
      if (!button || button.disabled) return;
      selectedAliasPeriod = button.dataset.aliasPeriod;
      renderAliases();
    });
    byId("cockpit-alias-export").addEventListener("click", exportAliasesCsv);
    byId("cockpit-alias-actions-only").addEventListener("change", renderAliases);
    byId("cockpit-alias-clear").addEventListener("click", () => {
      byId("cockpit-alias-search").value = "";
      byId("cockpit-alias-type").value = "todos";
      byId("cockpit-alias-actions-only").checked = false;
      selectedAliasPeriod = "todos";
      renderAliases();
    });
    byId("cockpit-monthly-month").addEventListener("change", event => loadMonthlyReport(event.currentTarget.value));
    byId("cockpit-monthly-copy").addEventListener("click", copyMonthlyPreview);
    byId("cockpit-monthly-export").addEventListener("click", exportMonthlyWorkbook);
    byId("cockpit-sheets-refresh").addEventListener("click", loadSheets);
    byId("cockpit-units-search").addEventListener("input", renderUnits);
    byId("cockpit-units-copy-cnpj").addEventListener("click", () => app.copiarDadoUnidade(selectedUnit()?.cnpj, "CNPJ"));
    byId("cockpit-units-copy-cep").addEventListener("click", () => app.copiarDadoUnidade(selectedUnit()?.cep, "CEP"));
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented || root.hidden) return;
      const modal = document.querySelector('[data-accessible-modal="true"]:not(.hidden)');
      if (!modal) { event.preventDefault(); closePanel(); }
    });
    // O destaque dos botões da barra (Chamados e OS) segue o painel, qualquer que seja o caminho que o esconda.
    if (typeof MutationObserver !== "undefined") new MutationObserver(() => {
      if (root.hidden) syncPanelButtons("");
    }).observe(root, { attributes: true, attributeFilter: ["hidden"] });
    eventsBound = true;
  }

  // Botões da barra principal (.ck-aba--painel) ficam pressionados enquanto o painel deles está aberto.
  function syncPanelButtons(tool) {
    document.querySelectorAll(".ck-aba--painel[data-cockpit-tool]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.cockpitTool === tool));
    });
  }

  function closePanel(restoreFocus = true) {
    const root = byId("cockpit-tool-panels");
    syncPanelButtons("");
    if (!root || root.hidden) return;
    root.hidden = true;
    byId("main-content").hidden = false;
    byId("cockpit-tools-dropdown").open = false;
    activeTool = "";
    previousTool = "";
    delete byId("cockpit-tools-dropdown").dataset.activeTool;
    if (restoreFocus && returnTarget?.isConnected) returnTarget.focus();
    else if (restoreFocus) byId("main-content").focus();
    returnTarget = null;
    const skipLink = document.querySelector(".skip-link");
    if (skipLink && skipLinkHref !== null) skipLink.setAttribute("href", skipLinkHref);
    skipLinkHref = null;
  }

  async function openPanel(tool) {
    if (!Object.hasOwn(toolInfo, tool)) return;
    ensureEvents();
    const root = byId("cockpit-tool-panels");
    if (!root) return;
    const activeElement = document.activeElement;
    if (!activeTool) returnTarget = activeElement?.closest?.(".ck-aba--painel") || byId("cockpit-tools-trigger") || activeElement;
    if (activeTool && activeTool !== tool && !goingBack) previousTool = activeTool;
    activeTool = tool;
    byId("cockpit-tools-dropdown").dataset.activeTool = tool;
    syncPanelButtons(tool);
    byId("main-content").hidden = true;
    const skipLink = document.querySelector(".skip-link");
    if (skipLink) {
      if (skipLinkHref === null) skipLinkHref = skipLink.getAttribute("href") || "#main-content";
      skipLink.setAttribute("href", "#cockpit-tool-title");
    }
    root.hidden = false;
    root.scrollTop = 0; // o cabeçalho rola junto com o painel; cada painel abre no topo
    byId("cockpit-tools-dropdown").open = false;
    byId("cockpit-tool-title").textContent = toolInfo[tool][0];
    byId("cockpit-tool-kbd").textContent = toolKeys[tool] || "";
    byId("cockpit-tool-kbd").hidden = !toolKeys[tool];
    byId("cockpit-tool-subtitle").textContent = toolInfo[tool][1];
    document.querySelectorAll("[data-cockpit-tool-panel]").forEach(panel => { panel.hidden = panel.dataset.cockpitToolPanel !== tool; });
    byId("cockpit-tool-title").focus();
    if (tool === "chamados") await loadTickets();
    if (tool === "comparacao") await loadComparisons();
    if (tool === "apelidos") await loadAliases();
    if (tool === "relatorio") {
      const input = byId("cockpit-monthly-month");
      if (!input.value) input.value = currentMonth();
      input.max = currentMonth();
      renderMonthlyPeriods(input.value);
      await loadMonthlyReport(input.value);
    }
    if (tool === "planilhas") await loadSheets();
    if (tool === "unidades") {
      app.toggleFormNovaUnidade?.(false);
      await loadUnits();
    }
  }

  // "OS deste equipamento" (Transporte): abre Chamados já filtrado pela série; a busca filtra a tabela de OS.
  async function abrirChamadosDoEquipamento() {
    const search = byId("cockpit-tickets-search");
    if (search) search.value = String(byId("transfer-serial")?.textContent || "").trim().toUpperCase();
    await openPanel("chamados");
    search?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Botão da OS (tabela de Chamados): garante o painel aberto, mostra a linha da OS, abre o Andamento da série e destaca.
  async function abrirChamadoDaOs(_fontes, serie, os) {
    if (activeTool !== "chamados") await openPanel("chamados");
    const host = byId("cockpit-tickets-os");
    const findRow = () => [...host.querySelectorAll("tbody tr[data-serial]")]
      .find(row => row.dataset.serial === String(serie) && (!os || row.dataset.os === String(os)));
    let row = findRow();
    if (row?.hidden) {
      clearTicketFilters();
      row = findRow();
    }
    if (!row) return;
    const toggle = [...host.querySelectorAll(".ck-os__andamento-btn")].find(button => button.dataset.serie === String(serie));
    if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click();
    destacarLinhaCockpit(row);
  }

  // Voltar: retorna ao painel aberto antes; sem anterior (ou com restoreFocus=false) fecha para a tela principal.
  function goBack(restoreFocus = true) {
    const target = previousTool;
    if (target && restoreFocus !== false) {
      previousTool = "";
      goingBack = true;
      const opened = openPanel(target);
      goingBack = false;
      return opened;
    }
    return closePanel(restoreFocus);
  }

  return {
    abrirPainelCockpit: openPanel,
    abrirComparacaoDaSerie,
    abrirChamadosDoEquipamento,
    abrirChamadoDaOs,
    destacarLinhaCockpit,
    fecharPainelCockpit: goBack,
    recarregarUnidadesCockpit: loadUnits,
    filterTicketRecords,
    mostrarResultadoNaAbaComparacao,
    comparisonMetrics,
    aliasMetrics,
    monthlyPreviewText,
    monthlyChartBars,
  };
});
