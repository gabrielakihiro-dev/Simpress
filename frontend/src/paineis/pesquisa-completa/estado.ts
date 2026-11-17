// Estado da pesquisa completa (Home F1, "Ver todos os resultados"), fora do componente: a aplicação chama as ações
// pela ponte (frontend/src/aplicacao/full-equipment-search.ts). Só leitura: GET /api/buscar-expandida.
import { flushSync } from "react-dom";
import { apiFetch } from "../../api";
import {
  TEXTO, decidirFiltros, filtrosAtivos, lerPagina, lerTermo, montarParametros, opcoesCategoria, opcoesCidade, opcoesUsuario,
  termoExibido, termoValido, textoContagem, textoStatus, usuarioAoLimpar,
  type Busca, type Opcao,
} from "./pesquisa-completa-puro";

const MODAL = "modal-pesquisa-completa";

// shortcut: linhas vêm do renderer antigo (equipment-search-renderers.ts), migram com equipment-search no Bloco final
export type CriarLinha = (item: unknown, indice: number, termo: string, aoSelecionar: () => void) => HTMLElement;

// Funções da aplicação publicadas em window (frontend/src/aplicacao/app.ts, publish) e globais carregados antes do bundle.
interface AppAntigo {
  abrirModalAcessivel(modalId: string, focoInicial: string, acaoFechar: string): void;
  fecharModalAcessivel(modalId: string): void;
  showToast(mensagem: string, tipo: string): void;
  fecharAutocomplete(): void;
  selecionarItemAutocomplete(item: unknown): void;
  lucide?: { createIcons(opcoes: { root: HTMLElement }): void };
  SimpressMotion?: { startLoading(container: HTMLElement, rotulo: string): () => void };
}
const app = window as unknown as AppAntigo;

// As linhas da lista são elementos do renderer antigo: o React não as desenha, só as acrescenta por ref (ver dialogo.tsx).
// `reiniciar` esvazia a lista antes de acrescentar; `versao` muda a cada pedido de mudança da lista.
export interface Lista {
  versao: number;
  reiniciar: boolean;
  novas: HTMLElement[];
}

export interface Estado {
  termo: string;
  contagem: string;
  status: string;
  categorias: Opcao[];
  cidades: Opcao[];
  usuarios: Opcao[];
  // Valores dos três selects (o que a pessoa escolheu); o filtro aplicado à busca fica em `busca`.
  categoria: string;
  cidade: string;
  usuario: string;
  carregando: boolean; // desliga os filtros e o "Carregar mais"
  maisVisivel: boolean;
  limparVisivel: boolean;
  lista: Lista;
  busca: number; // muda a cada busca nova: reinicia o esqueleto de carregamento
}

let versaoLista = 0;
const novaLista = (reiniciar: boolean, novas: HTMLElement[] = []): Lista => ({ versao: ++versaoLista, reiniciar, novas });

