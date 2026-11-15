// Regras puras dos lembretes: datas agendadas, agrupamento por dia, vistas e campos editados. Sem import e só
// com sintaxe apagável, para tests/frontend/test_lembretes.cjs carregar este arquivo com require() sem build.

export interface Lembrete {
  id: number | string;
  descricao: string;
  concluido?: boolean;
  criado_em: string;
  alterado_em?: string | null;
  data_agendada?: string | null;
  hora_agendada?: string | null;
  origem?: string | null;
  termo?: unknown;
}

export interface Agrupado {
  atrasados: Lembrete[];
  porDia: Map<string, Lembrete[]>;
  semData: Lembrete[];
}

export interface GrupoVista {
  chave: string;
  titulo: string;
  itens: Lembrete[];
  data?: string;
  n?: number;
  reagendar?: boolean;
  adicionar?: boolean;
}

export const LIMITE = 2000;

export const tamanho = (texto: unknown): number => [...String(texto ?? "")].length;

// Mesmos limites do backend para a cópia do termo (200 por campo, 2000 nas observações; controle vira espaço,
// exceto quebra de linha e tab nas observações): sem isso o POST dava 422 e o diálogo não deixava corrigir.
export const textoTermo = (texto: unknown, limite: number, permitidos = ""): string =>
  [...String(texto ?? "").replace(/\p{Cs}/gu, "").replace(/\p{Cc}/gu, (c) => (permitidos.includes(c) ? c : " "))].slice(0, limite).join("");

