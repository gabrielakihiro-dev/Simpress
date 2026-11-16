// G10 (pesquisa completa, editar equipamento, editar apelido): a ponte que sobrou em static/js/features/ e os
// contêineres do HTML. A tela e o comportamento dos diálogos ficam em tests/e2e/react-g10.spec.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const raiz = path.join(__dirname, "../..");
const criarPesquisaCompleta = require(path.join(raiz, "static/js/features/full-equipment-search.js"));
const criarEditor = require(path.join(raiz, "static/js/features/equipment-editor.js"));

const ler = relativo => fs.readFileSync(path.join(raiz, relativo), "utf8");
const DIALOGOS = {
  "pesquisa-completa": "frontend/src/paineis/pesquisa-completa/dialogo.tsx",
  "editar-equipamento": "frontend/src/paineis/editar-equipamento/dialogo.tsx",
  "editar-apelido": "frontend/src/paineis/editar-apelido/dialogo.tsx",
};

// Ponte falsa: grava (painel, ação, argumentos) e devolve o que o teste mandar.
function criarPonteFalsa(respostas = {}) {
  const chamadas = [];
  const ponteReact = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async (...argumentos) => {
    chamadas.push({ painel, nome, argumentos });
    if (respostas[nome] instanceof Error) throw respostas[nome];
    return respostas[nome] ?? null;
  }]));
  const ponteReactSincrona = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
    chamadas.push({ painel, nome, argumentos });
    if (respostas[nome] instanceof Error) throw respostas[nome];
    return respostas[nome] ?? null;
  }]));
  return { chamadas, ponteReact, ponteReactSincrona };
}

test("pesquisa completa: cada ação do window vai ao painel React, e a abertura leva a linha antiga", async () => {
  const { chamadas, ponteReact } = criarPonteFalsa();
  const criarLinhaPesquisaCompleta = () => "linha";
  const ponte = criarPesquisaCompleta({ ponteReact, equipmentSearchRenderer: () => ({ criarLinhaPesquisaCompleta }) });
  assert.deepEqual(Object.keys(ponte).sort(), [
    "abrirPesquisaCompleta", "alterarFiltrosPesquisaCompleta", "carregarMaisResultadosPesquisa",
    "fecharModalPesquisaCompleta", "limparFiltrosPesquisaCompleta",
  ]);
  for (const nome of Object.keys(ponte)) await ponte[nome]();
  assert.ok(chamadas.every(chamada => chamada.painel === "pesquisa-completa"));
  const abertura = chamadas.find(chamada => chamada.nome === "abrirPesquisaCompleta");
  assert.deepEqual(abertura.argumentos, [criarLinhaPesquisaCompleta], "a linha do resultado ainda é desenhada pelo código antigo");
  for (const chamada of chamadas.filter(item => item !== abertura)) assert.deepEqual(chamada.argumentos, []);
});

