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
    ["btn-cockpit-comparacao", "comparacao", "F7"],
    ["btn-historico-apelidos", "apelidos", "F8"],
    ["btn-relatorio-mensal", "relatorio", "F9"],
  ];
  for (const [id, panel, shortcut] of expected) {
    const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] || "";
    assert.match(button, new RegExp(`data-on-click="abrirPainelCockpit"`));
    assert.match(button, new RegExp(`data-args='\\["${panel}"\\]'`));
    // OS fica na barra principal (title com o atalho); os demais seguem no menu com <kbd> (Comparação F7, Histórico de apelidos F8, Relatório mensal F9).
    if (panel === "chamados") assert.match(button, new RegExp(`title="OS \\(${shortcut}\\)"`));
    else if (shortcut) assert.match(html, new RegExp(`<kbd aria-hidden="true">${shortcut}</kbd>`));
    else assert.doesNotMatch(html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?</button>`))[0], /<kbd/);
    assert.match(html, new RegExp(`data-cockpit-tool-panel="${panel}"`));
  }
  assert.match(html, /id="cockpit-tool-panels"[^>]*hidden/);
  assert.match(html, /id="cockpit-comparison-event"/);
  // O resultado completo mora na aba Comparação; lista/detalhe/KPIs/filtros/exportação antigos e o modal saíram.
  const comparacao = html.match(/<section[^>]*data-cockpit-tool-panel="comparacao"[\s\S]*?\n        <\/section>/)?.[0] || "";
  for (const id of ["comparacao-planilhas-conteudo", "comparacao-planilhas-fontes", "btn-exportar-resultado-comparacao"]) {
    assert.equal(comparacao.split(`id="${id}"`).length - 1, 1, `${id} dentro da aba Comparação`);
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
  // Ordem final da barra: ... Automação, Chamados (F5), OS (F6).
  assert.ok(html.indexOf('id="tab-automacao"') < html.indexOf('id="btn-sebrae-chamados-aba"'));
  assert.ok(html.indexOf('id="btn-sebrae-chamados-aba"') < html.indexOf('id="btn-acompanhamento-chamados"'));
  // Atalho F1-F6 pequeno em cada aba principal, escondido dos leitores de tela (o aria-label já traz o nome).
  for (const [id, atalho] of [["tab-home", "F1"], ["tab-retirada-entrega", "F2"], ["tab-resumo", "F3"], ["tab-automacao", "F4"], ["btn-sebrae-chamados-aba", "F5"], ["btn-acompanhamento-chamados", "F6"]]) {
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
  // Desde 31/10/2026 o menu não tem o grupo "Planilhas": Atualizar planilhas saiu; Exportar Excel (modelo) mora na aba Comparação.
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
  for (const id of ["sebrae-novos-lista", "sebrae-antigos", "sebrae-antigos-lista", "sebrae-antigos-resumo", "sebrae-sugestoes-a", "sebrae-sugestoes-b", "sebrae-sugestoes-s", "btn-sebrae-exportar", "btn-sebrae-atualizar", "sebrae-exportacao-status", "sebrae-atualizar-status", "sebrae-exportacao-blocos", "sebrae-bloco-a-p", "sebrae-bloco-r-s"]) {
    assert.equal(painel.split(`id="${id}"`).length - 1, 1, `${id} no painel`);
    assert.doesNotMatch(cartao, new RegExp(`id="${id}"`), `${id} fora do cartão`);
  }
  for (const id of ["sebrae-dashboard-file", "btn-sebrae-importar", "btn-sebrae-buscar", "sebrae-dashboard-status", "sebrae-novos-resumo", "sebrae-novos-avisos", "sebrae-historico-resumo"]) {
    assert.match(cartao, new RegExp(`id="${id}"`), `${id} no cartão`);
  }
  assert.doesNotMatch(html, /btn-sebrae-historico|data-cockpit-tool-panel="sebrae-historico"|sebrae-historico-(kpis|lista|detalhe|filtro|status)/);
  assert.match(html, /\.sebrae-chamado\b/.source ? /id="sebrae-novos-lista"/ : /x/);
  assert.match(css, /^\.sebrae-chamado \{/m);
  assert.match(css, /^\.sebrae-blocos \{/m);
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
