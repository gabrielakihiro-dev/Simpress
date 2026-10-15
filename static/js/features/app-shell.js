/** Page-wide services: toasts, accessible modals and the sidebar page they belong to, the confirmation dialog, and clipboard access. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).shell = factory;
})(typeof window !== "undefined" ? window : globalThis, function createShell(context) {
  "use strict";
  const { app, motion } = context;
  const { createIcon } = context.dom;

  const accessibleDialogs = window.SimpressAccessibleDialogs({
    document, window, motion, HTMLElement,
    requestAnimationFrame: callback => requestAnimationFrame(callback),
    lucide,
  });

  const notifications = window.SimpressNotifications({ document, window, lucide, motion, createIcon });

  const paginaSidebarPorModal = new Map();

  function atualizarPaginaSidebarAtiva() {
    const openModals = [...document.querySelectorAll('[data-accessible-modal="true"]')]
      .filter(modal => !modal.classList.contains("hidden") && modal.dataset.motionClosing !== "true");
    const activeButtonId = [...openModals].reverse()
      .map(modal => paginaSidebarPorModal.get(modal.id))
      .find(Boolean) || "";
    document.querySelectorAll("[data-sidebar-page]").forEach(button => {
      const active = button.id === activeButtonId;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  const observerPaginaSidebar = new MutationObserver(atualizarPaginaSidebarAtiva);

  document.querySelectorAll(".modal-overlay").forEach(modal => observerPaginaSidebar.observe(modal, {
    attributes: true,
    attributeFilter: ["class", "data-accessible-modal", "data-motion-closing"],
  }));

  function abrirModalAcessivel(modalId, initialFocusSelector, closeFunction, sidebarPageButtonId = null) {
    if (sidebarPageButtonId) paginaSidebarPorModal.set(modalId, sidebarPageButtonId);
    else paginaSidebarPorModal.delete(modalId);
    accessibleDialogs.open(modalId, initialFocusSelector, closeFunction);
    requestAnimationFrame(atualizarPaginaSidebarAtiva);
  }

  function fecharModalAcessivel(modalId) {
    accessibleDialogs.close(modalId);
    requestAnimationFrame(atualizarPaginaSidebarAtiva);
  }

  function associarRotulosAcessiveis() {
    accessibleDialogs.associateLabels();
  }

  // Toast system
  function showToast(message, type = "success") {
    notifications.show(message, type);
  }

  function fecharMenuSecundarioAoClicarFora(event) {
    const menu = document.querySelector(".header-secondary-actions");
    if (menu?.open && !menu.contains(event.target)) {
      menu.open = false;
    }
  }

  document.addEventListener("click", fecharMenuSecundarioAoClicarFora);

  // Accessible replacement for window.confirm; falls back to it when the dialog markup is absent.
  let confirmacaoAcaoPendente = null;

  function confirmarAcao({ titulo, mensagem, confirmar = "Confirmar", cancelar = "Cancelar", destrutiva = true }) {
    const modal = document.getElementById("modal-confirmar-acao");
    const botaoConfirmar = modal?.querySelector?.("#btn-confirmar-acao-ok");
    if (!botaoConfirmar) return Promise.resolve(window.confirm(mensagem));
    if (confirmacaoAcaoPendente) return confirmacaoAcaoPendente.promise;
    let resolver;
    const promise = new Promise(resolve => { resolver = resolve; });
    confirmacaoAcaoPendente = { promise, resolver };
    document.getElementById("titulo-confirmar-acao").textContent = titulo;
    document.getElementById("mensagem-confirmar-acao").textContent = mensagem;
    botaoConfirmar.textContent = confirmar;
    botaoConfirmar.dataset.variant = destrutiva ? "danger" : "primary";
    document.getElementById("btn-confirmar-acao-cancelar").textContent = cancelar;
    app.abrirModalAcessivel("modal-confirmar-acao", "#btn-confirmar-acao-cancelar", "fecharConfirmacaoAcao");
    return promise;
  }

  function responderConfirmacaoAcao(resposta) {
    const pendente = confirmacaoAcaoPendente;
    confirmacaoAcaoPendente = null;
    app.fecharModalAcessivel("modal-confirmar-acao");
    pendente?.resolver(resposta);
  }

  function fecharConfirmacaoAcao() {
    app.responderConfirmacaoAcao(false);
  }

  async function copiarTextoParaAreaTransferencia(texto) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(texto);
        return;
      } catch (err) {
        // Tenta o fallback legado quando a permissão da API moderna é negada.
      }
    }

    const campoTemporario = document.createElement("textarea");
    campoTemporario.value = texto;
    campoTemporario.setAttribute("readonly", "");
    campoTemporario.setAttribute("aria-hidden", "true");
    campoTemporario.style.position = "fixed";
    campoTemporario.style.opacity = "0";
    campoTemporario.style.pointerEvents = "none";
    document.body.appendChild(campoTemporario);
    campoTemporario.select();

    let copiado = false;
    try {
      copiado = typeof document.execCommand === "function" && document.execCommand("copy");
    } finally {
      campoTemporario.remove();
    }

    if (!copiado) {
      throw new Error("A cópia não foi permitida pelo navegador.");
    }
  }

  return {
    abrirModalAcessivel, fecharModalAcessivel, associarRotulosAcessiveis, showToast, confirmarAcao,
    responderConfirmacaoAcao, fecharConfirmacaoAcao, copiarTextoParaAreaTransferencia,
  };
});
