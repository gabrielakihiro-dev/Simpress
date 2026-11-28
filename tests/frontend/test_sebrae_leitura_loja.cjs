// Chips da última leitura dos antigos (leitura-loja.ts), escritos por estado.ts: textos, popover de falhas, leitura em
// andamento e corridas (POST recusado, resultado novo sem falhas). DOM falso e apiFetch simulado; só dados sintéticos.
// Esc e clique fora (ouvintes no document) são provados no e2e (tests/e2e/sebrae-dashboard.spec.cjs, "chips da última leitura").
// No fim, as lojas dos avisos dos novos e do rascunho (lojas.ts), escritas por renderizarAvisos e mostrarRascunho.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const sebraeDashboardModel = require("../../frontend/src/comum/sebrae-dashboard-model.ts");
const { criarDashboardSebrae } = require("../../frontend/src/paineis/sebrae-dashboard/estado.ts");
const { criarLojaLeitura, chipsLeitura } = require("../../frontend/src/paineis/sebrae-dashboard/leitura-loja.ts");
const { criarLojaAvisos, criarLojaRascunho } = require("../../frontend/src/paineis/sebrae-dashboard/lojas.ts");

const COM_FALHAS = { em: "2026-10-28T10:40:00-03:00", concluido: true, lidos: ["UTIC-2026-1"], falhas: { "UTIC-2026-2": "Página não abriu.", "UTIC-2026-3": "Sem acesso." }, sem_utic: 1 };
const SEM_FALHAS = { em: "2026-10-28T11:00:00-03:00", concluido: true, lidos: ["UTIC-2026-2", "UTIC-2026-3"], falhas: {}, sem_utic: 0 };
const CARGA = { importado: { abertos: [], finalizados: [], listas: {} }, novos: { formulario: [], pendentes: [], erros: {} } };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test("chipsLeitura: horário, plural, interrompida e chips vazios", () => {
  const c = chipsLeitura(COM_FALHAS);
  assert.match(c.hora, /^\d\d\/\d\d \d\d:\d\d$/);
  assert.equal(c.lidos, "1 lido");
  assert.equal(c.textoFalhas, "2 falhas");
  assert.deepEqual(c.falhas, [["UTIC-2026-2", "Página não abriu."], ["UTIC-2026-3", "Sem acesso."]]);
  assert.equal(c.semUtic, "1 sem UTIC");
  const interrompida = chipsLeitura({ concluido: false, lidos: [], falhas: { X: 7 }, sem_utic: 0 });
  assert.equal(interrompida.hora, "interrompida");
  assert.match(chipsLeitura({ ...COM_FALHAS, concluido: false }).hora, / · interrompida$/);
  assert.equal(interrompida.lidos, "0 lidos");
  assert.equal(interrompida.textoFalhas, "1 falha");
  assert.deepEqual(interrompida.falhas, [["X", "7"]]);
  assert.equal(interrompida.semUtic, "");
  assert.deepEqual(chipsLeitura(null), { hora: "", lidos: "", falhas: [], textoFalhas: "", semUtic: "" });
});

