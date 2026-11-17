import { createRoot } from "react-dom/client";
import { SecaoConflitos } from "./secao";
import { assinar, carregarConflitosSebrae, ler } from "./estado";

// Chamado por frontend/src/main.tsx com a seção #sebrae-conflitos (data-react-painel="sebrae-conflitos").
// carregarConflitosSebrae é chamado pela aplicação ao carregar os novos chamados (sebrae-dashboard.js), pela ponte.
export function montar(container: HTMLElement) {
  createRoot(container).render(<SecaoConflitos />);
  // A seção nasce escondida no HTML e só aparece com conflitos; troca síncrona, fora do ciclo do React.
  assinar(() => { container.hidden = ler().conflitos.length === 0; });
  return { carregarConflitosSebrae };
}
