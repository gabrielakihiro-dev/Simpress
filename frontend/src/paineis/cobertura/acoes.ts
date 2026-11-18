// Ações de escrita da Cobertura. Os diálogos são sempre os do app antigo (window.confirmarAcao, #modal-confirmar-acao):
// este painel não desenha diálogo próprio e nunca gera planilha (prepararTransporte só preenche o Transporte).
import { tentarVincularDeNovo } from "../historico-transferencias/vinculo";
import { carregarCobertura, escrever, ler } from "./estado";
import * as modelo from "./modelo";
import { appAntigo, type Registro } from "./tipos";
import type { Rotas } from "../../api-tipos.gerado";

type Corpo<R extends keyof Rotas> = Rotas[R]["corpo"];

export async function reservar(acao: Registro) {
  const corpo = { ...acao.corpo, manutencao_conferida: false };
  const { dados } = ler();
  if (modelo.exigeConferenciaManutencao(dados)) {
    const confirmado = await appAntigo().confirmarAcao?.({
      titulo: "Manutenção não verificada",
      mensagem: `${dados?.manutencao?.aviso || "A fonte de manutenção não pôde ser lida."} Confirme que a máquina não está em manutenção antes de reservar.`,
      confirmar: acao.rotulo,
      destrutiva: false,
    });
    if (!confirmado) return;
    corpo.manutencao_conferida = true;
  }
  await escrever("POST /api/cobertura/reservas", { corpo }, "Reserva registrada.");
}

export async function cancelarNecessidade(demanda: Registro) {
  const ok = await appAntigo().confirmarAcao?.({
    titulo: "Cancelar necessidade",
    mensagem: `A necessidade de ${demanda.cidade} (${modelo.formatarData(demanda.data)}) será cancelada.`,
    confirmar: "Cancelar necessidade",
    cancelar: "Voltar",
  });
  if (ok) await escrever("POST /api/cobertura/demandas/{demanda_id}/cancelar", { caminho: { demanda_id: demanda.id }, corpo: { rev: demanda.rev } }, "Necessidade cancelada.");
}

export function disponibilidade(serie: string, estado: Corpo<"POST /api/cobertura/disponibilidade">["estado"], rev?: number | null, cidade?: string) {
  const corpo: Corpo<"POST /api/cobertura/disponibilidade"> = { serie, estado };
  if (cidade) corpo.cidade = cidade;
  if (rev !== undefined && rev !== null) corpo.rev = rev;
  return escrever("POST /api/cobertura/disponibilidade", { corpo }, "Disponibilidade registrada.");
}

export const renovarReserva = (reserva: Registro) =>
  escrever("POST /api/cobertura/reservas/{reserva_id}/renovar", { caminho: { reserva_id: reserva.id }, corpo: { rev: reserva.rev } }, "Reserva renovada.");

// item é a chave do kit lida do arquivo; chave desconhecida volta 422 do servidor, como antes.
export const alterarKit = (reserva: Registro, item: string, marcado: boolean) =>
  escrever("POST /api/cobertura/reservas/{reserva_id}/kit",
    { caminho: { reserva_id: reserva.id }, corpo: { item: item as Corpo<"POST /api/cobertura/reservas/{reserva_id}/kit">["item"], marcado, rev: reserva.rev } });

export const entregarSemTransporte = (reserva: Registro) =>
  escrever("POST /api/cobertura/movimentacoes", { corpo: { reserva_id: reserva.id, rev: reserva.rev, tipo: "local" } },
    "Entrega sem Transporte registrada; confirme o recebimento em Em movimento.");

export async function cancelarReserva(reserva: Registro) {
  const ok = await appAntigo().confirmarAcao?.({
    titulo: "Cancelar reserva",
    mensagem: `A reserva da série ${reserva.serie} será cancelada e a vaga volta a ficar aberta.`,
    confirmar: "Cancelar reserva",
    cancelar: "Voltar",
  });
  if (ok) await escrever("POST /api/cobertura/reservas/{reserva_id}/cancelar", { caminho: { reserva_id: reserva.id }, corpo: { rev: reserva.rev } }, "Reserva cancelada.");
}

