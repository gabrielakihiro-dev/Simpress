const assert = require("node:assert/strict");
const test = require("node:test");

const criarPesquisa = require("../../static/js/features/equipment-search.js");

test("a busca encaminha as ações imediatas e assíncronas ao painel React", async () => {
  const chamadas = [];
  const criarPonte = tipo => (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
    chamadas.push({ tipo, painel, nome, argumentos });
    return tipo === "async" ? Promise.resolve(`${tipo}:${nome}`) : `${tipo}:${nome}`;
  }]));
  const acoes = criarPesquisa({
    ponteReact: criarPonte("async"),
    ponteReactSincrona: criarPonte("sync"),
  });

  assert.equal(acoes.formatarLocalAtual({ serial: "SINT-001" }), "sync:formatarLocalAtual");
  assert.equal(acoes.handleSerialInput("SINT-001"), "sync:handleSerialInput");
  assert.equal(acoes.adicionarCodigoPowerShell(), "sync:adicionarCodigoPowerShell");
  assert.equal(await acoes.buscarSerial(), "async:buscarSerial");
  assert.equal(await acoes.consultarEndpoint(), "async:consultarEndpoint");

  assert.deepEqual(chamadas.map(({ tipo, painel, nome }) => [tipo, painel, nome]), [
    ["sync", "pesquisa-equipamento", "formatarLocalAtual"],
    ["sync", "pesquisa-equipamento", "handleSerialInput"],
    ["sync", "pesquisa-equipamento", "adicionarCodigoPowerShell"],
    ["async", "pesquisa-equipamento", "buscarSerial"],
    ["async", "pesquisa-equipamento", "consultarEndpoint"],
  ]);
});
