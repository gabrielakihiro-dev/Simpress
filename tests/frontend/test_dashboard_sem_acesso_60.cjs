const test = require("node:test");
const assert = require("node:assert/strict");
const createDashboard = require("../../static/js/features/dashboard.js");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const transferUtils = require("../../static/js/shared/transfer-utils.js");

function render(info) {
  const make = () => ({
    hidden: true, dataset: {}, textContent: "", children: [],
    replaceChildren(...items) { this.children = items; },
    querySelector() { return null; },
  });
  const elements = {
    "alerta-sem-acesso-60": make(), "alerta-sem-acesso-60-lista": make(),
    "alerta-sem-acesso-60-selo": make(), "alerta-sem-acesso-60-titulo": make(),
  };
  const previous = global.document;
  global.document = { getElementById: id => elements[id] || null, createElement: () => ({ textContent: "" }) };
  try {
    const dom = createDomUtils(global.document);
    createDashboard({ app: {}, transferUtils, motion: {}, dom }).renderizarAlertaSemAcesso60(info);
  } finally {
    global.document = previous;
  }
  return elements;
}

const item = (serie, computador, dias, situacao = "limite") => ({ serie, computador, dias, situacao });

test("sem acesso 60: lista mostra 5 linhas, 'e mais N' e 'Sem identificação'", () => {
  const equipamentos = [
    item("S1", "PC1", 70, "passou"), item("", "", 66, "passou"), item("S3", "", 61, "saiu_endpoint"),
    item("S4", "PC4", 58), item("S5", "PC5", 57), item("S6", "PC6", 56), item("S7", "PC7", 56),
  ];
  const els = render({ estado: "passou_60", limite_aviso_dias: 55, limite_dias: 60, total_limite: 4, total_passou: 3, total_saiu_endpoint: 1, equipamentos });
  assert.equal(els["alerta-sem-acesso-60"].hidden, false);
  assert.deepEqual(els["alerta-sem-acesso-60-lista"].children.map(li => li.textContent), [
    "S1 · PC1 — 70 dias", "Sem identificação — 66 dias", "S3 — ~61 dias (saiu para Ausentes no Endpoint)",
    "S4 · PC4 — 58 dias", "S5 · PC5 — 57 dias", "e mais 2",
  ]);
  assert.equal(els["alerta-sem-acesso-60-lista"].hidden, false);
});

test("sem acesso 60: estado em_dia esconde o cartão", () => {
  const els = render({ estado: "em_dia", equipamentos: [] });
  assert.equal(els["alerta-sem-acesso-60"].hidden, true);
});
