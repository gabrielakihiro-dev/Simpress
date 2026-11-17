// Configuração local (Prontidão da base): ponte para o painel React em frontend/src/paineis/configuracao-local/.
// Contrato da API e regras: docs/cockpit-prompts/19-configuracao-local.md.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).configuracaoLocal = factory;
})(typeof window !== "undefined" ? window : globalThis, function createConfiguracaoLocal(context) {
  "use strict";

  const NOMES = [
    "abrirConfiguracaoLocal", "fecharConfiguracaoLocal",
    "salvarContasConfiguracaoLocal", "salvarLinksConfiguracaoLocal",
    "salvarClienteConfiguracaoLocal", "salvarAssistenteConfiguracaoLocal",
    "removerChaveAssistenteConfiguracaoLocal",
  ];
  const ponte = context.ponteReact("configuracao-local", NOMES);
  // Os data-on-* chamam sem esperar: a falha do bundle vira console.error, nunca rejeição solta.
  return Object.fromEntries(NOMES.map(nome => [nome, (...args) => ponte[nome](...args).catch(erro => { console.error(`${nome}: ${erro?.message}`); })]));
});
