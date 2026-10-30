const test = require("node:test");
const {
  assert,
  appHtml,
  appCss,
  createAppHarness,
  apiResponse,
} = require("./support/inventory-harness.cjs");

test("stale-access report sorts by inactivity, shows its reference time, and signals horizontal scrolling", () => {
  const harness = createAppHarness(async () => apiResponse({}), { stubDisplay: false });
  const referenceTime = "2026-09-30T15:00:00-03:00";
  harness.context.workflowComparison = {
    horario_comparacao: referenceTime,
    sem_acesso_7_dias: [
      { computador: "PRNOTE-14", dias_sem_verificacao: 14 },
      { computador: "PRNOTE-40", dias_sem_verificacao: 40 },
    ],
  };

  harness.run("renderizarResultadoComparacao(workflowComparison)");

  const html = harness.element("comparacao-planilhas-conteudo").innerHTML;
  assert.ok(html.indexOf("PRNOTE-40") < html.indexOf("PRNOTE-14"));
  const formattedReferenceTime = harness.run(`formatarHorarioHistorico(${JSON.stringify(referenceTime)})`);
  assert.ok(html.includes(`Atualização usada como referência: <time datetime="${referenceTime}">${formattedReferenceTime}</time>.`));
  assert.ok(html.includes("Role a tabela horizontalmente para consultar todas as colunas."));
  assert.match(appCss, /\.accessible-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(appCss, /:root :focus-visible\s*\{/);
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
  harness.run("SimpressApp.state.unidadesList = workflowUnits");
  harness.context.workflowSearchItem = equipment;

  await harness.run("selecionarItemAutocomplete(workflowSearchItem)");
  // Home also reads the open tickets of the selected series (Chamados abertos).
  assert.deepEqual(calls, [`/api/equipamento/${equipment.serial}`, "/api/operacoes/chamados"]);
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
  assert.equal(harness.element("transfer-serial").textContent, "");
  assert.equal(harness.element("btn-copiar-serie").disabled, true);

  harness.selectEquipment({ serial: "brj5512fgd", modelo: "HP 640 G11", tipo: "Notebook" });
  harness.run('ativarAbaTransferencia("transferencia")');
  assert.equal(harness.element("transfer-serial").textContent, "BRJ5512FGD");
  assert.equal(harness.element("transfer-equipment-banner").dataset.state, "selected");
  assert.equal(harness.element("transfer-equipment-description").textContent, "HP 640 G11 · Notebook");
  assert.match(appHtml, /<span id="transfer-serial-status">Copiar<\/span>/);
  assert.equal(harness.element("btn-copiar-serie").disabled, false);
});

test("the empty transfer banner offers a real button that opens Home and focuses equipment search", () => {
  assert.match(appHtml, /<button[^>]*id="btn-pesquisar-equipamento-home"[^>]*data-on-click="abrirHomeParaPesquisarEquipamento"[^>]*data-show="empty"/);
  assert.match(appHtml, /<span id="transfer-serial"/);
  assert.doesNotMatch(appHtml, /<input[^>]*id="transfer-serial"/);
  assert.match(appHtml, /id="btn-copiar-serie"[^>]*aria-label="Copiar série"/);
  const ckCss = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "static", "styles", "ck-cockpit.css"), "utf8");
  assert.match(ckCss, /\.ck-selecionado\[data-state="empty"\] \[data-show="selected"\]/);
  assert.match(ckCss, /\.ck-selecionado\[data-state="selected"\] \[data-show="empty"\] \{ display: none; \}/);
  const banner = appHtml.slice(appHtml.indexOf('id="transfer-equipment-banner"'), appHtml.indexOf('class="ck-passos"'));
  assert.match(banner, /id="btn-historico-transferencias"/);

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

test("the Home search action does nothing while a serial is selected", () => {
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
