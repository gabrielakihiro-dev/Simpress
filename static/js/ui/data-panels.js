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

    // ----- tabela de OS (montada em Chamados via montarTabelaOs) -----
    let lastFetch = 0;
    let requestSerial = 0;
    let ticketSummaryRequestSerial = 0;
    const textoOs = value => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

    // Estado por seção montada via montarTabelaOs; o filtro externo só esconde linhas já renderizadas.
    const osExternas = new Map();
    const osSerie = new WeakMap();
    let osExternaSeq = 0;
    const idLivre = (node, id) => { if (!doc.getElementById(id)) node.id = id; };

    // Triagem (grupo da série, de opcoes.grupoSerie): "ativos" aceita qualquer grupo; atencao = atrasados ou sem data.
    function correspondeTriagemOs(st, grupo) {
      if (st.atencao && grupo !== "atrasados" && grupo !== "sem_data") return false;
      if (!st.triagem) return true;
      return st.triagem === "ativos" ? Boolean(grupo) : grupo === st.triagem;
    }

    function filtrarSecaoOs(section) {
      const st = osExternas.get(section);
      if (!st) return;
      const termo = textoOs(st.busca.trim());
      const itens = [...section.querySelectorAll("tbody tr[data-serial]")];
      const series = new Set();
      let visiveis = 0;
      itens.forEach(item => {
        const ok = (!termo || textoOs(item.textContent).includes(termo))
          && (!st.relacao || st.relacao === "todos" || item.dataset.relacao === st.relacao)
          && correspondeTriagemOs(st, item.dataset.triagem || "");
        item.hidden = !ok;
        if (!ok) return;
        series.add(item.dataset.serial);
        visiveis += 1;
      });
      const total = itens.length;
      section.querySelectorAll("tbody tr[data-andamento]").forEach(row => { row.hidden = !series.has(row.dataset.andamento); });
      if (!st.renderizada) return;
      const status = section.querySelector(".ticket-summary-status");
      status.textContent = (visiveis === total ? visiveis : visiveis + " de " + total) + " OS · "
        + pluralize(series.size, "série", "séries") + (st.falhaUsuarios ? "; usuário e hostname indisponíveis." : "");
    }

    function filtrarTabelaOs(filtro = {}) {
      osExternas.forEach((st, section) => {
        if ("busca" in filtro) {
          st.busca = String(filtro.busca || "");
          const campo = section.querySelector(".ck-os__busca input");
          if (campo) campo.value = st.busca;
        }
        if ("relacao" in filtro) st.relacao = String(filtro.relacao || "");
        if ("triagem" in filtro) st.triagem = String(filtro.triagem || "");
        if ("atencao" in filtro) st.atencao = Boolean(filtro.atencao);
        filtrarSecaoOs(section);
      });
    }

    function montarTabelaOs(host, opcoes = {}) {
      if (!host) return null;
      osExternas.forEach((_, s) => { if (!s.isConnected) osExternas.delete(s); });
      const existente = [...osExternas.keys()].find(s => s.parentNode === host);
      if (existente) return existente;
      const section = el("section", "ck-cartao ck-os");
      const tituloId = "ck-os-titulo-" + (++osExternaSeq);
      section.setAttribute("aria-labelledby", tituloId);
      const title = el("h2", "ck-cartao__titulo", opcoes.titulo || "OS por equipamento");
      title.id = tituloId;
      const status = el("p", "ck-cartao__meta ticket-summary-status", "Carregando OS…");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      // opcoes.semBusca: o host já tem a própria busca (filtrarTabelaOs). aoExpandirSerie(serie, celula) preenche o "Andamento";
      // grupoSerie(chamado) devolve o grupo de triagem da série (data-triagem); aoCarregar(relatorio) recebe o GET /api/operacoes/chamados que a tabela já faz (evita segunda requisição).
      const st = {
        busca: "", relacao: "", triagem: "", atencao: false, grupoSerie: opcoes.grupoSerie, renderizada: false, falhaUsuarios: false, carregada: false,
        aoExpandirSerie: opcoes.aoExpandirSerie, aoCarregar: opcoes.aoCarregar, abertas: new Set(),
      };
      const head = el("div", "ck-cartao__cab");
      head.append(title, status);
      if (!opcoes.semBusca) {
        const busca = el("label", "ck-os__busca");
        busca.append(el("span", "ck-sr", "Buscar série, OS ou usuário"));
        const campo = el("input", "ck-entrada ck-entrada--sm");
        campo.type = "search";
        campo.placeholder = "Série, OS ou usuário";
        campo.addEventListener("input", () => { st.busca = campo.value; filtrarSecaoOs(section); });
        busca.append(campo);
        head.append(el("span", "ck-espaco"), busca);
        idLivre(campo, "ck-os-busca");
      }
      section.append(head);
      osExternas.set(section, st);
      host.append(section);
      idLivre(status, "ck-os-contagem");
      refreshTicketSummary(false);
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
      button.setAttribute("aria-label", "Abrir andamento em Chamados: " + ticketSummarySourceLabel(sources)
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

    let ticketDescriptionSeq = 0;
    // Uma linha por OS (fontes unidas): só a Oracle traz descrição.
    function renderTicketSummaryDescription(order, source) {
      const item = el("div", "ck-descricao ticket-summary-description-entry");
      const text = (source === "oracle" && order.descricao) || "Descrição não informada";
      item.append(el("p", "ck-descricao__texto ticket-summary-description", text));
      if (text.length > 90 || text.includes("\n")) {
        item.id = "resumo-os-descricao-" + (++ticketDescriptionSeq);
        const more = el("button", "ck-link-btn", "Ver mais");
        more.type = "button";
        more.setAttribute("data-expandir", item.id);
        more.setAttribute("aria-expanded", "false");
        item.append(more);
      }
      return item;
    }

    function renderTicketOsLinkEditor(record, saved, canSave, statusMessage) {
      const editor = el("div", "ticket-os-link-editor");
      if (!canSave) {
        editor.append(el("span", "ticket-os-link-value", saved?.chamado || "Não informado"));
        return editor;
      }
      const form = el("form", "ticket-os-link-form");
      const year = Number(saved?.ano) || new Date().getFullYear();
      const label = el("label", "ck-sr ticket-os-link-label", "Número do chamado UTIC");
      const controls = el("div", "ck-utic ticket-os-link-controls");
      const prefix = el("span", "ticket-os-link-prefix", `UTIC-${year}-`);
      const input = el("input", "ck-entrada ck-entrada--sm ticket-os-link-input");
      input.type = "text";
      input.inputMode = "numeric";
      input.pattern = "[0-9]*";
      input.maxLength = 24;
      input.autocomplete = "off";
      input.value = saved?.numero || "";
      input.placeholder = "0000";
      input.setAttribute("aria-label", "Número do chamado para OS " + record.os
        + ", série " + record.serie + ", fonte " + ticketSummarySourceLabel([record.fonte]));
      const save = el("button", "ck-btn ck-btn--secundario ck-btn--sm ticket-os-link-save", saved ? "Atualizar" : "Salvar");
      save.type = "submit";
      controls.append(prefix, input, save);
      if (saved) {
        const remove = el("button", "ck-btn ck-btn--fantasma ck-btn--sm ticket-os-link-remove", "Remover vínculo");
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

    function renderTicketSummary(section, records, users, links, canSave, userFailure, relacoes = new Map(), grupos = new Map()) {
      const status = section.querySelector(".ticket-summary-status");
      const content = el("div", "ck-os__corpo ticket-summary-content");
      const externa = osExternas.get(section);
      if (externa) { externa.renderizada = records.length > 0; externa.falhaUsuarios = Boolean(userFailure); }
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
      const table = el("table", "ck-tabela ck-tabela--cards ticket-summary-table");
      const cols = el("colgroup");
      ["fonte", "serie", "os", "usuario", "host", "chamado", ""].forEach(name => cols.append(el("col", name ? "ck-col-" + name : "")));
      table.append(cols);
      table.append(el("caption", "ck-sr", "Ordens de serviço associadas a equipamentos"));
      const header = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      ["Fonte", "Série", "OS", "Usuário", "Hostname", "Chamado", "Descrição"].forEach(title => {
        const cell = el("th", "", title);
        cell.scope = "col";
        headRow.append(cell);
      });
      header.append(headRow);
      table.append(header);
      const body = doc.createElement("tbody");
      records.forEach(record => {
        const user = users[record.serie];
        const userText = userFailure ? "Indisponível" : ticketUserLabel(user);
        const hostText = userFailure ? "Indisponível" : ticketHostnameLabel(user);
        record.ordens.forEach((order, orderIndex) => {
          const row = doc.createElement("tr");
          row.dataset.serial = record.serie;
          row.dataset.osCount = "1";
          row.dataset.os = String(order.os);
          row.dataset.relacao = relacoes.get(serialKey(record.serie)) || "";
          row.dataset.triagem = grupos.get(serialKey(record.serie)) || "";
          const cell = (label, className) => {
            const td = el("td", className || "");
            td.setAttribute("data-label", label);
            row.append(td);
            return td;
          };
          // OS presente nas duas fontes: uma linha, com um selo e um editor de chamado por fonte (a chave do vínculo inclui a fonte).
          const sourceCell = cell("Fonte", "ck-os-fontes");
          const serieCell = cell("Série", "ck-mono");
          serieCell.textContent = record.serie;
          // Um botão por série (na primeira OS) abre a linha extra com o andamento.
          if (externa?.aoExpandirSerie && orderIndex === 0) serieCell.append(renderAndamentoToggle(externa, record.serie));
          const osCell = cell("OS", "ck-mono");
          const osButton = renderTicketSummaryOrderButton({ serie: record.serie, os: order.os, fontes: order.fontes });
          osButton.className = "ck-link-btn ck-mono ticket-summary-order-link";
          osCell.append(osButton);
          cell("Usuário").textContent = userText;
          cell("Hostname", "ck-mono").textContent = hostText;
          const linkCell = cell("Chamado", "ck-td--largo ck-os-fontes");
          // Um único editor UTIC por linha: a fonte que já tem vínculo salvo, senão a primeira.
          const linkSource = order.fontes.find(source =>
            links.get(ticketOsLinkKey({ fonte: source, serie: record.serie, os: order.os }))) || order.fontes[0];
          order.fontes.forEach(source => {
            const tagSlot = el("div", "ck-os-fonte");
            tagSlot.append(el("span", "ck-tag", ticketSummarySourceLabel([source])));
            sourceCell.append(tagSlot);
            const sourceRecord = { fonte: source, serie: record.serie, os: order.os };
            if (source !== linkSource) return;
            const slot = el("div", "ck-os-fonte");
            slot.append(renderTicketOsLinkEditor(sourceRecord,
              links.get(ticketOsLinkKey(sourceRecord)), canSave, status));
            linkCell.append(slot);
          });
          const descCell = cell("Descrição", "ck-td--largo");
          descCell.append(renderTicketSummaryDescription(order, order.fontes.includes("oracle") ? "oracle" : "simpress"));
          body.append(row);
        });
      });
      table.append(body);
      content.append(table);
      section.querySelector(".ticket-summary-content")?.remove();
      section.append(content);
      section.setAttribute("aria-busy", "false");
      idLivre(table, "ck-os-tabela");
      // Salvar um vínculo recria a tabela: reabre as linhas de andamento que estavam abertas.
      externa?.abertas.forEach(serie => {
        const toggle = [...table.querySelectorAll(".ck-os__andamento-btn")].find(btn => btn.dataset.serie === serie);
        if (toggle) alternarAndamento(toggle, externa, serie, true);
        else externa.abertas.delete(serie);
      });
      filtrarSecaoOs(section);
    }

    let andamentoSeq = 0;
    function renderAndamentoToggle(st, serie) {
      const button = el("button", "ck-link-btn ck-os__andamento-btn", "Andamento");
      button.type = "button";
      button.dataset.serie = serie;
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", "Andamento registrado da série " + serie);
      button.addEventListener("click", () => alternarAndamento(button, st, serie));
      return button;
    }

    function alternarAndamento(button, st, serie, abrir = button.getAttribute("aria-expanded") !== "true") {
      doc.getElementById(button.getAttribute("aria-controls") || "")?.remove();
      button.removeAttribute("aria-controls");
      button.setAttribute("aria-expanded", String(abrir));
      if (!abrir) { st.abertas.delete(serie); return; }
      st.abertas.add(serie);
      const body = button.closest("tbody");
      const rows = [...body.querySelectorAll("tr[data-serial]")].filter(item => item.dataset.serial === serie);
      const detail = doc.createElement("tr");
      detail.id = "ck-os-andamento-" + (++andamentoSeq);
      detail.dataset.andamento = serie;
      const cell = el("td", "ck-td--largo ck-td--sem-rotulo");
      cell.colSpan = 7;
      cell.setAttribute("role", "region");
      cell.setAttribute("aria-label", "Andamento registrado da série " + serie);
      detail.append(cell);
      rows[rows.length - 1].after(detail);
      button.setAttribute("aria-controls", detail.id);
      st.aoExpandirSerie(serie, cell);
    }

    async function refreshTicketSummary(force) {
      const alvos = [];
      osExternas.forEach((st, s) => {
        if (!s.isConnected) osExternas.delete(s);
        else if (force || !st.carregada) alvos.push(s);
      });
      if (!alvos.length) return;
      const serial = ++ticketSummaryRequestSerial;
      // Cada seção só aceita o resultado da última carga que a incluiu.
      const vivos = () => alvos.filter(s => s.isConnected && osSerie.get(s) === serial);
      alvos.forEach(section => {
        osSerie.set(section, serial);
        section.setAttribute("aria-busy", "true");
        section.querySelector(".ticket-summary-status").textContent = "Carregando OS…";
      });
      try {
        const [report, linksData] = await Promise.all([
          osSummaryRequest("/api/operacoes/chamados"),
          osSummaryRequest("/api/operacoes/chamados/vinculos-os"),
        ]);
        const records = groupTicketOsRows(collectTicketOsRows(report));
        const relacoes = new Map((Array.isArray(report?.chamados) ? report.chamados : [])
          .map(ticket => [serialKey(ticket?.serie), String(ticket?.relacao || "")]));
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
        const linkItems = Array.isArray(linksData.vinculos) ? linksData.vinculos : [];
        const links = new Map(linkItems.map(item => [ticketOsLinkKey({ fonte: item.fonte, serie: item.serie, os: item.os }), item]));
        vivos().forEach(section => {
          const st = osExternas.get(section);
          if (st) st.carregada = true;
          st?.aoCarregar?.(report);
          const grupos = new Map(st?.grupoSerie ? (Array.isArray(report?.chamados) ? report.chamados : [])
            .map(ticket => [serialKey(ticket?.serie), st.grupoSerie(ticket) || ""]) : []);
          renderTicketSummary(section, records, users, links, true, userFailure, relacoes, grupos);
        });
      } catch (error) {
        vivos().forEach(section => {
          section.querySelector(".ticket-summary-content")?.remove();
          section.setAttribute("aria-busy", "false");
          const st = osExternas.get(section);
          if (st) st.renderizada = false;
          section.querySelector(".ticket-summary-status").textContent = error.message === "Failed to fetch"
            ? "Não foi possível carregar as OS. Tente novamente."
            : error.message || "Não foi possível carregar as OS.";
        });
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
    const notificationTitle = doc.getElementById("notification-center-title");
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
      if (notificationTitle) notificationTitle.textContent = `Pendências · ${total}`;
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
        if (!event.target?.closest?.(".ck-aviso__acao, .stale-base-alert-action")) return;
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
      try {
        const response = await win.fetch(ENDPOINT, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json();
        if (serial !== requestSerial) return;
        renderBadge(divergenceTotal(data.ultima_comparacao));
        renderizarNotificacoes(data);
        // Other Home cards (usage in the last 30 days) render from the same response.
        doc.dispatchEvent(new win.CustomEvent("simpress:painel-atualizado", { detail: data }));
      } catch (error) {
        // The dashboard is optional; never disturb the main flow.
        if (serial === requestSerial) {
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
    const counter = doc.getElementById("total-historico-comparacoes");
    if (counter) new win.MutationObserver(() => refresh(true)).observe(counter, { childList: true, characterData: true, subtree: true });
    // The cards are in the Resumo tab; Home keeps refreshing too, for the sidebar divergence badge.
    const abasComDados = ["tab-home", "tab-resumo", "tab-retirada-entrega"].map(id => doc.getElementById(id)).filter(Boolean);
    const abaComDadosAtiva = () => abasComDados.some(tab => tab.getAttribute("aria-selected") === "true");
    // Se o painel ainda não foi preenchido (ex.: falha anterior), abrir a aba tenta de novo sem esperar o intervalo mínimo.
    const abasObserver = new win.MutationObserver(() => {
      if (abaComDadosAtiva()) refresh(false);
    });
    abasComDados.forEach(tab => abasObserver.observe(tab, { attributes: true, attributeFilter: ["aria-selected"] }));

    doc.addEventListener("simpress:chamados-atualizados", () => refreshTicketSummary(true));
    doc.addEventListener("simpress:usuarios-equipamento-atualizados", () => refreshTicketSummary(true));

    osApi = { montar: montarTabelaOs, atualizar: refreshTicketSummary, filtrar: filtrarTabelaOs };
    refresh(true);
  }

  // Ponte para a instalação ativa: permite window.SimpressDataPanels.montarTabelaOs(...) após o install.
  let osApi = { montar: () => null, atualizar: async () => {}, filtrar: () => {} };
  const montarTabelaOs = (host, opcoes) => osApi.montar(host, opcoes);
  const atualizarTabelaOs = force => osApi.atualizar(Boolean(force));
  const filtrarTabelaOs = filtro => osApi.filtrar(filtro);

  return Object.freeze({
    ENDPOINT, DENSITY_KEY, sortKey, compareValues, nextDirection, sortedOrder, toTsv,
    divergenceTotal, barPercentages, formatNumber, pluralize, install,
    montarTabelaOs, atualizarTabelaOs, filtrarTabelaOs,
  });
});
