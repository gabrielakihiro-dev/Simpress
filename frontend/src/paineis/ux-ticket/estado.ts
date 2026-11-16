// Modal "Gerar ticket no UX" (Transporte F2): prepara uma sessão no UX e depois simula ou finaliza, com confirmação.
// Envio real só com enviar: true e confirmado: true, uma vez, depois de "Finalizar ticket" (invariante do AGENTS.md).
// O pedido vigente é um objeto mutável, como no módulo antigo: "ocupado" e "enviando" travam o segundo clique na hora,
// sem esperar o React desenhar. O estado abaixo é só o que a tela mostra; mudar() recalcula os derivados do pedido.
import { flushSync } from "react-dom";
import { apiFetch, type ApiFetchError } from "../../api";
import { lerEstado } from "../../estado-app";
import {
  ATUALIZACAO, ENDERECO, cepDaEntrega, cepTemOitoDigitos, mesclarSolicitante, motivoBloqueio, preencherVazio, textoConfirmacao,
  textoUltimoEnvio, valorOuTraco, type TipoTicket,
} from "./regras-puro";

const MODAL = "modal-ticket-ux";
const API = "/api/ux/gerar-ticket";

export interface Solicitante { nome: string; email: string; telefone: string }
export type CampoSolicitante = keyof Solicitante;

interface Resumo { serie: string; modelo: string; endereco: string; cnpjInstalacao: string; cnpjFaturamento: string; anexo: string }
const RESUMO_VAZIO: Resumo = { serie: "—", modelo: "—", endereco: "—", cnpjInstalacao: "—", cnpjFaturamento: "—", anexo: "—" };

interface Dados {
  session_id: string;
  serial?: string;
  modelo?: string;
  endereco?: string;
  cnpj_instalacao?: string;
  cnpj_faturamento?: string;
  arquivo?: string;
  ultimo_envio?: { ticket?: unknown; data?: unknown } | null;
  opcoes_endereco?: string[];
  solicitante?: Partial<Solicitante>;
}

interface Envio { status: string; ticket?: unknown; mensagem?: string }

// Corpo enviado ao /preparar (payload do evento simpress:transfer-generated + CEP) ou só a série (Alterar Endereço).
type Corpo = { serial: string } & Record<string, unknown>;

interface Pedido {
  tipo: TipoTicket;
  corpo: Corpo;
  dados: Dados | null;
  session_id: string | null;
  ocupado?: boolean;
  preparando?: boolean;
  enviando?: boolean;
  falha?: boolean;
  incerto?: boolean;
  concluido?: boolean;
}

interface Derivados {
  existe: boolean; // há pedido vigente
  ocupado: boolean;
  preparando: boolean; // /preparar em andamento: Registro e solicitante continuam editáveis
  enviando: boolean;
  temSessao: boolean;
  falha: boolean;
  incerto: boolean;
  concluido: boolean;
  motivo: string; // por que Simular e Finalizar estão desabilitados
  pronto: boolean;
}

interface Estado extends Derivados {
  tipo: TipoTicket;
  estadoTitulo: string;
  estadoDetalhe: string;
  erro: string;
  resumo: Resumo;
  avisoUltimoEnvio: string;
  ambiguo: boolean; // lista de endereços do UX visível, para o usuário escolher
  opcoes: string[];
  enderecoEscolhido: string;
  registro: string;
  nome: string;
  email: string;
  telefone: string;
  chamadoInterno: string;
}

// Ações do código antigo publicadas em window por static/app.js e transfer-form.js (fora de frontend/types/globais.d.ts).
interface TextoRegistro { texto?: string; aviso?: string }
interface AppAntigo {
  showToast(mensagem: string, tipo: string): void;
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string }): Promise<boolean>;
  abrirModalAcessivel(id: string, foco: string, fechar: string): void;
  fecharModalAcessivel(id: string): void;
  montarTextoSolicitacaoTransporte?(): TextoRegistro | undefined;
  montarTextoAlterarEndereco?(): TextoRegistro | undefined;
  serialAlterarEndereco?(): string | undefined;
}
const app = () => window as unknown as AppAntigo;

