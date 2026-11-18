// Cartão "Ativos por regional" do Resumo (F3, Visão geral). Mesmos IDs, ARIA, classes e textos do
// cartão antigo em JS puro (antigo frontend/src/legado/features/resumo-ativos.js até o Bloco 3); o visual vem do bento.
import { useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import {
  TEXTO_CARREGANDO, VISIVEIS, alternarExpandido, assinar, categorias, escolherFiltro, ler, opcoes, regionais,
} from "./estado";

const formatar = (valor: number) => valor.toLocaleString("pt-BR");

// O número conta até o total pelo bento (SimpressBento.contarAte); com movimento reduzido, aparece pronto.
// O React não desenha filhos neste span: quem escreve o texto é a contagem. Cada linha nasce de novo a cada
// redesenho (key com a geração), então a contagem roda uma vez por linha.
function Valor({ total }: { total: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = formatar(total);
    window.SimpressBento?.contarAte(el, total);
  }, [total]);
  return <span ref={ref} className="ck-barra__valor" />;
}

// Mesmo esqueleto de SimpressMotion.startLoading (frontend/src/ui/ui-motion.ts), que só aparece após 150 ms.
function Esqueleto() {
  return (
    <div className="ui-skeleton-list">
      <span className="ui-sr-only" role="status">{TEXTO_CARREGANDO}</span>
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

export function CartaoRegionais() {
  const { resultado, carregando, esqueleto, filtro, expandido, geracao } = useSyncExternalStore(assinar, ler);
  const painel = resultado?.tipo === "pronto" ? resultado.painel : null;
  const cidades = painel ? regionais(painel, filtro) : [];
  const mostradas = expandido ? cidades : cidades.slice(0, VISIVEIS);
  const maior = Math.max(...mostradas.map(cidade => cidade.total), 1);
  const soma = cidades.reduce((total, cidade) => total + cidade.total, 0);
  const meta = cidades.length
    ? `${formatar(soma)} ${soma === 1 ? "ativo" : "ativos"} em ${formatar(cidades.length)} ${cidades.length === 1 ? "regional" : "regionais"}`
    : "";
  const categoria = painel ? categorias(painel).find(opcao => opcao.value === filtro) : undefined;
  const vazio = categoria
    ? `Nenhum ativo de ${categoria.label} na base local.`
    : "A distribuição por cidade não está disponível.";
  const estadoBarras = carregando ? "carregando" : resultado ? (painel ? "pronto" : "erro") : undefined;
  const linhas = mostradas.length ? ({ "--linhas": String(Math.ceil(mostradas.length / 2)) } as CSSProperties) : undefined;

  return (
    <div className="ck-cartao ck-regionais">
      <div className="ck-cartao__cab">
        <span className="ck-bento-icone" aria-hidden="true">
          <svg className="ck-bento-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2"></path>
          </svg>
        </span>
        <h3 id="resumo-regionais-titulo" className="ck-cartao__titulo">Ativos por regional</h3>
        <span className="ck-espaco"></span>
        <span id="resumo-regionais-contagem" className="ck-cartao__meta" role="status" aria-live="polite">{meta}</span>
      </div>
      <div id="resumo-regionais-filtros" className="ck-pilulas ck-regionais__filtros" role="group" aria-label="Filtrar ativos por categoria">
        {painel && opcoes(painel).map(opcao => (
          <button
            key={opcao.value}
            type="button"
            className="ck-pilula"
            data-categoria={opcao.value}
            aria-pressed={opcao.value === filtro ? "true" : "false"}
            disabled={opcao.value !== "todos" && opcao.total === 0}
            onClick={evento => { escolherFiltro(opcao.value); evento.currentTarget.focus(); }}
          >
            {opcao.label}{" "}<span className="ck-pilula__n">{formatar(opcao.total)}</span>
          </button>
        ))}
      </div>
      <div id="resumo-regionais" className="ck-barras" aria-busy={carregando || !resultado ? "true" : "false"} data-estado={estadoBarras} style={linhas}>
        {painel && !cidades.length && vazio}
        {resultado && !painel && "A distribuição por regional está indisponível enquanto o servidor local não responde."}
        {mostradas.map((cidade, indice) => (
          <div key={`${geracao}-${indice}`} className="ck-barra">
            <span className="ck-barra__nome" title={cidade.name}>{cidade.name}</span>
            <span className="ck-barra__trilho" aria-hidden="true">
              <span className="ck-barra__cheio" style={{ width: `${Math.max(2, (cidade.total / maior) * 100)}%` }} />
            </span>
            <Valor total={cidade.total} />
          </div>
        ))}
        {esqueleto && <Esqueleto />}
      </div>
      <div className="ck-regionais__rodape">
        <button
          type="button"
          id="resumo-regionais-mais"
          className="ck-btn ck-btn--fantasma ck-btn--sm"
          aria-expanded={expandido ? "true" : "false"}
          hidden={!painel || cidades.length <= VISIVEIS}
          onClick={alternarExpandido}
        >
          {cidades.length ? (expandido ? "Ver menos" : `Ver todas as ${formatar(cidades.length)} regionais`) : ""}
        </button>
      </div>
    </div>
  );
}
