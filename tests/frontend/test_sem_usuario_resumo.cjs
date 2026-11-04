const assert = require("node:assert/strict");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createComparisonResultRenderer = require("../../static/js/ui/comparison-result-renderer.js");
const createLoggedUserMarkers = require("../../static/js/ui/logged-user-markers.js");
const createComparisonResult = require("../../static/js/features/comparison-result.js");

const dom = createDomUtils({ createElement: () => ({ setAttribute() {} }) });
const rendererContext = { app: { atributosVersaoAnotacao: () => "" }, dom, historyFormat, loggedUserMarkers: createLoggedUserMarkers({ dom }) };
const renderer = createComparisonResultRenderer(rendererContext);

// The table renderer derives mobile cards through <template>; the markup checks only need the desktop rows.
globalThis.document = { createElement: () => ({ content: { querySelector: () => null } }) };

function renderizar(semUsuario) {
  const comparison = { total_endpoint: 3, sem_acesso_7_dias: [], mudancas_usuarios: [] };
  const listas = { ...renderer.listasComparacao(comparison), ...(semUsuario === undefined ? {} : { semUsuario }) };
  return renderer.conteudoResultadoComparacao(comparison, listas, renderer.criarColunasAnotacao(comparison));
}

const ITENS = [
  { serial: "SN-2", apelido: "PRNOTE-B", retirada_cidade: "Londrina", modelo: "Latitude" },
  { serial: "SN-1", apelido: "PRNOTE-A", retirada_cidade: "Curitiba", modelo: "MacBook" },
];

test("Sem usuário section lists notebook rows with the comparison row attributes and a summary card", () => {
  const html = renderizar({ estado: "ok", items: ITENS });
  assert.match(html, /<h4 id="comparacao-secao-sem-usuario" tabindex="-1"[^>]*>(?:<span[^>]*><\/span>)?Sem usuário<\/h4>/);
  const linhas = [...html.matchAll(/<tr [^>]*data-comparison-category="sem_usuario"[^>]*>/g)].map(([tag]) => tag);
  assert.equal(linhas.length, 2);
  assert.match(linhas[0], /data-comparison-serial="SN-1"[^>]*data-comparison-hostname="PRNOTE-A"/, "rows are sorted by hostname");
  assert.match(linhas[1], /data-comparison-serial="SN-2"[^>]*data-comparison-hostname="PRNOTE-B"/);
  assert.match(html, /data-history-filter-group="sem_usuario"/);
  assert.match(html, /Hostname\/Apelido, Série, Local, Modelo/);
  const cartao = html.match(/<button [^>]*data-comparison-section-target="comparacao-secao-sem-usuario"[^>]*aria-label="([^"]+)"/);
  assert.equal(cartao?.[1], "Sem usuário: 2. Ir para Sem usuário");
});

test("Sem usuário with no rows keeps the section, an empty message and a static card", () => {
  const html = renderizar({ estado: "ok", items: [] });
  assert.match(html, /Todos os notebooks do cadastro têm usuário\./);
  assert.doesNotMatch(html, /data-comparison-section-target="comparacao-secao-sem-usuario"/);
  assert.match(html, /<p class="text-xs uppercase tracking-wide text-fg-subtle">Sem usuário<\/p>/);
});

test("Sem usuário read error shows a message and no card; without the read the section is left out", () => {
  const erro = renderizar({ estado: "erro", items: [] });
  assert.match(erro, /data-sem-usuario-section="erro"/);
  assert.match(erro, /Não foi possível consultar os notebooks sem usuário agora/);
  assert.doesNotMatch(erro, /<p class="text-xs uppercase tracking-wide text-fg-subtle">Sem usuário<\/p>/);
  const ausente = renderizar(undefined);
  assert.doesNotMatch(ausente, /Sem usuário|comparacao-secao-sem-usuario/);
});

