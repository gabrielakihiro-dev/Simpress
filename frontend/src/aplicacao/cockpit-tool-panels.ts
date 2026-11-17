/** Dedicated Cockpit workspaces for the tools in the nine-dot menu: the panels live in frontend/src/paineis/ferramentas-cockpit/; this module only forwards the calls. */
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export function createCockpitToolPanels(context: ContextoApp): Acoes {
  // Chamados, buttons and shortcuts call these in the same turn, so the bridge is synchronous (the panel is mounted before the first user action).
  const ponte = context.ponteReactSincrona("ferramentas-cockpit", [
    "abrirPainelCockpit", "fecharPainelCockpit", "abrirComparacaoDaSerie", "abrirChamadosDoEquipamento", "abrirChamadoDaOs",
    "abrirJanelaChamadoOs", "abrirReferenciaLembrete", "fecharJanelaChamadoOs", "destacarLinhaCockpit", "filterTicketRecords",
    "mostrarResultadoNaAbaComparacao",
  ]);
  // Without the panel the tools that load data would stay empty: show the error where the result would be. Cobertura, Lembretes,
  // Unidades and Chamados (F5) have no error text of their own: the shell opens empty and the bridge logs the error to the console.
  const ERRO_SEM_PAINEL: Record<string, [string, string]> = {
    chamados: ["cockpit-tickets-os", "A tabela de ordens de serviço não está disponível."],
    comparacao: ["comparacao-planilhas-conteudo", "Não foi possível abrir a comparação."],
    apelidos: ["cockpit-alias-list", "Falha ao carregar o histórico."],
    relatorio: ["cockpit-monthly-estado", "Falha ao carregar o relatório."],
    planilhas: ["cockpit-sheets-kpis", "Não foi possível carregar as planilhas."],
  };
  const STATUS_SEM_PAINEL: Record<string, string> = { comparacao: "cockpit-comparison-status", planilhas: "cockpit-sheets-status" };
  // Copy of toolInfo and toolKeys (estado.ts) for the path without the bundle: [title, subtitle, key] of the shell.
  const FERRAMENTAS: Record<string, [string, string, string]> = {
    chamados: ["OS", "Acompanhamento local de ordens relacionadas por série.", "F6"],
    comparacao: ["Resumo", "Ativos por regional (com filtro por categoria) e resultados salvos da comparação entre as bases locais.", "F3"],
    apelidos: ["Histórico de apelidos", "Alterações registradas para equipamentos e usuários.", "F7"],
    relatorio: ["Relatório mensal", "Consolidação do mês usando os dados locais disponíveis.", "F8"],
    cobertura: ["Cobertura", "Necessidades de equipamento, reservas, transporte e devoluções por cidade.", "F10"],
    lembretes: ["Lembretes", "Anote o que precisa fazer; os termos de entrega e devolução ficam nas outras abas.", ""],
    planilhas: ["Atualizar planilhas", "Última atualização das bases locais de equipamentos.", ""],
    unidades: ["Catálogo de unidades", "Unidades Sebrae cadastradas para entrega e retirada.", ""],
    "sebrae-chamados": ["Chamados", "Preencha os chamados novos e antigos, exporte as linhas e atualize o Dashboard.", "F5"],
  };
  const semPainel = () => {
    const raiz: Qualquer = typeof window !== "undefined" ? window : globalThis;
    return !raiz.SimpressReact?.["ferramentas-cockpit"];
  };
  const porId = (id: string) => document.getElementById(id) as HTMLElement;
  // Shell state of the path without the bundle (the panel keeps its own in estado.ts).
  let ativa = "";
  let focoDeRetorno: Qualquer = null;
  let hrefDoSkipLink: string | null = null;
  let abaSuspensa: Qualquer = null;
  let escutandoEsc = false;

  function marcarAba(aba: HTMLElement, selecionada: boolean) {
    aba.setAttribute("aria-selected", String(selecionada));
    aba.tabIndex = selecionada ? 0 : -1;
    aba.classList.toggle("is-active", selecionada);
  }

  // Same as syncPanelButtons in estado.ts: the buttons of the bar follow the open tool; the tab that was active waits until the panel closes.
  function sincronizarBotoes(tool: string) {
    document.querySelectorAll<HTMLElement>(".ck-aba--painel[data-cockpit-tool]").forEach(botao => botao.setAttribute("aria-pressed", String(botao.dataset.cockpitTool === tool)));
    const abas = [...document.querySelectorAll<HTMLElement>('[role="tab"][data-cockpit-tool]')];
    const aberta = abas.find(aba => aba.dataset.cockpitTool === tool);
    if (!aberta && abaSuspensa) {
      marcarAba(abaSuspensa, true);
      abaSuspensa = null;
    } else if (aberta && !abaSuspensa) {
      abaSuspensa = document.querySelector('#ck-abas [role="tab"][aria-selected="true"]:not([data-cockpit-tool])');
      if (abaSuspensa) marcarAba(abaSuspensa, false);
    }
    abas.forEach(aba => marcarAba(aba, aba === aberta));
  }

  // Only the shell of openPanel in estado.ts (title, key, subtitle, focus, buttons, skip link) and no loader of this panel; the one call out is to the Resumo card's own bridge below.
  function abrirSemPainel(tool: string): Promise<void> {
    if (typeof document === "undefined" || !Object.hasOwn(FERRAMENTAS, tool)) return Promise.resolve();
    const raiz = porId("cockpit-tool-panels");
    if (!raiz) return Promise.resolve();
    const [titulo, subtitulo, tecla] = FERRAMENTAS[tool];
    const menu = porId("cockpit-tools-dropdown") as HTMLDetailsElement;
    const skipLink = document.querySelector(".skip-link");
    if (!escutandoEsc) {
      // Same rule as the keydown in ensureEvents (estado.ts): the label "Esc" on the Voltar button must work without the bundle too.
      document.addEventListener("keydown", evento => {
        if (evento.key !== "Escape" || evento.defaultPrevented || !ativa || document.querySelector('[data-accessible-modal="true"]:not(.hidden)')) return;
        evento.preventDefault();
        fecharSemPainel();
      });
      escutandoEsc = true;
    }
    if (!ativa) focoDeRetorno = document.activeElement?.closest?.(".ck-aba--painel, [data-cockpit-tool]") || porId("cockpit-tools-trigger") || document.activeElement;
    ativa = tool;
    menu.dataset.activeTool = tool;
    menu.open = false;
    sincronizarBotoes(tool);
    porId("main-content").hidden = true;
    if (skipLink) {
      hrefDoSkipLink ??= skipLink.getAttribute("href") || "#main-content";
      skipLink.setAttribute("href", "#cockpit-tool-title");
    }
    raiz.hidden = false;
    raiz.scrollTop = 0;
    porId("cockpit-tool-title").textContent = titulo;
    porId("cockpit-tool-kbd").textContent = tecla;
    porId("cockpit-tool-kbd").hidden = !tecla;
    porId("cockpit-tool-subtitle").textContent = subtitulo;
    document.querySelectorAll<HTMLElement>("[data-cockpit-tool-panel]").forEach(painel => { painel.hidden = painel.dataset.cockpitToolPanel !== tool; });
    porId("cockpit-tool-title").focus();
    const alvo = Object.hasOwn(ERRO_SEM_PAINEL, tool) ? porId(ERRO_SEM_PAINEL[tool][0]) : null;
    if (alvo) {
      // Same markup as renderError in the panel's estado.ts.
      const nota = document.createElement("p");
      nota.className = "ck-nota ck-nota--erro";
      nota.textContent = ERRO_SEM_PAINEL[tool][1];
      alvo.replaceChildren(nota);
      // Same state attribute as comparison-result.js, which the Resumo card is waiting for.
      if (tool === "comparacao") alvo.dataset.estado = "erro";
    }
    // The Resumo card has its own bridge (resumo-ativos.js), which logs its own failure; openPanel always called it.
    if (tool === "comparacao") context.app?.carregarResumoAtivos?.();
    // The status line of Resumo and Planilhas still says "Carregando…"; the error replaces it.
    const status = porId(STATUS_SEM_PAINEL[tool] ?? "");
    if (status) status.textContent = "";
    return Promise.resolve();
  }

  // Same as closePanel in estado.ts, except that the Voltar button does not reopen a previous tool.
  function fecharSemPainel(restaurarFoco = true) {
    if (typeof document === "undefined") return;
    sincronizarBotoes("");
    const raiz = porId("cockpit-tool-panels");
    if (!raiz || raiz.hidden) return;
    const principal = porId("main-content");
    const menu = porId("cockpit-tools-dropdown") as HTMLDetailsElement;
    const skipLink = document.querySelector(".skip-link");
    raiz.hidden = true;
    principal.hidden = false;
    menu.open = false;
    delete menu.dataset.activeTool;
    ativa = "";
    if (restaurarFoco && focoDeRetorno?.isConnected) focoDeRetorno.focus();
    else if (restaurarFoco) principal.focus();
    focoDeRetorno = null;
    if (skipLink && hrefDoSkipLink !== null) skipLink.setAttribute("href", hrefDoSkipLink);
    hrefDoSkipLink = null;
  }

  return {
    ...ponte,
    // abrirPainelCockpit always returns a Promise in the panel; undefined means the panel did not mount.
    abrirPainelCockpit: (...argumentos: Qualquer[]) => ponte.abrirPainelCockpit(...argumentos) ?? abrirSemPainel(argumentos[0]),
    // fecharPainelCockpit may return undefined with the panel mounted, so the missing panel is read from SimpressReact.
    fecharPainelCockpit: (...argumentos: Qualquer[]) => {
      const retorno = ponte.fecharPainelCockpit(...argumentos);
      if (semPainel()) fecharSemPainel(argumentos[0] !== false);
      return retorno;
    },
    filterTicketRecords: (...argumentos: Qualquer[]) => ponte.filterTicketRecords(...argumentos) ?? [],
  };
}
