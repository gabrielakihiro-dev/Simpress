import type { Qualquer } from "./tipos";

export const ENDPOINT = "/api/painel";

// Na carga, a Home, o Resumo e a pesquisa pedem o painel ao mesmo tempo: pedidos que se cruzam dividem uma
// só requisição. Nada fica guardado depois da resposta (o próximo pedido busca de novo) e cada um recebe a sua cópia.
let painelEmVoo: Promise<unknown> | null = null;

// Com `novo` (depois de uma mutação) e um pedido em voo, a busca espera esse pedido e começa só depois dele, para não
// reaproveitar uma resposta que partiu antes da mudança; quem chegar depois divide o pedido novo.
export function painelCompartilhado<T>(buscar: () => Promise<T>, opcoes?: { novo?: boolean }): Promise<T> {
  const anterior = painelEmVoo;
  if (!anterior || opcoes?.novo) {
    const base: Promise<unknown> = anterior ? anterior.catch(() => undefined).then(() => buscar()) : buscar();
    const pedido: Promise<unknown> = base.finally(() => { if (painelEmVoo === pedido) painelEmVoo = null; });
    painelEmVoo = pedido;
  }
  return (painelEmVoo as Promise<unknown>).then(dados => structuredClone(dados) as T);
}

// Cartão e badge do sino (lembretes agendados) usam a mesma regra: só contagens; null = nada a mostrar.
export function contagemLembretesAgendados(dados: unknown): { atrasados: number; hoje: number } | null {
  if (!dados || typeof dados !== "object") return null;
  const { atrasados, hoje, indisponivel } = dados as { atrasados?: unknown; hoje?: unknown; indisponivel?: unknown };
  if (indisponivel) return null;
  const contar = (valor: unknown): number => { const n = Number(valor); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0; };
  const resultado = { atrasados: contar(atrasados), hoje: contar(hoje) };
  return resultado.atrasados + resultado.hoje === 0 ? null : resultado;
}
export const DENSITY_KEY = "simpress:table-density";
const DIVERGENCE_FIELDS = Object.freeze(["divergencias_local", "divergencias_apelidos_manuais"]);

// ---------- sorting helpers (pure) ----------
const DATE_BR = /^(\d{2})\/(\d{2})\/(\d{4})(?:\D+(\d{2}):(\d{2}))?/;
const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

export function sortKey(text: Qualquer): { kind: string; value: Qualquer } {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value || value === "—" || value === "-") return { kind: "empty", value: "" };
  const date = DATE_BR.exec(value);
  if (date) {
    const [, day, month, year, hour = "0", minute = "0"] = date;
    return { kind: "number", value: Date.UTC(+year, +month - 1, +day, +hour, +minute) };
  }
  if (NUMBER.test(value)) return { kind: "number", value: parseFloat(value.replace(",", ".")) };
  return { kind: "text", value };
}

export function compareValues(a: Qualquer, b: Qualquer): number {
  const left = sortKey(a);
  const right = sortKey(b);
  if (left.kind === "empty" || right.kind === "empty") {
    return left.kind === right.kind ? 0 : left.kind === "empty" ? 1 : -1;
  }
  if (left.kind === "number" && right.kind === "number") return left.value - right.value;
  if (left.kind !== right.kind) return left.kind === "number" ? -1 : 1;
  return left.value.localeCompare(right.value, "pt-BR", { numeric: true, sensitivity: "base" });
}

// Cycle: none -> ascending -> descending -> none.
export function nextDirection(current: string | null): string {
  return current === "ascending" ? "descending" : current === "descending" ? "none" : "ascending";
}

// Returns the original indexes in display order; ties keep the original order (stable).
export function sortedOrder(texts: Qualquer[], direction: string): number[] {
  const indexes = texts.map((_, index) => index);
  if (direction !== "ascending" && direction !== "descending") return indexes;
  const sign = direction === "ascending" ? 1 : -1;
  return indexes.sort((a, b) => {
    const left = sortKey(texts[a]);
    const right = sortKey(texts[b]);
    // Empty values always stay last, whatever the direction.
    if (left.kind === "empty" || right.kind === "empty") {
      return left.kind === right.kind ? a - b : left.kind === "empty" ? 1 : -1;
    }
    return sign * compareValues(texts[a], texts[b]) || a - b;
  });
}

export function toTsv(headers: Qualquer[], rows: Qualquer[][]): string {
  const clean = (value: Qualquer) => String(value ?? "").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return [headers, ...rows].map(row => row.map(clean).join("\t")).join("\n");
}

// ---------- dashboard helpers (pure) ----------
export function divergenceTotal(latest: Qualquer): number {
  const items: Qualquer[] = Array.isArray(latest?.atencao) ? latest.atencao : [];
  return items
    .filter(item => DIVERGENCE_FIELDS.includes(item?.campo))
    .reduce((sum, item) => sum + (Number(item.total) || 0), 0);
}

export function barPercentages(entries: Qualquer[]): number[] {
  const max = Math.max(0, ...entries.map(entry => Number(entry.total) || 0));
  return entries.map(entry => (max ? Math.max(4, Math.round(((Number(entry.total) || 0) / max) * 100)) : 0));
}

export function formatNumber(value: Qualquer): string {
  return Number(value || 0).toLocaleString("pt-BR");
}

export function pluralize(count: number, singular: string, plural: string): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

// ---------- chaves de série e de OS (mesma normalização do servidor e do modelo Chamado × OS) ----------
export function serialKey(value: Qualquer): string {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function orderKey(value: Qualquer): string {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}
