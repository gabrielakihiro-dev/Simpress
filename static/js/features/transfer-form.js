// Comportamento da Home e do Transporte migrado para frontend/src/paineis/transporte/.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).transferForm = factory;
})(typeof window !== "undefined" ? window : globalThis, function createTransferForm(context) {
  "use strict";

  const ponteSincrona = context.ponteReactSincrona("transporte", [
    "atualizarResumoSerieTransferencia", "ativarAbaTransferencia", "abrirAbaTransporteDoEquipamento",
    "abrirHomeParaPesquisarEquipamento", "controlarAbasTransferencia", "forcarSedePradoVelho",
    "atualizarEstadoCopiaCnpjEntrega", "atualizarChipsUnidade", "trocarEquipamentoTransporte",
    "handleUnidadeDestinoChange", "selecionarUnidadePorCidade", "adicionarObsChamado",
    "alternarVisualizacaoModelo", "recolherVisualizacoesModelosChamado", "alternarChamadosManuais",
    "abrirModalPreview", "fecharModalPreview", "copiarTextoDoModal", "montarTextoSolicitacaoTransporte",
    "gerarTextoSolicitacaoTransporte", "montarTextoAlterarEndereco", "serialAlterarEndereco",
    "atualizarBotaoAlterarEndereco", "atualizarPreviaTransporteCockpit", "fecharModalTextoTransporte",
    "validarCamposObrigatoriosPlanilha",
  ]);
  const ponte = context.ponteReact("transporte", [
    "copiarModeloChamado", "prepararTransporte", "copiarSerieAtual", "copiarDadoLocalAtual",
    "copiarDadoEntrega", "copiarTextoSolicitacaoTransporte", "gerarPlanilhaExcel", "resetarFormulario",
  ]);

  const registrar = (nome, promessa) => promessa.catch(erro => { console.error(`${nome}: ${erro?.message}`); });
  const ponteRegistrada = Object.fromEntries(Object.entries(ponte).map(([nome, acao]) => [
    nome, (...argumentos) => registrar(nome, acao(...argumentos)),
  ]));
  return { ...ponteSincrona, ...ponteRegistrada };
});
