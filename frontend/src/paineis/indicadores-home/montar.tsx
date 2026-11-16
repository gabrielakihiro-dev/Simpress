import { apiFetch } from "../../api";
import { criarIndicadoresHome, type ContextoIndicadoresHome } from "./estado";

// Indicadores da Home: o HTML continua em static/index.html (ids, ARIA e data-* intactos); este painel só
// liga os comportamentos e devolve as ações que static/js/features/dashboard.js encaminha pela ponte.
export function montar(_container: HTMLElement) {
  return criarIndicadoresHome({
    app: window as unknown as ContextoIndicadoresHome["app"],
    transferUtils: window.SimpressTransferUtils,
    motion: window.SimpressMotion,
    dom: window.SimpressDomUtils(document),
    apiFetch,
  });
}
