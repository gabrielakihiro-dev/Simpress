// Paginação local do histórico F7 ("Carregar mais"), em frontend/src/paineis/historico-apelidos/paginacao-historico.ts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const arquivo = path.join(__dirname, "../../frontend/src/paineis/historico-apelidos/paginacao-historico.ts");
const paginacao = require(arquivo);

const itens = Array.from({ length: 120 }, (_, indice) => indice);

test("a paginação é pura e não usa any", () => {
  const fonte = fs.readFileSync(arquivo, "utf8");
  assert.doesNotMatch(fonte, /^\s*import\s/m);
  assert.doesNotMatch(fonte, /:\s*any\b|\bas any\b|<any>/);
});

test("a primeira página tem 50 registros e a contagem do que falta", () => {
  assert.equal(paginacao.TAMANHO_PAGINA_HISTORICO, 50);
  const fatia = paginacao.fatiaHistorico(itens, 1);
  assert.equal(fatia.visiveis.length, 50);
  assert.equal(fatia.restantes, 70);
  assert.deepEqual(fatia.visiveis.slice(0, 2), [0, 1]);
});

test("cada página a mais soma 50 registros e a última não passa do total", () => {
  assert.equal(paginacao.fatiaHistorico(itens, 2).visiveis.length, 100);
  const ultima = paginacao.fatiaHistorico(itens, 3);
  assert.equal(ultima.visiveis.length, 120);
  assert.equal(ultima.restantes, 0);
  assert.equal(paginacao.fatiaHistorico(itens, 99).restantes, 0);
});

test("lista menor que a página aparece inteira e lista vazia não quebra", () => {
  const poucos = paginacao.fatiaHistorico([1, 2, 3], 1);
  assert.deepEqual(poucos.visiveis, [1, 2, 3]);
  assert.equal(poucos.restantes, 0);
  assert.deepEqual(paginacao.fatiaHistorico([], 1), { visiveis: [], restantes: 0 });
});

test("página inválida volta para a primeira", () => {
  for (const invalida of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(paginacao.fatiaHistorico(itens, invalida).visiveis.length, 50, `paginas=${invalida}`);
  }
  assert.equal(paginacao.fatiaHistorico(itens, 1.9).visiveis.length, 50);
});

test("o registro selecionado nunca fica fora da fatia", () => {
  const fatia = paginacao.fatiaHistorico(itens, 1, 77);
  assert.equal(fatia.visiveis.length, 78);
  assert.equal(fatia.visiveis[77], 77);
  assert.equal(fatia.restantes, 42);
  assert.equal(paginacao.fatiaHistorico(itens, 1, -1).visiveis.length, 50);
  assert.equal(paginacao.fatiaHistorico(itens, 1, 10).visiveis.length, 50);
});

test("o tamanho da página pode ser trocado", () => {
  const fatia = paginacao.fatiaHistorico(itens, 2, -1, 10);
  assert.equal(fatia.visiveis.length, 20);
  assert.equal(fatia.restantes, 100);
});

test("a chave do filtro muda com qualquer parte e não confunde partes vizinhas", () => {
  const base = paginacao.chaveFiltroHistorico(["abc", "todos", false, "tudo", 60]);
  assert.equal(base, paginacao.chaveFiltroHistorico(["abc", "todos", false, "tudo", 60]));
  assert.notEqual(base, paginacao.chaveFiltroHistorico(["abcd", "todos", false, "tudo", 60]));
  assert.notEqual(base, paginacao.chaveFiltroHistorico(["abc", "usuario", false, "tudo", 60]));
  assert.notEqual(base, paginacao.chaveFiltroHistorico(["abc", "todos", true, "tudo", 60]));
  assert.notEqual(base, paginacao.chaveFiltroHistorico(["abc", "todos", false, "7d", 60]));
  assert.notEqual(base, paginacao.chaveFiltroHistorico(["abc", "todos", false, "tudo", 61]));
  assert.notEqual(paginacao.chaveFiltroHistorico(["ab", "c"]), paginacao.chaveFiltroHistorico(["a", "bc"]));
});
