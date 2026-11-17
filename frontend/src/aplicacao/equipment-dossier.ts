/**
 * Home "Dossiê do equipamento": read-only dialog with the OS and tickets of the selected series (GET /api/equipamento/{série}/dossie).
 * Since the React migration (Dia 2, G3) the dialog lives in frontend/src/paineis/dossie-equipamento/; this module is only the
 * bridge that keeps the old action names on window (data-on-click, definirEquipamentoAtual, the accessible dialog's Esc).
 */
import { registrar } from "./pontes.ts";
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export function createEquipmentDossier(context: ContextoApp): Acoes {
  const ponte = context.ponteReact("dossie-equipamento", [
    "abrirDossieEquipamento", "fecharDossieEquipamento", "atualizarDossieEquipamento",
  ]);
  // Callers ignore the promise: a React panel that did not load is logged, never an unhandled rejection.

  // Called by definirEquipamentoAtual. The "Ver dossiê" button is outside the dialog and stays in sync right away.
  function atualizarDossieEquipamento(equipamento: Qualquer) {
    const botao = document.getElementById("btn-ver-dossie") as HTMLButtonElement | null;
    if (botao) botao.disabled = !String(equipamento?.serial ?? "").trim();
    void registrar("atualizarDossieEquipamento", ponte.atualizarDossieEquipamento(equipamento));
  }

  function abrirDossieEquipamento() {
    return registrar("abrirDossieEquipamento", ponte.abrirDossieEquipamento());
  }

  function fecharDossieEquipamento() {
    return registrar("fecharDossieEquipamento", ponte.fecharDossieEquipamento());
  }

  return { abrirDossieEquipamento, fecharDossieEquipamento, atualizarDossieEquipamento };
}
