// Cartão do sino #alerta-hostnames-atualizados: só apresentação de `hostnames_atualizados` do /api/painel (dados sintéticos).
const assert = require("node:assert/strict");
const test = require("node:test");
const { assembledHtml } = require("./support/assembled-html.cjs");
const { criarIndicadoresHome: createDashboard } = require("../../frontend/src/paineis/indicadores-home/estado.ts");
const { createDomUtils } = require("../../frontend/src/comum/dom-utils.ts");
const transferUtils = require("../../frontend/src/comum/transfer-utils.ts");

const html = assembledHtml();

function criarElemento() {
  const ouvintes = {};
  return {
    hidden: true, dataset: {}, textContent: "", children: [], ouvintes,
    querySelector() { return this; },
    addEventListener(tipo, funcao) { ouvintes[tipo] = funcao; },
    replaceChildren(...itens) { this.children = itens; },
  };
}

function montar() {
  const card = criarElemento();
  const lista = criarElemento();
  const elementos = { "alerta-hostnames-atualizados": card, "alerta-hostnames-atualizados-lista": lista };
  const ouvintes = {};
  const doc = {
    getElementById: id => elementos[id] || null,
    addEventListener: (tipo, funcao) => { ouvintes[tipo] = funcao; },
    createElement: () => ({ textContent: "", dataset: {}, append(filho) { this.filho = filho; } }),
  };
  const anterior = global.document;
  global.document = doc;
  const aberturas = [];
  const dashboard = createDashboard({
    app: { abrirComparacaoDaSerie: (...args) => aberturas.push(args) },
    transferUtils, motion: {}, dom: createDomUtils(doc),
  });
  dashboard.inicializarAlertasOsDivergencias();
  const painel = detalhe => ouvintes["simpress:painel-atualizado"]({ detail: detalhe });
  return { card, lista, aberturas, painel, restaurar: () => { global.document = anterior; } };
}

test("o partial traz o cartão com título curto e a lista, escondidos", () => {
  assert.match(html, /<section id="alerta-hostnames-atualizados"[^>]*hidden>/);
  assert.match(html, /Hostname atualizado pelo Endpoint/);
  assert.match(html, /<ul id="alerta-hostnames-atualizados-lista"[^>]*hidden>/);
});

test("com total > 0 mostra uma linha por série e o clique abre a Comparação na série, com realce", () => {
  const cena = montar();
  try {
    cena.painel({ hostnames_atualizados: { total: 2, itens: [
      { serie: "BRJ100AAAA", hostname_anterior: "PRNOTE001", hostname_novo: "PRNOTE002" },
      { serie: "BRJ100BBBB", hostname_anterior: "PRNOTE003", hostname_novo: "PRNOTE004" },
    ] } });
    assert.equal(cena.card.hidden, false);
    assert.match(cena.card.textContent, /^2 séries mudaram de hostname\./);
    assert.deepEqual(cena.lista.children.map(li => li.filho.textContent), [
      "BRJ100AAAA: PRNOTE001 → PRNOTE002", "BRJ100BBBB: PRNOTE003 → PRNOTE004",
    ]);
    assert.equal(cena.lista.hidden, false);
    cena.lista.ouvintes.click({ target: { closest: () => ({ dataset: { serie: "BRJ100BBBB" } }) } });
    assert.deepEqual(cena.aberturas, [["BRJ100BBBB", "registros_ambiguos", true]]);
  } finally { cena.restaurar(); }
});

test("sem total, ou com total 0, o cartão some", () => {
  const cena = montar();
  try {
    cena.painel({ hostnames_atualizados: { total: 1, itens: [{ serie: "BRJ100AAAA", hostname_anterior: "A", hostname_novo: "B" }] } });
    assert.equal(cena.card.hidden, false);
    cena.painel({ hostnames_atualizados: { total: 0, itens: [] } });
    assert.equal(cena.card.hidden, true);
    cena.painel({});
    assert.equal(cena.card.hidden, true);
  } finally { cena.restaurar(); }
});
