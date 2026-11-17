import type { apiFetch as ApiFetch } from "../../api";
import type { EstadoApp } from "../../estado-app";

interface PreviaPlanilhas {
  endpointFile: File | undefined;
  detailsFile: File | undefined;
  previewToken?: string;
}
interface EstadoImportacao extends Omit<EstadoApp, "currentEquipamento" | "previaPlanilhasAtual"> {
  currentEquipamento: { serial?: string } | null;
  previaPlanilhasAtual: PreviaPlanilhas | null;
}
interface AppImportacao {
  abrirModalAcessivel(modalId: string, focoInicial: string, acaoFechar: string): void;
  fecharModalAcessivel(modalId: string): void;
  showToast(mensagem: string, tipo: string): void;
  carregarProntidao(): Promise<unknown>;
  carregarEstatisticas(): Promise<unknown>;
  carregarUnidades(): Promise<unknown>;
  carregarContagemHistoricoComparacoes(): Promise<unknown>;
  atualizarSelecaoAposSubstituirInventarios(serial: string): Promise<string>;
  baixarHistoricoComparacoesExcel(data: string): Promise<unknown>;
  mostrarResultadoNaAbaComparacao(comparacao: unknown): unknown;
  acompanharExecucaoAutomacao?(execucao: unknown): void;
}
export interface ContextoImportacaoPlanilhas {
  app: AppImportacao;
  appState: EstadoImportacao;
  apiFetch: typeof ApiFetch;
  /** Uma chave de idempotência por tentativa; o padrão é a mesma que frontend/src/legado/app.js sempre gerou. */
  inventoryOperationKey?: () => string;
}
type ErroApi = Error & { status?: number };
interface ArquivoPrevia { nome?: string; linhas?: unknown }
interface AlteracaoPrevia {
  series_novas?: unknown;
  series_removidas?: unknown;
  series_duplicadas_no_arquivo_novo?: unknown;
}
interface ResultadoPrevia {
  preview_token?: string;
  arquivos?: Record<string, ArquivoPrevia>;
  alteracoes?: Record<string, AlteracaoPrevia>;
}
interface ResultadoAtualizacao {
  comparacao?: { horario_comparacao?: string };
}
type ExecucaoUx = unknown;

