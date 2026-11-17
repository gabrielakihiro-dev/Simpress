import { apiFetch } from "../../api";
import { criarFerramentasCockpit } from "./estado";
import type { ContextoFerramentasCockpit } from "./tipos";

// Ferramentas do Cockpit (OS, Resumo, Histórico de apelidos, Relatório mensal, Planilhas e janela Chamado × OS):
// o HTML continua em static/index.html (ids, ARIA e data-* intactos); este painel liga os painéis, os filtros e os
// eventos simpress:*, e devolve as ações que static/js/features/cockpit-tool-panels.js encaminha pela ponte.
// O contexto é lido de window na hora de montar, como o app.js monta o contexto dos módulos antigos.
export function montar(_container: HTMLElement) {
  const app = window as unknown as ContextoFerramentasCockpit["app"];
  return criarFerramentasCockpit({
    app,
    appState: window.SimpressApp?.state,
    apiFetch,
    historyFormat: window.SimpressHistoryFormat,
    chamadosOsModel: window.SimpressChamadosOsModel,
  });
}
