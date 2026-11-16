// Modal "E-mail pelo Outlook" (Home F1): modelos com autosave, contatos do Entra e abrir ou enviar pelo Outlook local.
// Envio real só por clique, depois da confirmação, com confirmado: true; o clique duplo nunca envia duas vezes porque
// "ocupado" trava na hora, sem esperar o React desenhar (invariante do AGENTS.md). Nada de corpo nem destinatário em console.
// A lógica é a do módulo antigo: os valores e as listas ficam em variáveis do módulo, lidas na hora; o objeto "estado" é só
// o que a tela mostra e é trocado por inteiro a cada mudança (useSyncExternalStore compara por identidade).
import { flushSync } from "react-dom";
import type { KeyboardEvent } from "react";
import { apiFetch, type ApiFetchOptions } from "../../api";
import { lerEstado } from "../../estado-app";
import {
  ATRASO_BUSCA, ATRASO_SALVAR, ID_CABO, TEXTO, contaInicial, dividir, falhaEmail, inserirContato, marcadorPendente, mensagemDeErro,
  podeBuscar, proximoAtivo, resultadoEmail, rotuloContato, substituirTokens, temDestinatario, textoConfirmacaoEnvio, textoCopiado,
  tokenFinal, tokensParaResolver, type Conta, type Contato, type ErroApi, type ModoEmail, type TipoAviso,
} from "./regras-puro";

const MODAL = "modal-email-outlook";
const API = "/api/outlook";
const ULTIMO_MODELO = "simpress.outlook-email.ultimo-modelo";
const JSON_HEADERS = { "Content-Type": "application/json" };

export type CampoModelo = "nome" | "conta" | "para" | "cc" | "assunto" | "corpo";
export type CampoCombo = "para" | "cc";
const COMBOS: CampoCombo[] = ["para", "cc"];

interface Modelo { id: string; nome: string; conta?: string; para?: string; cc?: string; assunto?: string; corpo?: string }
interface Config { contas: Conta[]; modelos: Modelo[]; diretorio?: { disponivel?: boolean } }
interface Ambiguo { token: string; opcoes: Contato[] }
interface Resolucao { token: string; status: string; nome?: string; email?: string; opcoes?: Contato[] }

export interface ComboEstado {
  aberta: boolean; // lista de sugestões visível
  itens: Contato[];
  ativo: number;
  ambiguos: Ambiguo[]; // "qual pessoa?" para nomes com mais de uma opção no Entra
}

export interface Estado {
  pronto: boolean; // configuração carregada: os campos livres liberam
  ocupado: boolean; // ação lenta em andamento: os controles de ação travam
  modelos: { id: string; nome: string }[];
  contas: Conta[];
  modeloSelecionado: string; // o que o select mostra; só vira modelo vigente depois de salvar o atual
  restaurarVisivel: boolean;
  semDiretorio: boolean; // base do Entra não importada
  nome: string;
  conta: string;
  para: string;
  cc: string;
  assunto: string;
  corpo: string;
  nomePessoa: string;
  setor: string;
  autosave: string;
  autosaveErro: boolean;
  status: string;
  statusTipo: TipoAviso | "";
  combos: Record<CampoCombo, ComboEstado>;
}

// Ações do código antigo publicadas em window por static/app.js (fora de frontend/types/globais.d.ts).
interface AppAntigo {
  showToast(mensagem: string, tipo: string): void;
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string; cancelar: string; destrutiva?: boolean }): Promise<boolean>;
  abrirModalAcessivel(id: string, foco: string, fechar: string): void;
  fecharModalAcessivel(id: string): void;
  copiarTextoParaAreaTransferencia(texto: string): Promise<unknown>;
}
const app = () => window as unknown as AppAntigo;

