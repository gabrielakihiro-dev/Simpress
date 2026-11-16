// Regras puras do painel Chamados (importação, versões, comparação, exportação e chamados abertos da Home).
// Sem DOM, sem fetch e sem import, só com sintaxe apagável, para os testes de tests/frontend carregarem este
// arquivo com require() direto do Node, sem build. As três regras de ticket-rules.js entram por parâmetro
// (RegrasChamados): a fonte única delas continua no código antigo.

export interface RegrasChamados {
  normalizarFiltroChamados(valor: unknown): string;
  idadeAtualizacaoChamado(ticket: ChamadoOracle): { rotulo: string; encerrado: boolean };
  compararOrdensServicoDecrescente(esquerda: unknown, direita: unknown): number;
}

export interface ChamadoOracle {
  ordem_servico?: string | number;
  status?: string;
  sub_status?: string;
  fila?: string;
  nome_filial?: string;
  cidade?: string;
  ultima_atualizacao?: string;
}

export interface RegistroChamados {
  serie?: string;
  oracle?: ChamadoOracle[];
}

export interface EventoImportacao {
  id?: string;
  atualizado_em?: string;
  fontes?: { simpress?: string | { arquivo?: string }; oracle?: string | { arquivo?: string } };
}

export interface RelatorioChamados {
  snapshot_id?: string;
  atualizado_em?: string;
  historico?: EventoImportacao[];
  fontes?: { simpress?: { arquivo?: string }; oracle?: { arquivo?: string } };
  chamados?: RegistroChamados[];
}

export interface ChamadoSebrae {
  chave: string;
  numero: string;
  titulo?: string;
  serie?: string;
  chamado?: string;
}

interface ItemSebraeAberto {
  numero: string;
  titulo?: string;
  chamado?: string;
  automaticos?: { K?: string };
  automaticos_sugeridos?: { K?: string };
}

interface ItemSebraeNovo {
  numero: string;
  linha?: { G?: string; K?: string };
}

export interface DadosSebraeNovos {
  importado?: { finalizados?: { numero: string }[]; abertos?: ItemSebraeAberto[] };
  novos?: { formulario?: ItemSebraeNovo[] };
}

export interface DadosEvolucao {
  contagens?: { novos?: number; alterados?: number; iguais?: number; ausentes_arquivo?: number };
  mudancas?: {
    novos?: string[];
    alterados?: { serie: string; campos?: { campo: string }[] }[];
    ausentes_arquivo?: string[];
  };
  aviso_ausentes?: string;
}

export interface EvolucaoMontada {
  resumo: string;
  aviso: string;
  linhas: [string, string][];
}

type FormatarHorario = (valor?: string) => string;

/** Rótulo de uma importação no seletor de versões: horário e os nomes dos dois arquivos. */
export function rotuloImportacao(evento: EventoImportacao, formatarHorario: FormatarHorario): string {
  const fontes = evento.fontes || {};
  const nomeSimpress = typeof fontes.simpress === "string" ? fontes.simpress : fontes.simpress?.arquivo;
  const nomeOracle = typeof fontes.oracle === "string" ? fontes.oracle : fontes.oracle?.arquivo;
  const arquivos = [nomeSimpress, nomeOracle].filter(Boolean).join(" + ");
  return `${formatarHorario(evento.atualizado_em)}${arquivos ? ` · ${arquivos}` : ""}`;
}

/** Versão em uso depois de uma nova carga: mantém a escolhida se ainda existe; senão a da tabela, senão a mais recente. */
export function versaoAposCarga(historico: EventoImportacao[], escolhida: string, snapshotId?: string): string {
  if (historico.some(evento => evento.id === escolhida)) return escolhida;
  return snapshotId || historico[0]?.id || "";
}

/** Chave que decide se a comparação precisa ser recarregada. */
export function chaveEvolucao(historico: EventoImportacao[], versao: string): string {
  return `${versao}|${historico[0]?.id || ""}|${historico.length}`;
}

/** Texto do bloco de comparação quando não há versão anterior para comparar; null = há, vá à API. */
export function textoSemComparacao(historico: EventoImportacao[], versao: string): string | null {
  if (!versao) return "Nenhuma importação selecionada.";
  const indice = historico.findIndex(evento => evento.id === versao);
  const anterior = indice >= 0 ? historico[indice + 1] : null;
  if (anterior) return null;
  return historico.length > 1
    ? "Esta é a importação mais antiga disponível. Selecione uma versão mais recente para comparar."
    : "A primeira importação ficará registrada aqui para comparação com as próximas planilhas.";
}

export function idAnterior(historico: EventoImportacao[], versao: string): string {
  const indice = historico.findIndex(evento => evento.id === versao);
  return (indice >= 0 ? historico[indice + 1]?.id : "") || "";
}

