/**
 * Automação → resumo das últimas entradas do histórico do Dashboard Sebrae (mini-lista no cartão).
 * Migrado para React no G1 (Sebrae): a lista vive em frontend/src/paineis/sebrae-historico/.
 * Este módulo é só a ponte que mantém a ação carregarResumoHistoricoSebrae publicada para o código antigo.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).sebraeHistorico = factory;
})(typeof window !== "undefined" ? window : globalThis, function createSebraeHistorico(context) {
  "use strict";
  const ponte = context.ponteReact("sebrae-historico", ["carregarResumoHistoricoSebrae"]);

  // sebrae-dashboard.js chama sem esperar nem tratar erro: como no resumo antigo, nunca rejeita.
  function carregarResumoHistoricoSebrae() {
    return ponte.carregarResumoHistoricoSebrae().catch(erro => { console.error(erro); });
  }

  return { carregarResumoHistoricoSebrae };
});