// `respostas` é a fila de GET /api/sebrae/antigos/ler; `post` responde (ou lança) o POST.
function montar({ respostas = [{ em_andamento: false, resultado: null }], post = async () => ({ iniciado: true }), carga = CARGA, armazenamento = null } = {}) {
  const doc = createFakeDocument();
  const antigoDoc = global.document;
  const antigaJanela = global.window;
  doc.getElementById = id => {
    let no = doc.root.querySelectorAll(`[id="${id}"]`)[0];
    if (!no) { no = doc.createElement(id.startsWith("btn-") ? "button" : "div"); no.setAttribute("id", id); doc.body.append(no); }
    return no;
  };
  global.document = doc;
  const ouvintesJanela = {};
  global.window = { setTimeout, clearTimeout, localStorage: armazenamento, addEventListener: (tipo, ouvinte) => { ouvintesJanela[tipo] = ouvinte; } };
  const toasts = [];
  const apiFetch = async (url, opcoes = {}) => {
    if (url === "/api/sebrae/antigos/ler") {
      if (opcoes.method === "POST") return post();
      return respostas.length > 1 ? respostas.shift() : respostas[0];
    }
    return structuredClone(carga);
  };
  const loja = criarLojaLeitura();
  const lojaAvisos = criarLojaAvisos();
  const lojaRascunho = criarLojaRascunho();
  const app = { apiFetch, showToast: (texto, tipo) => toasts.push({ texto, tipo }), confirmarAcao: async () => true };
  const dom = { createTextElement: (tag, classe, texto) => { const no = doc.createElement(tag); no.className = classe || ""; no.textContent = texto; return no; } };
  const feature = criarDashboardSebrae({ app, dom, sebraeDashboardModel: { ...sebraeDashboardModel, INTERVALO_FECHAR_MS: 0 }, lojaLeitura: loja, lojaAvisos, lojaRascunho });
  return { feature, loja, lojaAvisos, lojaRascunho, ouvintesJanela, toasts, doc, restaurar() { global.document = antigoDoc; global.window = antigaJanela; } };
}

test("carregar a lista põe o último resultado na loja; o chip de falhas abre e fecha o popover", async () => {
  const { feature, loja, doc, restaurar } = montar({ respostas: [{ em_andamento: false, resultado: COM_FALHAS }] });
  try {
    assert.deepEqual(loja.ler(), { resultado: null, falhasAbertas: false });
    await feature.carregarNovosSebrae();
    await tick();
    assert.deepEqual(loja.ler().resultado, COM_FALHAS);
    assert.equal(loja.ler().falhasAbertas, false);
    doc.getElementById("btn-sebrae-falhas").click();
    assert.equal(loja.ler().falhasAbertas, true);
    doc.getElementById("btn-sebrae-falhas").click();
    assert.equal(loja.ler().falhasAbertas, false);
  } finally { restaurar(); }
});

test("Ler chamados antigos: em andamento os chips somem; o resultado novo sem falhas fecha o popover aberto", async () => {
  const respostas = [{ em_andamento: false, resultado: COM_FALHAS }];
  const { feature, loja, doc, toasts, restaurar } = montar({ respostas });
  try {
    await feature.carregarNovosSebrae();
    await tick();
    doc.getElementById("btn-sebrae-falhas").click();
    assert.equal(loja.ler().falhasAbertas, true);
    // Do POST em diante: 1.º GET andando, 2.º concluído sem falhas (e a recarga final repete o último).
    respostas.splice(0, 1, { em_andamento: true, resultado: COM_FALHAS }, { em_andamento: false, resultado: SEM_FALHAS });
    const vistos = [];
    const parar = loja.assinar(() => vistos.push(loja.ler()));
    await feature.lerAntigosSebrae();
    assert.equal(vistos[0].resultado, null, "começou: chips ocultos");
    assert.equal(vistos[0].falhasAbertas, false, "sem falhas na tela, o popover fecha");
    for (let i = 0; i < 20 && loja.ler().resultado !== SEM_FALHAS; i += 1) await tick();
    parar();
    assert.equal(loja.ler().resultado, SEM_FALHAS);
    assert.equal(loja.ler().falhasAbertas, false);
    assert.ok(toasts.some(t => t.tipo === "success"));
  } finally { restaurar(); }
});

test("POST recusado (409) mantém os chips do resultado anterior e o popover como estava", async () => {
  const erro = Object.assign(new Error("Já há uma rotina em andamento."), { status: 409 });
  const { feature, loja, doc, toasts, restaurar } = montar({ respostas: [{ em_andamento: false, resultado: COM_FALHAS }], post: async () => { throw erro; } });
  try {
    await feature.carregarNovosSebrae();
    await tick();
    doc.getElementById("btn-sebrae-falhas").click();
    await feature.lerAntigosSebrae();
    assert.equal(loja.ler().resultado, COM_FALHAS);
    assert.equal(loja.ler().falhasAbertas, true);
    assert.deepEqual(toasts.at(-1), { texto: "Já há uma rotina em andamento.", tipo: "warning" });
  } finally { restaurar(); }
});

