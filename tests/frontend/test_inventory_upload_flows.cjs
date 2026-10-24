const test = require("node:test");
const {
  assert,
  createAppHarness,
  apiResponse,
  setButton,
  priorEquipment,
} = require("./support/inventory-harness.cjs");

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
  assert.equal(harness.run("SimpressApp.state.currentEquipamento.modelo"), "Modelo atualizado");
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

test("history and comparison exports use the approved success confirmation", async () => {
  const requests = [];
  const harness = createAppHarness(async url => {
    requests.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'attachment; filename="Historico_Planilhas_20261009.xlsx"' },
      blob: async () => ({}),
    };
  });
  harness.element("data-exportar-historico-comparacoes").value = "2026-10-09";
  harness.element("btn-exportar-resultado-comparacao").dataset.historyDate = "2026-10-09";

  await harness.run("exportarHistoricoComparacoesExcel()");
  await harness.run("exportarResultadoComparacaoPlanilhas()");

  assert.deepEqual(requests, [
    "/api/historico-comparacoes/exportar/excel?data=2026-10-09",
    "/api/historico-comparacoes/exportar/excel?data=2026-10-09",
  ]);
  assert.equal(harness.effects.toasts.length, 2);
  harness.effects.toasts.forEach(toast => {
    assert.equal(toast.message, "Planilha Exportada com Sucesso!");
    assert.equal(toast.type, "success");
  });
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
  assert.equal(harness.effects.toasts.at(-1).message, "Planilha Exportada com Sucesso!");
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

  assert.equal(harness.run("SimpressApp.state.currentEquipamento.serial"), "SERIE-ANTIGA");
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
  assert.equal(harness.run("SimpressApp.state.previaPlanilhasAtual"), null);
  assert.equal(harness.element("btn-confirmar-planilhas").classList.contains("hidden"), true);
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

  assert.equal(harness.run("SimpressApp.state.currentEquipamento"), null);
  assert.equal(harness.element("input-serial").value, "");
  assert.equal(harness.element("retirada-endereco").value, "");
  assert.equal(harness.element("card-equipamento").classList.contains("hidden"), true);
  assert.equal(harness.run('window.SimpressTransferUtils.serialForTransfer(SimpressApp.state.currentEquipamento, document.getElementById("input-serial").value)'), "");
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
  assert.equal(harness.run("SimpressApp.state.currentEquipamento"), null);
  assert.equal(harness.element("retirada-endereco").value, "");

  harness.element("input-serial").value = "SERIE-NOVA";
  await harness.run("buscarSerial()");
  assert.equal(refreshSignal.aborted, true);
  resolveRefresh(apiResponse({ ...priorEquipment, modelo: "Resposta atrasada" }));
  await upload;

  assert.equal(harness.run("SimpressApp.state.currentEquipamento.serial"), "SERIE-NOVA");
  assert.equal(harness.run("SimpressApp.state.currentEquipamento.modelo"), "Busca atual");
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

  assert.equal(harness.run("SimpressApp.state.currentEquipamento.serial"), "SERIE-NOVA");
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

  assert.equal(harness.run("SimpressApp.state.currentEquipamento.serial"), "SERIE-NOVA");
  assert.equal(harness.element("input-serial").value, "SERIE-NOVA");
  assert.equal(harness.element("retirada-endereco").value, "Rua nova, 20");
  assert.equal(harness.effects.toasts.at(-1).type, "success");
});
