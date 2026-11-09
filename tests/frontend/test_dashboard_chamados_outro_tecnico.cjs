// Aviso do sino "Chamados finalizados por outro técnico": só apresentação do total que /api/painel já traz.
const test = require("node:test");
const assert = require("node:assert/strict");
const createDashboard = require("../../static/js/features/dashboard.js");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const transferUtils = require("../../static/js/shared/transfer-utils.js");

const ID = "alerta-chamados-outro-tecnico";
const TEXTO = "Confira no SoftExpert e marque Conferido na aba OS (F6).";

function montar() {
  const texto = { textContent: "" };
  const card = { hidden: true, dataset: {}, querySelector: () => texto, addEventListener() {} };
  const ouvintes = {};
  const doc = {
    getElementById: id => (id === ID ? card : null),
    addEventListener: (tipo, funcao) => { ouvintes[tipo] = funcao; },
    createElement: () => ({ textContent: "" }),
  };
  const previous = global.document;
  global.document = doc;
  const dashboard = createDashboard({ app: {}, transferUtils, motion: {}, dom: createDomUtils(doc) });
  return { card, texto, ouvintes, dashboard, restaurar: () => { global.document = previous; } };
}

test("com total maior que zero o aviso aparece com o texto aprovado", () => {
  const cena = montar();
  try {
    cena.dashboard.renderizarAlertaChamadosOutroTecnico({ total: 2, itens: [{ chamado: "UTIC-2026-1", serie: "S1", os: "9001", motivo: "saiu_do_dashboard" }] });
    assert.equal(cena.card.hidden, false);
    assert.equal(cena.texto.textContent, TEXTO);
    assert.equal(cena.card.dataset.enter, "true");
  } finally { cena.restaurar(); }
});

test("total 0, indisponível ou sem dados escondem o aviso", () => {
  const cena = montar();
  try {
    for (const info of [{ total: 0, itens: [] }, { indisponivel: true, total: 3 }, { indisponivel: true }, null, undefined, "x"]) {
      cena.card.hidden = false;
      cena.dashboard.renderizarAlertaChamadosOutroTecnico(info);
      assert.equal(cena.card.hidden, true, JSON.stringify(info));
    }
  } finally { cena.restaurar(); }
});

test("o evento do painel liga o aviso; sem o campo ele some", () => {
  const cena = montar();
  try {
    cena.dashboard.inicializarAlertasOsDivergencias();
    const evento = detail => ({ detail });
    cena.ouvintes["simpress:painel-atualizado"](evento({ chamados_outro_tecnico: { total: 1, itens: [] } }));
    assert.equal(cena.card.hidden, false);
    cena.ouvintes["simpress:painel-atualizado"](evento({}));
    assert.equal(cena.card.hidden, true);
  } finally { cena.restaurar(); }
});
