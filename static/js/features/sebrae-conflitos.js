/**
 * Chamados (F5) → conflitos de edição do Dashboard: escolha por célula entre o SharePoint e o site, e reenvio.
 * Migrado para React no G1 (Sebrae): a seção vive em frontend/src/paineis/sebrae-conflitos/.
 * Este módulo é só a ponte que mantém a ação carregarConflitosSebrae publicada para o código antigo.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).sebraeConflitos = factory;
})(typeof window !== "undefined" ? window : globalThis, function createSebraeConflitos(context) {
  "use strict";
  const ponte = context.ponteReact("sebrae-conflitos", ["carregarConflitosSebrae"]);

  // sebrae-dashboard.js chama sem esperar nem tratar erro: como na seção antiga, nunca rejeita.
  function carregarConflitosSebrae() {
    return ponte.carregarConflitosSebrae().catch(erro => { console.error(`carregarConflitosSebrae: ${erro?.message}`); });
  }

  return { carregarConflitosSebrae };
});
