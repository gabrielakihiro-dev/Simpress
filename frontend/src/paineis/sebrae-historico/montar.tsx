import { createRoot } from "react-dom/client";
import { ResumoHistorico } from "./resumo";
import { carregarResumoHistoricoSebrae } from "./estado";

// Chamado por frontend/src/main.tsx com #sebrae-historico-resumo (data-react-painel="sebrae-historico").
// carregarResumoHistoricoSebrae é chamado pela aplicação ao carregar os chamados novos (sebrae-dashboard.js), pela ponte.
export function montar(container: HTMLElement) {
  createRoot(container).render(<ResumoHistorico />);
  return { carregarResumoHistoricoSebrae };
}
