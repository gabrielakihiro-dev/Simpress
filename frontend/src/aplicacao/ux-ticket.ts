/**
 * Transporte (F2): depois de "Transporte" (planilha) ou "Alterar Endereço" (série + endereços), prepara o "Gerar ticket"
 * do UX e simula ou confirma o envio.
 * Migrado para React no Dia 3 (G7): o modal vive em frontend/src/paineis/ux-ticket/.
 * Este módulo é só a ponte que mantém as ações publicadas para o código antigo e o evento que abre o ticket.
 */
import { registrarRejeicoes } from "./pontes.ts";
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export function createUxTicket(context: ContextoApp): Acoes {
  const ponte = context.ponteReact("ux-ticket", [
    "fecharTicketUX", "atualizarTicketUX", "prepararNovamenteTicketUX", "conferirTicketUX", "confirmarEnderecoTicketUX",
    "executarTicketUX", "alterarEnderecoTicketUX", "prepararTicketUX",
  ]);

  // Quem chama (data-on-*, fechar do modal) não trata erro: como no módulo antigo, nunca rejeita.
  const { prepararTicketUX, ...acoes } = registrarRejeicoes(ponte);

  // O listener fica aqui, síncrono, e engole tudo: o download e os outros ouvintes nunca dependem do ticket.
  // O React só abre o modal quando o bundle estiver pronto (a ponte espera); o evento não se perde.
  document.addEventListener("simpress:transfer-generated", (event: Qualquer) => {
    try {
      prepararTicketUX(event?.detail?.payload);
    } catch (erro: Qualquer) {
      console.error(`Erro ao preparar o ticket no UX: ${erro?.message}`);
    }
  });

  return acoes;
}
