/**
 * Home "Ver todos os resultados": full inventory search dialog, filters and paginated loading (GET /api/buscar-expandida).
 * Since the React migration (Dia 2, G10) the dialog lives in frontend/src/paineis/pesquisa-completa/; this module is only
 * the bridge that keeps the old action names on window (data-on-click, data-on-change, the accessible dialog's Esc) and
 * hands the React panel the old row renderer (equipment-search-renderers.js), which still draws each result row.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).fullEquipmentSearch = factory;
})(typeof window !== "undefined" ? window : globalThis, function createFullEquipmentSearch(context) {
  "use strict";
  const renderers = context.equipmentSearchRenderer(context);
  const ponte = context.ponteReact("pesquisa-completa", [
    "abrirPesquisaCompleta", "alterarFiltrosPesquisaCompleta", "limparFiltrosPesquisaCompleta",
    "carregarMaisResultadosPesquisa", "fecharModalPesquisaCompleta",
  ]);
  // Callers ignore the promise: a React panel that did not load is logged, never an unhandled rejection.
  const registrar = promessa => promessa.catch(erro => { console.error(erro); });

  function abrirPesquisaCompleta() {
    return registrar(ponte.abrirPesquisaCompleta(renderers.criarLinhaPesquisaCompleta));
  }

  function alterarFiltrosPesquisaCompleta() {
    return registrar(ponte.alterarFiltrosPesquisaCompleta());
  }

  function limparFiltrosPesquisaCompleta() {
    return registrar(ponte.limparFiltrosPesquisaCompleta());
  }

  function carregarMaisResultadosPesquisa() {
    return registrar(ponte.carregarMaisResultadosPesquisa());
  }

  function fecharModalPesquisaCompleta() {
    return registrar(ponte.fecharModalPesquisaCompleta());
  }

  return {
    abrirPesquisaCompleta, alterarFiltrosPesquisaCompleta, limparFiltrosPesquisaCompleta,
    carregarMaisResultadosPesquisa, fecharModalPesquisaCompleta,
  };
});
