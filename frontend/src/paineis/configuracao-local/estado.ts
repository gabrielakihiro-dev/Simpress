// Estado do modal Configuração local (store externo, lido pelo corpo com useSyncExternalStore).
// Contrato da API e regras: docs/cockpit-prompts/19-configuracao-local.md.

export interface Campo {
  rotulo: string;
  placeholder?: string;
  ajuda?: string;
  valor?: string;
  fonte?: string;
  somente_leitura?: boolean;
  valido?: boolean;
}
export interface Conta extends Campo {
  id: string;
  usar_no_outlook?: boolean | null;
}
export interface Link extends Campo {
  chave: string;
}
export interface EstadoChave {
  configurada?: boolean;
  final?: string;
  fonte?: string;
}
export interface Leitura {
  contas: Conta[];
  links: Link[];
  contas_arquivo_invalido?: boolean;
  cliente?: { arquivo_invalido?: boolean };
  assistente?: Record<string, EstadoChave>;
}
export interface Cliente {
  contrato?: unknown;
  cnpj_faturamento?: unknown;
  series_sebrae_fora?: unknown;
  cliente_fontes?: Record<string, string>;
}

export type Secao = "contas" | "links" | "cliente" | "assistente";
export type TipoStatus = "" | "ok" | "erro";
export interface Status {
  texto: string;
  tipo: TipoStatus;
}

export interface Estado {
  /** Texto de #cfg-local-carga; vazio esconde o parágrafo. */
  carga: string;
  cargaErro: boolean;
  leitura: Leitura | null;
  cliente: Cliente | null;
  /** Seções visíveis (depois de uma leitura bem-sucedida). */
  aberto: boolean;
  atalhos: boolean;
  ocupado: boolean;
  status: Record<Secao, Status>;
  /** Revisão por grupo: muda quando os campos devem voltar ao valor do servidor (como o replaceChildren antigo). */
  revisao: Record<"contas" | "links" | "cliente" | "chaves", number>;
}

const SEM_STATUS: Status = { texto: "", tipo: "" };

let estado: Estado = {
  carga: "Carregando a configuração…",
  cargaErro: false,
  leitura: null,
  cliente: null,
  aberto: false,
  atalhos: false,
  ocupado: false,
  status: { contas: SEM_STATUS, links: SEM_STATUS, cliente: SEM_STATUS, assistente: SEM_STATUS },
  revisao: { contas: 0, links: 0, cliente: 0, chaves: 0 },
};
const ouvintes = new Set<() => void>();

export function ler(): Estado {
  return estado;
}

export function assinar(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

export function mudar(parcial: Partial<Estado>): void {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}

export function mudarStatus(secao: Secao, texto: string, tipo: TipoStatus = ""): void {
  mudar({ status: { ...estado.status, [secao]: { texto: texto || "", tipo } } });
}

export function novaRevisao(...grupos: (keyof Estado["revisao"])[]): Estado["revisao"] {
  const revisao = { ...estado.revisao };
  grupos.forEach(grupo => { revisao[grupo] += 1; });
  return revisao;
}
