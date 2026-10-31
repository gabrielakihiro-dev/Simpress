const test = require("node:test");
const assert = require("node:assert/strict");
const createSebraeHistorico = require("../../static/js/features/sebrae-historico.js");

const { rotuloTipo, resumoEntrada, textoRepeticoes, ultimasEntradas } = createSebraeHistorico.puro;

const importacao = (extra = {}) => ({
  id: "a", tipo: "importacao", inicial: false, total: 10, n_adicionados: 0, n_removidos: 0, n_alterados: 0, repeticoes: 0, ...extra,
});
const busca = (extra = {}) => ({ id: "b", tipo: "busca", n_lidos: 0, ignorados: 0, n_pendentes: 0, n_erros: 0, ...extra });

test("rótulos do tipo usam os termos aprovados", () => {
  assert.equal(rotuloTipo("importacao"), "Importação");
  assert.equal(rotuloTipo("busca"), "Busca");
  assert.equal(rotuloTipo("outro"), "Outro");
});

test("resume a primeira importação e as mudanças com singular e plural", () => {
  assert.equal(resumoEntrada(importacao({ inicial: true, total: 1 })), "Primeira importação: 1 chamado");
  assert.equal(resumoEntrada(importacao({ inicial: true, total: 120 })), "Primeira importação: 120 chamados");
  assert.equal(
    resumoEntrada(importacao({ n_adicionados: 1, n_removidos: 2, n_alterados: 3 })),
    "1 adicionado, 2 removidos, 3 com status alterado",
  );
  assert.equal(resumoEntrada(importacao({ n_alterados: 1 })), "1 com status alterado");
  assert.equal(resumoEntrada(importacao()), "Sem mudanças");
});

test("resume a busca com lidos, ignorados, pendentes e erros", () => {
  assert.equal(resumoEntrada(busca({ n_lidos: 2, ignorados: 5, n_pendentes: 1, n_erros: 1 })), "2 lidos, 5 já no Dashboard, 1 pendente, 1 com erro");
  assert.equal(resumoEntrada(busca()), "Nenhum chamado novo");
});

test("reimportado só aparece depois de uma repetição", () => {
  assert.equal(textoRepeticoes(importacao()), "");
  assert.equal(textoRepeticoes(importacao({ repeticoes: 1 })), "Reimportado 1 vez");
  assert.equal(textoRepeticoes(importacao({ repeticoes: 3 })), "Reimportado 3 vezes");
  assert.equal(textoRepeticoes(busca({ repeticoes: 4 })), "");
});

test("o resumo do cartão mostra as três entradas mais recentes", () => {
  const itens = [1, 2, 3, 4, 5].map(n => ({ id: String(n) }));
  assert.deepEqual(ultimasEntradas(itens).map(i => i.id), ["1", "2", "3"]);
  assert.deepEqual(ultimasEntradas(undefined), []);
});
