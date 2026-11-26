// Cartão do sino #alerta-lembretes-agendados: só apresentação de `lembretes_agendados` do /api/painel (números, nunca texto de lembrete).
const assert = require("node:assert/strict");
const test = require("node:test");
const { assembledHtml } = require("./support/assembled-html.cjs");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const { criarIndicadoresHome: createDashboard } = require("../../frontend/src/paineis/indicadores-home/estado.ts");
const { createDomUtils } = require("../../frontend/src/comum/dom-utils.ts");
const transferUtils = require("../../frontend/src/comum/transfer-utils.ts");
const panels = require("../../frontend/src/paineis/paineis-dados/paineis.ts");
const { contagemLembretesAgendados, painelCompartilhado } = require("../../frontend/src/paineis/paineis-dados/utilitarios.ts");

const html = assembledHtml();
const dados = (atrasados, hoje, extra = {}) => ({ total: atrasados + hoje, atrasados, hoje, indisponivel: false, ...extra });

function montarCartao() {
  const texto = { textContent: "" };
  const card = { hidden: true, dataset: { gravidade: "urgente" }, querySelector: () => texto, addEventListener() {} };
  const selo = { dataset: { status: "erro" }, textContent: "Urgente" };
  const elementos = { "alerta-lembretes-agendados": card, "alerta-lembretes-agendados-selo": selo };
  const ouvintes = {};
  const doc = {
    getElementById: id => elementos[id] || null,
    addEventListener: (tipo, funcao) => { ouvintes[tipo] = funcao; },
    createElement: () => ({ textContent: "" }),
  };
  const anterior = global.document;
  global.document = doc;
  const dashboard = createDashboard({ app: {}, transferUtils, motion: {}, dom: createDomUtils(doc) });
  return { card, texto, selo, ouvintes, dashboard, restaurar: () => { global.document = anterior; } };
}

test("urgente quando há atrasados; texto só com números e plural correto", () => {
  const cena = montarCartao();
  try {
    const casos = [
      [dados(2, 0), "2 lembretes atrasados."],
      [dados(1, 0), "1 lembrete atrasado."],
      [dados(2, 1), "2 atrasados e 1 para hoje."],
      [dados(1, 3), "1 atrasado e 3 para hoje."],
    ];
    for (const [entrada, esperado] of casos) {
      cena.dashboard.renderizarAlertaLembretes(entrada);
      assert.equal(cena.card.hidden, false);
      assert.equal(cena.card.dataset.gravidade, "urgente");
      assert.equal(cena.selo.dataset.status, "erro");
      assert.equal(cena.selo.textContent, "Urgente");
      assert.equal(cena.texto.textContent, esperado);
    }
    assert.equal(cena.card.dataset.enter, "true");
  } finally { cena.restaurar(); }
});

test("atenção quando só há lembretes para hoje", () => {
  const cena = montarCartao();
  try {
    cena.dashboard.renderizarAlertaLembretes(dados(0, 3));
    assert.equal(cena.card.hidden, false);
    assert.equal(cena.card.dataset.gravidade, "atencao");
    assert.equal(cena.selo.dataset.status, "alerta");
    assert.equal(cena.selo.textContent, "Atenção");
    assert.equal(cena.texto.textContent, "3 lembretes para hoje.");
    cena.dashboard.renderizarAlertaLembretes(dados(0, 1));
    assert.equal(cena.texto.textContent, "1 lembrete para hoje.");
    cena.dashboard.renderizarAlertaLembretes(dados(1, 0));
    assert.equal(cena.card.dataset.gravidade, "urgente", "volta a urgente com atrasado");
  } finally { cena.restaurar(); }
});

