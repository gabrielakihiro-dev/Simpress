const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const transferUtils = require("../static/transfer-utils.js");
const catalogSearch = require("../static/catalog-search-utils.js");
const formDraftGuard = require("../static/form-draft-guard.js");
const annotationAutosave = require("../static/history-annotation-autosave.js");
const accessibleDialogs = require("../static/accessible-dialogs.js");
const notifications = require("../static/ui-notifications.js");

const appScript = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const appCss = fs.readFileSync(path.join(__dirname, "..", "static", "app.css"), "utf8");

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
    this.disabled = false;
    this.checked = false;
    this.isConnected = true;
    this.files = [];
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.focused = false;
    this.clicked = false;
    this.isValid = true;
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
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(type) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this });
  }
  click() { this.clicked = true; }
  remove() { this.isConnected = false; }
  replaceChildren(...children) { this.children = children; }
  appendChild(child) { this.children.push(child); return child; }
  querySelector() { return null; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  checkValidity() { return this.isValid; }
  closest() { return null; }
  getClientRects() { return [1]; }
}

class FakeTemplate extends FakeElement {
  set innerHTML(value) { this.markup = String(value); }
  get innerHTML() { return this.markup || ""; }
  get content() {
    const markup = this.innerHTML;
    return {
      querySelector: selector => {
        if (selector !== "tr") return null;
        const cells = [...markup.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => {
          const html = match[1];
          return {
            innerHTML: html,
            textContent: html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim(),
            querySelector: () => null,
            hasAttribute: () => false,
          };
        });
        return { cells, dataset: {}, hasAttribute: () => false };
      },
    };
  }
}

class FakeFormData {
  constructor() { this.fields = []; }
  append(...args) { this.fields.push(args); }
}

