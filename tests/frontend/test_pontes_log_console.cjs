// LGPD: as pontes registram só "nome: mensagem". O objeto de erro inteiro (stack, dados da resposta) não vai ao console.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PASTA = path.join(__dirname, "..", "..", "frontend", "src", "legado", "features");
// console.error com o erro como argumento solto (sozinho ou depois de um texto) ou .catch(console.error).
const PROIBIDO = /console\.error\(\s*(?:[^()]*?,\s*)?(?:erro|err|error|e)\s*\)|\.catch\(\s*console\.error\s*\)/;

test("nenhuma ponte manda o objeto de erro inteiro ao console", () => {
  const culpados = fs.readdirSync(PASTA)
    .filter(nome => nome.endsWith(".js"))
    .filter(nome => PROIBIDO.test(fs.readFileSync(path.join(PASTA, nome), "utf8")));
  assert.deepEqual(culpados, []);
});

test("o padrão pega as formas antigas e deixa passar só a mensagem", () => {
  for (const ruim of [
    "acao().catch(erro => { console.error(erro); })",
    "acao().catch(e => console.error(e))",
    "acao().catch(function (erro) { console.error(erro) })",
    "acao().catch(console.error)",
    'console.error("Erro ao salvar:", err);',
  ]) assert.ok(PROIBIDO.test(ruim), ruim);
  assert.ok(!PROIBIDO.test("acao().catch(erro => { console.error(`acao: ${erro?.message}`); })"));
  assert.ok(!PROIBIDO.test('console.error(new Error(\'O painel React "x" não carregou.\'));'));
});
