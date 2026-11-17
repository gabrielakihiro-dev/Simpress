// Formas mínimas do que o painel Lembretes e Termos lê da aplicação em window.
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

// O mínimo de um evento de teclado: a aplicação (ponte) e o React passam objetos diferentes para as mesmas ações.
export interface EventoTecla {
  key: string;
  target: EventTarget | null;
  preventDefault: () => void;
}

// Funções que as features de frontend/src/aplicacao publicam em window (por app.ts) (confirmação, diálogos, toast, referências).
export interface AppAntigo {
  confirmarAcao?: (opcoes: OpcoesConfirmacao) => Promise<boolean>;
  showToast?: (texto: string, tipo?: string) => void;
  abrirModalAcessivel?: (id: string, focoSeletor?: string, funcaoDeFechar?: string) => void;
  fecharModalAcessivel?: (id: string) => void;
  abrirReferenciaLembrete?: (referencia: { tipo: string; numero: string }, gatilho?: Element) => void;
}

// Lidos na hora do uso, nunca no topo do módulo: uma ação trocada em window (testes) vale em todo lugar (frontend/src/aplicacao/app.ts).
export const appAntigo = () => window as unknown as AppAntigo;
export { referenciasNoTexto } from "../paineis-dados/chamados-os.ts";
