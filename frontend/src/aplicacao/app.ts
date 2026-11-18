/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Arranque: monta o contexto compartilhado, cria os módulos de feature de frontend/src/aplicacao/registro.ts,
 * publica as ações no escopo da página e inicia a página quando o DOM estiver pronto.
 *
 * As ações ficam em window porque os atributos data-on-* (frontend/src/ui/action-dispatcher.ts, que roda só as
 * ações das features registradas abaixo), os fechamentos de diálogo (frontend/src/ui/accessible-dialogs.ts) e
 * os scripts de melhoria as resolvem ali. As features chamam umas às outras por `app` também, então uma ação
 * substituída em window (testes, melhorias) vale em todo lugar.
 *
 * `iniciar(app)` roda uma vez por carga da página (frontend/src/arranque/iniciar-aplicacao.ts); não há estado no topo do módulo,
 * para os testes poderem iniciar de novo com outro `window` falso sem recarregar o arquivo.
 */
import { fabricas } from "./registro.ts";
import { createTicketRules } from "./ticket-rules.ts";

type Qualquer = any;

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

export function iniciar(app: Qualquer = globalThis): void {
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
  const context: Qualquer = {
    app,
    appState,
    dom: domUtils,
    apiErrors: window.SimpressApiErrors,
    apiFetch: window.SimpressApiFetch.apiFetch,
    equipmentSearchRenderer: window.SimpressEquipmentSearchRenderers,
    historyFormat: window.SimpressHistoryFormat,
    sebraeDashboardModel: window.SimpressSebraeDashboardModel,
    ticketRules: createTicketRules(),
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
  // react-entry.js runs this file first and then publishes each panel's actions in window.SimpressReact, so the
  // panel's old feature module stays in FEATURE_ORDER as a bridge: ponteReact(panel, names) returns async
  // forwarders that wait for that registry. Nothing waits until the first call; if react-entry.js never
  // loads (its script fires "error", or window "load" with no registry) or the panel failed to mount, every call rejects.
  // On-demand panels (frontend/src/paineis.ts) are not in that registry: window.SimpressReactSobDemanda[panel]()
  // downloads and mounts them on the first call.
  const scriptReact = document.querySelector('script[src*="/static/dist/react-entry.js"]');
  let bundleFalhou = false;
  scriptReact?.addEventListener("error", () => { bundleFalhou = true; }, { once: true });
  const reactPanels = new Map<string, Promise<Qualquer>>();
  // Painel sob demanda (frontend/src/paineis.ts): o primeiro pedido baixa e monta; main.tsx guarda a montagem e, se o
  // download falhar, a próxima chamada tenta de novo (por isso não fica em reactPanels).
  const loadOnDemand = (load: () => Promise<Qualquer>, panel: string) => load().catch(() => {
    throw new Error(`O painel React "${panel}" não carregou.`);
  });
  function waitForReactPanel(panel: string): Promise<Qualquer> {
    const load = window.SimpressReactSobDemanda?.[panel];
    if (load) return loadOnDemand(load, panel);
    if (!reactPanels.has(panel)) {
      reactPanels.set(panel, new Promise((resolve, reject) => {
        const settle = () => {
          if (!window.SimpressReact && !bundleFalhou && document.readyState !== "complete") return false;
          const actions = window.SimpressReact?.[panel];
          const loadLater = window.SimpressReactSobDemanda?.[panel];
          if (actions) resolve(actions);
          else if (loadLater) resolve(loadOnDemand(loadLater, panel));
          else reject(new Error(`O painel React "${panel}" não carregou.`));
          return true;
        };
        if (settle()) return;
        document.addEventListener("simpress:react-pronto", settle, { once: true });
        window.addEventListener("load", settle, { once: true });
        scriptReact?.addEventListener("error", settle, { once: true });
      }));
    }
    return reactPanels.get(panel) as Promise<Qualquer>;
  }
  context.ponteReact = (panel: string, names: string[]) => Object.fromEntries(names.map(name => [
    name,
    (...args: Qualquer[]) => waitForReactPanel(panel).then(actions => actions[name](...args)),
  ]));
  // Ações chamadas no mesmo turno pelo código legado não podem esperar pelo boot do React.
  context.ponteReactSincrona = (panel: string, names: string[]) => Object.fromEntries(names.map(name => [
    name,
    (...args: Qualquer[]) => {
      const action = window.SimpressReact?.[panel]?.[name];
      if (typeof action !== "function") {
        console.error(new Error(`O painel React "${panel}" não carregou.`));
        return;
      }
      return action(...args);
    },
  ]));

  const publishedBy = new Map<string, string>();
  function publish(actions: Record<string, Qualquer>, source: string): void {
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
    const createFeature = fabricas[name];
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

  function inicializarAplicacao(): void {
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
    // Nova importação de OS (F6 ou rotina de OS): o F5 recalcula a OS sugerida dos chamados com o relatório novo.
    document.addEventListener("simpress:chamados-atualizados", () => app.carregarNovosSebrae());
  }

  if (document.readyState === "interactive" || document.readyState === "complete") {
    inicializarAplicacao();
  } else {
    document.addEventListener("DOMContentLoaded", inicializarAplicacao, { once: true });
  }
}
