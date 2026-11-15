// Resumo do histórico do Dashboard Sebrae (Automação, cartão "Chamados novos do SoftExpert"), fora do
// componente: o código antigo chama carregarResumoHistoricoSebrae pela ponte (sebrae-dashboard.js).
import { apiFetch, type ApiFetchError } from "../../api";

const ENTRADAS_NO_CARTAO = 3;
const ROTULOS_TIPO: Record<string, string> = { importacao: "Importação", busca: "Busca" };

export interface Entrada {
  tipo?: string;
  em?: string;
  inicial?: boolean;
  total?: number;
  n_lidos?: number;
  ignorados?: number;
  n_pendentes?: number;
  n_erros?: number;
  n_adicionados?: number;
  n_removidos?: number;
  n_alterados?: number;
  repeticoes?: number;
}

const plural = (n: number, singular: string, pluralTexto: string) => `${n} ${n === 1 ? singular : pluralTexto}`;

// String(): tipo fora do contrato (número, objeto) vira texto em vez de quebrar o render do painel.
export function rotuloTipo(tipo?: unknown): string {
  const texto = tipo ? String(tipo) : "";
  return texto ? ROTULOS_TIPO[texto] || texto[0].toUpperCase() + texto.slice(1) : "";
}

/** Uma linha com as contagens da entrada, o texto mostrado no cartão. */
export function resumoEntrada(entrada: Entrada): string {
  if (entrada.tipo === "busca") {
    const partes: string[] = [];
    if (entrada.n_lidos) partes.push(plural(entrada.n_lidos, "lido", "lidos"));
    if (entrada.ignorados) partes.push(`${entrada.ignorados} já no Dashboard`);
    if (entrada.n_pendentes) partes.push(plural(entrada.n_pendentes, "pendente", "pendentes"));
    if (entrada.n_erros) partes.push(`${entrada.n_erros} com erro`);
    return partes.join(", ") || "Nenhum chamado novo";
  }
  if (entrada.inicial) return `Primeira importação: ${plural(entrada.total || 0, "chamado", "chamados")}`;
  const partes: string[] = [];
  if (entrada.n_adicionados) partes.push(plural(entrada.n_adicionados, "adicionado", "adicionados"));
  if (entrada.n_removidos) partes.push(plural(entrada.n_removidos, "removido", "removidos"));
  if (entrada.n_alterados) partes.push(`${entrada.n_alterados} com status alterado`);
  return partes.join(", ") || "Sem mudanças";
}

export function textoRepeticoes(entrada: Entrada): string {
  const vezes = entrada.tipo === "importacao" ? Number(entrada.repeticoes) || 0 : 0;
  return vezes > 0 ? `Reimportado ${plural(vezes, "vez", "vezes")}` : "";
}

export function dataHora(iso?: string): string {
  const data = new Date(iso ?? "");
  return Number.isNaN(data.getTime()) ? "—" : data.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// null: ainda não consultou (o cartão fica vazio, como no HTML de antes).
export type Estado = null | { itens: Entrada[] } | { erro: string };

let estado: Estado = null;
const ouvintes = new Set<() => void>();
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;
function mudar(novo: Estado) {
  estado = novo;
  ouvintes.forEach(ouvinte => ouvinte());
}

let consulta = 0;

// Chamado pelo código antigo a cada carga dos chamados novos. Nunca rejeita: a falha vira o texto do cartão.
export async function carregarResumoHistoricoSebrae(): Promise<void> {
  const minha = ++consulta;
  try {
    const corpo = await apiFetch<{ itens?: unknown }>(`/api/sebrae/historico?limite=${ENTRADAS_NO_CARTAO}`, {
      errorMessage: "Não foi possível consultar o histórico do Dashboard Sebrae.",
    });
    const itens = (Array.isArray(corpo?.itens) ? corpo.itens : []).slice(0, ENTRADAS_NO_CARTAO) as Entrada[];
    if (minha === consulta) mudar({ itens: itens.map(item => item ?? {}) });
  } catch (erro) {
    if (minha === consulta) mudar({ erro: (erro as ApiFetchError).message });
  }
}
