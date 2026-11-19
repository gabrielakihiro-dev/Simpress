// Estado do diálogo "Histórico de atualizações de planilhas", fora dos componentes: a aplicação chama as ações
// pela ponte (frontend/src/aplicacao/comparison-history.ts), às vezes antes de o React desenhar o diálogo. Toda mudança
// de estado vai por flushSync: o DOM já está final quando a ação devolve a promessa (os testes e o MutationObserver
// de paineis-dados dependem disso).
import { flushSync } from "react-dom";
import { apiFetch, type ApiFetchError } from "../../api";
import {
  datasExportacao, mensagemConfirmacaoRestauracao, mensagemRestauracaoConcluida, previaInvalidada, rotuloTotal,
  type EventoHistorico, type Formatadores, type PreviaRestauracao,
} from "./historico-puro";

export type Acao = "consultar" | "restaurar" | "excluir";

export interface Estado {
  fase: "ocioso" | "carregando" | "pronto" | "erro";
  erro: string;
  eventos: EventoHistorico[];
  esqueleto: boolean; // só aparece se a resposta passar de 150 ms (contrato do ui-motion)
  datas: string[];
  dataEscolhida: string; // "" enquanto não há data para exportar
  mensagemDatas: string | null; // preenchida: o seletor mostra só este aviso, desabilitado
  exportando: boolean;
  ocupados: Record<string, string>; // texto do botão em andamento, por chaveAcao()
}

// Ações da aplicação publicadas em window por frontend/src/aplicacao/app.ts (fora de frontend/types/globais.d.ts).
interface AppAntigo {
  abrirModalAcessivel(modalId: string, focoInicial: string, acaoFechar: string): void;
  fecharModalAcessivel(modalId: string): void;
  showToast(mensagem: string, tipo: string): void;
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string; destrutiva?: boolean }): Promise<boolean>;
  invalidarDadosEquipamentoAposRestauracao(): void;
  carregarEstatisticas(): Promise<unknown>;
  carregarUnidades(): Promise<unknown>;
  mostrarResultadoNaAbaComparacao(comparacao: Record<string, unknown>, alvo: unknown): Promise<unknown>;
  baixarHistoricoComparacoesExcel(data: string): Promise<string>;
}
const app = () => window as unknown as AppAntigo;

// frontend/src/comum/history-format.ts, lido na hora do uso (o script antigo já carregou quando o React desenha).
export const formatadores = (): Formatadores => window.SimpressHistoryFormat;