export function montarEvolucao(dados: DadosEvolucao): EvolucaoMontada {
  const contagens = dados.contagens || {};
  const mudancas = dados.mudancas || {};
  const alterados = Array.isArray(mudancas.alterados) ? mudancas.alterados : [];
  const novos = Array.isArray(mudancas.novos) ? mudancas.novos : [];
  const ausentes = Array.isArray(mudancas.ausentes_arquivo) ? mudancas.ausentes_arquivo : [];
  const linhas: [string, string][] = [
    ...novos.slice(0, 5).map((serie): [string, string] => ["Nova série:", serie]),
    ...alterados.slice(0, 8).map((linha): [string, string] => [`${linha.serie}:`, (linha.campos || []).map(campo => campo.campo).join(", ")]),
    ...ausentes.slice(0, 5).map((serie): [string, string] => ["Não consta na planilha atual:", serie]),
  ];
  return {
    resumo: `Comparação com a versão anterior · ${Number(contagens.novos) || 0} novas · ${Number(contagens.alterados) || 0} alteradas · ${Number(contagens.iguais) || 0} sem mudança · ${Number(contagens.ausentes_arquivo) || 0} ausentes`,
    aviso: dados.aviso_ausentes || "Ausência na planilha não confirma resolução.",
    linhas,
  };
}

export function rotuloImportacoesAntigas(quantidade: number): string {
  return quantidade === 1 ? "1 importação antiga" : `${quantidade} importações antigas`;
}

export function rotuloImportacoesRemovidas(quantidade: number): string {
  return quantidade === 1 ? "1 importação antiga removida" : `${quantidade} importações antigas removidas`;
}

export interface PedidoExportacao {
  endpoint: string;
  metodo: "GET" | "POST";
  corpo?: string;
}

/** Séries da tela (todas as páginas) vão por POST; sem lista, ou com outra versão na tela, o GET antigo. */
export function pedidoExportacao(
  versao: string,
  busca: string,
  somenteAtencao: boolean,
  relacao: string,
  series: unknown,
): PedidoExportacao {
  const base = "/api/operacoes/chamados/exportar";
  if (Array.isArray(series)) {
    return {
      endpoint: base,
      metodo: "POST",
      corpo: JSON.stringify({
        snapshot_id: versao, series, search: busca,
        relation: relacao === "todos" ? "" : relacao, attention_only: somenteAtencao,
      }),
    };
  }
  const parametros = new URLSearchParams({ snapshot_id: versao, stale_days: "3" });
  if (busca) parametros.set("search", busca);
  if (somenteAtencao) parametros.set("attention_only", "true");
  return { endpoint: `${base}?${parametros.toString()}`, metodo: "GET" };
}

export function nomeArquivoExportado(disposicao: string): string {
  const achado = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposicao || "");
  return achado?.[1]?.replace(/["']/g, "") || "Acompanhamento_de_Chamados.xlsx";
}

/** Chamados da aba Chamados (F5) ainda não finalizados cuja série (coluna K, já preenchida ou sugerida) é a da Home. */
export function chamadosSebraeDaSerie(dados: DadosSebraeNovos | null | undefined, serie: string, regras: Pick<RegrasChamados, "normalizarFiltroChamados">): ChamadoSebrae[] {
  const alvo = regras.normalizarFiltroChamados(serie);
  const finalizados = new Set((dados?.importado?.finalizados || []).map(item => item.numero));
  const antigos: ChamadoSebrae[] = (dados?.importado?.abertos || []).map(item => ({
    chave: item.numero, numero: item.numero, titulo: item.titulo, serie: item.automaticos?.K || item.automaticos_sugeridos?.K, chamado: item.chamado,
  }));
  const novos: ChamadoSebrae[] = (dados?.novos?.formulario || []).map(item => ({ chave: item.numero, numero: item.numero, titulo: item.linha?.G, serie: item.linha?.K }));
  return [...antigos, ...novos]
    .filter(item => !finalizados.has(item.numero) && item.serie && regras.normalizarFiltroChamados(item.serie) === alvo)
    .map(item => ({ ...item, numero: String(item.numero).startsWith("linha:") ? item.chamado || "Sem UTIC" : item.numero }));
}

export interface AbertosDaSerie {
  abertos: ChamadoOracle[];
  serie: string;
}

/** Chamados Oracle ainda abertos da série, do maior número de OS para o menor. */
export function chamadosAbertosDaSerie(relatorio: RelatorioChamados, serie: string, regras: RegrasChamados): AbertosDaSerie {
  const chamados = Array.isArray(relatorio.chamados) ? relatorio.chamados : [];
  const alvo = regras.normalizarFiltroChamados(serie);
  const registro = chamados.find(item => regras.normalizarFiltroChamados(item.serie) === alvo);
  const abertos = (registro?.oracle || []).filter(ticket => !regras.idadeAtualizacaoChamado(ticket).encerrado)
    .sort((esquerda, direita) => regras.compararOrdensServicoDecrescente(esquerda.ordem_servico, direita.ordem_servico));
  return { abertos, serie: registro?.serie || serie };
}

export function rotuloContagemHome(total: number, falhaSebrae: boolean): string {
  const rotulo = total ? `${total} ${total === 1 ? "aberto" : "abertos"}` : "";
  if (!falhaSebrae) return rotulo;
  return total ? `${rotulo} · consulta parcial` : "Consulta parcial";
}

export function rotuloChamadosSebrae(quantidade: number): string {
  return `${quantidade} ${quantidade === 1 ? "chamado" : "chamados"} na aba Chamados (F5)`;
}

export function textoChamadoSebrae(chamado: ChamadoSebrae): string {
  return [chamado.numero, chamado.titulo].filter(Boolean).join(" · ");
}

export function statusDoChamado(ticket: ChamadoOracle): string {
  return [ticket.status, ticket.sub_status].filter(Boolean).join(" · ") || "Status não informado";
}
