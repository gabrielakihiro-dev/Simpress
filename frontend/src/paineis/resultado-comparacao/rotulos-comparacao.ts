import { seloDoEvento } from "../historico-comparacoes/historico-puro.ts";
import type { EventoHistorico } from "../historico-comparacoes/historico-puro.ts";

// Rótulos do seletor e do status do Resumo (F3, Novo layout) e o aviso que alimenta o cartão "Histórico" do bento.
// Só sintaxe apagável: os testes carregam ferramentas-cockpit/estado.ts, que importa este arquivo, direto no Node.

export const EVENTO_COMPARACOES = "simpress:comparacoes-atualizadas";

const DOIS = (n: number) => String(n).padStart(2, "0");

// "2026-11-12T09:33:00-03:00" -> "12/11/2026 09:33" (hora local do navegador, sem segundos). Valor inválido: "Data indisponível".
export function horarioCurto(horario: unknown): string {
  const texto = String(horario ?? "").trim();
  // Registro antigo já em "dd/mm/aaaa hh:mm": o Date do navegador leria como mês/dia.
  const br = /^(\d{2})\/(\d{2})\/(\d{4})[ T,]+(\d{2}):(\d{2})/.exec(texto);
  if (br) return `${br[1]}/${br[2]}/${br[3]} ${br[4]}:${br[5]}`;
  // Só a data ("2026-11-12") seria lida em UTC e cairia no dia anterior: lê como meia-noite local.
  const data = new Date(/^\d{4}-\d{2}-\d{2}$/.test(texto) ? `${texto}T00:00` : texto);
  if (!horario || Number.isNaN(data.getTime())) return "Data indisponível";
  return `${DOIS(data.getDate())}/${DOIS(data.getMonth() + 1)}/${data.getFullYear()} ${DOIS(data.getHours())}:${DOIS(data.getMinutes())}`;
}

// O "tipo" cru da API ("atualizacao") vira o rótulo legível ("Atualização"); o rótulo é o mesmo do selo do diálogo de histórico.
export function tipoLegivel(evento: { tipo?: unknown; somente_anotacoes_sincronizadas?: unknown } | null | undefined): string {
  return seloDoEvento((evento || {}) as EventoHistorico).tipo;
}

// Opção do seletor: "12/11/2026 09:33 · Atualização".
export function rotuloOpcaoComparacao(evento: { horario?: unknown; tipo?: unknown }): string {
  return `${horarioCurto(evento.horario)} · ${tipoLegivel(evento)}`;
}

// Status ao lado do seletor: "Atualização · 12/11/2026 09:33".
export function rotuloStatusComparacao(evento: { horario?: unknown; tipo?: unknown }): string {
  return `${tipoLegivel(evento)} · ${horarioCurto(evento.horario)}`;
}

export interface AnuncioComparacoes { eventos: unknown[]; selecionadoId: string }
let ultimoAnuncio: AnuncioComparacoes | null = null;
// O último aviso, para o cartão pintar mesmo se o evento passou antes de ele montar.
export const ultimasComparacoes = (): AnuncioComparacoes | null => ultimoAnuncio;

// Avisa o cartão "Histórico" do bento (frontend/src/paineis/resultado-comparacao/bento-resumo.ts) sem novo pedido à API.
export function anunciarComparacoes(eventos: unknown[], selecionadoId: unknown): void {
  ultimoAnuncio = { eventos, selecionadoId: String(selecionadoId || "") };
  if (typeof document === "undefined" || typeof document.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  document.dispatchEvent(new CustomEvent(EVENTO_COMPARACOES, { detail: { eventos, selecionadoId: String(selecionadoId || "") } }));
}
