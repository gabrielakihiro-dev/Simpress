(() => {
  "use strict";

  const STORAGE_KEY = "simpress.sidebar.collapsed";
  const MOBILE_QUERY = "(max-width: 767px)";
  const COMPACT_QUERY = "(min-width: 768px) and (max-width: 1199px)";

  function inicializarMenuLateral() {
    const shell = document.getElementById("simpress-app-shell");
    const sidebar = document.getElementById("app-sidebar");
    const sidebarToggle = document.getElementById("btn-sidebar-toggle");
    const mobileOpenButton = document.getElementById("btn-sidebar-open");
    const backdrop = document.getElementById("sidebar-backdrop");
    const mainContent = document.getElementById("main-content");

    if (!shell || !sidebar || !sidebarToggle || !mobileOpenButton || !backdrop) return;

    const mobileQuery = window.matchMedia(MOBILE_QUERY);
    const compactQuery = window.matchMedia(COMPACT_QUERY);
    let hasSavedPreference = false;

    function menuRecolhido() {
      return shell.dataset.sidebarCollapsed === "true";
    }

    function menuMovelAberto() {
      return shell.dataset.sidebarOpen === "true";
    }

    function atualizarBotoes() {
      const expandido = mobileQuery.matches ? menuMovelAberto() : !menuRecolhido();
      sidebarToggle.setAttribute("aria-expanded", String(expandido));
      sidebarToggle.setAttribute(
        "aria-label",
        mobileQuery.matches
          ? "Fechar menu lateral"
          : menuRecolhido()
            ? "Expandir menu lateral"
            : "Recolher menu lateral",
      );
      sidebarToggle.title = sidebarToggle.getAttribute("aria-label");
      mobileOpenButton.setAttribute("aria-expanded", String(menuMovelAberto()));
    }

    function definirMenuRecolhido(recolhido, persistir = true) {
      shell.dataset.sidebarCollapsed = String(recolhido);
      if (persistir) {
        hasSavedPreference = true;
        try {
          window.localStorage.setItem(STORAGE_KEY, String(recolhido));
        } catch (_error) {
          // The menu remains usable if storage is unavailable.
        }
      }
      atualizarBotoes();
    }

    function fecharMenuMovel(restaurarFoco = false) {
      shell.dataset.sidebarOpen = "false";
      document.body.classList.remove("sidebar-drawer-open");
      atualizarBotoes();
      if (restaurarFoco) {
        window.requestAnimationFrame(() => mobileOpenButton.focus({ preventScroll: true }));
      }
    }

    function abrirMenuMovel() {
      shell.dataset.sidebarOpen = "true";
      document.body.classList.add("sidebar-drawer-open");
      atualizarBotoes();
      window.requestAnimationFrame(() => sidebarToggle.focus({ preventScroll: true }));
    }

    function existeDialogoVisivel() {
      return Array.from(document.querySelectorAll('.modal-overlay, [role="dialog"], dialog[open]')).some((element) => {
        const estilo = window.getComputedStyle(element);
        return estilo.display !== "none" && estilo.visibility !== "hidden" && element.getClientRects().length > 0;
      });
    }

    try {
      const salvo = window.localStorage.getItem(STORAGE_KEY);
      if (salvo === "true" || salvo === "false") {
        hasSavedPreference = true;
        definirMenuRecolhido(salvo === "true", false);
      } else {
        definirMenuRecolhido(compactQuery.matches, false);
      }
    } catch (_error) {
      definirMenuRecolhido(compactQuery.matches, false);
    }

    sidebarToggle.addEventListener("click", () => {
      if (mobileQuery.matches) {
        fecharMenuMovel(true);
        return;
      }
      definirMenuRecolhido(!menuRecolhido());
    });

    mobileOpenButton.addEventListener("click", () => {
      if (menuMovelAberto()) fecharMenuMovel(true);
      else abrirMenuMovel();
    });

    backdrop.addEventListener("click", () => fecharMenuMovel(true));

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && mobileQuery.matches && menuMovelAberto()) {
        fecharMenuMovel(true);
      }
    });

    sidebar.addEventListener("click", (event) => {
      if (!mobileQuery.matches || !menuMovelAberto()) return;

      const controle = event.target.closest("button");
      if (!controle || controle === sidebarToggle) return;

      const trocouAba = controle.getAttribute("role") === "tab";
      fecharMenuMovel(false);

      if (trocouAba && mainContent) {
        window.requestAnimationFrame(() => mainContent.focus({ preventScroll: true }));
      } else {
        window.requestAnimationFrame(() => {
          if (!existeDialogoVisivel()) mobileOpenButton.focus({ preventScroll: true });
        });
      }
    });

    const sincronizarViewport = () => {
      if (!mobileQuery.matches && menuMovelAberto()) fecharMenuMovel(false);
      atualizarBotoes();
    };

    if (typeof mobileQuery.addEventListener === "function") {
      mobileQuery.addEventListener("change", sincronizarViewport);
    } else if (typeof mobileQuery.addListener === "function") {
      mobileQuery.addListener(sincronizarViewport);
    }

    const ajustarMenuCompacto = () => {
      if (!hasSavedPreference) definirMenuRecolhido(compactQuery.matches, false);
    };
    if (typeof compactQuery.addEventListener === "function") {
      compactQuery.addEventListener("change", ajustarMenuCompacto);
    } else if (typeof compactQuery.addListener === "function") {
      compactQuery.addListener(ajustarMenuCompacto);
    }

    atualizarBotoes();
    if (window.lucide?.createIcons) window.lucide.createIcons({ root: sidebar });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inicializarMenuLateral, { once: true });
  } else {
    inicializarMenuLateral();
  }
})();