test("editor: abrir, fechar e cadastrar série vão aos painéis certos; a série pesquisada segue ao cadastro", async () => {
  const { chamadas, ponteReact, ponteReactSincrona } = criarPonteFalsa();
  globalThis.document = { getElementById: id => (id === "input-serial" ? { value: "XYZ-9" } : null) };
  try {
    const editor = criarEditor({ app: {}, appState: {}, ponteReact, ponteReactSincrona });
    await editor.abrirModalEditarEquipamento();
    await editor.cadastrarNovoSerialPesquisado();
    await editor.fecharModalEditarEquipamento();
    await editor.abrirModalEditarApelido();
    await editor.fecharModalEditarApelido();
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(chamadas.map(({ painel, nome, argumentos }) => [painel, nome, argumentos]), [
    ["cartao-equipamento", "abrirModalEditarEquipamento", []],
    ["cartao-equipamento", "cadastrarNovoSerialPesquisado", []],
    ["cartao-equipamento", "fecharModalEditarEquipamento", []],
    ["cartao-equipamento", "abrirModalEditarApelido", []],
    ["cartao-equipamento", "fecharModalEditarApelido", []],
  ]);
});

test("painel que não carregou: a ponte registra o erro no console e nunca rejeita", async () => {
  const falha = new Error('O painel React "cartao-equipamento" não carregou.');
  const { ponteReact, ponteReactSincrona } = criarPonteFalsa({ abrirModalEditarApelido: falha, abrirPesquisaCompleta: falha, salvarApelido: falha });
  const registrados = [];
  const original = console.error;
  console.error = (...argumentos) => registrados.push(argumentos);
  try {
    const editor = criarEditor({ app: {}, appState: {}, ponteReact, ponteReactSincrona });
    const pesquisa = criarPesquisaCompleta({ ponteReact, equipmentSearchRenderer: () => ({ criarLinhaPesquisaCompleta() {} }) });
    assert.equal(await editor.abrirModalEditarApelido(), undefined);
    assert.equal(await pesquisa.abrirPesquisaCompleta(), undefined);
    assert.equal(await editor.salvarApelido(), undefined, "sem painel não há o que aplicar ao cartão");
  } finally {
    console.error = original;
  }
  assert.equal(registrados.length, 3);
  assert.ok(registrados.every(([erro]) => erro === falha));
});

test("salvar: resultado vazio do React (falha ou seleção trocada) não mexe no cartão", async () => {
  const { ponteReact, ponteReactSincrona } = criarPonteFalsa();
  const chamadasApp = [];
  const app = new Proxy({}, { get: (_alvo, nome) => (...argumentos) => chamadasApp.push([nome, argumentos]) });
  const editor = criarEditor({ app, appState: {}, ponteReact, ponteReactSincrona });
  await editor.salvarApelido();
  await editor.salvarDadosEquipamento();
  assert.deepEqual(chamadasApp, []);
});

test("contêineres: o HTML só tem os três pontos de montagem vazios, e os ids antigos moram nos diálogos React", () => {
  const modais = ler("frontend/partials/modais.html");
  for (const painel of Object.keys(DIALOGOS)) {
    assert.match(modais, new RegExp(`<div class="[^"]*" data-react-painel="${painel}"></div>`), `${painel}: contêiner vazio`);
    assert.equal(modais.split(`data-react-painel="${painel}"`).length - 1, 1, `${painel}: um só contêiner`);
  }
  const idsDosDialogos = new Map();
  for (const [painel, arquivo] of Object.entries(DIALOGOS)) {
    for (const [, id] of ler(arquivo).matchAll(/\bid="([a-z0-9-]+)"/g)) {
      assert.ok(!idsDosDialogos.has(id), `id "${id}" repetido entre ${idsDosDialogos.get(id)} e ${painel}`);
      idsDosDialogos.set(id, painel);
    }
  }
  assert.ok(idsDosDialogos.size >= 20, "os diálogos mantêm os ids que o e2e e o código antigo leem");
  const hospedeiros = ["frontend/partials/modais.html", "frontend/partials/card-equipamento.html", "frontend/partials/cockpit-tool-panels.html", "static/index.html"];
  for (const arquivo of hospedeiros) {
    const texto = ler(arquivo);
    for (const id of idsDosDialogos.keys()) assert.ok(!texto.includes(`id="${id}"`), `id "${id}" ainda no ${arquivo}`);
  }
});

test("todo data-on-click e data-on-change dos diálogos tem função na ponte correspondente", () => {
  const { ponteReact, ponteReactSincrona } = criarPonteFalsa();
  const pesquisa = criarPesquisaCompleta({ ponteReact, equipmentSearchRenderer: () => ({ criarLinhaPesquisaCompleta() {} }) });
  const editor = criarEditor({ app: {}, appState: {}, ponteReact, ponteReactSincrona });
  const ponteDe = { "pesquisa-completa": pesquisa, "editar-equipamento": editor, "editar-apelido": editor };
  for (const [painel, arquivo] of Object.entries(DIALOGOS)) {
    const nomes = [...ler(arquivo).matchAll(/data-on-(?:click|change)="([A-Za-z]+)"/g)].map(achado => achado[1]);
    assert.ok(nomes.length > 0, `${painel}: sem ações ligadas`);
    for (const nome of nomes) assert.equal(typeof ponteDe[painel][nome], "function", `${painel}: ${nome} sem ponte`);
  }
});

test("editor: ações imediatas do cartão usam a ponte React síncrona", () => {
  const { chamadas, ponteReact, ponteReactSincrona } = criarPonteFalsa();
  const editor = criarEditor({ app: {}, appState: {}, ponteReact, ponteReactSincrona });

  editor.editarDadosCadastrais();
  editor.cancelarDadosCadastrais();

  assert.deepEqual(chamadas.map(({ painel, nome }) => [painel, nome]), [
    ["cartao-equipamento", "editarDadosCadastrais"],
    ["cartao-equipamento", "cancelarDadosCadastrais"],
  ]);
});

test("os diálogos não ligam onClick; todo onChange só grava o rascunho (editar, escolher), sem pedido nem ação", () => {
  for (const [painel, arquivo] of Object.entries(DIALOGOS)) {
    const fonte = ler(arquivo);
    assert.doesNotMatch(fonte, /\bonClick=/, `${painel}: onClick ligado`);
    for (const [, corpo] of fonte.matchAll(/\bonChange=\{([^\n]*)\}/g)) {
      assert.match(corpo, /^evento => (editar|aoEscolher)\(/, `${painel}: onChange fora do gravador de rascunho`);
    }
  }
});
