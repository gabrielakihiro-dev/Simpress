/**
 * Resumo (F3), sub-aba Backups: migrada para React em frontend/src/paineis/backups-regionais/
 * (painel #resumo-painel-backups, data-react-painel="backups-regionais"). Fica vazio para manter a
 * ordem de FEATURE_ORDER em static/app.js; ninguém de fora chama este módulo.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).backupsRegionais = factory;
})(typeof window !== "undefined" ? window : globalThis, function createBackupsRegionais() {
  "use strict";
  return {};
});