let vigente: Pedido | null = null;
// Solicitante padrão, lido uma vez do servidor (nenhum e-mail corporativo em arquivo do front-end); aparece antes de o /preparar acabar.
let padrao: Solicitante | null = null;

function derivar(s: Pick<Estado, "registro" | "nome" | "email" | "telefone" | "chamadoInterno">): Derivados {
  const p = vigente;
  const ocupado = Boolean(p?.ocupado);
  const motivo = motivoBloqueio({
    existe: Boolean(p), enviando: Boolean(p?.enviando), ocupado, temSessao: Boolean(p?.session_id), concluido: Boolean(p?.concluido),
    ehEndereco: p?.tipo === ENDERECO, temEnderecoEscolhido: Boolean(p?.dados?.endereco),
    registro: s.registro, nome: s.nome, email: s.email, telefone: s.telefone, chamadoInterno: s.chamadoInterno,
  });
  return {
    existe: Boolean(p), ocupado, preparando: Boolean(p?.preparando), enviando: Boolean(p?.enviando), temSessao: Boolean(p?.session_id),
    falha: Boolean(p?.falha), incerto: Boolean(p?.incerto), concluido: Boolean(p?.concluido), motivo, pronto: !ocupado && !motivo,
  };
}

const BASE = {
  tipo: ATUALIZACAO as TipoTicket, estadoTitulo: "", estadoDetalhe: "", erro: "", resumo: RESUMO_VAZIO, avisoUltimoEnvio: "",
  ambiguo: false, opcoes: [] as string[], enderecoEscolhido: "", registro: "", nome: "", email: "", telefone: "", chamadoInterno: "",
};
let estado: Estado = { ...BASE, ...derivar(BASE) };
const ouvintes = new Set<() => void>();
// Um objeto novo a cada mudança (useSyncExternalStore compara por identidade).
function mudar(parcial: Partial<Estado>) {
  const base = { ...estado, ...parcial };
  estado = { ...base, ...derivar(base) };
  ouvintes.forEach(ouvinte => ouvinte());
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

const mensagem = (erro: unknown) => (erro instanceof Error ? erro.message : String(erro));
const statusHttp = (erro: unknown) => (erro as Partial<ApiFetchError> | null | undefined)?.status;
const codigo = (erro: unknown) => ((erro as Partial<ApiFetchError> | null | undefined)?.data as { codigo?: string } | null | undefined)?.codigo;

function post<T>(etapa: string, dados: unknown) {
  return apiFetch<T>(API + "/" + etapa, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dados), errorMessage: "Não foi possível continuar o ticket no UX.",
  });
}

// O servidor responde 409 para sessão que já acabou (enviada, expirada ou trocada): não resta nada a cancelar.
function cancelarSessao(session_id?: string | null) {
  if (session_id) void post("cancelar", { session_id }).catch(() => {});
}

const atual = (pedido: Pedido) => vigente === pedido;
const lerSolicitante = (): Solicitante => ({ nome: estado.nome.trim(), email: estado.email.trim(), telefone: estado.telefone.trim() });

function mostrarEstado(estadoTitulo: string, detalhe?: string) {
  mudar({ estadoTitulo, estadoDetalhe: detalhe ? " " + detalhe : "" });
}
const mostrarErro = (erro: string) => mudar({ erro });
const controles = () => mudar({});

export function atualizarTicketUX() {
  controles();
}

// Campos editados na tela: gravam e recalculam os botões.
export function editarRegistro(registro: string) {
  mudar({ registro });
}
export function editarSolicitante(campo: CampoSolicitante, valor: string) {
  mudar({ [campo]: valor } as Partial<Estado>);
}
export function editarChamadoInterno(chamadoInterno: string) {
  mudar({ chamadoInterno });
}
export function escolherEndereco(enderecoEscolhido: string) {
  mudar({ enderecoEscolhido });
}

function renderizarResumo(pedido: Pedido) {
  const dados = pedido.dados || ({} as Partial<Dados>);
  mudar({
    resumo: {
      serie: valorOuTraco(dados.serial || pedido.corpo.serial), modelo: valorOuTraco(dados.modelo), endereco: valorOuTraco(dados.endereco),
      cnpjInstalacao: valorOuTraco(dados.cnpj_instalacao || pedido.corpo.entrega_cnpj),
      cnpjFaturamento: valorOuTraco(dados.cnpj_faturamento), anexo: valorOuTraco(dados.arquivo),
    },
    avisoUltimoEnvio: textoUltimoEnvio(dados.ultimo_envio),
  });
}

