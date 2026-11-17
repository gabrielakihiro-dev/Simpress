/** Tipos compartilhados pelas pontes e pelo bootstrap (código dinâmico do cockpit antigo: tudo vem de `context`). */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Qualquer = any;

// Ações publicadas por uma feature: nome da função -> função, no formato que o app.js repassa ao `window`.
export type Acoes = Record<string, Qualquer>;

// O que o bootstrap entrega a cada feature (app.js monta; os testes montam versões falsas).
export type ContextoApp = {
  ponteReact: (painel: string, nomes: string[]) => Record<string, (...argumentos: Qualquer[]) => Promise<Qualquer>>;
  ponteReactSincrona: (painel: string, nomes: string[]) => Record<string, (...argumentos: Qualquer[]) => Qualquer>;
  [chave: string]: Qualquer;
};
