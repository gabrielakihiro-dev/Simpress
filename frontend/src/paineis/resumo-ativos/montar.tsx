import { createRoot } from "react-dom/client";
import { CartaoRegionais } from "./cartao";
import { carregarResumoAtivos, repetirAnimacao } from "./estado";

// Chamado por frontend/src/main.tsx com a seção #resumo-ativos-secao (data-react-painel="resumo-ativos").
// carregarResumoAtivos é chamado pelo código antigo ao abrir o Resumo (cockpit-tool-panels.js), pela ponte.
export function montar(container: HTMLElement) {
  createRoot(container).render(<CartaoRegionais />);
  document.addEventListener("simpress:bento-repetir", repetirAnimacao);
  return { carregarResumoAtivos };
}
