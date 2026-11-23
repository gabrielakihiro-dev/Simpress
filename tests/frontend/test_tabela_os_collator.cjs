const assert = require("node:assert/strict");
const test = require("node:test");
const { collatorOs } = require("../../frontend/src/paineis/paineis-dados/tabela-os.ts");

const opcoes = { numeric: true, sensitivity: "base" };
const amostra = ["OS 10", "OS 2", "os 2", "água", "agua", "Água", "zebra", "ABC-9", "abc-10", "", "1", "01"];

test("collator da tabela de OS ordena igual ao localeCompare antigo", () => {
  const antigo = [...amostra].sort((a, b) => a.localeCompare(b, "pt-BR", opcoes));
  assert.deepEqual([...amostra].sort(collatorOs.compare), antigo);
  for (const a of amostra) for (const b of amostra) {
    assert.equal(Math.sign(collatorOs.compare(a, b)), Math.sign(a.localeCompare(b, "pt-BR", opcoes)));
  }
});

test("numeros, acentos e caixa", () => {
  assert.ok(collatorOs.compare("OS 2", "OS 10") < 0);
  assert.equal(collatorOs.compare("água", "agua"), 0);
  assert.equal(collatorOs.compare("OS", "os"), 0);
});
