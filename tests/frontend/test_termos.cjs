// Termos de entrega e devolução: funções puras e garantia de que nada é guardado (LGPD).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
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
  const html = assembledHtml();
  for (const texto of ["Termo Entrega", "Termo Devolução", "Gerar PDF", "Limpar"]) {
    assert.ok(html.includes(`>${texto}</button>`), `falta o botão ${texto}`);
  }
  const botaoMenu = html.match(/<button[^>]*id="btn-lembretes"[^>]*>/);
  assert.ok(botaoMenu, "falta #btn-lembretes no menu Ferramentas");
  assert.ok(!/aria-keyshortcuts/.test(botaoMenu[0]), "Lembretes não tem atalho de teclado");
  assert.ok(!html.includes('ck-menu__rotulo">Termos<'), "a ferramenta Termos saiu do menu");
  assert.ok(!/>Imprimir</.test(html.slice(html.indexOf('data-cockpit-tool-panel="lembretes"'))), "não pode haver botão Imprimir");
});

test("termosPreencherDoEquipamento preenche só nome, modelo, série e Notebook, sem apagar o que foi digitado", () => {
  const criarForm = (nomes) => {
    const campos = Object.fromEntries(nomes.map((n) => [n, { value: "", dataset: {} }]));
    const notebook = { checked: false };
    return {
      campos, notebook, dataset: {},
      querySelector: (sel) => (sel === 'input[name="item-02"][value="sim"]' ? notebook : campos[/name="([^"]+)"/.exec(sel)?.[1]] || null),
    };
  };
  const forms = {
    "termos-form-entrega": criarForm(["nome", "unidade", "modelo_anterior", "modelo_entregue", "serie_entregue"]),
    "termos-form-devolucao": criarForm(["nome", "unidade", "modelo", "serie"]),
  };
  const anterior = globalThis.document;
  globalThis.document = { getElementById: (id) => forms[id] || null };
  try {
    const e = forms["termos-form-entrega"], d = forms["termos-form-devolucao"];
    e.campos.unidade.value = "UTIC";
    termos.termosPreencherDoEquipamento({ serial: "BRJ1", modelo: "HP 640 G11", nome_pessoa: "Maria Teste" });
    assert.equal(e.campos.nome.value, "Maria Teste");
    assert.equal(e.campos.modelo_entregue.value, "HP 640 G11");
    assert.equal(e.campos.serie_entregue.value, "BRJ1");
    assert.equal(e.campos.modelo_anterior.value, "");
    assert.equal(e.campos.unidade.value, "UTIC");
    assert.equal(e.notebook.checked, true);
    assert.equal(d.campos.nome.value, "Maria Teste");
    assert.equal(d.campos.modelo.value, "HP 640 G11");
    assert.equal(d.campos.serie.value, "BRJ1");
    assert.equal(d.notebook.checked, true);

    // Série sem nome: apaga o nome que a Home tinha posto...
    termos.termosPreencherDoEquipamento({ serial: "BRJ2", modelo: "X" });
    assert.equal(e.campos.nome.value, "");
    // ...mas não o que o usuário digitou.
    e.campos.nome.value = "Digitado";
    termos.termosPreencherDoEquipamento({ serial: "BRJ3", modelo: "Y" });
    assert.equal(e.campos.nome.value, "Digitado");
    // A mesma série exibida de novo (salvar edição cadastral) não desfaz o que o usuário mudou.
    e.notebook.checked = false;
    e.campos.modelo_entregue.value = "Editado";
    termos.termosPreencherDoEquipamento({ serial: "BRJ3", modelo: "Y" });
    assert.equal(e.notebook.checked, false);
    assert.equal(e.campos.modelo_entregue.value, "Editado");
    e.campos.modelo_entregue.value = "Y";
    // Sem série, não mexe em nada.
    termos.termosPreencherDoEquipamento({ modelo: "Z" });
    assert.equal(e.campos.modelo_entregue.value, "Y");
  } finally {
    globalThis.document = anterior;
  }
});
