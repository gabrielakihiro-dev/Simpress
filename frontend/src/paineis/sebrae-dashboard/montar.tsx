import { apiFetch } from "../../api";
import { criarDashboardSebrae } from "./estado";
import type { AppSebrae, Registro } from "./tipos";

// Chamado por frontend/src/main.tsx com o contêiner [data-react-painel="sebrae-dashboard"] (fica depois de #sebrae-novos-avisos).
// A tela de "Chamados novos do SoftExpert" continua nos elementos que já estão em static/index.html; este painel só liga
// o comportamento a eles e devolve as ações que o código antigo chama pela ponte (static/js/features/sebrae-dashboard.js).
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
    // Precisam continuar `undefined` quando ausentes: abrirJanelaChamadoOs é chamada com `?.` e a regra de ticket cai num texto padrão.
    get abrirJanelaChamadoOs() { return janela.abrirJanelaChamadoOs; },
    get normalizarFiltroChamados() { return janela.normalizarFiltroChamados; },
  };
  return criarDashboardSebrae({
    app,
    dom: window.SimpressDomUtils(document),
    sebraeDashboardModel: window.SimpressSebraeDashboardModel,
  });
}
