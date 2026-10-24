(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.SimpressDataPanels = api;
    if (root.document) api.install(root);
  }
})(typeof window !== "undefined" ? window : globalThis, function createDataPanels() {
  "use strict";

  const ENDPOINT = "/api/painel";
  const DENSITY_KEY = "simpress:table-density";
  const REFRESH_MIN_MS = 15000;
  const DIVERGENCE_FIELDS = Object.freeze(["divergencias_local", "divergencias_apelidos_manuais"]);

  // ---------- sorting helpers (pure) ----------
  const DATE_BR = /^(\d{2})\/(\d{2})\/(\d{4})(?:\D+(\d{2}):(\d{2}))?/;
  const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

  function sortKey(text) {
    const value = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!value || value === "—" || value === "-") return { kind: "empty", value: "" };
    const date = DATE_BR.exec(value);
    if (date) {
      const [, day, month, year, hour = "0", minute = "0"] = date;
      return { kind: "number", value: Date.UTC(+year, +month - 1, +day, +hour, +minute) };
    }
    if (NUMBER.test(value)) return { kind: "number", value: parseFloat(value.replace(",", ".")) };
    return { kind: "text", value };
  }

  function compareValues(a, b) {
    const left = sortKey(a);
    const right = sortKey(b);
    if (left.kind === "empty" || right.kind === "empty") {
      return left.kind === right.kind ? 0 : left.kind === "empty" ? 1 : -1;
    }
    if (left.kind === "number" && right.kind === "number") return left.value - right.value;
    if (left.kind !== right.kind) return left.kind === "number" ? -1 : 1;
    return left.value.localeCompare(right.value, "pt-BR", { numeric: true, sensitivity: "base" });
  }

  // Cycle: none -> ascending -> descending -> none.
  function nextDirection(current) {
    return current === "ascending" ? "descending" : current === "descending" ? "none" : "ascending";
  }

  // Returns the original indexes in display order; ties keep the original order (stable).
  function sortedOrder(texts, direction) {
    const indexes = texts.map((_, index) => index);
    if (direction !== "ascending" && direction !== "descending") return indexes;
    const sign = direction === "ascending" ? 1 : -1;
    return indexes.sort((a, b) => {
      const left = sortKey(texts[a]);
      const right = sortKey(texts[b]);
      // Empty values always stay last, whatever the direction.
      if (left.kind === "empty" || right.kind === "empty") {
        return left.kind === right.kind ? a - b : left.kind === "empty" ? 1 : -1;
      }
      return sign * compareValues(texts[a], texts[b]) || a - b;
    });
  }

  function toTsv(headers, rows) {
    const clean = value => String(value ?? "").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return [headers, ...rows].map(row => row.map(clean).join("\t")).join("\n");
  }

  // ---------- dashboard helpers (pure) ----------
  function divergenceTotal(latest) {
    const items = Array.isArray(latest?.atencao) ? latest.atencao : [];
    return items
      .filter(item => DIVERGENCE_FIELDS.includes(item?.campo))
      .reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  }

  function barPercentages(entries) {
    const max = Math.max(0, ...entries.map(entry => Number(entry.total) || 0));
    return entries.map(entry => (max ? Math.max(4, Math.round(((Number(entry.total) || 0) / max) * 100)) : 0));
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("pt-BR");
  }

  function formatMoment(iso) {
    const date = new Date(iso);
    if (!iso || Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function pluralize(count, singular, plural) {
    return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
  }

  // ---------- browser behaviour ----------
  function install(win) {
    const doc = win.document;
    if (!doc || install.done) return;
    install.done = true;

    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const safeStorage = {
      get(key) { try { return win.localStorage.getItem(key); } catch (_) { return null; } },
      set(key, value) { try { win.localStorage.setItem(key, value); } catch (_) { /* optional convenience */ } },
    };
    const toast = (message, type) => {
      if (typeof win.showToast === "function") win.showToast(message, type);
    };

    // ----- density -----
    function applyDensity(density) {
      if (density === "compact") doc.documentElement.setAttribute("data-ux-density", "compact");
      else doc.documentElement.removeAttribute("data-ux-density");
      doc.querySelectorAll("[data-ux-density-toggle]").forEach(button => {
        button.setAttribute("aria-pressed", String(density === "compact"));
      });
    }
    applyDensity(safeStorage.get(DENSITY_KEY) === "compact" ? "compact" : "comfortable");

    // ----- sortable / copyable tables -----
    function isActionColumn(rows, column) {
      const cells = rows.map(row => row.cells[column]).filter(Boolean);
      return cells.length > 0 && cells.every(cell => cell.querySelector("textarea, input, select, button"));
    }

    function cellText(cell) {
      if (!cell) return "";
      const field = cell.querySelector("textarea, input");
      return field ? field.value : cell.textContent;
    }

    function visibleRows(tbody) {
      return Array.from(tbody.rows).filter(row => !row.hidden && win.getComputedStyle(row).display !== "none");
    }

    function enhanceTable(table) {
      if (table.dataset.uxTable) return;
      const tbody = table.tBodies[0];
      const headRow = table.tHead?.rows[0];
      if (!tbody || !headRow || !tbody.rows.length) return;
      table.dataset.uxTable = "ready";
      const originalOrder = Array.from(tbody.rows);
      const headers = Array.from(headRow.cells);

      headers.forEach((th, column) => {
        if (isActionColumn(originalOrder, column)) return;
        const label = th.textContent.trim();
        const button = el("button", "ux-sort-button");
        button.type = "button";
        button.setAttribute("aria-label", `Ordenar por ${label}`);
        button.append(el("span", "", label), el("span", "ux-sort-icon"));
        button.lastChild.setAttribute("aria-hidden", "true");
        th.replaceChildren(button);
        th.setAttribute("aria-sort", "none");
        button.addEventListener("click", () => {
          const direction = nextDirection(th.getAttribute("aria-sort"));
          headers.forEach(other => { if (other.hasAttribute("aria-sort")) other.setAttribute("aria-sort", "none"); });
          th.setAttribute("aria-sort", direction);
          // Rows are moved, never recreated, so annotation fields keep their values and listeners.
          const current = originalOrder.slice();
          const texts = current.map(row => cellText(row.cells[column]));
          const order = sortedOrder(texts, direction);
          const fragment = doc.createDocumentFragment();
          order.forEach(index => fragment.appendChild(current[index]));
          tbody.appendChild(fragment);
          announceSort(label, direction);
        });
      });

      const wrap = table.closest(".comparison-desktop-table");
      if (wrap && !wrap.previousElementSibling?.classList?.contains("ux-table-tools")) {
        const tools = el("div", "ux-table-tools");
        const copy = el("button", "ux-table-tool", "Copiar tabela");
        copy.type = "button";
        copy.addEventListener("click", () => copyTable(table, copy));
        const density = el("button", "ux-table-tool", "Modo compacto");
        density.type = "button";
        density.setAttribute("data-ux-density-toggle", "");
        density.setAttribute("aria-pressed", String(doc.documentElement.getAttribute("data-ux-density") === "compact"));
        density.addEventListener("click", () => {
          const next = doc.documentElement.getAttribute("data-ux-density") === "compact" ? "comfortable" : "compact";
          safeStorage.set(DENSITY_KEY, next);
          applyDensity(next);
        });
        tools.append(copy, density);
        wrap.parentNode.insertBefore(tools, wrap);
      }
    }

    function announceSort(label, direction) {
      const text = direction === "none"
        ? "Ordem original restaurada."
        : `Ordenado por ${label}, ${direction === "ascending" ? "crescente" : "decrescente"}.`;
      let region = doc.getElementById("ux-sort-status");
      if (!region) {
        region = el("div", "sr-only");
        region.id = "ux-sort-status";
        region.setAttribute("role", "status");
        region.setAttribute("aria-live", "polite");
        doc.body.appendChild(region);
      }
      region.textContent = text;
    }

    async function copyTable(table, button) {
      const headRow = table.tHead.rows[0];
      const headers = Array.from(headRow.cells).map(cell => cell.textContent);
      const rows = visibleRows(table.tBodies[0]).map(row => Array.from(row.cells).map(cellText));
      const text = toTsv(headers, rows);
      try {
        if (typeof win.copiarTextoParaAreaTransferencia === "function") await win.copiarTextoParaAreaTransferencia(text);
        else await win.navigator.clipboard.writeText(text);
        toast(`Tabela copiada (${pluralize(rows.length, "linha", "linhas")}).`, "success");
      } catch (_) {
        toast("Não foi possível copiar a tabela.", "error");
      }
    }

    function scanTables() {
      doc.querySelectorAll(".comparison-desktop-table table:not([data-ux-table])").forEach(enhanceTable);
    }

    // ----- Home panel -----
    let panel = null;
    let lastFetch = 0;
    let requestSerial = 0;
    let cityFilter = "";
    let panelExpanded = true;
    let ticketSummaryRequestSerial = 0;

    function ensurePanel() {
      if (panel) return panel;
      // Lives in the Resumo tab, above the usage card.
      const host = doc.getElementById("resumo-cards");
      if (!host) return null;
      panel = el("section", "ux-home-panel glass-card");
      panel.id = "ux-home-panel";
      panel.setAttribute("aria-labelledby", "ux-home-panel-title");
      panel.hidden = true;
      host.prepend(panel);
      return panel;
    }

    function stat(label, value, extra) {
      const box = el("div", "ux-stat");
      box.append(el("span", "ux-stat-value", formatNumber(value)), el("span", "ux-stat-label", label));
      if (extra) box.append(el("span", "ux-stat-extra", extra));
      return box;
    }

    function renderPanel(data) {
      const host = ensurePanel();
      if (!host) return;
      host.replaceChildren();
      const title = el("h2", "ux-home-title", "Resumo do parque");
      title.id = "ux-home-panel-title";
      const header = el("div", "ux-home-header");
      header.append(title);
      host.append(header);
      if (!data.base_importada) {
        host.append(el("p", "ux-home-empty", "Nenhuma base importada ainda. Use “Atualizar planilhas” para carregar os equipamentos."));
        host.hidden = false;
        ensureTicketSummary();
        return;
      }
      const stats = el("div", "ux-stat-grid");
      stats.setAttribute("role", "list");
      stats.append(stat("Equipamentos", data.total_equipamentos), stat("Unidades", data.total_unidades));
      (data.por_categoria || []).forEach(category => stats.append(stat(category.label, category.total)));
      stats.querySelectorAll(".ux-stat").forEach(item => item.setAttribute("role", "listitem"));
      const body = el("div", "ux-home-body");
      body.id = "ux-home-body";
      body.hidden = !panelExpanded;
      body.append(stats);

      const columns = el("div", "ux-home-columns");
      if ((data.cidades_principais || []).length) {
        const block = el("div", "ux-home-block");
        const head = el("div", "ux-city-head");
        head.append(el("h3", "ux-home-subtitle", "Cidades com mais equipamentos"));
        const categories = data.por_categoria || [];
        if (!categories.some(category => category.value === cityFilter)) cityFilter = "";
        const select = el("select", "ux-city-filter");
        select.setAttribute("aria-label", "Filtrar cidades por tipo de equipamento");
        [{ value: "", label: "Todos" }, ...categories].forEach(option => {
          const node = el("option", "", option.label);
          node.value = option.value;
          select.append(node);
        });
        select.value = cityFilter;
        head.append(select);
        block.append(head);
        const listHost = el("div", "ux-city-list");
        const fillList = () => {
          const cities = cityFilter ? (data.cidades_por_categoria?.[cityFilter] || []) : (data.cidades_principais || []);
          listHost.replaceChildren();
          if (!cities.length) {
            listHost.append(el("p", "ux-home-note", "Nenhum equipamento desse tipo com cidade informada."));
            return;
          }
          const list = el("ul", "ux-bars");
          const widths = barPercentages(cities);
          cities.forEach((city, index) => {
            const row = el("li", "ux-bar-row");
            const bar = el("span", "ux-bar");
            bar.setAttribute("aria-hidden", "true");
            const fill = el("span", "ux-bar-fill");
            fill.style.width = `${widths[index]}%`;
            bar.append(fill);
            row.append(el("span", "ux-bar-label", city.cidade), bar, el("span", "ux-bar-value", formatNumber(city.total)));
            list.append(row);
          });
          listHost.append(list);
        };
        select.addEventListener("change", () => { cityFilter = select.value; fillList(); });
        fillList();
        block.append(listHost);
        if (data.sem_cidade > 0) block.append(el("p", "ux-home-note", `${pluralize(data.sem_cidade, "equipamento sem cidade", "equipamentos sem cidade")} na base.`));
        columns.append(block);
      }

      const status = el("div", "ux-home-block");
      status.append(el("h3", "ux-home-subtitle", "Última atualização"));
      const when = data.ultima_comparacao?.horario ? formatMoment(data.ultima_comparacao.horario) : data.ultima_atualizacao;
      status.append(el("p", "ux-home-note", when ? `${when}${data.arquivo_origem ? ` · ${data.arquivo_origem}` : ""}` : "Sem registro de atualização."));
      const attention = data.ultima_comparacao?.atencao || [];
      if (attention.length) {
        const list = el("ul", "ux-attention");
        attention.forEach(item => {
          const row = el("li", "ux-attention-row");
          const eventId = data.ultima_comparacao?.id;
          if (eventId && typeof win.abrirResultadoHistoricoComparacao === "function") {
            const button = el("button", "ux-attention-row-button");
            button.type = "button";
            button.setAttribute("aria-label", `${item.rotulo}: ${formatNumber(item.total)}. Abrir esta seção no resultado da última atualização.`);
            button.append(el("span", "", item.rotulo), el("strong", "", formatNumber(item.total)));
            button.addEventListener("click", () => win.abrirResultadoHistoricoComparacao(eventId, item.campo, button));
            row.append(button);
          } else {
            row.append(el("span", "", item.rotulo), el("strong", "", formatNumber(item.total)));
          }
          list.append(row);
        });
        status.append(list);
      } else if (data.ultima_comparacao) {
        status.append(el("p", "ux-home-note ux-home-note--ok", "Nenhum ponto de atenção na última comparação."));
      }
      columns.append(status);
      body.append(columns);
      const toggle = el("button", "ux-home-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-controls", "ux-home-body");
      const syncToggle = () => {
        body.hidden = !panelExpanded;
        toggle.setAttribute("aria-expanded", String(panelExpanded));
        toggle.textContent = panelExpanded ? "Minimizar" : "Maximizar";
        title.classList.toggle("ux-home-title--collapsed", !panelExpanded);
      };
      toggle.addEventListener("click", () => { panelExpanded = !panelExpanded; syncToggle(); });
      syncToggle();
      header.append(toggle);
      host.append(body);
      host.hidden = false;
      ensureTicketSummary();
    }

    function ensureTicketSummary() {
      const host = doc.getElementById("resumo-cards");
      if (!host) return null;
      let section = doc.getElementById("resumo-os-equipamento");
      if (!section) {
        section = el("section", "ticket-summary-section glass-card");
        section.id = "resumo-os-equipamento";
        section.setAttribute("aria-labelledby", "resumo-os-equipamento-title");
        const title = el("h2", "ux-home-title", "OS por equipamento");
        title.id = "resumo-os-equipamento-title";
        const status = el("p", "ux-home-note ticket-summary-status", "Abra a aba Resumo para carregar as OS.");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        section.append(title, status);
        host.append(section);
      }
      return section;
    }

    function osSummaryRequest(url, options) {
      return win.fetch(url, { headers: { Accept: "application/json", ...(options?.headers || {}) }, ...options })
        .then(async response => {
          let data = {};
          try { data = await response.json(); } catch (_) { /* handled as an HTTP error below */ }
          if (!response.ok) throw new Error(data.detail || `Falha ${response.status}`);
          return data;
        });
    }

    function serialKey(value) {
      return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    }

    function orderKey(value) {
      return String(value || "").replace(/\s+/g, "").toUpperCase();
    }

    function ticketOsLinkKey(record) {
      return JSON.stringify([record.fonte, serialKey(record.serie), orderKey(record.os)]);
    }

    function ticketSummarySourceLabel(sources) {
      const selected = Array.isArray(sources) ? sources : [sources];
      const labels = [];
      if (selected.includes("oracle")) labels.push("Oracle");
      if (selected.includes("simpress")) labels.push("Simpress");
      return labels.join(" + ") || "Fonte não informada";
    }

    function renderTicketSummaryOrderButton(record, label = record.os) {
      const button = el("button", "ticket-summary-order ticket-summary-order-link", label);
      const sources = Array.isArray(record.fontes) ? record.fontes : [record.fonte];
      button.type = "button";
      button.setAttribute("aria-label", "Abrir acompanhamento de chamados: " + ticketSummarySourceLabel(sources)
        + ", série " + record.serie + ", OS " + record.os);
      button.setAttribute("data-on-click", "abrirChamadoDaOs");
      button.setAttribute("data-args", JSON.stringify([sources, record.serie, record.os]));
      return button;
    }

    function collectTicketOsRows(report) {
      const rows = [];
      (Array.isArray(report?.chamados) ? report.chamados : []).forEach(ticket => {
        const serie = String(ticket?.serie || "").trim();
        if (!serie) return;
        const simpress = ticket?.simpress || {};
        const seenSimpressOrders = new Set();
        (Array.isArray(simpress.ordens_servico) ? simpress.ordens_servico : []).forEach(value => {
          const os = String(value || "").trim();
          const key = orderKey(os);
          if (!key || seenSimpressOrders.has(key)) return;
          seenSimpressOrders.add(key);
          rows.push({ fonte: "simpress", serie, os, descricao: "" });
        });

        const oracleByOrder = new Map();
        (Array.isArray(ticket?.oracle) ? ticket.oracle : []).forEach(request => {
          const os = String(request?.ordem_servico || "").trim();
          const key = orderKey(os);
          if (!key) return;
          if (!oracleByOrder.has(key)) oracleByOrder.set(key, { fonte: "oracle", serie, os, solicitacoes: [] });
          const group = oracleByOrder.get(key);
          const solicitacao = String(request?.solicitacao || "").trim();
          const descricao = String(request?.descricao || "").trim();
          if (solicitacao || descricao) group.solicitacoes.push({ solicitacao, descricao });
        });
        oracleByOrder.forEach(record => {
          record.descricao = record.solicitacoes.length
            ? record.solicitacoes.map(item => `${item.solicitacao ? `Solicitação ${item.solicitacao}: ` : ""}${item.descricao || "Descrição não informada"}`).join("\n")
            : "";
          rows.push(record);
        });
      });
      const compareOrder = (left, right) => {
        const numeric = value => /[A-Za-z]/.test(value) ? null : value.replace(/\D/g, "");
        const leftDigits = numeric(left.os);
        const rightDigits = numeric(right.os);
        if (leftDigits && rightDigits) {
          const a = BigInt(leftDigits);
          const b = BigInt(rightDigits);
          if (a !== b) return a > b ? -1 : 1;
        } else if (leftDigits && !rightDigits) return -1;
        else if (!leftDigits && rightDigits) return 1;
        return right.os.localeCompare(left.os, "pt-BR", { numeric: true, sensitivity: "base" })
          || left.fonte.localeCompare(right.fonte, "pt-BR");
      };
      return rows.sort(compareOrder);
    }

    function groupTicketOsRows(rows) {
      const groups = new Map();
      rows.forEach(record => {
        const key = serialKey(record.serie) || String(record.serie).trim().toUpperCase();
        if (!groups.has(key)) groups.set(key, { serie: record.serie, ordens: [] });
        const group = groups.get(key);
        let order = group.ordens.find(item => orderKey(item.os) === orderKey(record.os));
        if (!order) {
          order = { serie: record.serie, os: record.os, fontes: [], descricao: "" };
          group.ordens.push(order);
        }
        if (!order.fontes.includes(record.fonte)) order.fontes.push(record.fonte);
        if (record.fonte === "oracle" && record.descricao) {
          const descriptions = order.descricao ? order.descricao.split("\n") : [];
          if (!descriptions.includes(record.descricao)) descriptions.push(record.descricao);
          order.descricao = descriptions.join("\n");
        }
      });
      const result = [...groups.values()];
      result.forEach(group => {
        group.ordens.forEach(order => {
          order.fontes = ["oracle", "simpress"].filter(source => order.fontes.includes(source));
        });
        group.fontes = ["oracle", "simpress"].filter(source =>
          group.ordens.some(order => order.fontes.includes(source)));
      });
      return result;
    }

    function ticketUserLabel(user) {
      if (!user) return "Não informado";
      const candidates = Array.isArray(user.candidatos) ? user.candidatos.filter(Boolean) : [];
      if (candidates.length) return `Ambíguo: ${candidates.join(" / ")}`;
      return String(user.usuario || "Não informado");
    }

    function ticketHostnameLabel(user) {
      if (!user) return "Não informado";
      const candidates = Array.isArray(user.hostname_candidatos) ? user.hostname_candidatos.filter(Boolean) : [];
      if (user.hostname_ambiguo) return candidates.length ? `Ambíguo: ${candidates.join(" / ")}` : "Ambíguo no cadastro";
      return String(user.hostname || "Não informado");
    }

    function renderTicketSummaryOrders(record) {
      const list = el("div", "ticket-summary-orders");
      record.ordens.forEach(order => {
        const item = el("div", "ticket-summary-order-item");
        item.append(renderTicketSummaryOrderButton(order),
          el("span", "ticket-summary-order-sources", ticketSummarySourceLabel(order.fontes)));
        list.append(item);
      });
      return list;
    }

    function renderTicketSummaryDescriptions(record) {
      const descriptions = record.ordens.filter(order => order.fontes.includes("oracle"));
      const list = el("div", "ticket-summary-descriptions");
      if (!descriptions.length) {
        list.append(el("span", "ticket-summary-description", "Descrição não informada"));
        return list;
      }
      descriptions.forEach(order => {
        const item = el("div", "ticket-summary-description-entry");
        item.append(el("strong", "ticket-summary-description-label", "OS " + order.os + " · Oracle"),
          el("p", "ticket-summary-description", order.descricao || "Descrição não informada"));
        list.append(item);
      });
      return list;
    }

    function renderTicketOsLinkEditors(record, links, canSave, statusMessage) {
      const list = el("div", "ticket-os-link-editors");
      record.ordens.forEach(order => {
        order.fontes.forEach(source => {
          const sourceRecord = { fonte: source, serie: record.serie, os: order.os };
          const item = el("div", "ticket-os-link-entry");
          item.append(el("span", "ticket-os-link-entry-label",
            ticketSummarySourceLabel([source]) + " · OS " + order.os));
          item.append(renderTicketOsLinkEditor(sourceRecord,
            links.get(ticketOsLinkKey(sourceRecord)), canSave, statusMessage));
          list.append(item);
        });
      });
      return list;
    }

    function renderTicketOsLinkEditor(record, saved, canSave, statusMessage) {
      const editor = el("div", "ticket-os-link-editor");
      if (!canSave) {
        editor.append(el("span", "ticket-os-link-value", saved?.chamado || "Não informado"));
        return editor;
      }
      const form = el("form", "ticket-os-link-form");
      const year = Number(saved?.ano) || new Date().getFullYear();
      const label = el("label", "ticket-os-link-label", "Número do chamado UTIC");
      const controls = el("div", "ticket-os-link-controls");
      const prefix = el("span", "ticket-os-link-prefix", `UTIC-${year}-`);
      const input = el("input", "ticket-os-link-input");
      input.type = "text";
      input.inputMode = "numeric";
      input.pattern = "[0-9]*";
      input.maxLength = 24;
      input.autocomplete = "off";
      input.value = saved?.numero || "";
      input.placeholder = "0000";
      input.setAttribute("aria-label", "Número do chamado para OS " + record.os
        + ", série " + record.serie + ", fonte " + ticketSummarySourceLabel([record.fonte]));
      const save = el("button", "btn btn-secondary ticket-os-link-save", saved ? "Atualizar" : "Salvar");
      save.type = "submit";
      controls.append(prefix, input, save);
      if (saved) {
        const remove = el("button", "btn btn-tertiary ticket-os-link-remove", "Remover vínculo");
        remove.type = "button";
        remove.addEventListener("click", () => persistTicketOsLink(record, year, "", input, save, remove, statusMessage));
        controls.append(remove);
      }
      form.append(label, controls);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const numero = input.value.trim();
        if (!/^\d{1,24}$/.test(numero)) {
          statusMessage.textContent = "Digite os números depois do prefixo UTIC.";
          input.focus();
          return;
        }
        persistTicketOsLink(record, year, numero, input, save, null, statusMessage);
      });
      editor.append(form);
      return editor;
    }

    async function persistTicketOsLink(record, year, numero, input, save, remove, statusMessage) {
      const buttons = [save, remove].filter(Boolean);
      buttons.forEach(button => { button.disabled = true; button.setAttribute("aria-busy", "true"); });
      statusMessage.textContent = "Salvando vínculo…";
      try {
        await osSummaryRequest("/api/operacoes/chamados/vinculos-os", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...record, ano: year, numero }),
        });
        await refreshTicketSummary(true);
        statusMessage.textContent = numero ? `Vínculo salvo: UTIC-${year}-${numero}.` : "Vínculo removido.";
      } catch (error) {
        statusMessage.textContent = error.message || "Não foi possível salvar o vínculo.";
        buttons.forEach(button => { button.disabled = false; button.removeAttribute("aria-busy"); });
        input?.focus();
      }
    }

    function renderTicketSummary(section, records, users, links, canSave, userFailure) {
      const status = section.querySelector(".ticket-summary-status");
      const content = el("div", "ticket-summary-content");
      if (!records.length) {
        status.textContent = "Nenhuma OS vinculada por série na importação atual.";
        section.setAttribute("aria-busy", "false");
        section.querySelector(".ticket-summary-content")?.remove();
        section.append(content);
        return;
      }
      const orderCount = records.reduce((total, record) => total + record.ordens.length, 0);
      status.textContent = userFailure
        ? orderCount + " OS agrupadas por série; dados de usuário e hostname estão indisponíveis."
        : orderCount + " OS · " + records.length + (records.length === 1 ? " série" : " séries");
      const tableWrap = el("div", "ticket-summary-table-wrap");
      const table = el("table", "ticket-summary-table");
      table.append(el("caption", "sr-only", "Ordens de serviço associadas a equipamentos"));
      const header = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      ["Fonte", "Série", "OS", "Usuário", "Hostname", "Chamado", "Descrição do chamado"].forEach(title => {
        const cell = el("th", "", title);
        cell.scope = "col";
        headRow.append(cell);
      });
      header.append(headRow);
      table.append(header);
      const body = doc.createElement("tbody");
      const mobileCards = el("div", "ticket-summary-mobile");
      records.forEach(record => {
        const user = users[record.serie];
        const values = [ticketSummarySourceLabel(record.fontes), record.serie, "",
          userFailure ? "Indisponível" : ticketUserLabel(user), userFailure ? "Indisponível" : ticketHostnameLabel(user),
          "", ""];
        const row = doc.createElement("tr");
        values.forEach((value, index) => {
          const cell = el("td", "", value);
          cell.setAttribute("data-label", ["Fonte", "Série", "OS", "Usuário", "Hostname", "Chamado", "Descrição"][index]);
          if (index === 5) {
            cell.textContent = "";
            cell.append(renderTicketOsLinkEditors(record, links, canSave, status));
          } else if (index === 2) {
            cell.textContent = "";
            cell.append(renderTicketSummaryOrders(record));
          } else if (index === 6) {
            cell.textContent = "";
            cell.append(renderTicketSummaryDescriptions(record));
          }
          row.append(cell);
        });
        body.append(row);

        const card = el("article", "ticket-summary-card");
        const cardHead = el("div", "ticket-summary-card-head");
        cardHead.append(el("span", "ticket-summary-source", ticketSummarySourceLabel(record.fontes)),
          el("span", "ticket-summary-order-count", record.ordens.length + " OS"));
        card.append(cardHead);
        card.append(renderTicketSummaryOrders(record));
        const identifiers = el("dl", "ticket-summary-identifiers");
        [["Série", record.serie], ["Usuário", userFailure ? "Indisponível" : ticketUserLabel(user)],
          ["Hostname", userFailure ? "Indisponível" : ticketHostnameLabel(user)]].forEach(([label, value]) => {
          identifiers.append(el("dt", "", label), el("dd", "", value));
        });
        card.append(identifiers);
        const link = el("div", "ticket-summary-card-link");
        link.append(el("span", "ticket-summary-field-label", "Chamado"),
          renderTicketOsLinkEditors(record, links, canSave, status));
        card.append(link);
        const description = renderTicketSummaryDescriptions(record);
        description.setAttribute("data-label", "Descrição do chamado");
        card.append(description);
        mobileCards.append(card);
      });
      table.append(body);
      tableWrap.append(table);
      content.append(tableWrap, mobileCards);
      section.querySelector(".ticket-summary-content")?.remove();
      section.append(content);
      section.setAttribute("aria-busy", "false");
    }

    async function refreshTicketSummary(force) {
      const summaryTab = doc.getElementById("tab-resumo");
      if (!force && summaryTab?.getAttribute("aria-selected") !== "true") return;
      const section = ensureTicketSummary();
      if (!section) return;
      const status = section.querySelector(".ticket-summary-status");
      const serial = ++ticketSummaryRequestSerial;
      section.setAttribute("aria-busy", "true");
      status.textContent = "Carregando OS…";
      try {
        const [report, linksData] = await Promise.all([
          osSummaryRequest("/api/operacoes/chamados"),
          osSummaryRequest("/api/operacoes/chamados/vinculos-os"),
        ]);
        const records = groupTicketOsRows(collectTicketOsRows(report));
        let users = {};
        let userFailure = false;
        if (records.length) {
          try {
            const userData = await osSummaryRequest("/api/equipamentos/usuarios-logados", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ series: [...new Set(records.map(item => item.serie))] }),
            });
            users = userData.usuarios || {};
          } catch (_) {
            userFailure = true;
          }
        }
        if (serial !== ticketSummaryRequestSerial || !section.isConnected) return;
        const linkItems = Array.isArray(linksData.vinculos) ? linksData.vinculos : [];
        const links = new Map(linkItems.map(item => [ticketOsLinkKey({ fonte: item.fonte, serie: item.serie, os: item.os }), item]));
        renderTicketSummary(section, records, users, links, true, userFailure);
      } catch (error) {
        if (serial !== ticketSummaryRequestSerial || !section.isConnected) return;
        section.querySelector(".ticket-summary-content")?.remove();
        section.setAttribute("aria-busy", "false");
        status.textContent = error.message === "Failed to fetch"
          ? "Não foi possível carregar as OS. Tente novamente ao abrir a aba Resumo."
          : error.message || "Não foi possível carregar as OS.";
      }
    }

    // ----- sidebar divergence badge -----
    // The group summary carries only this alert count; the summary's aria-label replaces its content, so it repeats the count.
    const SUMMARY_LABEL = "Abrir históricos e análises";
    function renderBadge(total) {
      const summary = doc.querySelector('.header-action-group[data-action-group="analysis"] > summary');
      const anchor = summary?.querySelector(".header-action-group-chevron");
      if (!anchor) return;
      let badge = doc.getElementById("badge-divergencias-ux");
      if (!total) {
        badge?.remove();
        summary.setAttribute("aria-label", SUMMARY_LABEL);
        return;
      }
      if (!badge) {
        badge = el("span", "ux-divergence-badge");
        badge.id = "badge-divergencias-ux";
        anchor.insertAdjacentElement("beforebegin", badge);
      }
      const label = `${pluralize(total, "divergência", "divergências")} na última atualização`;
      badge.textContent = total > 99 ? "99+" : String(total);
      badge.setAttribute("aria-label", label);
      badge.title = label;
      summary.setAttribute("aria-label", `${SUMMARY_LABEL}, ${label}`);
    }

    // ----- header notification center -----
    const notificationButton = doc.getElementById("btn-notificacoes");
    const notificationBadge = doc.getElementById("badge-notificacoes");
    const notificationPanel = doc.getElementById("notification-center-panel");
    const notificationSummary = doc.getElementById("notification-center-summary");
    let hasNotificationData = false;

    function atualizarResumoNotificacoes(text) {
      if (notificationSummary && notificationSummary.textContent !== text) notificationSummary.textContent = text;
    }

    function renderizarNotificacoes(data) {
      const osParadas = data?.os_paradas;
      const divergenciasNovas = data?.divergencias_novas;
      const total = Number(osParadas?.estado === "paradas" && Number(osParadas.total) > 0)
        + Number(divergenciasNovas?.estado === "novas" && Number(divergenciasNovas.total) > 0);
      const label = total
        ? `Notificações, ${pluralize(total, "aviso ativo", "avisos ativos")}`
        : "Notificações, nenhum aviso ativo";

      if (notificationBadge) {
        notificationBadge.textContent = String(total);
        notificationBadge.hidden = total === 0;
      }
      if (notificationButton) {
        notificationButton.setAttribute("aria-label", label);
        notificationButton.title = label;
      }
      if (notificationPanel) {
        notificationPanel.dataset.state = "ready";
        notificationPanel.setAttribute("aria-busy", "false");
      }
      atualizarResumoNotificacoes(total ? `${pluralize(total, "aviso ativo", "avisos ativos")}.` : "Nenhum aviso ativo.");
      hasNotificationData = true;
    }

    function renderizarFalhaNotificacoes() {
      if (notificationPanel) {
        notificationPanel.dataset.state = "error";
        notificationPanel.setAttribute("aria-busy", "false");
      }
      if (!hasNotificationData) {
        if (notificationBadge) notificationBadge.hidden = true;
        notificationButton?.setAttribute("aria-label", "Notificações, atualização indisponível");
        if (notificationButton) notificationButton.title = "Notificações, atualização indisponível";
        atualizarResumoNotificacoes("Não foi possível atualizar os avisos. Tente novamente.");
        return;
      }
      atualizarResumoNotificacoes("Atualização indisponível; exibindo os últimos avisos recebidos.");
    }

    function fecharCentralNotificacoes() {
      if (!notificationPanel || !notificationButton) return;
      notificationPanel.hidden = true;
      notificationButton.setAttribute("aria-expanded", "false");
    }

    if (notificationButton && notificationPanel) {
      notificationButton.addEventListener("click", () => {
        const abrir = notificationPanel.hidden;
        notificationPanel.hidden = !abrir;
        notificationButton.setAttribute("aria-expanded", String(abrir));
        if (!abrir) return;
        notificationPanel.dataset.state = "loading";
        notificationPanel.setAttribute("aria-busy", "true");
        doc.dispatchEvent(new win.Event("simpress:atualizar-notificacoes"));
      });

      notificationPanel.addEventListener("click", event => {
        if (!event.target?.closest?.(".stale-base-alert-action")) return;
        fecharCentralNotificacoes();
        notificationButton.focus();
      });

      doc.addEventListener("click", event => {
        if (notificationPanel.hidden || notificationPanel.contains(event.target) || notificationButton.contains(event.target)) return;
        fecharCentralNotificacoes();
      });

      doc.addEventListener("keydown", event => {
        if (event.key !== "Escape" || notificationPanel.hidden) return;
        event.preventDefault();
        fecharCentralNotificacoes();
        notificationButton.focus();
      });
    }

    async function refresh(force) {
      if (!force && Date.now() - lastFetch < REFRESH_MIN_MS) return;
      lastFetch = Date.now();
      const serial = ++requestSerial;
      const ticketSerialAtStart = ticketSummaryRequestSerial;
      try {
        const response = await win.fetch(ENDPOINT, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json();
        if (serial !== requestSerial) return;
        renderPanel(data);
        // An OS load started after this request already reflects data at least as new; repeating it only doubles the wait.
        if (ticketSerialAtStart === ticketSummaryRequestSerial
          && doc.getElementById("tab-resumo")?.getAttribute("aria-selected") === "true") refreshTicketSummary(true);
        renderBadge(divergenceTotal(data.ultima_comparacao));
        renderizarNotificacoes(data);
        // Other Home cards (usage in the last 30 days) render from the same response.
        doc.dispatchEvent(new win.CustomEvent("simpress:painel-atualizado", { detail: data }));
      } catch (error) {
        // The dashboard is optional; never disturb the main flow.
        if (serial === requestSerial) {
          if (panel) panel.hidden = true;
          renderBadge(0);
          renderizarFalhaNotificacoes();
        }
        win.console?.warn?.("Painel indisponível:", error?.message || error);
      }
    }

    doc.addEventListener("simpress:atualizar-notificacoes", () => refresh(true));

    new win.MutationObserver(scanTables).observe(doc.body, { childList: true, subtree: true });
    scanTables();

    // A change of the history counter means an update/restore/delete happened: refresh both the panel and the badge.
    const counter = doc.getElementById("badge-total-historico-comparacoes");
    if (counter) new win.MutationObserver(() => refresh(true)).observe(counter, { childList: true, characterData: true, subtree: true });
    // The cards are in the Resumo tab; Home keeps refreshing too, for the sidebar divergence badge.
    const abasComDados = ["tab-home", "tab-resumo"].map(id => doc.getElementById(id)).filter(Boolean);
    const abaComDadosAtiva = () => abasComDados.some(tab => tab.getAttribute("aria-selected") === "true");
    const resumoAtivo = () => doc.getElementById("tab-resumo")?.getAttribute("aria-selected") === "true";
    // Se o painel ainda não foi preenchido (ex.: falha anterior), abrir a aba tenta de novo sem esperar o intervalo mínimo.
    const abasObserver = new win.MutationObserver(() => {
      if (abaComDadosAtiva()) refresh(!panel || panel.hidden);
      if (resumoAtivo()) refreshTicketSummary(true);
    });
    abasComDados.forEach(tab => abasObserver.observe(tab, { attributes: true, attributeFilter: ["aria-selected"] }));

    doc.addEventListener("simpress:chamados-atualizados", () => refreshTicketSummary(true));
    doc.addEventListener("simpress:usuarios-equipamento-atualizados", () => {
      if (resumoAtivo()) refreshTicketSummary(true);
    });

    ensurePanel();
    ensureTicketSummary();
    refresh(true);
  }

  return Object.freeze({
    ENDPOINT, DENSITY_KEY, sortKey, compareValues, nextDirection, sortedOrder, toTsv,
    divergenceTotal, barPercentages, formatNumber, pluralize, install,
  });
});
