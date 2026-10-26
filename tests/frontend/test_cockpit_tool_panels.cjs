const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "static/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "static/styles/ck-cockpit.css"), "utf8");
const source = fs.readFileSync(path.join(root, "static/js/features/cockpit-tool-panels.js"), "utf8");
const createCockpitToolPanels = require("../../static/js/features/cockpit-tool-panels.js");
const panels = createCockpitToolPanels({ app: {}, appState: {} });

test("the four Cockpit tools open dedicated panels from the nine-dot menu", () => {
  const expected = [
    ["btn-acompanhamento-chamados", "chamados", "F5"],
    ["btn-cockpit-comparacao", "comparacao", "F6"],
    ["btn-historico-apelidos", "apelidos", "F7"],
    ["btn-relatorio-mensal", "relatorio", "F8"],
  ];
  for (const [id, panel, shortcut] of expected) {
    const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] || "";
    assert.match(button, new RegExp(`data-on-click="abrirPainelCockpit"`));
    assert.match(button, new RegExp(`data-args='\\["${panel}"\\]'`));
    assert.match(html, new RegExp(`<kbd aria-hidden="true">${shortcut}</kbd>`));
    assert.match(html, new RegExp(`data-cockpit-tool-panel="${panel}"`));
  }
  assert.match(html, /id="cockpit-tool-panels"[^>]*hidden/);
assert.match(html, /id="cockpit-comparison-event"/);
assert.match(html, /id="cockpit-comparison-filters"/);
assert.match(html, /id="cockpit-alias-filters"/);
assert.match(html, /id="cockpit-monthly-periods"/);
});

test("keeps closed tool panels hidden and starts a new comparison through the existing import flow", () => {
  assert.match(css, /#cockpit-tool-panels\[hidden\][\s\S]*?display:\s*none/);
  const action = source.match(/function openNewComparison\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.doesNotMatch(action, /closePanel/);
  assert.match(action, /app\.abrirModalAtualizarPlanilhas\(\)/);
});

test("ticket search filters only existing records and leaves unknown relations visible", () => {
  const rows = [
    { serie: "SN-001", relacao: "conferida", oracle: [{ ordem_servico: "OS-10" }] },
    { serie: "SN-002", relacao: "somente_oracle", oracle: [{ ordem_servico: "OS-20" }] },
  ];
  assert.deepEqual(panels.filterTicketRecords(rows, "os-20", "todos"), [rows[1]]);
  assert.deepEqual(panels.filterTicketRecords(rows, "", "somente_oracle"), [rows[1]]);
  assert.deepEqual(panels.filterTicketRecords([{ serie: "SN-003", relacao: "legado" }], "", "todos").length, 1);
});

test("comparison rows are built from existing result categories and unsupported counts stay unavailable", () => {
  const event = { comparacao: {
    total_detalhes: 8,
    total_endpoint: 7,
    equipamentos_sincronizados: 5,
    ausentes_no_endpoint: [{ serie: "SN-001", computador: "HOST-1" }],
    ausentes_em_detalhes: [],
    divergencias_local: [{ serie: "SN-002", computador: "HOST-2" }],
  } };
  assert.deepEqual(panels.comparisonMetrics(event), {
    simpress: 8, endpoint: 7, iguais: 5, divergenciaLocal: 1, divergenciaUsuario: null,
    soSimpress: 1, soEndpoint: 0,
  });
  assert.deepEqual(panels.comparisonRows(event, "todos").map(row => row.categoria), ["Só Simpress", "Localidade"]);
});

test("alias metrics count monthly events and distinct equipment without inventing classifications", () => {
  const events = [
    { tipo: "apelido", serial: "SN-1", horario: "2026-10-20T09:00:00-03:00" },
    { tipo: "usuario", serial: "SN-1", horario: "2026-10-23T09:00:00-03:00" },
    { tipo: "endereco", serial: "SN-2", horario: "2026-09-20T09:00:00-03:00" },
  ];
  assert.deepEqual(panels.aliasMetrics(events, new Date("2026-10-25T12:00:00-03:00")), {
    changesThisMonth: 2, equipmentAffected: 1, outOfPattern: null, duplicateAliases: null,
  });
});

test("monthly preview uses values returned by the existing report builder and marks unavailable metrics", () => {
  const text = panels.monthlyPreviewText({
    mes: { label: "outubro de 2026" },
    inventario: { total: 12, unidades: 3, arquivo_origem: "EquipamentosDetalhes_atual.xlsx", por_unidade: [["Curitiba", "Sede", 8], ["Londrina", "Centro", 4]] },
    comparacao: { horario: null, atualizacoes_no_mes: 0, contagens: { "Sem correspondência — no endpoint": 2, "Sem correspondência — na Simpress": 1, "Localidade divergente": 0 } },
    os: { oracle: { abertas: 2, concluidas: 1, pendentes: 3 }, simpress: { abertas: 1, concluidas: 0, pendentes: 1 }, dados_insuficientes: [] },
  });
  assert.match(text, /outubro de 2026/);
  assert.match(text, /Equipamentos na base atual: 12/);
  assert.match(text, /Unidades com mais equipamentos \(base atual\):[\s\S]*Curitiba · Sede: 8/);
  assert.match(text, /OS Oracle abertas: 2/);
  assert.match(text, /Tempo médio até fechar: indisponível/);
  assert.match(text, /Transportes solicitados: indisponível/);
  assert.match(text, /Alterações de apelido: indisponível/);
  assert.doesNotMatch(text, /Sem registros no mês/);
});

test("monthlyChartBars scales bars to the largest real count", () => {
  const bars = panels.monthlyChartBars({ abertas: 4, concluidas: 2 }, { abertas: "x" });
  assert.deepEqual(bars.map(bar => bar.height), [100, 50, 0, 0]);
  assert.deepEqual(panels.monthlyChartBars().map(bar => bar.height), [0, 0, 0, 0]);
});
