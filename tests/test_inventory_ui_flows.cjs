const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const transferUtils = require("../static/transfer-utils.js");

const appScript = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
    this.disabled = false;
    this.isConnected = true;
    this.files = [];
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.focused = false;
    this.scrollIntoViewOptions = null;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      },
    };
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener() {}
  replaceChildren(...children) { this.children = children; }
  appendChild(child) { this.children.push(child); return child; }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrollIntoViewOptions = options; }
  closest() { return null; }
  getClientRects() { return [1]; }
}

class FakeFormData {
  constructor() { this.fields = []; }
  append(...args) { this.fields.push(args); }
}

function createAppHarness(fetchApi) {
  const elements = new Map();
  const effects = {
    comparisons: [],
    toasts: [],
    refreshes: [],
    displays: [],
    confirmations: [],
    focusedSelectors: [],
  };
  const document = {
    body: new FakeElement("body"),
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    createElement: tag => new FakeElement(tag),
    querySelectorAll: () => [],
    querySelector(selector) {
      effects.focusedSelectors.push(selector);
      return new FakeElement(selector);
    },
  };
  const window = {
    SimpressTransferUtils: transferUtils,
    URL: { createObjectURL: () => "blob:ficticio", revokeObjectURL() {} },
    matchMedia: () => ({ matches: false }),
    confirm: message => { effects.confirmations.push(message); return true; },
  };
  const context = vm.createContext({
    document,
    window,
    fetch: (...args) => fetchApi(...args),
    FormData: FakeFormData,
    HTMLElement: FakeElement,
    setTimeout,
    clearTimeout,
    lucide: { createIcons() {} },
    console: { error() {}, warn() {}, log() {} },
    workflowEffects: effects,
  });

  vm.runInContext(appScript, context, { filename: "static/app.js" });
  vm.runInContext(`
    preencherRepresentanteRegional = () => {};
    exibirEquipamento = equipment => {
      workflowEffects.displays.push(equipment);
      document.getElementById("card-equipamento").classList.remove("hidden");
      document.getElementById("retirada-endereco").value = equipment.retirada_endereco || "";
    };
    showToast = (message, type) => workflowEffects.toasts.push({ message, type });
    abrirModalComparacaoPlanilhas = comparison => workflowEffects.comparisons.push(comparison);
    carregarEstatisticas = async () => workflowEffects.refreshes.push("estatisticas");
    carregarUnidades = async () => workflowEffects.refreshes.push("unidades");
    carregarContagemHistoricoComparacoes = async () => workflowEffects.refreshes.push("contagem-historico");
    carregarHistoricoComparacoes = async () => workflowEffects.refreshes.push("historico");
  `, context);

  return {
    context,
    effects,
    element: id => document.getElementById(id),
    run: source => vm.runInContext(source, context),
    selectEquipment(equipment) {
      context.workflowEquipment = equipment;
      vm.runInContext(`
        currentEquipamento = workflowEquipment;
        retiradaCidadeSelecionada = workflowEquipment.retirada_cidade || "";
      `, context);
      document.getElementById("input-serial").value = equipment.serial;
      document.getElementById("retirada-endereco").value = equipment.retirada_endereco || "";
      document.getElementById("card-equipamento").classList.remove("hidden");
    },
  };
}

function apiResponse(body, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { ok, status, json: async () => body };
}

function chooseUploadFiles(harness) {
  harness.element("upload-endpoint-file").files = [{ name: "endpoint-ficticio.xlsx" }];
  harness.element("upload-details-file").files = [{ name: "detalhes-ficticio.xlsx" }];
  harness.element("btn-confirmar-planilhas").innerHTML = "Confirmar";
  harness.element("modal-atualizar-planilhas").classList.remove("hidden");
}

function setButton(harness, button, label) {
  button.textContent = label;
  button.isConnected = true;
  harness.context.restoreButton = button;
}

const priorEquipment = {
  serial: "SERIE-ANTIGA",
  modelo: "Modelo anterior",
  retirada_cidade: "Maringá",
  retirada_endereco: "Rua antiga, 10",
};

