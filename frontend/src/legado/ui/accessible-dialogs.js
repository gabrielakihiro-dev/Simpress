(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.SimpressAccessibleDialogs = factory;
})(typeof window !== "undefined" ? window : globalThis, function createAccessibleDialogs(options) {
  "use strict";

  const {
    document,
    window,
    motion,
    HTMLElement: HTMLElementType,
    requestAnimationFrame: scheduleFrame,
    lucide,
  } = options;

  const returnFocus = new Map();

  function isConnectedVisibleElement(element) {
    if (!element
      || (HTMLElementType && !(element instanceof HTMLElementType))
      || !element.isConnected
      || element.closest(".hidden")
      || element.closest("[inert]")
      || !element.getClientRects().length
      || (typeof element.checkVisibility === "function" && !element.checkVisibility())) return false;
    if (typeof window.getComputedStyle !== "function") return true;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function stackLevel(modal) {
    const inline = Number(modal.style?.zIndex);
    if (inline) return inline;
    if (typeof window.getComputedStyle !== "function") return 0;
    return Number(window.getComputedStyle(modal).zIndex) || 0;
  }

  // Every overlay shares one z-index in CSS, so DOM order would decide which one is on top.
  // Raise the newly opened dialog above the ones already open, whatever its position in the page.
  function raiseAbove(modal, openModals) {
    if (!modal.style) return;
    const highest = openModals.filter(item => item !== modal).reduce((top, item) => Math.max(top, stackLevel(item)), 0);
    modal.style.zIndex = highest ? String(highest + 1) : "";
  }

  function open(modalId, initialFocusSelector, closeFunction) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    const openModals = [...document.querySelectorAll('[data-accessible-modal="true"]')]
      .filter(item => !item.classList.contains("hidden") && item.dataset.motionClosing !== "true");
    const previousModal = openModals[openModals.length - 1];
    if (previousModal && previousModal !== modal) {
      previousModal.inert = true;
      previousModal.setAttribute("aria-hidden", "true");
    }

    if (!returnFocus.has(modal)) returnFocus.set(modal, document.activeElement);
    raiseAbove(modal, openModals);
    modal.classList.remove("hidden");
    modal.inert = false;
    modal.removeAttribute("aria-hidden");
    modal.dataset.accessibleModal = "true";
    modal.dataset.closeFunction = closeFunction;

    const dialog = modal.firstElementChild;
    if (!dialog) return;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("tabindex", "-1");
    dialog.classList.add("modal-panel");
    const heading = dialog.querySelector("h1, h2, h3");
    if (heading) {
      if (!heading.id) heading.id = `${modalId}-titulo`;
      dialog.setAttribute("aria-labelledby", heading.id);
    }

    document.body.classList.add("dialog-open");
    lucide.createIcons({ root: modal });
    motion?.openOverlay(modal);
    scheduleFrame(() => {
      if (modal.classList.contains("hidden") || modal.dataset.motionClosing === "true" || modal.inert) return;
      const preferred = initialFocusSelector ? dialog.querySelector(initialFocusSelector) : null;
      const target = preferred && !preferred.disabled ? preferred : dialog;
      target.focus({ preventScroll: true });
    });
  }

  function close(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal || modal.classList.contains("hidden") || modal.dataset.motionClosing === "true") return;
    const hide = () => {
      modal.classList.add("hidden");
      if (modal.style) modal.style.zIndex = "";
    };
    if (motion) motion.closeOverlay(modal, hide);
    else hide();

    const previousFocus = returnFocus.get(modal);
    returnFocus.delete(modal);
    const openModals = [...document.querySelectorAll('[data-accessible-modal="true"]')]
      .filter(item => !item.classList.contains("hidden") && item.dataset.motionClosing !== "true");
    const activeModal = openModals[openModals.length - 1];
    if (activeModal) {
      activeModal.inert = false;
      activeModal.removeAttribute("aria-hidden");
      const target = previousFocus && activeModal.contains(previousFocus)
        ? previousFocus
        : activeModal.firstElementChild;
      target?.focus({ preventScroll: true });
      return;
    }

    document.body.classList.remove("dialog-open");
    if (isConnectedVisibleElement(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
    } else {
      const fallback = [
        document.getElementById("cockpit-tools-trigger"),
        document.getElementById("btn-sidebar-open"),
        document.querySelector('.header-action-group[data-action-group="analysis"] > summary'),
        document.getElementById("input-serial"),
      ].find(isConnectedVisibleElement);
      fallback?.focus({ preventScroll: true });
    }
  }

  function onKeyDown(event) {
    const openModals = [...document.querySelectorAll('[data-accessible-modal="true"]')]
      .filter(item => !item.classList.contains("hidden") && item.dataset.motionClosing !== "true");
    const modal = openModals[openModals.length - 1];
    if (!modal) {
      if (event.key === "Escape" && !document.querySelector(".ck-veu:not([hidden])")) {
        const disclosure = [...document.querySelectorAll("details[open]")].pop();
        if (disclosure) {
          disclosure.open = false;
          disclosure.querySelector("summary")?.focus();
        }
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      const closeFunction = window[modal.dataset.closeFunction];
      if (typeof closeFunction === "function") closeFunction();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = modal.firstElementChild;
    const focusable = [...dialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(element => element.getClientRects().length && !element.closest("[inert]"));
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  function associateLabels() {
    const fallbackLabels = new Map([
      ["input-serial", "Número de série do equipamento"],
      ["textarea-resumo-preview", "Resumo da transferência"],
    ]);
    document.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach(control => {
      if (control.labels?.length || control.hasAttribute("aria-label") || control.hasAttribute("aria-labelledby")) return;
      if (!control.id) control.id = `campo-${Math.random().toString(36).slice(2, 9)}`;

      let label = null;
      let node = control;
      while (node.parentElement && node.parentElement !== document.body && !label) {
        const siblings = [...node.parentElement.children];
        const priorSiblings = siblings.slice(0, siblings.indexOf(node)).reverse();
        for (const sibling of priorSiblings) {
          const candidates = [
            ...(sibling.matches("label") ? [sibling] : []),
            ...sibling.querySelectorAll("label"),
          ];
          label = candidates.find(candidate => !candidate.control && !candidate.htmlFor);
          if (label) break;
        }
        node = node.parentElement;
      }

      if (label) {
        label.htmlFor = control.id;
        return;
      }
      const fallback = fallbackLabels.get(control.id)
        || control.getAttribute("placeholder")
        || control.id.replace(/[-_]+/g, " ");
      control.setAttribute("aria-label", fallback.replace(/\s+/g, " ").trim());
    });
  }

  document.addEventListener("keydown", onKeyDown);
  return Object.freeze({ open, close, associateLabels });
});
