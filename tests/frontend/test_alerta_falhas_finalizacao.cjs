// Aviso do sino "Falha ao finalizar no SoftExpert": só apresentação do que /api/painel já traz (número UTIC e código fixo).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { criarIndicadoresHome: createDashboard } = require("../../frontend/src/paineis/indicadores-home/estado.ts");
const { createDomUtils } = require("../../frontend/src/comum/dom-utils.ts");
const transferUtils = require("../../frontend/src/comum/transfer-utils.ts");

const ID = "alerta-finalizacao-softexpert";
const DICA = "Confira no SoftExpert se o chamado já foi finalizado antes de tentar de novo.";

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

test("lista os chamados que falharam, com o motivo legível, e orienta a F5", () => {
  const cena = montar();
  try {
    cena.dashboard.renderizarAlertaFalhasFinalizacao({ total: 3, itens: [
      { numero: "UTIC-2026-1", motivo: "tempo_esgotado" }, { numero: "UTIC-2026-2", motivo: "erro" }, { numero: "", motivo: "sharepoint" },
    ] });
    assert.equal(cena.card.hidden, false);
    assert.equal(cena.card.dataset.enter, "true");
    assert.equal(cena.texto.textContent,
      `2 chamados não foram finalizados no SoftExpert: UTIC-2026-1 (tempo esgotado), UTIC-2026-2. O envio do Dashboard ao SharePoint falhou ou ficou incerto. ${DICA}`);
  } finally { cena.restaurar(); }
});

test("rotina interrompida e um só chamado com sessão expirada", () => {
  const cena = montar();
  try {
    cena.dashboard.renderizarAlertaFalhasFinalizacao({ total: 1, itens: [{ numero: "", motivo: "interrompida" }] });
    assert.equal(cena.texto.textContent, `A finalização parou no meio (tempo esgotado ou rotina encerrada). ${DICA}`);
    cena.dashboard.renderizarAlertaFalhasFinalizacao({ total: 1, itens: [{ numero: "UTIC-2026-3", motivo: "sessao_expirada" }] });
    assert.equal(cena.texto.textContent, `1 chamado não foi finalizado no SoftExpert: UTIC-2026-3 (sessão expirada). ${DICA}`);
  } finally { cena.restaurar(); }
});

test("R não gravado no Dashboard: finalizado, sem contar como falha de finalização", () => {
  const cena = montar();
  try {
    cena.dashboard.renderizarAlertaFalhasFinalizacao({ total: 2, itens: [{ numero: "UTIC-2026-4", motivo: "planilha" }, { numero: "UTIC-2026-5", motivo: "planilha" }] });
    assert.equal(cena.texto.textContent, `UTIC-2026-4, UTIC-2026-5: a DT ENCERRAMENTO não foi gravada no Dashboard. ${DICA}`);
    cena.dashboard.renderizarAlertaFalhasFinalizacao({ total: 2, itens: [{ numero: "UTIC-2026-6", motivo: "erro" }, { numero: "", motivo: "planilha" }] });
    assert.equal(cena.texto.textContent,
      `1 chamado não foi finalizado no SoftExpert: UTIC-2026-6. A DT ENCERRAMENTO não foi gravada no Dashboard. ${DICA}`);
  } finally { cena.restaurar(); }
});

test("total 0, indisponível, sem itens ou sem dados escondem o aviso", () => {
  const cena = montar();
  try {
    for (const info of [{ total: 0, itens: [] }, { indisponivel: true, total: 1, itens: [{ numero: "UTIC-2026-1", motivo: "erro" }] },
      { total: 1, itens: [] }, { total: 1, itens: [null] }, null, undefined, "x"]) {
      cena.card.hidden = false;
      cena.dashboard.renderizarAlertaFalhasFinalizacao(info);
      assert.equal(cena.card.hidden, true, JSON.stringify(info));
    }
  } finally { cena.restaurar(); }
});

test("o evento do painel liga o aviso; sem o campo ele some", () => {
  const cena = montar();
  try {
    cena.dashboard.inicializarAlertasOsDivergencias();
    const evento = detail => ({ detail });
    cena.ouvintes["simpress:painel-atualizado"](evento({ falhas_finalizacao_softexpert: { total: 1, itens: [{ numero: "UTIC-2026-1", motivo: "erro" }] } }));
    assert.equal(cena.card.hidden, false);
    cena.ouvintes["simpress:painel-atualizado"](evento({}));
    assert.equal(cena.card.hidden, true);
  } finally { cena.restaurar(); }
});

test("o cartão está no sino e leva à aba Chamados (F5)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "static", "index.html"), "utf8");
  const cartao = html.match(/<section id="alerta-finalizacao-softexpert"[\s\S]*?<\/section>/);
  assert.ok(cartao, "cartão ausente do index.html");
  assert.match(cartao[0], /Falha ao finalizar no SoftExpert/);
  assert.match(cartao[0], /data-on-click="abrirPainelCockpit" data-args='\["sebrae-chamados"\]'/);
  const sino = html.slice(html.indexOf('id="notification-center-panel"'), html.indexOf('id="cockpit-tools-dropdown"'));
  assert.ok(sino.includes('id="alerta-finalizacao-softexpert"'), "o cartão fica dentro do painel do sino");
});
