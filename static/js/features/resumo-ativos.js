/** Resumo (painel de ferramenta "comparacao"): ativos por regional e lista paginada do total de ativos, só com a API local. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).resumoAtivos = factory;
})(typeof window !== "undefined" ? window : globalThis, function createResumoAtivos(context) {
  "use strict";
  const { app, motion } = context;
  const PAGE_SIZE = 50;
  const LOAD_ERROR = "Não foi possível carregar os equipamentos da base local.";
  const columnLabels = ["Série", "Modelo / host", "Simpress", "Ação"];
  let page = { items: [], offset: 0, total: 0, hasMore: false, loading: false, error: "" };
  let pageRequestId = 0;

  function list(value) { return Array.isArray(value) ? value.filter(item => item && typeof item === "object") : []; }
  function number(value) {
    if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  function serial(item) { return String(item?.serie || item?.serial || item?.chave || "").trim(); }

  function renderRegions(dashboard) {
    const target = document.getElementById("resumo-regionais");
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
    const rows = [];
    cities.forEach(city => {
      const row = document.createElement("div");
      row.className = "ck-barra";
      const name = document.createElement("span");
      name.className = "ck-barra__nome";
      name.textContent = city.name;
      name.title = city.name;
      const track = document.createElement("span");
      track.className = "ck-barra__trilho";
      track.setAttribute("aria-hidden", "true");
      const bar = document.createElement("span");
      bar.className = "ck-barra__cheio";
      bar.style.width = `${Math.max(2, (city.total / maximum) * 100)}%`;
      track.appendChild(bar);
      const count = document.createElement("span");
      count.className = "ck-barra__valor";
      count.textContent = city.total.toLocaleString("pt-BR");
      row.append(name, track, count);
      rows.push(row);
    });
    target.replaceChildren(...rows);
  }

  function cell(row, text) {
    const td = document.createElement("td");
    td.textContent = String(text || "—");
    td.dataset.label = columnLabels[row.children.length] || "";
    row.appendChild(td);
  }

  function renderTotal() {
    const body = document.getElementById("resumo-total-ativos");
    const count = document.getElementById("resumo-total-contagem");
    const status = document.getElementById("resumo-total-status");
    if (!body || !count || !status) return;
    const rows = page.items;
    if (page.loading) count.textContent = "Carregando equipamentos…";
    else if (page.total && !rows.length) count.textContent = `${page.total.toLocaleString("pt-BR")} equipamentos`;
    else if (page.total) {
      const start = page.offset + 1;
      const end = page.offset + rows.length;
      count.textContent = `Mostrando ${start.toLocaleString("pt-BR")}–${end.toLocaleString("pt-BR")} de ${page.total.toLocaleString("pt-BR")}`;
    } else count.textContent = "0 equipamentos";
    const trs = [];
    rows.forEach(item => {
      const tr = document.createElement("tr");
      const currentSerial = serial(item);
      tr.dataset.serial = currentSerial.toUpperCase();
      cell(tr, currentSerial);
      cell(tr, item.modelo || item.computador || item.hostname || item.tipo);
      cell(tr, item.retirada_cidade || item.local);
      const actionCell = document.createElement("td");
      actionCell.dataset.label = columnLabels[3];
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ck-btn ck-btn--fantasma ck-btn--sm";
      open.textContent = "Abrir";
      open.disabled = !currentSerial || currentSerial.includes("/");
      open.title = open.disabled ? "A série está ausente ou tem mais de uma correspondência." : `Abrir ${currentSerial} na Home`;
      open.addEventListener("click", () => abrirEquipamentoResumo(currentSerial));
      actionCell.appendChild(open);
      tr.appendChild(actionCell);
      trs.push(tr);
    });
    body.replaceChildren(...trs);
    const pagination = document.getElementById("resumo-total-paginacao");
    const previous = document.getElementById("resumo-total-anterior");
    const next = document.getElementById("resumo-total-proxima");
    const pageLabel = document.getElementById("resumo-total-pagina");
    if (pagination) pagination.hidden = page.total <= PAGE_SIZE;
    if (previous) previous.disabled = page.loading || page.offset <= 0;
    if (next) next.disabled = page.loading || !page.hasMore;
    if (pageLabel) {
      pageLabel.textContent = page.total
        ? `Página ${Math.floor(page.offset / PAGE_SIZE) + 1} de ${Math.ceil(page.total / PAGE_SIZE)}`
        : "";
    }
    status.dataset.estado = page.error ? "erro" : page.loading ? "carregando" : "pronto";
    status.textContent = page.error || (page.loading
      ? "Carregando equipamentos da base local…"
      : rows.length ? "Equipamentos da base local." : "Não há equipamentos cadastrados na base local.");
  }

  async function carregarPaginaAtivosResumo(offset) {
    const requestId = ++pageRequestId;
    const knownTotal = page.total;
    page = { items: [], offset, total: 0, hasMore: false, loading: true, error: "" };
    renderTotal();
    try {
      const params = new URLSearchParams({ listar_todos: "true", offset: String(offset), limit: String(PAGE_SIZE) });
      const response = await fetch(`/api/buscar-expandida?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(LOAD_ERROR);
      const result = await response.json();
      if (requestId !== pageRequestId) return;
      page = {
        items: list(result?.items),
        offset: number(result?.offset) ?? offset,
        total: number(result?.total) ?? 0,
        hasMore: result?.has_more === true,
        loading: false,
        error: "",
      };
    } catch {
      if (requestId !== pageRequestId) return;
      // Mantém o total conhecido: com erro numa página, o Anterior continua disponível em vez de a paginação sumir.
      page = { items: [], offset, total: knownTotal, hasMore: false, loading: false, error: LOAD_ERROR };
    }
    renderTotal();
  }

  async function carregarRegionaisResumo() {
    const target = document.getElementById("resumo-regionais");
    if (!target) return;
    target.dataset.estado = "carregando";
    const stopLoading = motion?.startLoading(target, "Carregando dados da base local…") || (() => {});
    try {
      const response = await fetch("/api/painel", { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível consultar o painel local.");
      const dashboard = await response.json();
      target.dataset.estado = "pronto";
      stopLoading();
      renderRegions(dashboard);
    } catch {
      target.dataset.estado = "erro";
      stopLoading();
      target.textContent = "A distribuição por regional está indisponível enquanto o servidor local não responde.";
    } finally {
      stopLoading();
      target.setAttribute("aria-busy", "false");
    }
  }

  async function abrirEquipamentoResumo(serialValue) {
    const input = document.getElementById("input-serial");
    if (!input || !serialValue) return;
    input.value = serialValue;
    app.ativarAbaTransferencia("home");
    await app.buscarSerial();
  }

  // Chamado ao abrir o painel: recarrega as regionais e volta o total à primeira página.
  function carregarResumoAtivos() {
    return Promise.all([carregarRegionaisResumo(), carregarPaginaAtivosResumo(0)]);
  }

  document.getElementById("resumo-total-anterior")?.addEventListener("click", () => {
    if (page.offset > 0) void carregarPaginaAtivosResumo(Math.max(0, page.offset - PAGE_SIZE));
  });
  document.getElementById("resumo-total-proxima")?.addEventListener("click", () => {
    if (page.hasMore) void carregarPaginaAtivosResumo(page.offset + PAGE_SIZE);
  });

  return { carregarResumoAtivos };
});
