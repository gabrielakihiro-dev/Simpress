// Regras puras do diálogo "Histórico de atualizações de planilhas" (sem DOM nem API), testáveis no Node
// (tests/frontend/test_historico_comparacoes.cjs). Os formatadores de frontend/src/legado/shared/history-format.js entram por
// parâmetro, para o teste usar o módulo real e este arquivo não copiar a regra.

export interface Formatadores {
  formatarNomeFonteHistorico(valor: unknown): string;
  formatarHorarioHistorico(horario: unknown): string;
  classesMetricaHistorico(valor: unknown, tom: string | null): { cartao: string; numero: string };
}

type Arquivos = { endpoint?: unknown; detalhes?: unknown };

export interface EventoHistorico {
  id: string;
  horario?: string;
  tipo?: string;
  somente_anotacoes_sincronizadas?: boolean;
  restauravel?: boolean;
  arquivos_enviados?: Arquivos;
  arquivos_restaurados?: Arquivos;
  restauracao_de?: { horario?: string };
  resumo?: Record<string, unknown>;
}

export type TomMetrica = "amber" | "emerald" | "rose" | null;
export interface Metrica { rotulo: string; valor: unknown; tom: TomMetrica }

export const CLASSE_BOTAO_HISTORICO = "btn w-full sm:w-auto h-9";

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
export const dataValida = (data: unknown): boolean => DATA_ISO.test(String(data ?? ""));

const contar = (quantidade: number) => `${quantidade} ${quantidade === 1 ? "registro" : "registros"}`;

// "1 registro" / "N registros", no contador do cabeçalho do diálogo.
export function rotuloTotal(total: unknown): string {
  return contar(Number(total || 0));
}

export function chaveDiaHistorico(horario: unknown): string {
  const data = String(horario || "").slice(0, 10);
  return DATA_ISO.test(data) ? data : "";
}

export function rotuloDiaHistorico(chave: string, hoje: Date = new Date()): string {
  if (!chave) return "Sem data";
  const doisDigitos = (valor: number) => String(valor).padStart(2, "0");
  const chaveLocal = (data: Date) => `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`;
  const ontem = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 1);
  if (chave === chaveLocal(hoje)) return "Hoje";
  if (chave === chaveLocal(ontem)) return "Ontem";
  const [ano, mes, dia] = chave.split("-");
  return `${dia}/${mes}/${ano}`;
}

export interface GrupoDia { chave: string; rotulo: string; quantidade: string; eventos: EventoHistorico[] }

// Um grupo por dia, na ordem em que o dia aparece na lista (a API já devolve do mais novo para o mais antigo).
export function agruparPorDia(eventos: EventoHistorico[], hoje: Date = new Date()): GrupoDia[] {
  const grupos = new Map<string, EventoHistorico[]>();
  eventos.forEach(evento => {
    const chave = chaveDiaHistorico(evento.horario);
    grupos.set(chave, [...(grupos.get(chave) ?? []), evento]);
  });
  return [...grupos].map(([chave, doDia]) => ({
    chave, rotulo: rotuloDiaHistorico(chave, hoje), quantidade: `· ${contar(doDia.length)}`, eventos: doDia,
  }));
}

// Datas do seletor de exportação: só atualizações (anotações sincronizadas ficam fora), sem repetir.
export function datasExportacao(eventos: unknown): string[] {
  const lista = (Array.isArray(eventos) ? eventos : []) as (EventoHistorico | null)[];
  return [...new Set(lista
    .filter((evento): evento is EventoHistorico => !!evento && !evento.somente_anotacoes_sincronizadas)
    .map(evento => String(evento.horario || "").slice(0, 10))
    .filter(dataValida))];
}

