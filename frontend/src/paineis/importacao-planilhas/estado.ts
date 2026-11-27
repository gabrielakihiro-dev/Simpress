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
  /** Cancelar resolve false; Esc e fechar o diálogo resolvem null (frontend/src/aplicacao/app-shell.ts). */
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string; cancelar: string; destrutiva?: boolean }): Promise<boolean | null>;
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
  /** Uma chave de idempotência por tentativa; o padrão é a mesma que frontend/src/aplicacao/app.ts sempre gerou. */
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
// Só os inputs de arquivo (não controlados: o File e o redesenho do nome vivem no DOM, ui/file-picker.ts) são lidos assim.
function porId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ---------------------------------------------------------------------------------------------------------------------
// Estado da tela (dialogos.tsx desenha por useSyncExternalStore). A fábrica o reinicia a cada criação.
// ---------------------------------------------------------------------------------------------------------------------
export interface StatusUpload { texto: string; role?: "status" | "alert"; aoVivo?: "polite" | "assertive"; erro: boolean }
export interface EstadoTela {
  etapa: "arquivos" | "impacto";
  status: StatusUpload;
  previa: { texto: string; classe?: string };
  /** Botão e mensagem do envio em andamento; trava os controles da tela. */
  ocupado: { botao: "previa" | "confirmar"; mensagem: string } | null;
  exportarHistorico: boolean;
  /** Modal "Importar modelo": tipo ("transferencia" ou "exportacao"), status e trava do botão (aria-busy no overlay). */
  modelo: { tipo?: string; status: string; alerta: boolean; ocupado: boolean };
}

const CHAVE_EXPORTAR_HISTORICO = "simpress:auto-export-history-after-update";
const inicial = (): EstadoTela => ({
  etapa: "arquivos",
  status: { texto: "", role: "status", aoVivo: "polite", erro: false },
  previa: { texto: "" },
  ocupado: null,
  exportarHistorico: false,
  modelo: { status: "", alerta: false, ocupado: false },
});
let estado: EstadoTela = inicial();
const ouvintes = new Set<() => void>();
export const ler = (): EstadoTela => estado;
export const assinar = (ouvinte: () => void) => { ouvintes.add(ouvinte); return () => { ouvintes.delete(ouvinte); }; };
function mudar(parcial: Partial<EstadoTela>) {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}
const mudarModelo = (parcial: Partial<EstadoTela["modelo"]>) => mudar({ modelo: { ...estado.modelo, ...parcial } });

/** Checkbox "Baixar o Histórico de Planilhas automaticamente": grava no estado e na preferência deste navegador. */
export function definirExportarHistorico(valor: boolean) {
  mudar({ exportarHistorico: valor });
  try {
    window.localStorage.setItem(CHAVE_EXPORTAR_HISTORICO, valor ? "true" : "false");
  } catch (error) {
    console.warn("Não foi possível salvar a preferência de exportação automática do histórico.", error);
  }
}