test("escondido com total 0, indisponível, ausente ou inválido", () => {
  const cena = montarCartao();
  try {
    for (const entrada of [dados(0, 0), dados(2, 1, { indisponivel: true }), undefined, null, "x", { total: "abc" }, { total: 5, atrasados: -1, hoje: "x" }]) {
      cena.dashboard.renderizarAlertaLembretes(dados(1, 0));
      assert.equal(cena.card.hidden, false);
      cena.dashboard.renderizarAlertaLembretes(entrada);
      assert.equal(cena.card.hidden, true, JSON.stringify(entrada));
    }
    cena.dashboard.renderizarAlertaLembretes(dados(0, 0, { indisponivel: true }));
    assert.equal(cena.card.dataset.state, "indisponivel");
  } finally { cena.restaurar(); }
});

test("nenhum texto além dos números: campos extras do objeto não aparecem", () => {
  const cena = montarCartao();
  try {
    cena.dashboard.renderizarAlertaLembretes(dados(1, 1, { descricao: "Fulano Fictício", termo: "entrega", id: "abc-123", nomes: ["Fulano Fictício"] }));
    const visivel = cena.texto.textContent;
    assert.equal(visivel, "1 atrasado e 1 para hoje.");
    assert.ok(!/Fulano|entrega|abc-123/.test(visivel));
  } finally { cena.restaurar(); }
});

test("listener simpress:painel-atualizado renderiza e esconde o cartão", () => {
  const cena = montarCartao();
  try {
    cena.dashboard.inicializarAlertasOsDivergencias();
    cena.ouvintes["simpress:painel-atualizado"]({ detail: { lembretes_agendados: dados(1, 0) } });
    assert.equal(cena.card.hidden, false);
    cena.ouvintes["simpress:painel-atualizado"]({ detail: {} });
    assert.equal(cena.card.hidden, true);
  } finally { cena.restaurar(); }
});

test("index: cartão no sino com ids, aria e botão que abre Lembretes, sem lista", () => {
  const sino = html.match(/<div class="ck-sino__lista">[\s\S]*?<\/section>\s*<\/div>\s*<\/section>/)?.[0] || "";
  const cartao = sino.match(/<section id="alerta-lembretes-agendados"[\s\S]*?<\/section>/)?.[0];
  assert.ok(cartao, "cartão dentro de .ck-sino__lista");
  assert.match(cartao, /class="ck-aviso" data-gravidade="urgente" role="status" aria-labelledby="alerta-lembretes-agendados-titulo" data-state="loading" hidden>/);
  for (const id of ["alerta-lembretes-agendados-selo", "alerta-lembretes-agendados-titulo", "alerta-lembretes-agendados-texto"]) assert.match(cartao, new RegExp(`id="${id}"`), id);
  assert.match(cartao, />Lembretes agendados<\/h3>/);
  assert.doesNotMatch(cartao, /<ul/);
  assert.match(cartao, /<button type="button" id="btn-alerta-lembretes-agendados" data-on-click="abrirPainelCockpit" data-args='\["lembretes"\]'[^>]*>Ver Lembretes<\/button>/);
});

// install() é de módulo único: este processo instala uma vez e muda só a resposta do /api/painel.
const doc = createFakeDocument();
const ouvintes = {};
doc.addEventListener = (tipo, funcao) => { ouvintes[tipo] = funcao; };
const no = (tag, id) => { const item = doc.createElement(tag); item.id = id; doc.body.append(item); return item; };
const botaoSino = no("button", "btn-notificacoes");
const seloSino = no("span", "badge-notificacoes");
seloSino.hidden = true;
no("section", "notification-center-panel");
no("p", "notification-center-summary");
const tituloSino = no("h2", "notification-center-title");
let resposta = {};
let fetchAtual = async () => ({ ok: true, json: async () => resposta });
panels.install({
  document: doc,
  MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  console: { warn() {} },
  fetch: (...args) => fetchAtual(...args),
});

async function atualizar(corpo) {
  resposta = corpo;
  await ouvintes["simpress:atualizar-notificacoes"]();
  for (let tentativa = 0; tentativa < 20; tentativa += 1) await new Promise(resolve => setImmediate(resolve));
}

