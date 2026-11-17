/**
 * Cobertura de equipamentos (F10): necessidades, disponíveis, reservas, movimentações e devoluções por cidade.
 * Migrado para React no Grupo 6: o painel vive em frontend/src/paineis/cobertura/ (regras de tela em paineis/cobertura/modelo.ts).
 * Este módulo é só a ponte que mantém a ação carregarCobertura publicada para o código antigo.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).coverage = factory;
})(typeof window !== "undefined" ? window : globalThis, function createCoverage(context) {
  "use strict";
  const ponte = context.ponteReact("cobertura", ["carregarCobertura"]);

  // Chamado ao abrir o painel (cockpit-tool-panels.js espera por ele sem tratar erro): nunca rejeita.
  function carregarCobertura() {
    return ponte.carregarCobertura().catch(erro => { console.error(`carregarCobertura: ${erro?.message}`); });
  }

  return { carregarCobertura };
});
