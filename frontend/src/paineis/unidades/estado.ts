// Estado do painel Catálogo de unidades (store externo, lido pelo corpo com useSyncExternalStore).
// A lista do painel é independente de appState.unidadesList (aquela é a do Transporte, gravada por carregarUnidades).

export interface Unidade {
  id?: number | null;
  label?: string;
  cidade?: string;
  uf?: string;
  endereco?: string;
  cep?: string;
  cnpj?: string;
  is_sede?: boolean;
}

export interface Formulario {
  aberto: boolean;
  titulo: string;
  id: string;
  cidade: string;
  cep: string;
  cnpj: string;
  endereco: string;
  /** Muda quando os campos devem voltar aos valores acima (os inputs não são controlados). */
  revisao: number;
}

export interface Estado {
  /** "inicial": antes da primeira carga (como o HTML antigo, sem linhas nem KPIs). */
  fase: "inicial" | "carregando" | "ok" | "erro";
  erro: string;
  lista: Unidade[];
  busca: string;
  selecionada: string;
  form: Formulario;
}

let estado: Estado = {
  fase: "inicial",
  erro: "",
  lista: [],
  busca: "",
  selecionada: "",
  form: { aberto: false, titulo: "Cadastrar Nova Unidade / Filial", id: "", cidade: "", cep: "", cnpj: "", endereco: "", revisao: 0 },
};
const ouvintes = new Set<() => void>();

export function ler(): Estado {
  return estado;
}

export function assinar(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

export function mudar(parcial: Partial<Estado>): void {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}

export function mudarForm(parcial: Partial<Formulario>): void {
  mudar({ form: { ...estado.form, ...parcial } });
}

export function normalizar(valor: unknown): string {
  return String(valor ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").trim();
}

export function nomeUnidade(unidade: Unidade | undefined): string {
  return unidade?.label || unidade?.cidade || "Unidade sem nome";
}

/** Unidades que passam na busca, com a chave de seleção: o id ou, sem id, a posição na lista. */
export function filtrarUnidades(lista: Unidade[], busca: string): { unidade: Unidade; chave: string }[] {
  const termos = normalizar(busca).split(/\s+/).filter(Boolean);
  return lista.map((unidade, indice) => ({ unidade, chave: String(unidade?.id ?? indice) })).filter(({ unidade }) => {
    const texto = normalizar([nomeUnidade(unidade), unidade.cidade, unidade.cnpj, unidade.endereco].join(" "));
    return termos.every(termo => texto.includes(termo));
  });
}

/** Seleção válida entre as visíveis; sem ela, a primeira da busca (como o renderUnits antigo). */
export function chaveSelecionada(visiveis: { chave: string }[], selecionada: string): string {
  return visiveis.some(({ chave }) => chave === selecionada) ? selecionada : visiveis[0]?.chave || "";
}
