// Regras puras da aba Automação (F5): nomes das rotinas, formatação de datas, selo e botão de cada rotina, leitura
// do log em eventos e textos do estado do Chrome. Sem import e só com sintaxe apagável, para
// tests/frontend/test_automation_tab_structure.cjs carregar este arquivo com require() sem build.

export const ROTINAS: Readonly<Record<string, string>> = Object.freeze({
  os: "Rotina de OS",
  inventarios: "Inventários",
  usuarios: "Verificar usuários",
  ambas: "Rotina Completa",
  login: "Abrir Chrome para login",
  sebrae: "Chamados novos Sebrae",
  antigos: "Chamados antigos Sebrae",
  dashboard: "Dashboard + chamados novos Sebrae",
  enviar: "Enviar Dashboard atualizado ao SharePoint",
  ux_apelidos: "Atualizar apelidos e id no UX Simpress",
});

export const STATUS: Readonly<Record<string, string>> = Object.freeze({
  em_andamento: "Em andamento",
  concluido: "Concluído",
  falha: "Falha",
  cancelado: "Cancelado",
  ocupada: "Ocupada",
  interrompido: "Interrompido",
});

export const POLL_ATIVO_MS = 1500;
export const POLL_LIVRE_MS = 5000;
export const MAX_LINHAS = 500;
export const MAX_EVENTOS = 200;

// Rotinas com selo "última execução" nos cartões da aba (dashboard e sebrae alimentam a trilha SharePoint / SoftExpert).
export const ROTINAS_DOS_CARTOES: readonly string[] = ["os", "inventarios", "ambas", "usuarios", "dashboard", "sebrae"];

// Abas do seletor de rotinas e a aba de cada rotina (login não tem aba).
export const ABAS_ROTINA: readonly { id: string; nome: string }[] = [
  { id: "sharepoint", nome: "SharePoint" },
  { id: "softexpert", nome: "SoftExpert" },
  { id: "completa", nome: "Rotina Completa" },
  { id: "inventarios", nome: "Inventários" },
];
export const ABA_PADRAO = "softexpert";
// "dashboard" parte do cartão do SoftExpert: abrir a aba SharePoint esconderia o botão e o andamento dela.
const ABA_DA_ROTINA: Readonly<Record<string, string>> = Object.freeze({
  dashboard: "softexpert", sebrae: "softexpert", os: "completa", usuarios: "completa", ambas: "completa", inventarios: "inventarios",
});
export const abaDaRotina = (rotina: string | undefined): string => (rotina ? ABA_DA_ROTINA[rotina] || "" : "");
// A mais recente de duas execuções (a trilha do SoftExpert mostra a última entre "sebrae" e "dashboard").
export const execucaoMaisRecente = (a: Execucao | null | undefined, b: Execucao | null | undefined): Execucao | null => (!a ? (b ?? null) : (!b ? a : ((a.inicio ?? "") >= (b.inicio ?? "") ? a : b)));

export const ICONE_STATUS: Readonly<Record<string, string>> = Object.freeze({
  ok: "i-ok", erro: "i-erro", alerta: "i-alerta", info: "i-loader", "": "i-neutro",
});
export const STATUS_VISUAL: Readonly<Record<string, string>> = Object.freeze({
  concluido: "ok", falha: "erro", cancelado: "", interrompido: "alerta", ocupada: "alerta", em_andamento: "info",
});

export const AVISO_SERVIDOR_ANTIGO = "Servidor desatualizado: reinicie o Simpress (feche a janela do servidor e abra iniciar_servidor.bat).";

export interface Execucao {
  id: string;
  rotina: string;
  status: string;
  inicio?: string | null;
  fim?: string | null;
  origem?: string;
  mensagem?: string;
  lotes?: { id: string; status?: string }[];
  capturas?: { nome: string; url: string }[];
}

export interface DadosEstado {
  estado?: string;
  rotina?: string;
  inicio?: string | null;
  cancelamento_pedido?: boolean;
  aguardando_login?: boolean;
  login_origem?: string;
  ultima?: Execucao | null;
  log?: { arquivo?: string; offset?: number; reiniciado?: boolean; linhas?: string[] };
}

