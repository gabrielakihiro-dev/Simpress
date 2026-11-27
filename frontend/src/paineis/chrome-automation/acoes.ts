// Ações da aba Automação (F5). Cada função é a que o HTML chama por data-on-* (pela ponte em
// frontend/src/aplicacao/pontes.ts). Elas só mexem no store (estado.ts); quem desenha são os componentes.
import { carregarAgendamentoDashboard } from "./agendamento";
import { appAntigo, avisarErro, consultarAutomacao, valor } from "./consulta";
import { interno, ler, mudar } from "./estado";
import { atualizarBotoesExternos, botaoExterno, mostrarChip, semEstadoReal } from "./fora";
import {
  dataLocalIso, descreverEstado, limitarPagina, MAX_LINHAS, POLL_ATIVO_MS, POLL_LIVRE_MS, resumoDoHistorico, ROTINAS,
  ROTINAS_DOS_CARTOES, textoResultado, verBackupsDepois, osImportadaAoTerminar, type DadosEstado, type Execucao, type LogHistorico,
} from "./regras-puro";

interface RespostaHistorico { execucoes?: Execucao[]; pagina?: number; paginas?: number; total?: number }

const painel = () => document.getElementById("tab-panel-automacao");

function painelVisivel(): boolean {
  const elemento = painel();
  return Boolean(elemento) && !elemento!.hidden && document.visibilityState !== "hidden";
}

function agendar() {
  clearTimeout(interno.timer);
  // Sem a aba aberta o polling para, a menos que uma rotina recém-iniciada ainda precise ser acompanhada até o fim.
  if (!painelVisivel() && !interno.acompanharFim) { semEstadoReal(); return; }
  interno.timer = window.setTimeout(atualizarEstadoAutomacao, ler().emAndamento ? POLL_ATIVO_MS : POLL_LIVRE_MS);
}

const avisarResultado = (ultima: Execucao) => appAntigo().showToast?.(textoResultado(ultima), ultima.status === "concluido" ? "success" : "error");

function atualizarBotoes() {
  mudar({ botoesProntos: true });
  atualizarBotoesExternos(ler());
}

function mostrarLog() { mudar({ logMostrado: true, logErro: null }); }

function acrescentarLinhas(log: DadosEstado["log"]) {
  if (!log) return;
  const atual = ler();
  const base = log.reiniciado || log.arquivo !== atual.arquivo ? [] : atual.linhasAoVivo;
  interno.offset = Number(log.offset) || 0;
  mudar({ arquivo: log.arquivo || "", linhasAoVivo: base.concat(Array.isArray(log.linhas) ? log.linhas : []).slice(-MAX_LINHAS) });
  if (!ler().execucaoSelecionada) mostrarLog();
}

function aplicarEstado(dados: DadosEstado) {
  const antes = ler();
  const estavaAtivo = antes.emAndamento;
  const rotinaAnterior = antes.rotinaAtiva;
  const emAndamento = dados.estado === "em_andamento";
  // Requests first: rendering up to 64 KB of log lines below would delay them on the first open.
  const ultimaId = dados.ultima?.id || "";
  if (ultimaId !== interno.ultimaExecucaoId || estavaAtivo !== emAndamento) {
    interno.ultimaExecucaoId = ultimaId;
    void carregarHistoricoAutomacao();
    void carregarUltimasPorRotina();
  }
  const descricao = descreverEstado(dados);
  mudar({ emAndamento, rotinaAtiva: emAndamento ? (dados.rotina || "") : "", descricao });
  mostrarChip(descricao);
  acrescentarLinhas(dados.log);
  atualizarBotoes();
  const verBackups = verBackupsDepois({ emAndamento, estavaAtivo, rotinaAnterior, statusUltima: dados.ultima?.status });
  if (verBackups !== null) mudar({ verBackups });
  if (estavaAtivo && !emAndamento && ["sebrae", "dashboard", "enviar"].includes(rotinaAnterior)) appAntigo().carregarNovosSebrae?.();
  if (osImportadaAoTerminar({ emAndamento, estavaAtivo, rotinaAnterior })) document.dispatchEvent(new CustomEvent("simpress:chamados-atualizados"));
  if (estavaAtivo && !emAndamento && interno.acompanharFim) {
    interno.acompanharFim = false;
    if (dados.ultima) avisarResultado(dados.ultima);
  }
}

