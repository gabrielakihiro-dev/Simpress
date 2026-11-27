import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { apiFetch } from "../../api";
import { criarRegrasChamados } from "../regras-chamados/regras";
import { criarDashboardSebrae } from "./estado";
import { ChipsLeitura, type AlvosLeitura } from "./leitura";
import { criarLojaLeitura } from "./leitura-loja";
import { sugestaoOsPainel } from "./sugestao-os";
import type { AppSebrae, Registro } from "./tipos";

// Chamado por frontend/src/main.tsx com o contêiner [data-react-painel="sebrae-dashboard"] (fica depois de #sebrae-novos-avisos).
// A tela de "Chamados novos do SoftExpert" continua nos elementos que já estão em static/index.html; este painel só liga
// o comportamento a eles e devolve as ações que a aplicação chama pela ponte (frontend/src/aplicacao/pontes.ts).
// Os chips da última leitura dos antigos (#sebrae-leitura) são React declarativo (leitura.tsx): preenchem por portal os
// pontos dinâmicos do esqueleto estático do partial.
// Os elementos #sebrae-historico-resumo (painel sebrae-historico) e #sebrae-conflitos (painel sebrae-conflitos) não são tocados aqui.
const IDS_LEITURA: Record<keyof AlvosLeitura, string> = {
  grupo: "sebrae-leitura", hora: "sebrae-leitura-hora", horaTexto: "sebrae-leitura-hora", lidos: "sebrae-leitura-lidos",
  falhas: "sebrae-leitura-falhas", botao: "btn-sebrae-falhas", botaoTexto: "btn-sebrae-falhas", popover: "sebrae-falhas-popover",
  lista: "sebrae-antigos-leitura-falhas", semUtic: "sebrae-leitura-sem-utic",
};

export function montar(container: HTMLElement) {
  const janela = window as unknown as Record<string, any>;
  // Tudo que não é da API é lido de window na hora da chamada (nada é guardado aqui), como o código antigo lia de `app`.
  const app: AppSebrae = {
    apiFetch: (url, opcoes) => apiFetch<Registro>(url, opcoes),
    showToast: (mensagem, tipo) => janela.showToast(mensagem, tipo),
    copiarTextoParaAreaTransferencia: texto => janela.copiarTextoParaAreaTransferencia(texto),
    confirmarAcao: dialogo => janela.confirmarAcao(dialogo),
    atualizarEstadoAutomacao: () => janela.atualizarEstadoAutomacao?.(),
    acompanharExecucaoAutomacao: dados => janela.acompanharExecucaoAutomacao?.(dados),
    carregarResumoHistoricoSebrae: () => janela.carregarResumoHistoricoSebrae?.(),
    carregarConflitosSebrae: () => janela.carregarConflitosSebrae?.(),
    // Precisa continuar `undefined` quando ausente: abrirJanelaChamadoOs é chamada com `?.`.
    get abrirJanelaChamadoOs() { return janela.abrirJanelaChamadoOs; },
    get normalizarFiltroChamados() { return janela.normalizarFiltroChamados; },
  };
  const dom = window.SimpressDomUtils(document);
  const lojaLeitura = criarLojaLeitura();
  const acoes = criarDashboardSebrae({
    app,
    dom,
    // Regras direto do módulo (como cockpit-chamados): o filtro da F5 não depende da ponte de ticket-rules.js.
    ticketRules: criarRegrasChamados(dom),
    sebraeDashboardModel: window.SimpressSebraeDashboardModel,
    // A caixa "OS nova sugerida" é React (sugestao-os.tsx); estado.ts não a importa porque os testes em node o leem sem JSX.
    sugestaoOs: sugestaoOsPainel,
    lojaLeitura,
  });
  // Falha nos chips não derruba o painel: as ações voltam sempre.
  try {
    const alvos = {} as AlvosLeitura;
    for (const [chave, id] of Object.entries(IDS_LEITURA) as [keyof AlvosLeitura, string][]) {
      const alvo = document.getElementById(id);
      if (!alvo) throw new Error(`Falta #${id} no HTML.`);
      // Texto do horário e de "N falhas" vai no <span> interno (o ícone fica ao lado).
      alvos[chave] = chave === "horaTexto" || chave === "botaoTexto" ? alvo.querySelector<HTMLElement>(":scope > span") ?? alvo : alvo;
    }
    // Portais anexam: só os alvos de texto e a lista são esvaziados (no partial já nascem vazios).
    [alvos.horaTexto, alvos.lidos, alvos.botaoTexto, alvos.lista, alvos.semUtic].forEach(alvo => alvo.replaceChildren());
    flushSync(() => { createRoot(container).render(<ChipsLeitura alvos={alvos} loja={lojaLeitura} />); });
  } catch (erro) {
    console.error("Chamados do SoftExpert: os chips da última leitura dos antigos não foram montados.", erro);
  }
  return acoes;
}
