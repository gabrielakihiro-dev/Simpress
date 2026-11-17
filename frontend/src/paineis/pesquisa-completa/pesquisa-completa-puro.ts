// Regras puras da pesquisa completa (Home F1, "Ver todos os resultados"). Sem import e só com sintaxe apagável, para os
// testes de tests/frontend carregarem este arquivo com require() direto do Node, sem build.
// Vieram de frontend/src/aplicacao/full-equipment-search.ts; os textos são os aprovados em docs/cockpit-prompts/03-home-split-view.md.

export const PESQUISA_COMPLETA_PAGINA = 50;
export const MINIMO_CARACTERES = 2;

export const TEXTO = {
  digiteMinimo: "Digite ao menos 2 caracteres para pesquisar.",
  digiteTermoUsuario: "Digite um termo na pesquisa para ver os equipamentos com usuário.",
  buscando: "Buscando...",
  carregando: "Carregando resultados...",
  carregandoMais: "Carregando mais resultados...",
  erroStatus: "Não foi possível carregar a pesquisa. Feche a janela e tente novamente.",
  erroToast: "Falha ao carregar resultados",
  erroApi: "Não foi possível carregar os resultados da pesquisa.",
  paginaInvalida: "Resposta inválida da pesquisa.",
  todosEquipamentos: "Todos os equipamentos",
  zeroResultados: "0 resultados",
  todasCategorias: "Todas as categorias",
  todasCidades: "Todas as cidades",
  todosUsuarios: "Todos os usuários",
  rotuloCarregando: "Carregando resultados da pesquisa…",
};

export interface Opcao {
  valor: string;
  rotulo: string;
}

export interface Busca {
  query: string;
  categoria: string;
  cidade: string;
  usuario: string;
}

export interface Escolha {
  categoria: string;
  cidade: string;
  usuario: string;
}

export interface Pagina {
  itens: unknown[];
  total: number;
  temMais: boolean;
  filtros: Record<string, unknown>;
}

export const CATEGORIAS_PADRAO: readonly Opcao[] = [
  { valor: "notebook", rotulo: "Notebooks" },
  { valor: "macbook", rotulo: "MacBooks" },
  { valor: "monitor", rotulo: "Monitores" },
  { valor: "fone", rotulo: "Fones" },
];

export const USUARIO_FILTROS: readonly Opcao[] = [
  { valor: "sem", rotulo: "Sem usuário" },
  { valor: "com", rotulo: "Com usuário" },
];

type Registro = Record<string, unknown>;
const objeto = (valor: unknown): Registro => (valor && typeof valor === "object" ? (valor as Registro) : {});
const comContagem = (rotulo: string, contagem: unknown) => (typeof contagem === "number" && Number.isFinite(contagem) ? `${rotulo} (${contagem})` : rotulo);

export function pluralizar(total: number, singular: string, plural = `${singular}s`) {
  return Number(total) === 1 ? singular : plural;
}

// Termo digitado na Home: só o texto sem as pontas; abaixo de 2 caracteres a pesquisa não abre.
export const lerTermo = (valor: unknown) => String(valor || "").trim();
export const termoValido = (termo: string) => termo.length >= MINIMO_CARACTERES;
export const termoExibido = (query: string) => query || TEXTO.todosEquipamentos;

// Sem termo, "Sem usuário" é a própria listagem e não um filtro a limpar.
export const filtrosAtivos = (busca: Busca) => Boolean(busca.categoria || busca.cidade || (busca.usuario && busca.query));

// Mesma ordem de chaves do pedido antigo: q, offset, limit, include_filters e depois só os filtros preenchidos.
export function montarParametros(busca: Busca, offset: number): string {
  const parametros = new URLSearchParams({
    q: busca.query,
    offset: String(offset),
    limit: String(PESQUISA_COMPLETA_PAGINA),
    include_filters: "true",
  });
  if (busca.categoria) parametros.set("categoria", busca.categoria);
  if (busca.cidade) parametros.set("cidade", busca.cidade);
  if (busca.usuario) parametros.set("usuario", busca.usuario);
  return parametros.toString();
}

export const textoContagem = (total: number) => (total === 1 ? "1 resultado" : `${total} resultados`);

export function textoStatus(total: number, exibidos: number, temMais: boolean, query: string): string {
  if (total === 0) return query ? "Nenhum equipamento encontrado para esse termo." : "Nenhum equipamento a listar.";
  if (temMais) return `Exibindo ${exibidos} de ${total} ${pluralizar(total, "resultado")}.`;
  return total === 1 ? "O único resultado foi exibido." : `Todos os ${total} resultados foram exibidos.`;
}

// Limpar filtros: a listagem sem termo mantém sempre "Sem usuário".
export const usuarioAoLimpar = (query: string) => (query ? "" : "sem");

export type Decisao = "ignorar" | "reverter" | "aplicar";

// Mudança nos três filtros: igual ao estado atual não faz nada; sem termo só "Sem usuário" vale, o resto volta atrás.
export function decidirFiltros(busca: Busca, escolha: Escolha): Decisao {
  if (escolha.categoria === busca.categoria && escolha.cidade === busca.cidade && escolha.usuario === busca.usuario) return "ignorar";
  if (!busca.query && escolha.usuario !== "sem") return "reverter";
  return "aplicar";
}

export function opcoesCategoria(categorias: unknown, selecionada: string): { opcoes: Opcao[]; valor: string } {
  const itens: Registro[] = Array.isArray(categorias)
    ? categorias.map(objeto)
    : CATEGORIAS_PADRAO.map(({ valor, rotulo }) => ({ value: valor, label: rotulo }));
  const opcoes = itens.map(item => ({ valor: String(item.value), rotulo: comContagem(String(item.label), item.count) }));
  return { opcoes, valor: opcoes.some(({ valor }) => valor === selecionada) ? selecionada : "" };
}

export function opcoesCidade(cidades: unknown, selecionada: string): { opcoes: Opcao[]; valor: string } {
  const valores = Array.isArray(cidades) ? cidades.map(String) : [];
  return { opcoes: valores.map(valor => ({ valor, rotulo: valor })), valor: valores.includes(selecionada) ? selecionada : "" };
}

export function opcoesUsuario(contagens: unknown): Opcao[] {
  const porValor = objeto(contagens);
  return USUARIO_FILTROS.map(({ valor, rotulo }) => ({ valor, rotulo: comContagem(rotulo, porValor[valor]) }));
}

// Resposta de GET /api/buscar-expandida. Sem a lista de itens a resposta não serve: vira erro de pesquisa.
export function lerPagina(dados: unknown): Pagina {
  const pagina = objeto(dados);
  if (!Array.isArray(pagina.items)) throw new Error(TEXTO.paginaInvalida);
  return {
    itens: pagina.items,
    total: Number(pagina.total) || 0,
    temMais: Boolean(pagina.has_more),
    filtros: objeto(pagina.filters),
  };
}
