import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { IconeLucide } from "../../componentes/icone-lucide";
import { TEXTO, type Opcao } from "./pesquisa-completa-puro";
import { assinar, desenharIcones, escolher, iniciarEsqueleto, ler } from "./estado";

// Conteúdo de .ck-dialogo do #modal-pesquisa-completa (frontend/partials/modais.html). Mesmos IDs, classes e ARIA do
// diálogo antigo. Botões e selects mantêm só data-on-click e data-on-change: o despachante do código antigo chama as
// ações pela ponte (window.limparFiltrosPesquisaCompleta etc.), como no dossiê.
function Filtro({ id, rotulo, todos, opcoes, valor, desabilitado, aoEscolher }: {
  id: string;
  rotulo: string;
  todos: string;
  opcoes: Opcao[];
  valor: string;
  desabilitado: boolean;
  aoEscolher(valor: string): void;
}) {
  return (
    <label htmlFor={id} className="text-xs text-fg-tertiary">
      {rotulo}
      <select id={id} data-on-change="alterarFiltrosPesquisaCompleta" value={valor} disabled={desabilitado}
        onChange={evento => aoEscolher(evento.currentTarget.value)}
        className="mt-1 w-full rounded-lg glass-input bg-surface px-3 py-2 text-sm text-white focus:outline-none">
        <option value="">{todos}</option>
        {opcoes.map((opcao, indice) => <option key={`${indice}-${opcao.valor}`} value={opcao.valor}>{opcao.rotulo}</option>)}
      </select>
    </label>
  );
}

export function Dialogo() {
  const { termo, contagem, status, categorias, cidades, usuarios, categoria, cidade, usuario, carregando, maisVisivel,
    limparVisivel, lista, busca } = useSyncExternalStore(assinar, ler);
  const listaRef = useRef<HTMLDivElement>(null);

  // shortcut: linhas vêm do renderer antigo (equipment-search-renderers.ts), migram com equipment-search no Bloco final
  // O React não desenha filhos em #pesquisa-completa-lista: só esvazia e acrescenta as linhas que a ação trouxe.
  useLayoutEffect(() => {
    const elemento = listaRef.current;
    if (!elemento) return;
    if (lista.reiniciar) {
      elemento.replaceChildren();
      elemento.scrollTop = 0;
    }
    if (lista.novas.length > 0) {
      elemento.append(...lista.novas);
      desenharIcones(elemento);
    }
  }, [lista]);

  // Declarado depois do efeito acima: quando o carregamento termina junto com a chegada das linhas, o esqueleto sai
  // (limpeza) antes de as linhas entrarem, como no código antigo.
  useLayoutEffect(() => {
    const elemento = listaRef.current;
    if (!elemento || !carregando) return;
    return iniciarEsqueleto(elemento);
  }, [carregando, busca]);

  return (
    <>
      <div className="flex items-start justify-between gap-4 pb-4 border-b border-line-quiet shrink-0">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <IconeLucide nome="search" className="w-5 h-5 text-cyan-400" />
            Resultados da pesquisa
          </h3>
          <p className="text-xs text-fg-subtle mt-1">Termo: <span id="pesquisa-completa-termo" className="font-mono text-cyan-300 break-all">{termo}</span></p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span id="pesquisa-completa-contagem" className="px-2.5 py-1 rounded-full bg-cyan-500/15 text-cyan-200 border border-cyan-500/25 text-xs font-semibold" role="status" aria-live="polite">{contagem}</span>
          <button type="button" id="btn-fechar-pesquisa-completa" data-on-click="fecharModalPesquisaCompleta" className="ck-btn ck-btn--fantasma ck-btn--icone ck-btn--sm" aria-label="Fechar resultados da pesquisa">
            <IconeLucide nome="x" className="w-5 h-5" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 py-3 border-b border-line-quiet shrink-0">
        <Filtro id="filtro-pesquisa-categoria" rotulo="Categoria" todos={TEXTO.todasCategorias} opcoes={categorias}
          valor={categoria} desabilitado={carregando} aoEscolher={valor => escolher("categoria", valor)} />
        <Filtro id="filtro-pesquisa-cidade" rotulo="Cidade" todos={TEXTO.todasCidades} opcoes={cidades}
          valor={cidade} desabilitado={carregando} aoEscolher={valor => escolher("cidade", valor)} />
        <Filtro id="filtro-pesquisa-usuario" rotulo="Usuário" todos={TEXTO.todosUsuarios} opcoes={usuarios}
          valor={usuario} desabilitado={carregando} aoEscolher={valor => escolher("usuario", valor)} />
        <button type="button" id="btn-limpar-filtros-pesquisa" data-on-click="limparFiltrosPesquisaCompleta"
          className={`${limparVisivel ? "" : "hidden "}full-search-clear justify-self-end text-xs text-cyan-300 hover:text-white transition`}>
          Limpar filtros
        </button>
      </div>
      <p id="pesquisa-completa-status" className="text-xs text-fg-subtle py-3 shrink-0" role="status" aria-live="polite">{status}</p>
      <div id="pesquisa-completa-lista" ref={listaRef} className="overflow-y-auto flex-1 min-h-0 py-2 space-y-2" aria-label="Resultados completos da pesquisa"></div>
      <div className="pt-3 border-t border-line-quiet flex items-center justify-between gap-3 shrink-0">
        <button type="button" id="btn-carregar-mais-pesquisa" data-on-click="carregarMaisResultadosPesquisa"
          disabled={carregando} aria-busy={carregando ? "true" : undefined}
          className={`${maisVisivel ? "" : "hidden "}disabled:opacity-50 disabled:cursor-wait ck-btn ck-btn--primario`}>
          <IconeLucide nome="plus" className="w-4 h-4" />
          <span>Carregar mais</span>
        </button>
        <button type="button" data-on-click="fecharModalPesquisaCompleta" className="ml-auto ck-btn ck-btn--secundario">Fechar</button>
      </div>
    </>
  );
}
