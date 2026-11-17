import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Dialogo } from "./dialogo";
import {
  abrirPesquisaCompleta, alterarFiltrosPesquisaCompleta, carregarMaisResultadosPesquisa, fecharModalPesquisaCompleta,
  limparFiltrosPesquisaCompleta,
} from "./estado";

// Chamado por frontend/src/main.tsx com o .ck-dialogo do #modal-pesquisa-completa (data-react-painel="pesquisa-completa").
// As cinco ações são chamadas pela aplicação pela ponte (frontend/src/aplicacao/full-equipment-search.ts).
export function montar(container: HTMLElement) {
  const raiz = createRoot(container);
  // Desenha já: o diálogo acessível procura o título (aria-labelledby) e o botão Fechar no DOM.
  flushSync(() => raiz.render(<Dialogo />));
  return {
    abrirPesquisaCompleta, alterarFiltrosPesquisaCompleta, limparFiltrosPesquisaCompleta,
    carregarMaisResultadosPesquisa, fecharModalPesquisaCompleta,
  };
}
