// Formas mínimas do que o painel Lembretes e Termos lê do código antigo em window.
// O texto de um lembrete tem dado pessoal: nada aqui vai para log nem para storage.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Registro = Record<string, any>;

interface OpcoesConfirmacao {
  titulo: string;
  mensagem: string;
  confirmar?: string;
  cancelar?: string;
  destrutiva?: boolean;
}

export interface ReferenciaTexto {
  texto: string;
  tipo?: string;
  numero?: string;
}

// O mínimo de um evento de teclado: o código antigo (ponte) e o React passam objetos diferentes para as mesmas ações.
export interface EventoTecla {
  key: string;
  target: EventTarget | null;
  preventDefault: () => void;
}

// Funções que static/app.js e static/js/features publicam em window (confirmação, diálogos, toast, referências).
export interface AppAntigo {
  confirmarAcao?: (opcoes: OpcoesConfirmacao) => Promise<boolean>;
  showToast?: (texto: string, tipo?: string) => void;
  abrirModalAcessivel?: (id: string, focoSeletor?: string, funcaoDeFechar?: string) => void;
  fecharModalAcessivel?: (id: string) => void;
  abrirReferenciaLembrete?: (referencia: { tipo: string; numero: string }, gatilho?: Element) => void;
}

// Lidos na hora do uso, nunca no topo do módulo: o código antigo publica depois de o bundle carregar.
export const appAntigo = () => window as unknown as AppAntigo;
export const referenciasNoTexto = (texto: string): ReferenciaTexto[] =>
  window.SimpressChamadosOsModel?.referenciasNoTexto?.(texto) ?? [{ texto }];
