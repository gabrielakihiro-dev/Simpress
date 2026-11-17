// Estado compartilhado com o código antigo: o objeto appState de frontend/src/legado/app.js, publicado em
// window.SimpressApp.state. Painel React que precisar dele lê e grava só por aqui, nunca guarda cópia própria
// (o código antigo continua dono do valor). O piloto (resumo-ativos) não usa estado compartilhado.
export interface EstadoApp {
  currentEquipamento: unknown;
  equipamentoSelectionRevision: number;
  retiradaCidadeSelecionada: string;
  unidadesList: unknown[];
  previaPlanilhasAtual: unknown;
}

function estado(): EstadoApp {
  const atual = window.SimpressApp?.state as EstadoApp | undefined;
  if (!atual) throw new Error("window.SimpressApp.state não existe: frontend/src/legado/app-entry.js não carregou.");
  return atual;
}

export function lerEstado<K extends keyof EstadoApp>(chave: K): EstadoApp[K] {
  return estado()[chave];
}

export function gravarEstado<K extends keyof EstadoApp>(chave: K, valor: EstadoApp[K]): void {
  estado()[chave] = valor;
}
