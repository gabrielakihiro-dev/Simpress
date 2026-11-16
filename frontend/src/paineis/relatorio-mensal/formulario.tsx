import { useSyncExternalStore } from "react";
import { assinar, ler } from "./estado";

// Mesmo HTML do corpo do <form id="form-relatorio-mensal"> antigo (IDs, classes e ARIA); o cabeçalho, com o título e o
// botão Fechar, fica no partial. O <input> não é controlado (valor e max são gravados direto no DOM por estado.ts).
// O <i data-lucide> vira <svg> pelo lucide.createIcons que abrirModalAcessivel chama no diálogo; React não mexe nos
// filhos do botão depois do primeiro desenho.
export function FormularioRelatorio() {
  const { status, erro, ocupado } = useSyncExternalStore(assinar, ler);
  return (
    <>
      <div>
        <label htmlFor="relatorio-mensal-mes" className="block text-xs text-fg-subtle mb-1">Mês: <span className="required-mark" aria-hidden="true">*</span></label>
        <input type="month" id="relatorio-mensal-mes" name="mes" required min="2000-01" aria-describedby="tip-relatorio-mensal" className="w-full px-3 py-2 rounded-lg glass-input text-xs text-fg-secondary focus:outline-none" />
      </div>
      <p id="status-relatorio-mensal" role={erro ? "alert" : "status"} aria-live="polite" aria-atomic="true" data-state={erro === null ? undefined : erro ? "error" : ""}>{status}</p>
      <button id="btn-exportar-relatorio-mensal" type="submit" className="readiness-import" disabled={ocupado} aria-busy={ocupado || undefined}>
        <i data-lucide="download" className="w-4 h-4" aria-hidden="true"></i>
        <span>Exportar relatório</span>
      </button>
    </>
  );
}
