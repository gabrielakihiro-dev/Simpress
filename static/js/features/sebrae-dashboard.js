// Automação -> "Chamados novos do SoftExpert": ações migradas para frontend/src/paineis/sebrae-dashboard/.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).sebraeDashboard = factory;
})(typeof window !== "undefined" ? window : globalThis, function createSebraeDashboard(context) {
  "use strict";

  // mostrarChamadoSebrae devolve o cartão no mesmo turno (cockpit-chamados.js abre a linha e espera a animação): não pode esperar o boot do React.
  const ponteSincrona = context.ponteReactSincrona("sebrae-dashboard", ["mostrarChamadoSebrae"]);
  const ponte = context.ponteReact("sebrae-dashboard", [
    "carregarNovosSebrae", "lerAntigosSebrae", "importarDashboardSebrae", "atualizarDashboardSebrae",
    "descartarRascunhoSebrae", "cartaoChamadoSebraeLeitura",
  ]);

  const registrar = promessa => promessa.catch(erro => { console.error(erro); });
  const ponteRegistrada = Object.fromEntries(Object.entries(ponte).map(([nome, acao]) => [
    nome, (...argumentos) => registrar(acao(...argumentos)),
  ]));
  return { ...ponteSincrona, ...ponteRegistrada };
});
