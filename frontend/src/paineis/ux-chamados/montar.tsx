import { createRoot } from "react-dom/client";
import { DialogoChamadoUX } from "./dialogo";
import {
  abrirChamadoUX, atualizarProblemaChamadoUX, conferirChamadoUX, contextoChamadoUX, executarChamadoUX, fecharChamadoUX,
} from "./estado";

// Chamado por frontend/src/main.tsx com o overlay #modal-chamado-ux (data-react-painel="ux-chamados").
// A aplicação chama as ações pela ponte (frontend/src/aplicacao/ux-chamados.ts).
export function montar(container: HTMLElement) {
  createRoot(container).render(<DialogoChamadoUX />);
  return { abrirChamadoUX, fecharChamadoUX, atualizarProblemaChamadoUX, conferirChamadoUX, executarChamadoUX, contextoChamadoUX };
}
