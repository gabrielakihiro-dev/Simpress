// A tela F7 vive em frontend/src/paineis/ferramentas-cockpit/ (BF4). Este painel assume só as regras e ações dos registros.
import { apiFetch } from "../../api";
import { lerEstado } from "../../estado-app";
import { acoesEventoHistorico, type EventoHistorico } from "./historico-apelidos-puro";

interface EventoCompleto extends EventoHistorico {
  apelido_anterior?: string;
  usuario_anterior?: string;
}

interface Equipamento extends Record<string, unknown> {
  serial?: string;
  apelido?: string;
}

interface BotaoAcao {
  disabled: boolean;
  textContent: string | null;
}

interface Confirmacao {
  titulo: string;
  mensagem: string;
  confirmar: string;
  destrutiva?: boolean;
}

interface AppAntigo {
  confirmarAcao(opcoes: Confirmacao): Promise<boolean> | boolean;
  definirEquipamentoAtual(equipamento: Equipamento): void;
  formatarLocalAtual(equipamento: Equipamento): string;
  atualizarUsuarioLogadoCard?(equipamento: Equipamento): void;
  carregarEstatisticas(): Promise<unknown> | unknown;
  showToast(mensagem: string, tipo: string): void;
}

const app = window as unknown as AppAntigo;

function textoDeErro(erro: unknown, padrao: string): string {
  return erro instanceof Error ? erro.message : padrao;
}

function lerEquipamento(valor: unknown): Equipamento | null {
  if (!valor || typeof valor !== "object") return null;
  const equipamento = valor as Equipamento;
  return typeof equipamento.serial === "string" ? equipamento : null;
}

function atualizarCartao(equipamento: Equipamento | null): void {
  const selecionado = lerEquipamento(lerEstado("currentEquipamento"));
  if (!equipamento || selecionado?.serial !== equipamento.serial) return;
  app.definirEquipamentoAtual(equipamento);
  document.getElementById("badge-apelido")!.textContent = equipamento.apelido || "Sem Apelido";
  app.atualizarUsuarioLogadoCard?.(equipamento);
  document.getElementById("card-localizacao")!.textContent = app.formatarLocalAtual(equipamento);
  document.getElementById("card-cnpj-atual")!.textContent = `CNPJ: ${equipamento.retirada_cnpj || "Não especificado"}`;
}

async function desfazerAlteracaoApelido(evento: EventoCompleto, botao: BotaoAcao): Promise<boolean> {
  const ehUsuario = evento.tipo === "usuario";
  const anterior = (ehUsuario ? evento.usuario_anterior : evento.apelido_anterior) || "(vazio)";
  if (!(await app.confirmarAcao({
    titulo: "Desfazer alteração?",
    mensagem: `Desfazer a alteração da série ${evento.serial} e restaurar ${ehUsuario ? "o usuário" : "o apelido"} ${anterior}?`,
    confirmar: "Desfazer",
    destrutiva: false,
  }))) return false;

  const textoOriginal = botao.textContent || "";
  botao.disabled = true;
  botao.textContent = "Desfazendo...";
  try {
    const data = await apiFetch<Record<string, unknown>>("/api/equipamento/apelido/desfazer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evento_id: evento.id }),
      errorMessage: "Não foi possível desfazer a alteração.",
    });
    atualizarCartao(lerEquipamento(data.equipamento));
    await app.carregarEstatisticas();
    app.showToast(ehUsuario
      ? "Usuário restaurado. A reversão foi registrada no histórico."
      : "Apelido restaurado. A reversão foi registrada no histórico.", "success");
    return true;
  } catch (erro) {
    console.error("Erro ao desfazer alteração de apelido:", erro);
    app.showToast(textoDeErro(erro, "Não foi possível desfazer a alteração."), "error");
    botao.disabled = false;
    botao.textContent = textoOriginal;
    return false;
  }
}

export async function desfazerEventoHistoricoApelidos(evento: EventoCompleto, botao: BotaoAcao): Promise<boolean> {
  const tipo = evento?.tipo || "apelido";
  if (tipo !== "apelido" && tipo !== "usuario") {
    app.showToast("Este tipo de registro não pode ser restaurado por aqui.", "warning");
    return false;
  }
  const data = await apiFetch<{ eventos?: EventoCompleto[] }>("/api/historico-alteracoes", {
    errorMessage: "Não foi possível carregar o histórico.",
  });
  const eventos = Array.isArray(data.eventos) ? data.eventos : [];
  const atual = eventos.find(item => item.id === evento.id);
  if (!atual || !acoesEventoHistorico(atual, eventos).desfazer) {
    app.showToast("Só o registro mais recente desse campo pode ser restaurado. Atualize o histórico.", "warning");
    return false;
  }
  return desfazerAlteracaoApelido(atual, botao);
}

export async function excluirRegistroHistorico(evento: EventoCompleto, botao: BotaoAcao): Promise<boolean> {
  if (!(await app.confirmarAcao({
    titulo: "Excluir registro?",
    mensagem: "Tem certeza de que deseja excluir esse registro? Essa ação não poderá ser desfeita.",
    confirmar: "Excluir",
  }))) return false;

  const textoOriginal = botao.textContent || "";
  botao.disabled = true;
  botao.textContent = "Excluindo...";
  try {
    const data = await apiFetch<Record<string, unknown>>(
      `/api/historico-alteracoes/${encodeURIComponent(evento.id)}`,
      { method: "DELETE", errorMessage: "Não foi possível excluir o registro." },
    );
    atualizarCartao(lerEquipamento(data.equipamento));
    const mensagens: Record<string, string> = {
      endereco: "Endereço anterior restaurado e salvo; registro removido do histórico.",
      usuario: "Usuário anterior restaurado e salvo; registro removido do histórico.",
      aviso_endpoint: "Aviso removido do histórico.",
    };
    const tipo = typeof data.tipo === "string" ? data.tipo : "";
    app.showToast(mensagens[tipo] || "Apelido anterior restaurado e salvo; registro removido do histórico.", "success");
    return true;
  } catch (erro) {
    console.error("Erro ao excluir registro do histórico:", erro);
    app.showToast(textoDeErro(erro, "Não foi possível excluir o registro."), "error");
    botao.disabled = false;
    botao.textContent = textoOriginal;
    return false;
  }
}