const COMBO_VAZIO: ComboEstado = { aberta: false, itens: [], ativo: -1, ambiguos: [] };
let estado: Estado = {
  pronto: false, ocupado: false, modelos: [], contas: [], modeloSelecionado: "", restaurarVisivel: false, semDiretorio: false,
  nome: "", conta: "", para: "", cc: "", assunto: "", corpo: "", nomePessoa: "", setor: "",
  autosave: "", autosaveErro: false, status: "", statusTipo: "", combos: { para: COMBO_VAZIO, cc: COMBO_VAZIO },
};
const ouvintes = new Set<() => void>();
function mudar(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}
function mudarCombo(campo: CampoCombo, parcial: Partial<ComboEstado>) {
  mudar({ combos: { ...estado.combos, [campo]: { ...estado.combos[campo], ...parcial } } });
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

let config: Config | null = null; // { contas, modelos, diretorio } do último GET /email/configuracao
const cfg = () => config as Config;
let modeloId: string | null = null;
let aberto = false;
let geracao = 0; // sobe a cada abrir e fechar: resposta atrasada de uma sessão antiga é descartada
let ocupado = false;
let ligado = false;
let timerSalvar: ReturnType<typeof setTimeout> | null = null;
let cadeia: Promise<boolean> = Promise.resolve(true); // os PUTs rodam um depois do outro; resolve para "o último salvou"
const sujo = new Set<CampoModelo>(); // campos do modelo editados desde o último salvamento
let gravando = 0; // PUTs na fila ou em voo
const internos: Record<CampoCombo, { timer: ReturnType<typeof setTimeout> | null; pedido: number; resolucao: number }> = {
  para: { timer: null, pedido: 0, resolucao: 0 },
  cc: { timer: null, pedido: 0, resolucao: 0 },
};

const lerCampo = (campo: CampoModelo) => estado[campo];
const diretorioDisponivel = () => Boolean(config?.diretorio?.disponivel);
const sincronizar = () => mudar({ pronto: Boolean(config), ocupado });

function chamar<T>(caminho: string, { metodo = "GET", dados, erro = TEXTO.falha }: { metodo?: string; dados?: unknown; erro?: string } = {}) {
  const opcoes: ApiFetchOptions & { responseType?: "json" } = { method: metodo, errorMessage: erro };
  if (dados !== undefined) Object.assign(opcoes, { headers: JSON_HEADERS, body: JSON.stringify(dados) });
  return apiFetch<T>(API + caminho, opcoes);
}

// ---------------------------------------------------------------- mensagens

const mostrarAutosave = (autosave: string, autosaveErro = false) => mudar({ autosave, autosaveErro });
const mostrarStatus = (status: string, tipo: TipoAviso = "aviso") => mudar({ status, statusTipo: status ? tipo : "" });

// Resultado de uma ação: a linha de status no modal e um aviso na tela (só a linha era fácil de perder).
// linha = false: resultado de uma sessão do modal já fechada vai só para o aviso.
function avisar(texto: string, tipo: TipoAviso, linha = true) {
  if (linha) mostrarStatus(texto, tipo);
  app().showToast(texto, tipo === "ok" ? "success" : tipo === "erro" ? "error" : "warning");
}

// Uma ação lenta por vez (chamada ao Outlook, troca de modelo). O foco volta para onde estava quando os controles voltam.
async function exclusivo<T>(passo: () => Promise<T>): Promise<T | undefined> {
  if (ocupado || !aberto || !config) return undefined;
  const foco = document.activeElement as HTMLElement | null;
  const minha = geracao;
  ocupado = true;
  sincronizar();
  try {
    return await passo();
  } finally {
    ocupado = false;
    flushSync(sincronizar); // o botão precisa estar habilitado para receber o foco
    if (aberto && geracao === minha) foco?.focus?.();
  }
}

// ---------------------------------------------------------------- modelos e autosave

function lembrarModelo(id: string) {
  try { window.localStorage.setItem(ULTIMO_MODELO, id); } catch { /* só conveniência */ }
}

function ultimoModelo() {
  try { return window.localStorage.getItem(ULTIMO_MODELO); } catch { return null; }
}

const publicarModelos = () => mudar({ modelos: cfg().modelos.map(({ id, nome }) => ({ id, nome })) });

function selecionarModelo(id: string | null) {
  const modelo = cfg().modelos.find(item => item.id === id) || cfg().modelos[0];
  modeloId = modelo.id;
  limparTimer();
  sujo.clear();
  reiniciarCombos();
  mudar({
    modeloSelecionado: modelo.id, nome: modelo.nome, conta: contaInicial(cfg().contas, modelo.conta || ""),
    para: modelo.para || "", cc: modelo.cc || "", assunto: modelo.assunto || "", corpo: modelo.corpo || "",
    restaurarVisivel: modelo.id === ID_CABO, autosave: "", autosaveErro: false, status: "", statusTipo: "",
  });
  lembrarModelo(modelo.id);
}

function guardarModelo(modelo: Modelo | null | undefined) {
  if (!config || !modelo?.id) return;
  const indice = config.modelos.findIndex(item => item.id === modelo.id);
  if (indice < 0) return;
  config.modelos[indice] = modelo;
  publicarModelos();
}

function limparTimer() {
  if (timerSalvar) clearTimeout(timerSalvar);
  timerSalvar = null;
}

function marcarSujo(campo: CampoModelo) {
  sujo.add(campo);
  mostrarAutosave(TEXTO.pendente);
}

function agendarSalvar(campo: CampoModelo) {
  if (!modeloId) return;
  marcarSujo(campo);
  limparTimer();
  timerSalvar = setTimeout(() => void salvarPendente(), ATRASO_SALVAR);
}

async function gravar(id: string, dados: Partial<Record<CampoModelo, string>>, campos: CampoModelo[]) {
  try {
    guardarModelo(await chamar<Modelo>(`/email/modelos/${encodeURIComponent(id)}`, { metodo: "PUT", dados }));
    if (modeloId === id && !sujo.size && !timerSalvar && gravando === 1) mostrarAutosave(TEXTO.salva);
    return true;
  } catch (erro) {
    const atual = modeloId === id;
    if (atual) campos.forEach(campo => sujo.add(campo)); // o próximo salvamento tenta de novo
    const mensagem = TEXTO.falhaSalvar + mensagemDeErro(erro as ErroApi);
    mostrarAutosave(mensagem, true);
    if (!aberto || !atual) app().showToast(mensagem, "error");
    return false;
  } finally {
    gravando -= 1;
  }
}

// Grava o que está pendente agora, um PUT por campo: um campo que o servidor recusa não derruba os outros.
// Resolve para true quando nada ficou sem salvar.
function salvarPendente(): Promise<boolean> {
  limparTimer();
  const id = modeloId;
  if (!id || !sujo.size) return cadeia.then(() => sujo.size === 0);
  const campos = [...sujo];
  sujo.clear();
  const valores = Object.fromEntries(campos.map(campo => [campo, lerCampo(campo)]));
  mostrarAutosave(TEXTO.salvando);
  gravando += campos.length;
  const resultados = campos.map(campo => cadeia = cadeia.then(() => gravar(id, { [campo]: valores[campo] }, [campo])));
  return Promise.all(resultados).then(feitos => feitos.every(Boolean));
}

async function garantirSalvo() {
  let salvo = await salvarPendente();
  while (salvo && sujo.size) salvo = await salvarPendente(); // digitado enquanto o salvamento rodava
  return salvo;
}

async function descartarPendente() {
  limparTimer();
  sujo.clear();
  mostrarAutosave("");
  await cadeia;
}

// ---------------------------------------------------------------- contatos: sugestões e resolução

function fecharLista(campo: CampoCombo) {
  mudarCombo(campo, { aberta: false, itens: [], ativo: -1 });
}

function reiniciarCombos() {
  for (const campo of COMBOS) {
    const interno = internos[campo];
    if (interno.timer) clearTimeout(interno.timer);
    interno.pedido += 1;
    interno.resolucao += 1;
  }
  mudar({ combos: { para: COMBO_VAZIO, cc: COMBO_VAZIO } });
}

// Troca o texto depois do último ";" por "Nome <endereço>; ".
export function inserir(campo: CampoCombo, contato: Contato) {
  const interno = internos[campo];
  mudar({ [campo]: inserirContato(estado[campo], contato) });
  if (interno.timer) clearTimeout(interno.timer);
  interno.pedido += 1;
  fecharLista(campo);
  marcarSujo(campo);
  void salvarPendente();
  document.getElementById(`email-${campo}`)?.focus();
}

async function buscar(campo: CampoCombo, termo: string) {
  const interno = internos[campo];
  const minha = geracao;
  const pedido = ++interno.pedido;
  const vigente = () => aberto && geracao === minha && pedido === interno.pedido && tokenFinal(estado[campo]) === termo;
  try {
    const dados = await chamar<{ contatos?: Contato[] }>(`/contatos?q=${encodeURIComponent(termo)}`);
    if (vigente()) mudarCombo(campo, { itens: Array.isArray(dados.contatos) ? dados.contatos : [], ativo: -1, aberta: true });
  } catch {
    if (vigente()) fecharLista(campo);
  }
}

function agendarBusca(campo: CampoCombo) {
  const interno = internos[campo];
  if (interno.timer) clearTimeout(interno.timer);
  const termo = tokenFinal(estado[campo]);
  if (!podeBuscar(termo, diretorioDisponivel())) {
    interno.pedido += 1;
    fecharLista(campo);
    return;
  }
  interno.timer = setTimeout(() => void buscar(campo, termo), ATRASO_BUSCA);
}

export function teclaCombo(campo: CampoCombo, evento: KeyboardEvent<HTMLInputElement>) {
  const combo = estado.combos[campo];
  if (combo.aberta) {
    if (evento.key === "Escape") {
      // Fecha só a lista; um segundo Esc (lista já fechada) chega ao diálogo.
      evento.preventDefault();
      evento.stopPropagation();
      fecharLista(campo);
      return;
    }
    if (evento.key === "ArrowDown" || evento.key === "ArrowUp") {
      evento.preventDefault();
      mudarCombo(campo, { ativo: proximoAtivo(combo.ativo, combo.itens.length, evento.key === "ArrowDown" ? 1 : -1) });
      return;
    }
    if (evento.key === "Enter" && combo.itens[combo.ativo]) {
      evento.preventDefault();
      inserir(campo, combo.itens[combo.ativo]);
      return;
    }
    if (evento.key === "Tab") fecharLista(campo);
  }
  enterSalva(evento);
}

// Enter num campo de uma linha confirma o valor: o "change" nativo do módulo antigo salvava na hora.
export function enterSalva(evento: KeyboardEvent<HTMLElement>) {
  if (evento.key === "Enter") void salvarPendente();
}

// Sai do campo: busca agendada ou em voo não pode reabrir a lista com o campo sem foco.
export function sairDoCombo(campo: CampoCombo) {
  const interno = internos[campo];
  if (interno.timer) clearTimeout(interno.timer);
  interno.pedido += 1;
  fecharLista(campo);
  void salvarPendente();
  void resolverCampo(campo);
}

export const salvarAgora = () => { void salvarPendente(); };

// Caixa "qual pessoa?" para nomes que a base do Entra responde com mais de uma opção; some o que saiu do campo.
function mostrarOpcoes(campo: CampoCombo) {
  const presentes = dividir(estado[campo]);
  const atuais = estado.combos[campo].ambiguos;
  const ambiguos = atuais.filter(item => presentes.includes(item.token));
  if (ambiguos.length !== atuais.length) mudarCombo(campo, { ambiguos });
}

function substituirNoCampo(campo: CampoCombo, mapa: Map<string, string>) {
  const { valor, mudou } = substituirTokens(estado[campo], mapa);
  if (!mudou) return;
  mudar({ [campo]: valor });
  marcarSujo(campo);
  void salvarPendente();
}

export function escolherOpcao(campo: CampoCombo, token: string, contato: Contato) {
  substituirNoCampo(campo, new Map([[token, rotuloContato(contato)]]));
  mudarCombo(campo, { ambiguos: estado.combos[campo].ambiguos.filter(item => item.token !== token) });
  mostrarOpcoes(campo);
}

// Nomes sem "@" vão para a base do Entra: um resultado é escrito no campo, vários perguntam ao usuário, nenhum fica
// como digitado para o Outlook resolver (pessoas fora da base do Entra).
async function resolverCampo(campo: CampoCombo) {
  if (!aberto || !diretorioDisponivel()) return;
  const interno = internos[campo];
  const minha = geracao;
  const ordem = ++interno.resolucao;
  const tokens = tokensParaResolver(estado[campo]);
  if (!tokens.length) {
    mudarCombo(campo, { ambiguos: [] });
    return;
  }
  try {
    const dados = await chamar<{ resultados?: Resolucao[] }>("/contatos/resolver", { metodo: "POST", dados: { tokens } });
    if (!aberto || geracao !== minha || ordem !== interno.resolucao) return;
    const resultados = Array.isArray(dados.resultados) ? dados.resultados : [];
    mudarCombo(campo, {
      ambiguos: resultados
        .filter(item => item.status === "ambiguo" && Array.isArray(item.opcoes) && item.opcoes.length)
        .map(item => ({ token: item.token, opcoes: item.opcoes as Contato[] })),
    });
    substituirNoCampo(campo, new Map(resultados
      .filter((item): item is Resolucao & { email: string } => item.status === "unico" && Boolean(item.email))
      .map(item => [item.token, rotuloContato(item)])));
    mostrarOpcoes(campo);
  } catch {
    // Os nomes ficam como digitados; o Outlook ainda tenta resolver.
  }
}

const temAmbiguidade = () => COMBOS.some(campo => {
  mostrarOpcoes(campo);
  return estado.combos[campo].ambiguos.length > 0;
});

const emailDaConta = () => cfg().contas.find(conta => conta.id === estado.conta)?.email || estado.conta;

// ---------------------------------------------------------------- campos editados na tela

export function editarCampo(campo: CampoModelo, valor: string) {
  mudar({ [campo]: valor });
  if (campo === "conta") {
    marcarSujo("conta");
    void salvarPendente();
    return;
  }
  agendarSalvar(campo);
  if (campo === "para" || campo === "cc") {
    mostrarOpcoes(campo);
    agendarBusca(campo);
  }
}

// Nome da pessoa e Setor só entram no texto do e-mail; não fazem parte do modelo salvo.
export function editarEnvio(campo: "nomePessoa" | "setor", valor: string) {
  mudar({ [campo]: valor });
}

export function escolherModelo(id: string) {
  void trocarModeloEmail(id);
}

// ---------------------------------------------------------------- ações

// O navegador pergunta antes de sair com trabalho não salvo ou em andamento (mesmo padrão de history-annotation-autosave.js).
// Sem checar "aberto": um envio ou o salvamento do fechamento continua depois do Esc, e recarregar poderia perder o resultado.
function ligarEventos() {
  if (ligado) return;
  ligado = true;
  window.addEventListener("beforeunload", evento => {
    if (!(sujo.size || timerSalvar || gravando || ocupado)) return;
    evento.preventDefault();
    evento.returnValue = "";
  });
}

export function atualizarEmailOutlook(equipamento?: unknown) {
  const botao = document.getElementById("btn-enviar-email") as HTMLButtonElement | null;
  if (botao) botao.disabled = !equipamento;
}

export async function abrirEmailOutlook() {
  const equipamento = lerEstado("currentEquipamento") as { nome_pessoa?: unknown } | null | undefined;
  if (!equipamento || aberto) return;
  ligarEventos();
  aberto = true;
  const minha = ++geracao;
  config = null;
  modeloId = null;
  reiniciarCombos();
  // Desenha já: o modal abre vazio e sem os dados da sessão anterior (o foco inicial só vale com o select liberado).
  flushSync(() => mudar({
    pronto: false, ocupado, modelos: [], contas: [], modeloSelecionado: "", restaurarVisivel: false, semDiretorio: false,
    nome: "", conta: "", para: "", cc: "", assunto: "", corpo: "", nomePessoa: String(equipamento.nome_pessoa || "").trim(), setor: "",
    autosave: "", autosaveErro: false, status: "", statusTipo: "",
  }));
  app().abrirModalAcessivel(MODAL, "#email-modelo", "fecharEmailOutlook");
  try {
    await cadeia; // um salvamento da sessão anterior precisa chegar antes de ler os modelos de novo
    const dados = await chamar<Config>("/email/configuracao");
    if (!aberto || geracao !== minha) return;
    if (!Array.isArray(dados?.contas) || !dados.contas.length || !Array.isArray(dados.modelos) || !dados.modelos.length) {
      throw new Error(TEXTO.falha);
    }
    flushSync(() => {
      config = dados;
      mudar({ pronto: true, contas: dados.contas, semDiretorio: !diretorioDisponivel() });
      publicarModelos();
      selecionarModelo(ultimoModelo());
    });
    document.getElementById("email-modelo")?.focus();
  } catch (erro) {
    if (aberto && geracao === minha) avisar(mensagemDeErro(erro as ErroApi), "erro");
  }
}

// Esc e Cancelar. O que ainda não foi salvo é gravado antes; uma falha aparece no aviso da tela (o modal já fechou).
export function fecharEmailOutlook() {
  if (!aberto) return undefined;
  const salvando = salvarPendente();
  aberto = false;
  geracao += 1;
  reiniciarCombos();
  app().fecharModalAcessivel(MODAL);
  return salvando;
}

export function trocarModeloEmail(id: string) {
  return exclusivo(async () => {
    const minha = geracao;
    if (!id || id === modeloId) return;
    mudar({ modeloSelecionado: id });
    const salvo = await garantirSalvo();
    if (salvo && aberto && geracao === minha) selecionarModelo(id);
    else if (aberto && geracao === minha) mudar({ modeloSelecionado: modeloId || "" }); // fica; a linha do autosave diz por quê
  });
}

function criarModelo(copiarDe: string | null) {
  return exclusivo(async () => {
    const minha = geracao;
    if (!(await garantirSalvo()) || geracao !== minha) return;
    try {
      const novo = await chamar<Modelo>("/email/modelos", { metodo: "POST", dados: copiarDe ? { copiar_de: copiarDe } : {} });
      if (!aberto || geracao !== minha) return;
      flushSync(() => {
        cfg().modelos.push(novo);
        publicarModelos();
        selecionarModelo(novo.id);
      });
      const nome = document.getElementById("email-modelo-nome") as HTMLInputElement | null;
      nome?.focus();
      nome?.select?.();
    } catch (erro) {
      if (aberto && geracao === minha) avisar(mensagemDeErro(erro as ErroApi), "erro");
    }
  });
}

export const novoModeloEmail = () => criarModelo(null);
export const duplicarModeloEmail = () => criarModelo(modeloId);

export function excluirModeloEmail() {
  return exclusivo(async () => {
    const minha = geracao;
    if (cfg().modelos.length <= 1) {
      mostrarStatus(TEXTO.ultimoModelo, "aviso");
      return;
    }
    const modelo = cfg().modelos.find(item => item.id === modeloId) as Modelo;
    const confirmou = await app().confirmarAcao({
      titulo: "Excluir o modelo?",
      mensagem: `O modelo ${modelo.nome} será excluído deste site. Não há como desfazer.`,
      confirmar: "Excluir",
      cancelar: "Cancelar",
      destrutiva: true,
    });
    if (!confirmou || !aberto || geracao !== minha) return;
    try {
      await descartarPendente();
      await chamar(`/email/modelos/${encodeURIComponent(modelo.id)}`, { metodo: "DELETE" });
      if (!aberto || geracao !== minha) return;
      const indice = cfg().modelos.findIndex(item => item.id === modelo.id);
      cfg().modelos.splice(indice, 1);
      publicarModelos();
      selecionarModelo(cfg().modelos[Math.min(indice, cfg().modelos.length - 1)].id);
    } catch (erro) {
      if (aberto && geracao === minha) avisar(mensagemDeErro(erro as ErroApi), "erro");
    }
  });
}

export function restaurarModeloEmail() {
  return exclusivo(async () => {
    const minha = geracao;
    if (modeloId !== ID_CABO) return;
    const confirmou = await app().confirmarAcao({
      titulo: "Restaurar o padrão?",
      mensagem: "Para, Cc, Assunto, Mensagem e conta do Modelo 1 - Cabo voltam ao texto original.",
      confirmar: "Restaurar",
      cancelar: "Cancelar",
      destrutiva: true,
    });
    if (!confirmou || !aberto || geracao !== minha) return;
    try {
      await descartarPendente();
      guardarModelo(await chamar<Modelo>(`/email/modelos/${ID_CABO}/restaurar`, { metodo: "POST" }));
      if (!aberto || geracao !== minha) return;
      selecionarModelo(ID_CABO);
    } catch (erro) {
      if (aberto && geracao === minha) avisar(mensagemDeErro(erro as ErroApi), "erro");
    }
  });
}

export async function copiarTextoEmail() {
  if (!aberto || !config) return;
  const texto = textoCopiado(estado.assunto, estado.corpo, estado.nomePessoa, estado.setor);
  try {
    await app().copiarTextoParaAreaTransferencia(texto);
    app().showToast(TEXTO.copiado, "success");
  } catch (erro) {
    app().showToast((erro as Error | null | undefined)?.message || TEXTO.falha, "error");
  }
}

function executarEmail(modo: ModoEmail) {
  return exclusivo(async () => {
    const minha = geracao;
    const vigente = () => aberto && geracao === minha;
    await Promise.all(COMBOS.map(resolverCampo));
    if (!vigente()) return;
    mostrarStatus("");
    if (modo === "enviar") {
      if (temAmbiguidade()) return mostrarStatus(TEXTO.ambiguo, "aviso");
      if (!temDestinatario(lerCampo("para"))) {
        mostrarStatus(TEXTO.semPara, "erro");
        document.getElementById("email-para")?.focus();
        return;
      }
      if (marcadorPendente(lerCampo("assunto"), lerCampo("corpo"), estado.nomePessoa, estado.setor)) return mostrarStatus(TEXTO.marcador, "erro");
      const confirmou = await app().confirmarAcao({
        titulo: "Enviar o e-mail pelo Outlook?",
        mensagem: textoConfirmacaoEnvio(emailDaConta(), lerCampo("para"), lerCampo("cc")),
        confirmar: "Enviar",
        cancelar: "Cancelar",
      });
      if (!confirmou || !vigente()) return;
    }
    try {
      const resposta = await chamar<{ status?: string; aviso?: string }>("/email", {
        metodo: "POST",
        dados: {
          conta: lerCampo("conta"), para: lerCampo("para"), cc: lerCampo("cc"),
          assunto: lerCampo("assunto"), corpo: lerCampo("corpo"),
          nome: estado.nomePessoa, setor: estado.setor,
          modo, confirmado: modo === "enviar",
        },
      });
      const resultado = resultadoEmail(resposta, modo);
      avisar(resultado.texto, resultado.tipo, vigente());
    } catch (erro) {
      // Sem status HTTP a resposta se perdeu: um envio real pode ou não ter saído.
      const resultado = falhaEmail(erro as ErroApi, modo);
      avisar(resultado.texto, resultado.tipo, vigente());
    }
  });
}

export const abrirEmailNoOutlook = () => executarEmail("abrir");
export const enviarEmailPeloOutlook = () => executarEmail("enviar");