function renderizarEnderecos(pedido: Pedido) {
  const ambiguo = pedido.tipo !== ENDERECO && Boolean(pedido.session_id) && !pedido.dados?.endereco;
  const lista = pedido.dados?.opcoes_endereco;
  // Texto exato do UX: o servidor só aceita uma opção listada. Opções novas desmarcam a escolha.
  mudar({ ambiguo, opcoes: ambiguo && Array.isArray(lista) ? lista : [], enderecoEscolhido: "" });
}

function aplicarPreparo(pedido: Pedido, dados: Dados) {
  pedido.session_id = dados.session_id;
  const completo: Dados = { ...pedido.dados, ...dados };
  pedido.dados = completo;
  pedido.falha = false;
  renderizarResumo(pedido);
  renderizarEnderecos(pedido);
  mudar({
    nome: mesclarSolicitante(estado.nome, padrao?.nome, dados.solicitante?.nome),
    email: mesclarSolicitante(estado.email, padrao?.email, dados.solicitante?.email),
    telefone: mesclarSolicitante(estado.telefone, padrao?.telefone, dados.solicitante?.telefone),
  });
  if (pedido.tipo === ENDERECO) {
    mostrarEstado("Pronto para simular ou finalizar", "No UX o formulário está em Transporte / Transferência Fisica de Equipamentos; Simular preenchimento completa o Registro e o solicitante. Nada foi enviado ao UX.");
  } else if (completo.endereco) {
    mostrarEstado("Pronto para simular ou finalizar", "No UX o formulário está preenchido até Meus Endereços; Simular preenchimento completa os CNPJs, o Registro, o anexo e o solicitante. Nada foi enviado ao UX.");
  } else if (completo.opcoes_endereco?.length) {
    mostrarEstado("Escolha o endereço", "O UX listou mais de um endereço para o CEP da unidade de entrega. Escolha o correto e confirme.");
  } else {
    pedido.falha = true;
    mostrarEstado("Escolha o endereço", "O UX não listou nenhum endereço para o CEP da unidade de entrega.");
  }
}

function falhar(pedido: Pedido, erro: unknown) {
  pedido.falha = true;
  pedido.incerto = codigo(erro) === "envio_incerto";
  mostrarEstado(pedido.incerto ? "Incerto — confira no UX" : "Erro", pedido.incerto
    ? "Confira no UX se o ticket anterior foi criado antes de preparar de novo."
    : "Corrija o que o aviso indica e use Preparar novamente.");
  mostrarErro((erro as Error | null | undefined)?.message || "Não foi possível continuar o ticket no UX.");
}

async function preparar(pedido: Pedido, conferido: boolean) {
  pedido.ocupado = true;
  pedido.preparando = true;
  pedido.falha = false;
  pedido.incerto = false;
  pedido.concluido = false; // "Conferi no UX; preparar de novo" depois de envio incerto reabre o formulário
  pedido.session_id = null;
  mostrarErro("");
  mostrarEstado("Preparando no UX…", "Pode levar alguns minutos. Fora do login, o Simpress clica em Acesso Time Simpress e escolhe a conta padrão; senha e MFA, se pedidos, são seus no Chrome de automação.");
  renderizarEnderecos(pedido);
  controles();
  try {
    const etapa = pedido.tipo === ENDERECO ? "preparar-alterar-endereco" : "preparar";
    const dados = await post<Dados>(etapa, conferido ? { ...pedido.corpo, conferido: true } : pedido.corpo);
    if (!atual(pedido)) {
      cancelarSessao(dados?.session_id); // fechado durante o preparo: não deixa a aba do UX para trás
      return;
    }
    aplicarPreparo(pedido, dados);
  } catch (erro) {
    if (atual(pedido)) falhar(pedido, erro);
  } finally {
    if (atual(pedido)) {
      pedido.ocupado = false;
      pedido.preparando = false;
      controles();
    }
  }
}

