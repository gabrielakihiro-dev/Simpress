import { useSyncExternalStore } from "react";
import { COLUNAS, FILTRO_TUDO, TEXTO, VAZIO, assinar, escolherFiltro, ler, verOs, type Linha } from "./estado";

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

// A contagem visível fica aria-hidden: o nome acessível lê "OS, 2 eventos", não "OS2".
const nomePilula = (rotulo: string, total: number) => `${rotulo}, ${total} ${total === 1 ? "evento" : "eventos"}`;

export function Dialogo() {
  const { serie, modelo, status, corpo, linha, filtro, trocado } = useSyncExternalStore(assinar, ler);
  const contagens = linha?.contagens ?? [];
  // Filtro que já não tem eventos (não ocorre hoje) cai em "Tudo".
  const ativo = contagens.some(c => c.tipo === filtro) ? filtro : FILTRO_TUDO;
  const rotuloAtivo = contagens.find(c => c.tipo === ativo)?.rotulo ?? TEXTO.tudo;
  const eventos = (linha?.eventos ?? []).filter(e => ativo === FILTRO_TUDO || e.tipo === ativo);
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
      </section>
      <section id="dossie-linha" className="dossie-equip__secao" aria-labelledby="dossie-linha-titulo" hidden={!linha}>
        <h4 id="dossie-linha-titulo" className="dossie-equip__subtitulo">Linha do tempo</h4>
        <p id="dossie-linha-indisponivel" className="dossie-equip__mensagem dossie-equip__mensagem--alerta" hidden={!linha?.indisponivel}>{linha?.indisponivel}</p>
        <p id="dossie-filtro-impresso" className="dossie-equip__so-impressao">Filtro: {rotuloAtivo}</p>
        <div className="dossie-equip__filtros" role="group" aria-label="Filtrar a linha do tempo" hidden={contagens.length === 0}>
          <button type="button" className="dossie-equip__pilula" aria-pressed={ativo === FILTRO_TUDO} aria-label={nomePilula(TEXTO.tudo, linha?.eventos.length ?? 0)} onClick={() => escolherFiltro(FILTRO_TUDO)}>
            {TEXTO.tudo}<span className="dossie-equip__n" aria-hidden="true">{linha?.eventos.length}</span>
          </button>
          {contagens.map(c => (
            <button key={c.tipo} type="button" className="dossie-equip__pilula" aria-pressed={ativo === c.tipo} aria-label={nomePilula(c.rotulo, c.total)} onClick={() => escolherFiltro(c.tipo)}>
              {c.rotulo}<span className="dossie-equip__n" aria-hidden="true">{c.total}</span>
            </button>
          ))}
        </div>
        <ol id="dossie-linha-lista" key={ativo} className={trocado ? "dossie-equip__linha dossie-equip__linha--troca" : "dossie-equip__linha"} aria-label="Eventos, do mais recente ao mais antigo">
          {eventos.map((evento, i) => (
            <li key={i} className="dossie-equip__ev">
              <time dateTime={evento.datetime || undefined}>{evento.quando}</time>
              <span className="ck-tag ck-tag--neutra">{evento.rotulo}</span>
              <div>
                <p className="dossie-equip__ev-titulo">{evento.titulo}</p>
                {evento.detalhes.length > 0 && (
                  // LGPD: apelido e usuário só na tela; o CSS os esconde na impressão.
                  <ul className={`dossie-equip__mudancas${evento.tipo === "apelido_usuario" ? " dossie-equip__so-tela" : ""}`}>
                    {evento.detalhes.map((detalhe, j) => <li key={j}>{detalhe}</li>)}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ol>
        <p id="dossie-linha-vazio" hidden={!linha || linha.eventos.length > 0}>{TEXTO.semEventos}</p>
        <p id="dossie-linha-limite" hidden={!linha?.limite}>{linha?.limite}</p>
      </section>
      <div className="pt-3 border-t border-line-quiet flex items-center justify-end gap-3 shrink-0">
        {/* data-on-click como antes: o despachante de ações (frontend/src/ui/action-dispatcher.ts) chama window.fecharDossieEquipamento (a ponte) */}
        <button type="button" id="dossie-imprimir" className="ck-btn ck-btn--secundario" onClick={() => window.print()}>Imprimir</button>
        <button type="button" id="dossie-fechar" data-on-click="fecharDossieEquipamento" className="ck-btn ck-btn--secundario">Fechar</button>
      </div>
    </>
  );
}
