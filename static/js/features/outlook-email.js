/**
 * Home e-mail por modelo: modal "E-mail pelo Outlook" (modelos com autosave, contatos do Entra, abrir ou enviar pelo backend local).
 * Migrado para React no Dia 3 (G7): o modal vive em frontend/src/paineis/outlook-email/.
 * Este módulo é só a ponte que mantém as ações publicadas para o código antigo (data-on-*, busca de equipamento, fechar do modal).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).outlookEmail = factory;
})(typeof window !== "undefined" ? window : globalThis, function createOutlookEmail(context) {
  "use strict";
  const ponte = context.ponteReact("outlook-email", [
    "abrirEmailOutlook", "fecharEmailOutlook", "atualizarEmailOutlook", "trocarModeloEmail", "novoModeloEmail",
    "duplicarModeloEmail", "excluirModeloEmail", "restaurarModeloEmail", "copiarTextoEmail", "abrirEmailNoOutlook",
    "enviarEmailPeloOutlook",
  ]);

  // Quem chama (data-on-*, fechar do modal) não trata erro: como no módulo antigo, nunca rejeita.
  const semRejeitar = nome => (...args) => ponte[nome](...args).catch(erro => { console.error(`${nome}: ${erro?.message}`); });

  return {
    abrirEmailOutlook: semRejeitar("abrirEmailOutlook"),
    fecharEmailOutlook: semRejeitar("fecharEmailOutlook"),
    atualizarEmailOutlook: semRejeitar("atualizarEmailOutlook"),
    trocarModeloEmail: semRejeitar("trocarModeloEmail"),
    novoModeloEmail: semRejeitar("novoModeloEmail"),
    duplicarModeloEmail: semRejeitar("duplicarModeloEmail"),
    excluirModeloEmail: semRejeitar("excluirModeloEmail"),
    restaurarModeloEmail: semRejeitar("restaurarModeloEmail"),
    copiarTextoEmail: semRejeitar("copiarTextoEmail"),
    abrirEmailNoOutlook: semRejeitar("abrirEmailNoOutlook"),
    enviarEmailPeloOutlook: semRejeitar("enviarEmailPeloOutlook"),
  };
});
