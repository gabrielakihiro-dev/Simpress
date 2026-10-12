const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const transferUtils = require("../../static/js/shared/transfer-utils.js");
const catalogSearch = require("../../static/js/shared/catalog-search-utils.js");
const formDraftGuard = require("../../static/js/shared/form-draft-guard.js");
const annotationAutosave = require("../../static/js/shared/history-annotation-autosave.js");
const accessibleDialogs = require("../../static/js/ui/accessible-dialogs.js");
const notifications = require("../../static/js/ui/ui-notifications.js");

const appScript = fs.readFileSync(path.join(__dirname, "..", "..", "static", "app.js"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "..", "..", "static", "index.html"), "utf8");
const appCss = fs.readFileSync(path.join(__dirname, "..", "..", "static", "app.css"), "utf8");

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
  scrollIntoView(options) { this.scrollIntoViewOptions = options; }
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
        return { cells, dataset: {}, hasAttribute: () => false, getAttribute: () => null };
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
    SimpressDomUtils: require("../../static/js/shared/dom-utils.js"),
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
    URLSearchParams,
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

function pendingTicketResponse() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function ticketSelectionHarness(fetchApi) {
  const harness = createAppHarness(fetchApi);
  harness.run(`
    renderizarAcompanhamentoChamados = () => {
      document.getElementById("lista-acompanhamento-chamados").innerHTML = acompanhamentoChamadosAtual?.snapshot_id || "Importe as duas planilhas";
    };
    carregarEvolucaoChamados = async () => {};
  `);
  return harness;
}

test("latest ticket snapshot wins when responses arrive out of order", async () => {
  const old = pendingTicketResponse(), latest = pendingTicketResponse();
  const requests = [];
  const harness = ticketSelectionHarness((url, options) => {
    requests.push(options);
    return url.endsWith("/old") ? old.promise : latest.promise;
  });
  harness.element("versao-acompanhamento-chamados").value = "old";
  const first = harness.run("selecionarVersaoChamados()");
  harness.element("versao-acompanhamento-chamados").value = "latest";
  const second = harness.run("selecionarVersaoChamados()");
  latest.resolve(apiResponse({})); await second;
  old.resolve(apiResponse({})); await first;
  assert.equal(harness.run("acompanhamentoChamadosAtual.snapshot_id"), "latest");
  assert.equal(harness.element("lista-acompanhamento-chamados").innerHTML, "latest");
  assert.equal(requests[0].signal.aborted, true);
});

test("stale ticket errors cannot replace a newer successful snapshot", async () => {
  const old = pendingTicketResponse();
  const harness = ticketSelectionHarness(url => url.endsWith("/old") ? old.promise : Promise.resolve(apiResponse({})));
  harness.element("versao-acompanhamento-chamados").value = "old";
  const first = harness.run("selecionarVersaoChamados()");
  harness.element("versao-acompanhamento-chamados").value = "latest";
  await harness.run("selecionarVersaoChamados()");
  old.reject(new Error("falha antiga")); await first;
  assert.equal(harness.element("lista-acompanhamento-chamados").innerHTML, "latest");
});

test("choosing no ticket import cancels a pending snapshot and clears the selected report", async () => {
  const old = pendingTicketResponse();
  const requests = [];
  const harness = ticketSelectionHarness((url, options) => {
    requests.push(options);
    return old.promise;
  });
  harness.run('acompanhamentoChamadosAtual = { snapshot_id: "previous" }');
  harness.element("versao-acompanhamento-chamados").value = "previous";
  const pending = harness.run("selecionarVersaoChamados()");

  harness.element("versao-acompanhamento-chamados").value = "";
  await harness.run("selecionarVersaoChamados()");
  old.resolve(apiResponse({}));
  await pending;

  assert.equal(requests[0].signal.aborted, true);
  assert.equal(harness.run("acompanhamentoChamadosAtual"), null);
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /Importe as duas planilhas/);
});

test("a late initial ticket load cannot overwrite a selected historical snapshot", async () => {
  const initial = pendingTicketResponse();
  const harness = ticketSelectionHarness(url => url.endsWith("/chamados") ? initial.promise : Promise.resolve(apiResponse({})));
  const first = harness.run("carregarAcompanhamentoChamados()");
  harness.element("versao-acompanhamento-chamados").value = "historical";
  await harness.run("selecionarVersaoChamados()");
  initial.resolve(apiResponse({ snapshot_id: "current", historico: [] })); await first;
  assert.equal(harness.run("acompanhamentoChamadosAtual.snapshot_id"), "historical");
});

test("closing ticket tracking cancels reads and ignores their late completion", async () => {
  const response = pendingTicketResponse();
  const harness = ticketSelectionHarness(() => response.promise);
  harness.run("fecharModalAcessivel = () => {}");
  harness.element("versao-acompanhamento-chamados").value = "old";
  const pending = harness.run("selecionarVersaoChamados()");
  harness.run("fecharAcompanhamentoChamados()");
  response.resolve(apiResponse({})); await pending;
  assert.equal(harness.run("acompanhamentoChamadosAtual"), null);
});

test("rebuilding ticket cards aborts timeline reads tied to the old cards", async () => {
  const response = pendingTicketResponse();
  let options;
  const harness = createAppHarness((_url, requestOptions) => {
    options = requestOptions;
    return response.promise;
  });
  const details = new FakeElement("timeline"), body = new FakeElement("timeline-body");
  details.open = true;
  details.querySelector = () => body;
  harness.context.testTimeline = details;
  const pending = harness.run("carregarLinhaDoTempoChamado(testTimeline)");

  await harness.run("renderizarAcompanhamentoChamados()");

  assert.equal(options.signal.aborted, true);
  response.resolve(apiResponse({ eventos: [] }));
  await pending;
  assert.equal(details.dataset.ticketTimelineLoaded, undefined);
  assert.match(body.innerHTML, /Carregando histórico/);
});

