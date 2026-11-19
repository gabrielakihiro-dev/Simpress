// Rótulos do seletor de comparações do Resumo (F3, Novo layout): frontend/src/paineis/resultado-comparacao/rotulos-comparacao.ts.
// Dados sintéticos; nenhum dado real.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const r = require(path.resolve(__dirname, "../../frontend/src/paineis/resultado-comparacao/rotulos-comparacao.ts"));

test("horarioCurto: ISO com hora vira dd/mm/aaaa hh:mm na hora local", () => {
  const local = new Date(2026, 10, 12, 9, 33, 45);
  assert.equal(r.horarioCurto(local.toISOString()), "12/11/2026 09:33");
});

test("horarioCurto: só a data é meia-noite local, não o dia anterior", () => {
  assert.equal(r.horarioCurto("2026-11-12"), "12/11/2026 00:00");
});

test("horarioCurto: registro já em dd/mm/aaaa não troca dia por mês", () => {
  assert.equal(r.horarioCurto("03/11/2026 14:05"), "03/11/2026 14:05");
  assert.equal(r.horarioCurto("03/11/2026 14:05:59"), "03/11/2026 14:05");
});

test("horarioCurto: vazio ou inválido é Data indisponível", () => {
  for (const valor of [undefined, null, "", "não é data"]) assert.equal(r.horarioCurto(valor), "Data indisponível");
});

test("rótulos do seletor e do status usam o mesmo horário", () => {
  const evento = { horario: "03/11/2026 14:05", tipo: "atualizacao" };
  assert.match(r.rotuloOpcaoComparacao(evento), /^03\/11\/2026 14:05 · /);
  assert.match(r.rotuloStatusComparacao(evento), / · 03\/11\/2026 14:05$/);
});
