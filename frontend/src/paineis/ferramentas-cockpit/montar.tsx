import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { apiFetch } from "../../api";
import { criarFerramentasCockpit } from "./estado";
import { PainelPlanilhas, type AlvosPlanilhas } from "./planilhas";
import { criarLojaPlanilhas } from "./planilhas-loja";
import type { ContextoFerramentasCockpit } from "./tipos";

// Ferramentas do Cockpit (OS, Resumo, Histórico de apelidos, Relatório mensal, Planilhas e janela Chamado × OS):
// o HTML continua em frontend/partials; este painel liga os painéis, os filtros e os eventos simpress:*, e devolve as
// ações que frontend/src/aplicacao/cockpit-tool-panels.ts encaminha pela ponte. A sub-aba Planilhas é React
// declarativo (planilhas.tsx): preenche por portal os pontos dinâmicos do esqueleto estático do partial.
// O contexto é lido de window na hora de montar, como frontend/src/aplicacao/app.ts monta o contexto das features.
const IDS_PLANILHAS: Record<keyof AlvosPlanilhas, string> = {
  status: "cockpit-sheets-status", kpis: "cockpit-sheets-kpis", corpo: "cockpit-sheets-list-body",
  titulo: "cockpit-sheets-detail-title", sub: "cockpit-sheets-detail-sub", selo: "cockpit-sheets-detail-badge",
};

export function montar(container: HTMLElement) {
  const loja = criarLojaPlanilhas();
  const app = window as unknown as ContextoFerramentasCockpit["app"];
  const acoes = criarFerramentasCockpit({
    app,
    appState: window.SimpressApp?.state,
    apiFetch,
    historyFormat: window.SimpressHistoryFormat,
    lojaPlanilhas: loja,
  });
  // Falha na Planilhas não derruba as outras ferramentas: as ações voltam sempre.
  try {
    const alvos = {} as AlvosPlanilhas;
    for (const [chave, id] of Object.entries(IDS_PLANILHAS) as [keyof AlvosPlanilhas, string][]) {
      const alvo = document.getElementById(id);
      if (!alvo) throw new Error(`Falta #${id} no HTML.`);
      alvos[chave] = alvo;
    }
    // Só limpa depois de achar os 6 alvos; portais anexam, e o estado inicial da loja reproduz o texto estático.
    Object.values(alvos).forEach(alvo => alvo.replaceChildren());
    flushSync(() => { createRoot(container).render(<PainelPlanilhas alvos={alvos} loja={loja} />); });
  } catch (erro) {
    console.error("Ferramentas do Cockpit: a sub-aba Planilhas não foi montada.", erro);
  }
  return acoes;
}