test("ticket evolution ignores a stale error after a newer comparison succeeds", async () => {
  const old = pendingTicketResponse();
  const harness = createAppHarness(url => url.includes("atual=one") ? old.promise : Promise.resolve(apiResponse({ marker: "latest" })));
  harness.run(`
    historicoAcompanhamentoChamados = [{ id: "two" }, { id: "one" }, { id: "zero" }];
    renderizarEvolucaoChamados = data => document.getElementById("evolucao-acompanhamento-chamados").textContent = data.marker;
  `);
  const first = harness.run('carregarEvolucaoChamados("one")');
  await harness.run('carregarEvolucaoChamados("two")');
  old.reject(new Error("falha antiga")); await first;
  assert.equal(harness.element("evolucao-acompanhamento-chamados").textContent, "latest");
});

test("detached ticket timelines never install annotation editors after loading", async () => {
  const response = pendingTicketResponse();
  const harness = createAppHarness(() => response.promise);
  const details = new FakeElement("timeline"), body = new FakeElement("timeline-body");
  details.open = true;
  details.dataset.timelineSerial = "SN-SYNTHETIC";
  details.querySelector = () => body;
  harness.context.testTimeline = details;
  harness.run('conectarAnotacoesLinhaDoTempo = () => { throw new Error("editor should not attach"); }');
  const pending = harness.run("carregarLinhaDoTempoChamado(testTimeline)");
  details.isConnected = false;
  response.resolve(apiResponse({ eventos: [] })); await pending;
  assert.equal(details.dataset.ticketTimelineLoaded, undefined);
  assert.doesNotMatch(body.innerHTML, /editor should not attach/);
});

test("timeline reads deduplicate while pending and allow retry after a network error", async () => {
  const first = pendingTicketResponse();
  let requests = 0;
  const harness = createAppHarness(() => {
    requests += 1;
    return requests === 1 ? first.promise : Promise.resolve(apiResponse({ eventos: [] }));
  });
  const details = new FakeElement("timeline"), body = new FakeElement("timeline-body");
  details.open = true;
  details.querySelector = () => body;
  harness.context.testTimeline = details;
  harness.run("conectarAnotacoesLinhaDoTempo = () => {}");
  const pending = harness.run("carregarLinhaDoTempoChamado(testTimeline)");
  await harness.run("carregarLinhaDoTempoChamado(testTimeline)");
  assert.equal(requests, 1);
  first.reject(new Error("rede indisponível")); await pending;
  assert.match(body.innerHTML, /rede indisponível/);
  await harness.run("carregarLinhaDoTempoChamado(testTimeline)");
  assert.equal(requests, 2);
  assert.equal(details.dataset.ticketTimelineLoaded, "true");
});

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
function uploadPreviewResult(overrides = {}) {
  return {
    preview_token: "token-ficticio",
    arquivos: {
      endpoint: { nome: "endpoint-ficticio.xlsx", linhas: 2 },
      detalhes: { nome: "detalhes-ficticio.xlsx", linhas: 3 },
    },
    alteracoes: {
      endpoint: { series_novas: 1, series_removidas: 2, series_duplicadas_no_arquivo_novo: 0 },
      detalhes: { series_novas: 2, series_removidas: 1, series_duplicadas_no_arquivo_novo: 1 },
    },
    ...overrides,
  };
}

