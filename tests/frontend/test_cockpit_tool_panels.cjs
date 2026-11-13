const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const html = assembledHtml();
const css = fs.readFileSync(path.join(root, "static/styles/ck-cockpit.css"), "utf8");
const source = fs.readFileSync(path.join(root, "static/js/features/cockpit-tool-panels.js"), "utf8");
const createCockpitToolPanels = require("../../static/js/features/cockpit-tool-panels.js");
const panels = createCockpitToolPanels({ app: {}, appState: {} });

test("the four Cockpit tools open dedicated panels from the nine-dot menu", () => {
  const expected = [
    ["btn-acompanhamento-chamados", "chamados", "F6"],
    ["btn-historico-apelidos", "apelidos", "F7"],
    ["btn-relatorio-mensal", "relatorio", "F8"],
  ];
  for (const [id, panel, shortcut] of expected) {
    const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] || "";
    assert.match(button, new RegExp(`data-on-click="abrirPainelCockpit"`));
    assert.match(button, new RegExp(`data-args='\\["${panel}"\\]'`));
    // OS fica na barra principal (title com o atalho); os demais seguem no menu com <kbd> (Histórico de apelidos F7, Relatório mensal F8).
    if (panel === "chamados") assert.match(button, new RegExp(`title="OS \\(${shortcut}\\)"`));
    else if (shortcut) assert.match(html, new RegExp(`<kbd aria-hidden="true">${shortcut}</kbd>`));
    else assert.doesNotMatch(html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?</button>`))[0], /<kbd/);
    assert.match(html, new RegExp(`data-cockpit-tool-panel="${panel}"`));
  }
  assert.match(html, /id="cockpit-tool-panels"[^>]*hidden/);
  assert.match(html, /id="cockpit-comparison-event"/);
  // Resumo (F3) é a aba da barra que abre o painel interno "comparacao"; o item de menu Comparação F7 saiu.
  assert.doesNotMatch(html, /btn-cockpit-comparacao/);
  const abaResumo = html.match(/<button[^>]*id="btn-resumo-aba"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(abaResumo, /role="tab"/);
  assert.match(abaResumo, /data-cockpit-tool="comparacao" data-on-click="abrirPainelCockpit" data-args='\["comparacao"\]'/);
  assert.match(abaResumo, /aria-label="Resumo" title="Resumo \(F3\)" aria-keyshortcuts="F3"/);
  assert.match(abaResumo, /<span>Resumo<\/span><kbd class="ck-aba__kbd" aria-hidden="true">F3<\/kbd><\/button>$/);
  assert.match(html, /<h2 id="cockpit-comparison-heading" class="sr-only">Resumo<\/h2>/);
  // O resultado completo mora no Resumo (painel "comparacao"); lista/detalhe/KPIs/filtros/exportação antigos e o modal saíram.
  const comparacao = html.match(/<section[^>]*data-cockpit-tool-panel="comparacao"[\s\S]*?\n        <\/section>/)?.[0] || "";
  for (const id of ["comparacao-planilhas-conteudo", "comparacao-planilhas-fontes", "btn-exportar-resultado-comparacao", "resumo-regionais", "resumo-regionais-filtros", "resumo-regionais-mais"]) {
    assert.equal(comparacao.split(`id="${id}"`).length - 1, 1, `${id} dentro do painel Resumo`);
  }
  assert.match(comparacao, /id="btn-exportar-resultado-comparacao"[^>]*data-on-click="exportarResultadoComparacaoPlanilhas"/);
  assert.doesNotMatch(html, /id="cockpit-comparison-(kpis|filters|list|detail|export)"/);
  assert.doesNotMatch(html, /id="modal-comparacao-/);
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

test("comparison metrics are built from existing result categories and unsupported counts stay unavailable", () => {
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
  assert.equal(panels.comparisonRows, undefined, "a lista antiga de linhas saiu; o resultado completo vem de renderizarResultadoComparacao");
});

test("alias metrics count monthly events and distinct equipment without inventing classifications", () => {
  const events = [
    { tipo: "apelido", serial: "SN-1", horario: "2026-10-20T09:00:00-03:00" },
    { tipo: "usuario", serial: "SN-1", horario: "2026-10-23T09:00:00-03:00" },
    { tipo: "endereco", serial: "SN-2", horario: "2026-09-20T09:00:00-03:00" },
  ];
  assert.deepEqual(panels.aliasMetrics(events, new Date("2026-10-25T12:00:00-03:00")), {
    changesThisMonth: 2, equipmentAffected: 1,
  });
});

test("alias day label says Hoje, Ontem or the weekday in local time, and flags invalid dates", () => {
  const now = new Date(2026, 10, 11, 15, 0);
  assert.equal(panels.aliasDayLabel(new Date(2026, 10, 11, 9, 30).toISOString(), now), "Hoje · quarta, 11/11");
  assert.equal(panels.aliasDayLabel(new Date(2026, 10, 10, 23, 59).toISOString(), now), "Ontem · terça, 10/11");
  assert.equal(panels.aliasDayLabel(new Date(2026, 10, 9, 8, 0).toISOString(), now), "Segunda, 09/11");
  assert.equal(panels.aliasDayLabel("nao-e-data", now), "Data indisponível");
});

test("monthly preview uses the report values, the period and drops metrics the report does not provide", () => {
  const report = {
    mes: { label: "outubro de 2026", parcial: false, data_corte: "2026-10-31" },
    inventario: { total: 12, unidades: 3, arquivo_origem: "EquipamentosDetalhes_atual.xlsx", por_unidade: [["Curitiba", "Sede", 8], ["Londrina", "Centro", 4]] },
    comparacao: { horario: "2026-10-15T09:00:00", atualizacoes_no_mes: 1, contagens: { "Sem correspondência — no endpoint": 2, "Sem correspondência — na Simpress": 1, "Localidade divergente": 0 } },
    os: { oracle: { abertas: 2, concluidas: 1, pendentes: 3 }, simpress: { abertas: 1, concluidas: 0, pendentes: 1 }, dados_insuficientes: [{ fonte: "Simpress" }] },
  };
  const text = panels.monthlyPreviewText(report);
  assert.match(text, /^Relatório mensal Simpress · outubro de 2026 · Mês encerrado/);
  assert.match(text, /OS Oracle abertas no mês: 2/);
  assert.match(text, /OS Oracle pendentes no fim do período: 3/);
  assert.match(text, /Fora das contagens: 1 registro com dados insuficientes/);
  assert.match(text, /Comparação usada: 15\/10\/2026 às 09:00 · 1 atualização de inventário no mês/);
  assert.match(text, /Base atual \(não muda com o mês\): 12 equipamentos em 3 unidades/);
  assert.match(text, /Unidades com mais equipamentos \(base atual\):[\s\S]*Curitiba · Sede: 8/);
  assert.doesNotMatch(text, /indisponível|Tempo médio|Transportes|Alterações de apelido/);
  assert.doesNotMatch(text, /Chamados \(F5\)/, "sem a resposta do Sebrae a linha de chamados não aparece");

  const withSebrae = panels.monthlyPreviewText({ ...report, mes: { label: "novembro de 2026", parcial: true, data_corte: "2026-11-07" } }, {
    importado: { abertos: [{ numero: "UTIC-2026-1" }, { numero: "linha:9" }] }, novos: { formulario: [{ numero: "UTIC-2026-5" }] },
  });
  assert.match(withSebrae, /novembro de 2026 · Parcial até 07\/11\/2026/);
  assert.match(withSebrae, /Chamados \(F5\), situação atual: 1 novo · 2 antigos em aberto/);
});

test("monthly preview adds the server month count for Chamados (F5) and omits it on error or without Dashboard", () => {
  const sebrae = { abertos: 1234, finalizados: 2, sem_data: 3, linhas: [] };
  const line = /Chamados \(F5\), com data em outubro de 2026: Abertos no mês 1\.234 · Finalizados no mês 2 · Sem data de abertura ou de encerramento: 3 \(fora da contagem\)/;
  const base = { mes: { label: "outubro de 2026" } };
  // Sem a resposta do F5 (falhou), a linha do mês aparece sozinha, depois de uma linha em branco.
  assert.match(panels.monthlyPreviewText({ ...base, sebrae }), new RegExp(`\\n\\n${line.source}`));
  assert.doesNotMatch(panels.monthlyPreviewText({ ...base, sebrae }), /situação atual/);
  const both = panels.monthlyPreviewText({ ...base, sebrae }, { novos: { formulario: [{ numero: "UTIC-2026-5" }] } });
  assert.match(both, new RegExp(`Chamados \\(F5\\), situação atual: 1 novo · 0 antigos em aberto\\n${line.source}`));
  for (const value of [null, undefined, { erro: "Dashboard ilegível." }]) {
    assert.doesNotMatch(panels.monthlyPreviewText({ ...base, sebrae: value }), /com data em/);
  }
});

test("Sebrae lists follow the F5 rule: a ticket the site finalized leaves Novos and Antigos", () => {
  const data = {
    importado: {
      abertos: [{ numero: "UTIC-2026-1", titulo: "A" }, { numero: "UTIC-2026-2", titulo: "B" }],
      finalizados: [{ numero: "UTIC-2026-1", encerrado_em: "20/10/2026 15:00" }],
    },
    novos: { formulario: [{ numero: "UTIC-2026-3", linha: { G: "C", K: "SN-3" } }] },
  };
  const lists = panels.sebraeOpenLists(data);
  assert.deepEqual(lists.antigos.map(item => item.numero), ["UTIC-2026-2"]);
  assert.deepEqual(lists.novos.map(item => item.numero), ["UTIC-2026-3"]);
  assert.match(panels.monthlyPreviewText({ mes: { label: "outubro de 2026" } }, data), /Chamados \(F5\), situação atual: 1 novo · 1 antigo em aberto/);
});

test("a month row links to the F5 only with the F5 key and fills the series of new tickets", () => {
  const data = {
    importado: {
      abertos: [
        { numero: "UTIC-2026-1" },
        { numero: "linha:40", chamado: " 27206 " },
        { numero: "linha:41", chamado: "Sem chamado" },
        { numero: "linha:42", chamado: "Sem chamado" },
        { numero: "linha:43", chamado: "Chamado por e-mail" },
        { numero: "linha:44", chamado: "" },
      ],
      finalizados: [{ numero: "UTIC-2026-9" }],
    },
    novos: { formulario: [{ numero: "UTIC-2026-5", linha: { K: "SN-5" } }] },
  };
  const match = row => panels.sebraeMonthMatch(row, data);
  assert.deepEqual(match({ chave: "UTIC-2026-1", chamado: "UTIC-2026-1", serie: "SN-1" }), { chaveF5: "UTIC-2026-1", serie: "SN-1" });
  assert.deepEqual(match({ chave: "UTIC-2026-9", chamado: "UTIC-2026-9", serie: "" }), { chaveF5: "UTIC-2026-9", serie: "" });
  // Chamado novo da busca: série vazia no F8 vem de novos.formulario[].linha.K.
  assert.deepEqual(match({ chave: "UTIC-2026-5", chamado: "UTIC-2026-5", serie: "" }), { chaveF5: "UTIC-2026-5", serie: "SN-5" });
  // Número antigo: casa com o `linha:N` do F5 pelo número na coluna C.
  assert.equal(match({ chave: "27206", chamado: "27206" }).chaveF5, "linha:40");
  // linha:N do F8: nunca pela própria chave; só pelo texto de C, e só com resultado único e não vazio.
  assert.equal(match({ chave: "linha:43", chamado: "Chamado por e-mail" }).chaveF5, "linha:43");
  assert.equal(match({ chave: "linha:41", chamado: "Sem chamado" }).chaveF5, "", "ambíguo não liga");
  assert.equal(match({ chave: "linha:44", chamado: "" }).chaveF5, "", "chamado vazio não liga");
  assert.equal(match({ chave: "UTIC-2026-77", chamado: "UTIC-2026-77" }).chaveF5, "", "fora do F5: sem link");
  assert.equal(match({ chave: "99999", chamado: "99999" }).chaveF5, "");
  assert.deepEqual(panels.sebraeMonthMatch({ chave: "UTIC-2026-1", chamado: "UTIC-2026-1", serie: "" }, null), { chaveF5: "", serie: "" });
});

// DOM falso permissivo: qualquer propriedade desconhecida vira função/objeto inerte; só o que o roteamento lê é real.
function criarAmbientePaineis({ apiFetch = async () => ({}), appExtra = {}, contextExtra = {} } = {}) {
  const elementos = new Map();
  const ouvintes = [];
  const ouvintesElemento = [];
  const novo = id => new Proxy({ id, hidden: true, open: false, dataset: {}, textContent: "", value: "", children: [], attrs: {} }, {
    get(alvo, chave) {
      if (chave in alvo) return alvo[chave];
      if (chave === "isConnected") return true;
      if (chave === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (chave === "setAttribute") return (n, v) => { alvo.attrs[n] = v; };
      if (chave === "getAttribute") return n => alvo.attrs[n] ?? null;
      if (chave === "removeAttribute") return n => { delete alvo.attrs[n]; };
      if (chave === "addEventListener") return (tipo, fn) => ouvintesElemento.push([id, tipo, fn]);
      if (chave === "focus") return () => { global.document.activeElement = elementos.get(id); };
      if (chave === "querySelector" || chave === "closest") return () => null;
      if (chave === "querySelectorAll") return () => [];
      return () => {};
    },
    set(alvo, chave, valor) { alvo[chave] = valor; return true; },
  });
  global.document = {
    activeElement: null,
    getElementById: id => { if (!elementos.has(id)) elementos.set(id, novo(id)); return elementos.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (tipo, fn) => ouvintes.push([tipo, fn]),
    createElement: () => novo("novo"),
  };
  const app = { apiFetch, showToast() {}, ...appExtra };
  const api = createCockpitToolPanels({ app, appState: {}, apiFetch, ...contextExtra });
  const el = id => document.getElementById(id);
  const esc = () => { let prevenido = false; ouvintes.filter(([t]) => t === "keydown").forEach(([, fn]) => fn({ key: "Escape", defaultPrevented: false, preventDefault() { prevenido = true; } })); return prevenido; };
  // dispara(id, tipo, evento): chama os ouvintes que o painel registrou naquele elemento (cliques e teclas das sub-abas da F6).
  const dispara = (id, tipo, evento = {}) => ouvintesElemento.filter(([alvo, t]) => alvo === id && t === tipo).forEach(([, , fn]) => fn(evento));
  return { api, el, esc, dispara };
}

test("Voltar retorna ao painel anterior e, sem anterior, fecha para a tela principal", async () => {
  const { api, el } = criarAmbientePaineis();
  try {
    await api.abrirPainelCockpit("planilhas");
    await api.abrirPainelCockpit("unidades");
    assert.equal(el("cockpit-tools-dropdown").dataset.activeTool, "unidades");
    await api.fecharPainelCockpit();
    assert.equal(el("cockpit-tools-dropdown").dataset.activeTool, "planilhas");
    assert.equal(el("cockpit-tool-panels").hidden, false);
    await api.fecharPainelCockpit();
    assert.equal(el("cockpit-tool-panels").hidden, true);
    assert.equal(el("main-content").hidden, false);
    assert.equal(el("cockpit-tools-dropdown").dataset.activeTool, undefined);
  } finally { delete global.document; }
});

test("Esc fecha o painel aberto e é ignorado com o painel fechado", async () => {
  const { api, el, esc } = criarAmbientePaineis();
  try {
    await api.abrirPainelCockpit("unidades");
    assert.equal(esc(), true);
    assert.equal(el("cockpit-tool-panels").hidden, true);
    assert.equal(el("main-content").hidden, false);
    assert.equal(esc(), false);
  } finally { delete global.document; }
});

test("abrir uma ferramenta desconhecida não mostra o painel", async () => {
  const { api, el } = criarAmbientePaineis();
  try {
    await api.abrirPainelCockpit("inexistente");
    assert.equal(el("cockpit-tool-panels").hidden, true);
  } finally { delete global.document; }
});

test("Chamados (painel sebrae-chamados) tem aba na barra, item de menu, botão no cartão de Automação e painel com os IDs movidos", () => {
  const aba = html.match(/<button[^>]*id="btn-sebrae-chamados-aba"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(aba, /class="ck-aba ck-aba--painel"/);
  assert.match(aba, /data-args='\["sebrae-chamados"\]'/);
  assert.match(aba, /aria-label="Chamados" title="Chamados \(F5\)" aria-keyshortcuts="F5"/);
  assert.match(aba, /<span>Chamados<\/span>/);
  // Ordem final da barra: Home, Transporte, Resumo (F3, abre o painel "comparacao"), Automação, Chamados (F5), OS (F6).
  assert.ok(html.indexOf('id="tab-retirada-entrega"') < html.indexOf('id="btn-resumo-aba"'));
  assert.ok(html.indexOf('id="btn-resumo-aba"') < html.indexOf('id="tab-automacao"'));
  assert.doesNotMatch(html, /id="tab-resumo"|id="tab-panel-resumo"|id="resumo-cards"|cockpit-summary/, "Resumo antigo removido");
  assert.ok(html.indexOf('id="tab-automacao"') < html.indexOf('id="btn-sebrae-chamados-aba"'));
  assert.ok(html.indexOf('id="btn-sebrae-chamados-aba"') < html.indexOf('id="btn-acompanhamento-chamados"'));
  // Atalho F1-F6 pequeno em cada aba principal, escondido dos leitores de tela (o aria-label já traz o nome).
  for (const [id, atalho] of [["tab-home", "F1"], ["tab-retirada-entrega", "F2"], ["btn-resumo-aba", "F3"], ["tab-automacao", "F4"], ["btn-sebrae-chamados-aba", "F5"], ["btn-acompanhamento-chamados", "F6"]]) {
    const botao = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>[^]*?</button>`))?.[0] || "";
    assert.match(botao, new RegExp(`</span><kbd class="ck-aba__kbd" aria-hidden="true">${atalho}</kbd></button>$`), id);
  }
  const abaOs = html.match(/<button[^>]*id="btn-acompanhamento-chamados"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(abaOs, /aria-label="OS" title="OS \(F6\)" aria-keyshortcuts="F6"/);
  assert.match(abaOs, /<span>OS<\/span>/);
  const menuOs = html.match(/<button[^>]*id="btn-chamados-menu"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(menuOs, /ck-menu__item--so-compacto/);
  assert.match(menuOs, /<span class="ck-menu__rotulo">OS<\/span><kbd aria-hidden="true">F6<\/kbd>/);
  const menu = html.match(/<button[^>]*id="btn-sebrae-chamados-menu"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(menu, /data-on-click="abrirPainelCockpit"/);
  assert.match(menu, /data-args='\["sebrae-chamados"\]'/);
  assert.match(menu, /ck-menu__item--so-compacto/);
  assert.match(menu, /<span class="ck-menu__rotulo">Chamados<\/span><kbd aria-hidden="true">F5<\/kbd>/);
  assert.ok(html.indexOf('id="ck-menu-g-paineis"') < html.indexOf('id="btn-sebrae-chamados-menu"'));
  assert.doesNotMatch(html, /btn-historico-comparacoes|data-cockpit-tool-panel="historico-planilhas"|cockpit-sheets-history/);
  assert.ok(html.indexOf('id="btn-sebrae-chamados-menu"') < html.indexOf('id="btn-chamados-menu"'));
  // Desde 31/10/2026 o menu não tem o grupo "Planilhas": Atualizar planilhas saiu; Exportar Excel (modelo) mora no Resumo.
  assert.doesNotMatch(html, /ck-menu-g-planilhas|btn-atualizar-planilhas/);
  const menuFerramentas = html.match(/id="cockpit-tools-menu"[\s\S]*?<\/details>/)[0];
  assert.doesNotMatch(menuFerramentas, /btn-exportar-equipamentos/);
  const barraComparacao = html.match(/data-cockpit-tool-panel="comparacao"[\s\S]*?<div class="ck-barra-ferr">([\s\S]*?)<\/div>/)[1];
  const exportar = barraComparacao.match(/<button[^>]*id="btn-exportar-equipamentos"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(exportar, /class="ck-btn ck-btn--secundario hidden"/);
  assert.match(exportar, /data-on-click="exportarEquipamentosAtualizados"/);
  assert.match(exportar, /<span>Exportar Excel<\/span>/);
  const botao = html.match(/<button[^>]*id="btn-sebrae-abrir-chamados"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  assert.match(botao, /data-args='\["sebrae-chamados"\]'/);
  assert.match(botao, /<span>Chamados<\/span>/);
  const painel = html.match(/<section[^>]*data-cockpit-tool-panel="sebrae-chamados"[\s\S]*?\n        <\/section>/)?.[0] || "";
  const cartao = html.match(/<section[^>]*id="sebrae-novos-painel"[\s\S]*?\n      <\/section>/)?.[0] || "";
  for (const id of ["sebrae-novos-lista", "sebrae-antigos", "sebrae-antigos-lista", "sebrae-antigos-resumo", "sebrae-finalizados", "sebrae-finalizados-lista", "sebrae-finalizados-resumo", "sebrae-sugestoes-a", "sebrae-sugestoes-b", "sebrae-sugestoes-s", "btn-sebrae-atualizar", "sebrae-atualizar-status", "btn-sebrae-ler-antigos", "sebrae-antigos-leitura-status", "sebrae-antigos-leitura-falhas"]) {
    assert.equal(painel.split(`id="${id}"`).length - 1, 1, `${id} no painel`);
    assert.doesNotMatch(cartao, new RegExp(`id="${id}"`), `${id} fora do cartão`);
  }
  for (const id of ["sebrae-dashboard-file", "btn-sebrae-importar", "btn-sebrae-buscar", "sebrae-dashboard-status", "sebrae-novos-resumo", "sebrae-novos-avisos", "sebrae-historico-resumo"]) {
    assert.match(cartao, new RegExp(`id="${id}"`), `${id} no cartão`);
  }
  // Redesenho de 01/11/2026: o topo do painel (ações, status) vem antes das listas, Atualizar Dashboard antes de Enviar ao SharePoint e a seção de novos antes dos antigos.
  const ordem = ['class="sebrae-topo"', 'id="btn-sebrae-atualizar"', 'id="btn-sebrae-enviar"', 'id="btn-sebrae-ler-antigos"', 'id="sebrae-atualizar-status"', 'id="sebrae-antigos-leitura-status"',
    'id="sebrae-sharepoint-aviso"', 'id="sebrae-novos-secao"', 'id="sebrae-novos-lista"', 'id="sebrae-antigos"', 'id="sebrae-finalizados"'].map(marca => painel.indexOf(marca));
  assert.ok(ordem.every(posicao => posicao >= 0), `marcas do painel presentes: ${ordem}`);
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, "topo, ações, status, lista de novos, antigos e finalizados nesta ordem");
  assert.match(painel, /<button[^>]*class="ck-btn ck-btn--primario[^"]*"[^>]*id="btn-sebrae-atualizar"/, "Atualizar Dashboard é o botão primário");
  assert.doesNotMatch(painel, /<details id="sebrae-(antigos|finalizados)"[^>]*\bopen\b/, "antigos e finalizados nascem recolhidos");
  assert.match(css, /#sebrae-novos-lista:empty:not\(\[aria-busy="true"\]\)::before \{ content: "Nenhum chamado novo na lista\."/);
  assert.match(css, /#sebrae-novos-lista:empty:not\(\[aria-busy="true"\]\)::after \{ content: "A importação do Dashboard e a busca ficam na aba Automação \(F4\)\."/);
  assert.doesNotMatch(html, /btn-sebrae-historico|data-cockpit-tool-panel="sebrae-historico"|sebrae-historico-(kpis|lista|detalhe|filtro|status)/);
  assert.match(html, /\.sebrae-chamado\b/.source ? /id="sebrae-novos-lista"/ : /x/);
  assert.match(css, /^\.sebrae-chamado \{/m);
});

test("abrir Chamados (sebrae-chamados) mostra o painel sem recarregar a lista", async () => {
  const { api, el } = criarAmbientePaineis();
  try {
    await api.abrirPainelCockpit("sebrae-chamados");
    assert.equal(el("cockpit-tools-dropdown").dataset.activeTool, "sebrae-chamados");
    assert.equal(el("cockpit-tool-panels").hidden, false);
    assert.equal(el("cockpit-tool-title").textContent, "Chamados");
    assert.equal(el("cockpit-tool-kbd").textContent, "F5");
    assert.equal(el("cockpit-tool-kbd").hidden, false);
  } finally { delete global.document; }
  const openPanel = source.match(/async function openPanel\(tool\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.doesNotMatch(openPanel, /sebrae-chamados|carregarNovosSebrae/);
});

test("OS (painel chamados) troca lista e detalhe pelo host da tabela de OS e mantém KPIs, busca e Relação", () => {
  // A tabela de OS é o único painel das sub-abas: role=tabpanel, rotulado pela aba ativa (o JS troca o aria-labelledby).
  assert.match(html, /<div id="cockpit-tickets-os" class="ck-ferr-os" role="tabpanel" aria-labelledby="os-aba-abertas"><\/div>/);
  assert.doesNotMatch(html, /id="cockpit-tickets-(list|detail)"/);
  const idsChamados = [
    "cockpit-tickets-kpis", "cockpit-tickets-kpis-nota", "cockpit-tickets-triage", "cockpit-tickets-contagem", "os-aba-abertas", "os-aba-finalizadas", "os-abertas-contagem", "os-finalizadas-contagem",
    "cockpit-tickets-search", "cockpit-tickets-relation", "cockpit-tickets-attention",
    "cockpit-tickets-export", "cockpit-tickets-clear", "cockpit-tickets-manage", "cockpit-tickets-manage-panel",
    "cockpit-tickets-form", "cockpit-tickets-file-simpress", "cockpit-tickets-file-oracle", "cockpit-tickets-import", "cockpit-tickets-import-status",
    "cockpit-tickets-sources", "cockpit-tickets-version", "cockpit-tickets-delete-old", "cockpit-tickets-evolution",
  ];
  for (const id of idsChamados) assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  // Importar e gerenciar rola até o bloco do painel e o abre.
  assert.match(html.match(/<button[^>]*id="cockpit-tickets-manage"[^>]*>/)[0], /data-on-click="abrirGestaoChamadosCockpit"/);
  assert.doesNotMatch(source, /cockpit-tickets-manage"\)\.addEventListener/);
  assert.doesNotMatch(source, /abrirAcompanhamentoChamados/);
  assert.doesNotMatch(html, /resumo-os-equipamento/, "a seção de OS saiu do Transporte");
});

test("#ck-link-os é um botão que abre OS filtrada pela série do equipamento", () => {
  const link = html.match(/<(\w+)[^>]*id="ck-link-os"[^>]*>/);
  assert.equal(link?.[1], "button");
  assert.match(link[0], /type="button"/);
  assert.match(link[0], /data-on-click="abrirChamadosDoEquipamento"/);
  assert.equal(typeof panels.abrirChamadosDoEquipamento, "function");
});

test("abrir OS monta a tabela uma vez, com as opções de OS, e depois só atualiza", async () => {
  const { api, el } = criarAmbientePaineis();
  const calls = { montar: [], filtrar: [], atualizar: [] };
  global.SimpressDataPanels = {
    montarTabelaOs: (host, opcoes) => { calls.montar.push([host, opcoes]); return {}; },
    filtrarTabelaOs: filtro => calls.filtrar.push(filtro),
    atualizarTabelaOs: async force => { calls.atualizar.push(force); },
  };
  try {
    el("cockpit-tickets-relation").value = "todos";
    el("cockpit-tickets-attention").checked = false;
    await api.abrirPainelCockpit("chamados");
    assert.equal(calls.montar.length, 1);
    const [host, opcoes] = calls.montar[0];
    assert.equal(host, el("cockpit-tickets-os"));
    assert.equal(opcoes.semBusca, true);
    assert.equal(opcoes.incluirSemOs, undefined, "série sem OS nunca é listada");
    assert.equal(typeof opcoes.aoExpandirSerie, "function");
    assert.equal(typeof opcoes.aoCarregar, "function");
    for (const nome of ["aoContarSituacao", "aoContarAbas", "aoMudarSituacao", "aoFocarAba"]) assert.equal(typeof opcoes[nome], "function", nome);
    assert.equal(opcoes.statusEm, el("cockpit-tickets-contagem"), "o contador 'N OS · N séries' vai para a barra das sub-abas");
    assert.deepEqual(calls.filtrar, [{ busca: "", relacao: "", triagem: "", atencao: false, situacao: "abertas" }], "Relação 'todos' vira filtro vazio e a sub-aba nasce em Abertas");
    assert.deepEqual(calls.atualizar, [], "a tabela recém-montada já carrega sozinha");

    // aoCarregar guarda o relatório (snapshot); os KPIs vêm de aoContarSituacao (só Abertas). aoExpandirSerie preenche a linha de Andamento.
    const kpis = el("cockpit-tickets-kpis");
    let kpiRenders = 0;
    kpis.replaceChildren = () => { kpiRenders += 1; };
    opcoes.aoCarregar({ resumo: { series_total: 2 }, chamados: [{ serie: "SN-1", relacao: "conferida", oracle: [], simpress: {} }] });
    assert.equal(kpiRenders, 0, "o relatório todo não redesenha os KPIs");
    opcoes.aoContarSituacao({ os: 1, chamados: [{ serie: "SN-1", relacao: "conferida", oracle: [], simpress: {} }] });
    assert.equal(kpiRenders, 1);
    const celula = el("celula-andamento");
    let preenchida = 0;
    celula.replaceChildren = () => { preenchida += 1; };
    opcoes.aoExpandirSerie("SN-1", celula);
    assert.ok(preenchida >= 1);
    const antes = preenchida;
    opcoes.aoExpandirSerie("SN-X", celula);
    assert.ok(preenchida > antes, "série ausente da importação mostra aviso em vez de quebrar");

    // Já montada: reabrir só pede atualização.
    host.querySelector = () => ({});
    await api.abrirPainelCockpit("chamados");
    assert.equal(calls.montar.length, 1);
    assert.deepEqual(calls.atualizar, [true]);
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

// Nós simples no lugar do DOM permissivo: guardam filhos e texto para conferir KPIs, triagem e ARIA das sub-abas.
function usarNosSimples() {
  global.document.createElement = tag => {
    const node = { tag, className: "", textContent: "", dataset: {}, attrs: {}, children: [] };
    node.append = (...filhos) => { node.children.push(...filhos); };
    node.replaceChildren = (...filhos) => { node.children = filhos; };
    node.setAttribute = (nome, valor) => { node.attrs[nome] = valor; };
    return node;
  };
}

// Abre o painel OS com a tabela falsa e devolve o que o painel ligou nela (opções) e o que ele filtrou.
async function abrirOsComTabelaFalsa(ambiente) {
  const filtros = [];
  const dados = { opcoes: null };
  global.SimpressDataPanels = {
    montarTabelaOs: (_host, opcoes) => { dados.opcoes = opcoes; return {}; },
    filtrarTabelaOs: filtro => filtros.push(filtro),
    atualizarTabelaOs: async () => {},
  };
  usarNosSimples();
  ambiente.el("cockpit-tickets-attention").checked = false; // o DOM permissivo devolveria uma função (verdadeira)
  const kpis = [];
  const triagem = [];
  ambiente.el("cockpit-tickets-kpis").replaceChildren = (...cartoes) => { kpis.push(cartoes.map(cartao => [cartao.children[0].textContent, cartao.children[1].textContent])); };
  ambiente.el("cockpit-tickets-triage").replaceChildren = (cabecalho, botoes) => {
    triagem.push({ resumo: cabecalho.children[1].textContent, numeros: botoes.children.map(botao => [botao.dataset.triagem, botao.children[1].textContent]) });
  };
  await ambiente.api.abrirPainelCockpit("chamados");
  return { ...dados, filtros, kpis, triagem };
}

test("KPIs e triagem contam só as OS abertas e não mudam ao trocar de sub-aba", async () => {
  const ambiente = criarAmbientePaineis({ appExtra: { grupoTriagemChamado: registro => registro.grupo } });
  const { el, dispara } = ambiente;
  try {
    const { opcoes, filtros, kpis, triagem } = await abrirOsComTabelaFalsa(ambiente);
    opcoes.aoCarregar({ snapshot_id: "s1", resumo: { series_total: 9 }, chamados: new Array(9).fill({ serie: "X", relacao: "conferida" }) });
    assert.equal(kpis.length, 0, "o relatório inteiro (Abertas e Finalizadas) não gera KPIs");
    opcoes.aoContarSituacao({ os: 4, chamados: [
      { serie: "A", relacao: "conferida", grupo: "atrasados" },
      { serie: "B", relacao: "divergente", grupo: "em_dia" },
      { serie: "C", relacao: "somente_oracle", grupo: "" },
    ] });
    assert.deepEqual(kpis.at(-1), [
      ["OS abertas", "4"], ["Séries", "3"], ["Conferidas", "1"], ["Divergentes", "1"], ["Só Simpress", "0"], ["Só Oracle", "1"],
    ], "'OS abertas' vem primeiro e as séries são só as com OS aberta");
    assert.deepEqual(triagem.at(-1), {
      resumo: "2 de 3 séries com chamado aberto no Oracle · 1 sem chamado aberto",
      numeros: [["ativos", "2"], ["atrasados", "1"], ["sem_data", "0"], ["em_dia", "1"]],
    });
    const antesKpis = kpis.length;
    const antesTriagem = triagem.length;

    // Trocar de sub-aba só filtra a tabela: KPIs e triagem não são redesenhados nem mudam.
    dispara("os-aba-finalizadas", "click");
    assert.deepEqual(filtros.at(-1), { busca: "", relacao: "", triagem: "", atencao: false, situacao: "finalizadas" });
    dispara("os-aba-abertas", "click");
    assert.deepEqual(filtros.at(-1).situacao, "abertas");
    assert.equal(kpis.length, antesKpis);
    assert.equal(triagem.length, antesTriagem);

    // Recarregar (Desfazer/Conferido) recalcula: a OS que voltou para Abertas entra na contagem.
    opcoes.aoContarSituacao({ os: 5, chamados: [{ serie: "A", relacao: "conferida", grupo: "atrasados" }, { serie: "B", relacao: "divergente", grupo: "em_dia" }, { serie: "C", relacao: "somente_oracle", grupo: "" }, { serie: "D", relacao: "somente_simpress", grupo: "sem_data" }] });
    assert.deepEqual(kpis.at(-1).slice(0, 2), [["OS abertas", "5"], ["Séries", "4"]]);
    assert.equal(triagem.at(-1).numeros[0][1], "3");
    assert.match(html, /<p[^>]*id="cockpit-tickets-kpis-nota"[^>]*>KPIs e triagem contam só as OS da sub-aba Abertas\.<\/p>/);
    assert.ok(el("cockpit-tickets-triage").hidden === false);
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

test("sem OS aberta a triagem some e os KPIs zeram", async () => {
  const ambiente = criarAmbientePaineis({ appExtra: { grupoTriagemChamado: () => "ativos" } });
  try {
    const { opcoes, kpis, triagem } = await abrirOsComTabelaFalsa(ambiente);
    opcoes.aoContarSituacao({ os: 0, chamados: [] });
    assert.deepEqual(kpis.at(-1).slice(0, 2), [["OS abertas", "0"], ["Séries", "0"]]);
    assert.equal(triagem.length, 0);
    assert.equal(ambiente.el("cockpit-tickets-triage").hidden, true);
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

test("sub-abas da OS: números, aria-label, selecionada e painel único rotulado pela aba ativa", async () => {
  const ambiente = criarAmbientePaineis();
  const { el, dispara } = ambiente;
  try {
    const { opcoes, filtros } = await abrirOsComTabelaFalsa(ambiente);
    opcoes.aoContarAbas({ abertas: 3, finalizadas: 0 });
    assert.equal(el("os-abertas-contagem").textContent, "3");
    assert.equal(el("os-finalizadas-contagem").textContent, "0");
    assert.equal(el("os-aba-abertas").getAttribute("aria-label"), "Abertas: 3 OS");
    assert.equal(el("os-aba-finalizadas").getAttribute("aria-label"), "Finalizadas: 0 OS");
    assert.equal(el("os-aba-abertas").getAttribute("data-zero"), null);
    assert.equal(el("os-aba-finalizadas").getAttribute("data-zero"), "", "aba vazia fica com o número esmaecido");
    opcoes.aoContarAbas({ abertas: 3, finalizadas: 2 });
    assert.equal(el("os-aba-finalizadas").getAttribute("data-zero"), null);
    assert.equal(el("os-aba-finalizadas").getAttribute("aria-label"), "Finalizadas: 2 OS");

    dispara("os-aba-finalizadas", "click");
    assert.equal(el("os-aba-finalizadas").getAttribute("aria-selected"), "true");
    assert.equal(el("os-aba-abertas").getAttribute("aria-selected"), "false");
    assert.equal(el("os-aba-finalizadas").tabIndex, 0);
    assert.equal(el("os-aba-abertas").tabIndex, -1);
    assert.equal(el("cockpit-tickets-os").getAttribute("aria-labelledby"), "os-aba-finalizadas");
    assert.equal(filtros.at(-1).situacao, "finalizadas");
    // A tabela troca de sub-aba sozinha (abrir a OS de um chamado): o painel só espelha o ARIA, sem filtrar de novo.
    const filtrosAntes = filtros.length;
    opcoes.aoMudarSituacao("abertas");
    assert.equal(el("os-aba-abertas").getAttribute("aria-selected"), "true");
    assert.equal(el("cockpit-tickets-os").getAttribute("aria-labelledby"), "os-aba-abertas");
    assert.equal(filtros.length, filtrosAntes);
    // Depois de Desfazer/Conferido a linha some da vista: o foco volta para a aba ativa.
    opcoes.aoFocarAba();
    assert.equal(global.document.activeElement, el("os-aba-abertas"));
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

test("sub-abas da OS: setas, Home e End movem seleção e foco (tabindex rolante)", async () => {
  const ambiente = criarAmbientePaineis();
  const { el, dispara } = ambiente;
  try {
    const { filtros } = await abrirOsComTabelaFalsa(ambiente);
    const tecla = (id, key) => { let prevenido = false; dispara(id, "keydown", { key, preventDefault() { prevenido = true; } }); return prevenido; };
    assert.equal(tecla("os-aba-abertas", "ArrowRight"), true);
    assert.equal(el("os-aba-finalizadas").getAttribute("aria-selected"), "true");
    assert.equal(global.document.activeElement, el("os-aba-finalizadas"));
    assert.equal(filtros.at(-1).situacao, "finalizadas");
    assert.equal(tecla("os-aba-finalizadas", "ArrowRight"), true, "circula do fim para o começo");
    assert.equal(el("os-aba-abertas").getAttribute("aria-selected"), "true");
    assert.equal(tecla("os-aba-abertas", "ArrowLeft"), true, "circula do começo para o fim");
    assert.equal(el("os-aba-finalizadas").getAttribute("aria-selected"), "true");
    assert.equal(tecla("os-aba-finalizadas", "Home"), true);
    assert.equal(global.document.activeElement, el("os-aba-abertas"));
    assert.equal(tecla("os-aba-abertas", "End"), true);
    assert.equal(global.document.activeElement, el("os-aba-finalizadas"));
    assert.equal(filtros.at(-1).situacao, "finalizadas");
    assert.equal(tecla("os-aba-finalizadas", "Tab"), false, "outras teclas seguem o comportamento normal");
    assert.equal(tecla("os-aba-finalizadas", "a"), false);
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

test("busca, Relação, Atenção e Triagem seguem valendo na sub-aba ativa; Limpar filtros não muda de sub-aba", async () => {
  const ambiente = criarAmbientePaineis({ appExtra: { grupoTriagemChamado: () => "atrasados" } });
  const { el, dispara } = ambiente;
  try {
    const { opcoes, filtros } = await abrirOsComTabelaFalsa(ambiente);
    opcoes.aoContarSituacao({ os: 1, chamados: [{ serie: "A", relacao: "conferida" }] });
    dispara("os-aba-finalizadas", "click");
    el("cockpit-tickets-relation").value = "divergente";
    el("cockpit-tickets-attention").checked = true;
    dispara("cockpit-tickets-relation", "change");
    assert.deepEqual(filtros.at(-1), { busca: "", relacao: "divergente", triagem: "", atencao: true, situacao: "finalizadas" });
    dispara("cockpit-tickets-clear", "click");
    assert.deepEqual(filtros.at(-1), { busca: "", relacao: "", triagem: "", atencao: false, situacao: "finalizadas" });
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

test("sub-abas da OS no HTML: tablist rotulado, abas ligadas ao painel único e contador na barra", () => {
  const barra = html.match(/<div class="os-abas-barra">[\s\S]*?<div id="cockpit-tickets-os"/)?.[0] || "";
  assert.ok(barra, "barra das sub-abas antes da tabela de OS");
  assert.match(barra, /<div class="os-abas" role="tablist" aria-label="OS por situação">/);
  for (const [id, rotulo] of [["abertas", "Abertas"], ["finalizadas", "Finalizadas"]]) {
    const aba = barra.match(new RegExp(`<button[^>]*id="os-aba-${id}"[^>]*>[\\s\\S]*?</button>`))?.[0] || "";
    assert.match(aba, /class="os-aba"/);
    assert.match(aba, new RegExp(`data-os-aba="${id}"`));
    assert.match(aba, /role="tab"/);
    assert.match(aba, /aria-controls="cockpit-tickets-os"/);
    assert.match(aba, new RegExp(`aria-label="${rotulo}: 0 OS"`));
    assert.match(aba, new RegExp(`<span class="os-aba__rotulo">${rotulo}</span>`));
    assert.match(aba, /^<button[^>]*\sdata-zero>/, "aba vazia nasce esmaecida (data-zero no botão, como no CSS)");
    assert.match(aba, new RegExp(`<span id="os-${id}-contagem" class="ck-badge os-aba__n">0</span>`));
  }
  assert.match(barra, /id="os-aba-abertas"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  assert.match(barra, /id="os-aba-finalizadas"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
  assert.ok(barra.indexOf('id="os-aba-abertas"') < barra.indexOf('id="os-aba-finalizadas"'), "Abertas vem primeiro");
  assert.match(barra, /<div id="cockpit-tickets-contagem" class="os-contagem"><\/div>/);
  // Um só tabpanel na tela de OS: a tabela, rotulada pela aba ativa; sem segundo painel nem segunda tabela.
  const painelOs = html.match(/data-cockpit-tool-panel="chamados"[\s\S]*?\n        <\/section>/)?.[0] || "";
  assert.equal((painelOs.match(/role="tabpanel"/g) || []).length, 1);
  assert.equal((html.match(/id="cockpit-tickets-os"/g) || []).length, 1);
});

test("linha do tempo da série descarta a resposta tardia quando a linha de Andamento foi desconectada", async () => {
  let responder;
  const apiFetch = () => new Promise(resolve => { responder = resolve; });
  const { api, el } = criarAmbientePaineis({ apiFetch });
  let opcoes;
  global.SimpressDataPanels = {
    montarTabelaOs: (_host, opts) => { opcoes = opts; return {}; },
    filtrarTabelaOs() {}, atualizarTabelaOs: async () => {},
  };
  try {
    await api.abrirPainelCockpit("chamados");
    opcoes.aoCarregar({ snapshot_id: "s1", resumo: {}, chamados: [{ serie: "SN-1", relacao: "constructor", oracle: [], simpress: {} }] });
    // O histórico é desenhado num nó criado por renderTicketDetail: guarda todos os nós novos para desconectá-los.
    const criados = [];
    const criar = global.document.createElement;
    global.document.createElement = (...args) => { const node = criar(...args); criados.push(node); return node; };
    opcoes.aoExpandirSerie("SN-1", el("celula-andamento"));
    global.document.createElement = criar;
    let renders = 0;
    criados.forEach(node => { node.isConnected = false; node.replaceChildren = () => { renders += 1; }; });
    responder({ eventos: [{ tipo: "Atualização", atualizado_em: "2026-10-30" }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(criados.length > 0);
    assert.equal(renders, 0, "resposta tardia não redesenha uma linha que já saiu da tabela");
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

test("abrirChamadosDoEquipamento preenche a busca com a série e filtra a tabela", async () => {
  const { api, el } = criarAmbientePaineis();
  const filtros = [];
  global.SimpressDataPanels = { montarTabelaOs: () => ({}), filtrarTabelaOs: filtro => filtros.push(filtro), atualizarTabelaOs: async () => {} };
  try {
    el("transfer-serial").textContent = "  sn-9 ";
    el("cockpit-tickets-relation").value = "somente_oracle";
    el("cockpit-tickets-attention").checked = false;
    const busca = el("cockpit-tickets-search");
    const eventos = [];
    busca.dispatchEvent = evento => { eventos.push(evento.type); return true; };
    await api.abrirChamadosDoEquipamento();
    assert.equal(busca.value, "SN-9");
    assert.equal(el("cockpit-tool-panels").hidden, false);
    assert.equal(el("cockpit-tools-dropdown").dataset.activeTool, "chamados");
    assert.deepEqual(eventos, ["input"]);
    assert.deepEqual(filtros.at(0), { busca: "SN-9", relacao: "somente_oracle", triagem: "", atencao: false, situacao: "abertas" });
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

test("resultado novo aparece na aba Comparação na hora e é trocado pelo evento salvo (com evento_id)", async () => {
  const renders = [];
  const evento = { id: "7", tipo: "atualizacao", horario: "2026-10-09T14:30:00-03:00", comparacao: { total_detalhes: 3 } };
  const urls = [];
  const apiFetch = async url => {
    urls.push(url);
    return url === "/api/historico-comparacoes" ? { eventos: [evento] } : { evento };
  };
  const { api, el } = criarAmbientePaineis({ apiFetch, appExtra: { renderizarResultadoComparacao: (comparacao, alvo) => renders.push([comparacao, alvo]) } });
  try {
    await api.mostrarResultadoNaAbaComparacao({ resumo: "recém-gerado" });
    assert.equal(el("cockpit-tool-panels").hidden, false);
    assert.equal(el("cockpit-tools-dropdown").dataset.activeTool, "comparacao");
    assert.deepEqual(urls, ["/api/historico-comparacoes", "/api/historico-comparacoes/7"]);
    assert.equal(renders.length, 2);
    assert.deepEqual(renders[0][0], { resumo: "recém-gerado" });
    assert.equal(renders[1][0].evento_id, "7");
    assert.equal(renders[1][0].historico_salvo, true);
    assert.equal(renders[1][0].horario_comparacao, evento.horario);
  } finally { delete global.document; }
});

test("abrir Comparação com evento_id e destino leva o destino ao resultado salvo, sem exportar sem data", async () => {
  const renders = [];
  const evento = { id: "9", tipo: "atualizacao", horario: "2026-10-09T10:00:00-03:00", comparacao: {} };
  const apiFetch = async url => url === "/api/historico-comparacoes" ? { eventos: [evento] } : { evento };
  const { api, el } = criarAmbientePaineis({ apiFetch, appExtra: { renderizarResultadoComparacao: (comparacao, alvo) => renders.push([comparacao, alvo]) } });
  try {
    await api.mostrarResultadoNaAbaComparacao({ evento_id: "9" }, { serial: "SN-1" });
    assert.equal(renders.length, 1);
    assert.equal(renders[0][0].evento_id, "9");
    assert.deepEqual(renders[0][1], { serial: "SN-1" });
  } finally { delete global.document; }
});

test("abrirComparacaoDaSerie leva a categoria ao alvo e repassa o Sem usuário ao resultado", async () => {
  const renders = [];
  let invalidacoes = 0;
  const evento = { id: "4", tipo: "atualizacao", horario: "2026-10-09T10:00:00-03:00", comparacao: {} };
  const semUsuario = { estado: "ok", items: [{ serial: "SN-1" }] };
  const apiFetch = async url => url === "/api/historico-comparacoes" ? { eventos: [evento] } : { evento };
  const { api } = criarAmbientePaineis({
    apiFetch,
    appExtra: { carregarSemUsuarioResumo: async () => semUsuario, invalidarSemUsuarioResumo: () => { invalidacoes += 1; }, renderizarResultadoComparacao: (...args) => renders.push(args) },
  });
  try {
    await api.abrirComparacaoDaSerie("SN-1", "sem_usuario");
    assert.equal(renders.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(renders[0][1])), { serial: "SN-1", category: "sem_usuario" });
    assert.equal(renders[0][2], semUsuario);
    assert.equal(invalidacoes, 1, "abrir o painel Comparação invalida o cache do Sem usuário");
    await api.abrirComparacaoDaSerie("SN-2");
    assert.deepEqual(JSON.parse(JSON.stringify(renders[1][1])), { serial: "SN-2" }, "sem categoria o alvo é só a série");
  } finally { delete global.document; }
});

test("abrirPainelCockpit('comparacao', aba) escolhe a sub-aba só depois do render (que volta a Visão geral)", async () => {
  const ordem = [];
  const evento = { id: "4", tipo: "atualizacao", horario: "2026-10-09T10:00:00-03:00", comparacao: {} };
  const apiFetch = async url => url === "/api/historico-comparacoes" ? { eventos: [evento] } : { evento };
  const { api } = criarAmbientePaineis({
    apiFetch,
    appExtra: { renderizarResultadoComparacao: () => ordem.push("render"), selecionarAbaResumo: aba => ordem.push(`aba:${aba}`) },
  });
  // O render real cria os painéis [data-resumo-painel]; o documento falso os simula.
  global.document.querySelector = seletor => (String(seletor).includes("data-resumo-painel") ? {} : null);
  try {
    await api.abrirPainelCockpit("comparacao", "sem-acesso");
    assert.deepEqual(ordem, ["aba:divergencias", "render", "aba:sem-acesso"]);
    ordem.length = 0;
    await api.abrirPainelCockpit("comparacao");
    assert.deepEqual(ordem, ["render"], "reabrir o painel já aberto, sem aba pedida, não troca a aba");
  } finally { delete global.document; }
});

test("resultado novo com o Resumo já aberto em Backups volta a Divergências antes do render", async () => {
  const ordem = [];
  const evento = { id: "4", tipo: "atualizacao", horario: "2026-10-09T10:00:00-03:00", comparacao: {} };
  const apiFetch = async url => url === "/api/historico-comparacoes" ? { eventos: [evento] } : { evento };
  const { api } = criarAmbientePaineis({
    apiFetch,
    appExtra: { renderizarResultadoComparacao: () => ordem.push("render"), selecionarAbaResumo: aba => ordem.push(`aba:${aba}`) },
  });
  try {
    await api.abrirPainelCockpit("comparacao", "backups");
    ordem.length = 0;
    await api.mostrarResultadoNaAbaComparacao({ evento_id: "4" });
    assert.equal(ordem[0], "aba:divergencias", "sai de Backups antes de mostrar a comparação");
    assert.ok(!ordem.includes("aba:backups"));
  } finally { delete global.document; }
});

test("abrirPainelCockpit('comparacao') sem painel aberto volta a Divergências antes do render", async () => {
  const ordem = [];
  const evento = { id: "4", tipo: "atualizacao", horario: "2026-10-09T10:00:00-03:00", comparacao: {} };
  const apiFetch = async url => url === "/api/historico-comparacoes" ? { eventos: [evento] } : { evento };
  const { api } = criarAmbientePaineis({
    apiFetch,
    appExtra: { renderizarResultadoComparacao: () => ordem.push("render"), selecionarAbaResumo: aba => ordem.push(`aba:${aba}`) },
  });
  try {
    await api.abrirPainelCockpit("comparacao");
    assert.deepEqual(ordem, ["aba:divergencias", "render"]);
  } finally { delete global.document; }
});

test("abrirPainelCockpit('comparacao', 'backups') escolhe Backups antes e depois do render, mesmo sem painéis da comparação", async () => {
  const ordem = [];
  const evento = { id: "4", tipo: "atualizacao", horario: "2026-10-09T10:00:00-03:00", comparacao: {} };
  const apiFetch = async url => url === "/api/historico-comparacoes" ? { eventos: [evento] } : { evento };
  const { api } = criarAmbientePaineis({
    apiFetch,
    appExtra: { renderizarResultadoComparacao: () => ordem.push("render"), selecionarAbaResumo: aba => ordem.push(`aba:${aba}`) },
  });
  try {
    await api.abrirPainelCockpit("comparacao", "backups");
    assert.deepEqual(ordem, ["aba:backups", "render", "aba:backups"]);
  } finally { delete global.document; }
});

test("abrirPainelCockpit('comparacao', 'backups') funciona sem nenhum evento no histórico", async () => {
  const ordem = [];
  const { api } = criarAmbientePaineis({
    apiFetch: async () => ({ eventos: [] }),
    appExtra: { renderizarResultadoComparacao: () => ordem.push("render"), selecionarAbaResumo: aba => ordem.push(`aba:${aba}`) },
  });
  try {
    await api.abrirPainelCockpit("comparacao", "backups");
    assert.deepEqual(ordem, ["aba:backups", "aba:backups"]);
  } finally { delete global.document; }
});

test("abrirPainelCockpit('comparacao', aba) não escolhe sub-aba quando não há painéis nem quando outra abertura começou", async () => {
  const ordem = [];
  const evento = { id: "4", tipo: "atualizacao", horario: "2026-10-09T10:00:00-03:00", comparacao: {} };
  let segurar = null;
  const apiFetch = async url => {
    if (url === "/api/historico-comparacoes" && segurar) await segurar;
    return url === "/api/historico-comparacoes" ? { eventos: [evento] } : { evento };
  };
  const { api } = criarAmbientePaineis({
    apiFetch,
    appExtra: { renderizarResultadoComparacao: () => ordem.push("render"), selecionarAbaResumo: aba => ordem.push(`aba:${aba}`) },
  });
  try {
    // Sem painéis (sem comparação ou com erro): fica em Divergências, sem pedir a aba depois do render.
    await api.abrirPainelCockpit("comparacao", "sem-acesso");
    assert.deepEqual(ordem, ["aba:divergencias", "render"]);
    // Com painéis, uma abertura mais nova vence: a antiga não troca a aba depois.
    global.document.querySelector = seletor => (String(seletor).includes("data-resumo-painel") ? {} : null);
    ordem.length = 0;
    let soltar;
    segurar = new Promise(resolve => { soltar = resolve; });
    const antiga = api.abrirPainelCockpit("comparacao", "sem-acesso");
    segurar = null;
    const nova = api.abrirPainelCockpit("comparacao", "divergencias");
    soltar();
    await Promise.all([antiga, nova]);
    assert.ok(!ordem.includes("aba:sem-acesso"), `ordem: ${ordem.join(", ")}`);
    assert.ok(ordem.includes("aba:divergencias"), `ordem: ${ordem.join(", ")}`);
  } finally { delete global.document; }
});

test("histórico de comparações vazio limpa a aba e mantém o Exportar desativado", async () => {
  const renders = [];
  const { api, el } = criarAmbientePaineis({
    apiFetch: async () => ({ eventos: [] }),
    appExtra: { renderizarResultadoComparacao: (...args) => renders.push(args) },
  });
  try {
    await api.abrirPainelCockpit("comparacao");
    assert.equal(renders.length, 0);
    assert.equal(el("btn-exportar-resultado-comparacao").disabled, true);
    assert.equal(el("cockpit-comparison-event").disabled, true);
    assert.equal(el("comparacao-planilhas-fontes").textContent, "");
  } finally { delete global.document; }
});

test("histórico vazio ainda mostra a seção Sem usuário abaixo da mensagem vazia e leva o alvo da Home até ela", async () => {
  const secoes = [];
  const semUsuario = { estado: "ok", items: [{ serial: "SN-1" }] };
  const { api, el } = criarAmbientePaineis({
    apiFetch: async () => ({ eventos: [] }),
    appExtra: { carregarSemUsuarioResumo: async () => semUsuario, renderizarSemUsuarioSemComparacao: (...args) => secoes.push(args) },
  });
  try {
    await api.abrirComparacaoDaSerie("SN-1", "sem_usuario");
    assert.equal(secoes.length, 1);
    assert.equal(secoes[0][0], semUsuario);
    assert.deepEqual(JSON.parse(JSON.stringify(secoes[0][1])), { serial: "SN-1", category: "sem_usuario" });
    assert.equal(el("btn-exportar-resultado-comparacao").disabled, true);
    assert.equal(el("comparacao-planilhas-conteudo").dataset.estado, "vazio");
    // Erro e limite do inventário também chegam à seção (o renderer escolhe a mensagem).
    for (const estado of ["erro", "limite"]) {
      const { api: outro } = criarAmbientePaineis({
        apiFetch: async () => ({ eventos: [] }),
        appExtra: { carregarSemUsuarioResumo: async () => ({ estado, items: [] }), renderizarSemUsuarioSemComparacao: semUsuarioLido => secoes.push(semUsuarioLido) },
      });
      await outro.abrirPainelCockpit("comparacao");
      assert.equal(secoes.at(-1).estado, estado);
    }
  } finally { delete global.document; }
});

test("Catálogo de unidades absorve o formulário do modal antigo (31/10/2026)", () => {
  const painel = html.match(/<section[^>]*data-cockpit-tool-panel="unidades"[\s\S]*?\n        <\/section>/)?.[0] || "";
  for (const id of ["form-nova-unidade", "form-unidade-titulo", "form-unidade-id", "form-unidade-cidade", "form-unidade-cep", "form-unidade-cnpj", "form-unidade-endereco", "btn-salvar-unidade", "cockpit-units-copy-cnpj", "cockpit-units-copy-cep", "cockpit-units-detail-badge"]) {
    assert.equal(painel.split(`id="${id}"`).length - 1, 1, `${id} uma vez no painel`);
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} uma vez na página`);
  }
  assert.match(painel, /id="cockpit-units-new"[^>]*data-on-click="toggleFormNovaUnidade"[^>]*data-args='\[true\]'/);
  assert.match(painel, /id="btn-salvar-unidade"[^>]*data-on-click="salvarUnidadeForm"|data-on-click="salvarUnidadeForm"[^>]*id="btn-salvar-unidade"/);
  assert.doesNotMatch(html, /modal-gerenciar-unidades|cockpit-units-legacy|cockpit-units-edit|lista-unidades-container/);
  assert.doesNotMatch(painel, /Fluxo completo/);
});

test("digitar na busca da aba OS filtra só depois de 150 ms (contagem anunciada uma vez)", async () => {
  const { api, el } = criarAmbientePaineis();
  const filtros = [];
  const ouvintesBusca = {};
  global.SimpressDataPanels = { montarTabelaOs: () => ({}), filtrarTabelaOs: filtro => filtros.push(filtro), atualizarTabelaOs: async () => {} };
  try {
    el("cockpit-tickets-search").addEventListener = (tipo, fn) => { ouvintesBusca[tipo] = fn; };
    await api.abrirPainelCockpit("chamados");
    assert.equal(typeof ouvintesBusca.input, "function");
    filtros.length = 0;
    el("cockpit-tickets-search").value = "sn";
    ouvintesBusca.input();
    el("cockpit-tickets-search").value = "sn-1";
    ouvintesBusca.input();
    assert.equal(filtros.length, 0, "nada filtra antes da pausa");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(filtros.length, 1, "várias teclas viram um só filtro");
    assert.equal(filtros[0].busca, "sn-1");
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

// ---------- Chamados × OS: só a janela (o painel e os botões do topo foram removidos) ----------

test("Chamados × OS: sem botões no topo do F5/F6 nem painel antigo; a janela #modal-chamado-os continua", () => {
  assert.doesNotMatch(html, /id="btn-chamados-os-f5"|id="btn-chamados-os-f6"/);
  assert.doesNotMatch(html, /data-cockpit-tool-panel="chamados-os"|cockpit-chamados-os-/);
  assert.doesNotMatch(source, /"chamados-os"|loadChamadosOs|cockpit-chamados-os-/);
  assert.doesNotMatch(css, /\.ck-chos|#cockpit-chamados-os-/);
  const janela = html.match(/<div[^>]*id="modal-chamado-os"[\s\S]*?id="chamado-os-janela-f6"[\s\S]*?<\/button>/)?.[0] || "";
  // Como os outros .modal-overlay, role="dialog" e aria-modal vêm de accessible-dialogs.js ao abrir.
  assert.match(janela, /<div id="modal-chamado-os" class="modal-overlay ck-veu hidden" aria-labelledby="titulo-chamado-os">/);
  assert.match(janela, /<h3 id="titulo-chamado-os"[^>]*>Chamado × OS<\/h3>/);
  assert.match(janela, /Abrir na aba OS \(F6\)/);
});

test("janela Chamado × OS: abre o modal com o cartão só leitura e só a OS do chamado; fechar limpa", async () => {
  const modal = { abrir: [], fechar: [] };
  const pedidosCartao = [];
  const cartao = { dataset: { serie: "SN-1", os: "77" } };
  const { api, el } = criarAmbientePaineis({ appExtra: {
    abrirModalAcessivel: (...args) => modal.abrir.push(args),
    fecharModalAcessivel: id => modal.fechar.push(id),
    cartaoChamadoSebraeLeitura: async chave => { pedidosCartao.push(chave); return chave === "UTIC-2026-1" ? cartao : null; },
  } });
  const montadas = [];
  const linhaJanela = { dataset: { serial: "SN-1-REL", os: "77" } };
  global.SimpressDataPanels = {
    montarTabelaOs: (host, opcoes) => { montadas.push([host, opcoes]); return { querySelector: () => linhaJanela }; },
    filtrarTabelaOs() {}, atualizarTabelaOs: async () => {},
  };
  const conteudo = id => { const lista = []; el(id).replaceChildren = (...nos) => lista.push(nos); return lista; };
  try {
    const noChamado = conteudo("chamado-os-janela-chamado");
    const noOs = conteudo("chamado-os-janela-os");
    const gatilho = { isConnected: true };
    await api.abrirJanelaChamadoOs({ chamado: "UTIC-2026-1" }, gatilho);
    assert.deepEqual(modal.abrir, [["modal-chamado-os", "#chamado-os-janela-fechar", "fecharJanelaChamadoOs"]]);
    assert.deepEqual(pedidosCartao, ["UTIC-2026-1"]);
    assert.equal(noChamado.at(-1)[0], cartao, "o cartão só leitura do F5 vai para a esquerda");
    assert.equal(montadas.length, 1);
    const [host, opcoes] = montadas[0];
    assert.equal(host, el("chamado-os-janela-os"));
    assert.deepEqual(opcoes.soOs, { serie: "SN-1", os: "77", chamado: "UTIC-2026-1" }, "série e OS vêm do cartão; o chamado filtra as marcas de finalização");
    assert.equal(opcoes.somenteLeitura, true);
    assert.equal(opcoes.semBusca, true);
    assert.equal(el("chamado-os-janela-f6").hidden, false);

    // Abrir na aba OS (F6): fecha a janela e procura a linha com a grafia do relatório.
    const buscas = [];
    el("cockpit-tickets-os").querySelectorAll = seletor => { buscas.push(seletor); return seletor === "tbody tr[data-serial]" ? [{ dataset: { serial: "SN-1-REL", os: "77" } }] : []; };
    await el("chamado-os-janela-f6").onclick();
    assert.deepEqual(modal.fechar, ["modal-chamado-os"]);
    assert.ok(noChamado.at(-1).length === 0 && noOs.at(-1).length === 0, "fechar limpa os dois lados");
    assert.equal(el("cockpit-tools-dropdown").dataset.activeTool, "chamados");
    assert.ok(buscas.includes(".ck-os__andamento-btn"), "a linha SN-1-REL/77 foi achada na aba OS");

    // Chamado que não está no F5: avisa à esquerda e ainda mostra a OS pedida.
    await api.abrirJanelaChamadoOs({ chamado: "UTIC-X", serie: "SN-2", os: "88" });
    assert.equal(noChamado.at(-1)[0].textContent, "Chamado não encontrado na aba Chamados (F5).");
    assert.deepEqual(montadas.at(-1)[1].soOs, { serie: "SN-2", os: "88", chamado: "UTIC-X" });
  } finally { delete global.document; delete global.SimpressDataPanels; }
});

// ---------- Links de lembrete: abrirReferenciaLembrete abre a mesma janela, só com GETs existentes ----------

const modeloChamadosOs = require("../../static/js/shared/chamados-os-model.js");

// Ambiente da janela com respostas falsas: cartoes = { "UTIC-...": { os, serie } } (o que o F5 devolve); vinculos/sebrae = respostas dos GETs.
function ambienteReferencia({ cartoes = {}, vinculos = [], sebrae = {}, falhaVinculos = false, falhaSebrae = false } = {}) {
  const chamadasApi = [];
  const pedidosCartao = [];
  const apiFetch = async url => {
    chamadasApi.push(url);
    if (url === "/api/operacoes/chamados/vinculos-os") { if (falhaVinculos) throw new Error("falhou"); return { vinculos }; }
    if (url === "/api/sebrae/novos") { if (falhaSebrae) throw new Error("falhou"); return sebrae; }
    throw new Error(`GET inesperado: ${url}`);
  };
  const cartaoDe = chave => (cartoes[chave] ? { dataset: { os: cartoes[chave].os || "", serie: cartoes[chave].serie || "" } } : null);
  const ambiente = criarAmbientePaineis({
    apiFetch,
    contextExtra: { chamadosOsModel: modeloChamadosOs },
    appExtra: {
      abrirModalAcessivel() {},
      fecharModalAcessivel() {},
      cartaoChamadoSebraeLeitura: async chave => { pedidosCartao.push(chave); return cartaoDe(chave); },
    },
  });
  const montadas = [];
  global.SimpressDataPanels = {
    montarTabelaOs: (host, opcoes) => { montadas.push(opcoes); return { querySelector: () => null }; },
    filtrarTabelaOs() {}, atualizarTabelaOs: async () => {},
  };
  const conteudo = id => { const lista = []; ambiente.el(id).replaceChildren = (...nos) => lista.push(nos); return lista; };
  const noChamado = conteudo("chamado-os-janela-chamado");
  const noOs = conteudo("chamado-os-janela-os");
  const textos = lista => lista.at(-1).map(no => no.textContent);
  const limpar = () => { delete global.document; delete global.SimpressDataPanels; };
  return { ...ambiente, chamadasApi, pedidosCartao, montadas, noChamado, noOs, textos, limpar };
}

const vinculo = (os, chamado, extra = {}) => ({ fonte: "simpress", serie: "SN-1", os, chamado, ...extra });

test("lembrete, chamado com OS no cartão: abre cartão e a OS do cartão, sem consultar os vínculos", async () => {
  const a = ambienteReferencia({ cartoes: { "UTIC-2026-0833": { os: "1234567", serie: "SN-9" } } });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "chamado", numero: "UTIC-2026-0833" }, { isConnected: true });
    assert.deepEqual(a.pedidosCartao, ["UTIC-2026-0833"]);
    assert.deepEqual(a.chamadasApi, [], "a OS do cartão vence: nenhum GET");
    assert.deepEqual(a.montadas.at(-1).soOs, { serie: "SN-9", os: "1234567", chamado: "UTIC-2026-0833", lembrete: true });
    assert.equal(a.el("chamado-os-janela-f6").hidden, false);
  } finally { a.limpar(); }
});

test("lembrete, chamado sem OS no cartão: usa o vínculo salvo pelo chamado exato e respeita a prioridade", async () => {
  const a = ambienteReferencia({
    cartoes: { "UTIC-2026-0833": {} },
    vinculos: [
      vinculo("1111111", "UTIC-2026-0833", { origem: "dashboard" }),
      vinculo("2222222", "UTIC-2026-0833", { origem: "finalizacao" }),
      vinculo("3333333", "UTIC-2026-083"),
    ],
  });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "chamado", numero: "UTIC-2026-0833" });
    assert.deepEqual(a.chamadasApi, ["/api/operacoes/chamados/vinculos-os"]);
    assert.deepEqual(a.montadas.at(-1).soOs, { serie: "SN-1", os: "2222222", chamado: "UTIC-2026-0833", lembrete: true }, "finalizacao vence dashboard; UTIC-2026-083 não casa");
  } finally { a.limpar(); }
});

test("lembrete, cartão do F5 com OS \"—\": trata como sem OS, usa o vínculo e não leva a série do cartão", async () => {
  const a = ambienteReferencia({
    cartoes: { "UTIC-2026-0833": { os: "—", serie: "SN-CARTAO" } },
    vinculos: [vinculo("2222222", "UTIC-2026-0833", { serie: "" })],
  });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "chamado", numero: "UTIC-2026-0833" });
    assert.deepEqual(a.textos(a.noOs.slice(0, 1)), ["Carregando…"], "lado da OS começa com Carregando…");
    assert.deepEqual(a.chamadasApi, ["/api/operacoes/chamados/vinculos-os"]);
    assert.deepEqual(a.montadas.at(-1).soOs, { serie: "", os: "2222222", chamado: "UTIC-2026-0833", lembrete: true });
    assert.deepEqual(a.noOs.at(-1), [], "o Carregando… sai antes de a tabela da OS ser montada");
  } finally { a.limpar(); }
});

test("lembrete, chamado com duas OS na mesma prioridade: não escolhe e avisa à direita", async () => {
  const a = ambienteReferencia({ cartoes: { "UTIC-2026-1": {} }, vinculos: [vinculo("2222222", "UTIC-2026-1"), vinculo("1111111", "UTIC-2026-1")] });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "chamado", numero: "UTIC-2026-1" });
    assert.deepEqual(a.textos(a.noOs), ["Mais de uma OS ligada a este chamado (1111111, 2222222). Abra pela aba OS (F6)."]);
    assert.equal(a.montadas.length, 0);
    assert.equal(a.el("chamado-os-janela-f6").hidden, true);
  } finally { a.limpar(); }
});

test("lembrete, chamado sem OS em lugar nenhum: frase de sempre; chamado inexistente: só o aviso à esquerda", async () => {
  const a = ambienteReferencia({ cartoes: { "UTIC-2026-1": {} }, vinculos: [vinculo("1111111", "UTIC-2026-2")] });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "chamado", numero: "UTIC-2026-1" });
    assert.deepEqual(a.textos(a.noOs), ["Nenhuma OS vinculada por série na importação atual."]);
    assert.equal(a.montadas.length, 0);

    await a.api.abrirReferenciaLembrete({ tipo: "chamado", numero: "UTIC-2026-9999" });
    assert.deepEqual(a.textos(a.noChamado), ["Chamado não encontrado na aba Chamados (F5)."]);
    assert.deepEqual(a.noOs.at(-1), [], "lado da OS fica vazio (o CSS o esconde)");
    assert.equal(a.montadas.length, 0);
  } finally { a.limpar(); }
});

test("lembrete, chamado ausente do F5 mas com vínculo: mostra o aviso do chamado e a OS ligada", async () => {
  const a = ambienteReferencia({ vinculos: [vinculo("2222222", "UTIC-2026-7")] });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "chamado", numero: "UTIC-2026-7" });
    assert.deepEqual(a.textos(a.noChamado), ["Chamado não encontrado na aba Chamados (F5)."]);
    assert.equal(a.montadas.at(-1).soOs.os, "2222222");
  } finally { a.limpar(); }
});

test("lembrete, chamado com a leitura de vínculos falhando: não quebra e cai na frase de sempre", async () => {
  const a = ambienteReferencia({ cartoes: { "UTIC-2026-1": {} }, falhaVinculos: true });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "chamado", numero: "UTIC-2026-1" });
    assert.deepEqual(a.textos(a.noOs), ["Nenhuma OS vinculada por série na importação atual."]);
  } finally { a.limpar(); }
});

test("lembrete, OS ligada a um chamado: abre o cartão desse chamado e só essa OS", async () => {
  const a = ambienteReferencia({ cartoes: { "UTIC-2026-0833": { os: "1234567", serie: "SN-1" } }, vinculos: [vinculo("1234567", "utic-2026-0833")] });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "os", numero: "1234567" }, { isConnected: true });
    assert.deepEqual([...a.chamadasApi].sort(), ["/api/operacoes/chamados/vinculos-os", "/api/sebrae/novos"]);
    assert.deepEqual(a.pedidosCartao, ["UTIC-2026-0833"]);
    assert.deepEqual(a.montadas.at(-1).soOs, { serie: "SN-1", os: "1234567", chamado: "UTIC-2026-0833", lembrete: true });
  } finally { a.limpar(); }
});

test("lembrete, OS que só o F5 liga a um chamado: usa o F5 em aberto", async () => {
  const sebrae = { novos: { formulario: [{ numero: "UTIC-2026-5", linha: { E: "5555555", K: "SN-5" } }] } };
  const a = ambienteReferencia({ cartoes: { "UTIC-2026-5": { os: "5555555", serie: "SN-5" } }, sebrae });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "os", numero: "5555555" });
    assert.deepEqual(a.pedidosCartao, ["UTIC-2026-5"]);
    assert.deepEqual(a.montadas.at(-1).soOs, { serie: "SN-5", os: "5555555", chamado: "UTIC-2026-5", lembrete: true });
  } finally { a.limpar(); }
});

test("lembrete, OS sem chamado (inclusive com as duas leituras falhando): só a OS, sem série e sem cartão", async () => {
  for (const falhas of [{}, { falhaVinculos: true, falhaSebrae: true }]) {
    const a = ambienteReferencia(falhas);
    try {
      await a.api.abrirReferenciaLembrete({ tipo: "os", numero: "7654321" });
      assert.deepEqual(a.pedidosCartao, []);
      assert.deepEqual(a.noChamado.at(-1), [], "lado do chamado fica vazio (o CSS o esconde)");
      assert.deepEqual(a.montadas.at(-1).soOs, { serie: "", os: "7654321", chamado: "", lembrete: true });
      assert.equal(a.el("chamado-os-janela-f6").hidden, false);
    } finally { a.limpar(); }
  }
});

test("lembrete, OS ligada a mais de um chamado: abre só a OS e avisa à esquerda", async () => {
  const a = ambienteReferencia({ vinculos: [vinculo("1234567", "UTIC-2026-9"), vinculo("1234567", "UTIC-2026-2")] });
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "os", numero: "1234567" });
    assert.deepEqual(a.pedidosCartao, []);
    assert.deepEqual(a.textos(a.noChamado), ["OS ligada a mais de um chamado (UTIC-2026-2, UTIC-2026-9)."]);
    assert.equal(a.montadas.at(-1).soOs.os, "1234567");
  } finally { a.limpar(); }
});

test("lembrete: tipo desconhecido ou número vazio não abre nada", async () => {
  const a = ambienteReferencia();
  try {
    await a.api.abrirReferenciaLembrete({ tipo: "x", numero: "1" });
    await a.api.abrirReferenciaLembrete({ tipo: "os", numero: "" });
    await a.api.abrirReferenciaLembrete();
    assert.deepEqual([a.chamadasApi, a.pedidosCartao, a.montadas], [[], [], []]);
  } finally { a.limpar(); }
});

test("lembrete: pedido antigo que termina depois de um novo não sobrescreve a janela", async () => {
  let liberar;
  const a = ambienteReferencia({ cartoes: { "UTIC-2026-2": { os: "2222222", serie: "SN-2" } } });
  try {
    // O primeiro pedido espera no resolver; o segundo (chamado com OS no cartão) termina antes.
    const lento = a.api.abrirJanelaChamadoOs({ os: "1111111", resolver: () => new Promise(resolve => { liberar = resolve; }) });
    await a.api.abrirJanelaChamadoOs({ chamado: "UTIC-2026-2" });
    liberar({ chamado: "UTIC-2026-1" });
    await lento;
    assert.deepEqual(a.pedidosCartao, ["UTIC-2026-2"], "o pedido antigo parou antes de pedir o cartão");
    assert.equal(a.montadas.length, 1);
    assert.equal(a.montadas[0].soOs.os, "2222222");
  } finally { a.limpar(); }
});

test("lembrete: ao fechar, o foco volta ao link equivalente quando a lista se redesenhou", async () => {
  const a = ambienteReferencia();
  try {
    const args = JSON.stringify([{ tipo: "os", numero: "7654321" }, "$this"]);
    const antigo = { isConnected: false, matches: seletor => seletor === ".lembretes__ref", getAttribute: nome => (nome === "data-args" ? args : null) };
    const focados = [];
    const novo = { getAttribute: nome => (nome === "data-args" ? args : null), focus: () => focados.push("novo") };
    const outro = { getAttribute: () => "[]", focus: () => focados.push("outro") };
    const consultas = [];
    global.document.querySelectorAll = seletor => { consultas.push(seletor); return [outro, novo]; };
    await a.api.abrirReferenciaLembrete({ tipo: "os", numero: "7654321" }, antigo);
    a.api.fecharJanelaChamadoOs();
    assert.deepEqual(consultas, ["button.lembretes__ref"]);
    assert.deepEqual(focados, ["novo"]);
  } finally { a.limpar(); }
});
