const test = require("node:test");
const assert = require("node:assert/strict");
const createDashboard = require("../../static/js/features/dashboard.js");
const transferUtils = require("../../static/js/shared/transfer-utils.js");

for (const oldFails of [false, true]) test(`estatísticas: ${oldFails ? "erro" : "resposta"} antigo não substitui atualização recente`, async () => {
  const elements = Object.fromEntries(["stat-equipamentos", "stat-base-dot", "stat-equipamentos-rotulo", "stat-unidades", "btn-exportar-equipamentos"].map(id => [id, {
    textContent: "", dataset: {}, classList: { toggle(name, value) { this[name] = value; } }, title: "",
  }]));
  const previousDocument = global.document;
  const previousFetch = global.fetch;
  const previousWarn = console.warn;
  const pending = [];
  global.document = { getElementById: id => elements[id] || null };
  global.fetch = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  console.warn = () => {};
  try {
    const dashboard = createDashboard({ app: {}, transferUtils, motion: {}, dom: { pluralize: n => `${n} equipamentos` } });
    const older = dashboard.carregarEstatisticas();
    const newer = dashboard.carregarEstatisticas();
    pending[1].resolve({ ok: true, json: async () => ({ total_equipamentos: 20, total_unidades: 3, exportacao_disponivel: true, total_alteracoes_exportaveis: 1 }) });
    await newer;
    if (oldFails) pending[0].reject(new Error("falha antiga"));
    else pending[0].resolve({ ok: true, json: async () => ({ total_equipamentos: 10, total_unidades: 2, exportacao_disponivel: true, total_alteracoes_exportaveis: 0 }) });
    await older;
    assert.equal(elements["stat-equipamentos"].textContent, "20");
    assert.equal(elements["btn-exportar-equipamentos"].classList.hidden, false);
  } finally {
    global.document = previousDocument;
    global.fetch = previousFetch;
    console.warn = previousWarn;
  }
});