let estado: Estado = {
  fase: "ocioso", erro: "", eventos: [], esqueleto: false, datas: [], dataEscolhida: "",
  mensagemDatas: "Carregando datas...", exportando: false, ocupados: {},
};
const ouvintes = new Set<() => void>();
function mudar(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  flushSync(() => { ouvintes.forEach(ouvinte => ouvinte()); });
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

export const chaveAcao = (id: string, acao: Acao) => `${acao}:${id}`;

function marcarOcupado(chave: string, texto: string | null) {
  if ((estado.ocupados[chave] ?? null) === texto) return;
  const ocupados = { ...estado.ocupados };
  if (texto === null) delete ocupados[chave]; else ocupados[chave] = texto;
  mudar({ ocupados });
}

const mensagemDe = (erro: unknown, padrao: string) => (erro instanceof Error && erro.message) || padrao;

// O contador do cabeçalho fica fora do React e é escrito uma vez por carga: paineis-dados observa o nó e pede
// GET /api/painel a cada mudança, então ele não pode ser recriado nem reescrito a mais.
// A escrita da partida leva data-contagem-partida: paineis-dados não repete o painel que acabou de pedir.
function definirTotal(total: unknown, daPartida = false) {
  const contador = document.getElementById("total-historico-comparacoes");
  if (!contador) return;
  // Toda outra escrita tira a marca, mesmo se o observador ainda não existia quando a partida a pôs.
  if (daPartida) contador.setAttribute("data-contagem-partida", ""); else contador.removeAttribute("data-contagem-partida");
  contador.textContent = rotuloTotal(total);
}

function estadoDasDatas(eventos: unknown): Pick<Estado, "datas" | "dataEscolhida" | "mensagemDatas"> {
  const datas = datasExportacao(eventos);
  if (!datas.length) return { datas: [], dataEscolhida: "", mensagemDatas: "Sem datas disponíveis" };
  return { datas, dataEscolhida: datas.includes(estado.dataEscolhida) ? estado.dataEscolhida : datas[0], mensagemDatas: null };
}

const semDatas = () => (estado.dataEscolhida ? {} : { mensagemDatas: "Datas indisponíveis" });

interface RespostaLista { total?: number; eventos?: unknown }

export function escolherData(data: string) {
  mudar({ dataEscolhida: data });
}

// Contador e datas vêm da contagem da partida e de cada carga da lista: só a busca mais nova escreve neles.
let geracaoTotal = 0;
let primeiraContagem = true; // a primeira chamada é a da partida (app.ts); depois de importar, chama de novo

// Chamado na partida do app (sem await): só atualiza o contador e as datas do seletor. Nunca rejeita.
export async function carregarContagemHistoricoComparacoes(): Promise<void> {
  const minha = ++geracaoTotal;
  const daPartida = primeiraContagem;
  primeiraContagem = false;
  try {
    const dados = await apiFetch<RespostaLista>("/api/historico-comparacoes", { errorMessage: "Não foi possível carregar as datas do histórico." });
    if (minha !== geracaoTotal) return;
    definirTotal(dados.total, daPartida);
    mudar(estadoDasDatas(dados.eventos));
  } catch (erro) {
    console.warn("Não foi possível carregar a contagem do histórico de planilhas:", erro);
    if (minha === geracaoTotal) mudar(semDatas());
  }
}

let pedido = 0;
let relogio: ReturnType<typeof setTimeout> | undefined;

// Só a resposta do pedido mais novo vale, se dois se cruzarem. Nunca rejeita.
export async function carregarHistoricoComparacoes(): Promise<void> {
  const meu = ++pedido;
  ++geracaoTotal;
  clearTimeout(relogio);
  // `ocupados` fica: cada ação limpa a própria chave no finally, e um POST em andamento segue bloqueando o botão.
  mudar({ fase: "carregando", esqueleto: false });
  // Indicador de carregamento (ux-enhancements.js) entra antes da busca.
  document.dispatchEvent(new CustomEvent("simpress:carregando-exibido"));
  relogio = setTimeout(() => { if (meu === pedido) mudar({ esqueleto: true }); }, 150);
  try {
    const dados = await apiFetch<RespostaLista>("/api/historico-comparacoes", { errorMessage: "Não foi possível carregar o histórico de planilhas." });
    if (meu !== pedido) return;
    const eventos = Array.isArray(dados.eventos) ? (dados.eventos as EventoHistorico[]) : [];
    clearTimeout(relogio);
    definirTotal(dados.total ?? eventos.length);
    mudar({ fase: "pronto", eventos, esqueleto: false, ...estadoDasDatas(eventos) });
  } catch (erro) {
    if (meu !== pedido) return;
    console.error("Erro ao carregar histórico de planilhas:", erro);
    clearTimeout(relogio);
    mudar({ fase: "erro", erro: mensagemDe(erro, "Não foi possível carregar o histórico de planilhas."), eventos: [], esqueleto: false, ...semDatas() });
  }
}

export function fecharModalHistoricoComparacoes() {
  app().fecharModalAcessivel("modal-historico-comparacoes");
}

export async function abrirModalHistoricoComparacoes() {
  app().abrirModalAcessivel("modal-historico-comparacoes", '[aria-label="Fechar histórico de planilhas"]', "fecharModalHistoricoComparacoes");
  await carregarHistoricoComparacoes();
}

export async function exportarHistoricoComparacoesExcel() {
  const data = estado.dataEscolhida;
  if (!data) {
    app().showToast("Este resultado não tem uma data de histórico para exportar.", "warning");
    return;
  }
  if (estado.exportando) return;
  mudar({ exportando: true });
  try {
    await app().baixarHistoricoComparacoesExcel(data);
    app().showToast("Planilha Exportada com Sucesso!", "success");
  } catch (erro) {
    console.error("Erro ao exportar histórico de planilhas:", erro);
    app().showToast(mensagemDe(erro, "Não foi possível exportar o histórico selecionado."), "error");
  } finally {
    mudar({ exportando: false });
  }
}

// Retentativa de restauração após resposta perdida: reusa a prévia e a Idempotency-Key até o servidor aceitar
// (sucesso) ou invalidar a prévia (409).
const tentativasRestauracao = new Map<string, { token: string; chave: string }>();
const chaveOperacao = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export async function restaurarHistoricoComparacao(evento: EventoHistorico) {
  const chave = chaveAcao(evento.id, "restaurar");
  if (estado.ocupados[chave]) return;
  marcarOcupado(chave, "Preparando...");
  try {
    const previa = await apiFetch<PreviaRestauracao>(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}/restauracao`, { errorMessage: "Não foi possível validar o backup selecionado." });
    const confirmado = await app().confirmarAcao({
      titulo: "Restaurar inventários?",
      mensagem: mensagemConfirmacaoRestauracao(previa, evento, formatadores()),
      confirmar: "Restaurar",
      destrutiva: false,
    });
    if (!confirmado) return;

    marcarOcupado(chave, "Restaurando...");
    const tentativa = tentativasRestauracao.get(evento.id) ?? { token: previa.preview_token, chave: chaveOperacao() };
    tentativasRestauracao.set(evento.id, tentativa);
    const resposta = await apiFetch<Parameters<typeof mensagemRestauracaoConcluida>[0]>(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}/restaurar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": tentativa.chave },
      body: JSON.stringify({ preview_token: tentativa.token }),
      errorMessage: "Não foi possível restaurar o conjunto selecionado.",
    }).catch((erro: ApiFetchError) => {
      if (previaInvalidada(erro.status, erro.detail)) tentativasRestauracao.delete(evento.id);
      throw erro;
    });
    tentativasRestauracao.delete(evento.id);

    app().invalidarDadosEquipamentoAposRestauracao();
    await Promise.allSettled([app().carregarEstatisticas(), app().carregarUnidades(), carregarHistoricoComparacoes()]);
    document.querySelector<HTMLElement>('#modal-historico-comparacoes [aria-label="Fechar histórico de planilhas"]')
      ?.focus({ preventScroll: true });
    app().showToast(mensagemRestauracaoConcluida(resposta), "success");
  } catch (erro) {
    console.error("Erro ao restaurar o conjunto de planilhas:", erro);
    app().showToast(mensagemDe(erro, "Não foi possível restaurar o conjunto selecionado."), "error");
  } finally {
    marcarOcupado(chave, null);
  }
}

// `indicar` liga e desliga o aviso "Carregando..." do botão que pediu (o do cartão ou um botão de fora do diálogo).
async function abrirResultado(eventoId: string, destino: unknown, indicar: (ativo: boolean) => void) {
  indicar(true);
  try {
    const dados = await apiFetch<{ evento?: { id?: string; horario?: string; comparacao?: Record<string, unknown> } }>(
      `/api/historico-comparacoes/${encodeURIComponent(eventoId)}`,
      { errorMessage: "Não foi possível abrir este resultado." },
    );
    const evento = dados.evento || {};
    fecharModalHistoricoComparacoes();
    await app().mostrarResultadoNaAbaComparacao({
      ...(evento.comparacao || {}),
      evento_id: evento.id,
      horario_comparacao: evento.horario || evento.comparacao?.horario_comparacao,
      historico_salvo: true,
      contexto_historico: true,
    }, destino);
  } catch (erro) {
    console.error("Erro ao abrir comparação salva:", erro);
    app().showToast(mensagemDe(erro, "Não foi possível abrir este resultado."), "error");
  } finally {
    indicar(false);
  }
}

export function consultarDoCartao(eventoId: string) {
  const chave = chaveAcao(eventoId, "consultar");
  if (estado.ocupados[chave]) return Promise.resolve();
  return abrirResultado(eventoId, null, ativo => marcarOcupado(chave, ativo ? "Carregando..." : null));
}

// Atalho da Home (frontend/src/aplicacao/comparison-history.ts): abre o resultado salvo e rola até a seção de `destino`;
// `botao` é o botão da Home que pediu, e ganha o mesmo aviso "Carregando...".
export function consultarHistoricoComparacao(eventoId: string, botao?: unknown, destino: unknown = null) {
  if (!(botao instanceof HTMLButtonElement)) return abrirResultado(eventoId, destino, () => {});
  const original = [...botao.childNodes];
  return abrirResultado(eventoId, destino, ativo => {
    botao.disabled = ativo;
    if (ativo) { botao.setAttribute("aria-busy", "true"); botao.textContent = "Carregando..."; }
    else { botao.removeAttribute("aria-busy"); botao.replaceChildren(...original); }
  });
}

export async function excluirHistoricoComparacao(evento: EventoHistorico) {
  const dataHora = formatadores().formatarHorarioHistorico(evento.horario);
  const confirmado = await app().confirmarAcao({
    titulo: "Excluir atualização?",
    mensagem: `Tem certeza de que deseja excluir esta atualização de ${dataHora}? Essa ação não poderá ser desfeita.`,
    confirmar: "Excluir",
  });
  if (!confirmado) return;

  const chave = chaveAcao(evento.id, "excluir");
  marcarOcupado(chave, "Excluindo...");
  try {
    await apiFetch(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}`, { method: "DELETE", errorMessage: "Não foi possível excluir esta atualização." });
    await carregarHistoricoComparacoes();
    app().showToast("Atualização excluída do histórico.", "success");
  } catch (erro) {
    console.error("Erro ao excluir atualização do histórico:", erro);
    app().showToast(mensagemDe(erro, "Não foi possível excluir esta atualização."), "error");
  } finally {
    marcarOcupado(chave, null);
  }
}
