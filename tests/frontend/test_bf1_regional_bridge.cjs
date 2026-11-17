const assert = require("node:assert/strict");
const test = require("node:test");

const criarContatosRegionais = require("../../frontend/src/legado/features/regional-contacts.js");

test("encaminha ações síncronas e assíncronas do legado para o painel React", async () => {
  const chamadas = [];
  const criarPonte = tipo => (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
    chamadas.push({ tipo, painel, nome, argumentos });
    return tipo === "async" ? Promise.resolve(nome) : nome;
  }]));
  const acoes = criarContatosRegionais({
    ponteReact: criarPonte("async"),
    ponteReactSincrona: criarPonte("sync"),
  });

  assert.equal(acoes.formatarTelefoneBrasileiro("(41) 90000-0000"), "formatarTelefoneBrasileiro");
  assert.equal(acoes.preencherRepresentanteRegional("entrega", "Londrina", true), "preencherRepresentanteRegional");
  assert.equal(await acoes.carregarRepresentantesRegionais(), "carregarRepresentantesRegionais");
  assert.equal(await acoes.salvarConfiguracaoContatoOrigem(), "salvarConfiguracaoContatoOrigem");

  assert.deepEqual(chamadas.map(({ tipo, painel, nome }) => [tipo, painel, nome]), [
    ["sync", "contatos-regionais", "formatarTelefoneBrasileiro"],
    ["sync", "contatos-regionais", "preencherRepresentanteRegional"],
    ["async", "contatos-regionais", "carregarRepresentantesRegionais"],
    ["async", "contatos-regionais", "salvarConfiguracaoContatoOrigem"],
  ]);
});
