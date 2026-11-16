const test = require("node:test");
const {
  assert,
  appHtml,
  createAppHarness,
  apiResponse,
  priorEquipment,
} = require("./support/inventory-harness.cjs");

// Billing CNPJ comes from the client data of the installation (GET /api/config/transferencia), never from the code.
const CNPJ_FATURAMENTO_FICTICIO = "11.222.333/0001-81";

async function createHarnessWithClientData() {
  const harness = createAppHarness(async (url) => {
    if (url === "/api/config/transferencia") {
      return apiResponse({ contrato: "10101", cnpj_faturamento: CNPJ_FATURAMENTO_FICTICIO, cliente_configurado: true });
    }
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  await harness.run("carregarConfiguracaoTransferencia()");
  return harness;
}

// A restauração em si (prévia, confirmação, retentativa com a mesma chave, recusa) vive no React
// (frontend/src/paineis/historico-comparacoes/) e é testada no navegador: tests/e2e/react-g9.spec.cjs.
// Aqui fica só o que ela chama do código antigo: invalidar a seleção e os textos de transporte.
test("restoration invalidation clears old transfer data and the selected equipment", async () => {
  const harness = createAppHarness(async (url) => { throw new Error(`Chamada API inesperada: ${url}`); });
  harness.selectEquipment(priorEquipment);
  harness.element("textarea-resumo-preview").value = "Resumo antigo";
  harness.element("textarea-texto-transporte").value = "Transporte antigo";

  await harness.run("invalidarDadosEquipamentoAposRestauracao()");

  assert.equal(harness.run("SimpressApp.state.currentEquipamento"), null);
  assert.equal(harness.element("input-serial").value, "");
  assert.equal(harness.element("retirada-endereco").value, "");
  assert.equal(harness.element("textarea-resumo-preview").value, "");
  assert.equal(harness.element("textarea-texto-transporte").value, "");
});

test("copies the selected location postal code and installation CNPJ with the fixed billing CNPJ", async () => {
  const equipment = {
    ...priorEquipment,
    retirada_cep: "80000-123",
    retirada_cnpj: "12.345.678/0001-90",
  };
  const harness = await createHarnessWithClientData();
  harness.selectEquipment(equipment);
  harness.element("retirada-cnpj").value = equipment.retirada_cnpj;
  harness.element("retirada-endereco").value = `Rua da unidade, 10 - CEP ${equipment.retirada_cep}`;

  await harness.run('copiarDadoLocalAtual("cep")');
  await harness.run('copiarDadoLocalAtual("faturamento")');
  await harness.run('copiarDadoLocalAtual("instalacao")');

  assert.deepEqual(harness.effects.clipboardWrites, [
    "80000-123",
    CNPJ_FATURAMENTO_FICTICIO,
    "12.345.678/0001-90",
  ]);
  assert.deepEqual(harness.effects.toasts.map(({ type }) => type), ["success", "success", "success"]);
});

test("without client data the billing CNPJ is not copied and the user is sent to the client form", async () => {
  const harness = createAppHarness(async (url) => {
    if (url === "/api/config/transferencia") return apiResponse({ contrato: "", cnpj_faturamento: "", cliente_configurado: false });
    throw new Error(`Chamada API inesperada: ${url}`);
  });
  harness.context.workflowUnits = [{ id: 11, cidade: "Londrina", cnpj: "11.111.111/0001-11", endereco_completo: "Rua Alfa, 1" }];
  harness.run("SimpressApp.state.unidadesList = workflowUnits");
  await harness.run("carregarConfiguracaoTransferencia()");
  harness.element("select-unidade-destino").value = "11";

  await harness.run('copiarDadoLocalAtual("faturamento")');
  await harness.run('copiarDadoEntrega("faturamento")');

  assert.deepEqual(harness.effects.clipboardWrites, []);
  assert.deepEqual(harness.effects.toasts.map(({ type }) => type), ["warning", "warning"]);
  assert.match(harness.effects.toasts[0].message, /Configure os dados do cliente/);
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
  const harness = await createHarnessWithClientData();
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
    CNPJ_FATURAMENTO_FICTICIO,
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

test("keeps a transfer search when the user cancels the discard confirmation", async () => {
  const harness = createAppHarness(
    async () => { throw new Error("Nenhuma chamada de API esperada"); },
    { confirmResult: false },
  );
  harness.element("input-serial").value = "SERIE-EM-PESQUISA";

  await harness.run("resetarFormulario()");

  assert.equal(harness.element("input-serial").value, "SERIE-EM-PESQUISA");
  assert.equal(harness.effects.confirmations.length, 1);
  assert.equal(harness.effects.toasts.length, 0);
});
