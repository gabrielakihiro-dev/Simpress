// Estado do painel Chamados (Cockpit, "Importação e versões") e dos chamados abertos da Home, fora do componente:
// o código antigo chama as ações pela ponte (static/js/features/cockpit-chamados.js) e a tabela de OS avisa
// cada carga com sincronizarGestaoChamadosCockpit. Respostas atrasadas são descartadas por um portão de
// requisição por consulta (versões e Home); a regra pura mora em cockpit-chamados-puro.ts.
import { apiFetch, type ApiFetchOptions } from "../../api";
import {
  chamadosAbertosDaSerie, chamadosSebraeDaSerie, chaveEvolucao, idAnterior, montarEvolucao, nomeArquivoExportado,
  pedidoExportacao, rotuloImportacoesAntigas, rotuloImportacoesRemovidas, textoSemComparacao, versaoAposCarga,
  type ChamadoOracle, type ChamadoSebrae, type DadosEvolucao, type DadosSebraeNovos, type EventoImportacao,
  type EvolucaoMontada, type RegrasChamados, type RelatorioChamados,
} from "./cockpit-chamados-puro";

// Helpers do código antigo publicados em window (static/app.js), lidos só na hora do uso.
const app = window as unknown as {
  showToast?: (mensagem: string, tipo: string) => void;
  confirmarAcao?: (opcoes: { titulo: string; mensagem: string; confirmar: string }) => Promise<boolean>;
  carregarProntidao?: () => unknown;
  abrirChamadoDaOs?: (fontes: unknown[], serie: string, os: string | number) => unknown;
  abrirChamadoSebraeNoF5?: (chave: string) => unknown;
  formatarHorarioHistorico: (valor?: string) => string;
  normalizarFiltroChamados: RegrasChamados["normalizarFiltroChamados"];
  idadeAtualizacaoChamado: RegrasChamados["idadeAtualizacaoChamado"];
  compararOrdensServicoDecrescente: RegrasChamados["compararOrdensServicoDecrescente"];
};

const regras = (): RegrasChamados => ({
  normalizarFiltroChamados: valor => app.normalizarFiltroChamados(valor),
  idadeAtualizacaoChamado: ticket => app.idadeAtualizacaoChamado(ticket),
  compararOrdensServicoDecrescente: (esquerda, direita) => app.compararOrdensServicoDecrescente(esquerda, direita),
});

export const formatarHorario = (valor?: string) => app.formatarHorarioHistorico(valor);

export type Evolucao = { tipo: "texto"; texto: string } | { tipo: "dados"; dados: EvolucaoMontada };

/** Chamado Oracle aberto com o rótulo de idade já calculado na hora da consulta (como era no código antigo). */
export interface AbertoHome extends ChamadoOracle { idade: string }

export type Home =
  | { tipo: "inicial" }
  | { tipo: "carregando" }
  | { tipo: "erro"; mensagem: string }
  | { tipo: "lista"; abertos: AbertoHome[]; sebrae: ChamadoSebrae[]; serie: string; falhaSebrae: boolean };

export interface Estado {
  historico: EventoImportacao[];
  /** Versão em uso (Exportar Excel e comparação); a tabela mostra sempre a mais recente. */
  versao: string;
  textoGestao: string;
  fontes: string;
  evolucao: Evolucao;
  statusImportacao: string;
  importando: boolean;
  excluindo: boolean;
  exportando: boolean;
  home: Home;
}

