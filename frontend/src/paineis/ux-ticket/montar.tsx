import { createRoot } from "react-dom/client";
import { DialogoTicketUX } from "./dialogo";
import {
  alterarEnderecoTicketUX, atualizarTicketUX, conferirTicketUX, confirmarEnderecoTicketUX, executarTicketUX, fecharTicketUX,
  prepararNovamenteTicketUX, prepararTicketUX,
} from "./estado";

// Chamado por frontend/src/main.tsx com o overlay #modal-ticket-ux (data-react-painel="ux-ticket").
// O código antigo chama as ações pela ponte (frontend/src/legado/features/ux-ticket.js).
export function montar(container: HTMLElement) {
  createRoot(container).render(<DialogoTicketUX />);
  return {
    fecharTicketUX, atualizarTicketUX, prepararNovamenteTicketUX, conferirTicketUX, confirmarEnderecoTicketUX, executarTicketUX,
    alterarEnderecoTicketUX, prepararTicketUX,
  };
}
