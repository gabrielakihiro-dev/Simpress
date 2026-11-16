// Contatos e representantes: ações migradas para frontend/src/paineis/contatos-regionais/.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).regionalContacts = factory;
})(typeof window !== "undefined" ? window : globalThis, function createRegionalContacts(context) {
  "use strict";

  const ponteSincrona = context.ponteReactSincrona("contatos-regionais", [
    "formatarTelefoneBrasileiro", "entregaAlmocoNaoFecha", "abrirConfiguracaoContatoOrigem",
    "fecharConfiguracaoContatoOrigem", "obterDadosCliente", "fecharConfiguracaoCliente",
    "abrirImportacaoModeloTransferencia", "atualizarObrigatoriedadeDuracaoPausaEntrega",
    "popularSeletoresRepresentantesRegionais", "preencherRepresentanteRegional",
    "handleRepresentanteRegionalChange", "inicializarMascarasTelefone",
    "abrirEdicaoRepresentanteRegional", "fecharEdicaoRepresentanteRegional",
    "alternarAlmocoRepresentanteRegional",
  ]);
  const ponte = context.ponteReact("contatos-regionais", [
    "carregarConfiguracaoTransferencia", "salvarConfiguracaoContatoOrigem", "abrirConfiguracaoCliente",
    "salvarConfiguracaoCliente", "carregarRepresentantesRegionais", "salvarRepresentanteRegional",
    "restaurarRepresentanteRegional",
  ]);

  const registrar = promessa => promessa.catch(erro => { console.error(erro); });
  const ponteRegistrada = Object.fromEntries(Object.entries(ponte).map(([nome, acao]) => [
    nome, (...argumentos) => registrar(acao(...argumentos)),
  ]));
  return { ...ponteSincrona, ...ponteRegistrada };
});
