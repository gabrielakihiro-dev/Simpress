import { apiFetch } from "../../api";
import { criarPesquisaEquipamento, type ContextoPesquisaEquipamento } from "./estado";

export function montar(_container: HTMLElement) {
  const app = window as unknown as ContextoPesquisaEquipamento["app"];
  const appState = window.SimpressApp.state as ContextoPesquisaEquipamento["appState"];
  const acoes = criarPesquisaEquipamento({
    app,
    appState,
    motion: window.SimpressMotion,
    transferUtils: window.SimpressTransferUtils,
    recentEquipment: window.SimpressRecentEquipment,
    dom: window.SimpressDomUtils(document),
    equipmentSearchRenderer: window.SimpressEquipmentSearchRenderers,
    apiFetch,
  });
  document.getElementById("input-serial")?.addEventListener("input", () => {
    appState.equipamentoSelectionRevision += 1;
  });
  acoes.inicializarListaHome();
  return acoes;
}
