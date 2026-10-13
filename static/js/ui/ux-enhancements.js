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
  });
  const COPY_SELECTOR = '[onclick*="copiar"], [data-copy-field], .ticket-template-copy';
  const COPY_STATES = Object.freeze({ success: "copied", warning: "warning", error: "error" });
  const COPY_MATCH_WINDOW_MS = 2500;
  const COPY_FEEDBACK_MS = 1800;
  const COPIED_LABEL = "Copiado!";
  const CHECK_ICON = '<svg class="ux-copy-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>';

  function fieldProblem(field) {
    if (!field) return null;
    if (!String(field.value ?? "").trim()) return "required";
    if (field.type === "email" && typeof field.checkValidity === "function" && !field.checkValidity()) return "email";
    return null;
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

  function isCopyTrigger(element) {
    if (!element || typeof element.getAttribute !== "function") return false;
    if (String(element.tagName || "").toUpperCase() !== "BUTTON") return false;
    const handler = element.getAttribute("onclick") || "";
    return /\bcopiar[A-Z]\w*\s*\(/.test(handler)
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
      const host = doc.querySelector(".quick-actions-status");
      if (!host) return null;
      const chip = doc.createElement("button");
      chip.type = "button";
      chip.id = "ux-pending-chip";
      chip.className = "ux-pending-chip";
      chip.innerHTML = '<span class="ux-pending-chip-count" aria-hidden="true"><span data-ux-count>0</span></span>'
        + '<span data-ux-label></span><span class="ux-pending-chip-action" aria-hidden="true">· ir ao próximo</span>';
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
      chip.querySelector("[data-ux-label]").textContent = describePending(count);
      if (count) {
        chip.removeAttribute("aria-disabled");
        chip.title = `Próximo: ${pending[0].label}`;
        chip.setAttribute("aria-label", `${describePending(count)}. Ir para o próximo: ${pending[0].label}`);
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
      if (target?.closest?.("#btn-nova-transferencia")) win.setTimeout(() => { setTouched(false); refresh(); }, 0);
      win.setTimeout(scheduleRefresh, 0);
    }, true);

    doc.addEventListener("input", event => {
      if (REQUIRED_IDS.has(event.target?.id)) event.target.dataset.uxDirty = "true";
      scheduleRefresh();
    }, true);
    doc.addEventListener("change", scheduleRefresh, true);
    doc.addEventListener("focusout", event => {
      const field = event.target;
      if (REQUIRED_IDS.has(field?.id) && field.dataset.uxDirty === "true") field.dataset.uxTouched = "true";
      scheduleRefresh();
    }, true);
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
    isCopyTrigger,
    copyStateFor,
    overflowState,
    install,
  });
});