test("Sem usuário values are escaped", () => {
  const html = renderizar({ estado: "ok", items: [{ serial: "<b>x</b>", apelido: "<img src=x>", retirada_cidade: "", modelo: "" }] });
  assert.doesNotMatch(html, /<img src=x>|<b>x<\/b>/);
});

// Navigation: a fake result page with rows in several sections.
function criarLinha(categoria, serial, hostname) {
  return {
    dataset: { comparisonCategory: categoria, comparisonSerial: serial, comparisonHostname: hostname, comparisonItemId: "" },
    scrolled: 0,
    getClientRects: () => [{}],
    scrollIntoView() { this.scrolled += 1; },
  };
}

function criarNavegacao(linhas) {
  const content = { querySelectorAll: seletor => (seletor.includes("data-comparison-category") ? linhas : []), querySelector: () => null };
  const revealed = [];
  globalThis.document = { getElementById: id => (id === "comparacao-planilhas-conteudo" ? content : null) };
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  const api = createComparisonResult({
    app: {}, appState: {}, motion: { reveal: row => revealed.push(row) }, dom, historyFormat,
    comparisonResultRenderer: () => renderer, loggedUserMarkers: createLoggedUserMarkers({ dom }),
  });
  return { api, revealed };
}

test("navegarParaLinhaComparacao with sem_usuario highlights the Sem usuário row, not another section of the same serial", () => {
  const divergente = criarLinha("divergencias_local", "SN-1", "PRNOTE-A");
  const semUsuario = criarLinha("sem_usuario", "SN-1", "PRNOTE-A");
  const { api, revealed } = criarNavegacao([divergente, semUsuario]);
  try {
    api.navegarParaLinhaComparacao({ serial: "sn-1", category: "sem_usuario" });
    assert.equal(semUsuario.scrolled, 1);
    assert.equal(divergente.scrolled, 0);
    assert.deepEqual(revealed, [semUsuario]);
  } finally { delete globalThis.window; }
});

test("navegarParaLinhaComparacao falls back to the serial when the Home category has no row in this result", () => {
  const ambigua = criarLinha("correspondencias_ambiguas", "SN-3", "PRNOTE-C");
  const { api, revealed } = criarNavegacao([ambigua]);
  try {
    api.navegarParaLinhaComparacao({ serial: "SN-3", category: "divergencias_local" });
    assert.deepEqual(revealed, [ambigua]);
    const { api: vazio, revealed: nada } = criarNavegacao([ambigua]);
    vazio.navegarParaLinhaComparacao({ serial: "SN-9", category: "sem_usuario" });
    assert.deepEqual(nada, [], "an unknown serial highlights nothing and does not loop");
  } finally { delete globalThis.window; }
});

test("carregarSemUsuarioResumo pages the notebooks without user and reports errors without throwing", async () => {
  const urls = [];
  const paginas = [
    { items: Array.from({ length: 100 }, (_, i) => ({ serial: `A${i}` })), has_more: true },
    { items: [{ serial: "Z1" }], has_more: false },
  ];
  globalThis.document = {};
  const criar = apiFetch => createComparisonResult({
    app: { apiFetch }, appState: {}, motion: null, dom, historyFormat,
    comparisonResultRenderer: () => renderer, loggedUserMarkers: createLoggedUserMarkers({ dom }),
  });
  const ok = await criar(async url => { urls.push(url); return paginas[urls.length - 1]; }).carregarSemUsuarioResumo();
  assert.equal(ok.estado, "ok");
  assert.equal(ok.items.length, 101);
  assert.deepEqual(urls, [
    "/api/buscar-expandida?listar_todos=true&usuario=sem&limit=100&offset=0",
    "/api/buscar-expandida?listar_todos=true&usuario=sem&limit=100&offset=100",
  ]);
  const falha = await criar(async () => { throw new Error("fora"); }).carregarSemUsuarioResumo();
  assert.deepEqual({ estado: falha.estado, total: falha.items.length }, { estado: "erro", total: 0 });
});

