// Modal "Abrir chamado no UX" (Home): prepara uma sessão no UX e depois simula ou envia, com confirmação.
// Envio real só com enviar: true e confirmado: true, depois de "Enviar solicitação" (invariante do AGENTS.md).
// O pedido vigente é um objeto mutável, como no módulo antigo: "ocupado" trava o segundo clique na hora, sem
// esperar o React desenhar. O estado abaixo é só o que a tela mostra.
import { flushSync } from "react-dom";
import { apiFetch, type ApiFetchError } from "../../api";
import { lerEstado } from "../../estado-app";

const MODAL = "modal-chamado-ux";
const API = "/api/ux/abrir-chamado";

export interface Solicitante { nome: string; email: string; telefone: string; departamento_cargo: string }
const SEM_SOLICITANTE: Solicitante = { nome: "", email: "", telefone: "", departamento_cargo: "" };

interface Pedido {
  serial: string;
  descricao: string;
  revisao: number;
  session_id?: string | null;
  ocupado?: boolean;
  falha?: boolean;
}

interface Estado {
  serie: string;
  modelo: string;
  descricao: string;
  opcoes: string[]; // sem "" na frente: a tela acrescenta "Escolha um problema" quando há opções
  problema: string;
  solicitante: Solicitante;
  status: string;
  conferido: boolean; // botão "Conferi no UX; preparar de novo" visível
  ocupado: boolean;
  preparado: boolean;
  pronto: boolean; // libera Simular e Revisar e enviar
  motivo: string; // por que os dois botões estão desabilitados
}

// Ações do código antigo publicadas em window por static/app.js (fora de frontend/types/globais.d.ts).
interface AppAntigo {
  showToast(mensagem: string, tipo: string): void;
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string }): Promise<boolean>;
  abrirModalAcessivel(id: string, foco: string, fechar: string): void;
  fecharModalAcessivel(id: string): void;
}
const app = () => window as unknown as AppAntigo;

let estado: Estado = {
  serie: "", modelo: "", descricao: "", opcoes: [], problema: "", solicitante: SEM_SOLICITANTE,
  status: "", conferido: false, ocupado: false, preparado: false, pronto: false, motivo: "",
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

let vigente: Pedido | null = null;

const mensagem = (erro: unknown) => (erro instanceof Error ? erro.message : String(erro));
// Solicitante mostrado no modal (editável antes de Simular/Revisar e enviar); campo vazio bloqueia as duas ações.
const lerSolicitante = (): Solicitante => ({
  nome: estado.solicitante.nome.trim(), email: estado.solicitante.email.trim(),
  telefone: estado.solicitante.telefone.trim(), departamento_cargo: estado.solicitante.departamento_cargo.trim(),
});
const solicitanteCompleto = () => Object.values(lerSolicitante()).every(Boolean);

// Lido sem await pelo Assistente (assistant-chat.js) pela ponte: tem de continuar síncrono.
export function contextoChamadoUX() {
  const atualEquipamento = lerEstado("currentEquipamento") as { serial?: unknown } | null;
  const serial = String(atualEquipamento?.serial || "").trim().toUpperCase();
  const [campo] = JSON.parse(document.getElementById("btn-copiar-chamado-atual")?.dataset.args || "[]") as string[];
  const texto = campo ? document.getElementById(campo) as HTMLTextAreaElement | null : null;
  return { serial, descricao: texto?.value.trim() || "", revisao: lerEstado("equipamentoSelectionRevision") };
}

function post<T>(etapa: string, dados: unknown) {
  return apiFetch<T>(API + "/" + etapa, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dados), errorMessage: "Não foi possível continuar o chamado no UX.",
  });
}

function cancelarSessaoUX(session_id?: string | null) {
  if (session_id) void post("cancelar", { session_id }).catch(() => {});
}

export function fecharChamadoUX() {
  if (!vigente) return;
  const encerrado = vigente;
  vigente = null;
  cancelarSessaoUX(encerrado.session_id);
  mudar({ descricao: "" });
  app().fecharModalAcessivel(MODAL);
}

function atual(pedido: Pedido) {
  return vigente === pedido && lerEstado("equipamentoSelectionRevision") === pedido.revisao;
}

function controles(ocupado: boolean) {
  const preparado = !!vigente?.session_id;
  const pronto = !ocupado && preparado && !!estado.problema && solicitanteCompleto();
  // O motivo fica visível (e ligado por aria-describedby) enquanto as duas ações estão desabilitadas.
  const motivo = ocupado || pronto ? "" : preparado
    ? (solicitanteCompleto()
      ? "Escolha um problema para liberar a simulação e o envio."
      : "Preencha todos os campos do solicitante para liberar a simulação e o envio.")
    : vigente?.falha
      ? "Simulação e envio indisponíveis: a preparação no UX não foi concluída. A descrição foi mantida; corrija o que a mensagem acima indica e abra o chamado de novo."
      : "Simulação e envio indisponíveis: esta sessão do UX já foi usada. Abra o chamado de novo se precisar.";
  mudar({ ocupado, preparado, pronto, motivo });
}

export function atualizarProblemaChamadoUX() {
  controles(Boolean(vigente?.ocupado));
}

// Campos editados na tela (select e solicitante): grava e recalcula os botões.
export function editarProblema(problema: string) {
  mudar({ problema });
  atualizarProblemaChamadoUX();
}
export function editarSolicitante(campo: keyof Solicitante, valor: string) {
  mudar({ solicitante: { ...estado.solicitante, [campo]: valor } });
  atualizarProblemaChamadoUX();
}

interface Preparado {
  serial: string;
  session_id: string;
  opcoes: string[];
  modelo: string;
  solicitante?: Partial<Solicitante>;
  ultimo_envio?: { os: string } | null;
}

