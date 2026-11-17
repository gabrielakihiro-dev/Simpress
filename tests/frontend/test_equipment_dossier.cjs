// Home (F1): diálogo "Dossiê do equipamento". Desde a migração React (Dia 2, G3) o diálogo vive em
// frontend/src/paineis/dossie-equipamento/ e o comportamento é testado no navegador: tests/e2e/dossie-equipamento.spec.cjs
// e tests/e2e/react-g3.spec.cjs. Aqui ficam o registro, a ponte do código antigo e o HTML montado.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = assembledHtml();
const appSource = fs.readFileSync(path.join(root, "frontend/src/aplicacao/app.ts"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "frontend/src/arranque/entrada.ts"), "utf8");
const createEquipmentDossier = require("../../frontend/src/aplicacao/registro.ts").fabricas.equipmentDossier;
const NOMES = ["abrirDossieEquipamento", "fecharDossieEquipamento", "atualizarDossieEquipamento"];

function ponteFalsa(acao) {
  const chamadas = [];
  const repasses = [];
  const context = {
    ponteReact(painel, nomes) {
      chamadas.push([painel, nomes]);
      return Object.fromEntries(nomes.map(nome => [nome, (...args) => { repasses.push([nome, args]); return acao(); }]));
    },
  };
  return { chamadas, repasses, feature: createEquipmentDossier(context) };
}

function comBotao(fn) {
  const botao = { disabled: false };
  const original = global.document;
  global.document = { getElementById: id => (id === "btn-ver-dossie" ? botao : null) };
  try {
    fn(botao);
  } finally {
    global.document = original;
  }
}

test("registro: módulo importado no arranque e publicado no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\.\/aplicacao\/registro\.ts";/);
  assert.equal(typeof require("../../frontend/src/aplicacao/registro.ts").fabricas.equipmentDossier, "function");
  assert.match(appSource, /"equipmentDossier",/);
  assert.ok(fs.existsSync(path.join(root, "frontend/src/paineis/dossie-equipamento/montar.tsx")));
});

test("ponte: as três ações repassam ao painel React dossie-equipamento com os mesmos argumentos", async () => {
  const { chamadas, repasses, feature } = ponteFalsa(async () => undefined);
  assert.deepEqual(chamadas, [["dossie-equipamento", NOMES]]);
  assert.deepEqual(repasses, [], "criar o módulo não chama o React");
  await feature.abrirDossieEquipamento();
  await feature.fecharDossieEquipamento();
  const equipamento = { serial: "SERIE-TESTE" };
  comBotao(() => feature.atualizarDossieEquipamento(equipamento));
  assert.deepEqual(repasses, [["abrirDossieEquipamento", []], ["fecharDossieEquipamento", []], ["atualizarDossieEquipamento", [equipamento]]]);
  assert.equal(repasses[2][1][0], equipamento, "o mesmo objeto, sem cópia");
});

test("ponte: atualizarDossieEquipamento liga e desliga o botão Ver dossiê na hora, antes do React", () => {
  const { feature } = ponteFalsa(() => new Promise(() => {}));
  comBotao(botao => {
    feature.atualizarDossieEquipamento({ serial: "  " });
    assert.equal(botao.disabled, true);
    feature.atualizarDossieEquipamento({ serial: "SERIE-TESTE" });
    assert.equal(botao.disabled, false);
    feature.atualizarDossieEquipamento(null);
    assert.equal(botao.disabled, true);
  });
});

test("ponte: se o React não carregou, cada ação registra o erro e não rejeita", async () => {
  const erros = [];
  const original = console.error;
  console.error = erro => erros.push(erro);
  try {
    const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "dossie-equipamento" não carregou.')));
    assert.equal(await feature.abrirDossieEquipamento(), undefined);
    assert.equal(await feature.fecharDossieEquipamento(), undefined);
    comBotao(() => assert.equal(feature.atualizarDossieEquipamento({ serial: "SERIE-TESTE" }), undefined));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.error = original;
  }
  assert.deepEqual(erros, ["abrirDossieEquipamento", "fecharDossieEquipamento", "atualizarDossieEquipamento"].map(nome => `${nome}: O painel React "dossie-equipamento" não carregou.`));
});

test("estado: a seleção é lida só por lerEstado (estado-app.ts), na hora de cada conferência, nunca copiada nem gravada", () => {
  const pasta = path.join(root, "frontend/src/paineis/dossie-equipamento");
  const fontes = fs.readdirSync(pasta).map(nome => fs.readFileSync(path.join(pasta, nome), "utf8")).join("\n");
  assert.match(fontes, /import \{ lerEstado \} from "\.\.\/\.\.\/estado-app";/);
  assert.match(fontes, /lerEstado\("currentEquipamento"\)/);
  assert.match(fontes, /lerEstado\("equipamentoSelectionRevision"\)/);
  assert.doesNotMatch(fontes, /gravarEstado|SimpressApp|appState|retiradaCidadeSelecionada/);
  // A conferência da resposta atrasada relê a seleção (série e revisão) em vez de usar a cópia da abertura.
  const vigente = fontes.match(/const vigente = \(\) =>[^;]+;/)?.[0] ?? "";
  assert.match(vigente, /serieSelecionada\(\)/);
  assert.match(vigente, /lerEstado\("equipamentoSelectionRevision"\)/);
});

test("index.html: .ck-dialogo do dossiê vazio e marcado para o React, sem IDs duplicados", () => {
  const modal = html.match(/<div id="modal-dossie-equipamento"[^>]*>[\s\S]*?\n  <\/div>/)[0];
  assert.match(modal, /class="modal-overlay ck-veu hidden"/);
  assert.match(modal, /aria-labelledby="titulo-dossie-equipamento"/);
  assert.match(modal, /<div class="ck-dialogo dossie-equip" data-react-painel="dossie-equipamento"><\/div>/,
    "o diálogo fica vazio no HTML: o React desenha o conteúdo dentro dele");
  assert.doesNotMatch(modal, /id="dossie-/, "os IDs do conteúdo saem só do React");
  assert.match(html, /id="btn-ver-dossie"[^>]*data-on-click="abrirDossieEquipamento"/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicados = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(duplicados, []);
});
