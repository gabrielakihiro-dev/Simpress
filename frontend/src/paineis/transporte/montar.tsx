import { apiFetch } from "../../api";
import { criarFormularioTransferencia, type ContextoTransferencia } from "./estado";

export function montar(_container: HTMLElement) {
  const acoes = criarFormularioTransferencia({
    app: window as unknown as ContextoTransferencia["app"],
    appState: window.SimpressApp.state,
    motion: window.SimpressMotion,
    transferUtils: window.SimpressTransferUtils,
    apiFetch,
    draftTracker: window.SimpressFormDraftGuard.createDraftTracker(),
  });
  return acoes;
}
