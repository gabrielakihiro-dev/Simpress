const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const createChromeAutomation = require("../../static/js/features/chrome-automation.js");

const root = path.resolve(__dirname, "..", "..");
const indexHtml = fs.readFileSync(path.join(root, "static", "index.html"), "utf8");

test("o botão de verificar usuários está presente na interface com atributos corretos", () => {
  assert.match(indexHtml, /id="btn-automacao-usuarios"/, "deve ter id btn-automacao-usuarios");
  assert.match(indexHtml, /data-automacao-rotina="usuarios"/, "deve ter data-automacao-rotina='usuarios'");
  assert.match(indexHtml, /data-on-click="iniciarRotinaAutomacao"/, "deve ter data-on-click='iniciarRotinaAutomacao'");
  assert.match(indexHtml, /data-args='\["usuarios"\]'/, "deve passar ['usuarios'] nos args");
  assert.match(indexHtml, /<i data-lucide="users"/, "deve usar o ícone users");
  assert.match(indexHtml, /<span>Verificar usuários<\/span>/, "deve exibir o rótulo Verificar usuários");
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