// A data tem fonte em ISO com fuso; o navegador converte para a hora local.
export function formatarData(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${dois(d.getDate())}/${dois(d.getMonth() + 1)}/${d.getFullYear()} ${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

export const dataExibida = (l: Lembrete): string => l.alterado_em ?? l.criado_em;
const instante = (l: Lembrete): number => Date.parse(dataExibida(l)) || 0;
// Mais recente no topo, pela data que aparece no item. A data tem precisão de segundo: no empate, o que veio depois no arquivo fica acima.
export const ordenar = (itens: Lembrete[]): Lembrete[] => itens
  .map((item, posicao) => ({ item, posicao }))
  .sort((a, b) => instante(b.item) - instante(a.item) || b.posicao - a.posicao)
  .map(({ item }) => item);

// Datas agendadas são texto "AAAA-MM-DD" e só passam por Date.UTC/getUTC*: new Date("AAAA-MM-DD") e toISOString dependem do fuso do navegador.
// Só hojeEm olha para America/Sao_Paulo; os rótulos usam Intl com timeZone "UTC" para não deslocar o dia.
const FUSO = "America/Sao_Paulo";
const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
export const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIA_MS = 86400000;
export const DIAS_CURTOS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const dois = (n: number) => String(n).padStart(2, "0");
const formatoUtc = (opcoes: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", ...opcoes });
const fmtMesCurto = formatoUtc({ month: "short" });
const fmtMesLongo = formatoUtc({ month: "long" });
const fmtSemana = formatoUtc({ weekday: "long" });
const fmtSaoPaulo = new Intl.DateTimeFormat("en-US", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });

// Meia-noite UTC da data real no formato estrito, ou null (recusa 2026-02-30 e ano 0000, como o backend).
// setUTCFullYear em vez de Date.UTC: o Date.UTC trata os anos 0 a 99 como 1900 a 1999.
function dataMs(texto: unknown): number | null {
  const partes = typeof texto === "string" ? RE_DATA.exec(texto) : null;
  if (!partes) return null;
  const [ano, mes, dia] = [Number(partes[1]), Number(partes[2]), Number(partes[3])];
  const d = new Date(0);
  d.setUTCFullYear(ano, mes - 1, dia);
  return ano >= 1 && d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia ? d.getTime() : null;
}
export const dataValida = (texto: unknown): boolean => dataMs(texto) !== null;
const textoDeMs = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${dois(d.getUTCMonth() + 1)}-${dois(d.getUTCDate())}`;
};
export const somarDias = (data: string, n: number): string => textoDeMs((dataMs(data) as number) + n * DIA_MS);
export const diaDaSemana = (data: string): number => new Date(dataMs(data) as number).getUTCDay();

// "Hoje" em America/Sao_Paulo, no formato AAAA-MM-DD, para o instante em milissegundos.
export function hojeEm(instanteMs: number = Date.now()): string {
  const partes = Object.fromEntries(fmtSaoPaulo.formatToParts(new Date(instanteMs)).map(({ type, value }) => [type, value]));
  return `${partes.year}-${partes.month}-${partes.day}`;
}

// Segunda-feira seguinte a hoje; numa segunda, a da semana que vem (+7).
export const proximaSegunda = (hoje: string): string => somarDias(hoje, (8 - diaDaSemana(hoje)) % 7 || 7);
// Os 7 dias (domingo a sábado) da semana de hoje deslocada em n semanas.
export const semanaDe = (hoje: string, n = 0): string[] => {
  const domingo = somarDias(hoje, 7 * n - diaDaSemana(hoje));
  return Array.from({ length: 7 }, (_, i) => somarDias(domingo, i));
};

const semPonto = (texto: string) => texto.replace(/\.$/, "");
const capitalizar = (texto: string) => texto.charAt(0).toUpperCase() + texto.slice(1);
// "13 nov"; em ano diferente do de hoje, "13 nov 2027".
const diaEMes = (data: string, hoje: string) => `${Number(data.slice(8))} ${semPonto(fmtMesCurto.format(dataMs(data) as number))}${data.slice(0, 4) === hoje.slice(0, 4) ? "" : ` ${data.slice(0, 4)}`}`;
const rotuloDia = (data: string, hoje: string) => (data === hoje ? "Hoje" : data === somarDias(hoje, 1) ? "Amanhã" : diaEMes(data, hoje));
// Rótulo do item: "Hoje · 14:00", "Amanhã", "13 nov", "13 nov 2027".
export const rotuloAgenda = (data: string, hora: string | null | undefined, hoje: string): string => `${rotuloDia(data, hoje)}${RE_HORA.test(hora ?? "") ? ` · ${hora}` : ""}`;
// Cabeçalho de um dia: "12 nov · Hoje · quinta-feira", "13 nov · Amanhã · sexta-feira", "14 nov · sábado".
export const tituloGrupoDia = (data: string, hoje: string): string => [
  diaEMes(data, hoje), data === hoje && "Hoje", data === somarDias(hoje, 1) && "Amanhã", fmtSemana.format(dataMs(data) as number),
].filter(Boolean).join(" · ");
// Mês e ano da faixa: "Novembro 2026", ou "Novembro – Dezembro 2026" quando a semana cruza o mês.
export function tituloSemana(dias: string[]): string {
  const [inicio, fim] = [dias[0], dias[dias.length - 1]];
  const mes = (d: string) => capitalizar(fmtMesLongo.format(dataMs(d) as number));
  if (inicio.slice(0, 7) === fim.slice(0, 7)) return `${mes(inicio)} ${inicio.slice(0, 4)}`;
  if (inicio.slice(0, 4) === fim.slice(0, 4)) return `${mes(inicio)} – ${mes(fim)} ${inicio.slice(0, 4)}`;
  return `${mes(inicio)} ${inicio.slice(0, 4)} – ${mes(fim)} ${fim.slice(0, 4)}`;
}

// Data fora do formato (arquivo editado à mão) conta como sem data; hora só vale com data.
export const dataDe = (l: Partial<Lembrete> | null | undefined): string | null => (dataValida(l?.data_agendada) ? (l?.data_agendada as string) : null);
export const horaDe = (l: Partial<Lembrete> | null | undefined): string | null => (dataDe(l) && RE_HORA.test(l?.hora_agendada ?? "") ? (l?.hora_agendada as string) : null);
const chaveAgenda = (l: Lembrete) => `${dataDe(l)} ${horaDe(l) ?? "99:99"}`;

// Separa os pendentes em atrasados (data < hoje), um grupo por dia (de hoje em diante) e sem data.
// Dentro de cada grupo: data e hora crescentes, com hora antes de sem hora; no empate, a regra de ordenar (mais recente no topo).
export function agruparLembretes(pendentes: Lembrete[] | null | undefined, hoje: string): Agrupado {
  const recentes = ordenar(pendentes ?? []);
  const comData = recentes.filter((l) => dataDe(l)).sort((a, b) => (chaveAgenda(a) < chaveAgenda(b) ? -1 : chaveAgenda(a) > chaveAgenda(b) ? 1 : 0));
  const porDia = new Map<string, Lembrete[]>();
  comData.filter((l) => (dataDe(l) as string) >= hoje).forEach((l) => porDia.set(dataDe(l) as string, [...(porDia.get(dataDe(l) as string) ?? []), l]));
  return { atrasados: comData.filter((l) => (dataDe(l) as string) < hoje), porDia, semData: recentes.filter((l) => !dataDe(l)) };
}

// Grupos da vista aberta. Hoje: Atrasada, hoje e Sem data. Em breve: Atrasada só na semana atual, um grupo por dia (de hoje em diante) e Sem data.
export function montarVista(agrupado: Agrupado, hoje: string, qual = "hoje", semana = 0): GrupoVista[] {
  const grupos: GrupoVista[] = [];
  if (agrupado.atrasados.length && (qual === "hoje" || semana === 0)) {
    grupos.push({ chave: "atrasada", titulo: "Atrasada", n: agrupado.atrasados.length, itens: agrupado.atrasados, reagendar: true });
  }
  const dias = qual === "embreve" ? semanaDe(hoje, semana).filter((d) => d >= hoje) : [hoje];
  dias.forEach((d) => grupos.push({ chave: d, data: d, titulo: tituloGrupoDia(d, hoje), itens: agrupado.porDia.get(d) ?? [], adicionar: true }));
  if (agrupado.semData.length) grupos.push({ chave: "sem-data", titulo: "Sem data", n: agrupado.semData.length, itens: agrupado.semData });
  return grupos;
}

// Só o que mudou vai no PATCH. Tirar a data manda data_agendada null (o backend limpa a hora junto);
// trocar só a data mantém a hora; a hora só entra quando há data e ela mudou.
export function camposEditados(l: Lembrete, { descricao, data, hora }: { descricao: string; data: string; hora: string }): Record<string, string | null> {
  const campos: Record<string, string | null> = {};
  if (descricao !== l.descricao) campos.descricao = descricao;
  if (data !== (dataDe(l) ?? "")) campos.data_agendada = data || null;
  if (data && hora !== (horaDe(l) ?? "")) campos.hora_agendada = hora || null;
  return campos;
}

export interface ListaDerivada {
  pendentes: number;
  agrupado: Agrupado;
  grupos: GrupoVista[];
  concluidos: Lembrete[];
}

// Tudo o que a lista desenha a partir dos lembretes: pendentes agrupados, grupos da vista aberta e concluídos.
export function derivarLista(lembretes: Lembrete[], hoje: string, qual = "hoje", semana = 0): ListaDerivada {
  const pendentes = lembretes.filter((l) => !l.concluido);
  const agrupado = agruparLembretes(pendentes, hoje);
  return { pendentes: pendentes.length, agrupado, grupos: montarVista(agrupado, hoje, qual, semana), concluidos: ordenar(lembretes.filter((l) => l.concluido)) };
}
