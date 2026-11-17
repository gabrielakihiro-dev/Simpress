import { paineisDados } from "./paineis.ts";

// Painéis de dados do Cockpit (densidade, ordenação, tabela de OS, selo e central de notificações): sem JSX, só instala os
// ouvintes de documento que o data-panels.js antigo (removido) instalava ao ser importado. O container oculto existe só para o main.tsx.
export function montar(_container: HTMLElement) {
  paineisDados.install(window);
  return {};
}