export function rotuloDataExportacao(data: string): string {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

// Contadores zerados são ruído numa lista longa: só os diferentes de zero aparecem.
export const metricasVisiveis = (metricas: Metrica[]): Metrica[] => metricas.filter(({ valor }) => Number(valor || 0) !== 0);

export function metricasDoEvento(evento: EventoHistorico): Metrica[] {
  const resumo = evento.resumo || {};
  if (evento.tipo === "restauracao") {
    return [
      { rotulo: "Restaurados – Endpoint", valor: resumo.total_endpoint_restaurado, tom: null },
      { rotulo: "Restaurados – Simpress", valor: resumo.total_detalhes_restaurado, tom: null },
    ];
  }
  return [
    { rotulo: "Apelidos atualizados", valor: resumo.apelidos_atualizados, tom: "emerald" },
    { rotulo: "Sem acesso 7+ dias", valor: resumo.sem_acesso_7_dias, tom: "amber" },
    { rotulo: "Divergências manuais", valor: resumo.divergencias_apelidos_manuais, tom: "rose" },
    { rotulo: "Sem correspondência – Endpoint", valor: resumo.ausentes_no_endpoint, tom: "amber" },
    { rotulo: "Sem correspondência – Simpress", valor: resumo.ausentes_em_detalhes, tom: "amber" },
    { rotulo: "Divergências de local", valor: resumo.divergencias_local, tom: "amber" },
    { rotulo: "Ambiguidades", valor: resumo.correspondencias_ambiguas, tom: "rose" },
  ];
}

export function seloDoEvento(evento: EventoHistorico): { tipo: string; cores: string } {
  if (evento.somente_anotacoes_sincronizadas) return { tipo: "Anotações sincronizadas", cores: "border-line-firm/60 bg-surface-control/60 text-fg-tertiary" };
  if (evento.tipo === "restauracao") return { tipo: "Restauração", cores: "border-amber-500/30 bg-amber-500/10 text-amber-200" };
  return { tipo: "Atualização", cores: "border-cyan-500/30 bg-cyan-500/10 text-cyan-200" };
}

export function arquivosDoEvento(evento: EventoHistorico): { rotulo: string; arquivos: Arquivos } {
  return evento.tipo === "restauracao"
    ? { rotulo: "Inventários restaurados", arquivos: evento.arquivos_restaurados || {} }
    : { rotulo: "Arquivos enviados", arquivos: evento.arquivos_enviados || {} };
}

export function rotuloAcaoRestaurar(evento: EventoHistorico, f: Pick<Formatadores, "formatarHorarioHistorico">): string {
  const restauracao = evento.tipo === "restauracao";
  return `${restauracao ? "Desfazer restauração de" : "Restaurar versões anteriores à atualização de"} ${f.formatarHorarioHistorico(evento.horario)}`;
}

// --- Restauração: prévia devolvida pela API e textos do diálogo de confirmação e do aviso final.

interface ArquivoPrevia { nome?: unknown; registros?: unknown; modificado_em?: unknown; presente?: boolean }
export interface PreviaRestauracao {
  tipo_evento?: string;
  evento_horario?: string;
  preview_token: string;
  arquivos_backup?: { endpoint?: ArquivoPrevia; detalhes?: ArquivoPrevia };
  arquivos_atuais?: { endpoint?: ArquivoPrevia; detalhes?: ArquivoPrevia };
}

export function mensagemConfirmacaoRestauracao(previa: PreviaRestauracao, evento: EventoHistorico, f: Formatadores): string {
  const backup = previa.arquivos_backup || {};
  const atuais = previa.arquivos_atuais || {};
  const descreverBackup = (rotulo: string, item: ArquivoPrevia = {}) => {
    const modificado = item.modificado_em ? `; arquivo datado ${f.formatarHorarioHistorico(item.modificado_em)}` : "";
    return `${rotulo}: ${f.formatarNomeFonteHistorico(item.nome || "—")} (${Number(item.registros || 0).toLocaleString("pt-BR")} registros${modificado})`;
  };
  const descreverAtual = (rotulo: string, item?: ArquivoPrevia) => {
    if (!item?.presente) return `${rotulo}: arquivo ausente`;
    const modificado = item.modificado_em ? ` · modificado ${f.formatarHorarioHistorico(item.modificado_em)}` : "";
    return `${rotulo}: ${f.formatarNomeFonteHistorico(item.nome || "—")}${modificado}`;
  };
  const acao = previa.tipo_evento === "restauracao" ? "Desfazer a restauração" : "Reverter a atualização";
  return [
    `${acao} registrada em ${f.formatarHorarioHistorico(previa.evento_horario || evento.horario)}?`,
    "",
    "Conjunto que será restaurado:",
    descreverBackup("no endpoint", backup.endpoint),
    descreverBackup("na Simpress", backup.detalhes),
    "",
    "Conjunto ativo, que será guardado como backup:",
    descreverAtual("no endpoint", atuais.endpoint),
    descreverAtual("na Simpress", atuais.detalhes),
    "",
    "Os dois inventários serão substituídos juntos e a ação ficará registrada no histórico. Continuar?",
  ].join("\n");
}

export function mensagemRestauracaoConcluida(resposta: { evento?: { total_equipamentos_carregados?: unknown; desfazer_disponivel?: unknown } }): string {
  const quantidade = Number(resposta.evento?.total_equipamentos_carregados || 0);
  const total = quantidade.toLocaleString("pt-BR");
  const reversao = resposta.evento?.desfazer_disponivel
    ? "A restauração pode ser desfeita pelo histórico."
    : "O backup do conjunto substituído está incompleto ou inválido; não é possível desfazer pelo histórico.";
  return `Inventários restaurados. ${total} ${quantidade === 1 ? "equipamento carregado" : "equipamentos carregados"}. ${reversao}`;
}

// Erro da API que invalida a prévia guardada: a próxima tentativa pede prévia e chave novas.
export const previaInvalidada = (status: unknown, detail: unknown): boolean => status === 409 && /prévia|estado mudou/i.test(String(detail || ""));
