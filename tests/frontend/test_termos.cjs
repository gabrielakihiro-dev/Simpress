// Termos de entrega e devolução: funções puras e garantia de que nada é guardado (LGPD).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const caminhoFonte = path.join(__dirname, "../../static/js/features/termos.js");
const termos = require(caminhoFonte)({ app: {} });

test("termosFormatarData fatia aaaa-mm-dd sem passar por Date", () => {
  assert.equal(termos.termosFormatarData("2026-11-09"), "09/11/2026");
  assert.equal(termos.termosFormatarData("2026-01-01"), "01/01/2026");
  assert.equal(termos.termosFormatarData(""), "");
  assert.equal(termos.termosFormatarData(null), "");
  assert.equal(termos.termosFormatarData(undefined), "");
});

test("termosNomeArquivo junta série em maiúsculas e nome completo", () => {
  assert.equal(
    termos.termosNomeArquivo("brj54925dn", "Janaina do Rocio Santos Rocha"),
    "BRJ54925DN - Janaina do Rocio Santos Rocha",
  );
  assert.equal(termos.termosNomeArquivo("  brj54925dn  ", "  José   da  Conceição "), "BRJ54925DN - José da Conceição");
});

test("termosNomeArquivo usa só o lado preenchido, sem separador", () => {
  assert.equal(termos.termosNomeArquivo("brj54925dn", ""), "BRJ54925DN");
  assert.equal(termos.termosNomeArquivo("", "Maria Silva"), "Maria Silva");
  assert.equal(termos.termosNomeArquivo("   ", "Maria Silva"), "Maria Silva");
});

test("termosNomeArquivo devolve valor falso quando os dois lados ficam vazios", () => {
  assert.ok(!termos.termosNomeArquivo("", ""));
  assert.ok(!termos.termosNomeArquivo("  ", "\t"));
  assert.ok(!termos.termosNomeArquivo(null, undefined));
  assert.ok(!termos.termosNomeArquivo("/\\:*?\"<>|", "///"));
});

test("termosNomeArquivo remove caracteres proibidos em nome de arquivo", () => {
  const nome = termos.termosNomeArquivo('br/j\\5:4*9?2"5<d>n|', 'Ana/ \\ : * ? " < > | Souza');
  assert.equal(nome, "BRJ54925DN - Ana Souza");
  for (const proibido of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    assert.ok(!nome.includes(proibido), `não pode conter ${proibido}`);
  }
});

test("termosLimparParte limita cada parte a 100 caracteres", () => {
  assert.equal(termos.termosLimparParte("a".repeat(150)).length, 100);
  assert.equal(termos.termosLimparParte("x".repeat(150), true), "X".repeat(100));
  const nome = termos.termosNomeArquivo("s".repeat(150), "n".repeat(150));
  assert.equal(nome, `${"S".repeat(100)} - ${"n".repeat(100)}`);
});

test("termos.js não guarda nem envia dados (sem storage, cookie, rede nem innerHTML)", () => {
  const codigo = fs.readFileSync(caminhoFonte, "utf8");
  for (const proibido of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "fetch(", "innerHTML"]) {
    assert.ok(!codigo.includes(proibido), `termos.js não pode usar ${proibido}`);
  }
});

test("index.html traz as abas e os botões aprovados e nenhum Imprimir", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../static/index.html"), "utf8");
  for (const texto of ["Termo Entrega", "Termo Devolução", "Gerar PDF", "Limpar"]) {
    assert.ok(html.includes(`>${texto}</button>`), `falta o botão ${texto}`);
  }
  const botaoMenu = html.match(/<button[^>]*id="btn-termos"[^>]*>/);
  assert.ok(botaoMenu, "falta #btn-termos no menu Ferramentas");
  assert.ok(!/aria-keyshortcuts/.test(botaoMenu[0]), "Termos não tem atalho de teclado");
  assert.ok(!/>Imprimir</.test(html.slice(html.indexOf('data-cockpit-tool-panel="termos"'))), "não pode haver botão Imprimir");
});
