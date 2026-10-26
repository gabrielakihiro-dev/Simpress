(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.SimpressUxEnhancements = api;
    if (root.document) api.install(root);
  }
})(typeof window !== "undefined" ? window : globalThis, function createUxEnhancements() {
  "use strict";

  // Mirrors validarCamposObrigatoriosPlanilha() in app.js, which stays the gate for generating the sheet.
  const REQUIRED_FIELDS = Object.freeze([
    { id: "retirada-contato", label: "Nome do contato na retirada" },
    { id: "retirada-email", label: "E-mail do contato na retirada" },
    { id: "retirada-telefone", label: "Celular da retirada" },
    { id: "retirada-obs", label: "Observações da retirada" },
    { id: "entrega-email", label: "E-mail do destinatário" },
    { id: "entrega-telefone", label: "Celular do destinatário" },
    { id: "entrega-horario", label: "Expediente da entrega" },
    { id: "entrega-almoco", label: "Almoço da entrega" },
    { id: "entrega-pausa-duracao", label: "Duração da pausa da entrega", conditional: true },
    { id: "entrega-obs", label: "Observações da entrega" },
  ].map(Object.freeze));
  const REQUIRED_IDS = new Set(REQUIRED_FIELDS.map(field => field.id));
  const MESSAGES = Object.freeze({
    required: "Campo obrigatório.",
    email: "E-mail em formato inválido.",
    phone: "Celular inválido: informe DDD e número.",
  });
  const RECENT_UNITS_KEY = "simpress:recent-units";
  const RECENT_OBS_KEY = "simpress:recent-obs";
  const RECENT_LIMIT = 5;
  const COPY_SELECTOR = '[data-on-click^="copiar"], [data-copy-field], .ticket-template-copy';
  const COPY_STATES = Object.freeze({ success: "copied", warning: "warning", error: "error" });
  const COPY_MATCH_WINDOW_MS = 2500;
  const COPY_FEEDBACK_MS = 1800;
  const COPIED_LABEL = "Copiado!";
  const CHECK_ICON = '<svg class="ux-copy-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>';

  // Mirrors TransferenciaPayload.validate_phone (routers/transfers.py): DDD + 8/9 digits, optional +55 and ramal.
  function phoneProblem(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const main = text.replace(/\s*(?:ramal|ram\.?|ext\.?|x)\s*[:.]?\s*\d+\s*$/i, "");
    let digits = main.replace(/\D/g, "");
    if (main.trimStart().startsWith("+") && digits.startsWith("55")) digits = digits.slice(2);
    else if (digits.startsWith("0055") && (digits.length === 14 || digits.length === 15)) digits = digits.slice(4);
    else if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2);
    return digits.length === 10 || digits.length === 11 ? null : "phone";
  }

  // Masks plain Brazilian numbers while typing; anything with +, letters or a ramal is left untouched.
  function formatPhone(value) {
    const text = String(value ?? "");
    if (/[^\d\s()-]/.test(text)) return text;
    const digits = text.replace(/\D/g, "").slice(0, 11);
    if (!digits) return "";
    if (digits.length <= 2) return `(${digits}`;
    const area = digits.slice(0, 2);
    const rest = digits.slice(2);
    if (rest.length <= 4) return `(${area}) ${rest}`;
    const split = digits.length === 11 ? 5 : 4;
    return `(${area}) ${rest.slice(0, split)}-${rest.slice(split)}`;
  }

  function fieldProblem(field) {
    if (!field) return null;
    if (!String(field.value ?? "").trim()) return "required";
    if (field.type === "email" && typeof field.checkValidity === "function" && !field.checkValidity()) return "email";
    if (/-telefone$/.test(String(field.id || "")) && phoneProblem(field.value)) return "phone";
    return null;
  }

  // Keyboard shortcuts: "/" or Ctrl/Cmd+K focus the search, Ctrl/Cmd+Enter generates the sheet.
  function shortcutAction(event, { typing = false, modalOpen = false, transferVisible = false } = {}) {
    if (modalOpen || event.defaultPrevented || event.isComposing || event.altKey) return null;
    const key = String(event.key || "");
    const command = event.ctrlKey || event.metaKey;
    if (command && !event.shiftKey && key.toLowerCase() === "k") return "search";
    if (key === "/" && !command && !typing) return "search";
    if (command && key === "Enter" && transferVisible) return "generate";
    if (command || event.shiftKey || typing) return null;
    return ({
      F1: "tab-home",
      F2: "tab-transferencia",
      F3: "tab-resumo",
      F4: "tab-automacao",
      F5: "tool-chamados",
      F6: "tool-comparacao",
      F7: "tool-apelidos",
      F8: "tool-relatorio",
    })[key] || ({ t: "equipment-transport", e: "equipment-edit", c: "copy-ticket" })[key.toLowerCase()] || null;
  }

  function shouldCloseCockpitToolsMenu(menu, target) {
    if (!menu?.open) return false;
    return !menu.contains(target) || Boolean(target?.closest?.(".ck-menu__item"));
  }

  function pushRecent(list, value, limit = RECENT_LIMIT) {
    const text = String(value ?? "").trim();
    if (!text) return Array.isArray(list) ? list.slice(0, limit) : [];
    const rest = (Array.isArray(list) ? list : []).filter(item => String(item) !== text);
    return [text, ...rest].slice(0, limit);
  }

  // The lunch-break duration is only required while app.js keeps it `required`.
  function isFieldActive(definition, field) {
    return Boolean(field) && (!definition.conditional || field.required !== false);
  }

  function listPendingFields(getElementById) {
    return REQUIRED_FIELDS.flatMap(definition => {
      const field = getElementById(definition.id);
      if (!isFieldActive(definition, field)) return [];
      const problem = fieldProblem(field);
      return problem ? [{ id: definition.id, label: definition.label, field, problem }] : [];
    });
  }

  function describePending(count) {
    if (count <= 0) return "Campos obrigatórios completos";
    return count === 1 ? "1 campo pendente" : `${count} campos pendentes`;
  }

  // Bottom-bar status shown while no equipment message replaces it: it must agree with the pending chip.
  function describeReadiness(count) {
    if (count <= 0) return "Pronto para emissão.";
    return count === 1 ? "Falta 1 campo obrigatório." : `Faltam ${count} campos obrigatórios.`;
  }

  // Visible chip text: the count badge already shows the number, so "4" + "pendentes" reads "4 pendentes".
  function shortPendingLabel(count) {
    if (count <= 0) return "Campos completos";
    return count === 1 ? "pendente" : "pendentes";
  }

  function isCopyTrigger(element) {
    if (!element || typeof element.getAttribute !== "function") return false;
    if (String(element.tagName || "").toUpperCase() !== "BUTTON") return false;
    const action = element.getAttribute("data-on-click") || "";
    return /^copiar[A-Z]\w*$/.test(action)
      || element.hasAttribute?.("data-copy-field") === true
      || element.classList?.contains?.("ticket-template-copy") === true;
  }

  function copyStateFor(type) {
    return COPY_STATES[type] || null;
  }

  function overflowState(scrollLeft, clientWidth, scrollWidth) {
    const max = scrollWidth - clientWidth;
    if (!(max > 2)) return null;
    if (scrollLeft <= 2) return "end";
    if (scrollLeft >= max - 2) return "start";
    return "both";
  }

  function dismissInfoTips(doc) {
    const open = [...doc.querySelectorAll(".info-tip:hover, .info-tip:focus-within")];
    open.forEach(tip => tip.setAttribute("data-tip-dismissed", ""));
    return open.length;
  }

  function install(win) {
    const doc = win.document;
    const html = doc?.documentElement;
    if (!doc || !html || html.dataset.uxEnhanced === "true") return;
    html.dataset.uxEnhanced = "true";

    const byId = id => doc.getElementById(id);
    const copyTimers = new WeakMap();
    const observedTables = new WeakSet();
    const reducedMotion = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    const resizeObserver = typeof win.ResizeObserver === "function"
      ? new win.ResizeObserver(entries => entries.forEach(entry => updateOverflow(entry.target)))
      : null;
    let pendingCopy = null;
    const storage = (() => { try { return win.localStorage || null; } catch (error) { return null; } })();
    const readRecent = key => {
      try {
        const parsed = JSON.parse(storage?.getItem(key) || "[]");
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string") : [];
      } catch (error) { return []; }
    };
    const writeRecent = (key, list) => { try { storage?.setItem(key, JSON.stringify(list)); } catch (error) { /* optional */ } };
    // Destinos recentes foram removidos: apaga o histórico salvo neste navegador.
    try { storage?.removeItem(RECENT_UNITS_KEY); } catch (error) { /* optional */ }
    let refreshQueued = false;

    // ---------- Copy feedback on the clicked button ----------
    function visibleLabel(button) {
      if (button.id === "btn-copiar-serie") return byId("transfer-serial-status");
      const spans = Array.from(button.children).filter(child =>
        child.tagName === "SPAN" && child.getAttribute("aria-hidden") !== "true" && !child.classList.contains("sr-only"));
      return spans[spans.length - 1] || null;
    }

    function restoreCopyState(button) {
      const entry = copyTimers.get(button);
      if (!entry) return;
      copyTimers.delete(button);
      win.clearTimeout(entry.timer);
      entry.check?.remove();
      // app.js may have rewritten the label meanwhile (e.g. "Aguardando"); never clobber that.
      if (entry.label && entry.label.textContent === COPIED_LABEL) entry.label.textContent = entry.text;
      button.style.minWidth = entry.minWidth;
      delete button.dataset.copyState;
    }

    function showCopyState(button, state) {
      restoreCopyState(button);
      const entry = { minWidth: button.style.minWidth, label: null, text: "", check: null, timer: 0 };
      if (state === "copied") {
        const width = button.getBoundingClientRect?.().width;
        if (width) button.style.minWidth = `${Math.ceil(width)}px`;
        const label = visibleLabel(button);
        if (label) {
          entry.label = label;
          entry.text = label.textContent;
          label.textContent = COPIED_LABEL;
        }
        const template = doc.createElement("template");
        template.innerHTML = CHECK_ICON;
        entry.check = template.content.firstElementChild;
        button.insertBefore(entry.check, button.firstChild);
      }
      button.dataset.copyState = state;
      entry.timer = win.setTimeout(() => restoreCopyState(button), COPY_FEEDBACK_MS);
      copyTimers.set(button, entry);
    }

    doc.addEventListener("simpress:notify", event => {
      scheduleRefresh();
      if (!pendingCopy) return;
      const { trigger, at } = pendingCopy;
      pendingCopy = null;
      const state = copyStateFor(event.detail?.type);
      if (state && Date.now() - at <= COPY_MATCH_WINDOW_MS && trigger.isConnected) showCopyState(trigger, state);
    });

    // ---------- Inline validation ----------
    function errorIdFor(field) {
      return `${field.id}-ux-erro`;
    }

    function renderFieldState(field, problem) {
      const errorId = errorIdFor(field);
      let message = byId(errorId);
      const describedBy = new Set(String(field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
      if (problem) {
        if (!message) {
          message = doc.createElement("p");
          message.id = errorId;
          message.className = "ux-field-error";
          field.insertAdjacentElement("afterend", message);
        }
        message.textContent = MESSAGES[problem];
        message.hidden = false;
        field.setAttribute("aria-invalid", "true");
        field.dataset.uxInvalid = "true";
        describedBy.add(errorId);
      } else {
        if (field.dataset.uxInvalid === "true") field.removeAttribute("aria-invalid");
        delete field.dataset.uxInvalid;
        if (message) message.hidden = true;
        describedBy.delete(errorId);
      }
      if (describedBy.size) field.setAttribute("aria-describedby", Array.from(describedBy).join(" "));
      else field.removeAttribute("aria-describedby");
    }

    function validateTouchedFields() {
      REQUIRED_FIELDS.forEach(definition => {
        const field = byId(definition.id);
        if (!field) return;
        const problem = isFieldActive(definition, field) ? fieldProblem(field) : null;
        if (field.dataset.uxTouched === "true") renderFieldState(field, problem);
        else if (field.dataset.uxInvalid === "true") renderFieldState(field, null);
      });
    }

    function setTouched(touched) {
      REQUIRED_FIELDS.forEach(({ id }) => {
        const field = byId(id);
        if (!field) return;
        if (touched) field.dataset.uxTouched = "true";
        else {
          delete field.dataset.uxTouched;
          delete field.dataset.uxDirty;
        }
      });
    }

    // ---------- Pending-fields chip in the bottom bar ----------
    function ensureChip() {
      const existing = byId("ux-pending-chip");
      if (existing) return existing;
      const host = doc.querySelector(".ck-acoes-barra");
      if (!host) return null;
      const chip = doc.createElement("button");
      chip.type = "button";
      chip.id = "ux-pending-chip";
      chip.className = "ck-btn ck-btn--fantasma ck-pendentes";
      chip.innerHTML = '<svg class="ck-ico" aria-hidden="true" focusable="false"><use href="#i-alerta"></use></svg>'
        + '<span class="ck-pendentes__n" aria-hidden="true"><span data-ux-count>0</span></span>'
        + '<span data-ux-label aria-hidden="true"></span>';
      chip.addEventListener("click", () => {
        const [next] = listPendingFields(byId);
        if (!next) return;
        next.field.focus({ preventScroll: true });
        next.field.scrollIntoView?.({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
      });
      host.appendChild(chip);
      return chip;
    }

    function updateChip(pending) {
      const chip = ensureChip();
      if (!chip) return;
      const count = pending.length;
      chip.dataset.status = count ? "pending" : "success";
      chip.querySelector("[data-ux-count]").textContent = count ? String(count) : "✓";
      chip.querySelector("[data-ux-label]").textContent = shortPendingLabel(count);
      const readyStatus = byId("status-summary")?.querySelector("[data-ux-ready-status]");
      if (readyStatus) {
        const readyText = describeReadiness(count);
        if (readyStatus.textContent !== readyText) readyStatus.textContent = readyText;
      }
      if (count) {
        const shortText = `${count} ${shortPendingLabel(count)}`;
        chip.removeAttribute("aria-disabled");
        chip.title = `${describePending(count)}. Próximo: ${pending[0].label}`;
        chip.setAttribute("aria-label", `Ir ao próximo campo pendente: ${shortText}. Próximo: ${pending[0].label}`);
      } else {
        chip.setAttribute("aria-disabled", "true");
        chip.title = "Todos os campos obrigatórios estão preenchidos";
        chip.setAttribute("aria-label", "Todos os campos obrigatórios estão preenchidos");
      }
    }

    // ---------- Tables & state messages ----------
    function updateOverflow(wrap) {
      const state = overflowState(wrap.scrollLeft, wrap.clientWidth, wrap.scrollWidth);
      if (state) wrap.dataset.uxOverflow = state;
      else delete wrap.dataset.uxOverflow;
    }

    function scanDynamicContent() {
      doc.querySelectorAll(".accessible-table-wrap").forEach(wrap => {
        if (resizeObserver && !observedTables.has(wrap)) {
          observedTables.add(wrap);
          resizeObserver.observe(wrap);
        }
        updateOverflow(wrap);
      });
      doc.querySelectorAll('p.text-center[role="status"], [data-ux-loading]').forEach(node => {
        if (/^\s*Carregando/i.test(node.textContent || "")) node.dataset.uxLoading = "true";
        else delete node.dataset.uxLoading;
      });
    }

    function refresh() {
      refreshQueued = false;
      validateTouchedFields();
      updateChip(listPendingFields(byId));
    }

    function scheduleRefresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      (win.requestAnimationFrame || (callback => win.setTimeout(callback, 16)))(refresh);
    }

    // ---------- Event wiring (capture phase so app.js handlers still run normally) ----------
    doc.addEventListener("click", event => {
      const target = event.target;
      const copyTrigger = target?.closest?.(COPY_SELECTOR);
      if (isCopyTrigger(copyTrigger) && !copyTrigger.disabled) pendingCopy = { trigger: copyTrigger, at: Date.now() };
      if (target?.closest?.("#btn-gerar-planilha")) setTouched(true);
      win.setTimeout(scheduleRefresh, 0);
    }, true);

    doc.addEventListener("input", event => {
      const target = event.target;
      if (REQUIRED_IDS.has(target?.id)) target.dataset.uxDirty = "true";
      const typedAtEnd = target?.selectionStart == null || target.selectionStart === target.value.length;
      if (/-telefone$/.test(String(target?.id || "")) && typedAtEnd && !/^(deleteContent)/.test(event.inputType || "")) {
        const masked = formatPhone(target.value);
        if (masked !== target.value) target.value = masked;
      }
      scheduleRefresh();
    }, true);
    doc.addEventListener("change", scheduleRefresh, true);
    doc.addEventListener("focusout", event => {
      const field = event.target;
      if (/-telefone$/.test(String(field?.id || ""))) {
        const masked = formatPhone(field.value);
        if (masked !== field.value) field.value = masked;
      }
      if (REQUIRED_IDS.has(field?.id) && field.dataset.uxDirty === "true") field.dataset.uxTouched = "true";
      scheduleRefresh();
    }, true);
    // Fires only after the reset was confirmed and applied, so a cancelled dialog keeps the validation state.
    doc.addEventListener("simpress:form-reset", () => { setTouched(false); scheduleRefresh(); });
    // Other modules swap the status text (clear selection, reset); recompute it when they do.
    const statusSummary = byId("status-summary");
    if (statusSummary && win.MutationObserver) new win.MutationObserver(scheduleRefresh).observe(statusSummary, { childList: true });

    // Info tips: Esc hides the open tip until the pointer or focus leaves it (WCAG 1.4.13).
    doc.addEventListener("keydown", event => {
      if (event.key === "Escape") dismissInfoTips(doc);
    }, true);
    doc.addEventListener("click", event => {
      const menu = doc.querySelector(".cockpit-tools-dropdown[open]");
      if (shouldCloseCockpitToolsMenu(menu, event.target)) menu.open = false;
    }, true);
    doc.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      const menu = doc.querySelector(".cockpit-tools-dropdown[open]");
      if (!menu) return;
      event.preventDefault();
      menu.open = false;
      byId("cockpit-tools-trigger")?.focus();
    }, true);
    doc.addEventListener("keydown", event => {
      const chip = byId("readiness-panel");
      if (event.key !== "Escape" || !chip?.open || !chip.contains(event.target)) return;
      event.preventDefault();
      chip.open = false;
      chip.querySelector("summary")?.focus();
    }, true);
    const resetTip = event => {
      const tip = event.target?.closest?.(".info-tip");
      if (tip && !tip.contains(event.relatedTarget)) tip.removeAttribute("data-tip-dismissed");
    };
    doc.addEventListener("mouseout", resetTip, true);
    doc.addEventListener("focusout", resetTip, true);

    doc.addEventListener("keydown", event => {
      const target = event.target;
      const typing = Boolean(target) && (/^(INPUT|TEXTAREA|SELECT)$/.test(String(target.tagName || "")) || target.isContentEditable === true);
      const panel = byId("tab-panel-retirada-entrega");
      const action = shortcutAction(event, {
        typing,
        modalOpen: Boolean(doc.querySelector('[data-accessible-modal="true"]:not(.hidden):not([data-motion-closing="true"])')),
        transferVisible: Boolean(panel) && !panel.hidden && !byId("main-content")?.hidden,
      });
      if (action === "search") {
        const input = byId("input-serial");
        if (!input) return;
        event.preventDefault();
        if (typeof win.ativarAbaTransferencia === "function") win.ativarAbaTransferencia("home");
        input.focus();
        input.select?.();
      } else if (action === "tab-home") {
        event.preventDefault();
        if (typeof win.ativarAbaTransferencia === "function") win.ativarAbaTransferencia("home");
      } else if (action === "tab-transferencia") {
        event.preventDefault();
        if (typeof win.ativarAbaTransferencia === "function") win.ativarAbaTransferencia("transferencia");
      } else if (action === "tab-resumo") {
        event.preventDefault();
        if (typeof win.ativarAbaTransferencia === "function") win.ativarAbaTransferencia("resumo");
      } else if (action === "tab-automacao") {
        event.preventDefault();
        if (typeof win.ativarAbaTransferencia === "function") win.ativarAbaTransferencia("automacao");
      } else if (action?.startsWith("equipment-") || action === "copy-ticket") {
        if (!win.SimpressApp?.state.currentEquipamento || byId("main-content")?.hidden || byId("tab-panel-home")?.hidden) return;
        const button = action === "equipment-transport" ? byId("btn-ir-para-transporte")
          : action === "copy-ticket" ? byId("btn-copiar-chamado-atual")
            : doc.querySelector('#card-equipamento [data-on-click="abrirModalEditarEquipamento"]');
        if (!button || button.disabled) return;
        event.preventDefault();
        button.click();
      } else if (action?.startsWith("tool-")) {
        const buttonIds = {
          "tool-chamados": "btn-acompanhamento-chamados",
          "tool-comparacao": "btn-cockpit-comparacao",
          "tool-apelidos": "btn-historico-apelidos",
          "tool-relatorio": "btn-relatorio-mensal",
        };
        const button = byId(buttonIds[action]);
        if (!button) return;
        event.preventDefault();
        button.click();
      } else if (action === "generate") {
        const button = byId("btn-gerar-planilha");
        if (!button || button.disabled) return;
        event.preventDefault();
        button.click();
      }
    });

    // ---------- Recent destinations and observations ----------
    function ensureRecentRow(id, label, anchor) {
      let row = byId(id);
      if (!row && anchor) {
        row = doc.createElement("div");
        row.id = id;
        row.className = "ux-recent";
        row.setAttribute("role", "group");
        row.setAttribute("aria-label", label);
        anchor.insertAdjacentElement("afterend", row);
      }
      return row;
    }

    function fillRecentRow(row, label, items, onPick) {
      if (!row) return;
      row.replaceChildren();
      row.hidden = items.length === 0;
      if (!items.length) return;
      const caption = doc.createElement("span");
      caption.className = "ux-recent-label";
      caption.textContent = label;
      row.appendChild(caption);
      items.forEach(item => {
        const chip = doc.createElement("button");
        chip.type = "button";
        chip.className = "ux-recent-chip";
        chip.textContent = item.length > 34 ? `${item.slice(0, 33)}…` : item;
        chip.title = item;
        chip.addEventListener("click", () => onPick(item));
        row.appendChild(chip);
      });
    }

    function pickRecentObservation(text) {
      if (typeof win.adicionarObsChamado === "function") win.adicionarObsChamado(text);
      else {
        const field = byId("entrega-obs");
        if (!field) return;
        field.value = field.value.trim() ? `${field.value} ${text}` : text;
        field.dispatchEvent(new win.Event("input", { bubbles: true }));
      }
      byId("entrega-obs")?.focus();
    }

    function renderRecents() {
      const obs = byId("entrega-obs");
      const quickChips = obs?.parentElement?.querySelector(".flex.flex-wrap");
      const obsRow = ensureRecentRow("ux-recent-obs", "Observações recentes", quickChips || obs);
      fillRecentRow(obsRow, "Já usadas:", readRecent(RECENT_OBS_KEY), pickRecentObservation);
    }

    doc.addEventListener("simpress:transfer-generated", event => {
      const payload = event.detail?.payload || {};
      writeRecent(RECENT_OBS_KEY, pushRecent(readRecent(RECENT_OBS_KEY), payload.entrega_obs));
      renderRecents();
    });

    doc.addEventListener("scroll", event => {
      if (event.target?.classList?.contains("accessible-table-wrap")) updateOverflow(event.target);
    }, true);

    let scanQueued = false;
    const observer = typeof win.MutationObserver === "function" ? new win.MutationObserver(() => {
      if (scanQueued) return;
      scanQueued = true;
      win.setTimeout(() => { scanQueued = false; scanDynamicContent(); }, 50);
    }) : null;

    function start() {
      observer?.observe(doc.body, { childList: true, subtree: true });
      scanDynamicContent();
      renderRecents();
      refresh();
    }
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }

  return Object.freeze({
    REQUIRED_FIELDS,
    MESSAGES,
    fieldProblem,
    isFieldActive,
    listPendingFields,
    describePending,
    describeReadiness,
    shortPendingLabel,
    isCopyTrigger,
    phoneProblem,
    formatPhone,
    shortcutAction,
    shouldCloseCockpitToolsMenu,
    pushRecent,
    copyStateFor,
    overflowState,
    dismissInfoTips,
    install,
  });
});
