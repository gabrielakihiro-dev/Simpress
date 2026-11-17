import { createRoot } from "react-dom/client";
import { SecaoEntra } from "./secao";
import { carregarEstadoEntra, exportarNomesEntra, importarNomesEntra } from "./estado";

// Chamado por frontend/src/main.tsx com o <form> da seção #esc-inv-entra (data-react-painel="entra-users") do modal
// Atualizar planilhas. carregarEstadoEntra é chamado pelo código antigo na inicialização (frontend/src/legado/app.js), pela ponte.
export function montar(container: HTMLElement) {
  createRoot(container).render(<SecaoEntra />);
  container.addEventListener("submit", evento => void importarNomesEntra(evento));
  return { carregarEstadoEntra, importarNomesEntra, exportarNomesEntra };
}
