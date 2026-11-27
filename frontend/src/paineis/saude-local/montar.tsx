import { createRoot } from "react-dom/client";
import {
  abrirSaudeLocal, atualizarSaudeLocal, baixarDiagnosticoSaudeLocal, fecharSaudeLocal, limparSaudeLocal, previaLimpezaSaudeLocal,
} from "./acoes";
import { CorpoSaudeLocal } from "./corpo";

export function montar(container: HTMLElement) {
  createRoot(container).render(<CorpoSaudeLocal />);
  return {
    abrirSaudeLocal, fecharSaudeLocal, atualizarSaudeLocal, previaLimpezaSaudeLocal, limparSaudeLocal, baixarDiagnosticoSaudeLocal,
  };
}
