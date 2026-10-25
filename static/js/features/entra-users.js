/** Import the local Entra CSV independently from the two inventory workbooks. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).entraUsers = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEntraUsers(context) {
  "use strict";
  const { app, appState } = context;

  function resumoNomesEntra(data) {
    const texto = `${Number(data.users || 0).toLocaleString("pt-BR")} nomes PR importados.`;
    const ignorados = Number(data.logins_ignorados || 0);
    return ignorados > 0
      ? `${texto} ${ignorados.toLocaleString("pt-BR")} login(s) ignorado(s) por nomes conflitantes ou dados inválidos.`
      : texto;
  }

  async function carregarEstadoEntra() {
    const status = document.getElementById("entra-import-status");
    if (!status) return;
    try {
      const data = await app.apiFetch("/api/usuarios-entra/estado", { errorMessage: "Não foi possível consultar o cadastro Entra." });
      status.textContent = data.updated_at
        ? resumoNomesEntra(data)
        : "Nenhum CSV do Entra importado.";
      document.getElementById("btn-exportar-nomes-entra").disabled = !data.users;
    } catch (error) {
      status.textContent = error.message;
    }
  }

  async function importarNomesEntra(event) {
    event?.preventDefault?.();
    const input = document.getElementById("entra-csv-file");
    const button = document.getElementById("btn-importar-nomes-entra");
    const status = document.getElementById("entra-import-status");
    const file = input?.files?.[0];
    if (!file) {
      app.showToast("Selecione o CSV exportado do Entra.", "warning");
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    status.textContent = "Validando e importando o CSV…";
    const data = new FormData();
    data.append("file", file);
    try {
      const result = await app.apiFetch("/api/usuarios-entra/importar", {
        method: "POST", body: data, errorMessage: "Não foi possível importar o CSV do Entra.",
      });
      status.textContent = resumoNomesEntra(result);
      input.value = "";
      const nomeArquivo = document.getElementById("entra-csv-name");
      if (nomeArquivo) nomeArquivo.textContent = "Nenhum arquivo selecionado";
      document.getElementById("btn-exportar-nomes-entra").disabled = false;
      if (appState.currentEquipamento?.serial) {
        const serial = appState.currentEquipamento.serial;
        const fresh = await app.apiFetch(`/api/equipamento/${encodeURIComponent(serial)}`);
        if (fresh?.serial && appState.currentEquipamento?.serial === serial) {
          app.definirEquipamentoAtual(fresh);
          app.atualizarUsuarioLogadoCard(fresh);
        }
      }
      app.showToast("Nomes do Entra atualizados.", "success");
      app.carregarProntidao?.();
    } catch (error) {
      status.textContent = error.message;
      app.showToast(error.message, "error");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function exportarNomesEntra() {
    window.location.assign("/api/usuarios-entra/exportar");
  }

  return { carregarEstadoEntra, importarNomesEntra, exportarNomesEntra };
});