test("badge do sino: lembretes contam 1 aviso, qualquer que seja a quantidade", async () => {
  await atualizar({});
  assert.equal(seloSino.textContent, "0");
  await atualizar({ lembretes_agendados: dados(5, 4) });
  assert.equal(seloSino.textContent, "1");
  assert.equal(seloSino.hidden, false);
  assert.equal(tituloSino.textContent, "Pendências · 1");
  assert.equal(botaoSino.getAttribute("aria-label"), "Notificações, 1 aviso ativo");
  await atualizar({ lembretes_agendados: dados(1, 0), chamados_outro_tecnico: { total: 2 } });
  assert.equal(seloSino.textContent, "2", "soma com os outros cartões");
  for (const l of [dados(0, 0), dados(2, 1, { indisponivel: true }), null]) {
    await atualizar({ lembretes_agendados: l });
    assert.equal(seloSino.textContent, "0", JSON.stringify(l));
    assert.equal(seloSino.hidden, true);
  }
});

test("total 2 sem atrasados nem hoje: cartão escondido e badge sem aviso", async () => {
  const fixture = { total: 2, atrasados: 0, hoje: 0, indisponivel: false };
  const cena = montarCartao();
  try {
    cena.dashboard.renderizarAlertaLembretes(dados(1, 0));
    cena.dashboard.renderizarAlertaLembretes(fixture);
    assert.equal(cena.card.hidden, true);
    assert.equal(cena.card.dataset.state, "vazio");
  } finally { cena.restaurar(); }
  await atualizar({ lembretes_agendados: fixture });
  assert.equal(seloSino.textContent, "0");
  assert.equal(seloSino.hidden, true);
});

test("contagemLembretesAgendados: fracionário, negativo, não numérico e entradas inválidas", () => {
  assert.deepEqual(contagemLembretesAgendados({ atrasados: 1.9, hoje: 0 }), { atrasados: 1, hoje: 0 });
  assert.deepEqual(contagemLembretesAgendados({ atrasados: -3, hoje: 2.5 }), { atrasados: 0, hoje: 2 });
  assert.deepEqual(contagemLembretesAgendados({ atrasados: "x", hoje: "3" }), { atrasados: 0, hoje: 3 });
  assert.deepEqual(contagemLembretesAgendados({ atrasados: Infinity, hoje: 1 }), { atrasados: 0, hoje: 1 });
  for (const entrada of [null, undefined, "x", 5, {}, { total: 9 }, { atrasados: -3, hoje: "x" }, { atrasados: 1, hoje: 1, indisponivel: true }]) {
    assert.equal(contagemLembretesAgendados(entrada), null, JSON.stringify(entrada));
  }
});

const adiada = () => { const d = {}; d.promessa = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };
const assentar = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };

test("painelCompartilhado: dois chamadores padrão dividem um só buscar", async () => {
  const d = adiada();
  let chamadas = 0;
  const buscar = () => { chamadas += 1; return d.promessa; };
  const a = painelCompartilhado(buscar);
  const b = painelCompartilhado(buscar);
  assert.equal(chamadas, 1);
  d.resolve({ n: 1 });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, { n: 1 });
  assert.notEqual(ra, rb, "cada chamador recebe a sua cópia");
  await assentar();
});

test("painelCompartilhado: novo espera o pedido em voo e busca uma vez", async () => {
  const d1 = adiada();
  const d2 = adiada();
  let chamadas = 0;
  const primeiro = painelCompartilhado(() => d1.promessa);
  const novo = painelCompartilhado(() => { chamadas += 1; return d2.promessa; }, { novo: true });
  await assentar();
  assert.equal(chamadas, 0, "não busca antes do primeiro resolver");
  d1.resolve("velho");
  await primeiro;
  await assentar();
  assert.equal(chamadas, 1);
  d2.resolve("novo");
  assert.equal(await novo, "novo");
  await assentar();
});

