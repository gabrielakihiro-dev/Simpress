// Tipos do painel de dados (tabela de OS, densidade, central de notificações). Os dados do servidor e os elementos do DOM
// chegam sem formato fixo e o código antigo os lia por nome: ficam como Registro/Qualquer, como em ferramentas-cockpit/tipos.ts.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Registro = Record<string, any>;
/** Valor que o código antigo lia sem checar o tipo (parâmetros de callbacks e dados do servidor sem formato fixo). */
export type Qualquer = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** O `window` do navegador ou o objeto falso dos testes: só os membros que o painel lê. */
export type Janela = Registro & { document: Document };
