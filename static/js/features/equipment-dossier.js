/**
 * Home "Dossiê do equipamento": read-only dialog with the OS and tickets of the selected series (GET /api/equipamento/{série}/dossie).
 * Since the React migration (Dia 2, G3) the dialog lives in frontend/src/paineis/dossie-equipamento/; this module is only the
 * bridge that keeps the old action names on window (data-on-click, definirEquipamentoAtual, the accessible dialog's Esc).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).equipmentDossier = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentDossier(context) {
  "use strict";
  const ponte = context.ponteReact("dossie-equipamento", [
    "abrirDossieEquipamento", "fecharDossieEquipamento", "atualizarDossieEquipamento",
  ]);
  // Callers ignore the promise: a React panel that did not load is logged, never an unhandled rejection.
  const registrar = promessa => promessa.catch(erro => { console.error(erro); });

  // Called by definirEquipamentoAtual. The "Ver dossiê" button is outside the dialog and stays in sync right away.
  function atualizarDossieEquipamento(equipamento) {
    const botao = document.getElementById("btn-ver-dossie");
    if (botao) botao.disabled = !String(equipamento?.serial ?? "").trim();
    void registrar(ponte.atualizarDossieEquipamento(equipamento));
  }

  function abrirDossieEquipamento() {
    return registrar(ponte.abrirDossieEquipamento());
  }

  function fecharDossieEquipamento() {
    return registrar(ponte.fecharDossieEquipamento());
  }

  return { abrirDossieEquipamento, fecharDossieEquipamento, atualizarDossieEquipamento };
});