let estado: Estado = {
  historico: [],
  versao: "",
  textoGestao: "Nenhuma importação",
  fontes: "",
  evolucao: { tipo: "texto", texto: "O histórico de importações aparecerá aqui." },
  statusImportacao: "",
  importando: false,
  excluindo: false,
  exportando: false,
  home: { tipo: "inicial" },
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

// Versão que a tabela de OS mostra (ela sempre carrega a mais recente); o Excel só sai igual à tela nessa versão.
let versaoDaTabela = "";
let chaveEvolucaoAtual = "";
// shortcut: atualizado só por importação feita nesta aba ou ao abrir a aba Chamados; importação pela pasta pede recarregar a página.
let chamadosRecentesHome: RelatorioChamados | null = null;

interface Portao {
  begin(): { id: number; signal: AbortSignal };
  isCurrent(id: number): boolean;
}
const portoes: Partial<Record<"evolucao" | "home", Portao>> = {};
// Criado na primeira consulta: o shared/transfer-utils.js já está carregado, mas o módulo nasce antes.
const portao = (nome: "evolucao" | "home"): Portao => (portoes[nome] ??= window.SimpressTransferUtils.createRequestGate());

const mensagemDe = (erro: unknown, padrao: string) => (erro as Error | undefined)?.message || padrao;

async function carregarEvolucao() {
  const pedido = portao("evolucao").begin();
  const { historico, versao } = estado;
  const semComparacao = textoSemComparacao(historico, versao);
  if (semComparacao !== null) {
    mudar({ evolucao: { tipo: "texto", texto: semComparacao } });
    return;
  }
  mudar({ evolucao: { tipo: "texto", texto: "Comparando esta versão com a anterior…" } });
  const erroPadrao = "Não foi possível comparar as versões dos chamados.";
  try {
    const consulta = new URLSearchParams({ anterior: idAnterior(historico, versao), atual: versao });
    const dados = await apiFetch<DadosEvolucao>(`/api/operacoes/chamados/evolucao?${consulta.toString()}`, { signal: pedido.signal, errorMessage: erroPadrao });
    if (portao("evolucao").isCurrent(pedido.id)) mudar({ evolucao: { tipo: "dados", dados: montarEvolucao(dados) } });
  } catch (erro) {
    if (portao("evolucao").isCurrent(pedido.id)) mudar({ evolucao: { tipo: "texto", texto: mensagemDe(erro, erroPadrao) } });
  }
}

function aplicarRelatorio(relatorio: RelatorioChamados | null | undefined, versaoEscolhida: string) {
  const historico = Array.isArray(relatorio?.historico) ? relatorio.historico : [];
  versaoDaTabela = relatorio?.snapshot_id || "";
  const versao = versaoAposCarga(historico, versaoEscolhida, relatorio?.snapshot_id);
  const fontes = relatorio?.fontes || {};
  if (relatorio?.snapshot_id) chamadosRecentesHome = relatorio;
  mudar({
    historico,
    versao,
    textoGestao: relatorio?.atualizado_em ? `Atualizado ${formatarHorario(relatorio.atualizado_em)}` : "Nenhuma importação",
    fontes: `Simpress: ${fontes.simpress?.arquivo || "aguardando importação"} · Oracle: ${fontes.oracle?.arquivo || "aguardando importação"}`,
  });
  const chave = chaveEvolucao(historico, versao);
  if (chave !== chaveEvolucaoAtual) {
    chaveEvolucaoAtual = chave;
    void carregarEvolucao();
  }
}

// Chamado pela tabela de OS a cada carga de /api/operacoes/chamados (e logo após importar): mantém versões, fontes e Home em dia.
export function sincronizarGestaoChamadosCockpit(relatorio?: RelatorioChamados | null) {
  aplicarRelatorio(relatorio, estado.versao);
}

// Sem argumento (ponte do código antigo) lê o valor do seletor no HTML.
export function selecionarVersaoChamadosCockpit(valor?: string) {
  const escolhida = valor ?? (document.getElementById("cockpit-tickets-version") as HTMLSelectElement | null)?.value ?? "";
  chaveEvolucaoAtual = "";
  mudar({ versao: escolhida });
  void carregarEvolucao();
}

// A tabela e os indicadores escutam este evento e recarregam a importação mais recente.
function atualizarTabelaChamados() {
  document.dispatchEvent(new CustomEvent("simpress:chamados-atualizados", { detail: { snapshot_id: estado.versao } }));
}

export async function importarPlanilhas(simpress: File | undefined, oracle: File | undefined, limparCampos: () => void) {
  if (!simpress || !oracle) {
    mudar({ statusImportacao: "Selecione as duas planilhas para importar." });
    return;
  }
  const erroPadrao = "Não foi possível importar as planilhas.";
  mudar({ importando: true, statusImportacao: "Lendo as planilhas e relacionando as séries…" });
  try {
    const corpo = new FormData();
    corpo.append("simpress_file", simpress);
    corpo.append("oracle_file", oracle);
    const dados = await apiFetch<RelatorioChamados>("/api/operacoes/chamados/importar", { method: "POST", body: corpo, errorMessage: erroPadrao });
    chaveEvolucaoAtual = "";
    aplicarRelatorio(dados, "");
    // Até a tabela recarregar ela ainda mostra a versão anterior; o aoCarregar da tabela volta a definir a versão dela.
    versaoDaTabela = "";
    limparCampos();
    mudar({ statusImportacao: "Planilhas importadas. As OS foram relacionadas pela série." });
    const painel = document.getElementById("cockpit-tickets-manage-panel") as HTMLDetailsElement | null;
    if (painel) painel.open = false;
    atualizarTabelaChamados();
    await app.carregarProntidao?.();
    app.showToast?.("Acompanhamento de chamados atualizado.", "success");
  } catch (erro) {
    mudar({ statusImportacao: mensagemDe(erro, erroPadrao) });
  } finally {
    mudar({ importando: false });
  }
}

export async function excluirImportacoesAntigasChamadosCockpit() {
  const quantidade = Math.max(0, estado.historico.length - 1);
  if (!quantidade || !(await app.confirmarAcao?.({
    titulo: "Excluir importações antigas?",
    mensagem: `Excluir ${rotuloImportacoesAntigas(quantidade)} e manter somente a mais recente? Esta ação não poderá ser desfeita.`,
    confirmar: "Excluir",
  }))) return;
  const erroPadrao = "Não foi possível excluir as importações antigas.";
  mudar({ excluindo: true });
  try {
    const dados = await apiFetch<{ removidas?: number }>("/api/operacoes/chamados/historico/antigas", { method: "DELETE", errorMessage: erroPadrao });
    mudar({ versao: "" });
    atualizarTabelaChamados();
    app.showToast?.(`${rotuloImportacoesRemovidas(Number(dados.removidas) || 0)}. A importação mais recente foi mantida.`, "success");
  } catch (erro) {
    app.showToast?.(mensagemDe(erro, erroPadrao), "error");
  } finally {
    mudar({ excluindo: false });
  }
}

const campo = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

export async function exportarChamadosCockpit() {
  const versao = estado.versao;
  if (!versao) {
    app.showToast?.("Selecione e aguarde o carregamento de uma versão válida antes de exportar.", "error");
    return;
  }
  const buscaBruta = campo<HTMLInputElement>("cockpit-tickets-search")?.value ?? "";
  const busca = buscaBruta.trim();
  const somenteAtencao = Boolean(campo<HTMLInputElement>("cockpit-tickets-attention")?.checked);
  // Séries que passam no filtro da tela (todas as páginas); null = tabela não carregada ou versão diferente da tela: GET antigo.
  // Aplica antes a busca ainda na espera de 150 ms, para as séries e o rótulo "Busca" do Resumo virem do mesmo texto.
  const painelDados = window.SimpressDataPanels;
  const mesmaVersao = versao === versaoDaTabela;
  if (mesmaVersao) painelDados?.filtrarTabelaOs?.({ busca: buscaBruta });
  const series = mesmaVersao ? painelDados?.seriesFiltradasOs?.() ?? null : null;
  const pedido = pedidoExportacao(versao, busca, somenteAtencao, campo<HTMLSelectElement>("cockpit-tickets-relation")?.value || "", series);
  const erroPadrao = "Não foi possível exportar os chamados filtrados.";
  const opcoes: ApiFetchOptions & { responseType: "response" } = { responseType: "response", errorMessage: erroPadrao };
  if (pedido.metodo === "POST") {
    opcoes.method = "POST";
    opcoes.headers = { "Content-Type": "application/json" };
    opcoes.body = pedido.corpo;
  }
  mudar({ exportando: true });
  try {
    const resposta = await apiFetch(pedido.endpoint, opcoes);
    const url = window.URL.createObjectURL(await resposta.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = nomeArquivoExportado(resposta.headers?.get("Content-Disposition") || "");
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    app.showToast?.("Planilha Exportada com Sucesso!", "success");
  } catch (erro) {
    app.showToast?.(mensagemDe(erro, erroPadrao), "error");
  } finally {
    mudar({ exportando: false });
  }
}

// Home: chamados Oracle ainda abertos da série selecionada, sempre da importação mais recente (mesma API da aba Chamados).
export async function atualizarChamadosAbertosHome(serie: string) {
  if (!document.getElementById("home-open-tickets-body")) return;
  const pedido = portao("home").begin();
  const atual = () => portao("home").isCurrent(pedido.id);
  mudar({ home: { tipo: "carregando" } });
  try {
    // Os chamados do F5 são um complemento: se a consulta falhar, a lista de OS continua aparecendo.
    const sebraePedido = apiFetch<DadosSebraeNovos>("/api/sebrae/novos", { signal: pedido.signal, errorMessage: "Não foi possível consultar os chamados do Sebrae." })
      .then(dados => ({ dados, falhou: false }), () => ({ dados: null, falhou: true }));
    if (!chamadosRecentesHome) {
      const dados = await apiFetch<RelatorioChamados>("/api/operacoes/chamados", { signal: pedido.signal, errorMessage: "Não foi possível carregar os chamados." });
      if (!atual()) return;
      chamadosRecentesHome = dados;
    }
    const resultadoSebrae = await sebraePedido;
    if (!atual() || !chamadosRecentesHome) return;
    const sebrae = chamadosSebraeDaSerie(resultadoSebrae.dados, serie, regras());
    const { abertos, serie: serieDoRegistro } = chamadosAbertosDaSerie(chamadosRecentesHome, serie, regras());
    const comIdade = abertos.map(ticket => ({ ...ticket, idade: app.idadeAtualizacaoChamado(ticket).rotulo }));
    mudar({ home: { tipo: "lista", abertos: comIdade, sebrae, serie: serieDoRegistro, falhaSebrae: resultadoSebrae.falhou } });
  } catch (erro) {
    if (atual()) mudar({ home: { tipo: "erro", mensagem: mensagemDe(erro, "Não foi possível carregar os chamados.") } });
  }
}

// Cliques da lista da Home: as ações abaixo continuam no código antigo, resolvidas na hora do clique.
export const abrirOsEmChamados = (serie: string, os: string | number) => app.abrirChamadoDaOs?.([], serie, os);
export const abrirChamadoNoF5 = (chave: string) => app.abrirChamadoSebraeNoF5?.(chave);
export const verNaAbaChamados = () => document.getElementById("btn-sebrae-chamados-aba")?.click();