async function carregarUltimasPorRotina() {
  const consulta = ++interno.consultaUltimas;
  const novo: Record<string, Execucao | null> = {};
  try {
    // One request for every card; the server answers from its cached history.
    const dados = await consultarAutomacao<{ ultimas?: Record<string, Execucao | null> }>(
      `/api/automacao/historico/ultimas?${new URLSearchParams(ROTINAS_DOS_CARTOES.map(rotina => ["rotina", rotina]))}`,
      { errorMessage: "Não foi possível consultar a última execução." },
    );
    for (const rotina of ROTINAS_DOS_CARTOES) novo[rotina] = dados.ultimas?.[rotina] || null;
  } catch {
    for (const rotina of ROTINAS_DOS_CARTOES) novo[rotina] = null;
  }
  if (consulta === interno.consultaUltimas) mudar({ ultimasPorRotina: novo });
}

export async function atualizarEstadoAutomacao(): Promise<void> {
  clearTimeout(interno.timer);
  try {
    const dados = await consultarAutomacao<DadosEstado>(
      `/api/automacao/estado?${new URLSearchParams({ offset: String(interno.offset), arquivo: ler().arquivo })}`,
      { errorMessage: "Não foi possível consultar a automação." },
    );
    aplicarEstado(dados);
    await carregarAgendamentoDashboard();
  } catch (erro) {
    semEstadoReal();
    console.error("Erro ao consultar a automação:", erro);
  } finally {
    agendar();
  }
}

export async function acompanharExecucaoAutomacao(dados: DadosEstado): Promise<void> {
  interno.acompanharFim = dados.estado === "em_andamento";
  aplicarEstado(dados);
  if (!interno.acompanharFim && dados.ultima) avisarResultado(dados.ultima);
  agendar();
}

function acompanharRotina() {
  const eventos = document.getElementById("cockpit-automation-events");
  eventos?.scrollIntoView({ block: "nearest" });
  eventos?.focus({ preventScroll: true });
}

export async function iniciarRotinaAutomacao(rotina: string): Promise<void> {
  const atual = ler();
  if (!ROTINAS[rotina] || atual.ocupado) return;
  if (atual.emAndamento) {
    if (atual.rotinaAtiva === rotina) acompanharRotina();
    return;
  }
  mudar({ ocupado: true, iniciando: rotina });
  atualizarBotoes();
  // Os botões da aba levam aria-busy pelo estado "iniciando"; os de outras telas (Sebrae) recebem aqui.
  const externo = botaoExterno(rotina);
  externo?.setAttribute("aria-busy", "true");
  try {
    // Escrita no SharePoint (sistema externo): só depois do diálogo; Cancelar (false) e Esc (null) não enviam nada.
    if (rotina === "enviar") {
      const resposta = await appAntigo().confirmarAcao?.({
        titulo: "Enviar ao SharePoint?",
        mensagem: "Substitui o Dashboard no SharePoint (sistema externo) pela cópia atualizada.",
        confirmar: "Enviar ao SharePoint",
        cancelar: "Cancelar",
        destrutiva: false,
      });
      if (resposta !== true) return;
    }
    const dados = await consultarAutomacao<DadosEstado>("/api/automacao/executar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rotina === "enviar" ? { rotina, confirmado: true } : { rotina }),
      errorMessage: "Não foi possível iniciar a rotina.",
    });
    interno.acompanharFim = true;
    appAntigo().showToast?.(`${ROTINAS[rotina]} iniciada.`, "success");
    aplicarEstado(dados);
  } catch (erro) {
    console.error("Erro ao iniciar a automação:", erro);
    avisarErro(erro);
  } finally {
    mudar({ ocupado: false, iniciando: "" });
    externo?.removeAttribute("aria-busy");
    atualizarBotoes();
    void atualizarEstadoAutomacao();
  }
}