async function preparar(pedido: Pedido, conferido: boolean) {
  pedido.falha = false;
  mudar({ conferido: false, status: "Preparando no UX… Se o Chrome de automação pedir login, entre manualmente." });
  pedido.ocupado = true;
  controles(true);
  let focar = false;
  try {
    const dados = await post<Preparado>("preparar", { serial: pedido.serial, conferido });
    if (!atual(pedido) || dados.serial !== pedido.serial) {
      cancelarSessaoUX(dados.session_id);
      return;
    }
    pedido.session_id = dados.session_id;
    const solicitante = dados.solicitante || {};
    mudar({
      opcoes: dados.opcoes, problema: "", modelo: dados.modelo,
      solicitante: {
        nome: solicitante.nome || "", email: solicitante.email || "",
        telefone: solicitante.telefone || "", departamento_cargo: solicitante.departamento_cargo || "",
      },
      status: dados.ultimo_envio
        ? "Atenção: já há um chamado enviado para esta série (OS " + dados.ultimo_envio.os + "). Confira antes de prosseguir."
        : "Escolha um problema para simular ou enviar.",
    });
    focar = true;
  } catch (erro) {
    if (!atual(pedido)) return;
    pedido.falha = true;
    const codigo = ((erro as ApiFetchError).data as { codigo?: string } | null | undefined)?.codigo;
    mudar({ status: mensagem(erro), conferido: codigo === "envio_incerto" });
  } finally {
    if (atual(pedido)) {
      pedido.ocupado = false;
      // Desenha já, para o seletor estar habilitado quando receber o foco.
      flushSync(() => controles(false));
      if (focar) document.getElementById("ux-chamado-problema")?.focus();
    }
  }
}

export function abrirChamadoUX() {
  const contexto = contextoChamadoUX();
  if (!contexto.serial) return;
  // Mesmo padrão de PLACEHOLDER em domains/ux_chamados.py: mantenha os dois iguais.
  if (!contexto.descricao || /\[[^\]\n]*\]|:[ \t]*$/m.test(contexto.descricao)) {
    app().showToast("Preencha a descrição e substitua os campos em branco ou entre colchetes.", "warning");
    return;
  }
  fecharChamadoUX();
  const pedido: Pedido = vigente = contexto;
  // Desenha já: o modal abre com a série e a descrição deste pedido, não as do anterior.
  flushSync(() => mudar({ serie: pedido.serial, modelo: "—", descricao: pedido.descricao, opcoes: [], problema: "", solicitante: SEM_SOLICITANTE }));
  app().abrirModalAcessivel(MODAL, "#ux-chamado-fechar", "fecharChamadoUX");
  return preparar(pedido, false);
}

export function conferirChamadoUX() {
  if (vigente && !vigente.ocupado && !vigente.session_id && estado.conferido) {
    return preparar(vigente, true);
  }
}

interface Envio { status: string; os?: string; faltando?: unknown; mensagem?: string }

export async function executarChamadoUX(enviar: boolean) {
  const pedido = vigente;
  const problema = estado.problema;
  if (!pedido?.session_id || pedido.ocupado || !problema || !atual(pedido)) return;
  const { session_id, serial, descricao } = pedido;
  const solicitante = lerSolicitante();
  if (!solicitanteCompleto()) return;
  pedido.ocupado = true;
  controles(true);
  try {
    if (enviar) {
      const confirmou = await app().confirmarAcao({
        titulo: "Confirmar chamado no UX",
        mensagem: "Série: " + serial + "\nProblema: " + problema + "\nSolicitante: " + solicitante.nome + " · "
          + solicitante.email + " · " + solicitante.telefone + " · " + solicitante.departamento_cargo + "\n\n" + descricao,
        confirmar: "Enviar solicitação",
      });
      if (!confirmou || !atual(pedido)) return;
    }
    mudar({ status: enviar ? "Enviando a solicitação ao UX…" : "Preenchendo o formulário no Chrome de automação…" });
    const dados = await post<Envio>("enviar", { session_id, serial, problema, descricao, solicitante, enviar, confirmado: enviar });
    if (!atual(pedido)) return;
    if (dados.status === "preenchido") {
      const faltando = Array.isArray(dados.faltando) ? dados.faltando : [];
      mudar({ status: "Simulação concluída. Confira o formulário no Chrome de automação. Nenhuma solicitação foi enviada."
        + (faltando.length ? " Faltam no formulário: " + faltando.join(", ") + ". Preencha no Chrome de automação antes de enviar." : "") });
    } else if (dados.status === "enviado" && dados.os) {
      pedido.session_id = null;
      const texto = "Chamado enviado. OS #" + dados.os + ".";
      mudar({ status: texto });
      app().showToast(texto, "success");
    } else if (dados.status === "incerto") {
      pedido.session_id = null;
      mudar({ status: dados.mensagem || "", conferido: true });
    } else {
      throw new Error("O UX não confirmou o resultado.");
    }
  } catch (erro) {
    if (!atual(pedido)) return;
    if (enviar && !(erro as ApiFetchError).status) {
      // Sem resposta do servidor: o envio pode ter acontecido; nunca reenviar sem conferir no UX.
      pedido.session_id = null;
      mudar({ status: "Não foi possível receber o resultado. Confira no UX se a solicitação foi criada antes de tentar novamente.", conferido: true });
    } else {
      mudar({ status: mensagem(erro) });
      app().showToast(mensagem(erro), "error"); // só a linha de status passava despercebida
    }
  } finally {
    if (atual(pedido)) {
      pedido.ocupado = false;
      controles(false);
    }
  }
}