/** Arquivos do inventário: Simpress + Endpoint com prévia, modelos importados e a exportação de equipamentos atualizados. */
export function criarImportacaoPlanilhas(context: ContextoImportacaoPlanilhas) {
  const { app, appState, apiFetch } = context;
  const inventoryOperationKey = context.inventoryOperationKey ?? chaveOperacaoInventario;

  let inventoryUploadAttempt: { endpoint: File | undefined; details: File | undefined; key: string } | null = null;
  // Travas síncronas: o disabled do React só vale depois do commit e um duplo clique rápido mandaria dois POST.
  let planilhasOcupadas = false;
  estado = inicial();
  ouvintes.forEach(ouvinte => ouvinte());

  function inicializarExportacaoAutomaticaHistorico() {
    try {
      mudar({ exportarHistorico: window.localStorage.getItem(CHAVE_EXPORTAR_HISTORICO) === "true" });
    } catch (error) {
      console.warn("Não foi possível ler a preferência de exportação automática do histórico.", error);
    }
  }

  const ARQUIVOS_ATUALIZACAO_PLANILHAS = ["upload-endpoint-file", "upload-details-file", "entra-csv-file"];

  // O nome e o estado do arquivo são desenhados por ui/file-picker.ts a partir do evento change.
  function redesenharSeletorArquivo(input: HTMLElement) {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Escolher ou remover arquivo limpa a prévia: onChange dos dois inputs em dialogos.tsx (antes, ouvintes aqui). Fica na ponte por contrato.
  function inicializarArquivosAtualizacaoPlanilhas() {}

  // ==========================================
  // RECARREGAR / SINCRONIZAR PLANILHA BASE
  // ==========================================
  let importacaoModeloOcupada = false;

  function abrirImportacaoModelo(tipo: string) {
    if (importacaoModeloOcupada) return;
    // Título, descrição e data-tipo do overlay saem de modelo.tipo (dialogos.tsx).
    mudarModelo({ tipo, status: "" });
    const modelFile = porId<HTMLInputElement>("arquivo-modelo-local");
    modelFile.value = "";
    redesenharSeletorArquivo(modelFile);
    app.abrirModalAcessivel("modal-importar-modelo", "#arquivo-modelo-local", "fecharImportacaoModelo");
  }

  function fecharImportacaoModelo() {
    if (!importacaoModeloOcupada) app.fecharModalAcessivel("modal-importar-modelo");
  }

  async function enviarModeloLocal() {
    if (importacaoModeloOcupada) return;
    const file = porId<HTMLInputElement>("arquivo-modelo-local").files?.[0];
    if (!file) { mudarModelo({ alerta: false, status: "Selecione um modelo .xlsx." }); return; }
    importacaoModeloOcupada = true;
    mudarModelo({ ocupado: true, alerta: false, status: "Validando e importando o modelo…" });
    const data = new FormData();
    data.append("file", file);
    try {
      await apiFetch(`/api/modelos/${estado.modelo.tipo}/importar`, { method: "POST", body: data, errorMessage: "Não foi possível importar o modelo." });
      mudarModelo({ status: "Modelo importado. Confira abaixo se todas as dependências estão disponíveis." });
      const modelFile = porId<HTMLInputElement>("arquivo-modelo-local");
      modelFile.value = "";
      redesenharSeletorArquivo(modelFile);
      // The file replacement has completed; let the user dismiss the modal
      // while readiness and the other secondary panels finish refreshing.
      importacaoModeloOcupada = false;
      await Promise.allSettled([app.carregarProntidao(), app.carregarEstatisticas(), app.carregarUnidades()]);
      app.showToast("Modelo validado e importado.", "success");
    } catch (error) {
      mudarModelo({ alerta: true, status: (error as ErroApi).message || "Não foi possível importar o modelo." });
    } finally {
      importacaoModeloOcupada = false;
      mudarModelo({ ocupado: false });
    }
  }

  function limparPreviaUploadPlanilhas(limparStatus = true) {
    appState.previaPlanilhasAtual = null;
    mudar({
      previa: { texto: "", classe: "hidden" },
      etapa: "arquivos",
      ...(limparStatus ? { status: { texto: "", erro: false } } : {}),
    });
  }

  function abrirModalAtualizarPlanilhas() {
    limparPreviaUploadPlanilhas();
    app.abrirModalAcessivel("modal-atualizar-planilhas", "#upload-endpoint-file", "fecharModalAtualizarPlanilhas");
  }

  function fecharModalAtualizarPlanilhas() {
    limparPreviaUploadPlanilhas();
    app.fecharModalAcessivel("modal-atualizar-planilhas");
  }

  // O scrollIntoView do erro fica no efeito de dialogos.tsx (status.erro).
  function mostrarStatusUpload(mensagem: string, erro = false) {
    mudar({ status: { texto: mensagem, role: erro ? "alert" : "status", aoVivo: erro ? "assertive" : "polite", erro } });
  }

  function textoPreviaUploadPlanilhas(result: ResultadoPrevia | null | undefined): string {
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
    return linhas.join("\n");
  }

  function arquivoSelecionadoContinuaIgual(input: HTMLInputElement, arquivoPrevisto: File | undefined) {
    return input.files?.[0] === arquivoPrevisto;
  }

  // Trava a tela (botão com spinner, inputs e checkbox via estado.ocupado) e devolve a função que a libera.
  function travarEnvioPlanilhas(botao: "previa" | "confirmar", mensagem: string) {
    planilhasOcupadas = true;
    mudar({ ocupado: { botao, mensagem } });
    return () => {
      planilhasOcupadas = false;
      mudar({ ocupado: null });
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
    if (planilhasOcupadas) return;
    const endpointInput = porId<HTMLInputElement>("upload-endpoint-file");
    const detailsInput = porId<HTMLInputElement>("upload-details-file");
    const endpointFile = endpointInput.files?.[0];
    const detailsFile = detailsInput.files?.[0];
    if (!endpointFile || !detailsFile) {
      mostrarStatusUpload("Selecione Endpoint e EquipamentosDetalhes antes de gerar a prévia.", true);
      return;
    }

    const destravar = travarEnvioPlanilhas("previa", "Validando arquivos...");
    const formData = formularioArquivosPlanilhas(endpointFile, detailsFile);

    try {
      const result = await apiFetch<ResultadoPrevia>("/api/planilhas/previsualizar", {
        method: "POST", body: formData, errorMessage: "Não foi possível gerar a prévia.",
      }).catch((error: ErroApi) => { throw erroRespostaPlanilhas(error); });
      const textoPrevia = textoPreviaUploadPlanilhas(result);
      appState.previaPlanilhasAtual = {
        endpointFile,
        detailsFile,
        previewToken: result.preview_token,
      };
      // Etapa "impacto": dialogos.tsx esconde "Pré-visualizar impacto" e mostra "Confirmar substituição" e "Voltar".
      mudar({
        previa: { texto: textoPrevia, classe: "whitespace-pre-line" },
        etapa: "impacto",
        status: { texto: "Confira as contagens e confirme somente se este impacto estiver correto.", role: "status", aoVivo: "polite", erro: false },
      });
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
    if (planilhasOcupadas) return;
    const endpointInput = porId<HTMLInputElement>("upload-endpoint-file");
    const detailsInput = porId<HTMLInputElement>("upload-details-file");
    const endpointFile = endpointInput.files?.[0];
    const detailsFile = detailsInput.files?.[0];
    const exportarHistoricoAutomaticamente = estado.exportarHistorico;
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

    const destravar = travarEnvioPlanilhas("confirmar", "Confirmando substituição...");
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

  // Escrita no UX Simpress (sistema externo): só depois do download e só com o clique em "Enviar ao UX".
  async function enviarApelidosAoUx(blob: Blob, filename: string) {
    const resposta = await app.confirmarAcao({
      titulo: "Enviar ao UX Simpress?",
      mensagem: "Atualiza apelidos e IdCliente no UX Simpress (sistema externo).",
      confirmar: "Enviar ao UX",
      cancelar: "Cancelar",
      destrutiva: false,
    });
    // Cancelar resolve false e Esc resolve null: nos dois a planilha já foi baixada e nada é enviado.
    if (resposta !== true) return;
    try {
      const form = new FormData();
      form.append("file", blob, filename);
      form.append("confirmado", "true"); // só depois do diálogo acima
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
  }

  // Continua imperativo, de propósito: #btn-exportar-equipamentos vive no partial de outro painel (cockpit-tool-panels)
  // e o fluxo termina na confirmação e no envio ao UX (escrita em sistema externo, acima).
  async function exportarEquipamentosAtualizados() {
    const btn = porId<HTMLButtonElement>("btn-exportar-equipamentos");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span class="hidden sm:inline">Gerando Excel...</span>`;
    lucide.createIcons({ root: btn });

    let blob: Blob;
    let filename: string;
    try {
      const res = await apiFetch("/api/exportar-equipamentos", {
        responseType: "response",
        errorMessage: "Falha ao exportar a planilha de equipamentos.",
      });

      const disposition = res.headers.get("Content-Disposition") || "";
      const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      filename = match && match[1]
        ? match[1].replace(/['"]/g, "")
        : "EquipamentosDetalhes-atualizados.xlsx";
      blob = await res.blob();
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
      app.showToast((err as ErroApi).message, "error");
      return;
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.innerHTML = originalText;
      lucide.createIcons({ root: btn });
    }

    await enviarApelidosAoUx(blob, filename);
  }

  return {
    inicializarExportacaoAutomaticaHistorico, inicializarArquivosAtualizacaoPlanilhas, abrirImportacaoModelo,
    fecharImportacaoModelo, enviarModeloLocal, limparPreviaUploadPlanilhas, abrirModalAtualizarPlanilhas, fecharModalAtualizarPlanilhas, previsualizarPlanilhas,
    enviarPlanilhas, exportarEquipamentosAtualizados,
  };
}
