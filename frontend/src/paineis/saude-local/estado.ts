// Estado do modal Saúde local (store externo, lido pelo corpo com useSyncExternalStore).
// Contrato da API: GET /api/saude-local, POST /api/saude-local/limpeza[/previa], GET /api/saude-local/diagnostico.

export type ChaveArea = "backups_planilhas" | "logs" | "lotes_processados" | "pacotes_locais" | "quarentena";
export type SituacaoJson = "integro" | "invalido" | "vazio" | "ilegivel" | "grande_demais";
export interface Area { chave: ChaveArea; arquivos: number; bytes: number; existe: boolean }
export interface ArquivoEstado { nome: string; bytes: number; situacao: SituacaoJson; erro: string | null }
export interface SaudeLocal {
  gerado_em: string;
  disco: { livre_bytes: number; total_bytes: number } | null;
  areas: Area[];
  estado_json: { arquivos: ArquivoEstado[]; outros: number; copias_corrompidas: number };
  transacoes: { situacao: "limpo" | "pendente"; quantidade: number };
}
export interface ItemLimpeza { acao: "remover" | "quarentena"; area: "planilhas_entrada" | "state" | "modelos"; caminho: string; bytes: number }
export interface Limpeza {
  aplicada: boolean;
  itens: ItemLimpeza[];
  totais: { remover_arquivos: number; remover_bytes: number; quarentena_arquivos: number; quarentena_bytes: number; preservados: number };
}
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
