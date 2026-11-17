/**
 * Aba Automação: inicia as rotinas do Chrome e mostra estado, log ao vivo e histórico (docs/operacao/automacao-chrome.md).
 * Migrado para React no Dia 3 (G7): a aba vive em frontend/src/paineis/chrome-automation/.
 * Este módulo é só a ponte que mantém as ações publicadas para o código antigo (data-on-*, app.js, inventory-upload.js).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).chromeAutomation = factory;
})(typeof window !== "undefined" ? window : globalThis, function createChromeAutomation(context) {
  "use strict";
  const ponte = context.ponteReact("chrome-automation", [
    "inicializarAutomacao", "alterarAgendamentoDashboard", "carregarAgendamentoDashboard", "iniciarRotinaAutomacao",
    "acompanharExecucaoAutomacao", "cancelarRotinaAutomacao", "atualizarEstadoAutomacao", "carregarHistoricoAutomacao",
    "filtrarHistoricoAutomacao", "limparFiltrosAutomacao", "mudarPaginaHistoricoAutomacao", "carregarExecucoesLogAutomacao",
    "mudarPaginaLogAutomacao", "selecionarLogAutomacao", "abrirLogExecucaoAutomacao", "voltarAoVivoAutomacao",
    "alterarLimiteLogAutomacao",
  ]);

  // Quem chama (data-on-*, app.js, inventory-upload.js) não trata erro: como no módulo antigo, nunca rejeita.
  const semRejeitar = nome => (...args) => ponte[nome](...args).catch(erro => { console.error(`${nome}: ${erro?.message}`); });

  return {
    inicializarAutomacao: semRejeitar("inicializarAutomacao"),
    alterarAgendamentoDashboard: semRejeitar("alterarAgendamentoDashboard"),
    carregarAgendamentoDashboard: semRejeitar("carregarAgendamentoDashboard"),
    iniciarRotinaAutomacao: semRejeitar("iniciarRotinaAutomacao"),
    acompanharExecucaoAutomacao: semRejeitar("acompanharExecucaoAutomacao"),
    cancelarRotinaAutomacao: semRejeitar("cancelarRotinaAutomacao"),
    atualizarEstadoAutomacao: semRejeitar("atualizarEstadoAutomacao"),
    carregarHistoricoAutomacao: semRejeitar("carregarHistoricoAutomacao"),
    filtrarHistoricoAutomacao: semRejeitar("filtrarHistoricoAutomacao"),
    limparFiltrosAutomacao: semRejeitar("limparFiltrosAutomacao"),
    mudarPaginaHistoricoAutomacao: semRejeitar("mudarPaginaHistoricoAutomacao"),
    carregarExecucoesLogAutomacao: semRejeitar("carregarExecucoesLogAutomacao"),
    mudarPaginaLogAutomacao: semRejeitar("mudarPaginaLogAutomacao"),
    selecionarLogAutomacao: semRejeitar("selecionarLogAutomacao"),
    abrirLogExecucaoAutomacao: semRejeitar("abrirLogExecucaoAutomacao"),
    voltarAoVivoAutomacao: semRejeitar("voltarAoVivoAutomacao"),
    alterarLimiteLogAutomacao: semRejeitar("alterarLimiteLogAutomacao"),
  };
});
