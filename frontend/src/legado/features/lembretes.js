/**
 * Lembretes (Ferramentas): lista local de tarefas em /api/lembretes. A descrição tem dado pessoal: nunca vai para log nem para storage.
 * Migrado para React no Grupo 6: junto com os Termos, o painel vive em frontend/src/paineis/lembretes/ (regras puras em
 * lembretes-puro.ts, ações em lembretes-acoes.ts). Este módulo é só a ponte que mantém as ações publicadas para o código antigo
 * (carregarLembretes ao abrir o painel e as funções que os diálogos acessíveis chamam em data-close-function).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).lembretes = factory;
})(typeof window !== "undefined" ? window : globalThis, function createLembretes(context) {
  "use strict";
  const NOMES = [
    "carregarLembretes", "lembretesAdicionar", "lembretesAoDigitar", "lembretesAlternar", "lembretesEditar",
    "lembretesCancelarEdicao", "lembretesTeclaEdicao", "lembretesSalvarEdicao", "lembretesAlternarConcluidos",
    "lembretesExcluir", "lembretesCancelarExclusao", "lembretesConfirmarExclusao",
    "lembretesCriarDoTermo", "lembretesCancelarCriar", "lembretesConfirmarCriar", "lembretesVerLembretes",
    "lembretesSelecionarVista", "lembretesTeclaVista", "lembretesMudarSemana", "lembretesIrParaDia", "lembretesAdicionarNoDia",
    "lembretesReagendarAtrasados", "lembretesAlternarPainelData", "lembretesTeclaPainelData", "lembretesAtalhoData",
    "lembretesAoMudarData", "lembretesRemoverData", "lembretesGerarPdfTermo", "lembretesPreencherTermo",
  ];
  const ponte = context.ponteReact("lembretes", NOMES);

  // Os chamadores antigos não tratam erro: a ponte nunca rejeita. Sem console aqui: o que passa por estas ações pode ter dado pessoal.
  const acoes = {};
  NOMES.forEach((nome) => {
    acoes[nome] = (...args) => ponte[nome](...args).catch(() => {});
  });
  return acoes;
});
