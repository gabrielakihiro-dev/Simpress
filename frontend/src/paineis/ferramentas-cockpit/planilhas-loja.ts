// Estado da sub-aba Planilhas, lido por planilhas.tsx (useSyncExternalStore) e escrito por loadSheets em estado.ts.
// Só sintaxe apagável: os testes carregam estado.ts direto no Node.
export interface LinhaPlanilha { key: string; label: string; file: string; total: string; atualizado: string; situacao: string }
export interface EstadoPlanilhas {
  status: string;
  /** [rótulo, valor já formatado] */
  kpis: [string, string][];
  /** null = a lista nunca foi desenhada (tbody vazio). */
  linhas: LinhaPlanilha[] | null;
  /** Se houver, o tbody mostra só esta mensagem (carregando ou erro) e as linhas antigas ficam guardadas. */
  mensagemLista: string | null;
  selecionada: string;
}
export type LojaPlanilhas = ReturnType<typeof criarLojaPlanilhas>;

export function criarLojaPlanilhas() {
  let estado: EstadoPlanilhas = { status: "Carregando…", kpis: [], linhas: null, mensagemLista: null, selecionada: "" };
  const ouvintes = new Set<() => void>();
  return {
    assinar(ouvinte: () => void) { ouvintes.add(ouvinte); return () => { ouvintes.delete(ouvinte); }; },
    ler: () => estado,
    atualizar(parte: Partial<EstadoPlanilhas>) { estado = { ...estado, ...parte }; ouvintes.forEach(ouvinte => ouvinte()); },
  };
}