export async function cancelarRotinaAutomacao(): Promise<void> {
  const atual = ler();
  if (atual.ocupado || !atual.emAndamento) return;
  mudar({ ocupado: true });
  atualizarBotoes();
  try {
    const dados = await consultarAutomacao<{ mensagem?: string; estado?: DadosEstado }>("/api/automacao/cancelar", {
      method: "POST",
      errorMessage: "Não foi possível cancelar a rotina.",
    });
    appAntigo().showToast?.(dados.mensagem || "Cancelamento pedido.", "success");
    if (dados.estado) aplicarEstado(dados.estado);
  } catch (erro) {
    console.error("Erro ao cancelar a automação:", erro);
    avisarErro(erro);
  } finally {
    mudar({ ocupado: false });
    atualizarBotoes();
    void atualizarEstadoAutomacao();
  }
}

export async function alterarLimiteLogAutomacao(): Promise<void> {
  mudar({ limiteLog: Number(valor("automacao-log-limite")) || 200 });
  mostrarLog();
}

export async function selecionarLogAutomacao(id: string): Promise<void> {
  if (!id) return;
  const consulta = ++interno.consultaLog;
  mudar({ execucaoSelecionada: id, logHistorico: null });
  mostrarLog();
  try {
    const dados = await consultarAutomacao<LogHistorico>(`/api/automacao/execucoes/${encodeURIComponent(id)}/log?linhas=500`, {
      errorMessage: "Não foi possível abrir o log selecionado.",
    });
    if (consulta !== interno.consultaLog) return;
    mudar({ logHistorico: dados });
    mostrarLog();
  } catch (erro) {
    if (consulta !== interno.consultaLog) return;
    mudar({ logErro: (erro as Error).message });
  }
}

export async function voltarAoVivoAutomacao(): Promise<void> {
  ++interno.consultaLog;
  mudar({ execucaoSelecionada: "", logHistorico: null, versaoOpcoes: ler().versaoOpcoes + 1 });
  mostrarLog();
  await atualizarEstadoAutomacao();
}

async function consultarExecucoesLog(): Promise<void> {
  const consulta = ++interno.consultaOpcoes;
  const data = valor("automacao-log-data");
  mudar({
    opcoes: data ? { tipo: "carregando", itens: [], texto: "Carregando execuções…" } : { tipo: "sem-data", itens: [], texto: "Selecione uma data" },
    logPaginasVisivel: false,
  });
  if (!data) return;
  try {
    const dados = await consultarAutomacao<RespostaHistorico>(
      `/api/automacao/historico?${new URLSearchParams({ limite: "20", pagina: String(interno.logPagina), data_inicio: data, data_fim: data })}`,
      { errorMessage: "Não foi possível listar as execuções desta data." },
    );
    if (consulta !== interno.consultaOpcoes) return;
    const itens = dados.execucoes || [];
    interno.logPagina = dados.pagina || 1;
    interno.logPaginas = dados.paginas || 1;
    mudar({
      opcoes: { tipo: "lista", itens, texto: itens.length ? "Selecione uma execução" : "Nenhuma execução nesta data" },
      versaoOpcoes: ler().versaoOpcoes + 1,
      logPaginasVisivel: interno.logPaginas > 1,
      logPaginaTexto: `${interno.logPagina} de ${interno.logPaginas}`,
      logAnteriorDesabilitado: interno.logPagina >= interno.logPaginas,
      logProximaDesabilitado: interno.logPagina <= 1,
    });
  } catch (erro) {
    if (consulta !== interno.consultaOpcoes) return;
    mudar({ opcoes: { tipo: "erro", itens: [], texto: (erro as Error).message } });
  }
}

export function carregarExecucoesLogAutomacao(): Promise<void> {
  interno.logPagina = 1;
  return consultarExecucoesLog();
}

export function mudarPaginaLogAutomacao(direcao: number): Promise<void> {
  interno.logPagina = limitarPagina(interno.logPagina - Number(direcao), interno.logPaginas);
  return consultarExecucoesLog();
}

export async function abrirLogExecucaoAutomacao(id: string, inicio?: string): Promise<void> {
  const dia = dataLocalIso(inicio);
  const campo = document.getElementById("automacao-log-data") as HTMLInputElement | null;
  if (dia && campo) campo.value = dia;
  await Promise.all([selecionarLogAutomacao(id), carregarExecucoesLogAutomacao()]);
  document.getElementById("automacao-andamento-painel")?.scrollIntoView({ block: "start" });
  document.getElementById("cockpit-automation-events")?.focus({ preventScroll: true });
}