// Zera o modal para o pedido novo. "Transporte": Registro padrão = "Texto para Transporte" do F2; "Alterar Endereço":
// texto próprio; vazio sem os dois endereços. "Alterar Endereço" nunca manda o Nº de chamado interno.
function limparModal(payload: { serial?: string }, tipo: TipoTicket) {
  const texto = tipo === ENDERECO ? app().montarTextoAlterarEndereco?.() : app().montarTextoSolicitacaoTransporte?.();
  mudar({
    tipo, resumo: { ...RESUMO_VAZIO, serie: payload.serial || "—" }, avisoUltimoEnvio: "", ambiguo: false, opcoes: [], enderecoEscolhido: "",
    registro: texto?.texto || "", nome: "", email: "", telefone: "", chamadoInterno: "", erro: "",
  });
}

// Preenche só o que ainda está vazio, para não sobrescrever o que o usuário digitou; falha é silenciosa (o /preparar também devolve).
async function preencherPadrao(pedido: Pedido) {
  try {
    padrao ||= await apiFetch<Solicitante>(API + "/solicitante", { errorMessage: "Não foi possível carregar o solicitante padrão." });
  } catch {
    return;
  }
  if (!atual(pedido)) return;
  mudar({
    nome: preencherVazio(estado.nome, padrao?.nome), email: preencherVazio(estado.email, padrao?.email),
    telefone: preencherVazio(estado.telefone, padrao?.telefone),
  });
}

function encerrar() {
  if (!vigente) return;
  const encerrado = vigente;
  vigente = null;
  cancelarSessao(encerrado.session_id);
}

export async function prepararTicketUX(payload?: { serial?: string } & Record<string, unknown>, tipo: TipoTicket = ATUALIZACAO) {
  try {
    if (!payload?.serial) return;
    if (vigente?.ocupado) {
      app().showToast("Já há um ticket em preparação no UX. Aguarde o resultado ou cancele antes de gerar outro.", "warning");
      return;
    }
    encerrar();
    const unidade = (document.getElementById("select-unidade-destino") as HTMLSelectElement | null)?.value;
    const entrega_cep = tipo === ENDERECO ? "" : cepDaEntrega(lerEstado("unidadesList"), unidade);
    const corpo: Corpo = tipo === ENDERECO ? { serial: payload.serial } : { ...payload, serial: payload.serial, entrega_cep };
    const pedido: Pedido = vigente = { tipo, corpo, dados: null, session_id: null };
    // Desenha já: o modal abre com a série e o Registro deste pedido, não os do anterior.
    flushSync(() => limparModal(payload, tipo));
    app().abrirModalAcessivel(MODAL, "#ux-ticket-cancelar", "fecharTicketUX");
    void preencherPadrao(pedido);
    if (tipo === ATUALIZACAO && !cepTemOitoDigitos(entrega_cep)) {
      pedido.falha = true;
      mostrarEstado("Erro", "O ticket não foi preparado.");
      mostrarErro("A unidade de entrega não tem CEP com 8 dígitos no cadastro de unidades. Corrija o CEP da unidade e gere a planilha de novo.");
      controles();
      return;
    }
    await preparar(pedido, false);
  } catch (erro) {
    // Etapa opcional depois do download: nunca pode quebrar o fluxo do Transporte.
    console.error("Erro ao preparar o ticket no UX:", erro);
  }
}

// Botão "Alterar Endereço": só a série e os dois endereços; nunca chama /api/gerar-planilha.
export function alterarEnderecoTicketUX() {
  const serial = app().serialAlterarEndereco?.();
  const { aviso } = app().montarTextoAlterarEndereco?.() || { aviso: "Não foi possível montar o texto do Registro." };
  if (!serial || aviso) {
    app().showToast(serial ? String(aviso) : "Pesquise e selecione o equipamento antes de alterar o endereço.", "warning");
    return;
  }
  void prepararTicketUX({ serial }, ENDERECO);
}

export function fecharTicketUX() {
  if (vigente?.enviando) {
    controles(); // o motivo continua visível; fechar agora poderia esconder um ticket em envio
    return;
  }
  encerrar();
  app().fecharModalAcessivel(MODAL);
}

export function prepararNovamenteTicketUX() {
  if (vigente && !vigente.ocupado && vigente.falha && !vigente.incerto) return preparar(vigente, false);
}