function chooseUploadFiles(harness) {
  harness.element("upload-endpoint-file").files = [{ name: "endpoint-ficticio.xlsx" }];
  harness.element("upload-details-file").files = [{ name: "detalhes-ficticio.xlsx" }];
  harness.element("btn-previsualizar-planilhas").innerHTML = "Pré-visualizar impacto";
  harness.element("btn-confirmar-planilhas").innerHTML = "Confirmar substituição";
  harness.element("btn-confirmar-planilhas").classList.add("hidden");
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
    if (url === "/api/planilhas/previsualizar") return apiResponse(uploadPreviewResult());
    if (url === "/api/planilhas/atualizar") {
      return apiResponse({ comparacao: { resumo: "comparação fictícia" } });
    }
    if (url === "/api/equipamento/SERIE-ANTIGA") return apiResponse(refreshed);
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.selectEquipment(priorEquipment);
  chooseUploadFiles(harness);

  await harness.run("previsualizarPlanilhas()");
  assert.equal(calls[0].url, "/api/planilhas/previsualizar");
  assert.match(harness.element("upload-planilhas-preview").textContent, /Séries novas: 1; removidas: 2/);
  assert.equal(harness.element("btn-confirmar-planilhas").classList.contains("hidden"), false);
  const endpointFile = harness.element("upload-endpoint-file").files[0];
  const detailsFile = harness.element("upload-details-file").files[0];

  await harness.run("enviarPlanilhas()");

  assert.deepEqual(calls.map(call => call.url), [
    "/api/planilhas/previsualizar",
    "/api/planilhas/atualizar",
    "/api/equipamento/SERIE-ANTIGA",
    "/api/prontidao",
  ]);
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(calls[1].options.body.fields.map(([name]) => name), ["endpoint_file", "details_file", "preview_token"]);
  assert.equal(calls[1].options.body.fields[0][1], endpointFile);
  assert.equal(calls[1].options.body.fields[1][1], detailsFile);
  assert.equal(calls[1].options.body.fields[2][1], "token-ficticio");
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
    if (url === "/api/planilhas/previsualizar") return apiResponse(uploadPreviewResult());
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

  await harness.run("previsualizarPlanilhas()");
  await harness.run("enviarPlanilhas()");

  assert.deepEqual(calls, [
    "/api/planilhas/previsualizar",
    "/api/planilhas/atualizar",
    "/api/prontidao",
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
    if (url === "/api/planilhas/previsualizar") return apiResponse(uploadPreviewResult());
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

  await harness.run("previsualizarPlanilhas()");
  await harness.run("enviarPlanilhas()");

  assert.deepEqual(calls, [
    "/api/planilhas/previsualizar",
    "/api/planilhas/atualizar",
    "/api/prontidao",
    "/api/historico-comparacoes/exportar/excel?data=2026-10-09",
  ]);
  assert.deepEqual(harness.effects.comparisons, [{ horario_comparacao: eventTime }]);
  assert.equal(harness.element("upload-planilhas-status").textContent, "");
  assert.match(harness.effects.toasts.at(-1).message, /não foi possível exportar o histórico/);
  assert.equal(harness.effects.toasts.at(-1).type, "warning");
});

test("failed inventory upload keeps the selected equipment and shows its error", async () => {
  const harness = createAppHarness(async url => {
    if (url === "/api/planilhas/previsualizar") return apiResponse(uploadPreviewResult());
    assert.equal(url, "/api/planilhas/atualizar");
    return apiResponse({ detail: "Arquivo fictício inválido" }, { status: 422, ok: false });
  });
  harness.selectEquipment(priorEquipment);
  chooseUploadFiles(harness);

  await harness.run("previsualizarPlanilhas()");
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
  assert.equal(harness.element("btn-confirmar-planilhas").classList.contains("hidden"), true);
  assert.equal(harness.element("btn-previsualizar-planilhas").classList.contains("hidden"), false);
});

test("missing upload files block the preview and announce the error immediately", async () => {
  const harness = createAppHarness(async () => {
    throw new Error("A API não deve ser chamada sem os arquivos.");
  });
  harness.element("modal-atualizar-planilhas").classList.remove("hidden");

  await harness.run("previsualizarPlanilhas()");

  const status = harness.element("upload-planilhas-status");
  assert.match(status.textContent, /Selecione Endpoint e EquipamentosDetalhes antes de gerar a prévia/);
  assert.equal(status.scrollIntoViewOptions?.block, "nearest");
  assert.equal(status.attributes.get("role"), "alert");
  assert.equal(status.attributes.get("aria-live"), "assertive");
});

test("replacing a selected file after preview requires a fresh preview", async () => {
  const calls = [];
  const harness = createAppHarness(async url => {
    calls.push(url);
    assert.equal(url, "/api/planilhas/previsualizar");
    return apiResponse(uploadPreviewResult());
  });
  chooseUploadFiles(harness);

  await harness.run("previsualizarPlanilhas()");
  harness.element("upload-endpoint-file").files = [{ name: "outro-endpoint.xlsx" }];
  await harness.run("enviarPlanilhas()");

  assert.deepEqual(calls, ["/api/planilhas/previsualizar"]);
  assert.match(harness.element("upload-planilhas-status").textContent, /Os arquivos mudaram depois da prévia/);
  assert.equal(harness.element("btn-confirmar-planilhas").classList.contains("hidden"), true);
  assert.equal(harness.element("btn-previsualizar-planilhas").classList.contains("hidden"), false);
});

test("preview failure keeps the modal open and does not expose a confirmation action", async () => {
  const harness = createAppHarness(async () => apiResponse(
    { detail: "A base ativa não pôde ser validada." },
    { status: 409, ok: false },
  ));
  chooseUploadFiles(harness);

  await harness.run("previsualizarPlanilhas()");

  assert.equal(harness.element("modal-atualizar-planilhas").classList.contains("hidden"), false);
  assert.equal(harness.element("upload-planilhas-status").textContent, "A base ativa não pôde ser validada.");
  assert.equal(harness.element("btn-confirmar-planilhas").classList.contains("hidden"), true);
});

test("missing preview API instructs the user to restart the local server", async () => {
  const harness = createAppHarness(async () => apiResponse(
    { detail: "Not Found" },
    { status: 404, ok: false },
  ));
  chooseUploadFiles(harness);

  await harness.run("previsualizarPlanilhas()");

  assert.match(harness.element("upload-planilhas-status").textContent, /API ativa está desatualizada/);
  assert.equal(harness.element("btn-confirmar-planilhas").classList.contains("hidden"), true);
});

test("cancelling a completed preview never submits an inventory replacement", async () => {
  const calls = [];
  const harness = createAppHarness(async url => {
    calls.push(url);
    return apiResponse(uploadPreviewResult());
  });
  chooseUploadFiles(harness);

  await harness.run("previsualizarPlanilhas()");
  harness.run("fecharModalAtualizarPlanilhas()");

  assert.deepEqual(calls, ["/api/planilhas/previsualizar"]);
  assert.equal(harness.run("previaPlanilhasAtual"), null);
  assert.equal(harness.element("btn-confirmar-planilhas").classList.contains("hidden"), true);
});

test("PostgreSQL confirmation keeps its existing upload without inventing impact counts", async () => {
  let submitted;
  const harness = createAppHarness(async (url, options) => {
    if (url === "/api/planilhas/previsualizar") return apiResponse({ preview_required: false });
    assert.equal(url, "/api/planilhas/atualizar");
    submitted = options.body.fields;
    return apiResponse({ comparacao: {} });
  });
  chooseUploadFiles(harness);
  await harness.run("previsualizarPlanilhas()");
  assert.match(harness.element("upload-planilhas-preview").textContent, /Confira os arquivos selecionados/);
  assert.doesNotMatch(harness.element("upload-planilhas-preview").textContent, /Séries novas/);
  await harness.run("enviarPlanilhas()");
  assert.deepEqual(submitted.map(([name]) => name), ["endpoint_file", "details_file"]);
  assert.equal(harness.element("modal-atualizar-planilhas").classList.contains("hidden"), true);
});

test("inventory upload retry keeps its key until success or a new file selection", async () => {
  const keys = [];
  const harness = createAppHarness(async (url, options) => {
    if (url === "/api/planilhas/previsualizar") return apiResponse(uploadPreviewResult());
    assert.equal(url, "/api/planilhas/atualizar");
    keys.push(options.headers["Idempotency-Key"]);
    if (keys.length === 1) throw new Error("Resposta perdida");
    return apiResponse({ comparacao: {} });
  });
  chooseUploadFiles(harness);
  await harness.run("previsualizarPlanilhas()");
  await harness.run("enviarPlanilhas()");
  await harness.run("enviarPlanilhas()");
  assert.ok(keys[0]);
  assert.equal(keys[1], keys[0]);
  chooseUploadFiles(harness);
  await harness.run("previsualizarPlanilhas()");
  await harness.run("enviarPlanilhas()");
  assert.notEqual(keys[2], keys[1]);
});

test("successful upload clears a selection removed from the replacement inventory", async () => {
  const harness = createAppHarness(async url => {
    if (url === "/api/planilhas/previsualizar") return apiResponse(uploadPreviewResult());
    if (url === "/api/planilhas/atualizar") return apiResponse({ comparacao: { id: "atualizacao" } });
    if (url === "/api/equipamento/SERIE-ANTIGA") {
      return apiResponse({ detail: "Equipamento não encontrado" }, { status: 404, ok: false });
    }
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.selectEquipment(priorEquipment);
  chooseUploadFiles(harness);

  await harness.run("previsualizarPlanilhas()");
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
    if (url === "/api/planilhas/previsualizar") return apiResponse(uploadPreviewResult());
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

  await harness.run("previsualizarPlanilhas()");
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
  const ticketCards = harness.element("lista-acompanhamento-chamados").innerHTML;
  assert.ok(appHtml.includes('id="modal-acompanhamento-chamados"'));
  assert.match(appHtml, /href="https:\/\/simpress\.custhelp\.com\/AgentWeb\/" target="_blank" rel="noopener noreferrer"[^>]*aria-label="Abrir portal Oracle AgentWeb"/);
  assert.match(appHtml, /href="https:\/\/ux\.simpress\.com\.br\/equipamentos\/acompanhamento" target="_blank" rel="noopener noreferrer"[^>]*aria-label="Abrir acompanhamento de chamados Simpress"/);
  assert.equal((appHtml.match(/class="ticket-agent-link[^>]*"/g) || []).length, 2);
  assert.match(appHtml, /id="conteudo-acompanhamento-chamados"[^>]*overflow-y-auto/);
  assert.match(appHtml, /Acompanhamento de Chamados/);
  assert.match(ticketCards, /OS conferida/);
  assert.match(ticketCards, /7285070/);
  assert.match(ticketCards, /REQ-1/);
  assert.match(ticketCards, /text-lg font-bold leading-none text-violet-100/);
  assert.match(ticketCards, /class="ticket-card-identifier border border-cyan/);
  assert.match(ticketCards, /class="ticket-card-identifier border border-violet/);
  assert.equal(modal.id, "modal-acompanhamento-chamados");
});

test("provides Endpoint and Simpress shortcuts in the spreadsheet update dialog", () => {
  assert.match(appHtml, /id="modal-atualizar-planilhas"/);
  assert.ok(appHtml.includes('href="https://centralendpoint.pr.sebrae.com.br/webclient#/uems/inventory/computers" target="_blank" rel="noopener noreferrer"'));
  assert.ok(appHtml.includes('href="https://ux.simpress.com.br/MeusEquipamentos/Index" target="_blank" rel="noopener noreferrer"'));
  assert.match(appHtml, /spreadsheet-source-link--endpoint[^>]*aria-label="Abrir inventário de computadores do Endpoint Central"/);
  assert.match(appHtml, /spreadsheet-source-link--simpress[^>]*aria-label="Abrir Meus Equipamentos da Simpress"/);
  assert.equal((appHtml.match(/class="spreadsheet-source-link spreadsheet-source-link--/g) || []).length, 2);
  assert.match(appCss, /\.spreadsheet-source-link:focus-visible/);
});

test("opens ticket import controls only when there are no imported calls", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  const managementPanel = harness.element("painel-dados-acompanhamento-chamados");
  managementPanel.open = false;
  harness.context.ticketTestReport = { resumo: {}, chamados: [] };
  harness.run("acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");

  assert.equal(managementPanel.open, true);
  assert.match(appHtml, /id="filtro-acompanhamento-chamados"/);
  assert.match(appHtml, /id="btn-exportar-acompanhamento-chamados"[^>]*>Exportar Excel/);
  assert.match(appHtml, /class="ticket-filter-toolbar"/);
  assert.doesNotMatch(appHtml, /Filtros avançados|relacao-acompanhamento-chamados|status-acompanhamento-chamados|fila-acompanhamento-chamados|cidade-acompanhamento-chamados|atendimento-acompanhamento-chamados|idade-acompanhamento-chamados/);
  assert.match(appHtml, /id="painel-dados-acompanhamento-chamados" class="ticket-disclosure[^>]*>/);
  assert.match(appCss, /\.ticket-filter-action\s*\{[^}]*width: auto;[^}]*min-height: 2\.25rem;/);
});

test("shows Simpress product and city while gating delivery address by order status", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  harness.context.ticketTestReport = {
    fontes: {},
    resumo: { series_total: 2, conferidas: 0, divergentes: 0, sem_os: 0, somente_simpress: 2, somente_oracle: 0 },
    chamados: [
      {
        serie: "SN-ATIVO", relacao: "conferida", ordens_servico_conferidas: ["7124895", "7134662"], alertas_relacao: [{ mensagem: "Pedido com possíveis duplicidades" }], oracle: [{
          solicitacao: "REQ-77", ordem_servico: "7134662", status: "Em execução", fila: "Fila A",
          logradouro: "R Caeté", numero_endereco: "150", bairro: "Prado Velho", cidade: "Curitiba", atendido_pela_inibicao: "Não", nome_filial: "SIMPRESS - PR",
          ultima_atualizacao: "09/10/2026 14:15",
          descricao: `Solicito suporte para este equipamento. ${"Detalhe técnico importante. ".repeat(8)}<script>alert('x')</script>`,
        }, { solicitacao: "REQ-76", ordem_servico: "7124895", status: "Concluído", fila: "Fila A" }],
        simpress: {
          pedidos: ["48076976"], ordens_venda: ["OV_15799764"], ordens_servico: ["7124895", "7134662"], chamados_cliente: ["Não informado", ""], status: ["Verificação de estoque"],
          descricoes_produto: ["Notebook HP ProBook"], previsoes_entrega: ["2026-09-28"], cidades_entrega: ["Curitiba"],
          enderecos_entrega: ["Rua das Flores, 123, Curitiba - PR"], pedido_em_andamento: true,
        },
      },
      {
        serie: "SN-ENTREGUE", relacao: "somente_simpress", ordens_servico_conferidas: [], oracle: [],
        simpress: {
          pedidos: ["48076977"], ordens_servico: ["7232036"], status: ["Pedido entregue"], chamados_cliente: ["INC-77"],
          previsoes_entrega: ["15/09/2026"],
          descricoes_produto: ["Monitor HP"], cidades_entrega: ["Maringá"],
          enderecos_entrega: [], pedido_em_andamento: false,
        },
      },
    ],
  };
  harness.run("acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");
  const cards = harness.element("lista-acompanhamento-chamados").innerHTML;
  const activeCard = cards.split('data-ticket-serial="SN-ATIVO"')[1].split("</article>")[0];
  const activeSummary = activeCard.split('<details class="ticket-disclosure mt-3')[0];
  assert.match(activeSummary, /OS Simpress/);
  assert.match(activeSummary, /OS Oracle/);
  assert.match(activeSummary, /7134662/);
  assert.match(activeSummary, /Pedido<\/b> 48076976/);
  assert.match(activeSummary, /OV<\/b> OV_15799764/);
  assert.match(activeSummary, /Status Simpress/);
  assert.match(activeSummary, /Fila: Fila A/);
  assert.match(activeSummary, /Cidade: Curitiba/);
  assert.match(activeSummary, /Atendimento: Simpress/);
  assert.match(activeSummary, /Atualização: Sem atualização há/);
  assert.doesNotMatch(activeSummary, /Descrição do produto|Endereço de entrega|Série em/);
  assert.doesNotMatch(activeSummary, /REQ-77|R Caeté/);
  assert.match(activeCard, /data-ticket-section="details"/);
  assert.match(activeCard, /Descrição do produto: Notebook HP ProBook/);
  assert.match(activeCard, /Cidade de entrega: Curitiba/);
  assert.match(activeCard, /Previsão de entrega: 28\/09\/2026/);
  assert.match(activeCard, /Endereço de entrega: Rua das Flores, 123, Curitiba - PR/);
  assert.doesNotMatch(activeCard, /data-ticket-section="conference"|Conferência das relações|Revisar relação/);
  assert.match(activeSummary, /OS conferida/);
  assert.match(activeCard, /data-ticket-section="timeline"/);
  assert.match(activeCard, /Linha do tempo e anotações/);
  const oracleCards = activeCard.split("Oracle · solicitações e OS")[1];
  assert.ok(oracleCards.indexOf("7134662") < oracleCards.indexOf("7124895"));
  assert.match(oracleCards, /Endereço: R Caeté, 150, Prado Velho, Curitiba/);
  assert.match(oracleCards, /Atendido pela inibição: Não/);
  assert.match(oracleCards, /Atendimento por: SIMPRESS - PR/);
  assert.ok(oracleCards.includes(`Atualizado ${harness.run('formatarHorarioHistorico("09/10/2026 14:15")')}`));
  assert.match(cards, /<details class="ticket-oracle-description">/);
  assert.match(cards, /Descrição do chamado/);
  assert.match(cards, /⌄ Expandir/);
  assert.ok(cards.includes("&lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt;"));
  assert.doesNotMatch(cards, /<script>alert\('x'\)<\/script>/);
  assert.match(appCss, /\.ticket-oracle-description-content[\s\S]*max-height: 12rem; overflow: auto/);
  assert.match(appCss, /\.ticket-disclosure > summary:focus-visible/);
  assert.match(appCss, /\.ticket-card-meta > span:not\(:first-child\)::before,\s*\.ticket-card-triage > span:not\(:first-child\)::before\s*\{\s*content: "•";/);
  assert.match(appHtml, /id="painel-dados-acompanhamento-chamados"/);
  assert.doesNotMatch(appHtml, /Filtros avançados|filtros-avancados-acompanhamento-chamados/);
  assert.doesNotMatch(cards, /Chamado do cliente: Não informado/);
  const deliveredCard = cards.split('data-ticket-serial="SN-ENTREGUE"')[1].split("</article>")[0];
  assert.match(deliveredCard, /Descrição do produto: Monitor HP/);
  assert.match(deliveredCard, /Cidade de entrega: Maringá/);
  assert.match(deliveredCard, /Previsão de entrega: 15\/09\/2026/);
  assert.match(deliveredCard, /Chamado do cliente: INC-77/);
  assert.doesNotMatch(deliveredCard, /Endereço de entrega:/);
});

test("sorts ticket cards by descending OS and leaves tickets without an OS at the end", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  const ticket = (serie, order, source = "simpress") => ({
    serie,
    relacao: order ? "conferida" : "sem_os",
    ordens_servico_conferidas: order ? [order] : [],
    simpress: { ordens_servico: source === "simpress" && order ? [order] : [] },
    oracle: order && source === "oracle" ? [{ ordem_servico: order, status: "Em execução" }] : [],
  });
  harness.context.ticketTestReport = {
    fontes: {},
    resumo: { series_total: 4, conferidas: 3, divergentes: 0, sem_os: 1, somente_simpress: 0, somente_oracle: 0 },
    chamados: [
      ticket("SN-7265402", "7265402"),
      ticket("SN-SEM-OS", ""),
      ticket("SN-7279280", "7279280", "oracle"),
      ticket("SN-7279287", "7279287"),
    ],
  };

  harness.run("acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");

  const serials = [...harness.element("lista-acompanhamento-chamados").innerHTML.matchAll(/data-ticket-serial="([^"]+)"/g)]
    .map(match => match[1]);
  assert.deepEqual(serials, ["SN-7279287", "SN-7279280", "SN-7265402", "SN-SEM-OS"]);
  assert.match(harness.element("contagem-acompanhamento-chamados").textContent, /OS da maior para a menor, sem OS no final/);
});

test("keeps the three-day attention rule and removes advanced ticket filters", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  assert.equal(harness.run('dataAtualizacaoChamado("2026-10-09").getDate()'), 9);
  assert.equal(harness.run('dataAtualizacaoChamado("2026-10-09T00:00:00Z").getDate()'), 9);
  assert.equal(harness.run('dataAtualizacaoChamado("09/10/2026").getMonth()'), 9);
  const expectedOracleUpdate = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" })
    .format(new Date(2026, 9, 9, 14, 15));
  assert.equal(harness.run('formatarHorarioHistorico("09/10/2026 14:15")'), expectedOracleUpdate);
  assert.equal(harness.run('formatarHorarioHistorico("2026-10-09")'), new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(2026, 9, 9)));
  const localDateOffset = days => {
    const value = new Date();
    value.setHours(12, 0, 0, 0);
    value.setDate(value.getDate() - days);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  };
  const fresh = localDateOffset(0);
  const exactlyThreeDaysOld = localDateOffset(3);
  assert.equal(harness.run('classificarAtencaoChamado({ oracle: [{ status: "Em execução", ultima_atualizacao: "' + exactlyThreeDaysOld + '" }] }, 30).em_atencao'), true);
  harness.context.ticketTestReport = {
    fontes: {},
    resumo: { series_total: 7, conferidas: 3, divergentes: 1, sem_os: 1, somente_simpress: 1, somente_oracle: 1 },
    chamados: [
      { serie: "SN-FRESCA", relacao: "conferida", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila A", ultima_atualizacao: fresh }] },
      { serie: "SN-ATRASADA", relacao: "conferida", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila B", ultima_atualizacao: "2000-01-01" }] },
      { serie: "SN-DIVERGENTE", relacao: "divergente", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila C", ultima_atualizacao: fresh }] },
      { serie: "SN-LIMITE-3-DIAS", relacao: "conferida", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila E", ultima_atualizacao: exactlyThreeDaysOld }] },
      { serie: "SN-SEM-OS", relacao: "sem_os", simpress: {}, oracle: [{ status: "Em execução", fila: "Fila F", ultima_atualizacao: fresh }] },
      { serie: "SN-SOMENTE-SIMPRESS", relacao: "somente_simpress", simpress: {}, oracle: [] },
      { serie: "SN-FECHADA", relacao: "conferida", simpress: {}, oracle: [{ status: "Concluído", fila: "Fila D", ultima_atualizacao: "2000-01-01" }] },
    ],
  };
  harness.run("acompanhamentoChamadosAtual = ticketTestReport");
  harness.run("renderizarAcompanhamentoChamados()");

  harness.element("somente-atencao-chamados").checked = true;
  harness.run("renderizarAcompanhamentoChamados()");
  const visible = harness.element("lista-acompanhamento-chamados").innerHTML;
  assert.match(visible, /SN-ATRASADA/);
  assert.match(visible, /SN-LIMITE-3-DIAS/);
  assert.doesNotMatch(visible, /SN-DIVERGENTE/);
  assert.doesNotMatch(visible, /SN-SEM-OS/);
  assert.doesNotMatch(visible, /SN-SOMENTE-SIMPRESS/);
  assert.doesNotMatch(visible, /SN-FRESCA/);
  assert.doesNotMatch(visible, /SN-FECHADA/);
  assert.match(appHtml, /id="versao-acompanhamento-chamados"/);
  assert.doesNotMatch(appHtml, /Filtros avançados|relacao-acompanhamento-chamados|status-acompanhamento-chamados|fila-acompanhamento-chamados|cidade-acompanhamento-chamados|atendimento-acompanhamento-chamados|idade-acompanhamento-chamados/);
  assert.match(appHtml, /id="triagem-diaria-acompanhamento-chamados"/);
  assert.doesNotMatch(appHtml, /id="limite-desatualizacao-chamados"/);
  assert.match(appHtml, /id="evolucao-acompanhamento-chamados"/);
  assert.match(appScript, /\/api\/operacoes\/chamados\/evolucao\?/);
});

test("keeps city, queue, and provider visible in ticket cards without advanced filters", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  harness.context.ticketTestReport = {
    fontes: {}, resumo: { series_total: 2 },
    chamados: [
      { serie: "SN-SIMPRESS", relacao: "conferida", simpress: { cidades_entrega: ["Curitiba"] }, oracle: [{ cidade: "Curitiba", nome_filial: "SIMPRESS - PR", fila: "Fila A", status: "Em execução", ultima_atualizacao: "2026-10-10" }] },
      { serie: "SN-PARCEIRO", relacao: "conferida", simpress: { cidades_entrega: ["Curitiba"] }, oracle: [{ cidade: "Maringá", nome_filial: "PARCEIRO", fila: "Fila B", status: "Em execução", ultima_atualizacao: "2026-10-10" }] },
    ],
  };
  harness.run("acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");

  const cards = harness.element("lista-acompanhamento-chamados").innerHTML;
  assert.match(cards, /SN-SIMPRESS/);
  assert.match(cards, /SN-PARCEIRO/);
  assert.match(cards, /Fila: Fila B/);
  assert.match(cards, /Cidade: [^<]*Maringá/);
  assert.match(cards, /Atendimento: Parceiro/);
  assert.match(harness.element("triagem-diaria-acompanhamento-chamados").innerHTML, /Chamados ativos/);
  assert.match(harness.element("triagem-diaria-acompanhamento-chamados").innerHTML, /3\+ dias/);
  assert.match(appScript, /carregarLinhaDoTempoChamado/);
  assert.match(appScript, /HistoryAnnotationAutosave\.attachAnnotationAutosave/);
});

test("clears the remaining ticket search and attention filters", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  harness.context.ticketTestReport = {
    fontes: {}, resumo: { series_total: 2 },
    chamados: [
      { serie: "SN-PRIMEIRA", relacao: "conferida", simpress: {}, oracle: [] },
      { serie: "SN-SEGUNDA", relacao: "conferida", simpress: {}, oracle: [] },
    ],
  };
  harness.run("acompanhamentoChamadosAtual = ticketTestReport; renderizarAcompanhamentoChamados()");
  harness.element("filtro-acompanhamento-chamados").value = "PRIMEIRA";
  harness.element("somente-atencao-chamados").checked = true;

  harness.run("limparFiltrosAcompanhamentoChamados()");

  assert.equal(harness.element("filtro-acompanhamento-chamados").value, "");
  assert.equal(harness.element("somente-atencao-chamados").checked, false);
  const cards = harness.element("lista-acompanhamento-chamados").innerHTML;
  assert.match(cards, /SN-PRIMEIRA/);
  assert.match(cards, /SN-SEGUNDA/);
});

test("renders ticket timeline changes and a 2000-character action note", () => {
  const harness = createAppHarness(async () => apiResponse({}));
  const html = harness.run('renderizarLinhaDoTempoChamado([{ snapshot_id: "import-1", item_id: "ticket-row-1", atualizado_em: "2026-10-10T10:00:00", tipo: "Dados alterados", estado: { pedidos_simpress: ["48076976"], solicitacoes_oracle: ["REQ-1"], ordens_servico_simpress: ["7279287"], ordens_servico_oracle: ["7279287"], status_oracle: ["Em execução"], atualizacoes_oracle: ["2026-10-10"] }, mudancas: [{ campo: "OS Simpress", anterior: ["7124895"], atual: ["7279287"] }], anotacao: "Acompanhar parceiro" }])');
  assert.match(html, /Pedido Simpress/);
  assert.match(html, /Solicitação Oracle/);
  assert.match(html, /OS Oracle/);
  assert.match(html, /7124895 → 7279287/);
  assert.match(html, /maxlength="2000"/);
  assert.match(html, /Acompanhar parceiro/);
});

test("exports the selected ticket snapshot with only the visible filters", async () => {
  const requests = [];
  const harness = createAppHarness(async url => {
    requests.push(url);
    return {
      ok: true,
      headers: { get: () => 'attachment; filename="Acompanhamento_de_Chamados.xlsx"' },
      blob: async () => ({}),
    };
  });
  harness.context.ticketTestReport = { snapshot_id: "version-1", resumo: {}, fontes: {}, chamados: [] };
  harness.run("acompanhamentoChamadosAtual = ticketTestReport");
  harness.element("filtro-acompanhamento-chamados").value = "SN-4";
  harness.element("somente-atencao-chamados").checked = true;

  await harness.run("exportarAcompanhamentoChamados()");

  assert.equal(requests.length, 1);
  assert.match(requests[0], /snapshot_id=version-1/);
  assert.match(requests[0], /search=SN-4/);
  assert.match(requests[0], /attention_only=true/);
  assert.doesNotMatch(requests[0], /relation=|status=|queue=|city=|provider=|age_filter=/);
  assert.equal(harness.effects.toasts[0].type, "success");
});

test("shows imported ticket versions and compares the selected snapshot with the prior import", async () => {
  const newer = { id: "version-2", atualizado_em: "2026-10-10T12:00:00Z", fontes: { simpress: "novo.xlsx", oracle: "novo-oracle.xlsx" }, resumo: {} };
  const older = { id: "version-1", atualizado_em: "2026-10-09T12:00:00Z", fontes: { simpress: "anterior.xlsx", oracle: "anterior-oracle.xlsx" }, resumo: {} };
  const report = {
    fontes: {}, resumo: { series_total: 1, conferidas: 1, divergentes: 0, sem_os: 0, somente_simpress: 0, somente_oracle: 0 },
    chamados: [{ serie: "DEMO-SN-001", relacao: "conferida", simpress: {}, oracle: [] }],
  };
  const current = { ...report, snapshot_id: newer.id, historico: [newer, older] };
  const latestOnly = {
    ...current,
    chamados: [{ serie: "DEMO-SN-RECENTE", relacao: "conferida", simpress: {}, oracle: [] }],
    historico: [newer],
  };
  let oldImportsDeleted = false;
  const requests = [];
  const harness = createAppHarness(async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    if (url === "/api/operacoes/chamados/historico/antigas" && options.method === "DELETE") {
      oldImportsDeleted = true;
      return apiResponse({ removidas: 1, total: 1 });
    }
    if (url === "/api/operacoes/chamados") return apiResponse(oldImportsDeleted ? latestOnly : current);
    if (url.startsWith("/api/operacoes/chamados/evolucao?")) return apiResponse({
      contagens: { novos: 1, alterados: 2, iguais: 3, ausentes_arquivo: 1 },
      mudancas: { novos: ["SN-NOVO"], alterados: [{ serie: "SN-ALTERADA", campos: [{ campo: "Status Oracle" }] }], ausentes_arquivo: ["SN-ANTIGA"] },
      aviso_ausentes: "Ausência na planilha atual não confirma que o chamado foi resolvido.",
    });
    if (url.endsWith(`/snapshot/${older.id}`)) return apiResponse({ ...report, snapshot_id: older.id });
    return apiResponse({ detail: "endpoint inesperado" }, { status: 404 });
  });

  await harness.run("carregarAcompanhamentoChamados()");

  const versions = harness.element("versao-acompanhamento-chamados");
  assert.equal(versions.children.length, 3);
  assert.equal(versions.value, newer.id);
  assert.equal(harness.element("btn-excluir-importacoes-antigas-chamados").disabled, false);
  assert.match(harness.element("evolucao-acompanhamento-chamados").innerHTML, /2 alteradas/);
  assert.match(harness.element("evolucao-acompanhamento-chamados").innerHTML, /SN-ANTIGA/);
  assert.ok(requests.some(({ url }) => url.includes("anterior=version-1") && url.includes("atual=version-2")));
  assert.match(appHtml, /<button[^>]*id="btn-excluir-importacoes-antigas-chamados"[^>]*>Excluir importações antigas/);

  versions.value = older.id;
  await harness.run("selecionarVersaoChamados()");
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /DEMO-SN-001/);
  assert.match(harness.element("evolucao-acompanhamento-chamados").textContent, /mais antiga/);
  assert.ok(requests.some(({ url }) => url.endsWith(`/snapshot/${older.id}`)));

  await harness.run("excluirImportacoesAntigasChamados()");
  assert.match(harness.effects.confirmations[0], /manter somente a mais recente/);
  assert.ok(requests.some(({ url, method }) => url === "/api/operacoes/chamados/historico/antigas" && method === "DELETE"));
  assert.equal(versions.children.length, 2);
  assert.equal(versions.value, newer.id);
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /DEMO-SN-RECENTE/);
  assert.equal(harness.element("btn-excluir-importacoes-antigas-chamados").disabled, true);
  assert.equal(harness.effects.toasts.at(-1).type, "success");
});

test("keeps old ticket imports when the deletion confirmation is cancelled", async () => {
  const requests = [];
  const harness = createAppHarness(async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    return apiResponse({});
  }, { confirmResult: false });
  harness.run('renderizarHistoricoAcompanhamentoChamados({ snapshot_id: "new", historico: [{ id: "new" }, { id: "old" }] })');

  await harness.run("excluirImportacoesAntigasChamados()");

  assert.equal(harness.effects.confirmations.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(harness.element("btn-excluir-importacoes-antigas-chamados").disabled, false);
});

test("groups secondary actions while keeping spreadsheet updates prominent", () => {
  assert.match(appHtml, /id="btn-atualizar-planilhas" class="header-action-item header-action-item--large header-action-item--primary/);
  assert.match(appHtml, /id="btn-atualizar-planilhas"[\s\S]*?<\/button>\s*<button[^>]*id="btn-exportar-equipamentos"/);
  assert.match(appHtml, /id="btn-exportar-equipamentos"[^>]*header-action-item--large[^>]*header-action-item--emerald/);
  assert.match(appHtml, /<details class="header-action-group" data-action-group="analysis">/);
  assert.doesNotMatch(appHtml, /data-action-group="equipment"|Equipamentos e cadastros/);

  const analysisGroup = appHtml.match(/<details class="header-action-group" data-action-group="analysis">([\s\S]*?)<\/details>/)?.[1] || "";
  assert.match(analysisGroup, /<span class="sidebar-item-label">Análises e históricos<\/span>/);
  assert.match(analysisGroup, /abrirCentralPendencias\(\)/);
  assert.match(analysisGroup, /abrirEvolucaoAtualizacoes\(\)/);
  assert.match(analysisGroup, /abrirModalHistoricoComparacoes\(\)/);
  assert.match(analysisGroup, /abrirModalHistoricoApelidos\(\)/);
  assert.match(analysisGroup, /abrirModalGerenciarUnidades\(\)/);
  assert.ok(analysisGroup.indexOf('id="btn-historico-comparacoes"') < analysisGroup.indexOf('onclick="abrirCentralPendencias()"'));
  assert.ok(analysisGroup.indexOf('onclick="abrirEvolucaoAtualizacoes()"') < analysisGroup.indexOf('id="btn-historico-apelidos"'));
  assert.ok(analysisGroup.indexOf('id="btn-historico-apelidos"') < analysisGroup.indexOf('label-catalogo-unidades'));
  assert.doesNotMatch(analysisGroup, /btn-exportar-equipamentos/);
  assert.match(appHtml, /onclick="abrirAcompanhamentoChamados\(\)"/);
  assert.doesNotMatch(appHtml, /Acompanhamento de transportes/);
  assert.doesNotMatch(appScript, /\/api\/transferencias/);
});