test("carregarSemUsuarioResumo reutiliza o resultado bem-sucedido e só relê depois de invalidar; erro não entra no cache", async () => {
  let chamadas = 0;
  globalThis.document = {};
  const criar = apiFetch => createComparisonResult({
    app: { apiFetch }, appState: {}, motion: null, dom, historyFormat,
    comparisonResultRenderer: () => renderer, loggedUserMarkers: createLoggedUserMarkers({ dom }),
  });
  const api = criar(async () => { chamadas += 1; return { items: [{ serial: "A" }], has_more: false, total: 1 }; });
  const primeira = await api.carregarSemUsuarioResumo();
  const segunda = await api.carregarSemUsuarioResumo();
  assert.equal(chamadas, 1);
  assert.equal(segunda, primeira);
  api.invalidarSemUsuarioResumo();
  await api.carregarSemUsuarioResumo();
  assert.equal(chamadas, 2);

  let falhar = true;
  const instavel = criar(async () => { if (falhar) throw new Error("fora"); return { items: [], has_more: false }; });
  assert.equal((await instavel.carregarSemUsuarioResumo()).estado, "erro");
  falhar = false;
  assert.equal((await instavel.carregarSemUsuarioResumo()).estado, "ok", "falha não fica em cache");

  // Invalidar durante uma leitura em andamento: o resultado antigo não é guardado.
  let liberar;
  const lenta = criar(() => new Promise(resolve => { liberar = () => resolve({ items: [{ serial: "V" }], has_more: false }); }));
  const pendente = lenta.carregarSemUsuarioResumo();
  lenta.invalidarSemUsuarioResumo();
  liberar();
  assert.equal((await pendente).estado, "ok");
  let reler = 0;
  const outra = criar(async () => { reler += 1; return { items: [], has_more: false }; });
  await outra.carregarSemUsuarioResumo();
  assert.equal(reler, 1);
});

test("carregarSemUsuarioResumo ao bater o limite de páginas devolve estado limite com os itens lidos e o total", async () => {
  let chamadas = 0;
  globalThis.document = {};
  const api = createComparisonResult({
    app: { apiFetch: async () => { chamadas += 1; return { items: Array.from({ length: 100 }, (_, i) => ({ serial: `P${chamadas}-${i}` })), has_more: true, total: 2500 }; } },
    appState: {}, motion: null, dom, historyFormat,
    comparisonResultRenderer: () => renderer, loggedUserMarkers: createLoggedUserMarkers({ dom }),
  });
  const resultado = await api.carregarSemUsuarioResumo();
  assert.equal(chamadas, 20);
  assert.equal(resultado.estado, "limite");
  assert.equal(resultado.items.length, 2000);
  assert.equal(resultado.total, 2500);
  await api.carregarSemUsuarioResumo();
  assert.equal(chamadas, 20, "o estado limite também fica em cache");
});

test("Sem usuário em estado limite mostra os itens lidos e um aviso próprio, sem a mensagem de erro e sem cartão", () => {
  globalThis.document = { createElement: () => ({ content: { querySelector: () => null } }) };
  const html = renderizar({ estado: "limite", items: ITENS, total: 2500 });
  assert.match(html, /data-sem-usuario-section="limite"/);
  assert.match(html, /Mostrando os primeiros 2 de 2\.500 notebooks sem usuário; há mais no cadastro\./);
  assert.doesNotMatch(html, /Não foi possível consultar os notebooks sem usuário/);
  assert.equal([...html.matchAll(/<tr [^>]*data-comparison-category="sem_usuario"[^>]*>/g)].length, 2);
  assert.doesNotMatch(html, /data-comparison-section-target="comparacao-secao-sem-usuario"/);
  assert.match(renderizar({ estado: "limite", items: ITENS }), /Mostrando os primeiros 2 notebooks sem usuário; há mais/);
});
