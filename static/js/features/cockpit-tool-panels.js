/** Dedicated Cockpit workspaces for the tools in the nine-dot menu: the panels live in frontend/src/paineis/ferramentas-cockpit/; this module only forwards the calls. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).cockpitToolPanels = factory;
})(typeof window !== "undefined" ? window : globalThis, function createCockpitToolPanels(context) {
  "use strict";
  // Chamados, buttons and shortcuts call these in the same turn, so the bridge is synchronous (the panel is mounted before the first user action).
  const ponte = context.ponteReactSincrona("ferramentas-cockpit", [
    "abrirPainelCockpit", "fecharPainelCockpit", "abrirComparacaoDaSerie", "abrirChamadosDoEquipamento", "abrirChamadoDaOs",
    "abrirJanelaChamadoOs", "abrirReferenciaLembrete", "fecharJanelaChamadoOs", "destacarLinhaCockpit", "filterTicketRecords",
    "mostrarResultadoNaAbaComparacao",
  ]);
  // Without the panel the tools that load data would stay empty: show the error where the result would be. Cobertura, Lembretes,
  // Unidades and Chamados (F5) have no error text of their own, so for them the error only goes to the console (the bridge logs it).
  const ERRO_SEM_PAINEL = {
    chamados: ["cockpit-tickets-os", "A tabela de ordens de serviço não está disponível."],
    comparacao: ["comparacao-planilhas-conteudo", "Não foi possível abrir a comparação."],
    apelidos: ["cockpit-alias-list", "Falha ao carregar o histórico."],
    relatorio: ["cockpit-monthly-estado", "Falha ao carregar o relatório."],
    planilhas: ["cockpit-sheets-kpis", "Não foi possível carregar as planilhas."],
  };
  const semPainel = () => !(typeof window !== "undefined" ? window : globalThis).SimpressReact?.["ferramentas-cockpit"];

  function abrirSemPainel(tool) {
    if (typeof document === "undefined" || !Object.hasOwn(ERRO_SEM_PAINEL, tool)) return Promise.resolve();
    const [alvoId, mensagem] = ERRO_SEM_PAINEL[tool];
    const raiz = document.getElementById("cockpit-tool-panels");
    const alvo = document.getElementById(alvoId);
    if (!raiz || !alvo) return Promise.resolve();
    document.querySelectorAll("[data-cockpit-tool-panel]").forEach(painel => { painel.hidden = painel.dataset.cockpitToolPanel !== tool; });
    const principal = document.getElementById("main-content");
    if (principal) principal.hidden = true;
    raiz.hidden = false;
    // Same markup as renderError in the panel's estado.ts.
    const nota = document.createElement("p");
    nota.className = "ck-nota ck-nota--erro";
    nota.textContent = mensagem;
    alvo.replaceChildren(nota);
    // The sheets status line still says "Carregando…"; the error replaces it.
    if (tool === "planilhas") document.getElementById("cockpit-sheets-status").textContent = "";
    return Promise.resolve();
  }

  function fecharSemPainel() {
    if (typeof document === "undefined") return;
    const raiz = document.getElementById("cockpit-tool-panels");
    const principal = document.getElementById("main-content");
    if (raiz) raiz.hidden = true;
    if (principal) principal.hidden = false;
  }

  return {
    ...ponte,
    // abrirPainelCockpit always returns a Promise in the panel; undefined means the panel did not mount.
    abrirPainelCockpit: (...argumentos) => ponte.abrirPainelCockpit(...argumentos) ?? abrirSemPainel(argumentos[0]),
    // fecharPainelCockpit may return undefined with the panel mounted, so the missing panel is read from SimpressReact.
    fecharPainelCockpit: (...argumentos) => {
      const retorno = ponte.fecharPainelCockpit(...argumentos);
      if (semPainel()) fecharSemPainel();
      return retorno;
    },
    filterTicketRecords: (...argumentos) => ponte.filterTicketRecords(...argumentos) ?? [],
  };
});
