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

    function ensurePanel() {
      if (panel) return panel;
      const anchor = doc.querySelector("#tab-panel-home .home-search-card");
      if (!anchor) return null;
      panel = el("section", "ux-home-panel glass-card");
      panel.id = "ux-home-panel";
      panel.setAttribute("aria-labelledby", "ux-home-panel-title");
      panel.hidden = true;
      anchor.insertAdjacentElement("afterend", panel);
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
      host.append(title);
      if (!data.base_importada) {
        host.append(el("p", "ux-home-empty", "Nenhuma base importada ainda. Use “Atualizar planilhas” para carregar os equipamentos."));
        host.hidden = false;
        return;
      }
      const stats = el("div", "ux-stat-grid");
      stats.setAttribute("role", "list");
      stats.append(stat("Equipamentos", data.total_equipamentos), stat("Unidades", data.total_unidades), stat("Cidades", data.total_cidades));
      (data.por_categoria || []).forEach(category => stats.append(stat(category.label, category.total)));
      stats.querySelectorAll(".ux-stat").forEach(item => item.setAttribute("role", "listitem"));
      host.append(stats);

      const columns = el("div", "ux-home-columns");
      const cities = data.cidades_principais || [];
      if (cities.length) {
        const block = el("div", "ux-home-block");
        block.append(el("h3", "ux-home-subtitle", "Cidades com mais equipamentos"));
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
        block.append(list);
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
          row.append(el("span", "", item.rotulo), el("strong", "", formatNumber(item.total)));
          list.append(row);
        });
        status.append(list);
      } else if (data.ultima_comparacao) {
        status.append(el("p", "ux-home-note ux-home-note--ok", "Nenhum ponto de atenção na última comparação."));
      }
      columns.append(status);
      host.append(columns);
      host.hidden = false;
    }

    // ----- sidebar divergence badge -----
    function renderBadge(total) {
      const anchor = doc.getElementById("badge-total-historico-comparacoes");
      if (!anchor) return;
      let badge = doc.getElementById("badge-divergencias-ux");
      if (!total) { badge?.remove(); return; }
      if (!badge) {
        badge = el("span", "ux-divergence-badge");
        badge.id = "badge-divergencias-ux";
        anchor.insertAdjacentElement("afterend", badge);
      }
      badge.textContent = total > 99 ? "99+" : String(total);
      badge.setAttribute("aria-label", `${pluralize(total, "divergência", "divergências")} na última atualização`);
      badge.title = badge.getAttribute("aria-label");
    }

    async function refresh(force) {
      if (!force && Date.now() - lastFetch < REFRESH_MIN_MS) return;
      lastFetch = Date.now();
      const serial = ++requestSerial;
      try {
        const response = await win.fetch(ENDPOINT, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json();
        if (serial !== requestSerial) return;
        renderPanel(data);
        renderBadge(divergenceTotal(data.ultima_comparacao));
      } catch (error) {
        // The dashboard is optional; never disturb the main flow.
        if (serial === requestSerial) { if (panel) panel.hidden = true; renderBadge(0); }
        win.console?.warn?.("Painel indisponível:", error?.message || error);
      }
    }

    function homeIsActive() {
      return doc.getElementById("tab-home")?.getAttribute("aria-selected") === "true";
    }

    new win.MutationObserver(scanTables).observe(doc.body, { childList: true, subtree: true });
    scanTables();

    // A change of the history counter means an update/restore/delete happened: refresh both the panel and the badge.
    const counter = doc.getElementById("badge-total-historico-comparacoes");
    if (counter) new win.MutationObserver(() => refresh(true)).observe(counter, { childList: true, characterData: true, subtree: true });
    const homeTab = doc.getElementById("tab-home");
    if (homeTab) new win.MutationObserver(() => { if (homeIsActive()) refresh(false); }).observe(homeTab, { attributes: true, attributeFilter: ["aria-selected"] });

    ensurePanel();
    refresh(true);
  }

  return Object.freeze({
    ENDPOINT, DENSITY_KEY, sortKey, compareValues, nextDirection, sortedOrder, toTsv,
    divergenceTotal, barPercentages, formatNumber, pluralize, install,
  });
});
