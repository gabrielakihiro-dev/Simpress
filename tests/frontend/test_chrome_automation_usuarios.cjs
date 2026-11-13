const assert = require("node:assert/strict");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");
const createChromeAutomation = require("../../static/js/features/chrome-automation.js");

const indexHtml = assembledHtml();

test("o botão de verificar usuários está presente na interface com atributos corretos", () => {
  assert.match(indexHtml, /id="btn-automacao-usuarios"/, "deve ter id btn-automacao-usuarios");
  assert.match(indexHtml, /data-automacao-rotina="usuarios"/, "deve ter data-automacao-rotina='usuarios'");
  assert.match(indexHtml, /data-on-click="iniciarRotinaAutomacao"/, "deve ter data-on-click='iniciarRotinaAutomacao'");
  assert.match(indexHtml, /data-args='\["usuarios"\]'/, "deve passar ['usuarios'] nos args");
  assert.match(indexHtml, /<use href="#i-users">/, "deve usar o ícone users");
  assert.match(indexHtml, /<h3 class="[^"]*" id="ck-verificacao-titulo">Verificar usuários<\/h3>/, "deve exibir o rótulo Verificar usuários");
  assert.match(indexHtml, /<option value="usuarios">Verificar usuários<\/option>/, "deve ter opção no filtro de histórico");
});

test("iniciarRotinaAutomacao('usuarios') envia a rotina usuarios para o endpoint de execução", async t => {
  t.after(() => {
    delete global.document;
    delete global.window;
  });

  const chamadas = [];
  const toasts = [];
  const elemento = {
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { toggle() {} },
    removeAttribute() {},
    hidden: false,
    textContent: "",
    replaceChildren() {},
    append() {},
    appendChild() {},
    disabled: false,
    dataset: {},
  };

  global.document = {
    getElementById: () => elemento,
    querySelector: () => elemento,
    querySelectorAll: () => [],
    visibilityState: "visible",
  };
  global.window = {
    clearTimeout() {},
    setTimeout: () => 0,
  };

  const app = {
    apiFetch: async (url, opcoes) => {
      chamadas.push({ url, opcoes });
      if (url === "/api/automacao/executar") {
        return { estado: "em_andamento", rotina: "usuarios", inicio: new Date().toISOString() };
      }
      return { estado: "em_andamento", rotina: "usuarios", inicio: new Date().toISOString(), log: { linhas: [], offset: 0 } };
    },
    showToast: (mensagem, tipo) => toasts.push([mensagem, tipo]),
  };
  const dom = { createTextElement: () => elemento };

  const feature = createChromeAutomation({ app, dom });
  await feature.iniciarRotinaAutomacao("usuarios");

  const execucao = chamadas.find(c => c.url === "/api/automacao/executar");
  assert.ok(execucao, "deve ter chamado /api/automacao/executar");
  assert.equal(execucao.opcoes.method, "POST");
  assert.deepEqual(JSON.parse(execucao.opcoes.body), { rotina: "usuarios" });
  assert.ok(toasts.some(([msg, tipo]) => msg.includes("Verificar usuários iniciada") && tipo === "success"));
});

test("atalho 'Ver backups no Resumo': aparece ao concluir inventários ou rotina completa e some ao iniciar outra rotina", async t => {
  t.after(() => {
    delete global.document;
    delete global.window;
  });
  const generico = () => ({
    setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], classList: { toggle() {} }, removeAttribute() {},
    hidden: false, textContent: "", replaceChildren() {}, append() {}, appendChild() {}, disabled: false, dataset: {},
  });
  const botao = { ...generico(), hidden: true };
  const outros = generico();
  global.document = {
    getElementById: id => (id === "automacao-ver-backups" ? botao : (id === "automacao-log" ? null : outros)),
    querySelector: () => outros, querySelectorAll: () => [], visibilityState: "visible",
  };
  global.window = { clearTimeout() {}, setTimeout: () => 0 };
  let proximo = {};
  const app = {
    apiFetch: async url => (url.startsWith("/api/automacao/estado") ? proximo : {}),
    showToast() {},
  };
  const feature = createChromeAutomation({ app, dom: { createTextElement: () => outros } });
  const passo = async dados => { proximo = { log: { linhas: [], offset: 0 }, ...dados }; await feature.atualizarEstadoAutomacao(); };
  const andamento = rotina => ({ estado: "em_andamento", rotina, inicio: "2026-11-12T09:00:00-03:00" });
  const fim = (rotina, status) => ({ estado: "livre", ultima: { id: `${rotina}-${status}`, rotina, status } });

  await passo(fim("os", "concluido"));
  assert.equal(botao.hidden, true, "sem execução observada, continua escondido");

  await passo(andamento("os"));
  await passo(fim("os", "concluido"));
  assert.equal(botao.hidden, true, "rotina de OS não mostra o atalho");

  await passo(andamento("inventarios"));
  assert.equal(botao.hidden, true, "em andamento não mostra");
  await passo(fim("inventarios", "falha"));
  assert.equal(botao.hidden, true, "inventários com falha não mostra");

  await passo(andamento("inventarios"));
  await passo(fim("inventarios", "concluido"));
  assert.equal(botao.hidden, false, "inventários concluídos mostram o atalho");

  await passo(andamento("os"));
  assert.equal(botao.hidden, true, "nova rotina esconde o atalho");

  await passo(andamento("ambas"));
  await passo(fim("ambas", "concluido"));
  assert.equal(botao.hidden, false, "rotina completa concluída mostra o atalho");
  await passo(andamento("usuarios"));
  assert.equal(botao.hidden, true);
});
