// Tipos do painel "Chamados novos do SoftExpert" (Automação). Os dados do servidor (chamados novos, antigos e
// finalizados, resultados da rotina, SharePoint) mudam de campo com frequência e o código antigo os lia por nome:
// ficam como Registro, como em cobertura/tipos.ts. Estado, visão, contexto e modelo têm tipo próprio.
import type { ApiFetchOptions } from "../../api";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Registro = Record<string, any>;
/** Elemento do DOM com as propriedades de controle (value, checked, files, open) que o código antigo lia sem checar o tipo. */
export type ElementoSebrae = HTMLElement & Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

type Par = readonly [string, string];

/** Modelo puro de static/js/shared/sebrae-dashboard-model.js: constantes com tipo e funções com a assinatura frouxa do JS. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Funcao = (...argumentos: any[]) => any;
export interface ModeloSebrae {
  CAMPOS_AUTOMATICOS: readonly Par[];
  CAMPOS_PREENCHIDOS: readonly Par[];
  STATUS_CHAMADO: readonly string[];
  TIPOS_CHAMADO: readonly string[];
  DESCRICAO_API_SEBRAE: string;
  AVISO_CRUZAMENTO: Readonly<Record<string, string>>;
  ROTULOS_FALTA: Readonly<Record<string, string>>;
  MAX_TITULO: number;
  MAX_DESCRICAO: number;
  NUMERO_UTIC: RegExp;
  INTERVALO_FECHAR_MS: number;
  STATUS_DESFEITOS: readonly string[];
  STATUS_OUTRO_TECNICO: string;
  CHAVE_RASCUNHO: string;
  NUMERO_RASCUNHO: RegExp;
  PREFIXO_CAMPO: string;
  AJUDA_ENCERRAMENTO: string;
  ehApiSebrae: Funcao;
  padroesManuais: Funcao;
  avisoOutraPessoa: Funcao;
  avisoNomeDaDescricao: Funcao;
  formatarEncerramento: Funcao;
  encerramentoParaCampo: Funcao;
  payloadEdicoes: Funcao;
  descricaoJaNoDashboard: Funcao;
  tituloAntigo: Funcao;
  dadosAntigo: Funcao;
  encerramentoObrigatorio: Funcao;
  pendenciasEncerramento: Funcao;
  avisoEncerramento: Funcao;
  resumoLeituraAntigos: Funcao;
  totalPreenchimentos: Funcao;
  payloadAtualizacao: Funcao;
  formatarTamanho: Funcao;
  textoResultado: Funcao;
  textoPulado: Funcao;
  camposFaltando: Funcao;
  candidatosFinalizar: Funcao;
  excluidosFinalizar: Funcao;
  avisoExcluidosFinalizar: Funcao;
  resultadoEnvioAtualizacao: Funcao;
  resumoResultado: Funcao;
  resumoInicio: Funcao;
  lerRascunho: Funcao;
  gravarCampoRascunho: Funcao;
  apagarRascunho: Funcao;
  aplicarRascunho: Funcao;
}

export interface DialogoConfirmacao {
  titulo: string;
  mensagem: string;
  confirmar: string;
  cancelar: string;
}

/** O que o painel usa do restante do app (window): chamadas feitas na hora, nunca guardadas em `montar`. */
export interface AppSebrae {
  apiFetch(url: string, opcoes?: Omit<ApiFetchOptions, "responseType">): Promise<Registro>;
  showToast(mensagem: string, tipo?: string): void;
  confirmarAcao(dialogo: DialogoConfirmacao): Promise<boolean | null>;
  abrirJanelaChamadoOs?: (alvo: { chamado: string; serie: unknown; os: unknown }, origem: ElementoSebrae) => unknown;
  atualizarEstadoAutomacao?: () => void;
  carregarResumoHistoricoSebrae?: () => unknown;
  carregarConflitosSebrae?: () => unknown;
  normalizarFiltroChamados?: (valor: unknown) => string;
}

export interface DomSebrae {
  createTextElement(tag: string, classe: string, texto: unknown): ElementoSebrae;
}

export interface ContextoSebraeDashboard {
  app: AppSebrae;
  dom: DomSebrae;
  sebraeDashboardModel: ModeloSebrae;
  ticketRules?: { normalizarFiltroChamados?: (valor: unknown) => string };
}

export interface EstadoSebrae {
  naoSalvos: { valores: Registro; edicoes: Registro };
  rascunhoExterno: boolean;
  formulario: Registro[];
  valores: Registro;
  consulta: number;
  listas: Registro;
  abertos: Registro[];
  edicoes: Registro;
  atualizavel: boolean;
  importadoEm: string;
  versaoImportacao: string;
  descartar: boolean;
  soft: Record<string, Registro>;
  refs: Map<string, Registro>;
  temporizadores: Record<string, number>;
  salvando: Record<string, Promise<boolean>>;
  finalizados: Set<string>;
  observacoes: Record<string, Registro>;
  temporizadoresObs: Record<string, number>;
  salvandoObs: Record<string, Promise<boolean>>;
  destaques: Record<string, Registro>;
  destaqueEditados: Set<string>;
  destaqueOcupado: Set<string>;
  finalizadosItens: Registro[];
  destaqueVersao: number;
  destaqueUltimo: Record<string, Registro>;
  fechar: {
    emAndamento: boolean;
    mensagemInicio: string;
    numeros: string[];
    pulados: Registro[];
    resultado: Registro | null;
    sharepoint: Registro | null;
    token: number;
    recarregado: string;
  };
  antigos: { emAndamento: boolean; resultado: Registro | null; mensagem: string; token: number; anteriorEm: string | null };
}

export interface VisaoSebrae {
  aba: string;
  termo: string;
  paginas: Record<string, number>;
  novosAbertos: Set<string> | null;
  itens: Registro[];
  porNo: Map<Element, Registro>;
}

/** Erro de apiFetch como o código antigo o lia: mensagem, status HTTP e o corpo de erro. */
export type ErroApi = Error & { status?: number; data?: Registro };

/** Um campo pesquisável de um cartão: rótulo, valor e se aparece na linha recolhida. */
export interface CampoVisao { rotulo: string; valor: unknown; naLinha: boolean; norma?: string }
