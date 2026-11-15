import { createRoot } from "react-dom/client";
import { aoAtualizar, carregarCobertura } from "./estado";
import { PainelCobertura } from "./painel";

export function montar(container: HTMLElement) {
  createRoot(container).render(<PainelCobertura />);
  document.addEventListener("simpress:cobertura-atualizada", aoAtualizar);
  return { carregarCobertura };
}
