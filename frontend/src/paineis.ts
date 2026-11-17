/// <reference types="vite/client" />
// Fica num módulo próprio porque o Vite sobe as importações do glob eager para o topo do arquivo que o declara:
// importado por main.tsx depois de ./legado/app-entry.js, os painéis só são avaliados depois do código antigo.
export type Acoes = Record<string, (...args: never[]) => unknown>;
export interface ModuloPainel {
  montar(container: HTMLElement): Acoes;
}

export const modulos = import.meta.glob<ModuloPainel>("./paineis/*/montar.tsx", { eager: true });