// Só preenche o Transporte; quem gera a planilha é sempre o operador.
export async function prepararTransporte(reserva: Registro, demanda: Registro) {
  const mov = await escrever("POST /api/cobertura/movimentacoes", { corpo: { reserva_id: reserva.id, rev: reserva.rev, tipo: "transporte" } },
    "Transporte preparado: confira os dados e gere a planilha no Transporte.");
  if (!mov) return;
  await appAntigo().prepararTransporte?.({ serial: mov.serie, cidade: mov.destino_cidade, obs: demanda?.observacao || "", movimentacao: mov });
}

export function mudarEstado(mov: Registro, estado: Corpo<"POST /api/cobertura/movimentacoes/{movimentacao_id}/estado">["estado"], extra: Registro, sucesso: string) {
  return escrever("POST /api/cobertura/movimentacoes/{movimentacao_id}/estado",
    { caminho: { movimentacao_id: mov.id }, corpo: { estado, rev: mov.rev, ...extra } }, sucesso);
}

export async function cancelarMovimentacao(mov: Registro) {
  const ok = await appAntigo().confirmarAcao?.({
    titulo: "Cancelar movimentação",
    mensagem: `A movimentação da série ${mov.serie} será cancelada e a reserva volta a ficar ativa.`
      + (mov.estado === "preparada" ? "" : " A planilha de Transporte já foi gerada e continua no histórico de transferências.")
      + (mov.estado === "coletada" ? " O Transporte já coletou a máquina: confirme que ela voltou antes de cancelar, porque a série fica livre para outra demanda." : ""),
    confirmar: "Cancelar movimentação",
    cancelar: "Voltar",
  });
  if (ok) await mudarEstado(mov, "cancelada", {}, "Movimentação cancelada; reserva devolvida.");
}

export const vincularHistorico = (mov: Registro, historicoId: string) =>
  escrever("POST /api/cobertura/movimentacoes/{movimentacao_id}/vincular-historico",
    { caminho: { movimentacao_id: mov.id }, corpo: { historico_id: historicoId, rev: mov.rev } }, "Transferência vinculada.");

export const resolverDivergencia = (mov: Registro, corpo: Omit<Corpo<"POST /api/cobertura/movimentacoes/{movimentacao_id}/resolver-divergencia">, "rev">, sucesso: string) =>
  escrever("POST /api/cobertura/movimentacoes/{movimentacao_id}/resolver-divergencia",
    { caminho: { movimentacao_id: mov.id }, corpo: { ...corpo, rev: mov.rev } }, sucesso);

export async function cancelarEReabrirVaga(mov: Registro) {
  const ok = await appAntigo().confirmarAcao?.({
    titulo: "Cancelar e reabrir vaga",
    mensagem: `A movimentação da série ${mov.serie} será cancelada e a vaga volta a ficar aberta.`,
    confirmar: "Cancelar e reabrir vaga",
    cancelar: "Voltar",
  });
  if (ok) await resolverDivergencia(mov, { resolucao: "cancelar" }, "Movimentação cancelada; vaga reaberta.");
}

export const acaoDevolucao = (dev: Registro, sufixo: "reprogramar" | "receber" | "cancelar", corpo: Registro, sucesso: string) =>
  escrever(`POST /api/cobertura/devolucoes/{devolucao_id}/${sufixo}`, { caminho: { devolucao_id: dev.id }, corpo: { rev: dev.rev, ...corpo } }, sucesso);

export async function cancelarDevolucao(dev: Registro) {
  const ok = await appAntigo().confirmarAcao?.({
    titulo: "Cancelar devolução",
    mensagem: `A devolução prevista da série ${dev.serie} será cancelada.`,
    confirmar: "Cancelar devolução",
    cancelar: "Voltar",
  });
  if (ok) await acaoDevolucao(dev, "cancelar", {}, "Devolução cancelada.");
}

// Reavalia o vínculo da planilha de Transporte (../historico-transferencias/vinculo.ts) e relê a cobertura.
export async function tentarDeNovo(movimentacaoId: unknown) {
  await tentarVincularDeNovo(movimentacaoId);
  await carregarCobertura();
}
