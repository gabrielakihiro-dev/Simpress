import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { apiFetch } from "../../api";
import { criarRegrasChamados } from "../regras-chamados/regras";
import { criarDashboardSebrae } from "./estado";
import { ChipsLeitura, type AlvosLeitura } from "./leitura";
import { criarLojaLeitura } from "./leitura-loja";
import { AvisosNovos, Rascunho, type AlvosRascunho } from "./avisos-rascunho";
import { ContagensAbas, type AlvosAbas } from "./abas";
import { ResultadoFechar, type AlvosFechar } from "./fechar";
import { AvisosDestaques, type AlvosDestaques } from "./destaques";
import { criarLojaAbas, criarLojaAvisos, criarLojaDestaques, criarLojaFechar, criarLojaRascunho } from "./lojas";
import { sugestaoOsPainel } from "./sugestao-os";
import type { AppSebrae, Registro } from "./tipos";

// Chamado por frontend/src/main.tsx com o contêiner [data-react-painel="sebrae-dashboard"] (fica depois de #sebrae-novos-avisos).
// A tela de "Chamados novos do SoftExpert" continua nos elementos que já estão em static/index.html; este painel só liga
// o comportamento a eles e devolve as ações que a aplicação chama pela ponte (frontend/src/aplicacao/pontes.ts).
// Os chips da última leitura dos antigos (#sebrae-leitura, leitura.tsx), os avisos dos novos (#sebrae-novos-avisos) e o
// rascunho (#sebrae-rascunho, avisos-rascunho.tsx), as contagens das sub-abas com o resultado do filtro (abas.tsx) e o
// resultado do Atualizar/Fechar (#sebrae-fechar, fechar.tsx) e os avisos dos destaques (destaques.tsx) são React declarativo: preenchem por portal os pontos dinâmicos do partial.
// Os elementos #sebrae-historico-resumo (painel sebrae-historico) e #sebrae-conflitos (painel sebrae-conflitos) não são tocados aqui.
const IDS_LEITURA: Record<keyof AlvosLeitura, string> = {
  grupo: "sebrae-leitura", hora: "sebrae-leitura-hora", horaTexto: "sebrae-leitura-hora", lidos: "sebrae-leitura-lidos",
  falhas: "sebrae-leitura-falhas", botao: "btn-sebrae-falhas", botaoTexto: "btn-sebrae-falhas", popover: "sebrae-falhas-popover",
  lista: "sebrae-antigos-leitura-falhas", semUtic: "sebrae-leitura-sem-utic",
};
const IDS_RASCUNHO: Record<keyof AlvosRascunho, string> = {
  bloco: "sebrae-rascunho", status: "sebrae-rascunho-status", caixa: "sebrae-rascunho-detalhes", resumo: "sebrae-rascunho-resumo", itens: "sebrae-rascunho-itens",
};

function exigir(id: string) {
  const alvo = document.getElementById(id);
  if (!alvo) throw new Error(`Falta #${id} no HTML.`);
  return alvo;
}

export function montar(_container: HTMLElement) {
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
  const lojaAvisos = criarLojaAvisos();
  const lojaRascunho = criarLojaRascunho();
  const lojaAbas = criarLojaAbas();
  const lojaFechar = criarLojaFechar();
  const lojaDestaques = criarLojaDestaques();
  const acoes = criarDashboardSebrae({
    app,
    dom,
    // Regras direto do módulo (como cockpit-chamados): o filtro da F5 não depende da ponte de ticket-rules.js.
    ticketRules: criarRegrasChamados(dom),
    sebraeDashboardModel: window.SimpressSebraeDashboardModel,
    // A caixa "OS nova sugerida" é React (sugestao-os.tsx); estado.ts não a importa porque os testes em node o leem sem JSX.
    sugestaoOs: sugestaoOsPainel,
    lojaLeitura,
    lojaAvisos,
    lojaRascunho,
    lojaAbas,
    lojaFechar,
    lojaDestaques,
  });
  // Cada parte tem a sua raiz (num div solto: o conteúdo vai por portal), então erro ao montar ou ao desenhar uma não
  // derruba as outras nem o painel: as ações voltam sempre. Portais anexam: cada parte esvazia os seus alvos de texto antes.
  const montarParte = (nome: string, criar: () => ReactNode) => {
    try {
      const filho = criar();
      flushSync(() => { createRoot(document.createElement("div")).render(filho); });
    } catch (erro) {
      console.error(`Chamados do SoftExpert: falha ao montar ${nome}.`, erro);
    }
  };
  montarParte("os chips da última leitura dos antigos", () => {
    const alvos = {} as AlvosLeitura;
    for (const [chave, id] of Object.entries(IDS_LEITURA) as [keyof AlvosLeitura, string][]) {
      const alvo = exigir(id);
      // Texto do horário e de "N falhas" vai no <span> interno (o ícone fica ao lado).
      alvos[chave] = chave === "horaTexto" || chave === "botaoTexto" ? alvo.querySelector<HTMLElement>(":scope > span") ?? alvo : alvo;
    }
    [alvos.horaTexto, alvos.lidos, alvos.botaoTexto, alvos.lista, alvos.semUtic].forEach(alvo => alvo.replaceChildren());
    return <ChipsLeitura alvos={alvos} loja={lojaLeitura} />;
  });
  montarParte("os avisos dos novos", () => {
    const alvo = exigir("sebrae-novos-avisos");
    alvo.replaceChildren();
    return <AvisosNovos alvo={alvo} loja={lojaAvisos} />;
  });
  montarParte("o rascunho", () => {
    const alvos = Object.fromEntries(Object.entries(IDS_RASCUNHO).map(([chave, id]) => [chave, exigir(id)])) as unknown as AlvosRascunho;
    [alvos.status, alvos.resumo, alvos.itens].forEach(alvo => alvo.replaceChildren());
    return <Rascunho alvos={alvos} loja={lojaRascunho} />;
  });
  montarParte("as contagens das sub-abas", () => {
    const abas = Object.fromEntries(["novos", "antigos", "destaques", "finalizados"].map(aba => [aba, { botao: exigir(`sebrae-aba-${aba}`), contagem: exigir(`sebrae-${aba}-contagem`) }]));
    const alvos: AlvosAbas = { abas, resultado: exigir("sebrae-filtro-resultado") };
    [...Object.values(abas).map(({ contagem }) => contagem), alvos.resultado].forEach(alvo => alvo.replaceChildren());
    return <ContagensAbas alvos={alvos} loja={lojaAbas} />;
  });
  montarParte("o resultado do Atualizar/Fechar", () => {
    const alvos: AlvosFechar = { bloco: exigir("sebrae-fechar"), status: exigir("sebrae-fechar-status"), lista: exigir("sebrae-fechar-lista") };
    [alvos.status, alvos.lista].forEach(alvo => alvo.replaceChildren());
    return <ResultadoFechar alvos={alvos} loja={lojaFechar} />;
  });
  montarParte("os avisos dos destaques", () => {
    const alvos: AlvosDestaques = { anuncio: exigir("sebrae-destaque-anuncio"), resumo: exigir("sebrae-destaques-resumo") };
    [alvos.anuncio, alvos.resumo].forEach(alvo => alvo.replaceChildren());
    return <AvisosDestaques alvos={alvos} loja={lojaDestaques} />;
  });
  return acoes;
}
