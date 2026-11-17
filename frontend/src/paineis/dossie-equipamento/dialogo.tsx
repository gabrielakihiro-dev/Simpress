import { useSyncExternalStore } from "react";
import { COLUNAS, TEXTO, VAZIO, assinar, ler, verOs, type Linha } from "./estado";

// Conteúdo de .ck-dialogo do #modal-dossie-equipamento (frontend/partials/modais.html). Mesmos IDs, classes e ARIA do
// diálogo antigo: todos os elementos existem sempre e só o atributo hidden muda, como antes.
function LinhaDaOrdem({ linha }: { linha: Linha }) {
  return (
    <tr>
      <td data-label={COLUNAS[0]}>{linha.numero || VAZIO}</td>
      <td data-label={COLUNAS[1]}>{linha.fonte}</td>
      <td data-label={COLUNAS[2]}>{linha.status}</td>
      <td data-label={COLUNAS[3]}>{linha.fila}</td>
      <td data-label={COLUNAS[4]}>{linha.dias}</td>
      <td data-label={COLUNAS[5]}>
        {linha.utic ? <><span>{linha.utic.chamado}</span>{" "}<span className="ck-tag ck-tag--neutra">{linha.utic.origem}</span></> : VAZIO}
      </td>
      <td data-label="" className="ck-td--sem-rotulo">
        <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" aria-label={`${TEXTO.verOs} ${linha.numero}`}
          onClick={() => verOs(linha)}>{TEXTO.verOs}</button>
      </td>
    </tr>
  );
}

export function Dialogo() {
  const { serie, modelo, status, corpo } = useSyncExternalStore(assinar, ler);
  const historico = corpo?.historico ?? null;
  return (
    <>
      <header className="dossie-equip__cab">
        <h3 id="titulo-dossie-equipamento" className="text-base font-bold">Dossiê do equipamento</h3>
        <p className="dossie-equip__id"><strong id="dossie-serie">{serie}</strong><span id="dossie-modelo">{modelo}</span></p>
      </header>
      <p id="dossie-status" className="dossie-equip__status" role="status" aria-live="polite" hidden={!status}>{status}</p>
      <section id="dossie-os" className="dossie-equip__secao" aria-labelledby="dossie-os-titulo" hidden={!corpo}>
        <h4 id="dossie-os-titulo" className="dossie-equip__subtitulo">OS e chamados</h4>
        <p id="dossie-os-mensagem" className="dossie-equip__mensagem" hidden={!corpo?.mensagem}>{corpo?.mensagem}</p>
        <p id="dossie-os-importacoes" hidden={!corpo?.importacoes}>{corpo?.importacoes}</p>
        <p id="dossie-os-observada" hidden={!corpo?.observada}>{corpo?.observada}</p>
        <div id="dossie-os-ordens" className="dossie-equip__ordens" hidden={!corpo?.linhas.length}>
          <table className="ck-tabela ck-tabela--cards">
            <thead>
              <tr>
                {COLUNAS.map(coluna => <th key={coluna} scope="col">{coluna}</th>)}
                <th scope="col"><span className="ck-sr">{TEXTO.verOs}</span></th>
              </tr>
            </thead>
            <tbody id="dossie-os-linhas">
              {corpo?.linhas.map((linha, i) => <LinhaDaOrdem key={`${i}-${linha.numero}`} linha={linha} />)}
            </tbody>
          </table>
        </div>
        <div id="dossie-historico" className="dossie-equip__historico" hidden={!historico}>
          <h4 id="dossie-historico-titulo" className="dossie-equip__subtitulo">{historico?.titulo}</h4>
          <ul id="dossie-historico-lista" className="dossie-equip__eventos">
            {historico?.eventos.map((evento, i) => (
              <li key={i} className="dossie-equip__evento">
                <p className="dossie-equip__evento-cab">
                  <time dateTime={evento.datetime || undefined}>{evento.quando}</time>{" · "}<strong>{evento.tipo}</strong>
                </p>
                {evento.mudancas.length > 0 && (
                  <ul className="dossie-equip__mudancas">
                    {evento.mudancas.map((mudanca, j) => <li key={j}>{mudanca}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <p id="dossie-historico-vazio" hidden={!historico || historico.eventos.length > 0}>{TEXTO.semMudancas}</p>
        </div>
      </section>
      <div className="pt-3 border-t border-line-quiet flex items-center justify-end gap-3 shrink-0">
        {/* data-on-click como antes: o despachante de ações (frontend/src/ui/action-dispatcher.ts) chama window.fecharDossieEquipamento (a ponte) */}
        <button type="button" id="dossie-fechar" data-on-click="fecharDossieEquipamento" className="ck-btn ck-btn--secundario">Fechar</button>
      </div>
    </>
  );
}
