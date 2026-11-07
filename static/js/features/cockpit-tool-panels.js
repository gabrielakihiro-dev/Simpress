/** Dedicated Cockpit workspaces for the tools in the nine-dot menu. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).cockpitToolPanels = factory;
})(typeof window !== "undefined" ? window : globalThis, function createCockpitToolPanels(context) {
  "use strict";
  const { app, apiFetch } = context;
  const toolKeys = { "sebrae-chamados": "F5", chamados: "F6", comparacao: "F3", apelidos: "F7", relatorio: "F8", cobertura: "F10" };
  const toolInfo = {
    chamados: ["OS", "Acompanhamento local de ordens relacionadas por série."],
    comparacao: ["Resumo", "Ativos por regional (com filtro por categoria) e resultados salvos da comparação entre as bases locais."],
    apelidos: ["Histórico de apelidos", "Alterações registradas para equipamentos e usuários."],
    relatorio: ["Relatório mensal", "Consolidação do mês usando os dados locais disponíveis."],
    cobertura: ["Cobertura", "Necessidades de equipamento, reservas, transporte e devoluções por cidade."],
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

  // Prévia copiável (Copiar resumo): mesmos números da tela e da XLSX; sem linhas "indisponível" (decisão de 07/11/2026).
  // `sebrae`: resposta de GET /api/sebrae/novos (situação atual); null quando não carregou.
  function monthlyPreviewText(report, sebrae = null) {
    const month = report?.mes?.label || report?.mes?.key || "mês selecionado";
    const inventory = report?.inventario || {};
    const comparison = report?.comparacao || {};
    const tickets = report?.os || {};
    const oracle = tickets.oracle || {};
    const simpress = tickets.simpress || {};
    const counts = comparison.contagens || {};
    const insufficient = Array.isArray(tickets.dados_insuficientes) ? tickets.dados_insuficientes.length : 0;
    const topUnits = Array.isArray(inventory.por_unidade) ? inventory.por_unidade.slice(0, 3) : [];
    const period = typeof report?.mes?.parcial === "boolean" ? ` · ${monthlyPeriodLabel(report)}` : "";
    const lines = [
      `Relatório mensal Simpress · ${month}${period}`,
      "",
      `OS Oracle abertas no mês: ${displayCount(oracle.abertas)}`,
      `OS Oracle concluídas no mês: ${displayCount(oracle.concluidas)}`,
      `OS Oracle pendentes no fim do período: ${displayCount(oracle.pendentes)}`,
      `Pedidos Simpress abertos no mês: ${displayCount(simpress.abertas)}`,
      `Pedidos Simpress entregues no mês: ${displayCount(simpress.concluidas)}`,
      `Pedidos Simpress em andamento no fim do período: ${displayCount(simpress.pendentes)}`,
      ...(insufficient ? [`Fora das contagens: ${insufficient} ${plural(insufficient, "registro", "registros")} com dados insuficientes`] : []),
      "",
      comparisonUsedText(comparison),
      `Sem correspondência — no endpoint: ${displayCount(counts["Sem correspondência — no endpoint"])}`,
      `Sem correspondência — na Simpress: ${displayCount(counts["Sem correspondência — na Simpress"])}`,
      `Localidade divergente: ${displayCount(counts["Localidade divergente"])}`,
    ];
    if (sebrae && (sebrae.importado || sebrae.novos)) {
      const novos = (sebrae.novos?.formulario || []).length;
      const antigos = (sebrae.importado?.abertos || []).length;
      lines.push("", `Chamados (F5), situação atual: ${displayCount(novos)} ${plural(novos, "novo", "novos")} · ${displayCount(antigos)} ${plural(antigos, "antigo", "antigos")} em aberto`);
    }
    lines.push(
      "",
      `Base atual (não muda com o mês): ${displayCount(inventory.total)} equipamentos em ${displayCount(inventory.unidades)} unidades`,
      "Unidades com mais equipamentos (base atual):",
      ...(topUnits.length ? topUnits.map(([city, address, total]) => `- ${[city, address].filter(Boolean).join(" · ")}: ${displayCount(total)}`) : ["- Sem dados de unidade."]),
    );
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
    const dados = element("div", "ck-os-andamento__dados");
    dados.append(relation, fields, note);
    const tempo = element("div", "ck-os-andamento__tempo");
    tempo.append(timeline);
    const painel = element("div", "ck-os-andamento");
    painel.append(dados, tempo);
    target.replaceChildren(painel);
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

  // Busca: espera 150 ms sem digitar antes de filtrar (a contagem com aria-live não é anunciada a cada letra).
  let ticketSearchTimer = 0;
  function filterTicketTableSoon() {
    clearTimeout(ticketSearchTimer);
    ticketSearchTimer = setTimeout(filterTicketTable, 150);
  }

  function clearTicketFilters() {
    clearTimeout(ticketSearchTimer);
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

  // Serial (+ optional category) target: navegarParaLinhaComparacao finds the row in the rendered result (S-prefix rule included).
  // The category (sem_acesso_7_dias, divergencias_local, sem_usuario...) picks the right section when the serial is in several.
  async function abrirComparacaoDaSerie(serial, categoria = "") {
    const value = String(serial || "").trim();
    const category = String(categoria || "").trim();
    pendingComparisonTarget = value ? (category ? { serial: value, category } : { serial: value }) : null;
    selectedComparisonId = "";
    await openPanel("comparacao");
    pendingComparisonTarget = null;
  }

  // Shows a result in the Resumo panel (internal tool key "comparacao"). With evento_id that event is selected; a fresh result (no evento_id)
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
  function clearComparisonResult(message, estado = "vazio") {
    byId("comparacao-planilhas-fontes").textContent = "";
    const exportButton = byId("btn-exportar-resultado-comparacao");
    exportButton.dataset.historyDate = "";
    exportButton.disabled = true;
    renderEmpty(byId("comparacao-planilhas-conteudo"), message);
    byId("comparacao-planilhas-conteudo").dataset.estado = estado;
  }

  // keepContent: a freshly generated result is already on screen; this load only swaps in the saved event (it has evento_id).
  async function loadComparisonDetail(eventId, { keepContent = false } = {}) {
    const request = ++comparisonDetailRequest;
    selectedComparison = null;
    if (!eventId) {
      updateComparisonStatus();
      if (keepContent) return;
      clearComparisonResult("Não há comparação de inventários disponível neste histórico.");
      // Without a saved comparison the "Sem usuário" section (current inventory) still shows below the empty message.
      const target = pendingComparisonTarget;
      pendingComparisonTarget = null;
      const semUsuario = await app.carregarSemUsuarioResumo?.();
      if (semUsuario && request === comparisonDetailRequest && activeTool === "comparacao") app.renderizarSemUsuarioSemComparacao(semUsuario, target);
      return;
    }
    if (!keepContent) clearComparisonResult("Carregando comparação…", "carregando");
    try {
      // "Sem usuário" comes from the current inventory (not from the saved event), read in parallel with the event.
      const semUsuarioLoad = app.carregarSemUsuarioResumo?.();
      const data = await apiFetch(`/api/historico-comparacoes/${encodeURIComponent(eventId)}`, { errorMessage: "Não foi possível abrir esta comparação." });
      const semUsuario = await semUsuarioLoad;
      if (request !== comparisonDetailRequest || activeTool !== "comparacao") return;
      selectedComparison = data.evento || null;
      if (!selectedComparison) return clearComparisonResult("Comparação não encontrada.");
      const target = pendingComparisonTarget;
      pendingComparisonTarget = null;
      app.renderizarResultadoComparacao(comparisonFromEvent(selectedComparison), target, semUsuario);
      updateComparisonStatus();
    } catch (error) {
      if (request !== comparisonDetailRequest || activeTool !== "comparacao") return;
      if (!keepContent) {
        renderError(byId("comparacao-planilhas-conteudo"), error, "Não foi possível abrir a comparação.");
        byId("comparacao-planilhas-conteudo").dataset.estado = "erro";
      }
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
    else clearComparisonResult("Carregando histórico local…", "carregando");
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
      if (!fresh) {
        renderError(byId("comparacao-planilhas-conteudo"), error, "Falha ao carregar o histórico.");
        byId("comparacao-planilhas-conteudo").dataset.estado = "erro";
      }
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

  // Séries de máquinas virtuais do próprio Sebrae (VMware, Google Cloud): fora do F7, só na exibição.
  const ALIAS_HIDDEN_SERIAL = /^(VMWARE|GOOGLECLOUD)/i;

  const aliasDate = value => (value ? displayDate(value) : "Data indisponível");

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
      ["Data", aliasDate(event.horario)], ["Série", event.serial], ["Equipamento", event.equipamento],
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
          Object.assign(element("time", "ck-tempo__meta", aliasDate(item.horario)), { dateTime: item.horario || "" }),
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
      const searchable = normalize([event.serial, event.equipamento, event.tipo, event.acao, event.usuario_endpoint, event.horario, aliasDate(event.horario),
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
      button.append(element("small", "ck-item__sub", `${aliasDate(event.horario)} · ${event.tipo === "aviso_endpoint"
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
      aliasEvents = (Array.isArray(data.eventos) ? data.eventos : []).filter(event => !ALIAS_HIDDEN_SERIAL.test(String(event.serial || "").trim()));
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

  // ---- Relatório mensal (F8): layout operacional (07/11/2026) ----
  // Ordem: Precisa de atenção → Movimento do mês → OS e pedidos → Pendências da comparação → Chamados (F5, situação atual)
  // → Base atual → Prévia. Cada número aparece uma vez; os links só navegam (Home, OS, Resumo, Chamados), nada é gravado.
  const MONTHLY_PAGE = 25;
  const MONTHLY_TOP_UNITS = 8;
  const monthlyView = { report: null, sebrae: null, sebraeErro: "", filtro: "todas", limiteOs: MONTHLY_PAGE, limiteComp: MONTHLY_PAGE, limiteSebrae: MONTHLY_PAGE, unidadesTodas: false, foraAberto: false };
  const monthlySituationTone = { "Aberta no mês": "info", "Concluída no mês": "success", "Pendente no fim do mês": "warning" };
  const monthlyFilters = [["todas", "Todas", ""], ["abertas", "Abertas", "Aberta no mês"], ["concluidas", "Concluídas", "Concluída no mês"], ["pendentes", "Pendentes", "Pendente no fim do mês"]];
  const monthlySectionTone = { "Sem correspondência — no endpoint": "error", "Sem correspondência — na Simpress": "warning" };
  const monthlyBadgeStatus = { ...badgeStatus, info: "info" };

  function monthlyBadge(text, tone) {
    const node = element("span", "ck-badge", text);
    if (monthlyBadgeStatus[tone]) node.dataset.status = monthlyBadgeStatus[tone];
    return node;
  }

  // Datas da API ("2026-11-05T14:12:00" ou "2026-11-05") viram texto pt-BR sem conversão de fuso: mostra o horário salvo.
  function monthlyDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(value || ""));
    if (!match) return "";
    const [, year, month, day, hour, minute] = match;
    return hour ? `${day}/${month}/${year} às ${hour}:${minute}` : `${day}/${month}/${year}`;
  }

  // Mês ("AAAA-MM") de uma data do Sebrae: "dd/mm/aaaa HH:mm" (colunas P/R, SoftExpert) ou ISO; sem data reconhecível, "".
  function sebraeMonthKey(value) {
    const text = String(value || "").trim();
    const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
    if (br) return `${br[3]}-${br[2].padStart(2, "0")}`;
    const iso = /^(\d{4})-(\d{2})-\d{2}/.exec(text);
    return iso ? `${iso[1]}-${iso[2]}` : "";
  }

  function plural(count, singular, pluralText) { return Number(count) === 1 ? singular : pluralText; }

  function monthlyPeriodLabel(report) {
    const cutoff = monthlyDate(report?.mes?.data_corte);
    return report?.mes?.parcial ? `Parcial até ${cutoff || "data indisponível"}` : "Mês encerrado";
  }

  function comparisonUsedText(comparison) {
    const updates = Number(comparison?.atualizacoes_no_mes) || 0;
    const when = monthlyDate(comparison?.horario) || "nenhuma até o fim do período";
    return `Comparação usada: ${when} · ${displayCount(updates)} ${plural(updates, "atualização", "atualizações")} de inventário no mês`;
  }

  // Uma série só (pedidos Simpress podem reunir várias, separadas por vírgula): sem série única não há link.
  function singleSerial(value) {
    const text = String(value || "").trim();
    return text && !text.includes(",") ? text : "";
  }

  function monthlyButton(text, onClick, { className = "ck-btn ck-btn--secundario ck-btn--sm", label = "", arrow = false } = {}) {
    const button = element("button", className, text);
    button.type = "button";
    if (arrow) button.append(element("span", "ck-rel__seta", " ↓"));
    if (arrow) button.lastChild.setAttribute("aria-hidden", "true");
    if (label) button.setAttribute("aria-label", label);
    button.addEventListener("click", onClick);
    return button;
  }

  function monthlyLink(text, label, onClick) { return monthlyButton(text, onClick, { className: "ck-rel__link ck-mono", label }); }

  function monthlyJump(headingId) {
    const heading = byId(headingId);
    if (!heading) return;
    heading.scrollIntoView?.({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    heading.focus({ preventScroll: true });
  }

  // Abre a aba OS (F6) filtrada pela série (a busca da F6 procura série, OS, usuário, hostname, modelo e UTIC).
  async function openSerialInTickets(serial) {
    const search = byId("cockpit-tickets-search");
    if (search) search.value = String(serial || "").trim().toUpperCase();
    await openPanel("chamados");
    search?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Abre a aba Chamados (F5) numa sub-aba (Novos, Antigos…) sem filtro de chamado.
  async function openSebraeTab(tab) {
    await openPanel("sebrae-chamados");
    byId(`sebrae-aba-${tab}`)?.click();
  }

  function monthlyNumbers(entries) {
    const grid = element("dl", "ck-rel__numeros");
    entries.forEach(([label, value, tone]) => {
      const cell = element("div", "ck-rel__numero");
      if (tone) cell.dataset.status = tone;
      cell.append(element("dt", "ck-rel__rotulo", label), element("dd", "ck-rel__valor", displayCount(value)));
      grid.append(cell);
    });
    return grid;
  }

  function monthlyCard(title, tone) {
    const card = element("article", "ck-rel__cartao ck-rel__atencao");
    if (tone) card.dataset.status = tone;
    card.append(element("h4", "ck-rel__cartao-titulo", title));
    return card;
  }

  function monthlyOutsideCard(rows) {
    const card = monthlyCard("Fora das contagens", "alerta");
    const total = element("p", "ck-rel__total");
    total.append(element("strong", "ck-rel__valor", displayCount(rows.length)), document.createTextNode(` ${plural(rows.length, "registro", "registros")}`));
    const list = element("ul", "ck-rel__fora");
    list.id = "cockpit-monthly-fora";
    list.hidden = !monthlyView.foraAberto;
    rows.forEach(row => list.append(element("li", "", `${row.fonte || "Fonte indisponível"} · ${(row.identificadores || []).filter(Boolean).join(", ") || "Identificador indisponível"} · ${row.serie || "Série indisponível"} — ${row.motivo || "Motivo indisponível"}`)));
    const toggle = monthlyButton(monthlyView.foraAberto ? "Ocultar registros" : "Mostrar registros", () => {
      monthlyView.foraAberto = !monthlyView.foraAberto;
      list.hidden = !monthlyView.foraAberto;
      toggle.textContent = monthlyView.foraAberto ? "Ocultar registros" : "Mostrar registros";
      toggle.setAttribute("aria-expanded", String(monthlyView.foraAberto));
    });
    toggle.setAttribute("aria-expanded", String(monthlyView.foraAberto));
    toggle.setAttribute("aria-controls", list.id);
    card.append(total, element("p", "ck-rel__nota", "Datas ou vínculo insuficientes: não entram nos números do mês."), toggle, list);
    return card;
  }

  function renderMonthlyAttention(report) {
    const tickets = report.os || {};
    const comparison = report.comparacao || {};
    const insufficient = Array.isArray(tickets.dados_insuficientes) ? tickets.dados_insuficientes : [];
    const pending = monthlyCard("OS pendentes no fim do período");
    pending.append(
      monthlyNumbers([["OS Oracle", tickets.oracle?.pendentes], ["Pedidos Simpress", tickets.simpress?.pendentes]]),
      element("p", "ck-rel__nota", "Criados até o corte e ainda sem conclusão ou entrega."),
      monthlyButton("Ver lista", () => {
        monthlyView.filtro = "pendentes";
        monthlyView.limiteOs = MONTHLY_PAGE;
        refreshMonthlySection("os");
        monthlyJump("cockpit-monthly-os-title");
      }, { className: "ck-rel__link", label: "Ver lista de OS e pedidos pendentes", arrow: true }),
    );
    const counts = element("dl", "ck-rel__contagens");
    Object.entries(comparison.contagens || {}).forEach(([label, value]) => {
      const row = element("div", "ck-rel__contagem");
      row.append(element("dt", "", label), element("dd", "ck-num", displayCount(value)));
      counts.append(row);
    });
    const inventory = monthlyCard("Comparação de inventário");
    inventory.append(
      counts,
      element("p", "ck-rel__nota", `${comparisonUsedText(comparison)}.`),
      monthlyButton("Ver lista", () => monthlyJump("cockpit-monthly-comp-title"), { className: "ck-rel__link", label: "Ver lista de pendências da comparação", arrow: true }),
    );
    const cards = [pending, inventory];
    if (insufficient.length) cards.push(monthlyOutsideCard(insufficient));
    byId("cockpit-monthly-kpis").replaceChildren(...cards);
  }

  function monthlySection(key, title, actions = []) {
    const section = element("section", "ck-det-bloco ck-rel__secao");
    section.dataset.relSecao = key;
    const head = element("div", "ck-rel__secao-cab");
    const heading = element("h3", "ck-det__titulo", title);
    heading.id = `cockpit-monthly-${key}-title`;
    heading.tabIndex = -1;
    section.setAttribute("aria-labelledby", heading.id);
    head.append(heading, ...actions);
    section.append(head);
    return section;
  }

  // Tabela que vira cartões no celular (ck-tabela--cards). Célula: texto ou nó pronto; `numeric`: colunas à direita.
  function monthlyTable(columns, rows, numeric = []) {
    const wrap = element("div", "ck-rel__tabela");
    const table = element("table", "ck-tabela ck-tabela--cards");
    const head = element("tr");
    columns.forEach((label, index) => {
      const th = element("th", numeric.includes(index) ? "ck-th--dir" : "", label);
      th.scope = "col";
      head.append(th);
    });
    const thead = element("thead");
    thead.append(head);
    const body = element("tbody");
    rows.forEach(cells => {
      const line = element("tr");
      cells.forEach((cell, index) => {
        const td = element("td", numeric.includes(index) ? "ck-td--dir" : "");
        td.dataset.label = columns[index];
        if (cell && typeof cell === "object") td.append(cell);
        else td.textContent = String(cell ?? "") || "—";
        line.append(td);
      });
      body.append(line);
    });
    table.append(thead, body);
    wrap.append(table);
    return wrap;
  }

  // Rodapé só quando há mais a carregar ou já se carregou além da primeira página ("Mostrando 1 de 1" seria ruído).
  function monthlyMore(shown, total, onMore) {
    if (shown >= total && total <= MONTHLY_PAGE) return document.createDocumentFragment();
    const foot = element("div", "ck-rel__rodape");
    foot.append(element("span", "ck-rel__nota", `Mostrando ${displayCount(shown)} de ${displayCount(total)}`));
    if (shown < total) {
      const more = monthlyButton("Carregar mais", onMore);
      more.dataset.relMais = "";
      foot.append(more);
    }
    return foot;
  }

  function monthlyMovementSection(tickets) {
    const section = monthlySection("movimento", "Movimento do mês");
    const rows = [["OS Oracle", tickets.oracle || {}], ["Pedidos Simpress", tickets.simpress || {}]]
      .map(([label, counts]) => [label, displayCount(counts.abertas), displayCount(counts.concluidas), displayCount(counts.encerradas_sem_data)]);
    section.append(monthlyTable(["Fonte", "Abertas", "Concluídas", "Encerradas sem data"], rows, [1, 2, 3]));
    return section;
  }

  function monthlyOsSection(tickets) {
    const all = Array.isArray(tickets.linhas) ? tickets.linhas : [];
    const filter = monthlyFilters.find(([key]) => key === monthlyView.filtro) || monthlyFilters[0];
    const rows = filter[2] ? all.filter(row => (row.situacao || []).includes(filter[2])) : all;
    const group = element("div", "ck-rel__filtros");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Filtrar por situação");
    monthlyFilters.forEach(([key, label]) => {
      const button = monthlyButton(label, () => {
        monthlyView.filtro = key;
        monthlyView.limiteOs = MONTHLY_PAGE;
        refreshMonthlySection("os", `[data-rel-filtro="${key}"]`);
      });
      button.dataset.relFiltro = key;
      button.setAttribute("aria-pressed", String(key === filter[0]));
      group.append(button);
    });
    const section = monthlySection("os", "OS e pedidos do mês", [group, monthlyButton("Ver na aba OS (F6)", () => openPanel("chamados"))]);
    if (!rows.length) {
      section.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return section;
    }
    const shown = rows.slice(0, monthlyView.limiteOs);
    const columns = ["Fonte", "OS/Pedido", "Série", "Status", "Criação", "Conclusão", "Situação no mês"];
    section.append(monthlyTable(columns, shown.map(row => {
      const serial = singleSerial(row.serie);
      const id = String(row.identificador || "") || "—";
      const situations = element("span", "ck-rel__selos");
      (row.situacao || []).forEach(text => situations.append(monthlyBadge(text, monthlySituationTone[text])));
      return [
        row.fonte || "—",
        serial ? monthlyLink(id, `Ver ${id} na aba OS (F6), pela série ${serial}`, () => openSerialInTickets(serial)) : element("span", "ck-mono", id),
        serial ? monthlyLink(serial, `Abrir ${serial} na Home`, () => openSerialInHome(serial)) : element("span", "ck-mono", row.serie || "—"),
        row.status || "—",
        monthlyDate(row.criacao) || "—",
        monthlyDate(row.conclusao) || "—",
        situations,
      ];
    })), monthlyMore(shown.length, rows.length, () => {
      monthlyView.limiteOs += MONTHLY_PAGE;
      refreshMonthlySection("os", "[data-rel-mais]");
    }));
    return section;
  }

  function monthlyComparisonSection(comparison) {
    const rows = Array.isArray(comparison.linhas) ? comparison.linhas : [];
    const eventId = String(comparison.evento_id || "");
    const actions = eventId ? [monthlyButton("Abrir no Resumo (F3)", () => mostrarResultadoNaAbaComparacao({ evento_id: eventId }))] : [];
    const section = monthlySection("comp", "Pendências da comparação", actions);
    if (!rows.length) {
      section.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return section;
    }
    const shown = rows.slice(0, monthlyView.limiteComp);
    section.append(monthlyTable(["Seção", "Hostname", "Série", "Local previsto", "Local na Simpress"], shown.map(row => {
      const serial = singleSerial(row.serie);
      return [
        monthlyBadge(row.secao || "Seção indisponível", monthlySectionTone[row.secao]),
        element("span", "ck-mono", row.hostname || "—"),
        serial ? monthlyLink(serial, `Abrir ${serial} na Home`, () => openSerialInHome(serial)) : "—",
        row.local_previsto || "—",
        row.local_simpress || "—",
      ];
    })), monthlyMore(shown.length, rows.length, () => {
      monthlyView.limiteComp += MONTHLY_PAGE;
      refreshMonthlySection("comp", "[data-rel-mais]");
    }));
    return section;
  }

  // Chamados da aba Chamados (F5), lidos de GET /api/sebrae/novos (só leitura). Totais = situação atual (não mudam com o
  // mês); a lista traz só os chamados com data conhecida no mês: abertura (P/"Habilitada em") ou finalização feita pelo site.
  function sebraeMonthRows(data, monthKey) {
    const rows = [];
    (data?.novos?.formulario || []).forEach(item => {
      if (sebraeMonthKey(item.linha?.P) === monthKey) rows.push({ chave: item.numero, numero: item.numero, titulo: item.linha?.G, serie: item.linha?.K, data: item.linha?.P, situacao: "Aberto no mês", tom: "info" });
    });
    (data?.importado?.abertos || []).forEach(item => {
      const opened = item.leitura_softexpert?.habilitada_em;
      if (sebraeMonthKey(opened) === monthKey) rows.push({ chave: item.numero, numero: String(item.numero).startsWith("linha:") ? item.chamado || "Sem UTIC" : item.numero, titulo: item.titulo, serie: item.automaticos?.K || item.automaticos_sugeridos?.K, data: opened, situacao: "Aberto no mês", tom: "info" });
    });
    (data?.importado?.finalizados || []).forEach(item => {
      const closed = item.encerrado_em || item.em;
      if (sebraeMonthKey(closed) === monthKey) rows.push({ chave: item.numero, numero: item.numero, titulo: item.ficha?.titulo || "", serie: fichaSerial(item.ficha), data: closed, situacao: "Finalizado no mês", tom: "success" });
    });
    return rows;
  }

  function fichaSerial(ficha) {
    const pair = (Array.isArray(ficha?.fatos) ? ficha.fatos : []).find(entry => Array.isArray(entry) && /^s[ée]rie$/i.test(String(entry[0] || "").trim()));
    return pair ? String(pair[1] || "") : "";
  }

  function sebraeDateText(value) {
    const text = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? monthlyDate(text) : (text.match(/^\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2})?/)?.[0] || "—");
  }

  function monthlySebraeSection(report) {
    const section = monthlySection("sebrae", "Chamados (F5)", [monthlyBadge("Situação atual")]);
    section.classList.add("ck-rel__atual");
    if (monthlyView.sebraeErro) {
      section.append(element("p", "ck-nota ck-nota--erro", monthlyView.sebraeErro));
      return section;
    }
    const data = monthlyView.sebrae;
    if (!data?.importado && !data?.novos) {
      section.append(element("p", "ck-lista__vazio", "Nenhum Dashboard importado. A importação e a busca ficam na aba Automação (F4)."));
      return section;
    }
    const novos = (data.novos?.formulario || []).length;
    const antigos = (data.importado?.abertos || []).length;
    const totals = element("div", "ck-rel__sebrae-totais");
    totals.append(
      monthlyNumbers([["Chamados novos", novos], ["Antigos em aberto", antigos]]),
      monthlyButton("Ver novos", () => openSebraeTab("novos")),
      monthlyButton("Ver antigos", () => openSebraeTab("antigos")),
    );
    section.append(totals);
    const rows = sebraeMonthRows(data, report?.mes?.key || "");
    section.append(element("h4", "ck-rel__cartao-titulo", `Com data em ${report?.mes?.label || "mês selecionado"}`));
    section.append(element("p", "ck-rel__nota", "Só entram chamados com data conhecida: abertura (novos e antigos já lidos no SoftExpert) ou finalização feita pelo site."));
    if (!rows.length) {
      section.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return section;
    }
    const shown = rows.slice(0, monthlyView.limiteSebrae);
    section.append(monthlyTable(["Chamado", "Título", "Série", "Data", "Situação"], shown.map(row => {
      const serial = singleSerial(row.serie);
      return [
        monthlyLink(row.numero || "—", `Abrir ${row.numero || "chamado"} na aba Chamados (F5)`, () => app.abrirChamadoSebraeNoF5?.(row.chave)),
        row.titulo || "—",
        serial ? monthlyLink(serial, `Abrir ${serial} na Home`, () => openSerialInHome(serial)) : "—",
        sebraeDateText(row.data),
        monthlyBadge(row.situacao, row.tom),
      ];
    })), monthlyMore(shown.length, rows.length, () => {
      monthlyView.limiteSebrae += MONTHLY_PAGE;
      refreshMonthlySection("sebrae", "[data-rel-mais]");
    }));
    return section;
  }

  function monthlyTypesCard(rows) {
    const card = element("section", "ck-rel__cartao");
    card.append(element("h4", "ck-rel__cartao-titulo", "Inventário por tipo"));
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      card.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return card;
    }
    const max = Math.max(1, ...list.map(([, count]) => Number(count) || 0));
    const items = element("ul", "ck-rel__tipos");
    list.forEach(([name, count]) => {
      const item = element("li", "ck-rel__tipo");
      const line = element("span", "ck-rel__tipo-linha");
      line.append(element("span", "", name || "Sem tipo"), element("strong", "ck-num", displayCount(count)));
      const track = element("span", "ck-rel__trilho");
      track.setAttribute("aria-hidden", "true");
      const fill = element("span", "ck-rel__trilho-valor");
      fill.style.width = `${Math.round(((Number(count) || 0) / max) * 100)}%`;
      track.append(fill);
      item.append(line, track);
      items.append(item);
    });
    card.append(items);
    return card;
  }

  function monthlyUnitsCard(rows) {
    const card = element("section", "ck-rel__cartao");
    card.append(element("h4", "ck-rel__cartao-titulo", "Unidades com mais equipamentos"));
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      card.append(element("p", "ck-lista__vazio", "Sem registros neste período."));
      return card;
    }
    const items = element("ol", "ck-rel__unidades");
    (monthlyView.unidadesTodas ? list : list.slice(0, MONTHLY_TOP_UNITS)).forEach(([city, address, total]) => {
      const item = element("li", "ck-rel__unidade");
      const name = element("span", "ck-rel__unidade-nome");
      name.append(element("strong", "", city || "Sem cidade"));
      if (address) name.append(element("span", "ck-mudo", ` · ${address}`));
      item.append(name, element("strong", "ck-num", displayCount(total)));
      items.append(item);
    });
    card.append(items);
    if (list.length > MONTHLY_TOP_UNITS) {
      const toggle = monthlyButton(monthlyView.unidadesTodas ? "Ver menos" : `Ver todas as ${displayCount(list.length)} unidades`, () => {
        monthlyView.unidadesTodas = !monthlyView.unidadesTodas;
        refreshMonthlySection("base", "[data-rel-unidades]");
      });
      toggle.dataset.relUnidades = "";
      toggle.setAttribute("aria-expanded", String(monthlyView.unidadesTodas));
      card.append(toggle);
    }
    return card;
  }

  function monthlyBaseSection(inventory) {
    const section = monthlySection("base", "Base atual", [monthlyBadge("Não muda com o mês")]);
    section.classList.add("ck-rel__atual");
    const origin = [inventory.arquivo_origem, inventory.carregada_em ? `carregada em ${inventory.carregada_em}` : ""].filter(Boolean).join(" · ");
    if (origin) section.append(element("p", "ck-rel__nota", origin));
    const duplicates = Array.isArray(inventory.series_duplicadas) ? inventory.series_duplicadas.length : undefined;
    const numbers = element("section", "ck-rel__cartao");
    numbers.append(monthlyNumbers([
      ["Equipamentos", inventory.total], ["Unidades", inventory.unidades],
      ["Linhas sem série", inventory.linhas_sem_serie, inventory.linhas_sem_serie > 0 ? "alerta" : ""],
      ["Séries duplicadas", duplicates, duplicates > 0 ? "alerta" : ""],
    ]));
    numbers.setAttribute("aria-label", "Totais da base atual");
    const grid = element("div", "ck-rel__base-grade");
    grid.append(numbers, monthlyTypesCard(inventory.por_tipo), monthlyUnitsCard(inventory.por_unidade));
    section.append(grid);
    return section;
  }

  const monthlySectionBuilders = {
    os: report => monthlyOsSection(report.os || {}),
    comp: report => monthlyComparisonSection(report.comparacao || {}),
    sebrae: report => monthlySebraeSection(report),
    base: report => monthlyBaseSection(report.inventario || {}),
  };

  // Refaz uma seção (filtro, "Carregar mais", "Ver todas") e devolve o foco ao controle equivalente ou ao título.
  function refreshMonthlySection(key, focusSelector = "") {
    const report = monthlyView.report;
    const current = byId("cockpit-monthly-details")?.querySelector(`[data-rel-secao="${key}"]`);
    if (!report || !current) return;
    const next = monthlySectionBuilders[key](report);
    current.replaceWith(next);
    const target = (focusSelector && next.querySelector(focusSelector)) || (focusSelector ? next.querySelector("h3") : null);
    target?.focus();
  }

  function renderMonthly(report) {
    monthlyView.report = report;
    renderMonthlyAttention(report);
    byId("cockpit-monthly-attention").hidden = false;
    byId("cockpit-monthly-details").replaceChildren(
      monthlyMovementSection(report.os || {}),
      monthlyOsSection(report.os || {}),
      monthlyComparisonSection(report.comparacao || {}),
      monthlySebraeSection(report),
      monthlyBaseSection(report.inventario || {}),
    );
    byId("cockpit-monthly-preview").textContent = monthlyPreviewText(report, monthlyView.sebraeErro ? null : monthlyView.sebrae);
    const period = monthlyPeriodLabel(report);
    const badgeNode = byId("cockpit-monthly-period");
    badgeNode.textContent = period;
    badgeNode.dataset.status = report.mes?.parcial ? "info" : "";
    badgeNode.hidden = false;
    byId("cockpit-monthly-status").textContent = `Relatório de ${report.mes?.label || report.mes?.key || "mês selecionado"} · ${period} · gerado em ${monthlyDate(report.gerado_em) || "data indisponível"}`;
  }

  // `quiet`: recarga depois de importar OS ou de nova comparação; mantém filtros e páginas e não pisca "Carregando".
  async function loadMonthlyReport(month, { quiet = false } = {}) {
    const current = ++monthlyRequest;
    const target = byId("cockpit-monthly-details");
    if (!quiet) {
      Object.assign(monthlyView, { report: null, sebrae: null, sebraeErro: "", filtro: "todas", limiteOs: MONTHLY_PAGE, limiteComp: MONTHLY_PAGE, limiteSebrae: MONTHLY_PAGE, unidadesTodas: false, foraAberto: false });
      byId("cockpit-monthly-preview").textContent = "";
      byId("cockpit-monthly-kpis").replaceChildren();
      byId("cockpit-monthly-attention").hidden = true;
      byId("cockpit-monthly-period").hidden = true;
      byId("cockpit-monthly-copy").disabled = true;
      renderMonthlyPeriods(month);
      byId("cockpit-monthly-status").textContent = "Carregando dados do relatório…";
      renderEmpty(target, "Carregando relatório mensal local…");
    }
    // Os chamados do Sebrae são opcionais: falha neles não impede o relatório.
    const sebrae = apiFetch("/api/sebrae/novos", { errorMessage: "Não foi possível consultar os chamados do Sebrae." })
      .then(data => ({ data, error: "" }), error => ({ data: null, error: error?.message || "Não foi possível consultar os chamados do Sebrae." }));
    try {
      const report = await apiFetch(`/api/relatorio-mensal/dados?mes=${encodeURIComponent(month)}`, { errorMessage: "Não foi possível carregar o relatório mensal." });
      const sebraeResult = await sebrae;
      if (current !== monthlyRequest || activeTool !== "relatorio") return;
      const focused = document.activeElement;
      const focusedSection = quiet ? focused?.closest?.("[data-rel-secao]")?.dataset.relSecao : "";
      const focusedAttention = quiet && byId("cockpit-monthly-attention")?.contains(focused);
      monthlyView.sebrae = sebraeResult.data;
      monthlyView.sebraeErro = sebraeResult.error;
      renderMonthly(report);
      byId("cockpit-monthly-copy").disabled = false;
      if (focusedSection) byId(`cockpit-monthly-${focusedSection}-title`)?.focus();
      else if (focusedAttention) byId("cockpit-monthly-attention-title")?.focus();
    } catch (error) {
      if (current !== monthlyRequest || activeTool !== "relatorio") return;
      byId("cockpit-monthly-status").textContent = error.message || "Falha ao carregar o relatório.";
      if (quiet && monthlyView.report) return;
      renderError(target, error, "Falha ao carregar o relatório.");
      byId("cockpit-monthly-preview").textContent = "";
    }
  }

  // Importar OS (F6) ou nova comparação com o F8 aberto: recarrega o mês exibido sem perder filtros.
  function refreshMonthlyAfterChange() {
    if (activeTool !== "relatorio") return;
    const month = byId("cockpit-monthly-month")?.value;
    if (month) void loadMonthlyReport(month, { quiet: true });
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
    byId("cockpit-tickets-search").addEventListener("input", filterTicketTableSoon);
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
    document.addEventListener("simpress:chamados-atualizados", refreshMonthlyAfterChange);
    document.addEventListener("simpress:painel-atualizado", refreshMonthlyAfterChange);
    byId("cockpit-sheets-refresh").addEventListener("click", loadSheets);
    byId("cockpit-units-search").addEventListener("input", renderUnits);
    byId("cockpit-units-copy-cnpj").addEventListener("click", () => app.copiarDadoUnidade(selectedUnit()?.cnpj, "CNPJ"));
    byId("cockpit-units-copy-cep").addEventListener("click", () => app.copiarDadoUnidade(selectedUnit()?.cep, "CEP"));
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented || root.hidden) return;
      const modal = document.querySelector('[data-accessible-modal="true"]:not(.hidden)');
      if (!modal) { event.preventDefault(); closePanel(); }
    });
    // O destaque dos botões da barra (Resumo, Chamados e OS) segue o painel, qualquer que seja o caminho que o esconda.
    if (typeof MutationObserver !== "undefined") new MutationObserver(() => {
      if (root.hidden) syncPanelButtons("");
    }).observe(root, { attributes: true, attributeFilter: ["hidden"] });
    eventsBound = true;
  }

  // Botões da barra principal (.ck-aba--painel) ficam pressionados enquanto o painel deles está aberto.
  // O Resumo é uma aba (role="tab") da barra: fica selecionada e a aba que estava ativa fica desmarcada até o painel fechar.
  let suspendedTab = null;
  function restoreSuspendedTab() {
    if (!suspendedTab) return;
    suspendedTab.setAttribute("aria-selected", "true");
    suspendedTab.tabIndex = 0;
    suspendedTab.classList.add("is-active");
    suspendedTab = null;
  }
  function syncPanelButtons(tool) {
    document.querySelectorAll(".ck-aba--painel[data-cockpit-tool]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.cockpitTool === tool));
    });
    const toolTabs = [...document.querySelectorAll('[role="tab"][data-cockpit-tool]')];
    const opened = toolTabs.find(tab => tab.dataset.cockpitTool === tool);
    if (!opened) restoreSuspendedTab();
    else if (!suspendedTab) {
      suspendedTab = document.querySelector('#ck-abas [role="tab"][aria-selected="true"]:not([data-cockpit-tool])');
      if (suspendedTab) {
        suspendedTab.setAttribute("aria-selected", "false");
        suspendedTab.tabIndex = -1;
        suspendedTab.classList.remove("is-active");
      }
    }
    toolTabs.forEach(tab => {
      const selected = tab === opened;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle("is-active", selected);
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
    if (!activeTool) returnTarget = activeElement?.closest?.(".ck-aba--painel, [data-cockpit-tool]") || byId("cockpit-tools-trigger") || activeElement;
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
    if (tool === "comparacao") {
      app.invalidarSemUsuarioResumo?.();
      const ativos = app.carregarResumoAtivos?.();
      await loadComparisons();
      await ativos;
    }
    if (tool === "apelidos") await loadAliases();
    if (tool === "relatorio") {
      const input = byId("cockpit-monthly-month");
      if (!input.value) input.value = currentMonth();
      input.max = currentMonth();
      renderMonthlyPeriods(input.value);
      await loadMonthlyReport(input.value);
    }
    if (tool === "planilhas") await loadSheets();
    if (tool === "cobertura") await app.carregarCobertura?.();
    if (tool === "unidades") {
      app.toggleFormNovaUnidade?.(false);
      await loadUnits();
    }
  }

  // "OS deste equipamento" (Transporte): abre Chamados já filtrado pela série; a busca filtra a tabela de OS.
  function abrirChamadosDoEquipamento() {
    return openSerialInTickets(byId("transfer-serial")?.textContent);
  }

  // Botão da OS (tabela de Chamados): garante o painel aberto, mostra a linha da OS, abre o Andamento da série e destaca.
  async function abrirChamadoDaOs(_fontes, serie, os) {
    if (activeTool !== "chamados") await openPanel("chamados");
    const host = byId("cockpit-tickets-os");
    const chave = valor => String(valor || "").replace(/\s+/g, "").toUpperCase();
    const findRow = () => [...host.querySelectorAll("tbody tr[data-serial]")]
      .find(row => (!serie || chave(row.dataset.serial) === chave(serie)) && (!os || row.dataset.os === String(os)));
    let row = findRow();
    // Aberta agora pela Home, a tabela ainda está carregando: espera a linha aparecer (até ~3 s).
    for (let tentativa = 0; !row && tentativa < 30; tentativa += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      row = findRow();
    }
    // Escondida só pela página ("Carregar mais"): amplia a página; escondida pelo filtro: limpa os filtros e amplia.
    if (row?.hidden && !dataPanels()?.revelarLinhaOs?.(row)) {
      clearTicketFilters();
      row = findRow();
      if (row?.hidden) dataPanels()?.revelarLinhaOs?.(row);
    }
    if (!row) return;
    const toggle = [...host.querySelectorAll(".ck-os__andamento-btn")].find(button => button.dataset.serie === row.dataset.serial);
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
    sebraeMonthKey,
  };
});