test("successful inventory upload refreshes selection and presents comparison result", async () => {
  const refreshed = { ...priorEquipment, modelo: "Modelo atualizado", retirada_endereco: "Rua nova, 20" };
  const calls = [];
  const harness = createAppHarness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/planilhas/atualizar") {
      return apiResponse({ comparacao: { resumo: "comparação fictícia" } });
    }
    if (url === "/api/equipamento/SERIE-ANTIGA") return apiResponse(refreshed);
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.selectEquipment(priorEquipment);
  chooseUploadFiles(harness);

  await harness.run("enviarPlanilhas()");

  assert.deepEqual(calls.map(call => call.url), [
    "/api/planilhas/atualizar",
    "/api/equipamento/SERIE-ANTIGA",
  ]);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.body.fields.map(([name]) => name), ["endpoint_file", "details_file"]);
  assert.equal(harness.run("currentEquipamento.modelo"), "Modelo atualizado");
  assert.equal(harness.element("retirada-endereco").value, "Rua nova, 20");
  assert.equal(harness.element("card-equipamento").classList.contains("hidden"), false);
  assert.equal(harness.element("upload-endpoint-file").value, "");
  assert.equal(harness.element("upload-details-name").textContent, "Nenhum arquivo selecionado");
  assert.deepEqual(harness.effects.comparisons, [{ resumo: "comparação fictícia" }]);
  assert.deepEqual(harness.effects.refreshes, ["estatisticas", "unidades", "contagem-historico"]);
  assert.equal(harness.element("btn-confirmar-planilhas").disabled, false);
  assert.equal(harness.effects.toasts.length, 0);
});

test("failed inventory upload keeps the selected equipment and shows its error", async () => {
  const harness = createAppHarness(async url => {
    assert.equal(url, "/api/planilhas/atualizar");
    return apiResponse({ detail: "Arquivo fictício inválido" }, { status: 422, ok: false });
  });
  harness.selectEquipment(priorEquipment);
  chooseUploadFiles(harness);

  await harness.run("enviarPlanilhas()");

  assert.equal(harness.run("currentEquipamento.serial"), "SERIE-ANTIGA");
  assert.equal(harness.element("retirada-endereco").value, "Rua antiga, 10");
  assert.equal(harness.element("card-equipamento").classList.contains("hidden"), false);
  assert.equal(harness.element("upload-planilhas-status").textContent, "Arquivo fictício inválido");
  assert.equal(harness.element("upload-planilhas-status").scrollIntoViewOptions?.block, "nearest");
  assert.equal(harness.element("upload-planilhas-status").attributes.get("role"), "alert");
  assert.equal(harness.element("upload-planilhas-status").attributes.get("aria-live"), "assertive");
  assert.equal(harness.effects.comparisons.length, 0);
  assert.equal(harness.element("btn-confirmar-planilhas").disabled, false);
});

test("missing upload files reveal and announce the error immediately", async () => {
  const harness = createAppHarness(async () => {
    throw new Error("A API não deve ser chamada sem os arquivos.");
  });
  harness.element("modal-atualizar-planilhas").classList.remove("hidden");

  await harness.run("enviarPlanilhas()");

  const status = harness.element("upload-planilhas-status");
  assert.match(status.textContent, /Selecione Endpoint e EquipamentosDetalhes/);
  assert.equal(status.scrollIntoViewOptions?.block, "nearest");
  assert.equal(status.attributes.get("role"), "alert");
  assert.equal(status.attributes.get("aria-live"), "assertive");
});

