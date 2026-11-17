/**
 * Home "Ver todos os resultados": full inventory search dialog, filters and paginated loading (GET /api/buscar-expandida).
 * Since the React migration (Dia 2, G10) the dialog lives in frontend/src/paineis/pesquisa-completa/; this module is only
 * the bridge that keeps the old action names on window (data-on-click, data-on-change, the accessible dialog's Esc) and
 * hands the React panel the old row renderer (equipment-search-renderers.ts), which still draws each result row.
 */
import { registrar } from "./pontes.ts";
import type { Acoes, ContextoApp } from "./tipos.ts";

export function createFullEquipmentSearch(context: ContextoApp): Acoes {
  const renderers = context.equipmentSearchRenderer(context);
  const ponte = context.ponteReact("pesquisa-completa", [
    "abrirPesquisaCompleta", "alterarFiltrosPesquisaCompleta", "limparFiltrosPesquisaCompleta",
    "carregarMaisResultadosPesquisa", "fecharModalPesquisaCompleta",
  ]);
  // Callers ignore the promise: a React panel that did not load is logged, never an unhandled rejection.

  function abrirPesquisaCompleta() {
    return registrar("abrirPesquisaCompleta", ponte.abrirPesquisaCompleta(renderers.criarLinhaPesquisaCompleta));
  }

  function alterarFiltrosPesquisaCompleta() {
    return registrar("alterarFiltrosPesquisaCompleta", ponte.alterarFiltrosPesquisaCompleta());
  }

  function limparFiltrosPesquisaCompleta() {
    return registrar("limparFiltrosPesquisaCompleta", ponte.limparFiltrosPesquisaCompleta());
  }

  function carregarMaisResultadosPesquisa() {
    return registrar("carregarMaisResultadosPesquisa", ponte.carregarMaisResultadosPesquisa());
  }

  function fecharModalPesquisaCompleta() {
    return registrar("fecharModalPesquisaCompleta", ponte.fecharModalPesquisaCompleta());
  }

  return {
    abrirPesquisaCompleta, alterarFiltrosPesquisaCompleta, limparFiltrosPesquisaCompleta,
    carregarMaisResultadosPesquisa, fecharModalPesquisaCompleta,
  };
}
