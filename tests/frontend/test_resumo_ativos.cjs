// Resumo (painel "comparacao"): cartão "Ativos por regional" com filtro por categoria, DOM falso e fetch simulado.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");

const root = path.resolve(__dirname, "../..");
const html = assembledHtml();
const appSource = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "static/app-entry.js"), "utf8");

const newStyle = () => ({ setProperty(name, value) { this[name] = value; } });

function mount() {
  const doc = createFakeDocument();
  const make = (tag, id, extra = {}) => {
    const node = doc.createElement(tag);
    node.style = newStyle();
    node.setAttribute("id", id);
    Object.assign(node, extra);
    doc.body.appendChild(node);
    return node;
  };
  const original = doc.createElement.bind(doc);
  doc.createElement = tag => Object.assign(original(tag), { style: newStyle() });
  const nodes = {
    regionais: make("div", "resumo-regionais"),
    filtros: make("div", "resumo-regionais-filtros"),
    contagem: make("span", "resumo-regionais-contagem"),
    mais: make("button", "resumo-regionais-mais", { hidden: true }),
  };
  return { doc, nodes };
}

function load({ painel, motion }) {
  const { doc, nodes } = mount();
  const requests = [];
  globalThis.document = doc;
  globalThis.fetch = async url => {
    requests.push(url);
    if (painel instanceof Error) throw painel;
    return { ok: true, json: async () => painel };
  };
  const feature = require("../../static/js/features/resumo-ativos.js")({ app: {}, motion });
  return { feature, nodes, requests };
}

const cidades = (n, base = 100) => Array.from({ length: n }, (_, i) => ({ cidade: `Cidade ${String(i + 1).padStart(2, "0")}`, total: base - i }));
const painelBase = () => ({
  total_equipamentos: 16,
  por_categoria: [
    { value: "notebook", label: "Notebooks", total: 10 },
    { value: "macbook", label: "MacBooks", total: 3 },
    { value: "monitor", label: "Monitores", total: 2 },
    { value: "fone", label: "Fones", total: 0 },
  ],
  cidades_principais: [{ cidade: "Londrina", total: 5 }, { cidade: "Curitiba", total: 10 }, { cidade: "", total: 1 }],
  cidades_por_categoria: {
    notebook: [{ cidade: "Curitiba", total: 8 }, { cidade: "Londrina", total: 2 }],
    macbook: [{ cidade: "Londrina", total: 3 }],
    monitor: [{ cidade: "Curitiba", total: 2 }],
    fone: [],
  },
});
const nomes = nodes => nodes.regionais.querySelectorAll(".ck-barra").map(b => b.querySelector(".ck-barra__nome").textContent);
const pilula = (nodes, categoria) => nodes.filtros.querySelectorAll("button").find(b => b.dataset.categoria === categoria);
const tick = () => new Promise(resolve => setImmediate(resolve));

test("registro: módulo importado no app-entry e publicado no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\/js\/features\/resumo-ativos\.js";/);
  assert.match(appSource, /"resumoAtivos",/);
});

test("regionais: barras ordenadas pelo total, largura proporcional e contagem no cabeçalho", async () => {
  const { feature, nodes, requests } = load({ painel: painelBase() });
  await feature.carregarResumoAtivos();
  assert.deepEqual(requests, ["/api/painel"]);
  const barras = nodes.regionais.querySelectorAll(".ck-barra");
  assert.deepEqual(nomes(nodes), ["Curitiba", "Londrina", "Sem cidade"]);
  assert.deepEqual(barras.map(b => b.querySelector(".ck-barra__valor").textContent), ["10", "5", "1"]);
  assert.deepEqual(barras.map(b => b.querySelector(".ck-barra__cheio").style.width), ["100%", "50%", "10%"]);
  assert.equal(nodes.contagem.textContent, "16 ativos em 3 regionais");
  assert.equal(nodes.regionais.getAttribute("aria-busy"), "false");
  assert.equal(nodes.mais.hidden, true, "até 8 regionais não precisa de 'Ver todas'");
});

