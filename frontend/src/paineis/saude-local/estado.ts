// Estado do modal Saúde local (store externo, lido pelo corpo com useSyncExternalStore).
// Contrato da API: GET /api/saude-local, POST /api/saude-local/limpeza[/previa], GET /api/saude-local/diagnostico.

import type { Area, ArquivoJson, ItemLimpeza, Limpeza, SaudeLocal } from "../../api-tipos.gerado";

export type { Area, ArquivoJson, ItemLimpeza, Limpeza, SaudeLocal };
export type ChaveArea = Area["chave"];
export type SituacaoJson = ArquivoJson["situacao"];
export interface Aviso { titulo: string; detalhe: string; tipo: "alerta" | "erro" }

export interface Estado {
  carga: string;
  cargaErro: boolean;
  saude: SaudeLocal | null;
  previa: Limpeza | null;
  resultado: Limpeza | null;
  avisoLimpeza: Aviso | null;
  avisoDiagnostico: Aviso | null;
  ocupado: boolean;
}

let estado: Estado = {
  carga: "Carregando a saúde local…", cargaErro: false, saude: null, previa: null, resultado: null,
  avisoLimpeza: null, avisoDiagnostico: null, ocupado: false,
};
const ouvintes = new Set<() => void>();

export const ler = (): Estado => estado;

export function assinar(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

export function mudar(parcial: Partial<Estado>): void {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}

const NUMERO = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** 1024 por degrau: bytes e KB inteiros, MB e GB com uma casa ("1,2 GB", "418 KB", "0 B"). */
export function formatarBytes(bytes: number): string {
  if (!(bytes > 0)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${NUMERO.format(bytes / 1024 ** 2)} MB`;
  return `${NUMERO.format(bytes / 1024 ** 3)} GB`;
}

export const plural = (n: number, um: string, varios: string): string => `${n} ${n === 1 ? um : varios}`;