export async function carregarHistoricoAutomacao(): Promise<void> {
  const consulta = ++interno.consultaHistorico;
  try {
    const dados = await consultarAutomacao<RespostaHistorico>(
      `/api/automacao/historico?${new URLSearchParams({ limite: String(interno.limite), pagina: String(interno.pagina), ...interno.filtros })}`,
      { errorMessage: "Não foi possível carregar o histórico da automação." },
    );
    if (consulta !== interno.consultaHistorico) return;
    interno.pagina = dados.pagina || 1;
    interno.paginas = dados.paginas || 1;
    mudar({
      historico: { tipo: "lista", execucoes: Array.isArray(dados.execucoes) ? dados.execucoes : [], mensagem: "" },
      paginaTexto: `${interno.pagina} de ${interno.paginas}`,
      anteriorDesabilitado: interno.pagina <= 1,
      proximaDesabilitado: interno.pagina >= interno.paginas,
      resumoHist: resumoDoHistorico(dados.total ?? dados.execucoes?.length ?? 0, interno.filtros),
    });
  } catch (erro) {
    if (consulta !== interno.consultaHistorico) return;
    console.error("Erro ao carregar o histórico da automação:", erro);
    mudar({
      historico: { tipo: "erro", execucoes: [], mensagem: (erro as Error).message },
      resumoHist: "Não foi possível atualizar a consulta.",
      anteriorDesabilitado: true,
      proximaDesabilitado: true,
    });
  }
}

export function filtrarHistoricoAutomacao(): Promise<void> | undefined {
  const inicio = valor("automacao-historico-inicio");
  const fim = valor("automacao-historico-fim");
  if (inicio && fim && inicio > fim) {
    mudar({ resumoHist: "A data inicial deve ser anterior ou igual à data final." });
    const campo = document.getElementById("automacao-historico-fim");
    // O campo fica na caixa "Período" (<details>); fechada, o foco não chegaria nele.
    const caixa = campo?.closest("details");
    if (caixa) caixa.open = true;
    campo?.focus();
    return undefined;
  }
  interno.filtros = Object.fromEntries(Object.entries({
    data_inicio: inicio, data_fim: fim, rotina: valor("automacao-historico-rotina"), status: valor("automacao-historico-status"),
  }).filter(([, preenchido]) => preenchido));
  interno.limite = Number(valor("automacao-historico-limite")) || 5;
  interno.pagina = 1;
  return carregarHistoricoAutomacao();
}

export function limparFiltrosAutomacao(): Promise<void> | undefined {
  ["inicio", "fim", "rotina", "status"].forEach(campo => {
    const elemento = document.getElementById(`automacao-historico-${campo}`) as HTMLInputElement | HTMLSelectElement | null;
    if (elemento) elemento.value = "";
  });
  return filtrarHistoricoAutomacao();
}

export function mudarPaginaHistoricoAutomacao(direcao: number): Promise<void> {
  interno.pagina = limitarPagina(interno.pagina + Number(direcao), interno.paginas);
  return carregarHistoricoAutomacao();
}

// A aba muda só o atributo hidden: o polling segue a visibilidade dela e a da janela. Chamada de novo, desfaz a anterior.
export function inicializarAutomacao(): void {
  interno.desmontar?.();
  interno.desmontar = null;
  const elemento = painel();
  if (!elemento || typeof MutationObserver !== "function") return;
  const observador = new MutationObserver(() => {
    if (painelVisivel()) void atualizarEstadoAutomacao();
    else agendar();
  });
  observador.observe(elemento, { attributes: true, attributeFilter: ["hidden"] });
  const aoMudarVisibilidade = () => { if (painelVisivel()) void atualizarEstadoAutomacao(); };
  document.addEventListener("visibilitychange", aoMudarVisibilidade);
  interno.desmontar = () => {
    observador.disconnect();
    document.removeEventListener("visibilitychange", aoMudarVisibilidade);
    clearTimeout(interno.timer);
  };
  if (painelVisivel()) void atualizarEstadoAutomacao();
}