export function chaveOperacaoInventario(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Os elementos vêm do HTML montado; faltar um é erro de marcação e estoura no primeiro uso, como no código antigo.
function porId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Arquivos do inventário: Simpress + Endpoint com prévia, modelos importados e a exportação de equipamentos atualizados. */
export function criarImportacaoPlanilhas(context: ContextoImportacaoPlanilhas) {
  const { app, appState, apiFetch } = context;
  const inventoryOperationKey = context.inventoryOperationKey ?? chaveOperacaoInventario;

  let inventoryUploadAttempt: { endpoint: File | undefined; details: File | undefined; key: string } | null = null;

  function inicializarExportacaoAutomaticaHistorico() {
    const input = document.getElementById("auto-export-history-after-update") as HTMLInputElement | null;
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
  function redesenharSeletorArquivo(input: HTMLElement) {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function inicializarArquivosAtualizacaoPlanilhas() {
    ["upload-endpoint-file", "upload-details-file"].forEach(inputId => {
      document.getElementById(inputId)?.addEventListener("change", () => limparPreviaUploadPlanilhas());
    });
  }

  function mostrarEtapaPlanilhas(etapa: string) {
    document.getElementById("modal-atualizar-planilhas")?.querySelectorAll?.<HTMLElement>("[data-so-etapa]").forEach(el => {
      el.hidden = el.dataset.soEtapa !== etapa;
    });
    document.getElementById("btn-voltar-planilhas")?.classList.toggle("hidden", etapa !== "impacto");
  }

  // ==========================================
  // RECARREGAR / SINCRONIZAR PLANILHA BASE
  // ==========================================
  let importacaoModeloOcupada = false;

  function abrirImportacaoModelo(tipo: string) {
    if (importacaoModeloOcupada) return;
    const modal = porId("modal-importar-modelo");
    modal.dataset.tipo = tipo;
    porId("titulo-importar-modelo").textContent = tipo === "transferencia"
      ? "Arquivos para transferência" : "Arquivos para exportação";
    porId("descricao-importar-modelo").textContent = (tipo === "transferencia"
      ? "A base Simpress + Endpoint é compartilhada. Se necessário, atualize-a no painel de disponibilidade; aqui, importe o modelo oficial de transferência da Simpress."
      : "Importe a planilha do modelo de exportação que atualiza os apelidos/hostnames.")
      + " Ao substituir um modelo importado, uma cópia anterior é guardada nos backups locais. O modelo de transferência incluído no projeto é preservado.";
    const modelFile = porId<HTMLInputElement>("arquivo-modelo-local");
    modelFile.value = "";
    redesenharSeletorArquivo(modelFile);
    porId("status-modelo-local").textContent = "";
    app.abrirModalAcessivel("modal-importar-modelo", "#arquivo-modelo-local", "fecharImportacaoModelo");
  }

  function fecharImportacaoModelo() {
    if (!importacaoModeloOcupada) app.fecharModalAcessivel("modal-importar-modelo");
  }

  async function enviarModeloLocal() {
    if (importacaoModeloOcupada) return;
    const modal = porId("modal-importar-modelo");
    const file = porId<HTMLInputElement>("arquivo-modelo-local").files?.[0];
    const status = porId("status-modelo-local");
    status.setAttribute("role", "status");
    if (!file) { status.textContent = "Selecione um modelo .xlsx."; return; }
    const button = porId<HTMLButtonElement>("btn-importar-modelo");
    importacaoModeloOcupada = true;
    button.disabled = true;
    modal.setAttribute("aria-busy", "true");
    status.textContent = "Validando e importando o modelo…";
    const data = new FormData();
    data.append("file", file);
    try {
      await apiFetch(`/api/modelos/${modal.dataset.tipo}/importar`, { method: "POST", body: data, errorMessage: "Não foi possível importar o modelo." });
      status.textContent = "Modelo importado. Confira abaixo se todas as dependências estão disponíveis.";
      const modelFile = porId<HTMLInputElement>("arquivo-modelo-local");
      modelFile.value = "";
      redesenharSeletorArquivo(modelFile);
      // The file replacement has completed; let the user dismiss the modal
      // while readiness and the other secondary panels finish refreshing.
      importacaoModeloOcupada = false;
      await Promise.allSettled([app.carregarProntidao(), app.carregarEstatisticas(), app.carregarUnidades()]);
      app.showToast("Modelo validado e importado.", "success");
    } catch (error) {
      status.setAttribute("role", "alert");
      status.textContent = (error as ErroApi).message || "Não foi possível importar o modelo.";
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
      const status = porId("upload-planilhas-status");
      status.textContent = "";
      status.className = "ckp-rodape__status";
      status.removeAttribute("role");
      status.removeAttribute("aria-live");
    }
  }

  function abrirModalAtualizarPlanilhas() {
    limparPreviaUploadPlanilhas();
    app.abrirModalAcessivel("modal-atualizar-planilhas", "#upload-endpoint-file", "fecharModalAtualizarPlanilhas");
  }

  function fecharModalAtualizarPlanilhas() {
    limparPreviaUploadPlanilhas();
    app.fecharModalAcessivel("modal-atualizar-planilhas");
  }

  function mostrarStatusUpload(mensagem: string, erro = false) {
    const status = porId("upload-planilhas-status");
    status.textContent = mensagem;
    status.setAttribute("role", erro ? "alert" : "status");
    status.setAttribute("aria-live", erro ? "assertive" : "polite");
    status.setAttribute("aria-atomic", "true");
    status.className = "ckp-rodape__status";
    if (erro) status.scrollIntoView?.({ block: "nearest" });
  }

  function renderizarPreviaUploadPlanilhas(result: ResultadoPrevia | null | undefined) {
    if (!result?.preview_token || !result?.arquivos || !result?.alteracoes) {
      throw new Error("A prévia recebida está incompleta. Gere uma nova prévia.");
    }
    const labels: Record<string, string> = {
      endpoint: "Endpoint",
      detalhes: "Simpress",
    };
    const linhas = ["Resumo da substituição (contagens por número de série):"];
    for (const role of ["endpoint", "detalhes"]) {
      const arquivo: ArquivoPrevia = result.arquivos[role] || {};
      const alteracao: AlteracaoPrevia = result.alteracoes[role] || {};
      const formatar = (valor: unknown) => Number(valor || 0).toLocaleString("pt-BR");
      linhas.push(
        `${labels[role]} — ${arquivo.nome || "arquivo selecionado"} (${formatar(arquivo.linhas)} linhas)`,
        `Séries novas: ${formatar(alteracao.series_novas)}; removidas: ${formatar(alteracao.series_removidas)}; duplicadas no arquivo novo: ${formatar(alteracao.series_duplicadas_no_arquivo_novo)}.`
      );
    }
    const preview = porId("upload-planilhas-preview");
    preview.textContent = linhas.join("\n");
    preview.className = "whitespace-pre-line";
    preview.setAttribute("role", "status");
    preview.setAttribute("aria-live", "polite");
    preview.setAttribute("aria-atomic", "true");
    preview.scrollIntoView?.({ block: "nearest" });
  }

  function arquivoSelecionadoContinuaIgual(input: HTMLInputElement, arquivoPrevisto: File | undefined) {
    return input.files?.[0] === arquivoPrevisto;
  }

  // Disables the given controls and shows a spinner on the button; returns a function that restores them.
  function travarEnvioPlanilhas(button: HTMLElement, mensagem: string, controles: Array<HTMLElement & { disabled: boolean }>) {
    const modal = porId("modal-atualizar-planilhas");
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

  function erroRespostaPlanilhas(error: ErroApi): Error {
    if (error.status === 404) {
      return new Error("A API ativa está desatualizada. Feche a instância anterior e reinicie com iniciar_servidor.bat desta pasta.");
    }
    return error;
  }

  function formularioArquivosPlanilhas(endpointFile: File, detailsFile: File) {
    const formData = new FormData();
    formData.append("endpoint_file", endpointFile);
    formData.append("details_file", detailsFile);
    return formData;
  }

  async function previsualizarPlanilhas() {
    const endpointInput = porId<HTMLInputElement>("upload-endpoint-file");
    const detailsInput = porId<HTMLInputElement>("upload-details-file");
    const endpointFile = endpointInput.files?.[0];
    const detailsFile = detailsInput.files?.[0];
    if (!endpointFile || !detailsFile) {
      mostrarStatusUpload("Selecione Endpoint e EquipamentosDetalhes antes de gerar a prévia.", true);
      return;
    }

    const button = porId<HTMLButtonElement>("btn-previsualizar-planilhas");
    const destravar = travarEnvioPlanilhas(button, "Validando arquivos...", [button, endpointInput, detailsInput]);
    const formData = formularioArquivosPlanilhas(endpointFile, detailsFile);

    try {
      const result = await apiFetch<ResultadoPrevia>("/api/planilhas/previsualizar", {
        method: "POST", body: formData, errorMessage: "Não foi possível gerar a prévia.",
      }).catch((error: ErroApi) => { throw erroRespostaPlanilhas(error); });
      renderizarPreviaUploadPlanilhas(result);
      appState.previaPlanilhasAtual = {
        endpointFile,
        detailsFile,
        previewToken: result.preview_token,
      };
      porId("btn-previsualizar-planilhas").classList.add("hidden");
      porId("btn-confirmar-planilhas").classList.remove("hidden");
      mostrarEtapaPlanilhas("impacto");
      mostrarStatusUpload("Confira as contagens e confirme somente se este impacto estiver correto.");
    } catch (error) {
      console.error("Erro ao pré-visualizar planilhas:", error);
      limparPreviaUploadPlanilhas(false);
      mostrarStatusUpload((error as ErroApi).message || "Não foi possível gerar a prévia.", true);
    } finally {
      destravar();
    }
  }

  // One idempotency key per selected file pair, kept across retries until the upload succeeds.
  function chaveIdempotenciaUpload(endpointFile: File | undefined, detailsFile: File | undefined) {
    if (!inventoryUploadAttempt || inventoryUploadAttempt.endpoint !== endpointFile || inventoryUploadAttempt.details !== detailsFile) {
      inventoryUploadAttempt = { endpoint: endpointFile, details: detailsFile, key: inventoryOperationKey() };
    }
    return inventoryUploadAttempt.key;
  }

  function limparArquivosAtualizacaoPlanilhas() {
    ARQUIVOS_ATUALIZACAO_PLANILHAS.forEach(inputId => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      if (!input) return; // #entra-csv-file só existe se o painel entra-users montou; faltar não pode quebrar a conclusão
      input.value = "";
      redesenharSeletorArquivo(input);
    });
  }

  function avisarSelecaoAposAtualizacao(status: string) {
    if (status === "missing") {
      app.showToast("A série selecionada não está no inventário atualizado. Selecione outro equipamento.", "warning");
    } else if (status === "unavailable") {
      app.showToast("Não foi possível confirmar a série no inventário atualizado. Faça uma nova busca.", "warning");
    }
  }

  async function exportarHistoricoAposAtualizacao(comparison: NonNullable<ResultadoAtualizacao["comparacao"]>) {
    const historyDate = String(comparison.horario_comparacao || "").slice(0, 10);
    try {
      await app.baixarHistoricoComparacoesExcel(historyDate);
      app.showToast("Planilha Exportada com Sucesso!", "success");
    } catch (error) {
      console.warn("A atualização foi concluída, mas a exportação automática falhou:", error);
      app.showToast(
        `Atualização concluída, mas não foi possível exportar o histórico: ${(error as ErroApi).message || "tente novamente pelo Histórico de Planilhas."}`,
        "warning",
      );
    }
  }

  async function concluirAtualizacaoPlanilhas(result: ResultadoAtualizacao, exportarHistoricoAutomaticamente: boolean) {
    inventoryUploadAttempt = null;
    const selectedSerial = appState.currentEquipamento?.serial || "";
    const selectionRefresh = app.atualizarSelecaoAposSubstituirInventarios(selectedSerial);
    fecharModalAtualizarPlanilhas();
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
    const endpointInput = porId<HTMLInputElement>("upload-endpoint-file");
    const detailsInput = porId<HTMLInputElement>("upload-details-file");
    const endpointFile = endpointInput.files?.[0];
    const detailsFile = detailsInput.files?.[0];
    const autoExportInput = document.getElementById("auto-export-history-after-update") as HTMLInputElement | null;
    const exportarHistoricoAutomaticamente = autoExportInput?.checked === true;
    const preview = appState.previaPlanilhasAtual;
    if (!preview) {
      mostrarStatusUpload("Gere uma prévia dos arquivos antes de confirmar a substituição.", true);
      return;
    }
    if (
      !arquivoSelecionadoContinuaIgual(endpointInput, preview.endpointFile)
      || !arquivoSelecionadoContinuaIgual(detailsInput, preview.detailsFile)
    ) {
      limparPreviaUploadPlanilhas(false);
      mostrarStatusUpload("Os arquivos mudaram depois da prévia. Gere uma nova prévia antes de confirmar.", true);
      return;
    }

    const button = porId<HTMLButtonElement>("btn-confirmar-planilhas");
    const destravar = travarEnvioPlanilhas(
      button,
      "Confirmando substituição...",
      [button, endpointInput, detailsInput, autoExportInput].filter((controle): controle is HTMLInputElement | HTMLButtonElement => Boolean(controle)),
    );
    // Os dois arquivos existem: a prévia só vale enquanto a seleção continua igual (conferido acima).
    const formData = formularioArquivosPlanilhas(endpointFile as File, detailsFile as File);
    const idempotencyKey = chaveIdempotenciaUpload(endpointFile, detailsFile);
    if (preview.previewToken) formData.append("preview_token", preview.previewToken);
    let invalidarPrevia = false;

    try {
      const result = await apiFetch<ResultadoAtualizacao>("/api/planilhas/atualizar", {
        method: "POST", body: formData, headers: { "Idempotency-Key": idempotencyKey },
        errorMessage: "Falha ao atualizar as planilhas.",
      }).catch((error: ErroApi) => {
        if (error.status !== undefined) invalidarPrevia = error.status < 500;
        throw erroRespostaPlanilhas(error);
      });
      await concluirAtualizacaoPlanilhas(result, exportarHistoricoAutomaticamente);
    } catch (error) {
      console.error("Erro ao atualizar planilhas:", error);
      if (invalidarPrevia) limparPreviaUploadPlanilhas(false);
      mostrarStatusUpload((error as ErroApi).message || "Não foi possível atualizar as planilhas.", true);
    } finally {
      destravar();
    }
  }

  async function exportarEquipamentosAtualizados() {
    const btn = porId<HTMLButtonElement>("btn-exportar-equipamentos");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span class="hidden sm:inline">Gerando Excel...</span>`;
    lucide.createIcons({ root: btn });

    try {
      const res = await apiFetch("/api/exportar-equipamentos", {
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
      try {
        const form = new FormData();
        form.append("file", blob, filename);
        const execucao = await apiFetch<ExecucaoUx>("/api/automacao/ux-apelidos", {
          method: "POST", body: form,
          errorMessage: "Não foi possível iniciar a atualização no UX Simpress.",
        });
        app.showToast("Atualização no UX Simpress iniciada. Acompanhe o resultado e o login em Automação (F4).", "info");
        app.acompanharExecucaoAutomacao?.(execucao);
      } catch (error) {
        const erro = error as ErroApi;
        const status = Number(erro?.status);
        if (status >= 400 && status < 500) {
          app.showToast(`Atualização no UX Simpress não iniciada: ${erro.message}`, "error");
        } else {
          app.showToast(`Não foi possível confirmar o início da atualização no UX Simpress. Consulte Automação (F4) antes de tentar novamente. ${erro.message}`, "error");
        }
      }
    } catch (err) {
      console.error("Erro ao exportar planilha de equipamentos:", err);
      app.showToast((err as ErroApi).message, "error");
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
}
