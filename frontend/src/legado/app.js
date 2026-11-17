/**
 * Bootstrap: builds the shared context, creates the feature modules in frontend/src/aplicacao/ (registro.ts),
 * publishes their actions on the page scope and starts the page once the DOM is ready.
 *
 * Actions live on window because data-on-* attributes (frontend/src/legado/ui/action-dispatcher.js, which
 * runs only the feature actions registered below), modal close handlers
 * (frontend/src/ui/accessible-dialogs.ts) and the enhancement scripts
 * resolve them there. Features call each other through `app` as well, so an action that is
 * replaced on window (tests, enhancements) takes effect everywhere.
 */
(function bootstrap(app) {
  "use strict";

  const FEATURE_ORDER = Object.freeze([
    "shell",
    "dashboard",
    "resumoAtivos",
    "backupsRegionais",
    "cockpitToolPanels",
    "regionalContacts",
    "transferForm",
    "equipmentSearch",
    "uxChamados",
    "uxTicket",
    "fullEquipmentSearch",
    "unitsCatalog",
    "inventoryUpload",
    "entraUsers",
    "comparisonResult",
    "comparisonHistory",
    "cockpitChamados",
    "equipmentEditor",
    "aliasHistory",
    "monthlyReport",
    "sebraeDashboard",
    "sebraeHistorico",
    "sebraeConflitos",
    "chromeAutomation",
    "assistantChat",
    "coverage",
    "termos",
    "lembretes",
    "outlookEmail",
    "equipmentDossier",
    "configuracaoLocal",
  ]);

  // State shared by more than one feature. Each feature keeps the rest of its state private.
  const appState = {
    // Equipment selected on Home; the transfer form and the equipment dialogs read it.
    currentEquipamento: null,
    // Bumped on every selection change and serial edit, so a late save never overwrites a newer selection.
    equipamentoSelectionRevision: 0,
    retiradaCidadeSelecionada: "",
    unidadesList: [],
    previaPlanilhasAtual: null,
  };

  const domUtils = window.SimpressDomUtils(document);
  const context = {
    app,
    appState,
    dom: domUtils,
    apiErrors: window.SimpressApiErrors,
    apiFetch: window.SimpressApiFetch.apiFetch,
    equipmentSearchRenderer: window.SimpressEquipmentSearchRenderers,
    historyFormat: window.SimpressHistoryFormat,
    sebraeDashboardModel: window.SimpressSebraeDashboardModel,
    ticketRules: window.SimpressTicketRules(domUtils),
    transferUtils: window.SimpressTransferUtils,
    catalogSearch: window.SimpressCatalogSearch,
    recentEquipment: window.SimpressRecentEquipment,
    motion: window.SimpressMotion,
    inventoryOperationKey: () => globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
  // Logged user next to a series in the Histórico de Planilhas rows and the equipment dialogs.
  context.loggedUserMarkers = window.SimpressLoggedUserMarkers(context);

  // Panels migrated to React (frontend/src/paineis/<panel>/, plan docs/planos/migracao-react-vite.md).
  // react-entry.js runs after this file and publishes each panel's actions in window.SimpressReact, so the
  // panel's old feature module stays in FEATURE_ORDER as a bridge: ponteReact(panel, names) returns async
  // forwarders that wait for that registry. Nothing waits until the first call; if react-entry.js never
  // loads (its script fires "error", or window "load" with no registry) or the panel failed to mount, every call rejects.
  const scriptReact = document.querySelector('script[src*="/static/dist/react-entry.js"]');
  let bundleFalhou = false;
  scriptReact?.addEventListener("error", () => { bundleFalhou = true; }, { once: true });
  const reactPanels = new Map();
  function waitForReactPanel(panel) {
    if (!reactPanels.has(panel)) {
      reactPanels.set(panel, new Promise((resolve, reject) => {
        const settle = () => {
          if (!window.SimpressReact && !bundleFalhou && document.readyState !== "complete") return false;
          const actions = window.SimpressReact?.[panel];
          if (actions) resolve(actions);
          else reject(new Error(`O painel React "${panel}" não carregou.`));
          return true;
        };
        if (settle()) return;
        document.addEventListener("simpress:react-pronto", settle, { once: true });
        window.addEventListener("load", settle, { once: true });
        scriptReact?.addEventListener("error", settle, { once: true });
      }));
    }
    return reactPanels.get(panel);
  }
  context.ponteReact = (panel, names) => Object.fromEntries(names.map(name => [
    name,
    (...args) => waitForReactPanel(panel).then(actions => actions[name](...args)),
  ]));
  // Ações chamadas no mesmo turno pelo código legado não podem esperar pelo boot do React.
  context.ponteReactSincrona = (panel, names) => Object.fromEntries(names.map(name => [
    name,
    (...args) => {
      const action = window.SimpressReact?.[panel]?.[name];
      if (typeof action !== "function") {
        console.error(new Error(`O painel React "${panel}" não carregou.`));
        return;
      }
      return action(...args);
    },
  ]));

  const publishedBy = new Map();
  function publish(actions, source) {
    Object.entries(actions).forEach(([name, action]) => {
      if (publishedBy.has(name)) throw new Error(`A ação "${name}" foi publicada por ${publishedBy.get(name)} e por ${source}.`);
      publishedBy.set(name, source);
      app[name] = action;
    });
  }

  const { escapeHtml, createTextElement, createIcon, highlightMatch, pluralize } = domUtils;
  publish({ escapeHtml, createTextElement, createIcon, highlightMatch, pluralize }, "dom");
  publish({ createApiError: context.apiErrors.create }, "apiErrors");
  publish({ apiFetch: context.apiFetch }, "apiFetch");
  publish(context.historyFormat, "historyFormat");
  publish(context.ticketRules, "ticketRules");
  FEATURE_ORDER.forEach(name => {
    const createFeature = window.SimpressFeatures?.[name];
    if (typeof createFeature !== "function") throw new Error(`O módulo "${name}" não foi carregado.`);
    const actions = createFeature(context);
    publish(actions, name);
    // Closed list for data-on-*: only feature actions, never the shared helpers published above.
    window.SimpressActionDispatcher?.allow(Object.keys(actions));
    if (name === "shell") {
      context.motion?.installFeedback();
      window.HistoryAnnotationAutosave.installPendingNavigationGuard(window);
    }
  });
  app.SimpressApp = Object.freeze({ state: appState });

  function inicializarAplicacao() {
    lucide.createIcons();
    app.associarRotulosAcessiveis();
    app.inicializarExportacaoAutomaticaHistorico();
    app.carregarProntidao();
    app.carregarEstatisticas();
    app.carregarUnidades();
    app.carregarContagemHistoricoComparacoes();
    app.inicializarArquivosAtualizacaoPlanilhas();
    app.carregarEstadoEntra();
    app.inicializarAlertaBaseDesatualizada();
    app.inicializarAlertasOsDivergencias();
    app.inicializarProntidao();
    app.inicializarAutomacao();
    app.carregarNovosSebrae();
  }

  if (document.readyState === "interactive" || document.readyState === "complete") {
    inicializarAplicacao();
  } else {
    document.addEventListener("DOMContentLoaded", inicializarAplicacao, { once: true });
  }
})(globalThis);
