// Chips da última leitura dos antigos (leitura-loja.ts), escritos por estado.ts: textos, popover de falhas, leitura em
// andamento e corridas (POST recusado, resultado novo sem falhas). DOM falso e apiFetch simulado; só dados sintéticos.
// Esc e clique fora (ouvintes no document) são provados no e2e (tests/e2e/sebrae-dashboard.spec.cjs, "chips da última leitura").
const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const sebraeDashboardModel = require("../../frontend/src/comum/sebrae-dashboard-model.ts");
const { criarDashboardSebrae } = require("../../frontend/src/paineis/sebrae-dashboard/estado.ts");
const { criarLojaLeitura, chipsLeitura } = require("../../frontend/src/paineis/sebrae-dashboard/leitura-loja.ts");

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
function montar({ respostas, post = async () => ({ iniciado: true }) }) {
  const doc = createFakeDocument();
  const antigoDoc = global.document;
  const antigaJanela = global.window;
  doc.getElementById = id => {
    let no = doc.root.querySelectorAll(`[id="${id}"]`)[0];
    if (!no) { no = doc.createElement(id.startsWith("btn-") ? "button" : "div"); no.setAttribute("id", id); doc.body.append(no); }
    return no;
  };
  global.document = doc;
  global.window = { setTimeout, clearTimeout, localStorage: null };
  const toasts = [];
  const apiFetch = async (url, opcoes = {}) => {
    if (url === "/api/sebrae/antigos/ler") {
      if (opcoes.method === "POST") return post();
      return respostas.length > 1 ? respostas.shift() : respostas[0];
    }
    return structuredClone(CARGA);
  };
  const loja = criarLojaLeitura();
  const app = { apiFetch, showToast: (texto, tipo) => toasts.push({ texto, tipo }), confirmarAcao: async () => true };
  const dom = { createTextElement: (tag, classe, texto) => { const no = doc.createElement(tag); no.className = classe || ""; no.textContent = texto; return no; } };
  const feature = criarDashboardSebrae({ app, dom, sebraeDashboardModel: { ...sebraeDashboardModel, INTERVALO_FECHAR_MS: 0 }, lojaLeitura: loja });
  return { feature, loja, toasts, doc, restaurar() { global.document = antigoDoc; global.window = antigaJanela; } };
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
