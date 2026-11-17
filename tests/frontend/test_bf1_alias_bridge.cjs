// Ponte do histórico de apelidos para as ações React, inclusive as chamadas síncronas do roteador antigo.
const assert = require("node:assert/strict");
const test = require("node:test");

const criarHistorico = require("../../static/js/features/alias-history.js");

function criarPontes() {
  const chamadas = [];
  const ponteReact = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async (...argumentos) => {
    chamadas.push({ tipo: "async", painel, nome, argumentos });
    return `async:${nome}`;
  }]));
  const ponteReactSincrona = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
    chamadas.push({ tipo: "sync", painel, nome, argumentos });
    return `sync:${nome}`;
  }]));
  return { chamadas, ponteReact, ponteReactSincrona };
}

test("o histórico encaminha cálculos síncronos e mutações assíncronas ao React", async () => {
  const pontes = criarPontes();
  const acoes = criarHistorico(pontes);
  const eventos = [{ id: "a1", serial: "AAA111", tipo: "apelido" }];
  const ultimo = new Map([["AAA111:apelido", "a1"]]);

  assert.equal(acoes.acoesEventoHistorico(eventos[0], eventos, ultimo), "sync:acoesEventoHistorico");
  assert.equal(acoes.ultimoRegistroPorCampo(eventos), "sync:ultimoRegistroPorCampo");
  assert.equal(await acoes.desfazerEventoHistoricoApelidos(eventos[0]), "async:desfazerEventoHistoricoApelidos");
  assert.equal(await acoes.excluirRegistroHistorico(eventos[0]), "async:excluirRegistroHistorico");

  assert.deepEqual(pontes.chamadas, [
    { tipo: "sync", painel: "historico-apelidos", nome: "acoesEventoHistorico", argumentos: [eventos[0], eventos, ultimo] },
    { tipo: "sync", painel: "historico-apelidos", nome: "ultimoRegistroPorCampo", argumentos: [eventos] },
    { tipo: "async", painel: "historico-apelidos", nome: "desfazerEventoHistoricoApelidos", argumentos: [eventos[0]] },
    { tipo: "async", painel: "historico-apelidos", nome: "excluirRegistroHistorico", argumentos: [eventos[0]] },
  ]);
});

test("o histórico exige a ponte síncrona, sem mascarar painel não carregado", () => {
  const falha = new Error('O painel React "historico-apelidos" não carregou.');
  const acoes = criarHistorico({
    ponteReact: () => ({}),
    ponteReactSincrona: () => ({ acoesEventoHistorico() { throw falha; }, ultimoRegistroPorCampo() { throw falha; } }),
  });
  assert.throws(() => acoes.acoesEventoHistorico({}, []), erro => erro === falha);
});

test("sem o painel React a F7 lista sem ações e a rejeição assíncrona só vai ao console", async () => {
  const falha = new Error('O painel React "historico-apelidos" não carregou.');
  const acoes = criarHistorico({
    ponteReact: (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async () => { throw falha; }])),
    ponteReactSincrona: (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => undefined])),
  });
  assert.deepEqual(acoes.acoesEventoHistorico({}, [], new Map()), {});
  assert.deepEqual(acoes.ultimoRegistroPorCampo([]), new Map());
  const original = console.error;
  const registrados = [];
  console.error = erro => registrados.push(erro);
  try {
    assert.equal(await acoes.desfazerEventoHistoricoApelidos({}), undefined);
  } finally {
    console.error = original;
  }
  assert.deepEqual(registrados, [`desfazerEventoHistoricoApelidos: ${falha.message}`]);
});
