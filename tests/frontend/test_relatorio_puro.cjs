// Relatório mensal: regras puras do painel React (frontend/src/paineis/relatorio-mensal/relatorio-puro.ts).
// O Node carrega .ts direto (só sintaxe apagável); o módulo não importa nada. Dados sintéticos.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const puro = require(path.resolve(__dirname, "../../frontend/src/paineis/relatorio-mensal/relatorio-puro.ts"));

const HOJE = new Date(2026, 10, 17, 10, 0, 0); // 17/11/2026, hora local

test("mesValido: aceita AAAA-MM do mês atual e de meses passados", () => {
  assert.equal(puro.mesValido("2026-11", HOJE), true);
  assert.equal(puro.mesValido("2026-01", HOJE), true);
  assert.equal(puro.mesValido("2025-12", HOJE), true);
});

test("mesValido: recusa mês 00, 13 e futuro", () => {
  assert.equal(puro.mesValido("2026-00", HOJE), false);
  assert.equal(puro.mesValido("2026-13", HOJE), false);
  assert.equal(puro.mesValido("2026-12", HOJE), false);
  assert.equal(puro.mesValido("2027-01", HOJE), false);
});

test("mesValido: recusa formato errado e vazio", () => {
  for (const mes of ["", "2026-1", "26-11", "2026/11", "2026-11-01", " 2026-11", "2026-11 ", "novembro", "202611"]) {
    assert.equal(puro.mesValido(mes, HOJE), false, JSON.stringify(mes));
  }
});

test("mesAtual: AAAA-MM com zero à esquerda", () => {
  assert.equal(puro.mesAtual(new Date(2026, 0, 5)), "2026-01");
  assert.equal(puro.mesAtual(HOJE), "2026-11");
});
