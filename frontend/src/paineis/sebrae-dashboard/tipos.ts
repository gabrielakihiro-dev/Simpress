// Tipos do painel "Chamados novos do SoftExpert" (Automação). Os dados do servidor (chamados novos, antigos e
// finalizados, resultados da rotina, SharePoint) mudam de campo com frequência e o código antigo os lia por nome:
// ficam como Registro, como em cobertura/tipos.ts. Estado, visão, contexto e modelo têm tipo próprio.
import type { ApiFetchOptions } from "../../api";
import type { LojaLeitura } from "./leitura-loja";
import type { LojaAvisos, LojaRascunho } from "./lojas";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Os antigos em aberto (`abertos[]`) trazem `os_nova` e, no lugar dele, `os_sem_relacao` (nunca os dois com valor). */
export type Registro = Record<string, any> & { os_sem_relacao?: OsSemRelacao | null };
/** Elemento do DOM com as propriedades de controle (value, checked, files, open) que o código antigo lia sem checar o tipo. */
export type ElementoSebrae = HTMLElement & Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

type Par = readonly [string, string];

/** Modelo puro de frontend/src/comum/sebrae-dashboard-model.ts: constantes com tipo e funções com a assinatura frouxa do JS. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Funcao = (...argumentos: any[]) => any;
export interface ModeloSebrae {
  CAMPOS_AUTOMATICOS: readonly Par[];
  CAMPOS_PREENCHIDOS: readonly Par[];
  STATUS_CHAMADO: readonly string[];
  STATUS_FINALIZADO: string;
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
  encerramentoAgora: Funcao;
  payloadEdicoes: Funcao;
  descricaoJaNoDashboard: Funcao;
  tituloAntigo: Funcao;
  dadosAntigo: Funcao;
  encerramentoInformado: Funcao;
  ajudaEncerramentoSemHora: Funcao;
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
  blocoOutroTecnico: Funcao;
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

/** Bloco com caixa do diálogo de confirmação (`blocoOutroTecnico`); `bloqueio` não vazio deixa a caixa desabilitada e explica o motivo. */
export interface BlocoConfirmacao {
  id: string;
  titulo: string;
  texto: string;
  linhas: string[][];
  caixa: string;
  ajudaDesmarcada: string;
  ajudaMarcada: string;
  bloqueio: string;
}

/** Resposta do diálogo com blocos: `marcados` são os `id` das caixas marcadas (vazio se Esc, fechar ou Cancelar). */
export interface RespostaBlocos { confirmado: boolean | null; marcados: string[] }

/** O que o painel usa do restante do app (window): chamadas feitas na hora, nunca guardadas em `montar`. */
export interface AppSebrae {
  apiFetch(url: string, opcoes?: Omit<ApiFetchOptions, "responseType">): Promise<Registro>;
  showToast(mensagem: string, tipo?: string): void;
  copiarTextoParaAreaTransferencia(texto: string): Promise<unknown>;
  confirmarAcao(dialogo: DialogoConfirmacao & { blocos: BlocoConfirmacao[] }): Promise<RespostaBlocos>;
  confirmarAcao(dialogo: DialogoConfirmacao): Promise<boolean | null>;
  abrirJanelaChamadoOs?: (alvo: { chamado: string; serie: unknown; os: unknown }, origem: ElementoSebrae) => unknown;
  atualizarEstadoAutomacao?: () => void;
  acompanharExecucaoAutomacao?: (estado: Registro) => void;
  carregarResumoHistoricoSebrae?: () => unknown;
  carregarConflitosSebrae?: () => unknown;
  normalizarFiltroChamados?: (valor: unknown) => string;
}

export interface DomSebrae {
  createTextElement(tag: string, classe: string, texto: unknown): ElementoSebrae;
}

/** Textos de uma OS como o servidor os devolve em `os_nova`: strings vazias quando a OS não tem texto. */
export interface TextosOs { os: string; assunto: string; descricao: string; data: string }

/** `abertos[].os_nova` (GET /api/sebrae/novos): troca já feita, sugestão com OS em E, ou OS achada para chamado sem OS. */
export interface OsNova {
  tipo: "troca" | "sugestao" | "sem_os";
  atual: TextosOs | null;
  nova: TextosOs & { serie: string; fonte: string };
  sinais: { mesma_serie: boolean; nome: boolean; assunto: boolean; numero_chamado: boolean };
  /** Corpo pronto de PUT /api/operacoes/chamados/vinculos-os. */
  aceitar: { fonte: string; serie: string; os: string; ano: number; numero: string };
}

/** `abertos[].os_sem_relacao` (GET /api/sebrae/novos, 18/11/2026): a OS da coluna E não tem relação com o chamado. Sem `nova` nem `aceitar`; quando existe, `os_nova` vem null. */
export interface OsSemRelacao {
  tipo: "sem_relacao";
  atual: TextosOs;
  sinais: { assunto: boolean; numero_chamado: boolean; data_anterior: boolean };
}

/** Resultado de uma decisão já gravada: a nota fica no cartão mesmo depois que o recarregamento tira `os_nova`. */
export interface DecisaoOs { acao: "aceita" | "recusada"; os: string }

/** Mesma ideia para o aviso "sem relação": Manter ou Remover a OS da coluna E (`os` é a OS atual, não uma nova). */
export interface DecisaoSemRelacao { acao: "mantida" | "removida"; os: string }

/** Ponte do componente React `sugestao-os.tsx` (injetada por montar.tsx): estado.ts não importa JSX porque os testes o carregam sem transformação. */
export interface SugestaoOsPainel {
  /** Desenha (ou redesenha) a caixa no host; desmonta a raiz anterior do mesmo chamado. `recarregar` roda depois de uma decisão gravada. */
  montar(host: HTMLElement, chamado: { numero: string; osNova: OsNova | null; osSemRelacao: OsSemRelacao | null; recarregar: () => unknown }): void;
  /** Há decisão guardada para o chamado: o host precisa existir mesmo sem `os_nova`. */
  temDecisao(numero: string): boolean;
  /** Desmonta as raízes cujo host saiu do DOM (lista redesenhada, chamado finalizado). */
  limparOrfas(): void;
}

export interface ContextoSebraeDashboard {
  app: AppSebrae;
  dom: DomSebrae;
  sebraeDashboardModel: ModeloSebrae;
  ticketRules?: { normalizarFiltroChamados?: (valor: unknown) => string };
  /** Opcional: sem ele a sugestão de OS não é desenhada (testes sem React). */
  sugestaoOs?: SugestaoOsPainel;
  /** Loja dos chips da última leitura dos antigos; o montar cria a que o React lê (sem ela a fábrica usa uma própria). */
  lojaLeitura?: LojaLeitura;
  /** Lojas dos avisos dos novos e do rascunho (avisos-rascunho.tsx); mesma regra da lojaLeitura. */
  lojaAvisos?: LojaAvisos;
  lojaRascunho?: LojaRascunho;
}

export interface EstadoSebrae {
  naoSalvos: { valores: Registro; edicoes: Registro };
  rascunhoExterno: boolean;
  formulario: Registro[];
  valores: Registro;
  consulta: number;
  /** `Date.now()` do pedido de GET /api/sebrae/novos que está na tela (sem lista: ausente). */
  novosPedidoEm?: number;
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
  /** Trava por chamado enquanto Finalizar ou o envio/remoção do PDF está em andamento (os recálculos de botão a respeitam). */
  finalizando: Set<string>;
  pdfOcupado: Map<string, number>;
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
