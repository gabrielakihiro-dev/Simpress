/** Equipment-card actions delegated to the React panel. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).equipmentEditor = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentEditor(context) {
  "use strict";
  const sincrona = context.ponteReactSincrona("cartao-equipamento", [
    "atualizarUsuarioLogadoCard", "editarNomePessoa", "editarUsuarioLogado", "editarDadosCadastrais", "cancelarDadosCadastrais",
  ]);
  const assincrona = context.ponteReact("cartao-equipamento", [
    "abrirModalEditarEquipamento", "cadastrarNovoSerialPesquisado", "fecharModalEditarEquipamento",
    "abrirModalEditarApelido", "fecharModalEditarApelido", "salvarApelido", "salvarDadosEquipamento",
    "salvarUsuarioLogado", "limparUsuarioLogado", "salvarNomePessoa", "salvarDadosCadastrais",
  ]);
  const registrar = promessa => promessa.catch(erro => { console.error(erro); });
  const assincronaRegistrada = Object.fromEntries(Object.entries(assincrona).map(([nome, acao]) => [
    nome, (...argumentos) => registrar(acao(...argumentos)),
  ]));
  return {
    ...sincrona,
    ...assincronaRegistrada,
  };
});
