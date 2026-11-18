import type { KeyboardEvent, ReactNode } from "react";
import { agruparLinhas, anotacoesNoFim, ehAnotacao } from "./nl-modelo";

export type ColunaNl<L> = { chave: string; rotulo: string; render: (linha: L) => ReactNode };

// NL-Tabelas: tabela no desktop, cartões no celular (cada td leva data-rotulo para o rótulo do cartão).
// "Anotações" vai sempre para o fim; aoAbrir torna a linha clicável e acionável por Enter.
// grupo (opcional) separa as linhas em blocos com rótulo e contagem (ex.: por dia).
export function TabelaNl<L>({
  legenda,
  colunas,
  linhas,
  chaveLinha,
  aoAbrir,
  selecionada,
  grupo,
  vazio = "Nada para mostrar.",
}: {
  legenda: string;
  colunas: readonly ColunaNl<L>[];
  linhas: readonly L[];
  chaveLinha: (linha: L) => string;
  aoAbrir?: (linha: L) => void;
  selecionada?: string;
  grupo?: (linha: L) => string;
  vazio?: string;
}) {
  const ordem = anotacoesNoFim(colunas);
  const teclar = (e: KeyboardEvent<HTMLTableRowElement>, linha: L) => {
    if (e.key === "Enter" && e.target === e.currentTarget) aoAbrir?.(linha);
  };

  const linhaTr = (linha: L) => {
    const chave = chaveLinha(linha);
    return (
      <tr
        key={chave}
        className="nl-tabela__lin"
        data-clicavel={aoAbrir ? "" : undefined}
        data-selecionada={selecionada === chave ? "" : undefined}
        tabIndex={aoAbrir ? 0 : undefined}
        onClick={aoAbrir ? () => aoAbrir(linha) : undefined}
        onKeyDown={aoAbrir ? (e) => teclar(e, linha) : undefined}
      >
        {ordem.map((c) => (
          <td key={c.chave} data-rotulo={c.rotulo} className={ehAnotacao(c.rotulo) ? "nl-tabela__anot" : undefined}>
            {c.render(linha)}
          </td>
        ))}
      </tr>
    );
  };

  return (
    <div className="nl-tabela">
      <table className="nl-tabela__t">
        <caption className="sr-only">{legenda}</caption>
        <thead>
          <tr>{ordem.map((c) => <th key={c.chave} scope="col">{c.rotulo}</th>)}</tr>
        </thead>
        {linhas.length === 0 ? (
          <tbody>
            <tr><td className="nl-tabela__vazio" colSpan={ordem.length}>{vazio}</td></tr>
          </tbody>
        ) : grupo ? (
          agruparLinhas(linhas, grupo).map((g) => (
            <tbody key={g.rotulo} className="nl-tabela__grupo">
              <tr>
                <th scope="rowgroup" colSpan={ordem.length}>
                  {g.rotulo}<span className="nl-tabela__grupo-q">{g.linhas.length}</span>
                </th>
              </tr>
              {g.linhas.map(linhaTr)}
            </tbody>
          ))
        ) : (
          <tbody>{linhas.map(linhaTr)}</tbody>
        )}
      </table>
    </div>
  );
}
