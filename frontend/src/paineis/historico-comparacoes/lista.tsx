import { Fragment, useLayoutEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  assinar, chaveAcao, consultarDoCartao, excluirHistoricoComparacao, formatadores, ler, restaurarHistoricoComparacao,
  type Acao, type Estado,
} from "./estado";
import {
  agruparPorDia, arquivosDoEvento, CLASSE_BOTAO_HISTORICO, metricasDoEvento, metricasVisiveis, rotuloAcaoRestaurar,
  seloDoEvento, type EventoHistorico, type Metrica,
} from "./historico-puro";

// Mesmo esqueleto de SimpressMotion.startLoading (frontend/src/legado/ui/ui-motion.js), que só aparece após 150 ms.
function Esqueleto() {
  return (
    <div className="ui-skeleton-list">
      <span className="ui-sr-only" role="status">Carregando histórico…</span>
      {[0, 1, 2].map(linha => (
        <div key={linha} className="ui-skeleton-row" aria-hidden="true">
          <span className="ui-skeleton ui-skeleton--title" />
          <span className="ui-skeleton ui-skeleton--text" />
          <span className="ui-skeleton ui-skeleton--short" />
        </div>
      ))}
    </div>
  );
}

function Metricas({ metricas }: { metricas: Metrica[] }) {
  const visiveis = metricasVisiveis(metricas);
  if (!visiveis.length) return <p className="text-xs text-fg-subtle">Nenhuma alteração ou pendência.</p>;
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {visiveis.map(({ rotulo, valor, tom }) => {
        const numero = Number(valor || 0);
        const classes = formatadores().classesMetricaHistorico(numero, tom);
        return (
          <div key={rotulo} className={`flex flex-col-reverse rounded-lg px-3 py-2 ${classes.cartao}`}>
            <dt className="text-xs leading-tight text-fg-subtle">{rotulo}</dt>
            <dd className={`text-base font-semibold ${classes.numero}`}>{numero.toLocaleString("pt-BR")}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Arquivos({ evento }: { evento: EventoHistorico }) {
  const { rotulo, arquivos } = arquivosDoEvento(evento);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" aria-label={rotulo}>
      {([["Endpoint", arquivos.endpoint], ["Simpress", arquivos.detalhes]] as const).map(([fonte, arquivo]) => {
        const nome = formatadores().formatarNomeFonteHistorico(arquivo || "—");
        return (
          <Fragment key={fonte}>
            <dt className="text-fg-muted">{fonte}</dt>
            <dd className="min-w-0 truncate text-fg-tertiary" title={nome}>{nome}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

function Resumo({ evento }: { evento: EventoHistorico }) {
  if (evento.somente_anotacoes_sincronizadas) {
    return <p className="text-xs text-fg-subtle">As anotações podem ser consultadas e editadas neste notebook.</p>;
  }
  if (evento.tipo === "restauracao") {
    return (
      <>
        <p className="text-xs text-fg-subtle">
          Restauração do conjunto anterior a {formatadores().formatarHorarioHistorico(evento.restauracao_de?.horario)}
        </p>
        <Metricas metricas={metricasDoEvento(evento)} />
      </>
    );
  }
  return <Metricas metricas={metricasDoEvento(evento)} />;
}

function Cartao({ evento, ocupados }: { evento: EventoHistorico; ocupados: Estado["ocupados"] }) {
  const f = formatadores();
  const restauracao = evento.tipo === "restauracao";
  const selo = seloDoEvento(evento);
  const horario = f.formatarHorarioHistorico(evento.horario);
  // Texto do botão enquanto a ação roda; fora dela, `padrao`. Um botão ocupado fica desabilitado e com aria-busy.
  const estadoBotao = (acao: Acao, padrao: string) => {
    const ocupado = ocupados[chaveAcao(evento.id, acao)];
    return { texto: ocupado ?? padrao, disabled: !!ocupado, "aria-busy": ocupado ? ("true" as const) : undefined };
  };
  const consultar = estadoBotao("consultar", evento.somente_anotacoes_sincronizadas ? "Consultar anotações" : "Consultar resultado");
  const restaurar = estadoBotao("restaurar", restauracao ? "Desfazer restauração" : "Restaurar versão anterior");
  const excluir = estadoBotao("excluir", "Excluir");
  return (
    <article className="rounded-xl border border-line-quiet bg-surface/70 p-4 space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-white">{horario}</p>
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${selo.cores}`}>{selo.tipo}</span>
      </header>
      <Arquivos evento={evento} />
      <Resumo evento={evento} />
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:justify-end gap-2 border-t border-line-quiet/80 pt-3">
        {!restauracao && (
          <button type="button" className={`${CLASSE_BOTAO_HISTORICO} btn-secondary-accent`} disabled={consultar.disabled}
            aria-busy={consultar["aria-busy"]} onClick={() => { void consultarDoCartao(evento.id); }}>
            {consultar.texto}
          </button>
        )}
        {evento.restauravel && (
          <button type="button" className={`${CLASSE_BOTAO_HISTORICO} btn-secondary`} disabled={restaurar.disabled}
            aria-busy={restaurar["aria-busy"]} aria-label={rotuloAcaoRestaurar(evento, f)}
            onClick={() => { void restaurarHistoricoComparacao(evento); }}>
            {restaurar.texto}
          </button>
        )}
        {!evento.somente_anotacoes_sincronizadas && (
          <button type="button" className={`${CLASSE_BOTAO_HISTORICO} btn-danger-ghost`} disabled={excluir.disabled}
            aria-busy={excluir["aria-busy"]} aria-label={`Excluir atualização de ${horario}`}
            onClick={() => { void excluirHistoricoComparacao(evento); }}>
            {excluir.texto}
          </button>
        )}
      </div>
    </article>
  );
}

// Desenha dentro do #lista-historico-comparacoes do partial (alvo), que fica fora da raiz React: os filhos viram filhos
// diretos dele, como no HTML antigo. aria-busy e a animação de entrada são do alvo, então vão por efeito.
export function ListaHistorico({ alvo }: { alvo: HTMLElement }) {
  const { fase, erro, eventos, esqueleto, ocupados } = useSyncExternalStore(assinar, ler);
  useLayoutEffect(() => {
    if (fase === "carregando") alvo.setAttribute("aria-busy", "true");
    else alvo.removeAttribute("aria-busy");
  }, [alvo, fase]);
  useLayoutEffect(() => {
    if (fase === "pronto" && eventos.length) window.SimpressMotion?.stagger(alvo.children);
  }, [alvo, fase, eventos]);

  let conteudo = null;
  if (fase === "carregando") {
    conteudo = (
      <>
        <p className="text-sm text-fg-subtle text-center py-8" role="status" aria-live="polite">Carregando histórico...</p>
        {esqueleto && <Esqueleto />}
      </>
    );
  } else if (fase === "erro") {
    conteudo = <p className="text-sm text-rose-300 text-center py-8" role="alert" aria-live="assertive">{erro}</p>;
  } else if (fase === "pronto" && !eventos.length) {
    conteudo = <p className="text-sm text-fg-subtle text-center py-8" role="status" aria-live="polite">Nenhum histórico ainda.</p>;
  } else if (fase === "pronto") {
    conteudo = agruparPorDia(eventos).map(grupo => (
      <section key={grupo.chave} className="space-y-2" aria-label={`Atualizações de ${grupo.rotulo}`}>
        <h4 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          {grupo.rotulo}
          <span className="font-normal normal-case tracking-normal text-fg-muted">{grupo.quantidade}</span>
        </h4>
        {grupo.eventos.map(evento => <Cartao key={evento.id} evento={evento} ocupados={ocupados} />)}
      </section>
    ));
  }
  return createPortal(conteudo, alvo);
}
