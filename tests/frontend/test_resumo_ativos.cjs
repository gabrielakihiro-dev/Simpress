// Resumo (painel "comparacao"): "Ativos por regional" e "Total de ativos" (50 em 50) com DOM falso e fetch simulado.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "static/index.html"), "utf8");
const appSource = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "static/app-entry.js"), "utf8");

function mount() {
  const doc = createFakeDocument();
  const make = (tag, id, extra = {}) => {
    const node = doc.createElement(tag);
    node.style = {};
    node.setAttribute("id", id);
    Object.assign(node, extra);
    doc.body.appendChild(node);
    return node;
  };
  const original = doc.createElement.bind(doc);
  doc.createElement = tag => Object.assign(original(tag), { style: {} });
  const nodes = {
    regionais: make("div", "resumo-regionais"),
    corpo: make("tbody", "resumo-total-ativos"),
    contagem: make("span", "resumo-total-contagem"),
    status: make("p", "resumo-total-status"),
    paginacao: make("nav", "resumo-total-paginacao", { hidden: true }),
    anterior: make("button", "resumo-total-anterior"),
    proxima: make("button", "resumo-total-proxima"),
    pagina: make("span", "resumo-total-pagina"),
    serial: make("input", "input-serial"),
  };
  return { doc, nodes };
}

function load({ painel, paginas }) {
  const { doc, nodes } = mount();
  const requests = [];
  const calls = [];
  globalThis.document = doc;
  globalThis.fetch = async url => {
    requests.push(url);
    if (url === "/api/painel") {
      if (painel instanceof Error) throw painel;
      return { ok: true, json: async () => painel };
    }
    const offset = Number(new URL(url, "http://local").searchParams.get("offset"));
    const page = paginas[offset];
    if (page instanceof Error) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => page };
  };
  const app = {
    ativarAbaTransferencia: aba => calls.push(["aba", aba]),
    buscarSerial: async () => { calls.push(["buscar", nodes.serial.value]); },
  };
  const feature = require("../../static/js/features/resumo-ativos.js")({ app });
  return { feature, nodes, requests, calls };
}

const linhas = (n, inicio = 1) => Array.from({ length: n }, (_, i) => ({
  serie: `SN${String(inicio + i).padStart(3, "0")}`, modelo: "M404", retirada_cidade: "Curitiba",
}));

test("registro: módulo importado no app-entry e publicado no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\/js\/features\/resumo-ativos\.js";/);
  assert.match(appSource, /"resumoAtivos",/);
});

test("Ativos por regional: barras ordenadas pelo total, com largura proporcional (mesma lógica do Resumo antigo)", async () => {
  const { feature, nodes, requests } = load({
    painel: { cidades_principais: [{ cidade: "Londrina", total: 5 }, { cidade: "Curitiba", total: 10 }, { cidade: "", total: 1 }] },
    paginas: { 0: { items: [], offset: 0, total: 0, has_more: false } },
  });
  await feature.carregarResumoAtivos();
  assert.ok(requests.includes("/api/painel"));
  const barras = nodes.regionais.querySelectorAll(".ck-barra");
  assert.deepEqual(barras.map(b => b.querySelector(".ck-barra__nome").textContent), ["Curitiba", "Londrina", "Sem cidade"]);
  assert.deepEqual(barras.map(b => b.querySelector(".ck-barra__valor").textContent), ["10", "5", "1"]);
  assert.deepEqual(barras.map(b => b.querySelector(".ck-barra__cheio").style.width), ["100%", "50%", "10%"]);
  assert.equal(nodes.regionais.getAttribute("aria-busy"), "false");
});

test("Ativos por regional: sem cidades ou com o servidor fora do ar mostra aviso em vez de barras", async () => {
  const vazio = load({ painel: { cidades_principais: [] }, paginas: { 0: { items: [], total: 0 } } });
  await vazio.feature.carregarResumoAtivos();
  assert.equal(vazio.nodes.regionais.textContent, "A distribuição por cidade não está disponível.");
  const fora = load({ painel: new Error("offline"), paginas: { 0: { items: [], total: 0 } } });
  await fora.feature.carregarResumoAtivos();
  assert.match(fora.nodes.regionais.textContent, /indisponível/);
  assert.equal(fora.nodes.regionais.querySelectorAll(".ck-barra").length, 0);
});

