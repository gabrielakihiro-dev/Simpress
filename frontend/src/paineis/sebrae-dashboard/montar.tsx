import { apiFetch } from "../../api";
import { criarRegrasChamados } from "../regras-chamados/regras";
import { criarDashboardSebrae } from "./estado";
import type { AppSebrae, Registro } from "./tipos";

// Chamado por frontend/src/main.tsx com o contêiner [data-react-painel="sebrae-dashboard"] (fica depois de #sebrae-novos-avisos).
// A tela de "Chamados novos do SoftExpert" continua nos elementos que já estão em static/index.html; este painel só liga
// o comportamento a eles e devolve as ações que o código antigo chama pela ponte (frontend/src/aplicacao/pontes.ts).
// Os elementos #sebrae-historico-resumo (painel sebrae-historico) e #sebrae-conflitos (painel sebrae-conflitos) não são tocados aqui.
export function montar(_container: HTMLElement) {
  const janela = window as unknown as Record<string, any>;
  // Tudo que não é da API é lido de window na hora da chamada (nada é guardado aqui), como o código antigo lia de `app`.
  const app: AppSebrae = {
    apiFetch: (url, opcoes) => apiFetch<Registro>(url, opcoes),
    showToast: (mensagem, tipo) => janela.showToast(mensagem, tipo),
    confirmarAcao: dialogo => janela.confirmarAcao(dialogo),
    atualizarEstadoAutomacao: () => janela.atualizarEstadoAutomacao?.(),
    carregarResumoHistoricoSebrae: () => janela.carregarResumoHistoricoSebrae?.(),
    carregarConflitosSebrae: () => janela.carregarConflitosSebrae?.(),
    // Precisa continuar `undefined` quando ausente: abrirJanelaChamadoOs é chamada com `?.`.
    get abrirJanelaChamadoOs() { return janela.abrirJanelaChamadoOs; },
    get normalizarFiltroChamados() { return janela.normalizarFiltroChamados; },
  };
  const dom = window.SimpressDomUtils(document);
  return criarDashboardSebrae({
    app,
    dom,
    // Regras direto do módulo (como cockpit-chamados): o filtro da F5 não depende da ponte de ticket-rules.js.
    ticketRules: criarRegrasChamados(dom),
    sebraeDashboardModel: window.SimpressSebraeDashboardModel,
  });
}
