// Cartão do sino #alerta-lembretes-agendados: só apresentação de `lembretes_agendados` do /api/painel (números, nunca texto de lembrete).
const assert = require("node:assert/strict");
const test = require("node:test");
const { assembledHtml } = require("./support/assembled-html.cjs");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const { criarIndicadoresHome: createDashboard } = require("../../frontend/src/paineis/indicadores-home/estado.ts");
const { createDomUtils } = require("../../frontend/src/comum/dom-utils.ts");
const transferUtils = require("../../frontend/src/comum/transfer-utils.ts");
const panels = require("../../frontend/src/paineis/paineis-dados/paineis.ts");

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
    for (const entrada of [dados(0, 0), dados(2, 1, { indisponivel: true }), undefined, null, "x", { total: -3, atrasados: 1, hoje: 0 }, { total: "abc" }]) {
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
panels.install({
  document: doc,
  MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  console: { warn() {} },
  fetch: async () => ({ ok: true, json: async () => resposta }),
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
