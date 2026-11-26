/** Page-wide services: toasts, accessible modals and the sidebar page they belong to, the confirmation dialog, and clipboard access. */
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export function createShell(context: ContextoApp): Acoes {
  const { app, motion } = context;
  const { createIcon } = context.dom;

  const accessibleDialogs = window.SimpressAccessibleDialogs({
    document, window, motion, HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    lucide,
  });

  const notifications = window.SimpressNotifications({ document, window, lucide, motion, createIcon });

  const paginaSidebarPorModal = new Map<string, string>();

  function atualizarPaginaSidebarAtiva() {
    const openModals = ([...document.querySelectorAll('[data-accessible-modal="true"]')] as HTMLElement[])
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

  function abrirModalAcessivel(modalId: string, initialFocusSelector: Qualquer, closeFunction: Qualquer, sidebarPageButtonId: string | null = null) {
    if (sidebarPageButtonId) paginaSidebarPorModal.set(modalId, sidebarPageButtonId);
    else paginaSidebarPorModal.delete(modalId);
    accessibleDialogs.open(modalId, initialFocusSelector, closeFunction);
    requestAnimationFrame(atualizarPaginaSidebarAtiva);
  }

  function fecharModalAcessivel(modalId: string) {
    accessibleDialogs.close(modalId);
    requestAnimationFrame(atualizarPaginaSidebarAtiva);
  }

  function associarRotulosAcessiveis() {
    accessibleDialogs.associateLabels();
  }

  // Toast system
  function showToast(message: string, type = "success") {
    notifications.show(message, type);
  }

  function fecharMenuSecundarioAoClicarFora(event: Qualquer) {
    const menu = document.querySelector(".header-secondary-actions") as HTMLDetailsElement | null;
    if (menu?.open && !menu.contains(event.target)) {
      menu.open = false;
    }
  }

  document.addEventListener("click", fecharMenuSecundarioAoClicarFora);

  // Accessible replacement for window.confirm; falls back to it when the dialog markup is absent.
  let confirmacaoAcaoPendente: { promise: Promise<Qualquer>; resolver: (resposta: Qualquer) => void; comBlocos: boolean } | null = null;

  /** Bloco opcional do diálogo: aviso laranja com linhas rótulo/valor e uma caixa que abre SEMPRE desmarcada (o DOM é refeito a cada abertura).
   * Com `blocos`, a resposta vira `{ confirmado, marcados }` (ids das caixas marcadas, vazio em Esc, fechar e Cancelar); sem eles segue boolean/null. */
  function montarBlocosConfirmacao(blocos: Qualquer[]) {
    const raiz = document.getElementById("blocos-confirmar-acao");
    if (!raiz) return;
    raiz.replaceChildren(...blocos.map((bloco, indice) => {
      const criar = (tag: string, classe: string, texto = "") => { const no = document.createElement(tag); no.className = classe; if (texto) no.textContent = texto; return no; };
      const secao = criar("section", "ck-confirmar__bloco");
      const idBase = `confirmar-bloco-${indice}`;
      secao.setAttribute("aria-labelledby", `${idBase}-titulo`);
      const titulo = criar("h4", "ck-confirmar__bloco-titulo", bloco.titulo);
      titulo.id = `${idBase}-titulo`;
      const lista = criar("dl", "ck-confirmar__linhas");
      (bloco.linhas as string[][]).forEach(([rotulo, valor]) => { lista.append(criar("dt", "", rotulo), criar("dd", "", valor || "(vazio)")); });
      const rotulo = criar("label", "ck-confirmar__caixa");
      const caixa = document.createElement("input");
      caixa.type = "checkbox";
      caixa.checked = false;
      caixa.dataset.blocoId = bloco.id;
      caixa.disabled = Boolean(bloco.bloqueio);
      rotulo.append(caixa, criar("span", "", bloco.caixa));
      const ajuda = criar("p", "ck-confirmar__ajuda", bloco.ajudaDesmarcada);
      ajuda.id = `${idBase}-ajuda`;
      ajuda.setAttribute("aria-live", "polite");
      caixa.setAttribute("aria-describedby", ajuda.id);
      caixa.addEventListener("change", () => { ajuda.textContent = caixa.checked ? bloco.ajudaMarcada : bloco.ajudaDesmarcada; });
      secao.append(titulo, criar("p", "ck-confirmar__bloco-texto", bloco.texto), lista, rotulo, ajuda);
      if (bloco.bloqueio) secao.append(criar("p", "ck-confirmar__bloqueio", bloco.bloqueio));
      return secao;
    }));
    raiz.hidden = false;
  }

  function lerBlocosMarcados(): string[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>("#blocos-confirmar-acao input[type=checkbox]:checked:not(:disabled)")).map(caixa => caixa.dataset.blocoId || "");
  }

  function limparBlocosConfirmacao() {
    const raiz = document.getElementById("blocos-confirmar-acao");
    if (!raiz) return;
    raiz.replaceChildren();
    raiz.hidden = true;
  }

  function confirmarAcao({ titulo, mensagem, confirmar = "Confirmar", cancelar = "Cancelar", destrutiva = true, blocos }: Qualquer) {
    const modal = document.getElementById("modal-confirmar-acao");
    const botaoConfirmar = modal?.querySelector?.("#btn-confirmar-acao-ok") as HTMLElement | null | undefined;
    // sem o markup do diálogo vale o window.confirm; para as caixas, "não confirmado"
    if (!botaoConfirmar) { const resposta = window.confirm(mensagem); return Promise.resolve(blocos ? { confirmado: resposta, marcados: [] } : resposta); }
    if (confirmacaoAcaoPendente) return confirmacaoAcaoPendente.comBlocos === Boolean(blocos) ? confirmacaoAcaoPendente.promise : Promise.resolve(blocos ? { confirmado: null, marcados: [] } : null);
    let resolver: (resposta: Qualquer) => void = () => {};
    const promise = new Promise<Qualquer>(resolve => { resolver = resolve; });
    confirmacaoAcaoPendente = { promise, resolver, comBlocos: Boolean(blocos) };
    document.getElementById("titulo-confirmar-acao")!.textContent = titulo;
    document.getElementById("mensagem-confirmar-acao")!.textContent = mensagem;
    if (blocos?.length) montarBlocosConfirmacao(blocos); else limparBlocosConfirmacao();
    botaoConfirmar.textContent = confirmar;
    botaoConfirmar.dataset.variant = destrutiva ? "danger" : "primary";
    document.getElementById("btn-confirmar-acao-cancelar")!.textContent = cancelar;
    app.abrirModalAcessivel("modal-confirmar-acao", "#btn-confirmar-acao-cancelar", "fecharConfirmacaoAcao");
    // abrirModalAcessivel marca todo diálogo como role="dialog"; o foco vai a Cancelar, então a mensagem precisa ser lida ao abrir.
    const dialogo = modal!.firstElementChild;
    dialogo?.setAttribute("role", "alertdialog");
    dialogo?.setAttribute("aria-describedby", "mensagem-confirmar-acao");
    return promise;
  }

  function responderConfirmacaoAcao(resposta: Qualquer) {
    const pendente = confirmacaoAcaoPendente;
    confirmacaoAcaoPendente = null;
    const marcados = resposta === true ? lerBlocosMarcados() : []; // só o "Confirmar" leva as caixas; Esc e Cancelar nunca vazam marcação
    limparBlocosConfirmacao();
    app.fecharModalAcessivel("modal-confirmar-acao");
    pendente?.resolver(pendente.comBlocos ? { confirmado: resposta, marcados } : resposta);
  }

  // Esc e fechar o diálogo resolvem null (falso para quem só testa verdade); o botão Cancelar resolve false.
  // Quem precisa distinguir os dois (Atualizar Dashboard) compara com === null.
  function fecharConfirmacaoAcao() {
    app.responderConfirmacaoAcao(null);
  }

  async function copiarTextoParaAreaTransferencia(texto: string) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(texto);
        return;
      } catch {
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
}
