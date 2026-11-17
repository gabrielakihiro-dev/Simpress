// Estado compartilhado com a aplicação (frontend/src/aplicacao): o objeto appState de frontend/src/aplicacao/app.ts, publicado em
// window.SimpressApp.state. Painel React que precisar dele lê e grava só por aqui, nunca guarda cópia própria
// (a aplicação continua dona do valor). O piloto (resumo-ativos) não usa estado compartilhado.
export interface EstadoApp {
  currentEquipamento: unknown;
  equipamentoSelectionRevision: number;
  retiradaCidadeSelecionada: string;
  unidadesList: unknown[];
  previaPlanilhasAtual: unknown;
}

function estado(): EstadoApp {
  const atual = window.SimpressApp?.state as EstadoApp | undefined;
  if (!atual) throw new Error("window.SimpressApp.state não existe: frontend/src/arranque/entrada.ts não carregou.");
  return atual;
}

export function lerEstado<K extends keyof EstadoApp>(chave: K): EstadoApp[K] {
  return estado()[chave];
}

export function gravarEstado<K extends keyof EstadoApp>(chave: K, valor: EstadoApp[K]): void {
  estado()[chave] = valor;
}
