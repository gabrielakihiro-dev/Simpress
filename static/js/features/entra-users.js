/**
 * Nomes do Microsoft Entra (modal Atualizar planilhas): importa o CSV local do Entra, separado das duas planilhas.
 * Migrado para React no Dia 2 (G4): a seção vive em frontend/src/paineis/entra-users/.
 * Este módulo é só a ponte que mantém as ações publicadas para o código antigo.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).entraUsers = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEntraUsers(context) {
  "use strict";
  const ponte = context.ponteReact("entra-users", ["carregarEstadoEntra", "importarNomesEntra", "exportarNomesEntra"]);

  // Quem chama (inicialização em static/app.js, data-on-*) não trata erro: como no módulo antigo, nunca rejeita.
  const semRejeitar = nome => (...args) => ponte[nome](...args).catch(erro => { console.error(`${nome}: ${erro?.message}`); });

  return {
    carregarEstadoEntra: semRejeitar("carregarEstadoEntra"),
    importarNomesEntra: semRejeitar("importarNomesEntra"),
    exportarNomesEntra: semRejeitar("exportarNomesEntra"),
  };
});
