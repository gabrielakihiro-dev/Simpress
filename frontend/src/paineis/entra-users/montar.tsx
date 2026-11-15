import { createRoot } from "react-dom/client";
import { SecaoEntra } from "./secao";
import { carregarEstadoEntra, exportarNomesEntra, importarNomesEntra } from "./estado";

// Chamado por frontend/src/main.tsx com a seção #esc-inv-entra (data-react-painel="entra-users") do modal
// Atualizar planilhas. carregarEstadoEntra é chamado pelo código antigo na inicialização (static/app.js), pela ponte.
export function montar(container: HTMLElement) {
  createRoot(container).render(<SecaoEntra />);
  return { carregarEstadoEntra, importarNomesEntra, exportarNomesEntra };
}