test("filtros: Todos + 4 categorias com contagem, só Todos marcado e categoria sem ativos desabilitada", async () => {
  const { feature, nodes } = load({ painel: painelBase() });
  await feature.carregarResumoAtivos();
  const pilulas = nodes.filtros.querySelectorAll("button");
  assert.deepEqual(pilulas.map(p => p.dataset.categoria), ["todos", "notebook", "macbook", "monitor", "fone"]);
  assert.deepEqual(pilulas.map(p => p.getAttribute("aria-pressed")), ["true", "false", "false", "false", "false"]);
  assert.deepEqual(pilulas.map(p => p.textContent), ["Todos 16", "Notebooks 10", "MacBooks 3", "Monitores 2", "Fones 0"]);
  assert.deepEqual(pilulas.map(p => p.disabled), [false, false, false, false, true]);
});

test("filtros: escolher categoria troca as barras e a contagem; voltar a Todos restaura", async () => {
  const { feature, nodes } = load({ painel: painelBase() });
  await feature.carregarResumoAtivos();
  pilula(nodes, "notebook").click();
  assert.deepEqual(nomes(nodes), ["Curitiba", "Londrina"]);
  assert.equal(nodes.contagem.textContent, "10 ativos em 2 regionais");
  assert.equal(pilula(nodes, "notebook").getAttribute("aria-pressed"), "true");
  assert.equal(pilula(nodes, "todos").getAttribute("aria-pressed"), "false");
  pilula(nodes, "macbook").click();
  assert.deepEqual(nomes(nodes), ["Londrina"]);
  pilula(nodes, "todos").click();
  assert.deepEqual(nomes(nodes), ["Curitiba", "Londrina", "Sem cidade"]);
});

test("filtros: após escolher, o foco volta para a pílula nova (as pílulas são recriadas)", async () => {
  const { feature, nodes } = load({ painel: painelBase() });
  await feature.carregarResumoAtivos();
  const focados = [];
  const original = nodes.filtros.replaceChildren.bind(nodes.filtros);
  nodes.filtros.replaceChildren = (...filhos) => {
    original(...filhos);
    filhos.forEach(filho => { filho.focus = () => focados.push(filho.dataset.categoria); });
  };
  pilula(nodes, "notebook").click();
  pilula(nodes, "macbook").click();
  assert.deepEqual(focados, ["notebook", "macbook"]);
});

test("filtros: o filtro escolhido sobrevive a recarregar o painel", async () => {
  const { feature, nodes } = load({ painel: painelBase() });
  await feature.carregarResumoAtivos();
  pilula(nodes, "monitor").click();
  await feature.carregarResumoAtivos();
  assert.deepEqual(nomes(nodes), ["Curitiba"]);
  assert.equal(pilula(nodes, "monitor").getAttribute("aria-pressed"), "true");
});

test("filtros: categoria escolhida que fica sem ativos após recarregar volta para Todos", async () => {
  const { feature, nodes } = load({ painel: painelBase() });
  await feature.carregarResumoAtivos();
  pilula(nodes, "monitor").click();
  const vazio = painelBase();
  vazio.por_categoria[2].total = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => vazio });
  await feature.carregarResumoAtivos();
  assert.equal(pilula(nodes, "monitor").disabled, true);
  assert.equal(pilula(nodes, "monitor").getAttribute("aria-pressed"), "false");
  assert.equal(pilula(nodes, "todos").getAttribute("aria-pressed"), "true");
});

