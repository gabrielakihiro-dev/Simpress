// Paginação local da lista do F7: o histórico inteiro já está na memória, então "Carregar mais" só aumenta a fatia exibida.
// Módulo puro (sem importação, sem DOM): o painel em ferramentas-cockpit/estado.ts chama estas funções.
export const TAMANHO_PAGINA_HISTORICO = 50;

export interface FatiaHistorico<T> {
  visiveis: T[];
  restantes: number;
}

// `paginas` conta a primeira página; o registro selecionado nunca fica fora da fatia (indiceSelecionado < 0 = nenhum).
export function fatiaHistorico<T>(itens: readonly T[], paginas: number, indiceSelecionado = -1, tamanho = TAMANHO_PAGINA_HISTORICO): FatiaHistorico<T> {
  const paginasValidas = Number.isFinite(paginas) ? Math.max(1, Math.floor(paginas)) : 1;
  const limite = Math.min(itens.length, Math.max(paginasValidas * tamanho, indiceSelecionado + 1));
  return { visiveis: itens.slice(0, limite), restantes: itens.length - limite };
}

// Mudou a busca, o tipo, o período, a opção "somente com ação" ou a quantidade de registros: volta para a primeira página.
export function chaveFiltroHistorico(partes: readonly unknown[]): string {
  return partes.map(parte => String(parte)).join("\u0001");
}
