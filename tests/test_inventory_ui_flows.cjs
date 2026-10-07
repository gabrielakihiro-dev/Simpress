const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const transferUtils = require("../static/transfer-utils.js");
const catalogSearch = require("../static/catalog-search-utils.js");
const formDraftGuard = require("../static/form-draft-guard.js");
const annotationAutosave = require("../static/history-annotation-autosave.js");

const appScript = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");

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
  addEventListener() {}
  replaceChildren(...children) { this.children = children; }
  appendChild(child) { this.children.push(child); return child; }
  querySelector() { return null; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  checkValidity() { return this.isValid; }
  closest() { return null; }
  getClientRects() { return [1]; }
}

class FakeFormData {
  constructor() { this.fields = []; }
  append(...args) { this.fields.push(args); }
}

function createAppHarness(fetchApi, { stubDisplay = true, confirmResult = true } = {}) {
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
    createElement: tag => new FakeElement(tag),
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
    URL: { createObjectURL: () => "blob:ficticio", revokeObjectURL() {} },
    matchMedia: () => ({ matches: false }),
    confirm: message => { effects.confirmations.push(message); return confirmResult; },
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
    lucide: { createIcons() {} },
    console: { error() {}, warn() {}, log() {} },
    workflowEffects: effects,
  });

  vm.runInContext(appScript, context, { filename: "static/app.js" });
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
  assert.equal(harness.effects.comparisons.length, 0);
  assert.equal(harness.element("btn-confirmar-planilhas").disabled, false);
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