// ---- Avisos dos novos e rascunho ----
const IMPORTADO = { ...CARGA.importado, importado_em: "2026-10-28T10:00:00-03:00" };
const COM_AVISOS = { importado: IMPORTADO, novos: { formulario: [], pendentes: [{ numero: "UTIC-2026-7", motivo: "Sem série." }], erros: { "UTIC-2026-8": "Página não abriu." } } };
function armazenamentoFalso(inicial = {}) {
  const dados = { ...inicial };
  return { get length() { return Object.keys(dados).length; }, key: i => Object.keys(dados)[i] ?? null, getItem: k => (k in dados ? dados[k] : null), setItem: (k, v) => { dados[k] = String(v); }, removeItem: k => { delete dados[k]; } };
}

test("avisos: pendentes e não lidos vão para a loja na ordem da tela; recarga sem avisos esvazia", async () => {
  const montagem = montar({ carga: COM_AVISOS });
  try {
    assert.deepEqual(montagem.lojaAvisos.ler(), { itens: [] });
    await montagem.feature.carregarNovosSebrae();
    assert.deepEqual(montagem.lojaAvisos.ler().itens, ["UTIC-2026-7: pendente. Sem série.", "UTIC-2026-8: não foi lido. Página não abriu."]);
  } finally { montagem.restaurar(); }
  const vazia = montar();
  try {
    vazia.lojaAvisos.atualizar({ itens: ["antigo"] });
    await vazia.feature.carregarNovosSebrae();
    assert.deepEqual(vazia.lojaAvisos.ler().itens, []);
  } finally { vazia.restaurar(); }
});

test("rascunho: carga sem rascunho deixa o bloco sem texto; sem correspondência lista o chamado; outra aba e descartar trocam o texto", async () => {
  const disco = armazenamentoFalso({ "simpress:sebrae-rascunho": JSON.stringify({ importado_em: "outra", valores: { "UTIC-2026-9999": { A: "CLIENTE" } }, edicoes: {} }) });
  const montagem = montar({ carga: { ...CARGA, importado: IMPORTADO }, armazenamento: disco });
  try {
    assert.deepEqual(montagem.lojaRascunho.ler(), { texto: "", situacao: "", detalhes: [], versao: 0 }, "antes da primeira carga o partial fica como veio");
    await montagem.feature.carregarNovosSebrae();
    const r = montagem.lojaRascunho.ler();
    assert.equal(r.texto, "Rascunhos preservados sem correspondência nesta importação (1).");
    assert.equal(r.situacao, "alerta");
    assert.deepEqual(r.detalhes, [{ numero: "UTIC-2026-9999", campos: [["A", "CLIENTE"]] }]);
    const versao = r.versao;
    assert.ok(versao >= 2, "renderizar chamou mostrarRascunho mais de uma vez (cada uma recolhe a lista)");
    montagem.ouvintesJanela.storage({ key: "simpress:sebrae-rascunho" });
    assert.equal(montagem.lojaRascunho.ler().situacao, "alerta");
    assert.match(montagem.lojaRascunho.ler().texto, /^O rascunho mudou em outra aba/);
    assert.deepEqual(montagem.lojaRascunho.ler().detalhes, []);
    assert.equal(montagem.lojaRascunho.ler().versao, versao + 1);
    await montagem.feature.descartarRascunhoSebrae();
    assert.equal(montagem.lojaRascunho.ler().texto, "Rascunho descartado.");
    assert.equal(montagem.lojaRascunho.ler().situacao, "");
  } finally { montagem.restaurar(); }
  const limpa = montar({ carga: { ...CARGA, importado: IMPORTADO } });
  try {
    await limpa.feature.carregarNovosSebrae();
    assert.equal(limpa.lojaRascunho.ler().texto, "");
    assert.equal(limpa.lojaRascunho.ler().versao, 1);
  } finally { limpa.restaurar(); }
});
