// Ações dos lembretes: lista em /api/lembretes, edição, exclusão, vistas e criação a partir de um termo.
// A descrição tem dado pessoal: nunca vai para log nem para storage.
import { apiRota } from "../../api";
import type { AtualizarLembretePayload } from "../../api-tipos.gerado";
import {
  achar, avisar, avisarErro, focarCampoNovo, focarItem, interno, ler, mudar, mudarAgora, mutar, porId,
  type Agenda, type Estado, type IdLembrete, type Vista,
} from "./estado";
import {
  camposEditados, dataDe, dataValida, derivarLista, hojeEm, horaDe, LIMITE, proximaSegunda, RE_HORA, rotuloAgenda, somarDias, tamanho,
  textoTermo, type Lembrete,
} from "./lembretes-puro";
import { avisarTermo, ehTermo, gerarPdfDoLembrete, lerValidado, preencherDoLembrete } from "./termos-acoes";
import { limparTexto, montarDescricaoTermo } from "./termos-puro";
import { appAntigo, type EventoTecla } from "./tipos";

// O mínimo de um campo de formulário: o React e a ponte da aplicação passam objetos diferentes para as mesmas ações.
export interface CampoMinimo {
  id?: string;
  value: string;
  validity?: { badInput?: boolean };
}

const campoDe = (id: string) => porId(id) as HTMLInputElement | null;
const NOVO_VAZIO: Estado["novo"] = { descricao: "", data: "", hora: "", horaDesligada: true, painelData: false };

// Toda mudança na lista de lembretes conta como desenho feito: só depois dele "Nenhum lembrete." pode aparecer.
const comLista = (lembretes: Lembrete[], extra: Partial<Estado> = {}): Partial<Estado> => ({ lembretes, renderizado: true, ...extra });
const trocar = (id: IdLembrete, atualizado: Lembrete) => ler().lembretes.map(l => (String(l.id) === String(id) ? atualizado : l));

// Depois de cada mutação que mudou a lista (sucesso, ou 404 na exclusão): o cartão do sino (#alerta-lembretes-agendados) e o badge
// pedem o painel de novo, sem reaproveitar um pedido que partiu antes da mudança. O evento só leva esse booleano, nunca dado do lembrete.
function avisarSino() {
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("simpress:atualizar-notificacoes", { detail: { depoisDeMudanca: true } }));
}

// Item agendado para um dia fora da vista aberta: o toast diz para onde ele foi.
function avisarSeFora(l: Lembrete | undefined) {
  const dia = l && !l.concluido ? dataDe(l) : null;
  if (!l || !dia) return;
  const { lembretes, vista, semanaAtual } = ler();
  const hoje = hojeEm();
  const aqui = derivarLista(lembretes, hoje, vista, semanaAtual).grupos.some(grupo => grupo.itens.some(item => String(item.id) === String(l.id)));
  if (!aqui) avisar(`Lembrete agendado para ${rotuloAgenda(dia, horaDe(l), hoje)}.`);
}

export async function carregarLembretes(): Promise<void> {
  const pedido = ++interno.pedidoLista;
  try {
    const dados = await apiRota("GET /api/lembretes", { errorMessage: "Não foi possível carregar os lembretes." });
    if (pedido !== interno.pedidoLista) return;
    mudar(comLista(Array.isArray(dados?.lembretes) ? dados.lembretes : [], { editandoId: null }));
  } catch (erro) {
    if (pedido === interno.pedidoLista) avisarErro(erro, "Não foi possível carregar os lembretes.");
  }
}

// Mesmo teste para o campo de adicionar, o de editar e o do diálogo Criar: o texto vai para o estado e o botão de confirmar se ajusta.
export function aoDigitar(campo: CampoMinimo): void {
  if (campo.id === "lembretes-novo-descricao") mudar({ novo: { ...ler().novo, descricao: campo.value } });
  else if (campo.id === "lembretes-criar-descricao") mudar({ criarTexto: campo.value });
  else mudar({ edicao: { ...ler().edicao, descricao: campo.value } });
}

