import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { FormularioRelatorio } from "./formulario";
import { abrirRelatorioMensal, exportarRelatorioMensal, fecharRelatorioMensal } from "./estado";

// Chamado por frontend/src/main.tsx com o <form id="form-relatorio-mensal"> (data-react-painel="relatorio-mensal") do
// modal Relatório mensal. As ações são chamadas pelo código antigo pela ponte (frontend/src/aplicacao/pontes.ts).
export function montar(container: HTMLElement) {
  // flushSync: cockpit-tool-panels.js grava #relatorio-mensal-mes sem abrir o diálogo, então o campo precisa existir já.
  flushSync(() => { createRoot(container).render(<FormularioRelatorio />); });
  return { abrirRelatorioMensal, fecharRelatorioMensal, exportarRelatorioMensal };
}
