// Ordenação e "Copiar tabela" entram por evento explícito (simpress:tabelas-renderizadas), sem observer no body.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const panels = require("../../static/js/ui/data-panels.js");
const { createFakeDocument } = require("./support/fake-dom.cjs");

const doc = createFakeDocument();
// O DOM falso não traz insertBefore nem lastChild; enhanceTable usa os dois.
const NodeProto = Object.getPrototypeOf(doc.body);
NodeProto.insertBefore = function insertBefore(node, ref) {
  if (node.parentNode) node.remove();
  node.parentNode = this;
  this.children.splice(this.children.indexOf(ref), 0, node);
  return node;
};
Object.defineProperty(NodeProto, "lastChild", { get() { return this.children[this.children.length - 1] || null; } });
// Nem previousElementSibling nem classList: enhanceTable usa os dois para pôr os botões na linha do título.
Object.defineProperty(NodeProto, "previousElementSibling", { get() { const irmaos = this.parentNode?.children || []; return irmaos[irmaos.indexOf(this) - 1] || null; } });
Object.defineProperty(NodeProto, "classList", { get() {
  const node = this;
  const contains = nome => node.className.split(/\s+/).includes(nome);
  return { contains, add: nome => { if (!contains(nome)) node.className = `${node.className} ${nome}`.trim(); } };
} });

const listeners = new Map();
doc.addEventListener = (type, listener) => listeners.set(type, [...(listeners.get(type) || []), listener]);
doc.dispatchEvent = event => { (listeners.get(event.type) || []).forEach(listener => listener(event)); return true; };

const observados = [];
const win = {
  document: doc,
  MutationObserver: class { observe(target) { observados.push(target); } },
  CustomEvent: class { constructor(type) { this.type = type; } },
  getComputedStyle: () => ({ display: "" }),
  console: { warn() {} },
  fetch: async () => ({ ok: false, json: async () => ({}) }),
};
panels.install(win);

function el(tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const filhos = (node, tag) => node.children.filter(child => child.tagName === tag);

// Tabela no formato dos renderizadores (wrap .comparison-desktop-table > table > thead/tbody).
function montarTabela() {
  const wrap = el("div", "comparison-desktop-table");
  const table = el("table");
  const head = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", "", "Série"), el("th", "", "Data"));
  head.appendChild(headRow);
  const body = el("tbody");
  [["B", "02/01/2026"], ["A", "01/01/2026"]].forEach(valores => {
    const row = el("tr");
    valores.forEach(valor => row.appendChild(el("td", "", valor)));
    body.appendChild(row);
  });
  table.append(head, body);
  Object.defineProperty(table, "tHead", { get: () => filhos(table, "THEAD")[0] || null });
  Object.defineProperty(table, "tBodies", { get: () => filhos(table, "TBODY") });
  [head, body].forEach(section => Object.defineProperty(section, "rows", { get: () => filhos(section, "TR") }));
  [headRow, ...body.children].forEach(row => Object.defineProperty(row, "cells", { get: () => row.children.filter(c => c.tagName === "TD" || c.tagName === "TH") }));
  wrap.appendChild(table);
  return { wrap, table };
}

test("nenhum MutationObserver vigia o body", () => {
  assert.ok(!observados.includes(doc.body));
  assert.ok(!observados.includes(doc));
});

test("tabela nova só recebe ordenação e ferramentas depois do evento", () => {
  const host = el("section");
  doc.body.appendChild(host);
  const { wrap, table } = montarTabela();
  host.appendChild(wrap);
  assert.equal(table.dataset.uxTable, undefined);

  doc.dispatchEvent(new win.CustomEvent("simpress:tabelas-renderizadas"));
  assert.equal(table.dataset.uxTable, "ready");
  assert.equal(table.querySelectorAll("button.ux-sort-button").length, 2);
  const tools = host.children[host.children.indexOf(wrap) - 1];
  assert.ok(tools.className.includes("ux-table-tools"));
  assert.deepEqual(tools.children.map(button => button.textContent), ["Copiar tabela", "Modo compacto"]);

  // Evento repetido não duplica a barra nem reprocessa a tabela.
  doc.dispatchEvent(new win.CustomEvent("simpress:tabelas-renderizadas"));
  assert.equal(host.children.filter(child => child.className.includes("ux-table-tools")).length, 1);
});

test("no Resumo os botões vão para a linha do título, sem linha própria antes da tabela", () => {
  // Seção com cabeçalho (h4 + descrição) e grupo de filtro com a tabela.
  const secao = el("section");
  const cabecalho = el("div");
  cabecalho.append(el("h4", "", "Localidade divergente"), el("p", "", "Descrição"));
  const grupo = el("div", "history-filter-group space-y-2");
  const { wrap } = montarTabela();
  grupo.appendChild(wrap);
  secao.append(cabecalho, grupo);
  // Subtítulo h5 logo antes da tabela (Sem correspondência — Endpoint).
  const grupoH5 = el("div", "history-filter-group space-y-2");
  const subtitulo = el("h5", "", "Sem correspondência — Endpoint (1)");
  const tabelaH5 = montarTabela();
  grupoH5.append(subtitulo, tabelaH5.wrap);
  doc.body.append(secao, grupoH5);

  doc.dispatchEvent(new win.CustomEvent("simpress:tabelas-renderizadas"));
  assert.equal(grupo.children[0], wrap);
  assert.ok(cabecalho.className.includes("ux-table-tools-host"));
  assert.equal(cabecalho.children.filter(child => child.className.includes("ux-table-tools")).length, 1);

  const linha = grupoH5.children[0];
  assert.ok(linha.className.includes("ux-table-tools-host"));
  assert.deepEqual(linha.children.map(child => child.tagName), ["H5", "DIV"]);
  assert.equal(subtitulo.children.filter(child => child.className.includes("ux-table-tools")).length, 0, "o h5 não recebe os botões");
  assert.equal(grupoH5.children[1], tabelaH5.wrap);

  // Tabela nova no mesmo cabeçalho troca a barra, sem duplicar.
  const nova = montarTabela();
  wrap.remove();
  grupo.appendChild(nova.wrap);
  doc.dispatchEvent(new win.CustomEvent("simpress:tabelas-renderizadas"));
  assert.equal(cabecalho.children.filter(child => child.className.includes("ux-table-tools")).length, 1);
});

test("os renderizadores de .comparison-desktop-table disparam o evento", () => {
  const ler = arquivo => fs.readFileSync(path.join(__dirname, "..", "..", "static", "js", arquivo), "utf8");
  const dataPanels = ler("ui/data-panels.js");
  assert.doesNotMatch(dataPanels, /observe\(doc\.body/);
  assert.match(dataPanels, /addEventListener\("simpress:tabelas-renderizadas", scanTables\)/);
  const comparacao = ler("features/comparison-result.js");
  assert.equal(comparacao.match(/dispatchEvent\(new CustomEvent\("simpress:tabelas-renderizadas"\)\)/g)?.length, 2);
  assert.match(ler("ui/transfer-history.js"), /dispatchEvent\(new win\.CustomEvent\("simpress:tabelas-renderizadas"\)\)/);
});
