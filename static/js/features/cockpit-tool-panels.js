/** Dedicated Cockpit workspaces for the tools in the nine-dot menu. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).cockpitToolPanels = factory;
})(typeof window !== "undefined" ? window : globalThis, function createCockpitToolPanels(context) {
  "use strict";
  const { app, apiFetch } = context;
  const toolKeys = { chamados: "F5", comparacao: "F6", apelidos: "F7", relatorio: "F8" };
  const toolInfo = {
    chamados: ["Chamados", "Acompanhamento local de ordens relacionadas por série."],
    comparacao: ["Comparação", "Resultados salvos da comparação entre as bases locais."],
    apelidos: ["Histórico de apelidos", "Alterações registradas para equipamentos e usuários."],
    relatorio: ["Relatório mensal", "Consolidação do mês usando os dados locais disponíveis."],
    planilhas: ["Atualizar planilhas", "Última atualização das bases locais de equipamentos."],
    "historico-planilhas": ["Histórico planilhas", "Atualizações de planilhas já comparadas e salvas localmente."],
    evolucao: ["Evolução das atualizações", "Variação entre as duas últimas atualizações de inventário."],
    unidades: ["Catálogo de unidades", "Unidades Sebrae cadastradas para entrega e retirada."],
    "sebrae-historico": ["Histórico de importações do Dashboard Sebrae", "Importações do Dashboard e buscas de chamados novos, com o que mudou em cada uma."],
    // Sem loader em openPanel: recarregar a lista zeraria as edições dos chamados antigos (sebrae-dashboard.js).
    "sebrae-chamados": ["Chamados Sebrae", "Preencha os chamados novos e antigos, exporte as linhas e atualize o Dashboard."],
  };
  const relationLabels = {
    conferida: "Conferida", divergente: "Divergente", somente_simpress: "Só Simpress",
    somente_oracle: "Só Oracle", sem_os: "Sem OS",
  };
  const relationTones = { conferida: "success", divergente: "error", somente_simpress: "warning", somente_oracle: "warning" };
  let eventsBound = false;
  let activeTool = "";
  let previousTool = "";
  let goingBack = false;
  let sheetsRequest = 0;
  let sheetsRows = [];
  let selectedSheetKey = "";
  let historyEvents = [];
  let historyRequest = 0;
  let historyDetailRequest = 0;
  let selectedHistoryId = "";
  const historyDetailCache = new Map();
  let evolutionRequest = 0;
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
      ["Só Simpress", summary.somente_simpress], ["Só Oracle", summary.somente_oracle], ["Sem OS", summary.sem_os],
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
      titulo: "Ordens de serviço por série", semBusca: true, incluirSemOs: true,
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

  function aliasCanUndo(event) {
    if (!event || ![undefined, null, "", "apelido", "usuario"].includes(event.tipo)) return false;
    const serial = String(event.serial || "").trim().toUpperCase();
    const type = event.tipo || "apelido";
    const latest = aliasEvents.find(item => String(item.serial || "").trim().toUpperCase() === serial && (item.tipo || "apelido") === type);
    return Boolean(serial && latest?.id === event.id);
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
      ["Origem", event.origem], ["Motivo", event.motivo],
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
        if (item.tipo === "aviso_endpoint") change.textContent = `${item.motivo || "Aviso"} · ${item.valor_anterior || "valor não informado"}`;
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
    if (aliasCanUndo(event) && typeof app.desfazerEventoHistoricoApelidos === "function") {
      const undo = element("button", "ck-btn ck-btn--primario ck-btn--sm", "Restaurar anterior");
      undo.type = "button";
      undo.addEventListener("click", async () => {
        undo.disabled = true;
        const restored = await app.desfazerEventoHistoricoApelidos(event, undo);
        if (restored && activeTool === "apelidos") await loadAliases();
        else undo.disabled = false;
      });
      actions.append(undo);
    } else {
      const reason = event.tipo === "endereco"
        ? "Endereços são atualizados pela planilha Simpress e não podem ser restaurados manualmente."
        : event.tipo === "aviso_endpoint"
          ? "Avisos do Endpoint seguem a ação de remoção do histórico completo; não há restauração deste tipo."
          : "Há uma alteração mais recente para este campo, ou a ação de restauração não está disponível.";
      actions.append(element("p", "ck-nota", reason));
    }
    target.append(timeline);
    if (actions.childElementCount) target.append(actions);
    void loadAliasCurrentEquipment(event, current, request);
  }

  function filteredAliases() {
    const terms = normalize(byId("cockpit-alias-search").value).split(/\s+/).filter(Boolean);
    const type = byId("cockpit-alias-type").value;
    const cutoff = selectedAliasPeriod === "7dias" ? Date.now() - (7 * 24 * 60 * 60 * 1000) : null;
    return aliasEvents.filter(event => {
      if (type !== "todos" && (event.tipo || "apelido") !== type) return false;
      if (cutoff !== null) {
        const timestamp = Date.parse(event.horario || "");
        if (!Number.isFinite(timestamp) || timestamp < cutoff) return false;
      }
      const searchable = normalize([event.serial, event.equipamento, event.tipo, event.acao, event.usuario_endpoint, event.horario,
        event.motivo, event.origem, aliasValue(event, true), aliasValue(event)].join(" "));
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
        ? event.motivo || "Aviso do Endpoint" : `${aliasValue(event, true) || "(vazio)"} → ${aliasValue(event) || "(vazio)"}`}`));
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
      event.origem, event.usuario_endpoint, aliasValue(event, true), aliasValue(event), event.motivo,
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

  // ---- Telas v2: Atualizar planilhas, Histórico planilhas, Evolução e Unidades ----
  const svgNs = "http://www.w3.org/2000/svg";
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
      pair.append(element("dt", "", label), element("dd", "", value === null || value === undefined || value === "" ? "—" : value));
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
        if (event.key !== "Enter" && event.key !== " ") return;
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

  function summaryCount(summary, ...keys) {
    return keys.reduce((total, key) => total + (Number.isFinite(summary?.[key]) ? summary[key] : 0), 0);
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

  // Histórico planilhas
  function filteredHistory() {
    const terms = normalize(byId("cockpit-sheets-history-search").value).split(/\s+/).filter(Boolean);
    return historyEvents.filter(event => {
      const files = eventFiles(event);
      const searchable = normalize([displayDate(event.horario), event.horario, files.endpoint, files.detalhes].join(" "));
      return terms.every(term => searchable.includes(term));
    });
  }

  function renderHistoryRows() {
    const visible = filteredHistory();
    const body = byId("cockpit-sheets-history-list-body");
    if (!visible.some(event => String(event.id) === selectedHistoryId)) selectedHistoryId = String(visible[0]?.id || "");
    if (!visible.length) {
      tableEmpty(body, 6, historyEvents.length ? "Nenhum registro corresponde à busca." : "O histórico não contém atualizações.");
    } else {
      body.replaceChildren(...visible.map(event => {
        const summary = event.resumo || {};
        const files = eventFiles(event);
        const id = String(event.id);
        return tableRow([
          ["Data", displayDate(event.horario)], ["Arquivo", [files.endpoint, files.detalhes].filter(Boolean).join(" · ") || "—"],
          ["Equipamentos", displayCount(Number.isFinite(summary.total_endpoint) ? summary.total_endpoint : null), "ck-td--dir"],
          ["Iguais", displayCount(historyDetailCache.get(id)?.iguais ?? null), "ck-td--dir"],
          ["Divergentes", displayCount(summaryCount(summary, "divergencias_local")), "ck-td--dir"],
          ["Sem correspondência", displayCount(summaryCount(summary, "ausentes_no_endpoint", "ausentes_em_detalhes")), "ck-td--dir"],
        ], { selected: id === selectedHistoryId, onSelect: () => { selectedHistoryId = id; renderHistoryRows(); } });
      }));
    }
    byId("cockpit-sheets-history-status").textContent = `${visible.length} ${visible.length === 1 ? "registro" : "registros"}`;
    void renderHistoryDetail(visible.find(event => String(event.id) === selectedHistoryId));
  }

  async function renderHistoryDetail(event) {
    const request = ++historyDetailRequest;
    const exportButton = byId("cockpit-sheets-history-export");
    const note = byId("cockpit-sheets-history-detail-nota");
    note.hidden = true;
    byId("cockpit-sheets-history-detail-tag").replaceChildren();
    if (!event) {
      byId("cockpit-sheets-history-detail-title").textContent = "—";
      byId("cockpit-sheets-history-detail-sub").textContent = "Selecione um registro.";
      byId("cockpit-sheets-history-detail-pares").replaceChildren();
      exportButton.disabled = true;
      return;
    }
    byId("cockpit-sheets-history-detail-title").textContent = displayDate(event.horario);
    byId("cockpit-sheets-history-detail-sub").textContent = String(event.id);
    byId("cockpit-sheets-history-detail-tag").replaceChildren(badge(event.tipo === "restauracao" ? "Restauração" : "Atualização", event.tipo === "restauracao" ? "warning" : "neutral"));
    exportButton.disabled = !/^\d{4}-\d{2}-\d{2}$/.test(String(event.horario || "").slice(0, 10)) || typeof app.exportarResultadoComparacaoPlanilhas !== "function";
    renderPares(byId("cockpit-sheets-history-detail-pares"), [["Situação", "Carregando…"]]);
    try {
      const data = await apiFetch(`/api/historico-comparacoes/${encodeURIComponent(event.id)}`, { errorMessage: "Não foi possível abrir este registro." });
      if (request !== historyDetailRequest || activeTool !== "historico-planilhas") return;
      const detail = data.evento || event;
      const metrics = comparisonMetrics(detail);
      const files = eventFiles(detail);
      const known = historyDetailCache.has(String(event.id));
      historyDetailCache.set(String(event.id), metrics);
      renderPares(byId("cockpit-sheets-history-detail-pares"), [
        ["No Endpoint", files.endpoint], ["na Simpress", files.detalhes],
        ["Equipamentos na Simpress", displayCount(metrics.simpress)], ["Equipamentos no Endpoint", displayCount(metrics.endpoint)],
        ["Iguais", displayCount(metrics.iguais)], ["Divergência de local", displayCount(metrics.divergenciaLocal)],
        ["Divergência de usuário", displayCount(metrics.divergenciaUsuario)],
        ["Só Simpress", displayCount(metrics.soSimpress)], ["Só Endpoint", displayCount(metrics.soEndpoint)],
      ]);
      if (!known) {
        const cell = byId("cockpit-sheets-history-list-body").querySelector('tr[aria-selected="true"] td[data-label="Iguais"]');
        if (cell) cell.textContent = displayCount(metrics.iguais);
      }
    } catch (error) {
      if (request !== historyDetailRequest || activeTool !== "historico-planilhas") return;
      renderPares(byId("cockpit-sheets-history-detail-pares"), []);
      byId("cockpit-sheets-history-detail-nota-texto").textContent = error.message || "Não foi possível abrir este registro.";
      note.hidden = false;
    }
  }

  async function loadHistory() {
    const request = ++historyRequest;
    const status = byId("cockpit-sheets-history-status");
    status.textContent = "Carregando…";
    renderKpis(byId("cockpit-sheets-history-kpis"), []);
    tableEmpty(byId("cockpit-sheets-history-list-body"), 6, "Carregando…");
    try {
      const events = await fetchUpdateEvents();
      if (request !== historyRequest || activeTool !== "historico-planilhas") return;
      historyEvents = events;
      const latest = inventoryUpdates(events)[0];
      renderKpis(byId("cockpit-sheets-history-kpis"), [
        ["Registros no histórico", events.length], ["Última atualização", latest ? displayDate(latest.horario) : "—"],
        ["Divergentes na última", latest ? summaryCount(latest.resumo, "divergencias_local") : null],
        ["Sem correspondência na última", latest ? summaryCount(latest.resumo, "ausentes_no_endpoint", "ausentes_em_detalhes") : null],
      ]);
      renderHistoryRows();
    } catch (error) {
      if (request !== historyRequest || activeTool !== "historico-planilhas") return;
      status.textContent = error.message || "Não foi possível carregar o histórico.";
      tableEmpty(byId("cockpit-sheets-history-list-body"), 6, status.textContent);
    }
  }

  // Evolução
  function renderEvolutionChart(previous, current) {
    const svg = byId("cockpit-updates-chart");
    const sums = event => [summaryCount(event.resumo, "divergencias_local"), summaryCount(event.resumo, "ausentes_no_endpoint", "ausentes_em_detalhes")];
    const entries = [
      { kind: "abertos", label: "Anterior · divergentes", value: sums(previous)[0] },
      { kind: "concluidos", label: "Anterior · sem correspondência", value: sums(previous)[1] },
      { kind: "abertos", label: "Atual · divergentes", value: sums(current)[0] },
      { kind: "concluidos", label: "Atual · sem correspondência", value: sums(current)[1] },
    ];
    const max = Math.max(1, ...entries.map(entry => entry.value));
    svg.querySelectorAll("rect").forEach(rect => rect.remove());
    entries.forEach((entry, index) => {
      const height = entry.value > 0 ? Math.max(2, Math.round((entry.value / max) * 140)) : 0;
      const rect = document.createElementNS(svgNs, "rect");
      rect.setAttribute("class", `ck-graf__${entry.kind}`);
      rect.setAttribute("x", String(index * 100 + 25));
      rect.setAttribute("y", String(145 - height));
      rect.setAttribute("width", "50");
      rect.setAttribute("height", String(height));
      svg.append(rect);
    });
    svg.setAttribute("aria-label", `Pendências por atualização: ${entries.map(entry => `${entry.label} ${entry.value}`).join(", ")}`);
    byId("cockpit-updates-chart-labels").replaceChildren(...entries.map(entry => {
      const label = element("span", "", entry.label);
      label.prepend(element("strong", "", displayCount(entry.value)));
      return label;
    }));
  }

  function clearEvolution(message) {
    byId("cockpit-updates-status").textContent = message;
    renderKpis(byId("cockpit-updates-kpis"), []);
    tableEmpty(byId("cockpit-updates-table-body"), 5, message);
    const svg = byId("cockpit-updates-chart");
    svg.querySelectorAll("rect").forEach(rect => rect.remove());
    svg.setAttribute("aria-label", "Sem dados para o gráfico.");
    byId("cockpit-updates-chart-labels").replaceChildren();
    byId("cockpit-updates-new-list").replaceChildren();
    byId("cockpit-updates-new-empty").textContent = message;
    byId("cockpit-updates-new-empty").hidden = false;
    byId("cockpit-updates-detail-badge").replaceChildren();
    byId("cockpit-updates-detail-sub").textContent = "";
  }

  async function loadEvolution() {
    const request = ++evolutionRequest;
    clearEvolution("Carregando…");
    try {
      const events = inventoryUpdates(await fetchUpdateEvents());
      if (request !== evolutionRequest || activeTool !== "evolucao") return;
      if (events.length < 2) return clearEvolution("São necessárias pelo menos duas atualizações para comparar a evolução.");
      const [current, previous] = events;
      const query = new URLSearchParams({ anterior: String(previous.id), atual: String(current.id) });
      const data = await apiFetch(`/api/operacoes/evolucao?${query}`, { errorMessage: "Não foi possível comparar as atualizações." });
      if (request !== evolutionRequest || activeTool !== "evolucao") return;
      const counts = data.contagens || {};
      const fresh = Array.isArray(data.mudancas?.novos) ? data.mudancas.novos : [];
      byId("cockpit-updates-status").textContent = `${displayDate(previous.horario)} → ${displayDate(current.horario)}`;
      renderKpis(byId("cockpit-updates-kpis"), [
        ["Divergências novas", counts.novos], ["Resolvidas", counts.resolvidos], ["Continuam", counts.continuam],
        ["Atualização atual", displayDate(current.horario)],
      ]);
      renderEvolutionChart(previous, current);
      const equipment = event => displayCount(Number.isFinite(event.resumo?.total_endpoint) ? event.resumo.total_endpoint : null);
      const diverging = event => displayCount(summaryCount(event.resumo, "divergencias_local"));
      byId("cockpit-updates-table-body").replaceChildren(
        tableRow([["Atualização", `Anterior · ${displayDate(previous.horario)}`], ["Equipamentos", equipment(previous), "ck-td--dir"],
          ["Divergentes", diverging(previous), "ck-td--dir"], ["Resolvidas", "—", "ck-td--dir"], ["Novas", "—", "ck-td--dir"]]),
        tableRow([["Atualização", `Atual · ${displayDate(current.horario)}`], ["Equipamentos", equipment(current), "ck-td--dir"],
          ["Divergentes", diverging(current), "ck-td--dir"], ["Resolvidas", displayCount(counts.resolvidos), "ck-td--dir"],
          ["Novas", displayCount(counts.novos), "ck-td--dir"]]),
      );
      byId("cockpit-updates-detail-badge").replaceChildren(badge(`${displayCount(counts.novos)} novas`, fresh.length ? "warning" : "success"));
      byId("cockpit-updates-detail-sub").textContent = `Entre ${displayDate(previous.horario)} e ${displayDate(current.horario)}`;
      byId("cockpit-updates-new-list").replaceChildren(...fresh.slice(0, 50).map(change => {
        const item = element("li", "ck-tempo__item");
        const body = element("div", "ck-tempo__corpo");
        const row = change.item || {};
        body.append(element("strong", "ck-tempo__titulo", row.serie || row.serial || row.computador || "Registro sem série"),
          element("span", "ck-tempo__meta", [change.categoria, displaySource(change.secao)].filter(Boolean).join(" · ")));
        item.append(element("span", "ck-tempo__marca"), body);
        return item;
      }));
      const empty = byId("cockpit-updates-new-empty");
      empty.hidden = fresh.length > 0;
      empty.textContent = "Nenhuma divergência nova entre as duas atualizações.";
    } catch (error) {
      if (request !== evolutionRequest || activeTool !== "evolucao") return;
      clearEvolution(error.message || "Não foi possível carregar a evolução.");
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

  function renderUnits() {
    const visible = filteredUnits();
    const body = byId("cockpit-units-list-body");
    if (!visible.some(({ key }) => key === selectedUnitKey)) selectedUnitKey = visible[0]?.key || "";
    if (!visible.length) tableEmpty(body, 3, unitsList.length ? "Nenhuma unidade corresponde à busca." : "O catálogo não contém unidades.");
    else {
      body.replaceChildren(...visible.map(({ unit, key }) => tableRow([
        ["Unidade", unitName(unit)], ["Cidade", unit.cidade || "—"], ["CNPJ", unit.cnpj || "—"],
      ], { selected: key === selectedUnitKey, onSelect: () => { selectedUnitKey = key; renderUnits(); } })));
    }
    byId("cockpit-units-status").textContent = `${visible.length} de ${unitsList.length} ${unitsList.length === 1 ? "unidade" : "unidades"}`;
    const selected = visible.find(({ key }) => key === selectedUnitKey)?.unit;
    byId("cockpit-units-detail-title").textContent = selected ? unitName(selected) : "—";
    byId("cockpit-units-detail-sub").textContent = selected ? ([selected.cidade, selected.uf].filter(Boolean).join("/") || "Cidade não informada") : "Selecione uma unidade.";
    renderPares(byId("cockpit-units-detail-pares"), selected ? [
      ["Cidade", selected.cidade], ["UF", selected.uf], ["Endereço", selected.endereco], ["CEP", selected.cep], ["CNPJ", selected.cnpj],
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
    byId("cockpit-tickets-refresh").addEventListener("click", loadTickets);
    byId("cockpit-tickets-attention").addEventListener("change", filterTicketTable);
    byId("cockpit-tickets-clear").addEventListener("click", clearTicketFilters);
    byId("cockpit-tickets-triage").addEventListener("click", selectTicketTriage);
    byId("cockpit-comparison-refresh").addEventListener("click", loadComparisons);
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
    byId("cockpit-alias-refresh").addEventListener("click", loadAliases);
    byId("cockpit-alias-export").addEventListener("click", exportAliasesCsv);
    byId("cockpit-alias-legacy").addEventListener("click", app.abrirModalHistoricoApelidos);
    byId("cockpit-monthly-month").addEventListener("change", event => loadMonthlyReport(event.currentTarget.value));
    byId("cockpit-monthly-copy").addEventListener("click", copyMonthlyPreview);
    byId("cockpit-monthly-export").addEventListener("click", exportMonthlyWorkbook);
    byId("cockpit-sheets-refresh").addEventListener("click", loadSheets);
    byId("cockpit-sheets-history-search").addEventListener("input", renderHistoryRows);
    byId("cockpit-sheets-history-export").addEventListener("click", () => {
      void exportSelectedComparison(historyEvents.find(event => String(event.id) === selectedHistoryId));
    });
    byId("cockpit-updates-refresh").addEventListener("click", loadEvolution);
    byId("cockpit-units-search").addEventListener("input", renderUnits);
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented || root.hidden) return;
      const modal = document.querySelector('[data-accessible-modal="true"]:not(.hidden)');
      if (!modal) { event.preventDefault(); closePanel(); }
    });
    // O destaque de Chamados segue o painel, qualquer que seja o caminho que o esconda.
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
    if (tool === "historico-planilhas") await loadHistory();
    if (tool === "evolucao") await loadEvolution();
    if (tool === "unidades") await loadUnits();
    if (tool === "sebrae-historico") await app.carregarPainelHistoricoSebrae?.();
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
    filterTicketRecords,
    mostrarResultadoNaAbaComparacao,
    comparisonMetrics,
    aliasMetrics,
    monthlyPreviewText,
    monthlyChartBars,
  };
});
