import { createRoot } from "react-dom/client";
import { DialogoEmailOutlook } from "./dialogo";
import {
  abrirEmailNoOutlook, abrirEmailOutlook, atualizarEmailOutlook, copiarTextoEmail, duplicarModeloEmail, enviarEmailPeloOutlook,
  excluirModeloEmail, fecharEmailOutlook, novoModeloEmail, restaurarModeloEmail, trocarModeloEmail,
} from "./estado";

// Chamado por frontend/src/main.tsx com o overlay #modal-email-outlook (data-react-painel="outlook-email").
// O código antigo chama as ações pela ponte (frontend/src/legado/features/outlook-email.js).
export function montar(container: HTMLElement) {
  createRoot(container).render(<DialogoEmailOutlook />);
  return {
    abrirEmailOutlook, fecharEmailOutlook, atualizarEmailOutlook, trocarModeloEmail, novoModeloEmail, duplicarModeloEmail,
    excluirModeloEmail, restaurarModeloEmail, copiarTextoEmail, abrirEmailNoOutlook, enviarEmailPeloOutlook,
  };
}
