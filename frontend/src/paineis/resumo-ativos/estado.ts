// Estado do cartão "Ativos por regional" (Resumo, F3), fora do componente: a aplicação chama
// carregarResumoAtivos pela ponte antes ou depois de o React desenhar o cartão.
import { apiFetch } from "../../api";

export const VISIVEIS = 8; // "Ver menos" recolhe para as 8 maiores regionais
export const TEXTO_CARREGANDO = "Carregando dados da base local…";

type Painel = Record<string, unknown>;
export interface Opcao { value: string; label: string; total: number }
export interface Regional { name: string; total: number }

export interface Estado {
  resultado: { tipo: "pronto"; painel: Painel } | { tipo: "erro" } | null;
  carregando: boolean;
  esqueleto: boolean; // só aparece se a resposta passar de 150 ms (contrato do ui-motion)
  filtro: string;
  expandido: boolean; // por padrão mostra todas as regionais
  geracao: number; // muda a cada redesenho das barras: recria as linhas e repete a animação do bento
}

let estado: Estado = { resultado: null, carregando: false, esqueleto: false, filtro: "todos", expandido: true, geracao: 0 };
const ouvintes = new Set<() => void>();
function mudar(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

function lista(valor: unknown): Record<string, unknown>[] {
  return Array.isArray(valor) ? valor.filter(item => item && typeof item === "object") : [];
}
function numero(valor: unknown): number | null {
  if (valor === null || valor === undefined || typeof valor === "boolean" || String(valor).trim() === "") return null;
  const lido = Number(valor);
  return Number.isSafeInteger(lido) && lido >= 0 ? lido : null;
}

export function categorias(painel: Painel): Opcao[] {
  return lista(painel.por_categoria)
    .map(item => ({ value: String(item.value || ""), label: String(item.label || ""), total: numero(item.total) ?? 0 }))
    .filter(item => item.value && item.label);
}

export function opcoes(painel: Painel): Opcao[] {
  return [{ value: "todos", label: "Todos", total: numero(painel.total_equipamentos) ?? 0 }, ...categorias(painel)];
}

export function regionais(painel: Painel, filtro: string): Regional[] {
  const porCategoria = painel.cidades_por_categoria as Record<string, unknown> | null | undefined;
  return lista(filtro === "todos" ? painel.cidades_principais : porCategoria?.[filtro])
    .map(item => ({ name: String(item.cidade || "Sem cidade"), total: numero(item.total) ?? 0 }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "pt-BR"));
}

// Filtro que sumiu ou ficou sem ativos volta para "Todos" (a pílula dele fica desabilitada).
function filtroValido(painel: Painel, filtro: string) {
  return opcoes(painel).some(opcao => opcao.value === filtro && (opcao.value === "todos" || opcao.total > 0)) ? filtro : "todos";
}

export function escolherFiltro(filtro: string) {
  mudar({ filtro, expandido: true, geracao: estado.geracao + 1 });
}

export function alternarExpandido() {
  mudar({ expandido: !estado.expandido, geracao: estado.geracao + 1 });
}

// Clique numa sub-aba do Resumo repete barras e contagens (evento simpress:bento-repetir, comparison-result.js).
export function repetirAnimacao() {
  if (estado.resultado?.tipo === "pronto") mudar({ geracao: estado.geracao + 1 });
}

let pedido = 0;
let relogio: ReturnType<typeof setTimeout> | undefined;

// Chamado ao abrir o Resumo: recarrega o painel local e mantém o filtro escolhido. Nunca rejeita.
// Só a resposta do pedido mais novo vale, se dois se cruzarem.
export async function carregarResumoAtivos(): Promise<void> {
  const meu = ++pedido;
  clearTimeout(relogio);
  relogio = setTimeout(() => { if (meu === pedido) mudar({ esqueleto: true }); }, 150);
  mudar({ carregando: true });
  let resultado: Estado["resultado"];
  try {
    const painel = await apiFetch<unknown>("/api/painel", { cache: "no-store" });
    resultado = { tipo: "pronto", painel: painel && typeof painel === "object" ? (painel as Painel) : {} };
  } catch {
    resultado = { tipo: "erro" };
  }
  if (meu !== pedido) return;
  clearTimeout(relogio);
  mudar({
    resultado,
    carregando: false,
    esqueleto: false,
    filtro: resultado.tipo === "pronto" ? filtroValido(resultado.painel, estado.filtro) : estado.filtro,
    geracao: estado.geracao + 1,
  });
}
