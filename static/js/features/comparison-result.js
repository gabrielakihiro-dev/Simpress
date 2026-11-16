/** Comparação screen result: the render, the Resumo tabs, the filters and the annotations live in frontend/src/paineis/resultado-comparacao/; this module only forwards the calls. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).comparisonResult = factory;
})(typeof window !== "undefined" ? window : globalThis, function createComparisonResult(context) {
  "use strict";
  // The renderer and cockpit-tool-panels.js call these in the same turn, so the bridge is synchronous (the panel is mounted before the first call).
  const ponte = context.ponteReactSincrona("resultado-comparacao", [
    "renderizarResultadoComparacao", "renderizarSemUsuarioSemComparacao", "carregarSemUsuarioResumo",
    "invalidarSemUsuarioResumo", "navegarParaLinhaComparacao", "irParaSecaoComparacao", "atributosVersaoAnotacao",
    "renderizarAnotacaoOperacional", "conectarAnotacoesOperacionais", "selecionarAbaResumo", "limparAbasResumo",
  ]);
  // Without the panel the Comparação tab keeps opening, only without the result: the error goes to the console.
  return {
    ...ponte,
    atributosVersaoAnotacao: (...argumentos) => ponte.atributosVersaoAnotacao(...argumentos) ?? "",
    irParaSecaoComparacao: (...argumentos) => ponte.irParaSecaoComparacao(...argumentos) ?? false,
    navegarParaLinhaComparacao: (...argumentos) => ponte.navegarParaLinhaComparacao(...argumentos) ?? false,
    renderizarAnotacaoOperacional: (...argumentos) => ponte.renderizarAnotacaoOperacional(...argumentos) ?? "",
    carregarSemUsuarioResumo: (...argumentos) => ponte.carregarSemUsuarioResumo(...argumentos) ?? Promise.resolve(),
  };
});
