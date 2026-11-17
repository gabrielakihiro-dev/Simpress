// Formas mínimas do que a API de Cobertura devolve e do que a aplicação publica em window.
// O servidor e ./modelo continuam sendo a fonte da verdade (regras de vaga, kit, ações).

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Registro = Record<string, any>;
export interface Dados extends Registro {
  hoje?: string;
  vagas?: Registro[];
  casos?: Record<string, Record<string, Registro>>;
  bloqueios?: Registro[];
  sinais?: Registro[];
  manutencao?: Registro;
}

export const ABAS = ["necessidades", "disponiveis", "reservas", "movimento", "devolucoes"] as const;
export type Aba = (typeof ABAS)[number];

interface OpcoesConfirmacao {
  titulo: string;
  mensagem: string;
  confirmar?: string;
  cancelar?: string;
  destrutiva?: boolean;
}

// Funções que frontend/src/aplicacao/app.ts publica em window (diálogo de confirmação, Transporte, toast).
interface AppAntigo {
  confirmarAcao?: (opcoes: OpcoesConfirmacao) => Promise<boolean>;
  prepararTransporte?: (dados: Registro) => Promise<unknown>;
  showToast?: (texto: string, tipo?: string) => void;
}

// Lidos na hora do uso, nunca no topo do módulo: uma ação trocada em window (testes) vale em todo lugar (frontend/src/aplicacao/app.ts).
export const appAntigo = () => window as unknown as AppAntigo;
export const casos = (dados: Dados | null, secao: string): Record<string, Registro> => dados?.casos?.[secao] || {};
