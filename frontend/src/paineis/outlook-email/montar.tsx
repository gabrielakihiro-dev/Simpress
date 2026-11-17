import { createRoot } from "react-dom/client";
import { DialogoEmailOutlook } from "./dialogo";
import {
  abrirEmailNoOutlook, abrirEmailOutlook, atualizarEmailOutlook, copiarTextoEmail, duplicarModeloEmail, enviarEmailPeloOutlook,
  excluirModeloEmail, fecharEmailOutlook, novoModeloEmail, restaurarModeloEmail, trocarModeloEmail,
} from "./estado";

// Chamado por frontend/src/main.tsx com o overlay #modal-email-outlook (data-react-painel="outlook-email").
// A aplicação chama as ações pela ponte (frontend/src/aplicacao/pontes.ts).
export function montar(container: HTMLElement) {
  createRoot(container).render(<DialogoEmailOutlook />);
  return {
    abrirEmailOutlook, fecharEmailOutlook, atualizarEmailOutlook, trocarModeloEmail, novoModeloEmail, duplicarModeloEmail,
    excluirModeloEmail, restaurarModeloEmail, copiarTextoEmail, abrirEmailNoOutlook, enviarEmailPeloOutlook,
  };
}
