// Busca, lista da Home e Endpoint migrados para frontend/src/paineis/pesquisa-equipamento/.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).equipmentSearch = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentSearch(context) {
  "use strict";
  const ponteSincrona = context.ponteReactSincrona("pesquisa-equipamento", [
    "definirEquipamentoAtual", "limparSelecaoEquipamento", "invalidarBuscasEquipamento",
    "invalidarDadosEquipamentoAposRestauracao", "handleSerialInput", "handleSerialKeydown",
    "selecionarItemAutocomplete", "aplicarSugestaoBusca", "fecharAutocomplete", "limparSerial",
    "exibirEquipamento", "formatarLocalAtual", "limparPesquisasRecentes", "renderHomeList",
    "highlightHomeListItem", "filtrarListaHome", "inicializarListaHome",
    "aplicarCodigoProntoPowerShell", "adicionarCodigoPowerShell",
  ]);
  const ponte = context.ponteReact("pesquisa-equipamento", [
    "consultarEndpoint", "controleRemotoEndpoint", "abrirPowerShellEndpoint", "carregarCodigosPowerShell",
    "alternarEditorCodigosPowerShell", "salvarCodigosPowerShell", "atualizarSelecaoAposSubstituirInventarios",
    "buscarSerial", "abrirPesquisaRecente", "carregarMaisItensHome", "carregarListaHome",
  ]);
  const registrar = (nome, promessa) => promessa.catch(erro => { console.error(`${nome}: ${erro?.message}`); });
  const ponteRegistrada = Object.fromEntries(Object.entries(ponte).map(([nome, acao]) => [
    nome, (...argumentos) => registrar(nome, acao(...argumentos)),
  ]));
  return { ...ponteSincrona, ...ponteRegistrada };
});
