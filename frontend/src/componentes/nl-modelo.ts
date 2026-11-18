// Regras puras das peças do Novo layout (sem JSX, para os testes em Node: tests/frontend/test_nl_componentes.cjs).

export type TomNl = "indigo" | "ciano" | "esmeralda" | "fucsia" | "ambar" | "vermelho";
export type TipoToast = "sucesso" | "erro";

// Iniciais do selo de responsável: primeira letra do primeiro e do último nome ("Ana Lima" -> "AL").
export function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return "?";
  const primeira = partes[0][0];
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] : "";
  return (primeira + ultima).toLocaleUpperCase("pt-BR");
}

// NL-Tabelas: a coluna "Anotações" fica sempre por último, em toda tabela.
export const ehAnotacao = (rotulo: string) => rotulo.trim().toLocaleLowerCase("pt-BR") === "anotações";
export function anotacoesNoFim<T extends { rotulo: string }>(colunas: readonly T[]): T[] {
  return [...colunas.filter((c) => !ehAnotacao(c.rotulo)), ...colunas.filter((c) => ehAnotacao(c.rotulo))];
}

// NL-Tabelas: linhas em grupos (ex.: por dia), na ordem em que cada grupo aparece pela primeira vez.
export function agruparLinhas<L>(linhas: readonly L[], grupo: (linha: L) => string): { rotulo: string; linhas: L[] }[] {
  const grupos = new Map<string, L[]>();
  for (const linha of linhas) {
    const rotulo = grupo(linha);
    const lista = grupos.get(rotulo);
    if (lista) lista.push(linha);
    else grupos.set(rotulo, [linha]);
  }
  return [...grupos].map(([rotulo, itens]) => ({ rotulo, linhas: itens }));
}

// NL-Responsaveis (F5): CLIENTE em ciano, SIMPRESS em índigo.
export type LadoResponsavel = "CLIENTE" | "SIMPRESS";
export const tomDoLado = (lado: LadoResponsavel): TomNl => (lado === "CLIENTE" ? "ciano" : "indigo");

// Erro fica mais tempo na tela para dar tempo de ler.
export function duracaoToast(tipo: TipoToast): number {
  return tipo === "erro" ? 6000 : 4000;
}
