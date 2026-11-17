/**
 * Resumo (painel de ferramenta "comparacao"): ativos por regional, com filtro por categoria.
 * Migrado para React no Bloco 3 (piloto): o cartão vive em frontend/src/paineis/resumo-ativos/.
 * Este módulo é só a ponte que mantém a ação carregarResumoAtivos publicada para o código antigo.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).resumoAtivos = factory;
})(typeof window !== "undefined" ? window : globalThis, function createResumoAtivos(context) {
  "use strict";
  const ponte = context.ponteReact("resumo-ativos", ["carregarResumoAtivos"]);

  // Chamado ao abrir o painel (cockpit-tool-panels.js espera por ele): como no cartão antigo, nunca rejeita.
  function carregarResumoAtivos() {
    return ponte.carregarResumoAtivos().catch(erro => { console.error(`carregarResumoAtivos: ${erro?.message}`); });
  }

  return { carregarResumoAtivos };
});
