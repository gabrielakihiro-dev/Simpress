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
    // Without the panel the result never renders: show the error instead of leaving "Carregando comparação…" on screen.
    renderizarResultadoComparacao: (...argumentos) => {
      const resultado = ponte.renderizarResultadoComparacao(...argumentos);
      const semPainel = !globalThis.SimpressReact?.["resultado-comparacao"] && typeof document !== "undefined";
      const conteudo = semPainel ? document.getElementById("comparacao-planilhas-conteudo") : null;
      if (conteudo) {
        // Same markup as renderError in cockpit-tool-panels.js.
        const nota = document.createElement("p");
        nota.className = "ck-nota ck-nota--erro";
        nota.textContent = "Não foi possível abrir a comparação.";
        conteudo.replaceChildren(nota);
        conteudo.dataset.estado = "erro";
      }
      return resultado;
    },
    atributosVersaoAnotacao: (...argumentos) => ponte.atributosVersaoAnotacao(...argumentos) ?? "",
    irParaSecaoComparacao: (...argumentos) => ponte.irParaSecaoComparacao(...argumentos) ?? false,
    navegarParaLinhaComparacao: (...argumentos) => ponte.navegarParaLinhaComparacao(...argumentos) ?? false,
    renderizarAnotacaoOperacional: (...argumentos) => ponte.renderizarAnotacaoOperacional(...argumentos) ?? "",
    carregarSemUsuarioResumo: (...argumentos) => ponte.carregarSemUsuarioResumo(...argumentos) ?? Promise.resolve(),
  };
});