// Hora só existe com data: sem data o campo de hora fica desligado e vazio. Vale para o formulário novo e para a edição.
// O campo de hora também passa por aqui (é o mesmo "change" de antes da migração): só guarda o valor.
export function aoMudarData(campo: CampoMinimo): void {
  const id = campo.id ?? "";
  const edicao = id.startsWith("lembretes-edicao");
  const atual: Agenda = edicao ? ler().edicao : ler().novo;
  let proximo: Agenda;
  if (id.endsWith("-hora")) {
    proximo = { ...atual, hora: campo.value };
  } else {
    proximo = { ...atual, data: campo.value };
    // Data digitada pela metade (badInput) também chega como "": não apaga a hora já escolhida.
    if (!campo.validity?.badInput) {
      proximo.horaDesligada = !campo.value;
      if (!campo.value) proximo.hora = "";
    }
  }
  if (edicao) mudar({ edicao: { ...ler().edicao, ...proximo } });
  else mudar({ novo: { ...ler().novo, ...proximo } });
}

export function atalhoData(qual: string): void {
  const hoje = hojeEm();
  const data = qual === "amanha" ? somarDias(hoje, 1) : qual === "segunda" ? proximaSegunda(hoje) : hoje;
  aoMudarData({ id: "lembretes-novo-data", value: data });
}

export function removerData(escopo: string): void {
  const id = `lembretes-${escopo === "edicao" ? "edicao" : "novo"}-data`;
  // Data digitada pela metade não aparece no estado (valor ""): limpa o campo do navegador à mão.
  const campo = campoDe(id);
  if (campo) campo.value = "";
  aoMudarData({ id, value: "" });
  campo?.focus();
}

function mudarPainelData(abrir: boolean) {
  mudar({ novo: { ...ler().novo, painelData: abrir } });
}

export function alternarPainelData(): void {
  mudarPainelData(!ler().novo.painelData);
}

// Esc fecha só o painel Data agendada e devolve o foco ao botão Data; preventDefault impede o Esc de fechar o painel de ferramentas.
export function teclaPainelData(evento: EventoTecla): void {
  if (evento?.key !== "Escape" || !ler().novo.painelData) return;
  evento.preventDefault();
  mudarAgora({ novo: { ...ler().novo, painelData: false } });
  porId("lembretes-data-botao")?.focus();
}

// Corpo do POST: só inclui a data quando é uma data real; a hora, só com data e no formato HH:MM.
function agendaDe({ data, hora }: Agenda): Record<string, string> {
  if (!dataValida(data)) return {};
  return RE_HORA.test(hora) ? { data_agendada: data, hora_agendada: hora } : { data_agendada: data };
}

export async function adicionar(): Promise<void> {
  if (interno.ocupado) return;
  const { novo } = ler();
  const descricao = novo.descricao.trim();
  if (!descricao || tamanho(descricao) > LIMITE) return;
  // Data incompleta: não cria o lembrete sem data; leva o foco ao campo para completar.
  if (campoDe("lembretes-novo-data")?.validity?.badInput) {
    mudarAgora({ novo: { ...novo, painelData: true } });
    campoDe("lembretes-novo-data")?.focus();
    return;
  }
  const agenda = agendaDe(novo);
  interno.ocupado = true;
  mudarAgora({ adicionando: true });
  try {
    const criado = await mutar("POST /api/lembretes", {
      corpo: { descricao, ...agenda },
      errorMessage: "Não foi possível adicionar o lembrete.",
    });
    mudar(comLista([...ler().lembretes, criado], { novo: NOVO_VAZIO }));
    avisarSino();
    avisarSeFora(criado);
  } catch (erro) {
    avisarErro(erro, "Não foi possível adicionar o lembrete.");
  } finally {
    interno.ocupado = false;
    mudarAgora({ adicionando: false });
    focarCampoNovo();
  }
}

async function atualizar(id: IdLembrete, campos: AtualizarLembretePayload, mensagem: string): Promise<Lembrete> {
  return mutar("PATCH /api/lembretes/{lembrete_id}", { caminho: { lembrete_id: id }, corpo: campos, errorMessage: mensagem });
}

