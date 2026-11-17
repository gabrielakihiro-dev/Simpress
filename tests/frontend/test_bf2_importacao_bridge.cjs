// BF2: a ponte frontend/src/legado/features/inventory-upload.js só encaminha para window.SimpressReact["importacao-planilhas"].
// Dados sintéticos; os fluxos reais (prévia, envio, exportação) são testados em test_inventory_upload_flows e afins.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createAppHarness } = require("./support/inventory-harness.cjs");
const criarUpload = require("../../frontend/src/legado/features/inventory-upload.js");

const PAINEL = "importacao-planilhas";
const MENSAGEM = `O painel React "${PAINEL}" não carregou.`;
const SINCRONAS = [
  "abrirImportacaoModelo", "fecharImportacaoModelo", "limparPreviaUploadPlanilhas",
  "abrirModalAtualizarPlanilhas", "fecharModalAtualizarPlanilhas",
];
const ASSINCRONAS = [
  "inicializarExportacaoAutomaticaHistorico", "inicializarArquivosAtualizacaoPlanilhas", "enviarModeloLocal",
  "previsualizarPlanilhas", "enviarPlanilhas", "exportarEquipamentosAtualizados",
];

function criarPontes() {
  const chamadas = [];
  const ponteReact = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async (...argumentos) => {
    chamadas.push({ tipo: "async", painel, nome, argumentos });
    return `async:${nome}`;
  }]));
  const ponteReactSincrona = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
    chamadas.push({ tipo: "sync", painel, nome, argumentos });
    return `sync:${nome}`;
  }]));
  return { chamadas, ponteReact, ponteReactSincrona };
}

function capturarErros() {
  const original = console.error;
  const erros = [];
  console.error = erro => erros.push(erro);
  return { erros, restaurar: () => { console.error = original; } };
}

test("a ponte publica as 11 ações: 5 síncronas e 6 assíncronas, cada uma no painel certo", async () => {
  const pontes = criarPontes();
  const acoes = criarUpload(pontes);
  assert.deepEqual(Object.keys(acoes).sort(), [...SINCRONAS, ...ASSINCRONAS].sort());

  const argumentos = [{ id: "arg-sintetico" }, 3];
  for (const nome of SINCRONAS) {
    const retorno = acoes[nome](...argumentos);
    assert.ok(!(retorno instanceof Promise), `${nome} devolve o valor na hora, sem Promise`);
    assert.equal(retorno, `sync:${nome}`);
  }
  for (const nome of ASSINCRONAS) {
    const retorno = acoes[nome](...argumentos);
    assert.ok(retorno instanceof Promise, `${nome} devolve Promise`);
    assert.equal(await retorno, `async:${nome}`);
  }
  assert.deepEqual(pontes.chamadas, [
    ...SINCRONAS.map(nome => ({ tipo: "sync", painel: PAINEL, nome, argumentos })),
    ...ASSINCRONAS.map(nome => ({ tipo: "async", painel: PAINEL, nome, argumentos })),
  ]);
});

test("rejeição do painel nas ações assíncronas vai só ao console e a ponte resolve undefined", async () => {
  const falha = new Error(MENSAGEM);
  const acoes = criarUpload({
    ponteReact: (_painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async () => { throw falha; }])),
    ponteReactSincrona: (_painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => undefined])),
  });
  const captura = capturarErros();
  try {
    for (const nome of ASSINCRONAS) assert.equal(await acoes[nome](), undefined, nome);
  } finally { captura.restaurar(); }
  assert.deepEqual(captura.erros, ASSINCRONAS.map(nome => `${nome}: ${MENSAGEM}`));
});

test("as ações síncronas não mascaram o erro do painel: o que o painel lança sobe ao chamador", () => {
  const falha = new Error("falha sintética do painel");
  const acoes = criarUpload({
    ponteReact: (_painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async () => undefined])),
    ponteReactSincrona: (_painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => { throw falha; }])),
  });
  SINCRONAS.forEach(nome => assert.throws(() => acoes[nome](), erro => erro === falha, nome));
});

// Pontes reais de frontend/src/legado/app.js, com o painel real montado pelo harness (mountReactPanelsBf2).
test("no app real as ações da ponte chegam ao painel React e devolvem o retorno dele", async () => {
  const harness = createAppHarness(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const painel = harness.context.window.SimpressReact[PAINEL];
  assert.deepEqual(Object.keys(painel).sort(), [...SINCRONAS, ...ASSINCRONAS].sort());

  const chamadas = [];
  for (const nome of [...SINCRONAS, ...ASSINCRONAS]) {
    painel[nome] = (...argumentos) => { chamadas.push([nome, argumentos]); return `painel:${nome}`; };
  }
  harness.run("0");
  const ponte = harness.context;
  const dado = { id: "arg-sintetico" };
  for (const nome of SINCRONAS) assert.equal(ponte[nome](dado), `painel:${nome}`, nome);
  for (const nome of ASSINCRONAS) assert.equal(await ponte[nome](dado), `painel:${nome}`, nome);
  assert.deepEqual(chamadas, [...SINCRONAS, ...ASSINCRONAS].map(nome => [nome, [dado]]));
});

test("no app real, sem o painel, as ações síncronas registram o erro, devolvem undefined e não lançam", () => {
  const harness = createAppHarness(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  delete harness.context.window.SimpressReact[PAINEL];
  // O vm do harness tem console próprio (stub): captura nele, não no console do Node.
  const erros = [];
  harness.context.console.error = erro => erros.push(erro);
  const retornos = SINCRONAS.map(nome => harness.context[nome]());
  assert.deepEqual(retornos, SINCRONAS.map(() => undefined));
  assert.equal(erros.length, SINCRONAS.length);
  erros.forEach(erro => {
    assert.equal(Object.prototype.toString.call(erro), "[object Error]"); // o Error nasce no vm: instanceof falha entre realms
    assert.equal(erro.message, MENSAGEM);
  });
});
