import { apiFetch } from "../../api";
import { criarResultadoComparacao, type ContextoResultadoComparacao } from "./estado";

// Resultado da aba Comparação: o HTML continua em static/index.html (ids, ARIA e data-* intactos); este painel
// liga renderização, filtros, abas do Resumo e anotações, e devolve as ações que
// frontend/src/aplicacao/comparison-result.ts encaminha pela ponte.
export function montar(_container: HTMLElement) {
  const app = window as unknown as ContextoResultadoComparacao["app"];
  const appState = window.SimpressApp.state as ContextoResultadoComparacao["appState"];
  const dom = window.SimpressDomUtils(document);
  const contexto = { app, appState, dom };
  return criarResultadoComparacao({
    app,
    appState,
    motion: window.SimpressMotion,
    dom,
    historyFormat: window.SimpressHistoryFormat,
    loggedUserMarkers: window.SimpressLoggedUserMarkers(contexto),
    // O autosave é lido no momento do uso, como no módulo antigo.
    annotationAutosave: {
      attachAnnotationAutosave: opcoes => window.HistoryAnnotationAutosave.attachAnnotationAutosave(opcoes),
    },
    apiFetch,
  });
}
