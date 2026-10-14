(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.SimpressTransferHistory = api;
    if (root.document) api.install(root);
  }
})(typeof window !== "undefined" ? window : globalThis, function createTransferHistory() {
  "use strict";

  const ENDPOINT = "/api/historico-transferencias";
  const MODAL_ID = "modal-historico-transferencias";
  const LIST_LIMIT = 50;
  const SEARCH_DELAY_MS = 250;
  // Delivery fields restored by "Duplicar destino"; the equipment (serial) always comes from a new search.
  const DUPLICATE_FIELDS = Object.freeze([
    ["entrega-contato", "entrega_contato"],
    ["entrega-email", "entrega_email"],
    ["entrega-telefone", "entrega_telefone"],
    ["entrega-horario", "entrega_horario"],
    ["entrega-almoco", "entrega_almoco"],
    ["entrega-pausa-duracao", "entrega_pausa_duracao"],
    ["entrega-obs", "entrega_obs"],
  ]);

  function formatDateTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso || "—");
    return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function routeLabel(item) {
    return `${item.retirada_cidade || "Origem não informada"} → ${item.entrega_cidade || "Destino não informado"}`;
  }

  // Unit labels end with "(CNPJ)"; a street match breaks ties between units that share a CNPJ.
  function findUnitOption(options, payload) {
    const cnpj = String(payload?.entrega_cnpj || "").trim();
    if (!cnpj) return null;
    const candidates = options.filter(option => option.value && String(option.text).includes(`(${cnpj})`));
    if (candidates.length <= 1) return candidates[0] || null;
    const street = String(payload.entrega_endereco || "").split(" - ")[0].trim().toLowerCase();
    return candidates.find(option => street && String(option.text).toLowerCase().includes(street)) || candidates[0];
  }

  function duplicateValues(payload) {
    return DUPLICATE_FIELDS.map(([fieldId, key]) => [fieldId, String(payload?.[key] ?? "")]);
  }

  function describeFailure(status) {
    if (status === 501) return "O histórico de transferências não está disponível neste modo de armazenamento.";
    if (status === 503) return "O arquivo local do histórico está ilegível; os dados foram preservados. Verifique data/state/historico_transferencias.json.";
    return "Não foi possível carregar o histórico de transferências.";
  }

  function install(win) {
    const doc = win.document;
    if (!doc || win.SimpressTransferHistoryInstalled) return;
    win.SimpressTransferHistoryInstalled = true;
    const byId = id => doc.getElementById(id);
    let searchTimer = 0;
    let requestSerial = 0;

    function el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function notify(message, type = "success") {
      if (typeof win.showToast === "function") win.showToast(message, type);
    }

    function setStatus(text) {
      const status = byId("historico-transferencias-status");
      if (status) status.textContent = text;
    }

    function showMessage(text, role) {
      const list = byId("lista-historico-transferencias");
      const message = el("p", "text-sm text-center py-8 " + (role === "alert" ? "text-rose-300" : "text-slate-400"), text);
      message.setAttribute("role", role);
      list.replaceChildren(message);
    }

    async function copySerial(item) {
      try {
        await win.copiarTextoParaAreaTransferencia(item.serial);
        notify(`Série ${item.serial} copiada para a área de transferência.`);
      } catch (error) {
        notify("Não foi possível copiar a série.", "error");
      }
    }

    function duplicateDestination(item) {
      const payload = item.payload || {};
      win.fecharModalHistoricoTransferencias();
      if (typeof win.ativarAbaTransferencia === "function") win.ativarAbaTransferencia("transferencia");
      const select = byId("select-unidade-destino");
      const option = select && findUnitOption(
        Array.from(select.options).map(entry => ({ value: entry.value, text: entry.textContent })), payload);
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new win.Event("change", { bubbles: true }));
      }
      // Representative auto-fill runs on change; restore the saved contact data afterwards.
      win.setTimeout(() => {
        duplicateValues(payload).forEach(([fieldId, value]) => {
          const field = byId(fieldId);
          if (!field) return;
          field.value = value;
          field.dispatchEvent(new win.Event("input", { bubbles: true }));
        });
        notify(option
          ? "Destino e contato duplicados. Pesquise o equipamento na aba Home."
          : "Contato duplicado, mas o destino não está mais no catálogo. Selecione a unidade.", option ? "info" : "warning");
        byId("entrega-contato")?.focus();
      }, 0);
    }

    function actionButton(label, onClick, extra = {}) {
      const button = el("button", "ticket-template-view", label);
      button.type = "button";
      if (extra.copy) button.dataset.copyField = "serie";
      button.addEventListener("click", onClick);
      return button;
    }

    function renderRows(items) {
      const list = byId("lista-historico-transferencias");
      const columns = ["Data e hora", "Série", "Origem → Destino", "Destinatário", "Observações", "Ações"];
      const wrap = el("div", "accessible-table-wrap comparison-desktop-table rounded-lg border border-slate-800");
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", "Tabela de transferências geradas");
      wrap.tabIndex = 0;
      const table = el("table", "min-w-full text-left text-sm");
      table.setAttribute("aria-label", "Transferências geradas");
      const head = el("thead", "bg-slate-950 text-slate-300");
      const headRow = el("tr");
      columns.forEach(name => {
        const th = el("th", "px-3 py-2.5 font-semibold whitespace-nowrap", name);
        th.scope = "col";
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      const body = el("tbody", "divide-y divide-slate-800");
      const cards = el("div", "comparison-mobile-list");
      cards.setAttribute("role", "list");
      cards.setAttribute("aria-label", "Transferências geradas em cartões");

      items.forEach(item => {
        const cells = [
          formatDateTime(item.criado_em), item.serial, routeLabel(item),
          item.entrega_contato || "—", item.entrega_obs || "—",
        ];
        const row = el("tr");
        cells.forEach((text, index) => row.appendChild(el("td", index === 1 ? "px-3 py-2 font-mono whitespace-nowrap" : "px-3 py-2", text)));
        const actions = el("td", "px-3 py-2");
        const group = el("div", "flex flex-wrap gap-2");
        group.append(
          actionButton("Copiar série", () => copySerial(item), { copy: true }),
          actionButton("Duplicar destino", () => duplicateDestination(item)),
        );
        actions.appendChild(group);
        row.appendChild(actions);
        body.appendChild(row);

        const card = el("article", "comparison-mobile-card");
        card.setAttribute("role", "listitem");
        card.appendChild(el("h5", "comparison-mobile-card-title", `${item.serial} · ${formatDateTime(item.criado_em)}`));
        const fields = el("dl", "comparison-mobile-card-fields");
        [["Origem → Destino", cells[2]], ["Destinatário", cells[3]], ["Observações", cells[4]]].forEach(([label, value]) => {
          const field = el("div", "comparison-mobile-card-field");
          field.append(el("dt", "", label), el("dd", "", value));
          fields.appendChild(field);
        });
        card.appendChild(fields);
        const cardActions = el("div", "flex flex-wrap gap-2 mt-3");
        cardActions.append(
          actionButton("Copiar série", () => copySerial(item), { copy: true }),
          actionButton("Duplicar destino", () => duplicateDestination(item)),
        );
        card.appendChild(cardActions);
        cards.appendChild(card);
      });
      table.append(head, body);
      wrap.appendChild(table);
      list.replaceChildren(wrap, cards);
    }

    async function load() {
      const ticket = ++requestSerial;
      const term = String(byId("filtro-historico-transferencias")?.value || "").trim();
      const loading = el("p", "text-sm text-center py-8 text-slate-400", "Carregando histórico…");
      loading.setAttribute("role", "status");
      byId("lista-historico-transferencias").replaceChildren(loading);
      setStatus("Carregando histórico…");
      try {
        const response = await win.fetch(`${ENDPOINT}?limite=${LIST_LIMIT}&busca=${encodeURIComponent(term)}`);
        if (ticket !== requestSerial) return;
        if (!response.ok) {
          setStatus("");
          showMessage(describeFailure(response.status), "alert");
          return;
        }
        const data = await response.json();
        if (ticket !== requestSerial) return;
        const items = Array.isArray(data.itens) ? data.itens : [];
        if (!items.length) {
          setStatus(term ? "Nenhum resultado." : "Nenhuma transferência registrada.");
          showMessage(term ? "Nenhuma transferência corresponde à busca." : "Nenhuma planilha de transferência foi gerada ainda.", "status");
          return;
        }
        setStatus(data.total > items.length
          ? `Mostrando as ${items.length} mais recentes de ${data.total}.`
          : `${items.length} ${items.length === 1 ? "transferência" : "transferências"}.`);
        renderRows(items);
        win.lucide?.createIcons?.({ root: byId("lista-historico-transferencias") });
      } catch (error) {
        if (ticket !== requestSerial) return;
        setStatus("");
        showMessage(describeFailure(0), "alert");
      }
    }

    win.abrirModalHistoricoTransferencias = function abrirModalHistoricoTransferencias() {
      const filter = byId("filtro-historico-transferencias");
      if (filter) filter.value = "";
      win.abrirModalAcessivel(MODAL_ID, "#filtro-historico-transferencias", "fecharModalHistoricoTransferencias");
      load();
    };
    win.fecharModalHistoricoTransferencias = function fecharModalHistoricoTransferencias() {
      win.clearTimeout(searchTimer);
      requestSerial += 1;
      win.fecharModalAcessivel(MODAL_ID);
    };

    byId("filtro-historico-transferencias")?.addEventListener("input", () => {
      win.clearTimeout(searchTimer);
      searchTimer = win.setTimeout(load, SEARCH_DELAY_MS);
    });

    // Append after each generated sheet; the history is optional, so failures never reach the user's flow.
    doc.addEventListener("simpress:transfer-generated", event => {
      const payload = event.detail?.payload;
      if (!payload) return;
      win.fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(response => {
        if (!response.ok && response.status !== 501) win.console?.warn?.("Histórico de transferências não registrado:", response.status);
      }).catch(error => win.console?.warn?.("Histórico de transferências não registrado:", error));
    });
  }

  return Object.freeze({ ENDPOINT, DUPLICATE_FIELDS, formatDateTime, routeLabel, findUnitOption, duplicateValues, describeFailure, install });
});
