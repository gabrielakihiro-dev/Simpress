// Estado do painel Lembretes e Termos, fora do componente: a aplicação chama as ações da ponte (por exemplo
// termosPreencherDoEquipamento, que a Home dispara para todo equipamento exibido) antes ou depois de o React
// desenhar o painel, e com o painel fechado. A descrição de um lembrete e os campos de um termo têm dado pessoal:
// nada daqui vai para log nem para storage.
import { flushSync } from "react-dom";
import { apiRota, type OpcoesRota } from "../../api";
import type { Rotas } from "../../api-tipos.gerado";
import type { Lembrete } from "./lembretes-puro";
import { TERMOS, type DadosTermo, type NomeTermo } from "./termos-puro";
import { appAntigo } from "./tipos";

export type AbaPainel = "entrega" | "devolucao" | "lembretes";
export type Vista = "hoje" | "embreve";
export type IdLembrete = string | number;

export interface FormTermo {
  campos: Record<string, string>;
  itens: string[]; // "sim", "nao" ou "" (nenhum marcado), um por item do termo; as ações leem a marca do DOM (ver lerItens)
  versaoItens: number; // sobe a cada troca feita pelo código (limpar, preencher): só então os rádios são reescritos no DOM
  obs: string;
  preenchidoHome: string[]; // campos que a busca de série da Home preencheu: só esses a Home pode apagar depois
  serieHome: string | null; // série da Home já aplicada: a mesma série não sobrescreve o que o usuário mudou
}

export interface StatusTermo {
  texto: string;
  tipo?: "erro";
  verLembrete?: IdLembrete; // com "Lembrete criado.": id do lembrete para o botão Ver em Lembretes
}

export interface Agenda {
  data: string;
  hora: string;
  horaDesligada: boolean;
}

export interface Folha {
  dados: DadosTermo;
  assinatura: HTMLImageElement | null;
}

export interface Estado {
  aba: AbaPainel;
  termos: Record<NomeTermo, FormTermo>;
  status: Record<NomeTermo, StatusTermo>;
  folha: Folha | null;
  lembretes: Lembrete[];
  renderizado: boolean; // false até o primeiro desenho da lista: "Nenhum lembrete." só aparece depois dele
  editandoId: IdLembrete | null;
  concluidosAbertos: boolean;
  vista: Vista;
  semanaAtual: number; // 0 = a semana de hoje
  termosAbertos: string[]; // ids com o bloco "Dados do termo" aberto
  adicionando: boolean;
  novo: Agenda & { descricao: string; painelData: boolean };
  edicao: Agenda & { descricao: string };
  excluirTexto: string;
  criarTexto: string;
  criarEnviando: boolean;
}

export const formVazio = (termo: NomeTermo): FormTermo => ({
  campos: Object.fromEntries(TERMOS[termo].campos.map(nome => [nome, ""])),
  itens: TERMOS[termo].itens.map(() => "sim"),
  versaoItens: 0,
  obs: "",
  preenchidoHome: [],
  serieHome: null,
});

let estado: Estado = {
  aba: "lembretes",
  termos: { entrega: formVazio("entrega"), devolucao: formVazio("devolucao") },
  status: { entrega: { texto: "" }, devolucao: { texto: "" } },
  folha: null,
  lembretes: [],
  renderizado: false,
  editandoId: null,
  concluidosAbertos: false,
  vista: "hoje",
  semanaAtual: 0,
  termosAbertos: [],
  adicionando: false,
  novo: { descricao: "", data: "", hora: "", horaDesligada: true, painelData: false },
  edicao: { descricao: "", data: "", hora: "", horaDesligada: true },
  excluirTexto: "",
  criarTexto: "",
  criarEnviando: false,
};
const ouvintes = new Set<() => void>();
export function mudar(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}
// Para o que precisa do DOM já atualizado logo depois (foco, texto do diálogo antes de abrir, folha antes de imprimir).
export function mudarAgora(parcial: Partial<Estado>) {
  flushSync(() => mudar(parcial));
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

// Valores que nenhuma tela mostra: ficam fora do estado para uma mudança neles não redesenhar o painel.
export const interno = {
  ocupado: false, // uma escrita em andamento: as outras ações de lembrete são ignoradas
  pedidoLista: 0, // cada escrita invalida o GET em andamento: a resposta antiga não pode sobrescrever a lista alterada
  excluindoId: null as IdLembrete | null,
  criando: null as NomeTermo | null, // termo de origem enquanto o diálogo Criar lembrete está aberto
  copiaTermo: null as { campos: Record<string, string>; itens: string[]; obs: string } | null,
  pdfPendente: null as { termo: string } | null, // impressão à espera da assinatura (voo único)
  encerrarImpressao: null as (() => void) | null,
};

export const achar = (id: IdLembrete): Lembrete | undefined => estado.lembretes.find(l => String(l.id) === String(id));

export const mensagemDe = (erro: unknown, padrao: string): string => {
  const e = erro as { status?: number; message?: string } | null;
  return e?.status && e.message ? e.message : padrao;
};
export const avisar = (texto: string, tipo?: string) => appAntigo().showToast?.(texto, tipo);
export const avisarErro = (erro: unknown, padrao: string) => avisar(mensagemDe(erro, padrao), "error");

// Toda escrita invalida o GET em andamento.
export function mutar<R extends keyof Rotas>(rota: R, opcoes: OpcoesRota<R>): Promise<Rotas[R]["resposta"]> {
  interno.pedidoLista += 1;
  return apiRota(rota, opcoes);
}

export const porId = (id: string) => document.getElementById(id);

export const focarCampoNovo = () => porId("lembretes-novo-descricao")?.focus();

// Foco no item depois de uma ação: se o item sumiu da vista, vai para Concluídos ou, sem eles, para o campo novo.
export function focarItem(id: IdLembrete, seletor: string) {
  const item = [...document.querySelectorAll<HTMLElement>("[data-lembrete-id]")].find(el => el.dataset.lembreteId === String(id));
  const alvo = item?.querySelector<HTMLElement>(seletor);
  if (alvo && alvo.getClientRects().length) alvo.focus();
  else if (!porId("lembretes-concluidos-lista")?.hidden || !porId("lembretes-concluidos")?.hidden) porId("lembretes-concluidos-botao")?.focus();
  else focarCampoNovo();
}
