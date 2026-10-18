/** Monthly contract report: month picker dialog and XLSX download (docs/operacao/relatorio-mensal.md). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).monthlyReport = factory;
})(typeof window !== "undefined" ? window : globalThis, function createMonthlyReport(context) {
  "use strict";
  const { app } = context;
  const MES_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
  let exportandoRelatorio = false;

  function mesAtual(hoje = new Date()) {
    return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  }

  function mostrarStatus(mensagem, erro = false) {
    const status = document.getElementById("status-relatorio-mensal");
    if (!status) return;
    status.textContent = mensagem;
    status.setAttribute("role", erro ? "alert" : "status");
    status.dataset.state = erro ? "error" : "";
  }

  function abrirRelatorioMensal() {
    if (exportandoRelatorio) return;
    const input = document.getElementById("relatorio-mensal-mes");
    const atual = mesAtual();
    input.max = atual;
    if (!MES_PATTERN.test(input.value) || input.value > atual) input.value = atual;
    mostrarStatus("");
    app.abrirModalAcessivel("modal-relatorio-mensal", "#relatorio-mensal-mes", "fecharRelatorioMensal", "btn-relatorio-mensal");
  }

  function fecharRelatorioMensal() {
    if (!exportandoRelatorio) app.fecharModalAcessivel("modal-relatorio-mensal");
  }

  function baixarArquivo(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  }

  async function exportarRelatorioMensal() {
    if (exportandoRelatorio) return;
    const mes = document.getElementById("relatorio-mensal-mes").value;
    if (!MES_PATTERN.test(mes) || mes > mesAtual()) {
      mostrarStatus("Selecione o mês atual ou um mês anterior.", true);
      document.getElementById("relatorio-mensal-mes").focus();
      return;
    }
    const btn = document.getElementById("btn-exportar-relatorio-mensal");
    const form = document.getElementById("form-relatorio-mensal");
    exportandoRelatorio = true;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    form.setAttribute("aria-busy", "true");
    mostrarStatus("Gerando relatório...");
    try {
      const res = await app.apiFetch(`/api/relatorio-mensal?mes=${encodeURIComponent(mes)}`, {
        responseType: "response",
        errorMessage: "Falha ao gerar o relatório mensal.",
      });
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      const filename = match && match[1] ? match[1].replace(/['"]/g, "") : `Relatorio-mensal-${mes}.xlsx`;
      baixarArquivo(await res.blob(), filename);
      mostrarStatus("");
      app.showToast("Planilha Exportada com Sucesso!", "success");
    } catch (err) {
      console.error("Erro ao exportar o relatório mensal:", err);
      mostrarStatus(err.message, true);
      app.showToast(err.message, "error");
    } finally {
      exportandoRelatorio = false;
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      form.removeAttribute("aria-busy");
    }
  }

  return { abrirRelatorioMensal, fecharRelatorioMensal, exportarRelatorioMensal };
});
