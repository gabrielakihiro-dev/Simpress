/**
 * Cockpit Chamados: importação das planilhas, versões, comparação, exclusão de importações antigas e exportação
 * (bloco "Importação e versões"), mais os chamados abertos da Home.
 * Migrado para React no G8: o painel vive em frontend/src/paineis/cockpit-chamados/. Este módulo é a ponte que mantém
 * as ações publicadas em window (frontend/src/aplicacao/app.ts) e guarda as duas que mexem só no DOM e precisam ser síncronas:
 * abrirGestaoChamadosCockpit e abrirChamadoSebraeNoF5.
 */
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export function createCockpitChamados(context: ContextoApp): Acoes {
  const { app } = context;
  const ponte = context.ponteReact("cockpit-chamados", [
    "sincronizarGestaoChamadosCockpit", "selecionarVersaoChamadosCockpit", "excluirImportacoesAntigasChamadosCockpit",
    "exportarChamadosCockpit", "atualizarChamadosAbertosHome",
  ]);
  const registrarErro = (nome: string) => (erro: Qualquer) => { console.error(`${nome}: ${erro?.message}`); };

  // Quem chama (tabela de OS, busca de equipamento, data-on-click) não espera nem trata erro: como no módulo antigo, nunca rejeita.
  function sincronizarGestaoChamadosCockpit(relatorio: Qualquer) {
    return ponte.sincronizarGestaoChamadosCockpit(relatorio).catch(registrarErro("sincronizarGestaoChamadosCockpit"));
  }

  // Sem argumento o painel lê o valor do seletor; só texto vale como valor.
  function selecionarVersaoChamadosCockpit(valor: Qualquer) {
    return ponte.selecionarVersaoChamadosCockpit(typeof valor === "string" ? valor : undefined).catch(registrarErro("selecionarVersaoChamadosCockpit"));
  }

  function excluirImportacoesAntigasChamadosCockpit() {
    return ponte.excluirImportacoesAntigasChamadosCockpit().catch(registrarErro("excluirImportacoesAntigasChamadosCockpit"));
  }

  function exportarChamadosCockpit() {
    return ponte.exportarChamadosCockpit().catch(registrarErro("exportarChamadosCockpit"));
  }

  function atualizarChamadosAbertosHome(serial: Qualquer) {
    return ponte.atualizarChamadosAbertosHome(serial).catch(registrarErro("atualizarChamadosAbertosHome"));
  }

  // Síncrona de propósito: o painel React já está montado (flushSync) e os campos de arquivo existem na hora do foco.
  function abrirGestaoChamadosCockpit() {
    const panel = document.getElementById("cockpit-tickets-manage-panel") as HTMLDetailsElement;
    panel.open = true;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
    document.getElementById("cockpit-tickets-file-simpress")?.focus({ preventScroll: true });
  }

  // Abre a aba Chamados (F5) na sub-aba do chamado (tira o filtro que o esconde, amplia "Carregar mais"), expande a linha e a destaca.
  async function abrirChamadoSebraeNoF5(chave: Qualquer) {
    await app.abrirPainelCockpit?.("sebrae-chamados");
    const alvo: Qualquer = app.mostrarChamadoSebrae?.(chave) || ([...document.querySelectorAll('[data-cockpit-tool-panel="sebrae-chamados"] article[data-numero]')] as Qualquer[])
      .find(artigo => artigo.dataset.numero === String(chave));
    // mostrarChamadoSebrae já abre a linha; espera a animação de todo details em volta, aberto agora ou antes.
    const abertos: Qualquer[] = [];
    for (let pai: Qualquer = alvo?.parentElement?.closest("details"); pai; pai = pai.parentElement?.closest("details")) {
      pai.open = true;
      abertos.push(pai);
    }
    if (abertos.length) {
      // Abrir um details anima a altura do conteúdo (CSS): rolar antes do fim erra o alvo e exigia um segundo clique.
      void alvo.offsetHeight;
      const fim = Promise.all(abertos.flatMap(pai => pai.getAnimations?.({ subtree: true }) || []).map((animacao: Qualquer) => animacao.finished.catch(() => {})));
      await Promise.race([fim, new Promise(resolve => setTimeout(resolve, 800))]);
    }
    // Lista longa: o salto é instantâneo (rolagem suave de milhares de px era interrompida pelo relayout e parava fora do cartão).
    alvo?.scrollIntoView?.({ block: "center", behavior: "auto" });
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    alvo?.scrollIntoView?.({ block: "center", behavior: "auto" });
    app.destacarLinhaCockpit?.(alvo);
  }

  return {
    sincronizarGestaoChamadosCockpit, selecionarVersaoChamadosCockpit, excluirImportacoesAntigasChamadosCockpit,
    exportarChamadosCockpit, abrirGestaoChamadosCockpit, atualizarChamadosAbertosHome, abrirChamadoSebraeNoF5,
  };
}