test("Total de ativos: carrega a primeira página ao abrir (50 por vez) e pagina com Anterior/Próxima", async () => {
  const { feature, nodes, requests } = load({
    painel: { cidades_principais: [] },
    paginas: {
      0: { items: linhas(50), offset: 0, total: 120, has_more: true },
      50: { items: linhas(50, 51), offset: 50, total: 120, has_more: true },
    },
  });
  await feature.carregarResumoAtivos();
  assert.ok(requests.includes("/api/buscar-expandida?listar_todos=true&offset=0&limit=50"));
  assert.equal(nodes.corpo.querySelectorAll("tr").length, 50);
  assert.equal(nodes.contagem.textContent, "Mostrando 1–50 de 120");
  assert.equal(nodes.pagina.textContent, "Página 1 de 3");
  assert.equal(nodes.paginacao.hidden, false);
  assert.equal(nodes.anterior.disabled, true);
  assert.equal(nodes.proxima.disabled, false);

  nodes.proxima.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests.includes("/api/buscar-expandida?listar_todos=true&offset=50&limit=50"));
  assert.equal(nodes.contagem.textContent, "Mostrando 51–100 de 120");
  assert.equal(nodes.pagina.textContent, "Página 2 de 3");
  assert.equal(nodes.anterior.disabled, false);
  assert.equal(nodes.corpo.querySelector("tr").dataset.serial, "SN051");

  nodes.anterior.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(url => url.includes("offset=0&")).length, 2);
  assert.equal(nodes.pagina.textContent, "Página 1 de 3");
});

test("Total de ativos: até 50 itens esconde a paginação e Abrir leva a série à Home", async () => {
  const { feature, nodes, calls } = load({
    painel: { cidades_principais: [] },
    paginas: { 0: { items: [...linhas(2), { serie: "", modelo: "X" }, { serie: "A/B" }], offset: 0, total: 4, has_more: false } },
  });
  await feature.carregarResumoAtivos();
  assert.equal(nodes.paginacao.hidden, true);
  const linhasTabela = nodes.corpo.querySelectorAll("tr");
  assert.equal(linhasTabela.length, 4);
  const abrir = tr => tr.querySelector("button");
  assert.equal(abrir(linhasTabela[0]).textContent, "Abrir");
  assert.equal(abrir(linhasTabela[0]).disabled, false);
  assert.equal(abrir(linhasTabela[2]).disabled, true, "sem série não abre");
  assert.equal(abrir(linhasTabela[3]).disabled, true, "série ambígua não abre");
  abrir(linhasTabela[1]).click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [["aba", "home"], ["buscar", "SN002"]]);
  assert.equal(nodes.serial.value, "SN002");
});

test("Total de ativos: erro da API vira mensagem e não deixa a tabela com dados velhos", async () => {
  const { feature, nodes } = load({ painel: { cidades_principais: [] }, paginas: { 0: new Error("500") } });
  await feature.carregarResumoAtivos();
  assert.equal(nodes.status.textContent, "Não foi possível carregar os equipamentos da base local.");
  assert.equal(nodes.corpo.querySelectorAll("tr").length, 0);
});

test("index.html: seções novas dentro do painel comparacao, rótulos aprovados e sem IDs duplicados", () => {
  const painel = html.match(/<section[^>]*data-cockpit-tool-panel="comparacao"[\s\S]*?\n        <\/section>/)[0];
  assert.ok(painel.indexOf('id="comparacao-planilhas-conteudo"') < painel.indexOf('id="resumo-regionais"'));
  assert.ok(painel.indexOf('id="resumo-regionais"') < painel.indexOf('id="resumo-total-ativos"'));
  assert.match(painel, /<h3 id="resumo-regionais-titulo"[^>]*>Ativos por regional<\/h3>/);
  assert.match(painel, /<h3 id="resumo-total-titulo"[^>]*>Total de ativos<\/h3>/);
  assert.match(painel, /id="resumo-total-anterior"[^>]*>Anterior<\/button>/);
  assert.match(painel, /id="resumo-total-proxima"[^>]*>Próxima<\/button>/);
  assert.match(painel, /id="resumo-total-paginacao"[^>]*hidden/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicados = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(duplicados, []);
});
