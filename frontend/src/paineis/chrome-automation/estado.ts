// Estado da aba Automação (F5), fora dos componentes: as ações vivem em acoes.ts e a aplicação as chama pela ponte
// (frontend/src/aplicacao/pontes.ts) antes ou depois de o React desenhar a aba. Cada região da aba é uma raiz
// React própria e todas assinam este mesmo store.
import type { DescricaoEstado, Execucao, LogHistorico } from "./regras-puro";

export interface OpcoesLog {
  tipo: "inicial" | "sem-data" | "carregando" | "lista" | "erro";
  itens: Execucao[];
  texto: string;
}

export interface HistoricoLista {
  tipo: "carregando" | "lista" | "erro";
  execucoes: Execucao[];
  mensagem: string;
}

export interface EstadoAutomacao {
  emAndamento: boolean;
  ocupado: boolean;
  rotinaAtiva: string;
  iniciando: string; // rotina cujo botão leva aria-busy durante o POST
  botoesProntos: boolean; // só depois da primeira atualização os botões ganham disabled/aria-disabled
  descricao: DescricaoEstado | null; // null até o primeiro estado real da API
  verBackups: boolean;
  ultimasPorRotina: Record<string, Execucao | null>;
  logMostrado: boolean; // false até a primeira leitura do log: o modo ainda diz "execução mais recente"
  linhasAoVivo: string[];
  arquivo: string;
  execucaoSelecionada: string;
  logHistorico: LogHistorico | null;
  logErro: string | null; // mensagem do erro ao abrir o log de uma execução; null sem erro
  limiteLog: number;
  opcoes: OpcoesLog;
  versaoOpcoes: number; // muda a cada troca da lista de execuções: o select volta à execução escolhida
  logPaginasVisivel: boolean;
  logPaginaTexto: string;
  logAnteriorDesabilitado: boolean;
  logProximaDesabilitado: boolean;
  historico: HistoricoLista;
  resumoHist: string;
  paginaTexto: string;
  anteriorDesabilitado: boolean;
  proximaDesabilitado: boolean;
}

// Contadores e posições que não desenham nada: ficam fora do store para não gerar render.
export const interno = {
  offset: 0,
  timer: 0,
  ultimaExecucaoId: null as string | null, // null até o primeiro estado, para o histórico carregar uma vez mesmo sem execuções
  acompanharFim: false,
  consultaLog: 0,
  consultaHistorico: 0,
  consultaOpcoes: 0,
  consultaUltimas: 0,
  pagina: 1,
  paginas: 1,
  limite: 5,
  filtros: {} as Record<string, string>,
  logPagina: 1,
  logPaginas: 1,
  avisouServidorAntigo: false,
  desmontar: null as (() => void) | null,
};

let estado: EstadoAutomacao = {
  emAndamento: false,
  ocupado: false,
  rotinaAtiva: "",
  iniciando: "",
  botoesProntos: false,
  descricao: null,
  verBackups: false,
  ultimasPorRotina: {},
  logMostrado: false,
  linhasAoVivo: [],
  arquivo: "",
  execucaoSelecionada: "",
  logHistorico: null,
  logErro: null,
  limiteLog: 200,
  opcoes: { tipo: "inicial", itens: [], texto: "Selecione uma data" },
  versaoOpcoes: 0,
  logPaginasVisivel: false,
  logPaginaTexto: "",
  logAnteriorDesabilitado: false,
  logProximaDesabilitado: false,
  historico: { tipo: "carregando", execucoes: [], mensagem: "" },
  resumoHist: "",
  paginaTexto: "",
  anteriorDesabilitado: false,
  proximaDesabilitado: false,
};

const ouvintes = new Set<() => void>();

export const ler = () => estado;

export function mudar(parcial: Partial<EstadoAutomacao>) {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}

export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