export async function alternar(id: IdLembrete): Promise<void> {
  const l = achar(id);
  if (!l || interno.ocupado) return;
  interno.ocupado = true;
  try {
    const atualizado = await atualizar(id, { concluido: !l.concluido }, "Não foi possível atualizar o lembrete.");
    mudarAgora(comLista(trocar(id, atualizado)));
    avisarSino();
  } catch (erro) {
    avisarErro(erro, "Não foi possível atualizar o lembrete.");
  } finally {
    interno.ocupado = false;
  }
  focarItem(id, ".lembretes__marcar");
}

export function editar(id: IdLembrete): void {
  const l = achar(id);
  if (!l) return;
  const data = dataDe(l) ?? "";
  mudarAgora({ editandoId: id, edicao: { descricao: l.descricao, data, hora: horaDe(l) ?? "", horaDesligada: !data } });
  const campo = campoDe("lembretes-edicao-campo");
  campo?.focus();
  campo?.setSelectionRange?.(campo.value.length, campo.value.length);
}

function sairDaEdicao(id: IdLembrete, extra: Partial<Estado> = {}) {
  mudarAgora({ ...extra, editandoId: null });
  focarItem(id, ".lembretes__editar");
}

export function cancelarEdicao(id: IdLembrete): void {
  if (String(ler().editandoId) === String(id)) sairDaEdicao(id);
}

export function teclaEdicao(evento: EventoTecla): void {
  const { editandoId } = ler();
  if (evento?.key !== "Escape" || editandoId === null) return;
  // preventDefault impede o Esc de também fechar o painel de ferramentas.
  evento.preventDefault();
  sairDaEdicao(editandoId);
}

export async function salvarEdicao(id: IdLembrete): Promise<void> {
  const l = achar(id);
  if (!l || !campoDe("lembretes-edicao-campo") || interno.ocupado) return;
  const { edicao } = ler();
  const descricao = edicao.descricao.trim();
  if (!descricao || tamanho(descricao) > LIMITE) return;
  const campoData = campoDe("lembretes-edicao-data");
  // Data incompleta chega como "": sem esta checagem o PATCH apagaria a data e a hora.
  if (campoData?.validity?.badInput) {
    campoData.focus();
    return;
  }
  if (edicao.data && !dataValida(edicao.data)) return;
  const campos = camposEditados(l, { descricao, data: edicao.data, hora: edicao.hora });
  // Nada mudou: sem PATCH, e o alterado_em continua o mesmo.
  if (!Object.keys(campos).length) {
    sairDaEdicao(id);
    return;
  }
  interno.ocupado = true;
  try {
    const atualizado = await atualizar(id, campos, "Não foi possível salvar o lembrete.");
    sairDaEdicao(id, comLista(trocar(id, atualizado)));
    avisarSino();
    if ("data_agendada" in campos || "hora_agendada" in campos) avisarSeFora(achar(id));
  } catch (erro) {
    avisarErro(erro, "Não foi possível salvar o lembrete.");
  } finally {
    interno.ocupado = false;
  }
}

export function alternarConcluidos(): void {
  mudar({ concluidosAbertos: !ler().concluidosAbertos });
}

export function excluir(id: IdLembrete): void {
  const l = achar(id);
  if (!l) return;
  interno.excluindoId = id;
  // O texto precisa estar na tela antes de o diálogo abrir (o foco inicial e a leitura do leitor de tela dependem dele).
  mudarAgora({ excluirTexto: l.descricao });
  appAntigo().abrirModalAcessivel?.("lembretes-confirmar", "#lembretes-confirmar-cancelar", "lembretesCancelarExclusao");
  // abrirModalAcessivel marca todo diálogo como role="dialog"; esta pergunta é destrutiva.
  porId("lembretes-confirmar")?.firstElementChild?.setAttribute("role", "alertdialog");
}

// Também é o fechamento do Esc (accessible-dialogs chama window[data-close-function]).
export function cancelarExclusao(): void {
  if (interno.excluindoId === null) return;
  interno.excluindoId = null;
  appAntigo().fecharModalAcessivel?.("lembretes-confirmar");
}