test("regionais: mais de 8 mostram todas por padrão e 'Ver menos' recolhe para o top 8", async () => {
  const painel = { ...painelBase(), cidades_principais: cidades(12), total_equipamentos: 12 };
  const { feature, nodes } = load({ painel });
  await feature.carregarResumoAtivos();
  assert.equal(nomes(nodes).length, 12);
  assert.equal(nodes.regionais.style["--linhas"], "6");
  assert.equal(nodes.mais.hidden, false);
  assert.equal(nodes.mais.textContent, "Ver menos");
  assert.equal(nodes.mais.getAttribute("aria-expanded"), "true");
  nodes.mais.click();
  assert.equal(nomes(nodes).length, 8);
  assert.equal(nodes.regionais.style["--linhas"], "4");
  assert.equal(nodes.mais.textContent, "Ver todas as 12 regionais");
  assert.equal(nodes.mais.getAttribute("aria-expanded"), "false");
  pilula(nodes, "todos").click();
  assert.equal(nomes(nodes).length, 12, "trocar de filtro volta a mostrar todas");
});

test("regionais: categoria sem ativos, base sem cidades e servidor fora do ar mostram aviso em vez de barras", async () => {
  const { feature, nodes } = load({ painel: painelBase() });
  await feature.carregarResumoAtivos();
  assert.equal(pilula(nodes, "fone").disabled, true);

  const semDados = { ...painelBase(), cidades_principais: [], cidades_por_categoria: { notebook: [] } };
  const vazio = load({ painel: semDados });
  await vazio.feature.carregarResumoAtivos();
  assert.equal(vazio.nodes.regionais.querySelectorAll(".ck-barra").length, 0);
  assert.equal(vazio.nodes.contagem.textContent, "");
  pilula(vazio.nodes, "notebook").click();
  assert.equal(vazio.nodes.regionais.textContent, "Nenhum ativo de Notebooks na base local.");

  const fora = load({ painel: new Error("offline") });
  await fora.feature.carregarResumoAtivos();
  assert.match(fora.nodes.regionais.textContent, /indisponível/);
  assert.equal(fora.nodes.regionais.querySelectorAll(".ck-barra").length, 0);
  assert.equal(fora.nodes.filtros.querySelectorAll("button").length, 0);
  assert.equal(fora.nodes.mais.hidden, true);
});

test("index.html: cartão novo no painel comparacao, sem a tabela Total de ativos e sem IDs duplicados", () => {
  const painel = html.match(/<section[^>]*data-cockpit-tool-panel="comparacao"[\s\S]*?\n        <\/section>/)[0];
  assert.ok(painel.indexOf('id="comparacao-planilhas-conteudo"') < painel.indexOf('id="resumo-regionais"'));
  assert.match(painel, /<h3 id="resumo-regionais-titulo"[^>]*>Ativos por regional<\/h3>/);
  assert.match(painel, /id="resumo-regionais-filtros"[^>]*role="group"/);
  assert.match(painel, /id="resumo-regionais-mais"[^>]*hidden/);
  assert.doesNotMatch(painel, /resumo-total|Total de ativos/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicados = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(duplicados, []);
});

test("carregamento: esqueleto ao buscar as regionais e data-estado pronto/erro", async () => {
  const eventos = [];
  const motion = { startLoading: (alvo, rotulo) => { eventos.push(["inicio", alvo.getAttribute("id"), rotulo, alvo.dataset.estado]); return () => eventos.push(["fim"]); } };
  const ok = load({ painel: painelBase(), motion });
  await ok.feature.carregarResumoAtivos();
  await tick();
  assert.deepEqual(eventos[0], ["inicio", "resumo-regionais", "Carregando dados da base local…", "carregando"]);
  assert.ok(eventos.some(([tipo]) => tipo === "fim"));
  assert.equal(ok.nodes.regionais.dataset.estado, "pronto");
  assert.equal(ok.nodes.regionais.getAttribute("aria-busy"), "false");

  const falha = load({ painel: new Error("offline"), motion });
  await falha.feature.carregarResumoAtivos();
  assert.equal(falha.nodes.regionais.dataset.estado, "erro");
  assert.equal(falha.nodes.regionais.getAttribute("aria-busy"), "false");
});
