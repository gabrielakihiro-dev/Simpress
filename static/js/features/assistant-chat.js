/**
 * Assistente: conversa com a IA do Simpress (OpenRouter, chamada pelo servidor local) pelas rotas /api/assistente/*, no chat flutuante (F9).
 * Migrado para React no Dia 3 (G7b): o painel vive em frontend/src/paineis/assistant-chat/.
 * Este módulo é só a ponte que mantém as ações publicadas para o código antigo (F9, #btn-assistente, data-on-*).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).assistantChat = factory;
})(typeof window !== "undefined" ? window : globalThis, function createAssistantChat(context) {
  "use strict";
  const ponte = context.ponteReact("assistant-chat", [
    "carregarAssistente", "alternarAssistente", "minimizarAssistente", "maximizarAssistente", "voltarConversaAssistente",
    "enviarMensagemAssistente", "confirmarPendenteAssistente", "cancelarPendenteAssistente", "cancelarEnvioAssistente",
    "novaConversaAssistente", "contarMensagemAssistente", "preencherAtalhoAssistente", "teclaAssistente", "alternarGravacaoAssistente", "alternarVozAssistente",
    "alternarInstrucoesAssistente", "alternarBuscaWebAssistente", "contarInstrucoesAssistente", "salvarInstrucoesAssistente", "limparInstrucoesAssistente",
    "anexarArquivoAssistente", "removerAnexoAssistente",
    "alternarHistoricoAssistente", "abrirConversaHistoricoAssistente", "abrirConversaLateralAssistente", "fecharConversaHistoricoAssistente",
    "exportarPdfHistoricoAssistente", "pedirApagarConversaHistoricoAssistente", "cancelarApagarConversaHistoricoAssistente", "apagarConversaHistoricoAssistente",
    "alternarLembretesAssistente", "marcarLembreteAssistente", "pedirApagarLembreteAssistente", "cancelarApagarLembreteAssistente", "apagarLembreteAssistente",
  ]);

  // Quem chama (F9, #btn-assistente, data-on-*) não trata erro: como no módulo antigo, nunca rejeita.
  const semRejeitar = nome => (...args) => ponte[nome](...args).catch(erro => { console.error(erro); });

  return {
    carregarAssistente: semRejeitar("carregarAssistente"),
    alternarAssistente: semRejeitar("alternarAssistente"),
    minimizarAssistente: semRejeitar("minimizarAssistente"),
    maximizarAssistente: semRejeitar("maximizarAssistente"),
    voltarConversaAssistente: semRejeitar("voltarConversaAssistente"),
    enviarMensagemAssistente: semRejeitar("enviarMensagemAssistente"),
    confirmarPendenteAssistente: semRejeitar("confirmarPendenteAssistente"),
    cancelarPendenteAssistente: semRejeitar("cancelarPendenteAssistente"),
    cancelarEnvioAssistente: semRejeitar("cancelarEnvioAssistente"),
    novaConversaAssistente: semRejeitar("novaConversaAssistente"),
    contarMensagemAssistente: semRejeitar("contarMensagemAssistente"),
    preencherAtalhoAssistente: semRejeitar("preencherAtalhoAssistente"),
    teclaAssistente: semRejeitar("teclaAssistente"),
    alternarGravacaoAssistente: semRejeitar("alternarGravacaoAssistente"),
    alternarVozAssistente: semRejeitar("alternarVozAssistente"),
    alternarInstrucoesAssistente: semRejeitar("alternarInstrucoesAssistente"),
    alternarBuscaWebAssistente: semRejeitar("alternarBuscaWebAssistente"),
    contarInstrucoesAssistente: semRejeitar("contarInstrucoesAssistente"),
    salvarInstrucoesAssistente: semRejeitar("salvarInstrucoesAssistente"),
    limparInstrucoesAssistente: semRejeitar("limparInstrucoesAssistente"),
    anexarArquivoAssistente: semRejeitar("anexarArquivoAssistente"),
    removerAnexoAssistente: semRejeitar("removerAnexoAssistente"),
    alternarHistoricoAssistente: semRejeitar("alternarHistoricoAssistente"),
    abrirConversaHistoricoAssistente: semRejeitar("abrirConversaHistoricoAssistente"),
    abrirConversaLateralAssistente: semRejeitar("abrirConversaLateralAssistente"),
    fecharConversaHistoricoAssistente: semRejeitar("fecharConversaHistoricoAssistente"),
    exportarPdfHistoricoAssistente: semRejeitar("exportarPdfHistoricoAssistente"),
    pedirApagarConversaHistoricoAssistente: semRejeitar("pedirApagarConversaHistoricoAssistente"),
    cancelarApagarConversaHistoricoAssistente: semRejeitar("cancelarApagarConversaHistoricoAssistente"),
    apagarConversaHistoricoAssistente: semRejeitar("apagarConversaHistoricoAssistente"),
    alternarLembretesAssistente: semRejeitar("alternarLembretesAssistente"),
    marcarLembreteAssistente: semRejeitar("marcarLembreteAssistente"),
    pedirApagarLembreteAssistente: semRejeitar("pedirApagarLembreteAssistente"),
    cancelarApagarLembreteAssistente: semRejeitar("cancelarApagarLembreteAssistente"),
    apagarLembreteAssistente: semRejeitar("apagarLembreteAssistente"),
  };
});
