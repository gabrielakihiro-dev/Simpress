/** Inventory files: Simpress + Endpoint replacement with preview, template imports, and the updated equipment export. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).inventoryUpload = factory;
})(typeof window !== "undefined" ? window : globalThis, function createInventoryUpload(context) {
  "use strict";
  const { app, appState, inventoryOperationKey } = context;

  let inventoryUploadAttempt = null;

  function inicializarExportacaoAutomaticaHistorico() {
    const input = document.getElementById("auto-export-history-after-update");
    if (!input) return;

    try {
      input.checked = window.localStorage.getItem("simpress:auto-export-history-after-update") === "true";
    } catch (error) {
      console.warn("Não foi possível ler a preferência de exportação automática do histórico.", error);
    }

    input.addEventListener("change", () => {
      try {
        window.localStorage.setItem(
          "simpress:auto-export-history-after-update",
          input.checked ? "true" : "false",
        );
      } catch (error) {
        console.warn("Não foi possível salvar a preferência de exportação automática do histórico.", error);
      }
    });
  }

  const ARQUIVOS_ATUALIZACAO_PLANILHAS = ["upload-endpoint-file", "upload-details-file", "entra-csv-file"];

  // O nome e o estado do arquivo são desenhados por ui/file-picker.js a partir do evento change.
  function redesenharSeletorArquivo(input) {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function inicializarArquivosAtualizacaoPlanilhas() {
    ["upload-endpoint-file", "upload-details-file"].forEach(inputId => {
      document.getElementById(inputId)?.addEventListener("change", () => app.limparPreviaUploadPlanilhas());
    });
  }

  function mostrarEtapaPlanilhas(etapa) {
    document.getElementById("modal-atualizar-planilhas")?.querySelectorAll?.("[data-so-etapa]").forEach(el => {
      el.hidden = el.dataset.soEtapa !== etapa;
    });
    document.getElementById("btn-voltar-planilhas")?.classList.toggle("hidden", etapa !== "impacto");
  }

  // ==========================================
  // RECARREGAR / SINCRONIZAR PLANILHA BASE
  // ==========================================
  let importacaoModeloOcupada = false;

  function abrirImportacaoModelo(tipo) {
    if (importacaoModeloOcupada) return;
    const modal = document.getElementById("modal-importar-modelo");
    modal.dataset.tipo = tipo;
    document.getElementById("titulo-importar-modelo").textContent = tipo === "transferencia"
      ? "Arquivos para transferência" : "Arquivos para exportação";
    document.getElementById("descricao-importar-modelo").textContent = tipo === "transferencia"
      ? "A base Simpress + Endpoint é compartilhada. Se necessário, atualize-a no painel de disponibilidade; aqui, importe o modelo oficial de transferência da Simpress."
      : "Importe a planilha do modelo de exportação que atualiza os apelidos/hostnames.";
    const modelFile = document.getElementById("arquivo-modelo-local");
    modelFile.value = "";
    redesenharSeletorArquivo(modelFile);
    document.getElementById("status-modelo-local").textContent = "";
    app.abrirModalAcessivel("modal-importar-modelo", "#arquivo-modelo-local", "fecharImportacaoModelo");
  }

  function fecharImportacaoModelo() {
    if (!importacaoModeloOcupada) app.fecharModalAcessivel("modal-importar-modelo");
  }

  async function enviarModeloLocal() {
    if (importacaoModeloOcupada) return;
    const modal = document.getElementById("modal-importar-modelo");
    const file = document.getElementById("arquivo-modelo-local").files?.[0];
    const status = document.getElementById("status-modelo-local");
    status.setAttribute("role", "status");
    if (!file) { status.textContent = "Selecione um modelo .xlsx."; return; }
    const button = document.getElementById("btn-importar-modelo");
    importacaoModeloOcupada = true;
    button.disabled = true;
    modal.setAttribute("aria-busy", "true");
    status.textContent = "Validando e importando o modelo…";
    const data = new FormData();
    data.append("file", file);
    try {
      const result = await app.apiFetch(`/api/modelos/${modal.dataset.tipo}/importar`, { method: "POST", body: data, errorMessage: "Não foi possível importar o modelo." });
      status.textContent = "Modelo importado. Confira abaixo se todas as dependências estão disponíveis.";
      const modelFile = document.getElementById("arquivo-modelo-local");
      modelFile.value = "";
      redesenharSeletorArquivo(modelFile);
      // The file replacement has completed; let the user dismiss the modal
      // while readiness and the other secondary panels finish refreshing.
      importacaoModeloOcupada = false;
      await Promise.allSettled([app.carregarProntidao(), app.carregarEstatisticas(), app.carregarUnidades()]);
      app.showToast("Modelo validado e importado.", "success");
    } catch (error) {
      status.setAttribute("role", "alert");
      status.textContent = error.message || "Não foi possível importar o modelo.";
    } finally {
      importacaoModeloOcupada = false;
      button.disabled = false;
      modal.removeAttribute("aria-busy");
    }
  }

  function limparPreviaUploadPlanilhas(limparStatus = true) {
    appState.previaPlanilhasAtual = null;
    const preview = document.getElementById("upload-planilhas-preview");
    if (preview) {
      preview.textContent = "";
      preview.classList.add("hidden");
    }
    document.getElementById("btn-confirmar-planilhas")?.classList.add("hidden");
    document.getElementById("btn-previsualizar-planilhas")?.classList.remove("hidden");
    mostrarEtapaPlanilhas("arquivos");
    if (limparStatus) {
      const status = document.getElementById("upload-planilhas-status");
      status.textContent = "";
      status.className = "ckp-rodape__status";
      status.removeAttribute("role");
      status.removeAttribute("aria-live");
    }
  }

  function abrirModalAtualizarPlanilhas() {
    app.limparPreviaUploadPlanilhas();
    app.abrirModalAcessivel("modal-atualizar-planilhas", "#upload-endpoint-file", "fecharModalAtualizarPlanilhas");
  }

  function fecharModalAtualizarPlanilhas() {
    app.limparPreviaUploadPlanilhas();
    app.fecharModalAcessivel("modal-atualizar-planilhas");
  }

  function mostrarStatusUpload(mensagem, erro = false) {
    const status = document.getElementById("upload-planilhas-status");
    status.textContent = mensagem;
    status.setAttribute("role", erro ? "alert" : "status");
    status.setAttribute("aria-live", erro ? "assertive" : "polite");
    status.setAttribute("aria-atomic", "true");
    status.className = "ckp-rodape__status";
    if (erro) status.scrollIntoView?.({ block: "nearest" });
  }

  function renderizarPreviaUploadPlanilhas(result) {
    if (!result?.preview_token || !result?.arquivos || !result?.alteracoes) {
      throw new Error("A prévia recebida está incompleta. Gere uma nova prévia.");
    }
    const labels = {
      endpoint: "Endpoint",
      detalhes: "Simpress",
    };
    const linhas = ["Resumo da substituição (contagens por número de série):"];
    for (const role of ["endpoint", "detalhes"]) {
      const arquivo = result.arquivos[role] || {};
      const alteracao = result.alteracoes[role] || {};
      const formatar = valor => Number(valor || 0).toLocaleString("pt-BR");
      linhas.push(
        `${labels[role]} — ${arquivo.nome || "arquivo selecionado"} (${formatar(arquivo.linhas)} linhas)`,
        `Séries novas: ${formatar(alteracao.series_novas)}; removidas: ${formatar(alteracao.series_removidas)}; duplicadas no arquivo novo: ${formatar(alteracao.series_duplicadas_no_arquivo_novo)}.`
      );
    }
    const preview = document.getElementById("upload-planilhas-preview");
    preview.textContent = linhas.join("\n");
    preview.className = "whitespace-pre-line";
    preview.setAttribute("role", "status");
    preview.setAttribute("aria-live", "polite");
    preview.setAttribute("aria-atomic", "true");
    preview.scrollIntoView?.({ block: "nearest" });
  }

  function arquivoSelecionadoContinuaIgual(input, arquivoPrevisto) {
    return input.files?.[0] === arquivoPrevisto;
  }

  // Disables the given controls and shows a spinner on the button; returns a function that restores them.
  function travarEnvioPlanilhas(button, mensagem, controles) {
    const modal = document.getElementById("modal-atualizar-planilhas");
    const originalHtml = button.innerHTML;
    controles.forEach(controle => { controle.disabled = true; });
    button.setAttribute("aria-busy", "true");
    modal.setAttribute("aria-busy", "true");
    const spinner = document.createElement("i");
    spinner.setAttribute("data-lucide", "loader-2");
    spinner.className = "w-3.5 h-3.5 animate-spin";
    const texto = document.createElement("span");
    texto.textContent = mensagem;
    button.replaceChildren(spinner, texto);
    lucide.createIcons({ root: button });
    return () => {
      controles.forEach(controle => { controle.disabled = false; });
      button.removeAttribute("aria-busy");
      modal.removeAttribute("aria-busy");
      button.innerHTML = originalHtml;
      lucide.createIcons({ root: button });
    };
  }

  function erroRespostaPlanilhas(error) {
    if (error.status === 404) {
      return new Error("A API ativa está desatualizada. Feche a instância anterior e reinicie com iniciar_servidor.bat desta pasta.");
    }
    return error;
  }

  function formularioArquivosPlanilhas(endpointFile, detailsFile) {
    const formData = new FormData();
    formData.append("endpoint_file", endpointFile);
    formData.append("details_file", detailsFile);
    return formData;
  }

  async function previsualizarPlanilhas() {
    const endpointInput = document.getElementById("upload-endpoint-file");
    const detailsInput = document.getElementById("upload-details-file");
    const endpointFile = endpointInput.files?.[0];
    const detailsFile = detailsInput.files?.[0];
    if (!endpointFile || !detailsFile) {
      mostrarStatusUpload("Selecione Endpoint e EquipamentosDetalhes antes de gerar a prévia.", true);
      return;
    }

    const button = document.getElementById("btn-previsualizar-planilhas");
    const destravar = travarEnvioPlanilhas(button, "Validando arquivos...", [button, endpointInput, detailsInput]);
    const formData = formularioArquivosPlanilhas(endpointFile, detailsFile);

    try {
      const result = await app.apiFetch("/api/planilhas/previsualizar", {
        method: "POST", body: formData, errorMessage: "Não foi possível gerar a prévia.",
      }).catch(error => { throw erroRespostaPlanilhas(error); });
      renderizarPreviaUploadPlanilhas(result);
      appState.previaPlanilhasAtual = {
        endpointFile,
        detailsFile,
        previewToken: result.preview_token,
      };
      document.getElementById("btn-previsualizar-planilhas").classList.add("hidden");
      document.getElementById("btn-confirmar-planilhas").classList.remove("hidden");
      mostrarEtapaPlanilhas("impacto");
      mostrarStatusUpload("Confira as contagens e confirme somente se este impacto estiver correto.");
    } catch (error) {
      console.error("Erro ao pré-visualizar planilhas:", error);
      app.limparPreviaUploadPlanilhas(false);
      mostrarStatusUpload(error.message || "Não foi possível gerar a prévia.", true);
    } finally {
      destravar();
    }
  }

  // One idempotency key per selected file pair, kept across retries until the upload succeeds.
  function chaveIdempotenciaUpload(endpointFile, detailsFile) {
    if (!inventoryUploadAttempt || inventoryUploadAttempt.endpoint !== endpointFile || inventoryUploadAttempt.details !== detailsFile) {
      inventoryUploadAttempt = { endpoint: endpointFile, details: detailsFile, key: inventoryOperationKey() };
    }
    return inventoryUploadAttempt.key;
  }

  function limparArquivosAtualizacaoPlanilhas() {
    ARQUIVOS_ATUALIZACAO_PLANILHAS.forEach(inputId => {
      const input = document.getElementById(inputId);
      input.value = "";
      redesenharSeletorArquivo(input);
    });
  }

  function avisarSelecaoAposAtualizacao(status) {
    if (status === "missing") {
      app.showToast("A série selecionada não está no inventário atualizado. Selecione outro equipamento.", "warning");
    } else if (status === "unavailable") {
      app.showToast("Não foi possível confirmar a série no inventário atualizado. Faça uma nova busca.", "warning");
    }
  }

  async function exportarHistoricoAposAtualizacao(comparison) {
    const historyDate = String(comparison.horario_comparacao || "").slice(0, 10);
    try {
      await app.baixarHistoricoComparacoesExcel(historyDate);
      app.showToast("Planilha Exportada com Sucesso!", "success");
    } catch (error) {
      console.warn("A atualização foi concluída, mas a exportação automática falhou:", error);
      app.showToast(
        `Atualização concluída, mas não foi possível exportar o histórico: ${error.message || "tente novamente pelo Histórico de Planilhas."}`,
        "warning",
      );
    }
  }

  async function concluirAtualizacaoPlanilhas(result, exportarHistoricoAutomaticamente) {
    inventoryUploadAttempt = null;
    const selectedSerial = appState.currentEquipamento?.serial || "";
    const selectionRefresh = app.atualizarSelecaoAposSubstituirInventarios(selectedSerial);
    app.fecharModalAtualizarPlanilhas();
    limparArquivosAtualizacaoPlanilhas();
    await Promise.all([
      app.carregarEstatisticas(),
      app.carregarUnidades(),
      app.carregarContagemHistoricoComparacoes(),
      app.carregarProntidao()
    ]);
    avisarSelecaoAposAtualizacao(await selectionRefresh);
    const comparison = result.comparacao || {};
    if (exportarHistoricoAutomaticamente) await exportarHistoricoAposAtualizacao(comparison);
    await app.mostrarResultadoNaAbaComparacao(comparison);
  }

  async function enviarPlanilhas() {
    const endpointInput = document.getElementById("upload-endpoint-file");
    const detailsInput = document.getElementById("upload-details-file");
    const endpointFile = endpointInput.files?.[0];
    const detailsFile = detailsInput.files?.[0];
    const exportarHistoricoAutomaticamente = document.getElementById("auto-export-history-after-update")?.checked === true;
    const preview = appState.previaPlanilhasAtual;
    if (!preview) {
      mostrarStatusUpload("Gere uma prévia dos arquivos antes de confirmar a substituição.", true);
      return;
    }
    if (
      !arquivoSelecionadoContinuaIgual(endpointInput, preview.endpointFile)
      || !arquivoSelecionadoContinuaIgual(detailsInput, preview.detailsFile)
    ) {
      app.limparPreviaUploadPlanilhas(false);
      mostrarStatusUpload("Os arquivos mudaram depois da prévia. Gere uma nova prévia antes de confirmar.", true);
      return;
    }

    const button = document.getElementById("btn-confirmar-planilhas");
    const autoExportInput = document.getElementById("auto-export-history-after-update");
    const destravar = travarEnvioPlanilhas(
      button,
      "Confirmando substituição...",
      [button, endpointInput, detailsInput, autoExportInput].filter(Boolean),
    );
    const formData = formularioArquivosPlanilhas(endpointFile, detailsFile);
    const idempotencyKey = chaveIdempotenciaUpload(endpointFile, detailsFile);
    if (preview.previewToken) formData.append("preview_token", preview.previewToken);
    let invalidarPrevia = false;

    try {
      const result = await app.apiFetch("/api/planilhas/atualizar", {
        method: "POST", body: formData, headers: { "Idempotency-Key": idempotencyKey },
        errorMessage: "Falha ao atualizar as planilhas.",
      }).catch(error => {
        if (error.status !== undefined) invalidarPrevia = error.status < 500;
        throw erroRespostaPlanilhas(error);
      });
      await concluirAtualizacaoPlanilhas(result, exportarHistoricoAutomaticamente);
    } catch (error) {
      console.error("Erro ao atualizar planilhas:", error);
      if (invalidarPrevia) app.limparPreviaUploadPlanilhas(false);
      mostrarStatusUpload(error.message || "Não foi possível atualizar as planilhas.", true);
    } finally {
      destravar();
    }
  }

  async function exportarEquipamentosAtualizados() {
    const btn = document.getElementById("btn-exportar-equipamentos");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span class="hidden sm:inline">Gerando Excel...</span>`;
    lucide.createIcons({ root: btn });

    try {
      const res = await app.apiFetch("/api/exportar-equipamentos", {
        responseType: "response",
        errorMessage: "Falha ao exportar a planilha de equipamentos.",
      });

      const disposition = res.headers.get("Content-Disposition") || "";
      const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      const filename = match && match[1]
        ? match[1].replace(/['"]/g, "")
        : "EquipamentosDetalhes-atualizados.xlsx";
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);

      app.showToast("Planilha Exportada com Sucesso!", "success");
    } catch (err) {
      console.error("Erro ao exportar planilha de equipamentos:", err);
      app.showToast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = originalText;
      lucide.createIcons({ root: btn });
    }
  }

  return {
    inicializarExportacaoAutomaticaHistorico, inicializarArquivosAtualizacaoPlanilhas, abrirImportacaoModelo,
    fecharImportacaoModelo, enviarModeloLocal, limparPreviaUploadPlanilhas, abrirModalAtualizarPlanilhas, fecharModalAtualizarPlanilhas, previsualizarPlanilhas,
    enviarPlanilhas, exportarEquipamentosAtualizados,
  };
});