test("painelCompartilhado: chamador padrão depois do novo divide o pedido novo", async () => {
  const d1 = adiada();
  const d2 = adiada();
  let novas = 0;
  let extras = 0;
  const primeiro = painelCompartilhado(() => d1.promessa);
  const novo = painelCompartilhado(() => { novas += 1; return d2.promessa; }, { novo: true });
  const depois = painelCompartilhado(() => { extras += 1; return Promise.resolve("outro"); });
  d1.resolve("velho");
  await primeiro;
  await assentar();
  d2.resolve("novo");
  assert.deepEqual(await Promise.all([novo, depois]), ["novo", "novo"]);
  assert.equal(novas, 1);
  assert.equal(extras, 0);
  await assentar();
});

test("painelCompartilhado: se o primeiro falhar, o novo ainda busca", async () => {
  const d1 = adiada();
  let chamadas = 0;
  const primeiro = painelCompartilhado(() => d1.promessa);
  const novo = painelCompartilhado(() => { chamadas += 1; return Promise.resolve("novo"); }, { novo: true });
  d1.reject(new Error("falhou"));
  await assert.rejects(primeiro, /falhou/);
  assert.equal(await novo, "novo");
  assert.equal(chamadas, 1);
  await assentar();
});

test("painelCompartilhado: novo encadeia mesmo se o em voo já era novo", async () => {
  const d1 = adiada();
  const d2 = adiada();
  const d3 = adiada();
  let chamadas = 0;
  const a = painelCompartilhado(() => d1.promessa);
  const b = painelCompartilhado(() => { chamadas += 1; return d2.promessa; }, { novo: true });
  const c = painelCompartilhado(() => { chamadas += 10; return d3.promessa; }, { novo: true });
  d1.resolve(1);
  await a;
  await assentar();
  assert.equal(chamadas, 1, "o terceiro espera o segundo");
  d2.resolve(2);
  await b;
  await assentar();
  assert.equal(chamadas, 11);
  d3.resolve(3);
  assert.equal(await c, 3);
  await assentar();
});

// Integração do painel inteiro: evento -> refresh -> painelCompartilhado({ novo }) -> badge.
async function comFetchManual(corpo) {
  const pendentes = [];
  const anterior = fetchAtual;
  fetchAtual = () => { const d = adiada(); pendentes.push(d); return d.promessa; };
  try { await corpo(pendentes); } finally { fetchAtual = anterior; await assentar(); }
}
const respostaDe = painel => ({ ok: true, json: async () => painel });

test("evento com depoisDeMudanca busca de novo depois do GET em voo e o badge vem da 2ª resposta", async () => {
  await atualizar({});
  await comFetchManual(async pendentes => {
    const p1 = ouvintes["simpress:atualizar-notificacoes"]();
    await assentar();
    assert.equal(pendentes.length, 1, "1º GET em voo");
    const p2 = ouvintes["simpress:atualizar-notificacoes"](new CustomEvent("simpress:atualizar-notificacoes", { detail: { depoisDeMudanca: true } }));
    await assentar();
    assert.equal(pendentes.length, 1, "o pedido novo espera o 1º terminar");
    pendentes[0].resolve(respostaDe({ lembretes_agendados: { atrasados: 1, hoje: 0, total: 1, indisponivel: false } }));
    await assentar();
    assert.equal(pendentes.length, 2, "depois do 1º, busca de novo");
    assert.notEqual(seloSino.textContent, "1", "resposta antiga (com aviso) descartada (serial)");
    pendentes[1].resolve(respostaDe({ lembretes_agendados: dados(0, 0) }));
    await Promise.all([p1, p2]);
    await assentar();
    assert.notEqual(seloSino.textContent, "1", "badge final vem da 2ª resposta, sem o aviso da 1ª");
  });
});

test("dois eventos sem detail seguidos: um só GET (dedupe padrão preservado)", async () => {
  await atualizar({});
  await comFetchManual(async pendentes => {
    const a = ouvintes["simpress:atualizar-notificacoes"]();
    const b = ouvintes["simpress:atualizar-notificacoes"]();
    await assentar();
    assert.equal(pendentes.length, 1);
    pendentes[0].resolve(respostaDe({ lembretes_agendados: dados(0, 0) }));
    await Promise.all([a, b]);
    await assentar();
    assert.equal(pendentes.length, 1);
  });
});