export async function confirmarExclusao(): Promise<void> {
  const id = interno.excluindoId;
  if (id === null || interno.ocupado) return;
  interno.ocupado = true;
  const antes = achar(id);
  const idLista = antes?.concluido ? "lembretes-concluidos-lista" : "lembretes-lista";
  // A lista de pendentes tem grupos: os itens (li) são contados na ordem da tela, de todos os grupos.
  const itensDaLista = () => [...(porId(idLista)?.querySelectorAll<HTMLElement>("[data-lembrete-id]") ?? [])];
  const indice = itensDaLista().findIndex(li => li.dataset.lembreteId === String(id));
  let removido = false;
  try {
    await mutar("DELETE /api/lembretes/{lembrete_id}", { caminho: { lembrete_id: id }, errorMessage: "Não foi possível excluir o lembrete." });
    removido = true;
  } catch (erro) {
    avisarErro(erro, "Não foi possível excluir o lembrete.");
    // 404: o item já não existe no servidor, então recontar o sino é correto.
    if ((erro as { status?: number } | null)?.status === 404) removido = true;
  } finally {
    interno.ocupado = false;
    interno.excluindoId = null;
    appAntigo().fecharModalAcessivel?.("lembretes-confirmar");
  }
  if (!removido) return;
  avisarSino();
  mudarAgora(comLista(ler().lembretes.filter(l => String(l.id) !== String(id))));
  // O foco volta ao item que ocupou o lugar do excluído; sem itens na lista, ao campo de adicionar.
  const itens = itensDaLista();
  const proximo = itens[Math.min(indice, itens.length - 1)];
  if (proximo && proximo.getClientRects().length) proximo.querySelector<HTMLElement>(".lembretes__marcar")?.focus();
  else focarCampoNovo();
}

// Diálogo Criar lembrete (Termo Entrega e Termo Devolução): o texto já vem montado e o usuário revisa antes de criar.
export function criarDoTermo(termo: string): void {
  if (!ehTermo(termo)) return;
  // Sem número de série ou sem nome, lerValidado mostra o aviso no termo e nada abre.
  const dados = lerValidado(termo);
  // Com um POST em andamento, o fim dele fecharia este diálogo novo e o texto revisado se perderia.
  if (!dados || interno.ocupado) return;
  avisarTermo(termo, "");
  interno.criando = termo;
  interno.copiaTermo = {
    campos: Object.fromEntries(Object.entries(dados.campos).map(([chave, valor]) => [chave, textoTermo(valor, 200)])),
    itens: dados.itens.map(item => String(item.resposta)),
    obs: textoTermo(dados.obs, 2000, "\n\r\t"),
  };
  mudarAgora({ criarTexto: montarDescricaoTermo(termo, dados), criarEnviando: false });
  appAntigo().abrirModalAcessivel?.("lembretes-criar", "#lembretes-criar-descricao", "lembretesCancelarCriar");
}

// Também é o fechamento do Esc (accessible-dialogs chama window[data-close-function]).
export function cancelarCriar(): void {
  if (interno.criando === null) return;
  interno.criando = null;
  interno.copiaTermo = null;
  appAntigo().fecharModalAcessivel?.("lembretes-criar");
}

export async function confirmarCriar(): Promise<void> {
  const termo = interno.criando;
  if (termo === null || interno.ocupado) return;
  // Mesma limpeza da parte pura: o usuário pode ter digitado quebra de linha no campo.
  const descricao = limparTexto(ler().criarTexto);
  if (!descricao || tamanho(descricao) > LIMITE) return;
  interno.ocupado = true;
  mudarAgora({ criarEnviando: true });
  let criado: Lembrete | null = null;
  try {
    criado = await mutar("POST /api/lembretes", {
      corpo: { descricao, origem: termo, termo: interno.copiaTermo },
      errorMessage: "Não foi possível criar o lembrete.",
    });
  } catch (erro) {
    avisarErro(erro, "Não foi possível criar o lembrete.");
  } finally {
    interno.ocupado = false;
    mudar({ criarEnviando: false });
  }
  // Em erro o diálogo continua aberto, com o texto, para tentar de novo.
  if (!criado) return;
  avisarSino();
  interno.criando = null;
  interno.copiaTermo = null;
  const { status } = ler();
  mudarAgora(comLista([...ler().lembretes, criado], { status: { ...status, [termo]: { texto: "Lembrete criado.", verLembrete: criado.id } } }));
  appAntigo().fecharModalAcessivel?.("lembretes-criar");
}

