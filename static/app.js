/**
 * Bootstrap: builds the shared context, creates the feature modules in static/js/features/,
 * publishes their actions on the page scope and starts the page once the DOM is ready.
 *
 * Actions live on window because data-on-* attributes (static/js/ui/action-dispatcher.js),
 * modal close handlers (static/js/ui/accessible-dialogs.js) and the enhancement scripts
 * resolve them there. Features call each other through `app` as well, so an action that is
 * replaced on window (tests, enhancements) takes effect everywhere.
 */
(function bootstrap(app) {
  "use strict";

  const FEATURE_ORDER = Object.freeze([
    "shell",
    "dashboard",
    "regionalContacts",
    "transferForm",
    "equipmentSearch",
    "unitsCatalog",
    "inventoryUpload",
    "comparisonResult",
    "comparisonHistory",
    "ticketTracking",
    "equipmentEditor",
    "aliasHistory",
  ]);

  // State shared by more than one feature. Each feature keeps the rest of its state private.
  const appState = {
    // Equipment selected on Home; the transfer form and the equipment dialogs read it.
    currentEquipamento: null,
    // Bumped on every selection change and serial edit, so a late save never overwrites a newer selection.
    equipamentoSelectionRevision: 0,
    retiradaCidadeSelecionada: "",
    unidadesList: [],
    acompanhamentoChamadosAtual: null,
    historicoAcompanhamentoChamados: [],
    // Triage indicator chosen as a list filter ("ativos", "atrasados", "sem_data", "em_dia" or empty).
    filtroTriagemChamados: "",
    previaPlanilhasAtual: null,
  };

  const domUtils = window.SimpressDomUtils(document);
  const context = {
    app,
    appState,
    dom: domUtils,
    historyFormat: window.SimpressHistoryFormat,
    ticketRules: window.SimpressTicketRules(domUtils),
    transferUtils: window.SimpressTransferUtils,
    catalogSearch: window.SimpressCatalogSearch,
    recentEquipment: window.SimpressRecentEquipment,
    motion: window.SimpressMotion,
    inventoryOperationKey: () => globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };

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
  publish(context.historyFormat, "historyFormat");
  publish(context.ticketRules, "ticketRules");
  FEATURE_ORDER.forEach(name => {
    const createFeature = window.SimpressFeatures?.[name];
    if (typeof createFeature !== "function") throw new Error(`O módulo "${name}" não foi carregado.`);
    publish(createFeature(context), name);
    if (name === "shell") {
      context.motion?.installFeedback();
      window.HistoryAnnotationAutosave.installPendingNavigationGuard(window);
    }
  });
  app.SimpressApp = Object.freeze({ state: appState });

  function inicializarAplicacao() {
    document.getElementById("input-serial")?.addEventListener("input", () => {
      appState.equipamentoSelectionRevision += 1;
    });
    lucide.createIcons();
    app.carregarConfiguracaoTransferencia();
    app.popularSeletoresRepresentantesRegionais();
    app.associarRotulosAcessiveis();
    app.inicializarMascarasTelefone();
    app.inicializarExportacaoAutomaticaHistorico();
    const almocoEntrega = document.getElementById("entrega-almoco");
    almocoEntrega?.addEventListener("input", app.atualizarObrigatoriedadeDuracaoPausaEntrega);
    almocoEntrega?.addEventListener("change", app.atualizarObrigatoriedadeDuracaoPausaEntrega);
    app.atualizarObrigatoriedadeDuracaoPausaEntrega();
    app.carregarProntidao();
    app.carregarEstatisticas();
    app.carregarUnidades();
    app.carregarContagemHistoricoApelidos();
    app.carregarContagemHistoricoComparacoes();
    app.inicializarArquivosAtualizacaoPlanilhas();
  }

  if (document.readyState === "interactive" || document.readyState === "complete") {
    inicializarAplicacao();
  } else {
    document.addEventListener("DOMContentLoaded", inicializarAplicacao, { once: true });
  }
})(globalThis);
