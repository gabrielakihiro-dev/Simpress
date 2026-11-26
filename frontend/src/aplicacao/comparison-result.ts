/** Comparação screen result: the render, the Resumo tabs, the filters and the annotations live in frontend/src/paineis/resultado-comparacao/; this module only forwards the calls. */
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export function createComparisonResult(context: ContextoApp): Acoes {
  // The renderer and cockpit-tool-panels.ts call these in the same turn, so the bridge is synchronous (the panel is mounted before the first call).
  const ponte = context.ponteReactSincrona("resultado-comparacao", [
    "renderizarResultadoComparacao", "renderizarSemUsuarioSemComparacao", "carregarSemUsuarioResumo",
    "invalidarSemUsuarioResumo", "navegarParaLinhaComparacao", "irParaSecaoComparacao", "atributosVersaoAnotacao",
    "renderizarAnotacaoOperacional", "conectarAnotacoesOperacionais", "selecionarAbaResumo", "limparAbasResumo",
  ]);
  // Without the panel the Comparação tab keeps opening, only without the result: the error goes to the console.
  return {
    ...ponte,
    // Without the panel the result never renders: show the error instead of leaving "Carregando comparação…" on screen.
    renderizarResultadoComparacao: (...argumentos: Qualquer[]) => {
      const resultado = ponte.renderizarResultadoComparacao(...argumentos);
      const semPainel = !(globalThis as Qualquer).SimpressReact?.["resultado-comparacao"] && typeof document !== "undefined";
      const conteudo = semPainel ? document.getElementById("comparacao-planilhas-conteudo") : null;
      if (conteudo) {
        // Same markup as renderError in frontend/src/paineis/ferramentas-cockpit/estado.ts.
        const nota = document.createElement("p");
        nota.className = "ck-nota ck-nota--erro";
        nota.textContent = "Não foi possível abrir a comparação.";
        nota.setAttribute("role", "status");
        conteudo.replaceChildren(nota);
        conteudo.dataset.estado = "erro";
      }
      return resultado;
    },
    atributosVersaoAnotacao: (...argumentos: Qualquer[]) => ponte.atributosVersaoAnotacao(...argumentos) ?? "",
    irParaSecaoComparacao: (...argumentos: Qualquer[]) => ponte.irParaSecaoComparacao(...argumentos) ?? false,
    navegarParaLinhaComparacao: (...argumentos: Qualquer[]) => ponte.navegarParaLinhaComparacao(...argumentos) ?? false,
    renderizarAnotacaoOperacional: (...argumentos: Qualquer[]) => ponte.renderizarAnotacaoOperacional(...argumentos) ?? "",
    carregarSemUsuarioResumo: (...argumentos: Qualquer[]) => ponte.carregarSemUsuarioResumo(...argumentos) ?? Promise.resolve(),
  };
}
