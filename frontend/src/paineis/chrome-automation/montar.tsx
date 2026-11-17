import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  abrirLogExecucaoAutomacao, acompanharExecucaoAutomacao, atualizarEstadoAutomacao, cancelarRotinaAutomacao, carregarExecucoesLogAutomacao,
  carregarHistoricoAutomacao, filtrarHistoricoAutomacao, inicializarAutomacao, iniciarRotinaAutomacao, limparFiltrosAutomacao,
  mudarPaginaHistoricoAutomacao, mudarPaginaLogAutomacao, selecionarLogAutomacao, voltarAoVivoAutomacao, alterarLimiteLogAutomacao,
} from "./acoes";
import { alterarAgendamentoDashboard, carregarAgendamentoDashboard } from "./agendamento";
import { Aviso, Chrome, Console, DialogoLog, Historico, Rotinas } from "./componentes";

const REGIOES: Record<string, (host: HTMLElement) => ReactNode> = {
  aviso: host => <Aviso host={host} />,
  chrome: () => <Chrome />,
  rotinas: () => <Rotinas />,
  historico: () => <Historico />,
  console: () => <Console />,
  dialogo: () => <DialogoLog />,
};

// Chamado por frontend/src/main.tsx com o primeiro host (#automacao-aviso-login, data-react-painel="chrome-automation").
// A aba tem seis raízes, uma por <section> com data-automacao-regiao, porque o cartão Sebrae entre elas é HTML estático.
// O código antigo chama as ações pela ponte (frontend/src/aplicacao/pontes.ts).
export function montar(_container: HTMLElement) {
  document.querySelectorAll<HTMLElement>("[data-automacao-regiao]").forEach(host => {
    const desenhar = REGIOES[host.dataset.automacaoRegiao || ""];
    if (desenhar) createRoot(host).render(desenhar(host));
  });
  return {
    inicializarAutomacao, alterarAgendamentoDashboard, carregarAgendamentoDashboard, iniciarRotinaAutomacao, acompanharExecucaoAutomacao,
    cancelarRotinaAutomacao, atualizarEstadoAutomacao, carregarHistoricoAutomacao, filtrarHistoricoAutomacao, limparFiltrosAutomacao,
    mudarPaginaHistoricoAutomacao, carregarExecucoesLogAutomacao, mudarPaginaLogAutomacao, selecionarLogAutomacao, abrirLogExecucaoAutomacao,
    voltarAoVivoAutomacao, alterarLimiteLogAutomacao,
  };
}
