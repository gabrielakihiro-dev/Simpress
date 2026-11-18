// Peças comuns do Novo layout (frontend/src/componentes/): regras puras e contrato de DOM/ARIA.
// O Node não lê JSX; os .tsx são conferidos pelo texto e pelo tsc do npm run verify.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { iniciais, anotacoesNoFim, agruparLinhas, tomDoLado, duracaoToast } = require("../../frontend/src/componentes/nl-modelo.ts");

const ler = (nome) => fs.readFileSync(path.join(__dirname, "../../frontend/src/componentes", nome), "utf8");

test("iniciais pega o primeiro e o último nome", () => {
  assert.equal(iniciais("Ana Lima"), "AL");
  assert.equal(iniciais("  bruno  de  souza "), "BS");
  assert.equal(iniciais("Carla"), "C");
  assert.equal(iniciais("   "), "?");
});

test("Anotações vai sempre para o fim da tabela", () => {
  const cols = [{ rotulo: "Série" }, { rotulo: "Anotações" }, { rotulo: "Cidade" }];
  assert.deepEqual(anotacoesNoFim(cols).map((c) => c.rotulo), ["Série", "Cidade", "Anotações"]);
  assert.deepEqual(anotacoesNoFim([{ rotulo: "Série" }]).map((c) => c.rotulo), ["Série"]);
});

test("agruparLinhas mantém a ordem de chegada de cada grupo", () => {
  const linhas = [{ d: "Hoje", n: 1 }, { d: "Ontem", n: 2 }, { d: "Hoje", n: 3 }];
  assert.deepEqual(agruparLinhas(linhas, (l) => l.d), [
    { rotulo: "Hoje", linhas: [linhas[0], linhas[2]] },
    { rotulo: "Ontem", linhas: [linhas[1]] },
  ]);
  assert.deepEqual(agruparLinhas([], (l) => l.d), []);
});

test("lado responsável: CLIENTE em ciano, SIMPRESS em índigo", () => {
  assert.equal(tomDoLado("CLIENTE"), "ciano");
  assert.equal(tomDoLado("SIMPRESS"), "indigo");
});

test("erro fica mais tempo na tela que sucesso", () => {
  assert.equal(duracaoToast("sucesso"), 4000);
  assert.equal(duracaoToast("erro"), 6000);
});

test("peças usam as classes e o ARIA do nl-base.css", () => {
  const css = fs.readFileSync(path.join(__dirname, "../../static/styles/nl-base.css"), "utf8");
  const pecas = {
    "pilula-subaba.tsx": ["nl-subabas", "nl-subabas__marca", "nl-subaba", "aria-pressed", 'role="group"'],
    "tabela-nl.tsx": ["nl-tabela", "nl-tabela__lin", "data-rotulo", "data-clicavel", "data-selecionada", "scope=\"col\"", "nl-tabela__grupo", 'scope="rowgroup"', "nl-tabela__grupo-q"],
    "toast.tsx": ["nl-toasts", "nl-toast", "nl-toast__fechar", 'aria-live="polite"', 'aria-label="Fechar aviso"'],
    "folha-inferior.tsx": ["nl-veu", "nl-folha", "nl-folha__fechar", 'aria-modal="true"', "aria-labelledby", "Escape"],
    "selo-responsavel.tsx": ["nl-avs", "nl-av", "data-papel", "aria-label", "tabIndex={0}", "nl-selo-lado", "Responsável (A)"],
    "campo-nl.tsx": ["nl-campo", "nl-campo__inp", "nl-campo__rot", "nl-campo__erro", 'placeholder=" "', "aria-invalid", "aria-describedby", "htmlFor"],
    "cartao-bento.tsx": ["ck-bento-cartao", "ck-bento-face", "data-bento-cartao", "ck-bento-d${atraso}"],
  };
  for (const [arquivo, trechos] of Object.entries(pecas)) {
    const fonte = ler(arquivo);
    for (const t of trechos) assert.ok(fonte.includes(t), `${arquivo} sem ${t}`);
  }
  for (const classe of ["nl-subabas__marca", "nl-tabela__lin", "nl-tabela__grupo", "nl-toast__fechar", "nl-folha__fechar", "nl-av", "nl-selo-lado", "nl-campo__rot", "nl-campo__erro"]) {
    assert.ok(css.includes(`.${classe}`), `nl-base.css sem .${classe}`);
  }
});

test("dados de exemplo dos componentes são fictícios: nenhum e-mail nem CPF no código", () => {
  for (const arquivo of fs.readdirSync(path.join(__dirname, "../../frontend/src/componentes"))) {
    const fonte = ler(arquivo);
    assert.doesNotMatch(fonte, /[\w.+-]+@[\w-]+\.[\w.]+/, `${arquivo} tem e-mail`);
    assert.doesNotMatch(fonte, /\d{3}\.\d{3}\.\d{3}-\d{2}/, `${arquivo} tem CPF`);
  }
});
