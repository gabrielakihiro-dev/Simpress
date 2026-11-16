// Modal "Editar apelido" (Home F1): regras puras de frontend/src/paineis/editar-apelido/editar-apelido-puro.ts,
// carregado direto pelo require do Node. O diálogo (tela, POST, resposta tardia) é testado no navegador:
// tests/e2e/react-g10.spec.cjs. Dados sintéticos.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const arquivo = path.join(__dirname, "../../frontend/src/paineis/editar-apelido/editar-apelido-puro.ts");
const puro = require(arquivo);

test("o arquivo puro não importa nada e não usa any (o Node o carrega sem build)", () => {
  const fonte = fs.readFileSync(arquivo, "utf8");
  assert.doesNotMatch(fonte, /^\s*import\s/m);
  assert.doesNotMatch(fonte, /:\s*any\b|\bas any\b|<any>/);
});

test("ao abrir, o campo traz o apelido atual e a linha Série: ... aparece abaixo", () => {
  assert.deepEqual(puro.camposDoApelido({ serial: "AAA111", apelido: "NB-01" }), { apelido: "NB-01", contexto: "Série: AAA111" });
  assert.deepEqual(puro.camposDoApelido({ serial: "AAA111" }), { apelido: "", contexto: "Série: AAA111" });
  assert.deepEqual(puro.camposDoApelido(null), { apelido: "", contexto: "Série: " });
});

test("montarPayload leva série e apelido sem as pontas", () => {
  const payload = puro.montarPayload("AAA111", "  NB-02  ");
  assert.deepEqual(Object.keys(payload), ["serial", "apelido"]);
  assert.deepEqual(payload, { serial: "AAA111", apelido: "NB-02" });
  assert.equal(puro.montarPayload("AAA111", "   ").apelido, "", "apelido vazio limpa o manual");
});

test("resposta tardia: exige a mesma revisão e a mesma série (sem diferenciar maiúsculas)", () => {
  const atual = { serial: "aaa111" };
  assert.equal(puro.seguiuSelecionado(3, 3, "AAA111", atual), true);
  assert.equal(puro.seguiuSelecionado(3, 4, "AAA111", atual), false, "outra seleção, mesma série ou não");
  assert.equal(puro.seguiuSelecionado(3, 3, "BBB222", atual), false);
  assert.equal(puro.seguiuSelecionado(3, 3, "AAA111", null), false, "seleção limpa");
});

test("serialDo e lerEquipamento toleram resposta fora do formato", () => {
  assert.equal(puro.serialDo({ serial: "AAA111" }), "AAA111");
  assert.equal(puro.serialDo(undefined), "");
  assert.deepEqual(puro.lerEquipamento({ equipamento: { serial: "A", apelido: "X" } }), { serial: "A", apelido: "X" });
  assert.equal(puro.lerEquipamento(null), undefined);
});

test("textos aprovados não mudam", () => {
  assert.equal(puro.TEXTO.salvar, "Salvar apelido");
  assert.equal(puro.TEXTO.salvando, "Salvando...");
  assert.equal(puro.TEXTO.sucesso, "Apelido salvo para pesquisas e exportações do Excel.");
  assert.equal(puro.TEXTO.semEquipamento, "Pesquise um equipamento antes de editar o apelido.");
});
