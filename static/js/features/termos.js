/**
 * Termos de entrega e devolução (Ferramentas): formulários na tela, folha de PDF montada na hora; nada é guardado.
 * Migrado para React no Grupo 6: junto com os Lembretes, o painel vive em frontend/src/paineis/lembretes/ (regras puras em
 * termos-puro.ts, ações em termos-acoes.ts). Este módulo é só a ponte que mantém as ações publicadas para o código antigo
 * (cockpit-tool-panels.js abre a aba; equipment-search.js preenche o termo com o equipamento buscado).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).termos = factory;
})(typeof window !== "undefined" ? window : globalThis, function createTermos(context) {
  "use strict";
  const NOMES = [
    "termosSelecionarAba", "termosTeclaAba", "termosGerarPdf", "termosLimpar", "termosPreencherDoEquipamento",
    "termosGerarPdfDoLembrete", "termosPreencherDoLembrete",
  ];
  const ponte = context.ponteReact("lembretes", NOMES);

  // Os chamadores antigos (Home, abas das ferramentas) não tratam erro: a ponte nunca rejeita.
  // Sem console aqui: nome, unidade e série do termo podem estar na mensagem do erro.
  const acoes = {};
  NOMES.forEach((nome) => {
    acoes[nome] = (...args) => ponte[nome](...args).catch(() => {});
  });
  return acoes;
});
