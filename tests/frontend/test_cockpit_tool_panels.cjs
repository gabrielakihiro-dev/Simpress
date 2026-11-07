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
    changesThisMonth: 2, equipmentAffected: 1, outOfPattern: null, duplicateAliases: null,
  });
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

test("sebraeMonthKey reads Dashboard (dd/mm/aaaa HH:mm) and ISO dates and ignores anything else", () => {
  assert.equal(panels.sebraeMonthKey("05/11/2026 14:12"), "2026-11");
  assert.equal(panels.sebraeMonthKey("5/1/2026"), "2026-01");
  assert.equal(panels.sebraeMonthKey("2026-10-31T23:59:00-03:00"), "2026-10");
  assert.equal(panels.sebraeMonthKey(""), "");
  assert.equal(panels.sebraeMonthKey("ontem"), "");
});

test("Sebrae lists follow the F5 rule and one ticket opened and finalized in the month is one row", () => {
  const data = {
    importado: {
      abertos: [{ numero: "UTIC-2026-1", titulo: "A", leitura_softexpert: { habilitada_em: "03/10/2026 10:00" } }, { numero: "UTIC-2026-2", titulo: "B" }],
      finalizados: [{ numero: "UTIC-2026-1", encerrado_em: "20/10/2026 15:00", ficha: { titulo: "A", fatos: [["Série", "SN-1"]] } }],
    },
    novos: { formulario: [{ numero: "UTIC-2026-3", linha: { G: "C", K: "SN-3", P: "02/09/2026 08:30" } }] },
  };
  const lists = panels.sebraeOpenLists(data);
  assert.deepEqual(lists.antigos.map(item => item.numero), ["UTIC-2026-2"]);
  assert.deepEqual(lists.novos.map(item => item.numero), ["UTIC-2026-3"]);
  const october = panels.sebraeMonthRows(data, "2026-10");
  assert.equal(october.length, 1);
  assert.deepEqual(october[0].situacoes, ["Aberto no mês", "Finalizado no mês"]);
  assert.equal(october[0].abertura, "03/10/2026 10:00");
  assert.equal(october[0].finalizacao, "20/10/2026 15:00");
  assert.deepEqual(panels.sebraeMonthRows(data, "2026-09").map(row => row.numero), ["UTIC-2026-3"]);
  assert.match(panels.monthlyPreviewText({ mes: { label: "outubro de 2026" } }, data), /Chamados \(F5\), situação atual: 1 novo · 1 antigo em aberto/);
});

// DOM falso permissivo: qualquer propriedade desconhecida vira função/objeto inerte; só o que o roteamento lê é real.
function criarAmbientePaineis({ apiFetch = async () => ({}), appExtra = {} } = {}) {
  const elementos = new Map();
  const ouvintes = [];
  const novo = id => new Proxy({ id, hidden: true, open: false, dataset: {}, textContent: "", value: "", children: [], attrs: {} }, {
    get(alvo, chave) {
      if (chave in alvo) return alvo[chave];
      if (chave === "isConnected") return true;
      if (chave === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (chave === "setAttribute") return (n, v) => { alvo.attrs[n] = v; };
      if (chave === "getAttribute") return n => alvo.attrs[n] ?? null;
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
  const api = createCockpitToolPanels({ app, appState: {}, apiFetch });
  const el = id => document.getElementById(id);
  const esc = () => { let prevenido = false; ouvintes.filter(([t]) => t === "keydown").forEach(([, fn]) => fn({ key: "Escape", defaultPrevented: false, preventDefault() { prevenido = true; } })); return prevenido; };
  return { api, el, esc };
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
  assert.match(html, /<div id="cockpit-tickets-os" class="ck-ferr-os"><\/div>/);
  assert.doesNotMatch(html, /id="cockpit-tickets-(list|detail)"/);
  const idsChamados = [
    "cockpit-tickets-kpis", "cockpit-tickets-triage", "cockpit-tickets-search", "cockpit-tickets-relation", "cockpit-tickets-attention",
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
    assert.deepEqual(calls.filtrar, [{ busca: "", relacao: "", triagem: "", atencao: false }], "Relação 'todos' vira filtro vazio");
    assert.deepEqual(calls.atualizar, [], "a tabela recém-montada já carrega sozinha");

    // aoCarregar recebe o relatório (KPIs) e aoExpandirSerie preenche a linha de Andamento.
    const kpis = el("cockpit-tickets-kpis");
    let kpiRenders = 0;
    kpis.replaceChildren = () => { kpiRenders += 1; };
    opcoes.aoCarregar({ resumo: { series_total: 2 }, chamados: [{ serie: "SN-1", relacao: "conferida", oracle: [], simpress: {} }] });
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
    assert.deepEqual(filtros.at(0), { busca: "SN-9", relacao: "somente_oracle", triagem: "", atencao: false });
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
