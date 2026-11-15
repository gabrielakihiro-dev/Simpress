// Catálogo de unidades: ponte para o painel React em frontend/src/paineis/unidades/.
// carregarUnidades grava appState.unidadesList (lido pelo Transporte e pelo ticket UX); recarregarUnidadesCockpit
// é chamado pelo roteador do Cockpit ao abrir o painel "unidades".
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).unitsCatalog = factory;
})(typeof window !== "undefined" ? window : globalThis, function createUnitsCatalog(context) {
  "use strict";

  const NOMES = [
    "carregarUnidades", "abrirModalGerenciarUnidades", "copiarDadoUnidade", "editarUnidade",
    "toggleFormNovaUnidade", "salvarUnidadeForm", "recarregarUnidadesCockpit",
  ];
  const ponte = context.ponteReact("unidades", NOMES);
  // Os data-on-* chamam sem esperar: a falha do bundle vira console.error, nunca rejeição solta.
  return Object.fromEntries(NOMES.map(nome => [nome, (...args) => ponte[nome](...args).catch(erro => { console.error(erro); })]));
});
