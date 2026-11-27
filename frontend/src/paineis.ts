/// <reference types="vite/client" />
// Fica num módulo próprio porque o Vite sobe as importações do glob eager para o topo do arquivo que o declara:
// importado por main.tsx depois de ./arranque/entrada.ts, os painéis só são avaliados depois da aplicação.
export type Acoes = Record<string, (...args: never[]) => unknown>;
export interface ModuloPainel {
  montar(container: HTMLElement): Acoes;
}

// Painéis sob demanda: cada um vira um arquivo próprio em static/dist, baixado e montado na primeira chamada da ponte
// (frontend/src/aplicacao/app.ts). Só entra aqui painel cuja ponte é toda assíncrona (nada de ponteReactSincrona nem
// leitura direta de window.SimpressReact), com o container escondido na partida e sem nada que precise rodar antes de
// abrir (ouvinte, timer, chamada da aplicação no arranque). A lista se repete nos dois globs: o Vite só aceita literal.
export const modulos = import.meta.glob<ModuloPainel>(
  [
    "./paineis/*/montar.tsx",
    "!./paineis/{assistant-chat,cobertura,configuracao-local,dossie-equipamento,editar-apelido,editar-equipamento,lembretes,outlook-email,pesquisa-completa,resumo-ativos,saude-local,ux-ticket}/montar.tsx",
  ],
  { eager: true },
);
export const modulosSobDemanda = import.meta.glob<ModuloPainel>(
  "./paineis/{assistant-chat,cobertura,configuracao-local,dossie-equipamento,editar-apelido,editar-equipamento,lembretes,outlook-email,pesquisa-completa,resumo-ativos,saude-local,ux-ticket}/montar.tsx",
);
