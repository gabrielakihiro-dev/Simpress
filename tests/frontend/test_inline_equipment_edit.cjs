const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const createEquipmentEditor = require("../../static/js/features/equipment-editor.js");

const root = path.resolve(__dirname, "../..");

// DOM mínimo para a edição cadastral em linha: grade com dd[data-campo], inputs criados sob demanda.
function elementoFalso() {
  const classes = new Set();
  return {
    value: "", textContent: "", disabled: false, hidden: false, attrs: {}, dataset: {}, children: [],
    classList: {
      toggle(nome, force) { (force === undefined ? !classes.has(nome) : force) ? classes.add(nome) : classes.delete(nome); },
      add(nome) { classes.add(nome); },
      remove(nome) { classes.delete(nome); },
      contains(nome) { return classes.has(nome); },
    },
    focus() { this.focused = true; },
    setAttribute(nome, valor) { this.attrs[nome] = valor; },
    removeAttribute(nome) { delete this.attrs[nome]; },
    hasAttribute(nome) { return nome in this.attrs; },
    addEventListener() {},
    appendChild(filho) { this.children.push(filho); filho.pai = this; },
    remove() { if (this.pai) this.pai.children = this.pai.children.filter(f => f !== this); },
  };
}

function instalarDocumento() {
  const elementos = new Map();
  const campos = {};
  for (const nome of ["apelido", "usuario", "login"]) {
    const dd = elementoFalso();
    const dado = elementoFalso();
    dado.querySelector = () => ({ textContent: nome });
    dd.closest = () => dado;
    campos[nome] = dd;
  }
  const grade = elementoFalso();
  grade.querySelector = seletor => campos[/data-campo="(\w+)"/.exec(seletor)?.[1]] || null;
  elementos.set("ck-dados-equipamento", grade);
  globalThis.document = {
    getElementById: id => {
      if (!elementos.has(id)) elementos.set(id, elementoFalso());
      return elementos.get(id);
    },
    createElement: () => elementoFalso(),
    dispatchEvent: () => true,
  };
  return { campos };
}

function criarEditor(equipamento, { apiFetch } = {}) {
  const { campos } = instalarDocumento();
  const chamadas = [];
  const toasts = [];
  const appState = { currentEquipamento: equipamento, equipamentoSelectionRevision: 1 };
  const app = {
    apiFetch: apiFetch || (async (rota, opcoes) => {
      chamadas.push([rota, JSON.parse(opcoes.body)]);
      return { equipamento: { ...equipamento } };
    }),
    showToast: (mensagem, tipo) => toasts.push([mensagem, tipo]),
    definirEquipamentoAtual: eq => { appState.currentEquipamento = eq; appState.equipamentoSelectionRevision += 1; },
    atualizarIndicadoresPosSalvamento() {},
  };
  const editor = createEquipmentEditor({ app, appState });
  const entrada = nome => campos[nome].children.find(filho => filho.dataset?.campoEdicao === nome);
  return { editor, chamadas, toasts, entrada };
}

const BASE = { serial: "AAA111", apelido: "NB-01", usuarios_logados: "", usuarios_logados_origem: "", nome_pessoa: "", nome_pessoa_editavel: false };

test("a edição em linha envia só os campos alterados", async () => {
  const { editor, chamadas, entrada } = criarEditor(BASE);
  try {
    editor.editarDadosCadastrais();
    entrada("apelido").value = "  NB-02 ";
    await editor.salvarDadosCadastrais();
    assert.deepEqual(chamadas, [["/api/equipamento/atualizar-apelido", { serial: "AAA111", apelido: "NB-02" }]]);
  } finally {
    delete globalThis.document;
  }
});

test("a edição em linha envia apelido e usuário juntos, cada um na sua rota, e nada quando não há alteração", async () => {
  const { editor, chamadas, toasts, entrada } = criarEditor(BASE);
  try {
    editor.editarDadosCadastrais();
    await editor.salvarDadosCadastrais();
    assert.deepEqual(chamadas, []);
    assert.deepEqual(toasts.at(-1), ["Nenhuma alteração para salvar.", "info"]);
    entrada("apelido").value = "NB-03";
    entrada("usuario").value = "ana.lima";
    await editor.salvarDadosCadastrais();
    assert.deepEqual(chamadas.map(([rota]) => rota), ["/api/equipamento/atualizar-apelido", "/api/equipamento/atualizar-usuario"]);
    assert.deepEqual(chamadas[1][1], { serial: "AAA111", usuario: "ana.lima" });
  } finally {
    delete globalThis.document;
  }
});

test("o usuário vindo do Endpoint não é editável; vazio ou manual é", () => {
  try {
    for (const [eq, editavel] of [
      [{ ...BASE, usuarios_logados: "ana", usuarios_logados_origem: "endpoint" }, false],
      [{ ...BASE, usuarios_logados: "ana", usuarios_logados_origem: "manual" }, true],
      [{ ...BASE, usuarios_logados: "", usuarios_logados_origem: "" }, true],
    ]) {
      const { editor, entrada } = criarEditor(eq);
      editor.editarDadosCadastrais();
      assert.equal(Boolean(entrada("usuario")), editavel, JSON.stringify(eq));
      assert.ok(entrada("apelido"), "apelido sempre editável");
    }
  } finally {
    delete globalThis.document;
  }
});

test("o nome da pessoa só é editável com nome_pessoa_editavel", () => {
  try {
    const bloqueado = criarEditor({ ...BASE, usuarios_logados: "ana", nome_pessoa: "Ana", nome_pessoa_editavel: false });
    bloqueado.editor.editarDadosCadastrais();
    assert.equal(bloqueado.entrada("login"), undefined);
    const liberado = criarEditor({ ...BASE, usuarios_logados: "ana", nome_pessoa: "Ana", nome_pessoa_editavel: true });
    liberado.editor.editarDadosCadastrais();
    assert.equal(liberado.entrada("login").value, "Ana");
  } finally {
    delete globalThis.document;
  }
});

test("Local, CEP e CNPJ continuam somente leitura na edição em linha", () => {
  const source = fs.readFileSync(path.join(root, "static/js/features/equipment-editor.js"), "utf8");
  const bloco = source.match(/const CAMPOS_CADASTRAIS = \{([\s\S]*?)\n  \};/)?.[1] || "";
  assert.deepEqual([...bloco.matchAll(/^\s{4}(\w+):/gm)].map(m => m[1]), ["apelido", "usuario", "login"]);
});

test("os loaders das telas do Cockpit não montam HTML com dados de planilha", () => {
  const source = fs.readFileSync(path.join(root, "static/js/features/cockpit-tool-panels.js"), "utf8");
  assert.doesNotMatch(source, /\.innerHTML\s*[+]?=|insertAdjacentHTML|outerHTML|document\.write/);
});
