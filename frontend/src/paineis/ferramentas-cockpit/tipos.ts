import type { ApiFetchOptions } from "../../api";

// Tipos das ferramentas do Cockpit. Os dados do servidor (OS, comparações, apelidos, relatório mensal, planilhas)
// e as ações que os outros painéis publicam em window mudam de campo com frequência e o código antigo os lia por
// nome: ficam como Registro, como em sebrae-dashboard/tipos.ts. Contexto e funções têm tipo próprio.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Registro = Record<string, any>;
/** Elemento do DOM com as propriedades de controle (value, checked, open, max) que o código antigo lia sem checar o tipo. */
export type ElementoCockpit = HTMLElement & Record<string, any>;
/** Valor que o código antigo lia sem checar o tipo (parâmetros de callbacks e dados do servidor sem formato fixo). */
export type Qualquer = any;
/** Função solta, com a assinatura frouxa do JS (ações publicadas em window, ganchos opcionais). */
export type Funcao = (...argumentos: any[]) => any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Contexto da fábrica: o mesmo objeto que static/app.js passava ao módulo antigo, lido de window no montar. */
export interface ContextoFerramentasCockpit {
  /** Ações publicadas em window pelos módulos antigos e pelos outros painéis (selecionarAbaResumo, showToast...). */
  app: Registro;
  appState?: unknown;
  /** Método (não propriedade) para aceitar o apiFetch com sobrecarga de frontend/src/api.ts. */
  apiFetch<T = any>(url: string, options?: ApiFetchOptions): Promise<T>; // eslint-disable-line @typescript-eslint/no-explicit-any
  historyFormat?: Registro;
  chamadosOsModel?: Registro;
}