export function verLembretes(id: IdLembrete): void {
  mudarAgora({ aba: "lembretes" });
  focarItem(id, ".lembretes__marcar");
}

// Vistas Hoje e Em breve (pílulas, tablist com setas) e navegação por semana.
export function selecionarVista(qual: string): void {
  if ((qual !== "hoje" && qual !== "embreve") || qual === ler().vista) return;
  mudarAgora({ editandoId: null, vista: qual, semanaAtual: 0 });
}

export function teclaVista(evento: EventoTecla): void {
  const abas: Vista[] = ["hoje", "embreve"];
  const passo = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[evento?.key];
  const alvo = evento?.key === "Home" ? 0 : evento?.key === "End" ? abas.length - 1
    : passo === undefined ? null : (abas.indexOf(ler().vista) + passo + abas.length) % abas.length;
  if (alvo === null) return;
  evento.preventDefault();
  selecionarVista(abas[alvo]);
  porId(`lembretes-aba-${ler().vista}`)?.focus();
}

// delta: -1 semana anterior, 1 próxima semana, 0 volta à semana de hoje. Nunca mostra semana passada.
export function mudarSemana(delta: number | string): void {
  const passo = Number(delta);
  const { semanaAtual } = ler();
  const nova = passo === 0 ? 0 : Math.max(0, semanaAtual + passo);
  if (nova === semanaAtual) return;
  mudarAgora({ editandoId: null, semanaAtual: nova });
  // Semana anterior fica desligada na semana de hoje: o foco passa para Próxima semana em vez de se perder.
  if (passo < 0 && (porId("lembretes-semana-anterior") as HTMLButtonElement | null)?.disabled) porId("lembretes-semana-proxima")?.focus();
}

export function irParaDia(data: string): void {
  porId(`lembretes-grupo-${data}`)?.focus();
}

// + Adicionar lembrete de um dia: põe a data no formulário e leva o foco à descrição.
export function adicionarNoDia(data: string): void {
  if (!dataValida(data)) return;
  aoMudarData({ id: "lembretes-novo-data", value: data });
  focarCampoNovo();
}

// Sem confirmação (como no Todoist): o backend move todo pendente atrasado para hoje, mantendo a hora.
export async function reagendarAtrasados(): Promise<void> {
  if (interno.ocupado) return;
  // Uma edição aberta seria salva depois com a data antiga e desfaria o reagendamento.
  mudar({ editandoId: null });
  interno.ocupado = true;
  let movidos = 0;
  try {
    const dados = await mutar("POST /api/lembretes/reagendar-atrasados", {
      errorMessage: "Não foi possível reagendar os lembretes.",
    });
    movidos = Number(dados?.reagendados) || 0;
    mudarAgora(comLista(Array.isArray(dados?.lembretes) ? dados.lembretes : ler().lembretes));
    avisarSino();
    if (movidos > 0) avisar(movidos === 1 ? "1 lembrete reagendado para hoje." : `${movidos} lembretes reagendados para hoje.`);
  } catch (erro) {
    avisarErro(erro, "Não foi possível reagendar os lembretes.");
  } finally {
    interno.ocupado = false;
  }
  // O botão Reagendar sai da tela: o foco vai ao grupo de hoje, onde os itens foram parar.
  if (movidos > 0) porId(`lembretes-grupo-${hojeEm()}`)?.focus();
}

// Ações do bloco "Dados do termo": usam só os dados salvos no lembrete.
export function gerarPdfTermo(id: IdLembrete): Promise<void> | undefined {
  const l = achar(id);
  return l?.termo ? gerarPdfDoLembrete(l.origem, l.termo) : undefined;
}

export function preencherTermo(id: IdLembrete): Promise<boolean> | undefined {
  const l = achar(id);
  return l?.termo ? preencherDoLembrete(l.origem, l.termo) : undefined;
}
