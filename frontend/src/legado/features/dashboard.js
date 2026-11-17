/** Home indicators: inventory statistics and the readiness panel that lists which files and functions are available. The rules and actions live in frontend/src/paineis/indicadores-home/. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).dashboard = factory;
})(typeof window !== "undefined" ? window : globalThis, function createDashboard(context) {
  "use strict";
  // app.js starts the page before react-entry.js mounts the panel, so the boot actions wait for it (ponteReact).
  const ponte = context.ponteReact("indicadores-home", [
    "carregarEstatisticas", "carregarProntidao", "inicializarProntidao",
    "inicializarAlertaBaseDesatualizada", "inicializarAlertasOsDivergencias",
  ]);
  // Same-turn actions: atualizarIndicadoresPosSalvamento is called by other panels; the renderers keep the legacy names.
  const ponteSincrona = context.ponteReactSincrona("indicadores-home", [
    "atualizarIndicadoresPosSalvamento", "renderizarAlertaBaseDesatualizada", "renderizarAlertaOsParadas",
    "renderizarAlertaDivergenciasNovas", "renderizarAlertaSemAcesso60", "renderizarAlertaChamadosOutroTecnico",
    "renderizarAlertaBackupsRegionais",
  ]);
  // Without the panel the Home keeps working, only without live indicators: the error goes to the console.
  const registrar = (nome, promessa) => promessa.catch(erro => { console.error(`${nome}: ${erro?.message}`); });
  const ponteRegistrada = Object.fromEntries(Object.entries(ponte).map(([nome, acao]) => [
    nome, (...argumentos) => registrar(nome, acao(...argumentos)),
  ]));
  // paineis-dados fires painel-atualizado on import; if react-entry.js loads later, the panel replays the last detail on init.
  let ultimoPainel;
  if (typeof document !== "undefined") document.addEventListener("simpress:painel-atualizado", evento => { ultimoPainel = evento.detail; });
  const lerUltimoPainel = () => ultimoPainel;
  return {
    ...ponteRegistrada, ...ponteSincrona,
    inicializarAlertaBaseDesatualizada: () => ponteRegistrada.inicializarAlertaBaseDesatualizada(lerUltimoPainel),
    inicializarAlertasOsDivergencias: () => ponteRegistrada.inicializarAlertasOsDivergencias(lerUltimoPainel),
  };
});
