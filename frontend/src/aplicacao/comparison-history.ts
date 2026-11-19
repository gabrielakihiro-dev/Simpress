/**
 * Histórico de Planilhas (diálogo com as atualizações salvas, exportação por data, restauração e exclusão).
 * Migrado para React no Dia 3 (G9): o diálogo vive em frontend/src/paineis/historico-comparacoes/.
 * Este módulo é a ponte que mantém as ações publicadas em window (frontend/src/aplicacao/app.ts), e guarda o download do Excel, que segue fora do React.
 */
import { registrar, registrarRejeicoes } from "./pontes.ts";
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export function createComparisonHistory(context: ContextoApp): Acoes {
  const { app } = context;
  const ponte = context.ponteReact("historico-comparacoes", [
    "carregarContagemHistoricoComparacoes", "abrirModalHistoricoComparacoes", "fecharModalHistoricoComparacoes",
    "carregarHistoricoComparacoes", "exportarHistoricoComparacoesExcel", "restaurarHistoricoComparacao",
    "consultarHistoricoComparacao",
  ]);

  // Quem chama (data-on-*, app.ts, inventory-upload) não trata erro: como no módulo antigo, nunca rejeita.
  const registrada = registrarRejeicoes(ponte);

  async function baixarHistoricoComparacoesExcel(data: Qualquer) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ""))) {
      throw new Error("A data do histórico da atualização não está disponível.");
    }

    const res = await app.apiFetch(`/api/historico-comparacoes/exportar/excel?data=${encodeURIComponent(data)}`, {
      responseType: "response",
      errorMessage: "Não foi possível exportar o histórico selecionado.",
    });

    const disposition = res.headers.get("Content-Disposition") || "";
    const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
    const filename = match && match[1]
      ? match[1].replace(/['"]/g, "")
      : `Historico_Planilhas_${data.replace(/-/g, "")}.xlsx`;
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    return filename;
  }

  // Home dashboard shortcut: opens the saved result and scrolls to the section named by `secao`.
  function abrirResultadoHistoricoComparacao(eventoId: Qualquer, secao: Qualquer, botao: Qualquer) {
    return registrar("abrirResultadoHistoricoComparacao", ponte.consultarHistoricoComparacao(eventoId, botao, { section: secao }));
  }

  return {
    carregarContagemHistoricoComparacoes: registrada.carregarContagemHistoricoComparacoes,
    abrirModalHistoricoComparacoes: registrada.abrirModalHistoricoComparacoes,
    fecharModalHistoricoComparacoes: registrada.fecharModalHistoricoComparacoes,
    carregarHistoricoComparacoes: registrada.carregarHistoricoComparacoes,
    baixarHistoricoComparacoesExcel,
    exportarHistoricoComparacoesExcel: registrada.exportarHistoricoComparacoesExcel,
    restaurarHistoricoComparacao: registrada.restaurarHistoricoComparacao,
    abrirResultadoHistoricoComparacao,
  };
}