function createAppHarness(fetchApi, { stubDisplay = true, confirmResult = true, localStorage = new Map() } = {}) {
  const elements = new Map();
  const effects = {
    comparisons: [],
    clipboardWrites: [],
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
    createElement: tag => tag === "template" ? new FakeTemplate(tag) : new FakeElement(tag),
    querySelectorAll: () => [],
    querySelector(selector) {
      effects.focusedSelectors.push(selector);
      return new FakeElement(selector);
    },
  };
  const window = {
    SimpressTransferUtils: transferUtils,
    SimpressCatalogSearch: catalogSearch,
    SimpressFormDraftGuard: formDraftGuard,
    HistoryAnnotationAutosave: annotationAutosave,
    SimpressAccessibleDialogs: accessibleDialogs,
    SimpressNotifications: notifications,
    URL: { createObjectURL: () => "blob:ficticio", revokeObjectURL() {} },
    localStorage: {
      getItem: key => localStorage.get(key) ?? null,
      setItem: (key, value) => localStorage.set(key, String(value)),
    },
    matchMedia: () => ({ matches: false }),
    confirm: message => { effects.confirmations.push(message); return confirmResult; },
    setTimeout,
    clearTimeout,
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    window,
    navigator: { clipboard: { writeText: async text => effects.clipboardWrites.push(text) } },
    fetch: (...args) => fetchApi(...args),
    navigator: { clipboard: { writeText: async text => effects.clipboardWrites.push(text) } },
    FormData: FakeFormData,
    HTMLElement: FakeElement,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: callback => callback(0),
    lucide: { createIcons() {} },
    console: { error() {}, warn() {}, log() {} },
    workflowEffects: effects,
  });

  vm.runInContext(appScript, context, { filename: "static/app.js" });
  context.renderComparisonForTest = context.abrirModalComparacaoPlanilhas;
  vm.runInContext(`
    preencherRepresentanteRegional = () => {};
    showToast = (message, type) => workflowEffects.toasts.push({ message, type });
    abrirModalComparacaoPlanilhas = comparison => workflowEffects.comparisons.push(comparison);
    carregarEstatisticas = async () => workflowEffects.refreshes.push("estatisticas");
    carregarUnidades = async () => workflowEffects.refreshes.push("unidades");
    carregarContagemHistoricoComparacoes = async () => workflowEffects.refreshes.push("contagem-historico");
    carregarHistoricoComparacoes = async () => workflowEffects.refreshes.push("historico");
  `, context);
  if (stubDisplay) {
    vm.runInContext(`
      exibirEquipamento = equipment => {
        workflowEffects.displays.push(equipment);
        document.getElementById("card-equipamento").classList.remove("hidden");
        document.getElementById("retirada-endereco").value = equipment.retirada_endereco || "";
      };
    `, context);
  }

  return {
    context,
    effects,
    localStorage,
    element: id => document.getElementById(id),
    run: source => vm.runInContext(source, context),
    selectEquipment(equipment) {
      context.workflowEquipment = equipment;
      vm.runInContext(`
        definirEquipamentoAtual(workflowEquipment);
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

test("stale-access report sorts by inactivity, shows its reference time, and signals horizontal scrolling", () => {
  const harness = createAppHarness(async () => apiResponse({}), { stubDisplay: false });
  const referenceTime = "2026-09-30T15:00:00-03:00";
  harness.context.workflowComparison = {
    horario_comparacao: referenceTime,
    sem_acesso_14_dias: [
      { computador: "PRNOTE-14", dias_sem_verificacao: 14 },
      { computador: "PRNOTE-40", dias_sem_verificacao: 40 },
    ],
  };

  harness.run("renderComparisonForTest(workflowComparison)");

  const html = harness.element("comparacao-planilhas-conteudo").innerHTML;
  assert.ok(html.indexOf("PRNOTE-40") < html.indexOf("PRNOTE-14"));
  const formattedReferenceTime = harness.run(`formatarHorarioHistorico(${JSON.stringify(referenceTime)})`);
  assert.ok(html.includes(`Atualização usada como referência: <time datetime="${referenceTime}">${formattedReferenceTime}</time>.`));
  assert.ok(html.includes("Role a tabela horizontalmente para consultar todas as colunas."));
  assert.match(appCss, /\.accessible-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(appCss, /\.accessible-table-wrap:focus-visible\s*\{/);
  assert.match(appCss, /\.accessible-table-wrap::-webkit-scrollbar\s*\{/);
});

test("equipment search fills pickup CNPJ and selected delivery unit fills its installation CNPJ", async () => {
  const equipment = {
    serial: "SERIE-CNPJ-FICTICIA",
    modelo: "Modelo A",
    tipo: "Notebook",
    retirada_cidade: "Maringá",
    retirada_cnpj: "12.345.678/0001-90",
    retirada_endereco: "Rua Fictícia, 10 - Maringá/PR - CEP 87000-000",
    retirada_cep: "87000-000",
    descricao_sugerida: "Notebook + kit na mochila",
  };
  const deliveryCnpj = "98.765.432/0001-10";
  const calls = [];
  const harness = createAppHarness(async url => {
    calls.push(url);
    return apiResponse({ ...equipment, retirada_cnpj: "" });
  }, { stubDisplay: false });
  harness.context.workflowUnits = [
    { id: 17, cidade: "Foz do Iguaçu", cnpj: deliveryCnpj, endereco_completo: "R das Guianas, 151" },
  ];
  harness.run("unidadesList = workflowUnits");
  harness.context.workflowSearchItem = equipment;

  await harness.run("selecionarItemAutocomplete(workflowSearchItem)");
  assert.deepEqual(calls, [`/api/equipamento/${equipment.serial}`]);
  assert.equal(
    harness.element("retirada-cnpj").value,
    equipment.retirada_cnpj,
    JSON.stringify(harness.effects.toasts),
  );

  harness.element("select-unidade-destino").value = "17";
  harness.run('handleUnidadeDestinoChange("17", false)');
  assert.equal(harness.element("entrega-cnpj").value, deliveryCnpj);
});

test("copy serial action uses the currently selected equipment serial", async () => {
  const harness = createAppHarness(async () => {
    throw new Error("A ação de copiar não deve consultar a API");
  });
  const button = harness.element("btn-copiar-serie");

  harness.run("limparSelecaoEquipamento()");
  assert.equal(button.disabled, true);
  harness.selectEquipment({ serial: "SERIE-UM", apelido: "HOST-UM" });
  assert.equal(button.disabled, false);
  await harness.run("copiarSerieAtual()");
  assert.deepEqual(harness.effects.clipboardWrites, ["SERIE-UM"]);
  assert.equal(harness.effects.toasts.at(-1).type, "success");

  harness.selectEquipment({ serial: "SERIE-DOIS", apelido: "HOST-DOIS" });
  await harness.run("copiarSerieAtual()");
  assert.deepEqual(harness.effects.clipboardWrites, ["SERIE-UM", "SERIE-DOIS"]);

  harness.selectEquipment({ apelido: "HOST-SEM-SERIE" });
  assert.equal(button.disabled, true);
  await harness.run("copiarSerieAtual()");
  assert.deepEqual(harness.effects.clipboardWrites, ["SERIE-UM", "SERIE-DOIS"]);
  assert.equal(harness.effects.toasts.at(-1).type, "warning");

  harness.run("limparSelecaoEquipamento()");
  assert.equal(button.disabled, true);
});

test("transfer tab shows the selected serial with its copy action in the upper field", () => {
  const bannerStart = appHtml.indexOf('id="transfer-equipment-banner"');
  const copyButtonStart = appHtml.indexOf('id="btn-copiar-serie"');
  const quickActionsStart = appHtml.indexOf('<aside aria-label="Painel de Ações Rápidas"');
  assert.ok(bannerStart >= 0 && copyButtonStart > bannerStart && copyButtonStart < quickActionsStart);
  assert.equal((appHtml.match(/id="btn-copiar-serie"/g) || []).length, 1);

  const harness = createAppHarness(async () => {
    throw new Error("A exibição da série não deve consultar a API");
  });
  harness.run("limparSelecaoEquipamento()");
  harness.run('ativarAbaTransferencia("transferencia")');
  assert.equal(harness.element("transfer-serial").value, "");
  assert.equal(harness.element("btn-copiar-serie").disabled, true);

  harness.selectEquipment({ serial: "brj5512fgd", modelo: "HP 640 G11", tipo: "Notebook" });
  harness.run('ativarAbaTransferencia("transferencia")');
  assert.equal(harness.element("transfer-serial").value, "BRJ5512FGD");
  assert.equal(harness.element("transfer-equipment-banner").dataset.state, "selected");
  assert.equal(harness.element("transfer-equipment-description").textContent, "HP 640 G11 · Notebook");
  assert.equal(harness.element("transfer-serial-status").textContent, "Copiar");
  assert.equal(harness.element("btn-copiar-serie").disabled, false);
});

test("clicking an empty transfer serial opens Home and focuses equipment search", () => {
  assert.match(appHtml, /id="transfer-serial"[\s\S]*?onclick="abrirHomeParaPesquisarEquipamento\(\)"/);
  assert.match(appCss, /\.transfer-equipment-banner\[data-state="empty"\][^{]*\{[^}]*cursor:\s*pointer/s);

  const harness = createAppHarness(async () => {
    throw new Error("Opening the search must not call the API");
  });
  harness.run('ativarAbaTransferencia("transferencia")');
  harness.run("abrirHomeParaPesquisarEquipamento()");

  assert.equal(harness.element("tab-panel-home").hidden, false);
  assert.equal(harness.element("tab-panel-retirada-entrega").hidden, true);
  assert.equal(harness.element("tab-home").attributes.get("aria-selected"), "true");
  assert.equal(harness.element("input-serial").focused, true);
});

test("clicking a selected transfer serial keeps the transfer tab active", () => {
  const harness = createAppHarness(async () => {
    throw new Error("Clicking a selected serial must not call the API");
  });
  harness.selectEquipment({ serial: "SERIE-SELECIONADA" });
  harness.run('ativarAbaTransferencia("transferencia")');
  harness.run("abrirHomeParaPesquisarEquipamento()");

  assert.equal(harness.element("tab-panel-home").hidden, true);
  assert.equal(harness.element("tab-panel-retirada-entrega").hidden, false);
  assert.equal(harness.element("input-serial").focused, false);
});

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

test("automatic history export preference is restored and saved in this browser", () => {
  const localStorage = new Map();
  const firstHarness = createAppHarness(async () => apiResponse({}), { localStorage });
  firstHarness.run("inicializarExportacaoAutomaticaHistorico()");
  const firstInput = firstHarness.element("auto-export-history-after-update");
  assert.equal(firstInput.checked, false);
  firstInput.checked = true;
  firstInput.dispatchEvent("change");
  assert.equal(localStorage.get("simpress:auto-export-history-after-update"), "true");

  const nextHarness = createAppHarness(async () => apiResponse({}), { localStorage });
  nextHarness.run("inicializarExportacaoAutomaticaHistorico()");
  assert.equal(nextHarness.element("auto-export-history-after-update").checked, true);
});

test("enabled automatic history export downloads the updated event day", async () => {
  const calls = [];
  const eventTime = "2026-10-09T14:30:00-03:00";
  const harness = createAppHarness(async url => {
    calls.push(url);
    if (url === "/api/planilhas/atualizar") {
      return apiResponse({ comparacao: { horario_comparacao: eventTime } });
    }
    if (url === "/api/historico-comparacoes/exportar/excel?data=2026-10-09") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'attachment; filename="Historico_Planilhas_20261009.xlsx"' },
        blob: async () => ({}),
      };
    }
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.element("auto-export-history-after-update").checked = true;
  chooseUploadFiles(harness);

  await harness.run("enviarPlanilhas()");

  assert.deepEqual(calls, [
    "/api/planilhas/atualizar",
    "/api/historico-comparacoes/exportar/excel?data=2026-10-09",
  ]);
  assert.equal(harness.run("document.body.children.at(-1).clicked"), true);
  assert.deepEqual(harness.effects.comparisons, [{ horario_comparacao: eventTime }]);
  assert.equal(harness.effects.toasts.at(-1).message, "Histórico do dia exportado automaticamente.");
});

test("automatic export failure does not turn a successful inventory update into a failed upload", async () => {
  const calls = [];
  const eventTime = "2026-10-09T14:30:00-03:00";
  const harness = createAppHarness(async url => {
    calls.push(url);
    if (url === "/api/planilhas/atualizar") {
      return apiResponse({ comparacao: { horario_comparacao: eventTime } });
    }
    if (url === "/api/historico-comparacoes/exportar/excel?data=2026-10-09") {
      return apiResponse({ detail: "Exportação indisponível no teste." }, { status: 503, ok: false });
    }
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.element("auto-export-history-after-update").checked = true;
  chooseUploadFiles(harness);

  await harness.run("enviarPlanilhas()");

  assert.deepEqual(calls, [
    "/api/planilhas/atualizar",
    "/api/historico-comparacoes/exportar/excel?data=2026-10-09",
  ]);
  assert.deepEqual(harness.effects.comparisons, [{ horario_comparacao: eventTime }]);
  assert.equal(harness.element("upload-planilhas-status").textContent, "");
  assert.match(harness.effects.toasts.at(-1).message, /não foi possível exportar o histórico/);
  assert.equal(harness.effects.toasts.at(-1).type, "warning");
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
  assert.equal(harness.effects.comparisons.length, 0);
  assert.equal(harness.element("btn-confirmar-planilhas").disabled, false);
});

test("inventory upload retry keeps its key until success or a new file selection", async () => {
  const keys = [];
  const harness = createAppHarness(async (url, options) => {
    assert.equal(url, "/api/planilhas/atualizar");
    keys.push(options.headers["Idempotency-Key"]);
    if (keys.length === 1) throw new Error("Resposta perdida");
    return apiResponse({ comparacao: {} });
  });
  chooseUploadFiles(harness);
  await harness.run("enviarPlanilhas()");
  await harness.run("enviarPlanilhas()");
  assert.ok(keys[0]);
  assert.equal(keys[1], keys[0]);
  chooseUploadFiles(harness);
  await harness.run("enviarPlanilhas()");
  assert.notEqual(keys[2], keys[1]);
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

test("late alias save confirms success without taking over a newer selection", async () => {
  let resolveSave;
  const harness = createAppHarness(async url => {
    assert.equal(url, "/api/equipamento/atualizar-apelido");
    return new Promise(resolve => { resolveSave = resolve; });
  });
  const original = { ...priorEquipment, serial: "SERIE-ANTIGA", apelido: "HOST-ANTIGO" };
  const newer = { serial: "SERIE-NOVA", modelo: "Seleção nova", apelido: "HOST-NOVO" };
  harness.selectEquipment(original);
  harness.element("edit-apelido-isolado").value = "HOST-ATUALIZADO";

  const saving = harness.run("salvarApelido()");
  for (let attempt = 0; attempt < 20 && !resolveSave; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof resolveSave, "function");
  harness.selectEquipment(newer);
  resolveSave(apiResponse({ equipamento: { ...original, apelido: "HOST-ATUALIZADO" } }));
  await saving;

  assert.equal(harness.run("currentEquipamento.serial"), "SERIE-NOVA");
  assert.equal(harness.element("input-serial").value, "SERIE-NOVA");
  assert.equal(harness.effects.toasts.at(-1).type, "success");
  assert.equal(harness.element("modal-editar-apelido").classList.contains("hidden"), false);
});

test("late equipment save leaves a newer selection and search intact", async () => {
  let resolveSave;
  const harness = createAppHarness(async url => {
    assert.equal(url, "/api/equipamento/salvar");
    return new Promise(resolve => { resolveSave = resolve; });
  });
  const original = { ...priorEquipment, serial: "SERIE-ANTIGA", revisao: "a".repeat(64) };
  const newer = { serial: "SERIE-NOVA", modelo: "Seleção nova", retirada_endereco: "Rua nova, 20" };
  harness.selectEquipment(original);
  harness.element("edit-serial").value = original.serial;
  harness.element("edit-serial").readOnly = true;
  harness.element("edit-modelo").value = "Modelo atualizado";
  harness.element("edit-tipo").value = "Notebook";
  harness.element("edit-id-cliente").value = "CLIENTE-2";

  const saving = harness.run("salvarDadosEquipamento()");
  for (let attempt = 0; attempt < 20 && !resolveSave; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof resolveSave, "function");
  harness.selectEquipment(newer);
  resolveSave(apiResponse({ equipamento: { ...original, modelo: "Modelo atualizado" }, mensagem: "Salvo" }));
  await saving;

  assert.equal(harness.run("currentEquipamento.serial"), "SERIE-NOVA");
  assert.equal(harness.element("input-serial").value, "SERIE-NOVA");
  assert.equal(harness.element("retirada-endereco").value, "Rua nova, 20");
  assert.equal(harness.effects.toasts.at(-1).type, "success");
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

test("restoration retry retains the original key and preview after a lost response", async () => {
  const requests = [];
  let previews = 0;
  const harness = createAppHarness(async (url, options = {}) => {
    if (url.endsWith("/restauracao")) {
      previews += 1;
      return apiResponse({ ...restorePreview, preview_token: String(previews).repeat(64) });
    }
    requests.push(options);
    if (requests.length === 1) throw new Error("Resposta perdida");
    return apiResponse({ evento: { total_equipamentos_carregados: 1, desfazer_disponivel: true } });
  });
  setButton(harness, new FakeElement(), "Restaurar versão anterior");
  const restore = 'restaurarHistoricoComparacao({ id: "retry-fixture" }, restoreButton)';
  await harness.run(restore);
  await harness.run(restore);
  assert.equal(requests[1].headers["Idempotency-Key"], requests[0].headers["Idempotency-Key"]);
  assert.equal(requests[1].body, requests[0].body);
  await harness.run(restore);
  assert.notEqual(requests[2].headers["Idempotency-Key"], requests[1].headers["Idempotency-Key"]);
  assert.notEqual(requests[2].body, requests[1].body);
});

test("copies the selected location postal code and installation CNPJ with the fixed billing CNPJ", async () => {
  const equipment = {
    ...priorEquipment,
    retirada_cep: "80000-123",
    retirada_cnpj: "12.345.678/0001-90",
  };
  const harness = createAppHarness(async () => { throw new Error("Nenhuma chamada de API esperada"); });
  harness.selectEquipment(equipment);
  harness.element("retirada-cnpj").value = equipment.retirada_cnpj;
  harness.element("retirada-endereco").value = `Rua da unidade, 10 - CEP ${equipment.retirada_cep}`;

  await harness.run('copiarDadoLocalAtual("cep")');
  await harness.run('copiarDadoLocalAtual("faturamento")');
  await harness.run('copiarDadoLocalAtual("instalacao")');

  assert.deepEqual(harness.effects.clipboardWrites, [
    "80000-123",
    "75.110.585/0001-00",
    "12.345.678/0001-90",
  ]);
  assert.deepEqual(harness.effects.toasts.map(({ type }) => type), ["success", "success", "success"]);
});

test("copies the currently selected pickup locality after forcing the headquarters", async () => {
  const equipment = {
    ...priorEquipment,
    retirada_cep: "87000-000",
    retirada_cnpj: "12.345.678/0001-90",
  };
  const harness = createAppHarness(async () => { throw new Error("Nenhuma chamada de API esperada"); });
  harness.selectEquipment(equipment);
  harness.context.workflowSede = {
    is_sede: true,
    cep: "80220-300",
    cnpj: "01.234.567/0001-89",
  };
  harness.run("unidadesList = [workflowSede]; forcarSedePradoVelho()");

  await harness.run('copiarDadoLocalAtual("cep")');
  await harness.run('copiarDadoLocalAtual("instalacao")');

  assert.deepEqual(harness.effects.clipboardWrites, ["80220-300", "01.234.567/0001-89"]);
  assert.deepEqual(harness.effects.toasts.map(({ type }) => type), ["info", "success", "success"]);
});

test("copies the fixed billing CNPJ and installation CNPJ for the selected delivery unit", async () => {
  const units = [
    { id: 11, cidade: "Londrina", cnpj: "11.111.111/0001-11", endereco_completo: "Rua Alfa, 1" },
    { id: 22, cidade: "Maringá", cnpj: "22.222.222/0001-22", endereco_completo: "Rua Beta, 2" },
  ];
  const harness = createAppHarness(async () => { throw new Error("Nenhuma chamada de API esperada"); });
  harness.context.workflowUnits = units;
  harness.run("unidadesList = workflowUnits");
  const installCopyButton = harness.element("btn-copiar-cnpj-instalacao-entrega");
  installCopyButton.disabled = true;
  assert.equal(installCopyButton.disabled, true);

  harness.element("select-unidade-destino").value = "11";
  harness.run('handleUnidadeDestinoChange("11", false)');
  assert.equal(installCopyButton.disabled, false);
  await harness.run('copiarDadoEntrega("faturamento")');
  await harness.run('copiarDadoEntrega("instalacao")');

  harness.element("select-unidade-destino").value = "22";
  harness.run('handleUnidadeDestinoChange("22", false)');
  await harness.run('copiarDadoEntrega("instalacao")');

  assert.deepEqual(harness.effects.clipboardWrites, [
    "75.110.585/0001-00",
    "11.111.111/0001-11",
    "22.222.222/0001-22",
  ]);
  assert.deepEqual(harness.effects.toasts.map(({ type }) => type), ["success", "success", "success"]);
  assert.match(harness.effects.toasts[1].message, /CNPJ de instalação de Londrina copiado/);
  assert.match(harness.effects.toasts[2].message, /CNPJ de instalação de Maringá copiado/);

  harness.element("select-unidade-destino").value = "";
  harness.run('handleUnidadeDestinoChange("")');
  assert.equal(installCopyButton.disabled, true);
});

test("starts with the delivery installation CNPJ copy button disabled", () => {
  assert.match(
    appHtml,
    /<button\s+type="button"\s+id="btn-copiar-cnpj-instalacao-entrega"\s+disabled\s+onclick="copiarDadoEntrega\('instalacao'\)"/
  );
});

test("requires a selected delivery unit before copying its installation CNPJ", async () => {
  const harness = createAppHarness(async () => { throw new Error("Nenhuma chamada de API esperada"); });

  await harness.run('copiarDadoEntrega("instalacao")');

  assert.deepEqual(harness.effects.clipboardWrites, []);
  assert.equal(harness.effects.toasts.at(-1).type, "warning");
  assert.match(harness.effects.toasts.at(-1).message, /Selecione uma unidade de destino/);
});

test("rejects malformed transfer emails and clears invalid state after correction", () => {
  const harness = createAppHarness(async () => { throw new Error("Nenhuma chamada de API esperada"); });
  for (const id of [
    "retirada-contato", "retirada-email", "retirada-telefone", "retirada-obs",
    "entrega-email", "entrega-telefone", "entrega-horario", "entrega-almoco",
    "entrega-pausa-duracao", "entrega-obs",
  ]) {
    harness.element(id).value = id.includes("email") ? "email-invalido" : "valor de teste";
  }
  const email = harness.element("retirada-email");
  email.isValid = false;

  assert.equal(harness.run("validarCamposObrigatoriosPlanilha()"), false);
  assert.equal(email.attributes.get("aria-invalid"), "true");
  assert.equal(email.focused, true);
  assert.equal(harness.effects.toasts.at(-1).type, "warning");

  email.isValid = true;
  assert.equal(harness.run("validarCamposObrigatoriosPlanilha()"), true);
  assert.equal(email.attributes.has("aria-invalid"), false);
});

test("keeps a transfer search when the user cancels the discard confirmation", () => {
  const harness = createAppHarness(
    async () => { throw new Error("Nenhuma chamada de API esperada"); },
    { confirmResult: false },
  );
  harness.element("input-serial").value = "SERIE-EM-PESQUISA";

  harness.run("resetarFormulario()");

  assert.equal(harness.element("input-serial").value, "SERIE-EM-PESQUISA");
  assert.equal(harness.effects.confirmations.length, 1);
  assert.equal(harness.effects.toasts.length, 0);
});

test("centralizes the latest comparison issues with row-level annotation autosave and filters", () => {
  assert.match(appHtml, /id="modal-central-pendencias"/);
  assert.match(appHtml, /id="filtro-operacional-pendencias"/);
  assert.match(appHtml, /id="categoria-operacional-pendencias"/);
  assert.match(appScript, /fetch\("\/api\/operacoes\/pendencias"\)/);
  assert.match(appScript, /data-operational-annotation/);
  assert.match(appScript, /\/anotacoes\/\$\{encodeURIComponent\(targetItemId\)\}/);
  assert.match(appScript, /Abrir atualização/);
});

test("shows an equipment timeline by normalized serial or hostname and keeps links to source updates", () => {
  assert.match(appHtml, /id="modal-historico-equipamento"/);
  assert.match(appHtml, /id="identificador-historico-equipamento"/);
  assert.match(appScript, /\/api\/operacoes\/equipamento\/\$\{encodeURIComponent\(identifier\)\}/);
  assert.match(appScript, /Abrir resultado da atualização/);
  assert.match(appScript, /data-timeline-event/);
});

test("compares two complete inventory updates and annotates each source row in the evolution view", () => {
  assert.match(appHtml, /id="modal-evolucao-atualizacoes"/);
  assert.match(appHtml, /id="evolucao-anterior"/);
  assert.match(appHtml, /id="evolucao-atual"/);
  assert.match(appScript, /\/api\/operacoes\/evolucao\?/);
  assert.match(appScript, /"Deixaram de aparecer"/);
  assert.match(appScript, /data-evolution-event/);
  assert.match(appScript, /renderizarAnotacaoOperacional\(item/);
});

test("imports Simpress and Oracle files and displays the serial-to-OS reconciliation", async () => {
  const requests = [];
  const report = {
    fontes: { simpress: { arquivo: "pedidos.xlsx" }, oracle: { arquivo: "solicitacoes.xlsx" } },
    resumo: { series_total: 1, conferidas: 1, divergentes: 0, sem_os: 0, somente_simpress: 0, somente_oracle: 0 },
    chamados: [{
      serie: "SERIE-1", relacao: "conferida", ordens_servico_conferidas: ["7285070"],
      simpress: { pedidos: ["PED-1"], ordens_servico: ["7285070"], chamados_cliente: [], status: ["Em atendimento"] },
      oracle: [{ solicitacao: "REQ-1", ordem_servico: "7285070", status: "Em execução", sub_status: "Pendente", fila: "Fila A", fase_atendimento: "Atendimento em campo", status_entregas: "Sem entregas", status_atividades: "Atividades pendentes" }],
    }],
  };
  const harness = createAppHarness(async (url, options) => {
    requests.push({ url, options });
    return apiResponse(report);
  });
  harness.element("arquivo-chamados-simpress").files = [{ name: "pedidos.xlsx" }];
  harness.element("arquivo-chamados-oracle").files = [{ name: "solicitacoes.xlsx" }];
  await harness.run("importarPlanilhasChamados({ preventDefault() {} })");

  assert.equal(requests[0].url, "/api/operacoes/chamados/importar");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(requests[0].options.body.fields.map(([name, file]) => [name, file.name]), [
    ["simpress_file", "pedidos.xlsx"], ["oracle_file", "solicitacoes.xlsx"],
  ]);
  const modal = harness.element("modal-acompanhamento-chamados");
  assert.ok(appHtml.includes('id="modal-acompanhamento-chamados"'));
  assert.match(appHtml, /Acompanhamento de Chamados/);
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /OS conferida/);
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /7285070/);
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /REQ-1/);
  assert.equal(modal.id, "modal-acompanhamento-chamados");
});

test("groups secondary actions while keeping spreadsheet updates prominent", () => {
  assert.match(appHtml, /id="btn-atualizar-planilhas" class="header-action-item header-action-item--large header-action-item--primary/);
  assert.match(appHtml, /id="btn-atualizar-planilhas"[\s\S]*?<\/button>\s*<button[^>]*id="btn-exportar-equipamentos"/);
  assert.match(appHtml, /id="btn-exportar-equipamentos"[^>]*header-action-item--large[^>]*header-action-item--emerald/);
  assert.match(appHtml, /<details class="header-action-group" data-action-group="analysis">/);
  assert.match(appHtml, /<details class="header-action-group" data-action-group="equipment">/);

  const analysisGroup = appHtml.match(/<details class="header-action-group" data-action-group="analysis">([\s\S]*?)<\/details>/)?.[1] || "";
  const equipmentGroup = appHtml.match(/<details class="header-action-group" data-action-group="equipment">([\s\S]*?)<\/details>/)?.[1] || "";
  assert.match(analysisGroup, /abrirCentralPendencias\(\)/);
  assert.match(analysisGroup, /abrirEvolucaoAtualizacoes\(\)/);
  assert.match(analysisGroup, /abrirModalHistoricoComparacoes\(\)/);
  assert.ok(analysisGroup.indexOf('id="btn-historico-comparacoes"') < analysisGroup.indexOf('onclick="abrirCentralPendencias()"'));
  assert.doesNotMatch(analysisGroup, /btn-exportar-equipamentos/);
  assert.match(equipmentGroup, /abrirHistoricoEquipamento\(\)/);
  assert.match(equipmentGroup, /abrirModalHistoricoApelidos\(\)/);
  assert.match(appHtml, /onclick="abrirAcompanhamentoChamados\(\)"/);
  assert.doesNotMatch(appHtml, /Acompanhamento de transportes/);
  assert.doesNotMatch(appScript, /\/api\/transferencias/);
});
