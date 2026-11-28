// Lojas dos pedaços do F5 que já são React (chips da leitura, avisos dos novos, rascunho): estado.ts escreve, os
// componentes leem por useSyncExternalStore. Só sintaxe apagável: os testes carregam estado.ts direto no Node.
export function criarLoja<T>(inicial: T) {
  let estado = inicial;
  const ouvintes = new Set<() => void>();
  return {
    assinar(ouvinte: () => void) { ouvintes.add(ouvinte); return () => { ouvintes.delete(ouvinte); }; },
    ler: () => estado,
    atualizar(parte: Partial<T>) { estado = { ...estado, ...parte }; ouvintes.forEach(ouvinte => ouvinte()); },
  };
}

/** Avisos de #sebrae-novos-avisos (pendentes e não lidos); vazio = o bloco fica vazio. */
export interface EstadoAvisos { itens: string[] }
export const criarLojaAvisos = () => criarLoja<EstadoAvisos>({ itens: [] });
export type LojaAvisos = ReturnType<typeof criarLojaAvisos>;

/** Linha do detalhe do rascunho: texto solto ou um chamado com as seleções [letra, valor]. */
export type ItemRascunho = string | { numero: string; campos: [string, string][] };
export interface EstadoRascunho {
  texto: string;
  /** Vai para data-estado do bloco: "ok", "alerta", "erro" ou vazio. */
  situacao: string;
  detalhes: ItemRascunho[];
  /** Quantas vezes mostrarRascunho rodou: 0 = nunca (o partial fica como veio); cada vez recolhe a lista de novo. */
  versao: number;
}
export const criarLojaRascunho = () => criarLoja<EstadoRascunho>({ texto: "", situacao: "", detalhes: [], versao: 0 });
export type LojaRascunho = ReturnType<typeof criarLojaRascunho>;

/** Número e aria-label de cada sub-aba do F5 (novos, antigos, destaques, finalizados) e o texto do resultado do filtro.
 *  `abas` null = aplicarVisao ainda não rodou: o partial fica como veio ("0", "Novos: 0 chamados", sem data-zero). */
export interface EstadoAbas {
  abas: Record<string, { n: number; rotulo: string }> | null;
  resultado: string;
  /** Conta as chamadas de aplicarVisao: cada uma reescreve o texto do resultado (role=status), como o textContent fazia. */
  versao: number;
}
export const criarLojaAbas = () => criarLoja<EstadoAbas>({ abas: null, resultado: "", versao: 0 });
export type LojaAbas = ReturnType<typeof criarLojaAbas>;

/** Resultado do Atualizar/Fechar (#sebrae-fechar): status, rotina em andamento e a lista de avisos, erros e pulados. */
export interface EstadoFechar {
  status: string;
  ocupado: boolean;
  itens: { status: string; texto: string }[];
  /** Conta as chamadas de renderizarFechar: 0 = nunca (o partial fica como veio); cada uma reescreve o status (role=status). */
  versao: number;
}
export const criarLojaFechar = () => criarLoja<EstadoFechar>({ status: "", ocupado: false, itens: [], versao: 0 });
export type LojaFechar = ReturnType<typeof criarLojaFechar>;

/** Avisos dos destaques: o anúncio de marcar/tirar (#sebrae-destaque-anuncio) e o resumo da aba (#sebrae-destaques-resumo), regiões role=status. */
export interface EstadoDestaques {
  anuncio: string;
  resumo: string;
  /** Contam as chamadas: 0 = nunca (o partial fica como veio); cada uma põe um nó de texto novo, como o replaceChildren/textContent faziam. */
  versaoAnuncio: number;
  versaoResumo: number;
}
export const criarLojaDestaques = () => criarLoja<EstadoDestaques>({ anuncio: "", resumo: "", versaoAnuncio: 0, versaoResumo: 0 });
export type LojaDestaques = ReturnType<typeof criarLojaDestaques>;

/** Selo de um item da lista mestre: a estrela de destaque ou um selo de texto. `tom` vira data-nl-tom (selo CLIENTE/SIMPRESS).
 *  A estrela leva status/title quando copia o selo `Destaque` do resumo (que tem data-status). */
export type SeloMestre =
  | { estrela: true; status?: string; title?: string }
  | { estrela?: undefined; classe: string; texto: string; status?: string; title?: string; tom?: string };
/** Item da lista compacta (#sebrae-<aba>-mestre): número, selos, título, `quem`, data e trecho achado pelo filtro. */
export interface ItemMestre { numero: string; titulo: string; quem: string; selos: SeloMestre[]; selecionado: boolean; tom?: string; quando?: string; achado?: string; osDecidir?: string }
export interface EstadoMestre {
  listas: Record<string, ItemMestre[]>;
  /** Conta as chamadas de atualizarMestre: 0 = nunca (o partial fica como veio); cada uma recria os nós, como o replaceChildren. */
  versao: number;
}
export const criarLojaMestre = () => criarLoja<EstadoMestre>({ listas: {}, versao: 0 });
export type LojaMestre = ReturnType<typeof criarLojaMestre>;