export interface LogHistorico {
  arquivo?: string;
  linhas?: string[];
  limitado?: boolean;
  execucao?: Execucao | null;
}

// Uma 404 em /api/automacao/* com o corpo padrão do FastAPI ("Not Found" ou sem detail) é rota inexistente: servidor antigo.
export function eServidorDesatualizado(erro: { status?: number; detail?: unknown } | null | undefined): boolean {
  return erro?.status === 404 && (erro.detail === undefined || erro.detail === "Not Found");
}

export const nomeDaRotina = (rotina: string | undefined): string => (rotina ? ROTINAS[rotina] || rotina : "");
export const nomeDoStatus = (status: string | undefined): string => (status ? STATUS[status] || status : "");

export function formatarHora(iso?: string | null): string {
  const data = iso ? new Date(iso) : null;
  if (!data || Number.isNaN(data.getTime())) return "";
  return data.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatarDuracao(inicio?: string | null, fim?: string | null): string {
  const comeco = new Date(inicio as string).getTime();
  const termino = new Date(fim as string).getTime();
  if (!Number.isFinite(comeco) || !Number.isFinite(termino) || termino < comeco) return "—";
  const segundos = Math.round((termino - comeco) / 1000);
  const minutos = Math.floor(segundos / 60);
  return minutos < 60 ? `${minutos}m ${segundos % 60}s` : `${Math.floor(minutos / 60)}h ${minutos % 60}m`;
}

export function formatarHoraCurta(iso?: string | null): string {
  const data = iso ? new Date(iso) : null;
  if (!data || Number.isNaN(data.getTime())) return "";
  return data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// "08:30" (hoje), "ontem 17:45" ou "22/10 16:20"; `dia` é 0 para hoje e 1 para ontem.
export function descreverQuando(iso?: string | null, agora: Date = new Date()): { dia: number; texto: string } {
  const data = iso ? new Date(iso) : null;
  if (!data || Number.isNaN(data.getTime())) return { dia: -1, texto: "" };
  const meiaNoite = (valorData: Date) => new Date(valorData.getFullYear(), valorData.getMonth(), valorData.getDate()).getTime();
  const dia = Math.round((meiaNoite(agora) - meiaNoite(data)) / 86400000);
  const hora = formatarHoraCurta(iso);
  if (dia === 0) return { dia, texto: hora };
  if (dia === 1) return { dia, texto: `ontem ${hora}` };
  return { dia, texto: `${data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hora}` };
}

export function rotuloInicio(iso?: string | null, agora: Date = new Date()): string {
  const { dia, texto } = descreverQuando(iso, agora);
  if (dia === 0) return `Hoje ${texto}`;
  return texto ? texto.charAt(0).toLocaleUpperCase("pt-BR") + texto.slice(1) : "—";
}

// AAAA-MM-DD no fuso local, para o campo "Data do log" ao abrir o log de uma linha do histórico.
export function dataLocalIso(inicio?: string | null): string {
  const data = new Date(inicio as string);
  if (Number.isNaN(data.getTime())) return "";
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}-${String(data.getDate()).padStart(2, "0")}`;
}

export interface Selo { status: string; texto: string }

// Selo da última execução de cada rotina: em andamento, concluída hoje, outro dia ou outro resultado.
export function situacaoDoSelo(ativo: boolean, ultima: Execucao | null | undefined, agora: Date = new Date()): Selo {
  const quando = descreverQuando(ultima?.fim || ultima?.inicio, agora);
  if (ativo) return { status: "info", texto: "Em andamento" };
  if (ultima && ultima.status === "concluido" && quando.dia === 0) return { status: "ok", texto: `Concluído ${quando.texto}` };
  if (ultima && ultima.status === "concluido") return { status: "", texto: quando.texto.charAt(0).toLocaleUpperCase("pt-BR") + quando.texto.slice(1) };
  if (ultima) return { status: STATUS_VISUAL[ultima.status] || "", texto: `${STATUS[ultima.status] || ultima.status} ${quando.texto}`.trim() };
  return { status: "", texto: "Sem execuções" };
}

export const iconeDoSelo = (ativo: boolean, status: string): string => (ativo ? "i-loader" : (status ? ICONE_STATUS[status] : "i-clock"));
export const situacaoDoCartao = (ativo: boolean, status: string): string => (ativo ? "em-andamento" : (status === "ok" ? "concluido" : "ocioso"));

export interface EntradaBotao { ocupado: boolean; emAndamento: boolean; acompanhar: boolean; semSaida: boolean }

// Nunca libera uma segunda rotina: só a própria rotina em andamento ("Acompanhar") fica livre.
export const botaoBloqueado = (e: EntradaBotao): boolean => e.ocupado || (e.emAndamento && !e.acompanhar) || e.semSaida;

export const rotuloDoBotao = (acompanhar: boolean, repetir: boolean): string => (acompanhar ? "Acompanhar" : (repetir ? "Tentar de novo" : "Executar"));
export const iconeDoBotao = (acompanhar: boolean, repetir: boolean): string => (acompanhar ? "i-text" : (repetir ? "i-refresh" : "i-play"));

export interface DescricaoEstado {
  ativo: boolean;
  dataState: string;
  seloStatus: string;
  titulo: string;
  detalhe: string;
  esperandoLogin: boolean;
  avisoLogin: string;
  chipState: string;
  chipTitulo: string;
  chipDica: string;
}

// O que a aba e o chip do cabeçalho mostram para o estado devolvido por /api/automacao/estado.
export function descreverEstado(dados: DadosEstado): DescricaoEstado {
  const ativo = dados.estado === "em_andamento";
  const cancelando = Boolean(dados.cancelamento_pedido);
  const rotina = ROTINAS[dados.rotina as string] || dados.rotina || "Rotina";
  let titulo = "Livre";
  let detalhe = "Nenhuma rotina em andamento.";
  if (ativo) {
    const inicio = formatarHoraCurta(dados.inicio);
    titulo = cancelando ? "Cancelando…" : "Ocupado";
    detalhe = `${rotina} em andamento${inicio ? ` desde ${inicio}` : ""}`;
  } else if (dados.ultima) {
    const ultima = dados.ultima;
    detalhe = `Última execução: ${ROTINAS[ultima.rotina] || ultima.rotina}, ${STATUS[ultima.status] || ultima.status} em ${formatarHora(ultima.fim || ultima.inicio)}.`;
  }
  const sistema = dados.login_origem ? ` (${dados.login_origem})` : "";
  return {
    ativo,
    dataState: ativo ? (cancelando ? "cancelando" : "em_andamento") : "livre",
    seloStatus: ativo ? (cancelando ? "alerta" : "info") : "ok",
    titulo,
    detalhe,
    esperandoLogin: ativo && Boolean(dados.aguardando_login),
    avisoLogin: `Faça o login no Chrome de automação${sistema}. A rotina continua sozinha depois do login.`,
    chipState: ativo ? "occupied" : "idle",
    chipTitulo: ativo ? "Chrome ocupado" : "Chrome livre",
    chipDica: ativo ? `${ROTINAS[dados.rotina as string] || dados.rotina || "Rotina"} em andamento.` : "Chrome livre para uma nova rotina.",
  };
}

// Resultado da última rotina para o aviso ao terminar; só "Atualizar apelidos" leva a mensagem de falha junto.
export function textoResultado(ultima: Execucao): string {
  const rotina = ROTINAS[ultima.rotina] || ultima.rotina;
  const status = STATUS[ultima.status] || ultima.status;
  const mensagem = ultima.rotina === "ux_apelidos" && ["falha", "interrompido"].includes(ultima.status) && ultima.mensagem
    ? ` ${ultima.mensagem}` : "";
  return `${rotina}: ${status}.${mensagem}`;
}

export interface Classificacao { estado: string; icone: string; status: string }

export function classificarEvento(mensagem: string): Classificacao {
  // "0 com erro"/"0 com falha" é contagem zerada, não falha.
  const texto = mensagem.toLocaleLowerCase("pt-BR").replace(/\b0\s+com\s+(?:erros?|falhas?)\b/g, "");
  const percentual = texto.match(/(?:^|\s)(\d{1,3}%)(?=\s|$)/)?.[1];
  if (/\b(falha|falhou|erro|error|exception|não conclu[ií]d[oa]|nao conclu[ií]d[oa])\b/.test(texto)) {
    return { estado: "error", icone: "✕", status: "Falha" };
  }
  if (/ação necessária|acao necessaria|aguardando|pendente|login necessário|login necessario/.test(texto)) {
    return { estado: "waiting", icone: "◌", status: "Aguardando" };
  }
  if (percentual || /exportando|importando|comparando|em andamento|processando|carregando/.test(texto)) {
    return { estado: "active", icone: "◌", status: percentual || "Em andamento" };
  }
  if (/conclu[ií]d[oa]|finalizad[oa]|válid[oa]|valid[oa]|confirmad[oa]|iniciad[oa]|\bok\b/.test(texto)) {
    return { estado: "success", icone: "✓", status: "OK" };
  }
  return { estado: "info", icone: "·", status: "Info" };
}

export interface Evento { hora: string; origem: string; mensagem: string; estado: string; status: string; nivel: string }

const NIVEL_DO_ESTADO: Readonly<Record<string, string>> = Object.freeze({ error: "erro", waiting: "alerta", active: "info", success: "ok" });

// Cada linha do log vira um evento: "[hh:mm:ss] [origem] mensagem". Sem linhas, um aviso de espera.
export function eventosDoLog(texto: string): Evento[] {
  const linhas = texto.split(/\r?\n/).filter(linha => linha.trim()).slice(-MAX_EVENTOS);
  if (!linhas.length) {
    return [{ hora: "—", origem: "", mensagem: "Aguardando atividade do Chrome.", estado: "waiting", status: "Aguardando", nivel: "alerta" }];
  }
  return linhas.map(linha => {
    const partes = linha.match(/^\s*(?:\[(\d{2}:\d{2}:\d{2})\]\s*)?(?:\[([^\]\r\n]+)\]\s*)?(.*)$/);
    const mensagem = partes?.[3] || linha;
    const classificacao = classificarEvento(mensagem);
    return {
      hora: partes?.[1] || "—", origem: partes?.[2] || "", mensagem,
      estado: classificacao.estado, status: classificacao.status, nivel: NIVEL_DO_ESTADO[classificacao.estado] || "info",
    };
  });
}

export interface EntradaModo {
  historico: boolean;
  limite: number;
  total: number;
  execucao?: Execucao | null;
  limitado?: boolean;
}

export function textoDoModo(e: EntradaModo): string {
  const ultimas = Math.min(e.limite, e.total);
  if (!e.historico) return `Ao vivo · últimas ${ultimas} linhas`;
  const quem = e.execucao ? `${ROTINAS[e.execucao.rotina] || e.execucao.rotina} · ${formatarHora(e.execucao.inicio)}` : "Consultando execução";
  return `Histórico · ${quem} · últimas ${ultimas} linhas${e.limitado ? " (trecho final)" : ""}`;
}

export const textoDoArquivo = (arquivo: string): string => (arquivo ? `Arquivo: ${arquivo}` : "Nenhum log disponível.");

export const rotuloDaExecucao = (item: Execucao): string => `${formatarHora(item.inicio)} · ${ROTINAS[item.rotina] || item.rotina} · ${STATUS[item.status] || item.status}`;

// "3 execuções · de 01/11/2026 · até 10/11/2026 · Rotina de OS · Falha" sob o título do histórico.
export function resumoDoHistorico(total: number, filtros: Readonly<Record<string, string>>): string {
  const resumo = [`${total} execuções`];
  if (filtros.data_inicio) resumo.push(`de ${filtros.data_inicio.split("-").reverse().join("/")}`);
  if (filtros.data_fim) resumo.push(`até ${filtros.data_fim.split("-").reverse().join("/")}`);
  if (filtros.rotina) resumo.push(ROTINAS[filtros.rotina]);
  if (filtros.status) resumo.push(STATUS[filtros.status]);
  return resumo.join(" · ");
}

export const limitarPagina = (pagina: number, total: number): number => Math.max(1, Math.min(total, pagina));

export function descricaoDaCaptura(execucao: Execucao): string {
  const rotina = ROTINAS[execucao.rotina] || execucao.rotina || "Automação";
  const hora = formatarHora(execucao.inicio);
  const base = `Captura de tela da falha em ${rotina}${hora ? ` às ${hora}` : ""}`;
  return execucao.mensagem ? `${base}: ${execucao.mensagem}` : base;
}

export function dicaDosLotes(execucao: Execucao): string {
  const lotes = (execucao.lotes || []).map(lote => `${lote.id}${lote.status ? ` (${lote.status})` : ""}`).join(", ");
  return lotes ? `Lotes: ${lotes}` : "";
}

export interface EntradaVisaoLog {
  logMostrado: boolean;
  execucaoSelecionada: string;
  linhasAoVivo: readonly string[];
  arquivo: string;
  logHistorico: LogHistorico | null;
  logErro: string | null;
  limiteLog: number;
}

export interface VisaoLog { historico: boolean; texto: string; arquivoTexto: string; modo: string; eventos: Evento[] }

// O que o console e o "Log completo" mostram: ao vivo (linhas do polling) ou histórico (log da execução escolhida).
// Antes da primeira leitura valem os textos iniciais do HTML.
export function visaoDoLog(e: EntradaVisaoLog): VisaoLog {
  const historico = Boolean(e.execucaoSelecionada);
  if (!e.logMostrado) {
    return { historico, texto: "", arquivoTexto: "", modo: "Ao vivo · execução mais recente", eventos: eventosDoLog("") };
  }
  const dados = e.logHistorico;
  const arquivoTexto = textoDoArquivo(historico ? (dados?.arquivo || "") : e.arquivo);
  if (e.logErro !== null) {
    return { historico, texto: e.logErro, arquivoTexto, modo: "Histórico · erro ao consultar", eventos: eventosDoLog(e.logErro) };
  }
  const linhas = historico ? (dados?.linhas || []) : e.linhasAoVivo;
  const texto = linhas.slice(-e.limiteLog).join("\n");
  const modo = textoDoModo({ historico, limite: e.limiteLog, total: linhas.length, execucao: dados?.execucao, limitado: dados?.limitado });
  return { historico, texto, arquivoTexto, modo, eventos: eventosDoLog(texto) };
}

// "Ver backups no Resumo" aparece só quando uma rotina de inventário (inventarios ou ambas) acabou de concluir.
// Devolve o novo valor do atalho, ou null para deixá-lo como está.
export function verBackupsDepois(
  e: { emAndamento: boolean; estavaAtivo: boolean; rotinaAnterior: string; statusUltima: string | undefined },
): boolean | null {
  if (e.emAndamento) return false;
  if (e.estavaAtivo && ["inventarios", "ambas"].includes(e.rotinaAnterior) && e.statusUltima === "concluido") return true;
  return null;
}

// Rotinas que importam o relatório de OS (os ou ambas) acabaram: a tela recarrega OS, Relatório e F5 (simpress:chamados-atualizados).
// Vale também para falha ou cancelamento: um lote já em pendentes pode ter sido importado, e recarregar não grava nada.
export function osImportadaAoTerminar(e: { emAndamento: boolean; estavaAtivo: boolean; rotinaAnterior: string }): boolean {
  return e.estavaAtivo && !e.emAndamento && ["os", "ambas"].includes(e.rotinaAnterior);
}

// Etapa da trilha: concluída em qualquer dia conta como ok; o resto vem de situacaoDoSelo.
export function situacaoDaEtapa(ativo: boolean, ultima: Execucao | null | undefined, agora: Date = new Date()): Selo {
  const selo = situacaoDoSelo(ativo, ultima, agora);
  return !ativo && ultima?.status === "concluido" && selo.status === "" ? { status: "ok", texto: `Concluído ${selo.texto.toLocaleLowerCase("pt-BR")}` } : selo;
}

// Percentual da rotina para a barra de etapas: o último "NN%" do log ao vivo; concluída vale 100; sem leitura, 0.
export function percentualDaRotina(ativo: boolean, ultima: Execucao | null | undefined, linhas: readonly string[]): number {
  if (!ativo) return ultima?.status === "concluido" ? 100 : 0;
  for (let i = linhas.length - 1; i >= 0; i--) {
    const achado = linhas[i].match(/(?:^|\s)(\d{1,3})%(?=\s|$)/);
    if (achado) return Math.min(100, Number(achado[1]));
  }
  return 0;
}