test("successful upload clears a selection removed from the replacement inventory", async () => {
  const harness = createAppHarness(async url => {
    if (url === "/api/planilhas/atualizar") return apiResponse({ comparacao: { id: "atualizacao" } });
    if (url === "/api/equipamento/SERIE-ANTIGA") {
      return apiResponse({ detail: "Equipamento não encontrado" }, { status: 404, ok: false });
    }
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.selectEquipment(priorEquipment);
  chooseUploadFiles(harness);

  await harness.run("enviarPlanilhas()");

  assert.equal(harness.run("currentEquipamento"), null);
  assert.equal(harness.element("input-serial").value, "");
  assert.equal(harness.element("retirada-endereco").value, "");
  assert.equal(harness.element("card-equipamento").classList.contains("hidden"), true);
  assert.equal(harness.run('transferUtils.serialForTransfer(currentEquipamento, document.getElementById("input-serial").value)'), "");
  assert.equal(harness.effects.toasts.at(-1).type, "warning");
  assert.match(harness.effects.toasts.at(-1).message, /não está no inventário atualizado/);
});

test("late post-upload equipment response cannot replace a newer search", async () => {
  let resolveRefresh;
  let refreshSignal;
  const harness = createAppHarness(async (url, options = {}) => {
    if (url === "/api/planilhas/atualizar") return apiResponse({ comparacao: { id: "atrasada" } });
    if (url === "/api/equipamento/SERIE-ANTIGA") {
      refreshSignal = options.signal;
      return new Promise(resolve => { resolveRefresh = resolve; });
    }
    if (url === "/api/equipamento/SERIE-NOVA") {
      return apiResponse({ serial: "SERIE-NOVA", modelo: "Busca atual" });
    }
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.selectEquipment(priorEquipment);
  chooseUploadFiles(harness);

  const upload = harness.run("enviarPlanilhas()");
  for (let attempt = 0; attempt < 20 && !resolveRefresh; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof resolveRefresh, "function");
  assert.equal(harness.run("currentEquipamento"), null);
  assert.equal(harness.element("retirada-endereco").value, "");

  harness.element("input-serial").value = "SERIE-NOVA";
  await harness.run("buscarSerial()");
  assert.equal(refreshSignal.aborted, true);
  resolveRefresh(apiResponse({ ...priorEquipment, modelo: "Resposta atrasada" }));
  await upload;

  assert.equal(harness.run("currentEquipamento.serial"), "SERIE-NOVA");
  assert.equal(harness.run("currentEquipamento.modelo"), "Busca atual");
  assert.equal(harness.element("card-equipamento").classList.contains("hidden"), false);
  assert.equal(harness.effects.comparisons.length, 1);
  assert.equal(harness.effects.toasts.some(item => item.message.includes("Não foi possível confirmar")), false);
});

const restorePreview = {
  tipo_evento: "atualizacao",
  evento_horario: "2026-10-03T10:00:00-03:00",
  preview_token: "a".repeat(64),
  arquivos_backup: {
    endpoint: { nome: "endpoint-anterior.xlsx", registros: 10 },
    detalhes: { nome: "detalhes-anterior.xlsx", registros: 12 },
  },
  arquivos_atuais: {
    endpoint: { presente: true, nome: "endpoint-atual.xlsx" },
    detalhes: { presente: true, nome: "detalhes-atual.xlsx" },
  },
};

test("successful restoration clears old transfer data and refreshes inventory views", async () => {
  const calls = [];
  const harness = createAppHarness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/restauracao")) return apiResponse(restorePreview);
    if (url.endsWith("/restaurar")) {
      assert.equal(JSON.parse(options.body).preview_token, restorePreview.preview_token);
      return apiResponse({ evento: { total_equipamentos_carregados: 12, desfazer_disponivel: true } });
    }
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.selectEquipment(priorEquipment);
  harness.element("textarea-resumo-preview").value = "Resumo antigo";
  harness.element("textarea-texto-transporte").value = "Transporte antigo";
  const button = new FakeElement("restore-button");
  setButton(harness, button, "Restaurar versão anterior");

  await harness.run(`restaurarHistoricoComparacao({ id: "evento-ficticio", horario: "2026-10-03T10:00:00-03:00" }, restoreButton)`);

  assert.deepEqual(calls.map(call => call.options.method || "GET"), ["GET", "POST"]);
  assert.equal(harness.effects.confirmations.length, 1);
  assert.match(harness.effects.confirmations[0], /endpoint-anterior\.xlsx/);
  assert.equal(harness.run("currentEquipamento"), null);
  assert.equal(harness.element("input-serial").value, "");
  assert.equal(harness.element("retirada-endereco").value, "");
  assert.equal(harness.element("textarea-resumo-preview").value, "");
  assert.equal(harness.element("textarea-texto-transporte").value, "");
  assert.deepEqual(harness.effects.refreshes, ["estatisticas", "unidades", "historico", "contagem-historico"]);
  assert.equal(harness.effects.toasts.at(-1).type, "success");
  assert.match(harness.effects.toasts.at(-1).message, /12 equipamentos carregados/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Restaurar versão anterior");
});

test("failed restoration leaves the current selection intact and presents the error", async () => {
  const harness = createAppHarness(async (url, options = {}) => {
    if (url.endsWith("/restauracao")) return apiResponse(restorePreview);
    if (url.endsWith("/restaurar")) {
      return apiResponse({ detail: "Backup fictício indisponível" }, { status: 409, ok: false });
    }
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.selectEquipment(priorEquipment);
  const button = new FakeElement("restore-button");
  setButton(harness, button, "Restaurar versão anterior");

  await harness.run(`restaurarHistoricoComparacao({ id: "evento-ficticio", horario: "2026-10-03T10:00:00-03:00" }, restoreButton)`);

  assert.equal(harness.run("currentEquipamento.serial"), "SERIE-ANTIGA");
  assert.equal(harness.element("retirada-endereco").value, "Rua antiga, 10");
  assert.equal(harness.effects.refreshes.length, 0);
  assert.equal(harness.effects.toasts.at(-1).message, "Backup fictício indisponível");
  assert.equal(harness.effects.toasts.at(-1).type, "error");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Restaurar versão anterior");
});