// Mesmo conteúdo inicial do diálogo antigo (frontend/partials/modais.html).
let estado: Estado = {
  termo: "",
  contagem: TEXTO.zeroResultados,
  status: TEXTO.carregando,
  categorias: opcoesCategoria(undefined, "").opcoes,
  cidades: [],
  usuarios: opcoesUsuario(undefined),
  categoria: "",
  cidade: "",
  usuario: "",
  carregando: false,
  maisVisivel: false,
  limparVisivel: false,
  lista: novaLista(false),
  busca: 0,
};
const ouvintes = new Set<() => void>();
function mudar(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

// Escolha num select: só guarda o valor. Quem pesquisa é a ação alterarFiltrosPesquisaCompleta (data-on-change).
export function escolher(filtro: "categoria" | "cidade" | "usuario", valor: string) {
  const parcial: Partial<Estado> = {};
  parcial[filtro] = valor;
  mudar(parcial);
}

// Filtros aplicados à busca em andamento; os selects só os alcançam por alterarFiltrosPesquisaCompleta.
let busca: Busca = { query: "", categoria: "", cidade: "", usuario: "" };
let deslocamento = 0;
let emCurso = false;
let idPedido = 0; // respostas de pedidos antigos são descartadas
let criarLinha: CriarLinha | null = null;

export function abrirPesquisaCompleta(criar: CriarLinha) {
  const campo = document.getElementById("input-serial") as HTMLInputElement | null;
  const query = lerTermo(campo?.value);
  if (!termoValido(query)) {
    app.showToast(TEXTO.digiteMinimo, "warning");
    return;
  }
  criarLinha = criar;
  iniciar(query, "");
}

function iniciar(query: string, usuario: string) {
  idPedido += 1;
  busca = { query, categoria: "", cidade: "", usuario };
  deslocamento = 0;
  emCurso = false;
  // O diálogo abre já com o termo, "Buscando..." e a lista vazia desenhados: o foco inicial depende do DOM pronto.
  flushSync(() => mudar({
    termo: termoExibido(query),
    contagem: TEXTO.buscando,
    status: TEXTO.carregando,
    categoria: "",
    cidade: "",
    usuario,
    maisVisivel: false,
    limparVisivel: false,
    lista: novaLista(true),
    busca: estado.busca + 1,
  }));
  app.abrirModalAcessivel(MODAL, "#btn-fechar-pesquisa-completa", "fecharModalPesquisaCompleta");
  app.fecharAutocomplete();
  void carregar(false, idPedido);
}

export function alterarFiltrosPesquisaCompleta() {
  if (emCurso) return;
  const escolha = { categoria: estado.categoria, cidade: estado.cidade, usuario: estado.usuario };
  const decisao = decidirFiltros(busca, escolha);
  if (decisao === "ignorar") return;
  // Sem termo a listagem existe só para "Sem usuário": qualquer outra escolha volta atrás.
  if (decisao === "reverter") {
    mudar({ usuario: busca.usuario });
    app.showToast(TEXTO.digiteTermoUsuario, "warning");
    return;
  }
  busca = { ...busca, ...escolha };
  deslocamento = 0;
  idPedido += 1;
  mudar({
    contagem: TEXTO.buscando,
    maisVisivel: false,
    limparVisivel: filtrosAtivos(busca),
    lista: novaLista(true),
    busca: estado.busca + 1,
  });
  void carregar(false, idPedido);
}

export function limparFiltrosPesquisaCompleta() {
  mudar({ categoria: "", cidade: "", usuario: usuarioAoLimpar(busca.query) });
  alterarFiltrosPesquisaCompleta();
}

async function carregar(carregarMais: boolean, idDestePedido: number = idPedido) {
  if (emCurso || idDestePedido !== idPedido || !criarLinha) return;
  const criar = criarLinha;
  const consulta = busca;
  const inicio = carregarMais ? deslocamento : 0;
  emCurso = true;
  mudar({ carregando: true, status: carregarMais ? TEXTO.carregandoMais : TEXTO.carregando });
  try {
    const dados = await apiFetch<unknown>(`/api/buscar-expandida?${montarParametros(consulta, inicio)}`, { errorMessage: TEXTO.erroApi });
    if (idDestePedido !== idPedido) return;
    const pagina = lerPagina(dados);
    const categoria = opcoesCategoria(pagina.filtros.categories, busca.categoria);
    const cidade = opcoesCidade(pagina.filtros.cities, busca.cidade);
    busca = { ...busca, categoria: categoria.valor, cidade: cidade.valor };
    const novas = pagina.itens.map((item, indice) => criar(item, inicio + indice, busca.query, () => {
      fecharModalPesquisaCompleta();
      app.selecionarItemAutocomplete(item);
    }));
    deslocamento = inicio + pagina.itens.length;
    emCurso = false;
    // Uma atualização só: o esqueleto de carregamento sai antes de as linhas entrarem (efeitos em dialogo.tsx).
    flushSync(() => mudar({
      categorias: categoria.opcoes,
      cidades: cidade.opcoes,
      usuarios: opcoesUsuario(pagina.filtros.users),
      categoria: categoria.valor,
      cidade: cidade.valor,
      usuario: busca.usuario,
      contagem: textoContagem(pagina.total),
      status: textoStatus(pagina.total, deslocamento, pagina.temMais, busca.query),
      maisVisivel: pagina.temMais,
      limparVisivel: filtrosAtivos(busca),
      lista: novaLista(false, novas),
      carregando: false,
    }));
  } catch (erro) {
    if (idDestePedido === idPedido) {
      mudar({ status: TEXTO.erroStatus });
      app.showToast((erro instanceof Error && erro.message) || TEXTO.erroToast, "error");
    }
  } finally {
    if (idDestePedido === idPedido && emCurso) {
      emCurso = false;
      mudar({ carregando: false });
    }
  }
}

export function carregarMaisResultadosPesquisa() {
  return carregar(true);
}

export function fecharModalPesquisaCompleta() {
  app.fecharModalAcessivel(MODAL);
}

// Chamados pelo componente depois de acrescentar linhas e quando a busca começa a carregar.
export function desenharIcones(lista: HTMLElement) {
  app.lucide?.createIcons({ root: lista });
}
export function iniciarEsqueleto(lista: HTMLElement): () => void {
  return app.SimpressMotion?.startLoading(lista, TEXTO.rotuloCarregando) ?? (() => {});
}
