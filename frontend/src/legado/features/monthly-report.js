/**
 * Relatório mensal do contrato (diálogo do mês e download do XLSX; docs/operacao/relatorio-mensal.md).
 * Migrado para React no Dia 3 (G9): o formulário vive em frontend/src/paineis/relatorio-mensal/.
 * Este módulo é só a ponte que mantém as ações publicadas para o código antigo.
 * O ícone data-lucide="download" do botão agora é desenhado pelo React; este literal o mantém no subset do lucide
 * (scripts/build/lucide-subset.cjs só lê static/ e frontend/partials/).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).monthlyReport = factory;
})(typeof window !== "undefined" ? window : globalThis, function createMonthlyReport(context) {
  "use strict";
  const ponte = context.ponteReact("relatorio-mensal", ["abrirRelatorioMensal", "fecharRelatorioMensal", "exportarRelatorioMensal"]);

  // Quem chama (data-on-*, cockpit-tool-panels.js) não trata erro: como no módulo antigo, nunca rejeita.
  const semRejeitar = nome => (...args) => ponte[nome](...args).catch(erro => { console.error(`${nome}: ${erro?.message}`); });

  return {
    abrirRelatorioMensal: semRejeitar("abrirRelatorioMensal"),
    fecharRelatorioMensal: semRejeitar("fecharRelatorioMensal"),
    exportarRelatorioMensal: semRejeitar("exportarRelatorioMensal"),
  };
});
