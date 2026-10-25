/** Operational summary built only from the local inventory and comparison APIs. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).cockpitSummary = factory;
})(typeof window !== "undefined" ? window : globalThis, function createCockpitSummary(context) {
  "use strict";
  const { app } = context;
  const INVENTORY_PAGE_SIZE = 50;
  const sections = Object.freeze({
    total: [],
    sincronizados: [],
    sem_acesso_7_dias: ["sem_acesso_7_dias"],
    divergencias_local: ["divergencias_local"],
    sem_correspondencia: ["ausentes_no_endpoint", "ausentes_em_detalhes"],
  });
  const labels = Object.freeze({
    total: "Total de ativos",
    sincronizados: "Sincronizados",
    sem_acesso_7_dias: "Sem acesso há 7+ dias",
    divergencias_local: "Divergência de localidade",
    sem_correspondencia: "Sem correspondência",
  });
  const tones = Object.freeze({ total: "neutral", sincronizados: "ok", sem_acesso_7_dias: "warn", divergencias_local: "error", sem_correspondencia: "error" });
  let dashboard = null;
  let event = null;
  let comparison = null;
  let selectedMetric = "divergencias_local";
  let inventoryPage = { items: [], offset: 0, total: 0, hasMore: false, loading: false, error: "" };
  let inventoryRequestId = 0;

  function list(value) { return Array.isArray(value) ? value.filter(item => item && typeof item === "object") : []; }
  function number(value) {
    if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  function serial(item) { return String(item?.serie || item?.serial || item?.chave || "").trim(); }
  function uniqueRecords(items) {
    const seen = new Set();
    return items.filter((item, index) => {
      const key = serial(item).toUpperCase() || `${item?.tipo || "row"}:${index}:${JSON.stringify(item)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function rowsForMetric(metric) {
    if (metric === "total") return inventoryPage.items.map(item => ({ ...item, __section: "total" }));
    if (!comparison) return [];
    const keys = sections[metric] || [];
    return uniqueRecords(keys.flatMap(key => list(comparison[key]).map(item => ({ ...item, __section: key }))));
  }
  function countFromComparison(key) {
    const direct = number(event?.resumo?.[key]);
    return direct ?? (Array.isArray(comparison?.[key]) ? comparison[key].length : null);
  }
  function syncPercent(count, total) {
    return count === null || total === null || total === 0 ? "Percentual indisponível" : `${((count / total) * 100).toFixed(1).replace(".", ",")}% da comparação`;
  }
  function metricValues() {
    const total = number(dashboard?.total_equipamentos);
    const synced = number(comparison?.equipamentos_sincronizados);
    const comparedDetails = number(comparison?.total_detalhes);
    const unmatched = comparison
      ? uniqueRecords(["ausentes_no_endpoint", "ausentes_em_detalhes"].flatMap(key => list(comparison[key]))).length
      : null;
    return {
      total: { value: total, note: "equipamentos na base local" },
      sincronizados: { value: synced, note: syncPercent(synced, comparedDetails) },
      sem_acesso_7_dias: { value: countFromComparison("sem_acesso_7_dias"), note: "na última comparação" },
      divergencias_local: { value: countFromComparison("divergencias_local"), note: "na última comparação" },
      sem_correspondencia: { value: unmatched, note: "registros sem par" },
    };
  }
  function renderKpis() {
    const target = document.getElementById("cockpit-summary-kpis");
    if (!target) return;
    const values = metricValues();
    const content = document.createDocumentFragment();
    Object.keys(labels).forEach(key => {
      const metric = values[key];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cockpit-summary-kpi";
      button.dataset.metric = key;
      button.dataset.tone = tones[key];
      button.setAttribute("aria-pressed", String(selectedMetric === key));
      button.addEventListener("click", () => selecionarMetricaResumo(key));
      const label = document.createElement("span");
      label.className = "cockpit-summary-kpi-label";
      label.textContent = labels[key];
      const value = document.createElement("strong");
      value.className = "cockpit-summary-kpi-value";
      value.textContent = metric.value === null ? "—" : metric.value.toLocaleString("pt-BR");
      const note = document.createElement("span");
      note.className = "cockpit-summary-kpi-note";
      note.textContent = metric.note;
      button.append(label, value, note);
      content.appendChild(button);
    });
    target.replaceChildren(content);
  }
  function renderRegions() {
    const target = document.getElementById("cockpit-summary-region-list");
    if (!target) return;
    const cities = list(dashboard?.cidades_principais).map(item => ({
      name: String(item.cidade || "Sem cidade"),
      total: number(item.total) ?? 0,
    })).sort((left, right) => right.total - left.total || left.name.localeCompare(right.name, "pt-BR"));
    if (!cities.length) {
      target.textContent = "A distribuição por cidade não está disponível.";
      return;
    }
    const maximum = Math.max(...cities.map(item => item.total), 1);
    const content = document.createDocumentFragment();
    cities.forEach(city => {
      const row = document.createElement("div");
      row.className = "cockpit-summary-region";
      const name = document.createElement("span");
      name.className = "cockpit-summary-region-name";
      name.textContent = city.name;
      name.title = city.name;
      const track = document.createElement("span");
      track.className = "cockpit-summary-region-track";
      track.setAttribute("aria-hidden", "true");
      const bar = document.createElement("span");
      bar.className = "cockpit-summary-region-bar";
      bar.style.width = `${Math.max(2, (city.total / maximum) * 100)}%`;
      track.appendChild(bar);
      const count = document.createElement("span");
      count.className = "cockpit-summary-region-count";
      count.textContent = city.total.toLocaleString("pt-BR");
      row.append(name, track, count);
      content.appendChild(row);
    });
    target.replaceChildren(content);
  }
  function dateLabel(item) {
    const days = number(item?.dias_sem_verificacao ?? item?.dias_sem_acesso ?? item?.dias);
    if (days !== null) return `${days} dias`;
    const date = String(item?.ultima_verificacao || item?.data_ultimo_acesso || "").trim();
    return date || "—";
  }
  function cell(row, text, status) {
    const td = document.createElement("td");
    td.textContent = String(text || "—");
    if (status) td.dataset.status = status;
    row.appendChild(td);
    return td;
  }
  function renderRows() {
    const body = document.getElementById("cockpit-summary-rows");
    const title = document.getElementById("cockpit-summary-table-title");
    const count = document.getElementById("cockpit-summary-count");
    const status = document.getElementById("cockpit-summary-status");
    if (!body || !title || !count || !status) return;
    const rows = rowsForMetric(selectedMetric);
    const metricTotal = selectedMetric === "total" ? inventoryPage.total
      : selectedMetric === "sincronizados" ? metricValues().sincronizados.value
        : rows.length;
    title.textContent = `${labels[selectedMetric]}${metricTotal === null ? "" : ` · ${metricTotal.toLocaleString("pt-BR")}`}`;
    if (selectedMetric === "total" && inventoryPage.loading) {
      count.textContent = "Carregando equipamentos…";
    } else if (selectedMetric === "total") {
      const start = rows.length ? inventoryPage.offset + 1 : 0;
      const end = inventoryPage.offset + rows.length;
      count.textContent = inventoryPage.total
        ? `Mostrando ${start.toLocaleString("pt-BR")}–${end.toLocaleString("pt-BR")} de ${inventoryPage.total.toLocaleString("pt-BR")}`
        : "0 equipamentos";
    } else {
      count.textContent = `${rows.length.toLocaleString("pt-BR")} ${rows.length === 1 ? "registro" : "registros"}`;
    }
    const content = document.createDocumentFragment();
    rows.forEach(item => {
      const tr = document.createElement("tr");
      const currentSerial = serial(item);
      cell(tr, currentSerial || item.chave || "—");
      cell(tr, item.modelo || item.computador || item.hostname || item.tipo || "—");
      cell(tr, selectedMetric === "total"
        ? item.retirada_cidade || item.local || "—"
        : item.local_detalhes || item.localidade_simpress || "—");
      cell(tr, selectedMetric === "total" ? "—" : item.local_previsto || item.local_endpoint || item.localidade_endpoint || "—");
      cell(tr, selectedMetric === "total" ? "—" : dateLabel(item));
      const state = selectedMetric === "total" ? "ok"
        : selectedMetric === "sem_acesso_7_dias" ? "warning"
        : selectedMetric === "sincronizados" ? "ok" : "error";
      const statusText = selectedMetric === "total" ? "Na base local"
        : selectedMetric === "sem_acesso_7_dias" ? "Sem acesso"
        : selectedMetric === "sincronizados" ? "Sincronizado"
          : labels[item.__section] || labels[selectedMetric];
      cell(tr, statusText, state);
      const actionCell = document.createElement("td");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn btn-tertiary btn-sm";
      open.textContent = "Abrir";
      open.disabled = !currentSerial || currentSerial.includes("/");
      open.title = open.disabled ? "A série está ausente ou tem mais de uma correspondência." : `Abrir ${currentSerial} na Home`;
      open.addEventListener("click", () => abrirEquipamentoResumo(currentSerial));
      actionCell.appendChild(open);
      tr.appendChild(actionCell);
      content.appendChild(tr);
    });
    body.replaceChildren(content);
    const pagination = document.getElementById("cockpit-summary-pagination");
    const previous = document.getElementById("cockpit-summary-previous");
    const next = document.getElementById("cockpit-summary-next");
    const pageLabel = document.getElementById("cockpit-summary-page");
    if (pagination) pagination.hidden = selectedMetric !== "total" || inventoryPage.total <= INVENTORY_PAGE_SIZE;
    if (previous) previous.disabled = inventoryPage.loading || inventoryPage.offset <= 0;
    if (next) next.disabled = inventoryPage.loading || !inventoryPage.hasMore;
    if (pageLabel && selectedMetric === "total") {
      pageLabel.textContent = inventoryPage.total
        ? `Página ${Math.floor(inventoryPage.offset / INVENTORY_PAGE_SIZE) + 1} de ${Math.ceil(inventoryPage.total / INVENTORY_PAGE_SIZE)}`
        : "";
    }

    if (selectedMetric === "total") {
      status.textContent = inventoryPage.error || (inventoryPage.loading
        ? "Carregando equipamentos da base local…"
        : rows.length
          ? "Equipamentos da base local. Endpoint e último acesso são dados da comparação de inventários."
          : "Não há equipamentos cadastrados na base local.");
    } else if (selectedMetric === "sincronizados") {
      status.textContent = !comparison
        ? "Ainda não existe uma comparação de inventários disponível."
        : number(comparison.equipamentos_sincronizados) === null
          ? "A última comparação não contém uma contagem segura de equipamentos presentes nas duas fontes."
          : "A contagem vem de correspondências únicas nas duas fontes; a lista detalhada não é armazenada nesta seção.";
    } else {
      const keys = sections[selectedMetric] || [];
      const hasDetails = comparison && keys.every(key => Array.isArray(comparison[key]));
      status.textContent = rows.length
        ? "Dados da última comparação local."
        : !comparison
          ? "Ainda não existe uma comparação de inventários disponível."
          : hasDetails ? "Nenhum registro nesta categoria da última comparação." : "A comparação não contém os detalhes desta categoria.";
    }
  }
  function selecionarMetricaResumo(metric) {
    if (!Object.hasOwn(labels, metric)) return;
    selectedMetric = metric;
    document.querySelectorAll(".cockpit-summary-kpi[data-metric]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.metric === metric));
    });
    if (metric === "total") void carregarPaginaInventarioResumo(0);
    else {
      inventoryRequestId += 1;
      renderRows();
    }
  }
  async function carregarPaginaInventarioResumo(offset) {
    const requestId = ++inventoryRequestId;
    inventoryPage = { items: [], offset, total: 0, hasMore: false, loading: true, error: "" };
    renderRows();
    try {
      const params = new URLSearchParams({
        listar_todos: "true",
        offset: String(offset),
        limit: String(INVENTORY_PAGE_SIZE),
      });
      const response = await fetch(`/api/buscar-expandida?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível carregar os equipamentos da base local.");
      const result = await response.json();
      if (requestId !== inventoryRequestId || selectedMetric !== "total") return;
      inventoryPage = {
        items: list(result?.items),
        offset: number(result?.offset) ?? offset,
        total: number(result?.total) ?? 0,
        hasMore: result?.has_more === true,
        loading: false,
        error: "",
      };
    } catch (error) {
      if (requestId !== inventoryRequestId || selectedMetric !== "total") return;
      inventoryPage = { items: [], offset, total: 0, hasMore: false, loading: false, error: error.message || "Falha ao consultar a base local." };
    }
    renderRows();
  }
  async function abrirEquipamentoResumo(serialValue) {
    const input = document.getElementById("input-serial");
    if (!input || !serialValue) return;
    input.value = serialValue;
    app.ativarAbaTransferencia("home");
    await app.buscarSerial();
  }
  async function exportarResumoCockpit() {
    const eventDate = String(event?.horario || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      app.showToast("Ainda não existe uma data de comparação para exportar.", "warning");
      return;
    }
    const button = document.getElementById("btn-exportar-resultado-comparacao");
    if (!button) return;
    button.dataset.historyDate = eventDate;
    button.disabled = false;
    await app.exportarResultadoComparacaoPlanilhas();
  }
  async function carregarResumoCockpit() {
    const root = document.getElementById("resumo-cards");
    if (!root) return;
    root.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/painel", { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível consultar o painel local.");
      dashboard = await response.json();
      event = null;
      comparison = null;
      const eventId = String(dashboard?.ultima_comparacao?.id || "");
      if (eventId) {
        const historyResponse = await fetch(`/api/historico-comparacoes/${encodeURIComponent(eventId)}`, { cache: "no-store" });
        if (!historyResponse.ok) throw new Error("Não foi possível consultar a última comparação.");
        event = (await historyResponse.json())?.evento || null;
        comparison = event?.comparacao && typeof event.comparacao === "object" ? event.comparacao : null;
      }
      const count = document.getElementById("btn-cockpit-summary-export");
      if (count) count.disabled = !event?.horario;
      root.dataset.state = "ready";
      renderKpis();
      renderRegions();
      renderRows();
    } catch (error) {
      root.dataset.state = "error";
      const status = document.getElementById("cockpit-summary-status");
      if (status) status.textContent = error.message || "Não foi possível carregar o resumo local.";
      const kpis = document.getElementById("cockpit-summary-kpis");
      if (kpis) kpis.textContent = "Indicadores indisponíveis enquanto o servidor local não responde.";
      renderRegions();
      renderRows();
    } finally {
      root.setAttribute("aria-busy", "false");
    }
  }

  document.getElementById("cockpit-summary-previous")?.addEventListener("click", () => {
    if (selectedMetric === "total" && inventoryPage.offset > 0) {
      void carregarPaginaInventarioResumo(Math.max(0, inventoryPage.offset - INVENTORY_PAGE_SIZE));
    }
  });
  document.getElementById("cockpit-summary-next")?.addEventListener("click", () => {
    if (selectedMetric === "total" && inventoryPage.hasMore) {
      void carregarPaginaInventarioResumo(inventoryPage.offset + INVENTORY_PAGE_SIZE);
    }
  });

  return { carregarResumoCockpit, exportarResumoCockpit, selecionarMetricaResumo };
});
