/**
 * Resumo (F3), sub-aba Backups: migrada para React em frontend/src/paineis/backups-regionais/
 * (painel #resumo-painel-backups, data-react-painel="backups-regionais"). Aqui só fica o pedido do painel a cada
 * 5 min: ele atualiza todos os alertas do sino, não só Backups, e não pode depender do bundle React carregar.
 * Ninguém de fora chama este módulo; ele continua em FEATURE_ORDER (static/app.js).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).backupsRegionais = factory;
})(typeof window !== "undefined" ? window : globalThis, function createBackupsRegionais() {
  "use strict";
  const INTERVALO_ATUALIZACAO_MS = 5 * 60 * 1000;

  // Cartão do sino e sub-aba ficam em dia sem ação do usuário: pede o painel a cada 5 min, só com a aba visível
  // (importações e abrir o sino já pedem atualização por conta própria).
  if (typeof window !== "undefined" && typeof window.setInterval === "function") {
    window.setInterval(() => {
      if (!document.hidden) document.dispatchEvent(new CustomEvent("simpress:atualizar-notificacoes"));
    }, INTERVALO_ATUALIZACAO_MS);
  }

  return {};
});
