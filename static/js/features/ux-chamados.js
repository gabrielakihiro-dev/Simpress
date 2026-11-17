/**
 * Modal "Abrir chamado no UX" (Home): prepara uma sessão, depois simula ou envia com confirmação.
 * Migrado para React no Dia 2 (G4): o modal vive em frontend/src/paineis/ux-chamados/.
 * Este módulo é só a ponte que mantém as ações publicadas para o código antigo.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).uxChamados = factory;
})(typeof window !== "undefined" ? window : globalThis, function createUxChamados(context) {
  "use strict";
  const ponte = context.ponteReact("ux-chamados", [
    "abrirChamadoUX", "fecharChamadoUX", "atualizarProblemaChamadoUX", "conferirChamadoUX", "executarChamadoUX",
  ]);

  // Quem chama (data-on-*, fechar do modal, troca de equipamento) não trata erro: como no módulo antigo, nunca rejeita.
  const semRejeitar = nome => (...args) => ponte[nome](...args).catch(erro => { console.error(`${nome}: ${erro?.message}`); });

  // O Assistente lê o contexto sem await (assistant-chat.js): continua síncrono; antes de o React montar, undefined.
  const contextoChamadoUX = () => window.SimpressReact?.["ux-chamados"]?.contextoChamadoUX();

  return {
    abrirChamadoUX: semRejeitar("abrirChamadoUX"),
    fecharChamadoUX: semRejeitar("fecharChamadoUX"),
    atualizarProblemaChamadoUX: semRejeitar("atualizarProblemaChamadoUX"),
    conferirChamadoUX: semRejeitar("conferirChamadoUX"),
    executarChamadoUX: semRejeitar("executarChamadoUX"),
    contextoChamadoUX,
  };
});
