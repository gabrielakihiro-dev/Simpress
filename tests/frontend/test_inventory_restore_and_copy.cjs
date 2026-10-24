const test = require("node:test");
const {
  assert,
  appHtml,
  FakeElement,
  createAppHarness,
  apiResponse,
  setButton,
  priorEquipment,
} = require("./support/inventory-harness.cjs");

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
  assert.equal(harness.run("SimpressApp.state.currentEquipamento"), null);
  assert.equal(harness.element("input-serial").value, "");
  assert.equal(harness.element("retirada-endereco").value, "");
  assert.equal(harness.element("textarea-resumo-preview").value, "");
  assert.equal(harness.element("textarea-texto-transporte").value, "");
  assert.deepEqual(harness.effects.refreshes, ["estatisticas", "unidades", "historico"]);
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

  assert.equal(harness.run("SimpressApp.state.currentEquipamento.serial"), "SERIE-ANTIGA");
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
  harness.run("SimpressApp.state.unidadesList = [workflowSede]; forcarSedePradoVelho()");

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
  harness.run("SimpressApp.state.unidadesList = workflowUnits");
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
    /<button\s+type="button"\s+id="btn-copiar-cnpj-instalacao-entrega"\s+disabled\s+data-on-click="copiarDadoEntrega" data-args='\["instalacao"\]'/
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
