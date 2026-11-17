const test = require("node:test");
const assert = require("node:assert/strict");
const { criarIndicadoresHome: createDashboard } = require("../../frontend/src/paineis/indicadores-home/estado.ts");
const transferUtils = require("../../frontend/src/comum/transfer-utils.ts");

for (const oldFails of [false, true]) test(`estatísticas: ${oldFails ? "erro" : "resposta"} antigo não substitui atualização recente`, async () => {
  const elements = Object.fromEntries(["stat-equipamentos", "stat-base-dot", "stat-equipamentos-rotulo", "stat-unidades", "btn-exportar-equipamentos"].map(id => [id, {
    textContent: "", dataset: {}, classList: { toggle(name, value) { this[name] = value; } }, title: "",
  }]));
  const previousDocument = global.document;
  const previousWarn = console.warn;
  const pending = [];
  global.document = { getElementById: id => elements[id] || null };
  const apiFetch = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  console.warn = () => {};
  try {
    const dashboard = createDashboard({ app: {}, transferUtils, motion: {}, dom: { pluralize: n => `${n} equipamentos` }, apiFetch });
    const older = dashboard.carregarEstatisticas();
    const newer = dashboard.carregarEstatisticas();
    pending[1].resolve({ total_equipamentos: 20, total_unidades: 3, exportacao_disponivel: true, total_alteracoes_exportaveis: 1 });
    await newer;
    if (oldFails) pending[0].reject(new Error("falha antiga"));
    else pending[0].resolve({ total_equipamentos: 10, total_unidades: 2, exportacao_disponivel: true, total_alteracoes_exportaveis: 0 });
    await older;
    assert.equal(elements["stat-equipamentos"].textContent, "20");
    assert.equal(elements["btn-exportar-equipamentos"].classList.hidden, false);
  } finally {
    global.document = previousDocument;
    console.warn = previousWarn;
  }
});
