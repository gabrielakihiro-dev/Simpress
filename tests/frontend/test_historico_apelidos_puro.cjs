// Regras puras do histórico F7, migradas para frontend/src/paineis/historico-apelidos/.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const arquivo = path.join(__dirname, "../../frontend/src/paineis/historico-apelidos/historico-apelidos-puro.ts");
const puro = require(arquivo);

test("as regras do histórico são puras e não usam any", () => {
  const fonte = fs.readFileSync(arquivo, "utf8");
  assert.doesNotMatch(fonte, /^\s*import\s/m);
  assert.doesNotMatch(fonte, /:\s*any\b|\bas any\b|<any>/);
});

test("o registro mais recente é calculado por série e campo, e cada aviso é independente", () => {
  const eventos = [
    { id: "a2", serial: "aaa111", tipo: "apelido" },
    { id: "u1", serial: "AAA111", tipo: "usuario" },
    { id: "a1", serial: "AAA111", tipo: "apelido" },
    { id: "e1", serial: "AAA111", tipo: "endereco" },
    { id: "warn1", serial: "AAA111", tipo: "aviso_endpoint" },
    { id: "warn2", serial: "AAA111", tipo: "aviso_endpoint" },
    { id: "b1", serial: "BBB222", tipo: "apelido" },
  ];
  const ultimos = puro.ultimoRegistroPorCampo(eventos);
  assert.deepEqual([...ultimos.entries()], [
    ["AAA111:apelido", "a2"], ["AAA111:usuario", "u1"], ["AAA111:endereco", "e1"],
    ["AAA111:aviso:warn1", "warn1"], ["AAA111:aviso:warn2", "warn2"], ["BBB222:apelido", "b1"],
  ]);
});

test("só apelido ou usuário mais recente pode ser desfeito; endereço não é removido", () => {
  const eventos = [
    { id: "a2", serial: "AAA111", tipo: "apelido" },
    { id: "a1", serial: "AAA111", tipo: "apelido" },
    { id: "u1", serial: "AAA111", tipo: "usuario" },
    { id: "e1", serial: "AAA111", tipo: "endereco" },
    { id: "warn1", serial: "AAA111", tipo: "aviso_endpoint" },
  ];
  const ultimos = puro.ultimoRegistroPorCampo(eventos);
  assert.deepEqual(puro.acoesEventoHistorico(eventos[0], eventos, ultimos), {
    desfazer: true, excluir: true, rotuloExcluir: "Restaurar e excluir",
  });
  assert.equal(puro.acoesEventoHistorico(eventos[1], eventos, ultimos).desfazer, false);
  assert.equal(puro.acoesEventoHistorico(eventos[2], eventos, ultimos).desfazer, true);
  assert.deepEqual(puro.acoesEventoHistorico(eventos[3], eventos, ultimos), {
    desfazer: false, excluir: false, rotuloExcluir: "Restaurar e excluir",
  });
  assert.deepEqual(puro.acoesEventoHistorico(eventos[4], eventos, ultimos), {
    desfazer: false, excluir: true, rotuloExcluir: "Excluir aviso",
  });
});

test("série vazia não torna um registro elegível", () => {
  const evento = { id: "a1", serial: "", tipo: "apelido" };
  assert.deepEqual(puro.acoesEventoHistorico(evento, [evento]), {
    desfazer: false, excluir: false, rotuloExcluir: "Restaurar e excluir",
  });
});