export function conferirTicketUX() {
  if (vigente && !vigente.ocupado && vigente.incerto) return preparar(vigente, true);
}

export async function confirmarEnderecoTicketUX() {
  const pedido = vigente;
  const escolhido = estado.enderecoEscolhido;
  if (!pedido?.session_id || pedido.ocupado || !escolhido) return;
  pedido.ocupado = true;
  mostrarErro("");
  controles();
  try {
    const dados = await post<Dados>("escolher-endereco", { session_id: pedido.session_id, serial: pedido.dados?.serial, endereco: escolhido });
    if (!atual(pedido)) return;
    aplicarPreparo(pedido, dados); // a resposta traz só status/endereco: junta com os dados do preparo
  } catch (erro) {
    if (atual(pedido)) {
      mostrarEstado("Erro", "O endereço não foi confirmado.");
      mostrarErro(mensagem(erro));
    }
  } finally {
    if (atual(pedido)) {
      pedido.ocupado = false;
      controles();
    }
  }
}

export async function executarTicketUX(enviar: boolean) {
  const pedido = vigente;
  if (!pedido || pedido.ocupado || derivar(estado).motivo) return;
  const { session_id } = pedido;
  const serial = pedido.dados?.serial;
  const descricao = estado.registro.trim();
  const solicitante = lerSolicitante();
  const ehEndereco = pedido.tipo === ENDERECO;
  const chamado_interno = ehEndereco ? "" : estado.chamadoInterno.trim();
  pedido.ocupado = true; // antes de qualquer await: o segundo clique já encontra o pedido ocupado
  controles();
  try {
    if (enviar) {
      const confirmou = await app().confirmarAcao({
        titulo: "Finalizar ticket no UX",
        mensagem: textoConfirmacao({
          serial: String(serial ?? ""), ehEndereco, endereco: pedido.dados?.endereco ?? "", nome: solicitante.nome,
          email: solicitante.email, telefone: solicitante.telefone, chamadoInterno: chamado_interno, descricao,
        }),
        confirmar: "Finalizar ticket",
      });
      if (!confirmou || !atual(pedido)) return;
      pedido.enviando = true;
      controles();
    }
    mostrarErro("");
    mostrarEstado(enviar ? "Finalizando no UX…" : "Simulando no UX…", enviar
      ? "Não feche esta janela até o resultado."
      : "Preenchendo o formulário no Chrome de automação.");
    const dados = await post<Envio>("enviar", { session_id, serial, descricao, solicitante, chamado_interno, enviar, confirmado: enviar });
    if (!atual(pedido)) return;
    if (dados.status === "preenchido") {
      mostrarEstado("Simulado", "Confira o formulário no Chrome de automação. Nenhum ticket foi enviado.");
    } else if (dados.status === "enviado" && dados.ticket) {
      pedido.session_id = null;
      pedido.concluido = true;
      mostrarEstado("Enviado", "Ticket nº " + String(dados.ticket) + ".");
      app().showToast("Ticket enviado. Nº " + String(dados.ticket) + ".", "success");
    } else if (dados.status === "incerto") {
      pedido.session_id = null;
      pedido.concluido = true;
      pedido.incerto = true;
      mostrarEstado("Incerto — confira no UX", dados.mensagem || "Confira no UX se o ticket foi criado.");
    } else {
      throw new Error("O UX não confirmou o resultado.");
    }
  } catch (erro) {
    if (!atual(pedido)) return;
    if (enviar && !statusHttp(erro)) {
      // Sem resposta depois que o envio começou: o ticket pode ter sido criado; nunca reenviar sem conferir no UX.
      pedido.session_id = null;
      pedido.concluido = true;
      pedido.incerto = true;
      mostrarEstado("Incerto — confira no UX", "Não foi possível receber o resultado. Confira no UX se o ticket foi criado antes de tentar de novo.");
      mostrarErro(mensagem(erro));
    } else {
      falhar(pedido, erro);
      if (codigo(erro) === "envio_incerto") pedido.session_id = null;
    }
  } finally {
    if (atual(pedido)) {
      pedido.ocupado = false;
      pedido.enviando = false;
      controles();
    }
  }
}
