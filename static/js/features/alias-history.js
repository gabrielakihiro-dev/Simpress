/** The F7 history screen remains legacy; all record rules and actions are owned by the React panel. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).aliasHistory = factory;
})(typeof window !== "undefined" ? window : globalThis, function createAliasHistory(context) {
  "use strict";
  const ponteSinc = context.ponteReactSincrona("historico-apelidos", [
    "acoesEventoHistorico", "ultimoRegistroPorCampo",
  ]);
  const ponte = context.ponteReact("historico-apelidos", [
    "desfazerEventoHistoricoApelidos", "excluirRegistroHistorico",
  ]);
  const registrar = promessa => promessa.catch(erro => { console.error(erro); });
  const ponteRegistrada = Object.fromEntries(Object.entries(ponte).map(([nome, acao]) => [
    nome, (...argumentos) => registrar(acao(...argumentos)),
  ]));
  // Sem o painel, a F7 continua listando o histórico, só sem Restaurar/Excluir.
  return {
    acoesEventoHistorico: (...argumentos) => ponteSinc.acoesEventoHistorico(...argumentos) ?? {},
    ultimoRegistroPorCampo: (...argumentos) => ponteSinc.ultimoRegistroPorCampo(...argumentos) ?? new Map(),
    ...ponteRegistrada,
  };
});
