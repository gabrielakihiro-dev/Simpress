const { test, expect } = require("@playwright/test");

// Transporte (F2): "Transporte" (#btn-gerar-planilha) downloads the file and then opens "Gerar ticket no UX";
// "Alterar Endereço" opens the same modal with only the série and the addresses, without any workbook.
// Every /api/ux/gerar-ticket/* call is stubbed here: no suite reaches the real ticket backend, Chrome or the UX.

const SESSION = "b".repeat(32);
const UNIDADE = {
  id: 7, cidade: "Cidade Teste", cep: "80000-000", cnpj: "11.111.111/0001-11",
  endereco_completo: "Rua Fictícia, 100 - Centro - Cidade Teste/PR",
};
const SOLICITANTE = { nome: "Pessoa Teste", email: "pessoa@exemplo.com", telefone: "(41) 90000-0000" };
const PREPARADO = {
  status: "preparado", session_id: SESSION, serial: "LENTO", modelo: "Notebook de demonstração", endereco: "Rua Fictícia, 100",
  opcoes_endereco: [], cnpj_instalacao: UNIDADE.cnpj, cnpj_faturamento: "75.110.585/0001-00",
  arquivo: "Transferencia_LENTO.xlsx", solicitante: SOLICITANTE, ultimo_envio: null,
};
const TRANSPORTE_INICIO = /^Prezados,\n\nSolicito o transporte do equipamento da unidade do Sebrae de .+ para a unidade do Sebrae de Cidade Teste/;
const TRANSPORTE_ENDERECOS = /\nEndereço para Retirada: \S.*\nEndereço para Entrega: Rua Fictícia, 100/;
const REGISTRO_OK = "Prezados,\n\nSolicito o deslocamento de um técnico.\n\nContato no local: Maria Teste\nColaborador(a) Novo(a): Fulano\nData de Instalação: 10/11/2026\nHorário da Instalação: 09h";

async function prepararTela(page, ticket, { contatos = true } = {}) {
  const chamadas = [];
  await page.route("**/api/unidades", route => route.fulfill({ json: [UNIDADE] }));
  await page.route("**/api/gerar-planilha", route => route.fulfill({
    status: 200, body: "planilha-ficticia",
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="Transferencia_LENTO.xlsx"',
    },
  }));
  await page.route("**/api/ux/gerar-ticket/**", async route => {
    const etapa = new URL(route.request().url()).pathname.split("/").pop();
    if (etapa === "solicitante") return route.fulfill({ json: SOLICITANTE });
    const corpo = route.request().postDataJSON();
    chamadas.push({ etapa, corpo });
    const [status, json] = ticket(etapa, corpo, chamadas);
    await route.fulfill({ status, json });
  });
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await page.locator("#input-serial").focus();
  await page.keyboard.press("F2");
  await expect(page.locator("#btn-gerar-planilha")).toBeVisible();
  await expect(page.locator("#btn-alterar-endereco")).toBeDisabled(); // no delivery address yet
  await page.evaluate(() => {
    const select = document.getElementById("select-unidade-destino");
    select.value = "7";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#entrega-cnpj")).toHaveText(UNIDADE.cnpj);
  const campos = {
    "retirada-contato": "Pessoa Retirada", "retirada-email": "retirada@exemplo.com", "retirada-telefone": "(41) 91111-1111",
    "retirada-obs": "Notebook + kit", "entrega-contato": "Maria Teste", "entrega-email": "entrega@exemplo.com",
    "entrega-telefone": "(41) 3333-0000", "entrega-obs": "Nova contratação",
  };
  if (contatos) for (const [id, valor] of Object.entries(campos)) await page.locator(`#${id}`).fill(valor);
  return chamadas;
}

async function gerarPlanilha(page) {
  const download = page.waitForEvent("download");
  await page.locator("#btn-gerar-planilha").click();
  expect((await download).suggestedFilename()).toBe("Transferencia_LENTO.xlsx");
  const modal = page.getByRole("dialog", { name: "Gerar ticket no UX" });
  await expect(modal).toBeVisible();
  return modal;
}

async function semRolagemHorizontal(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test("Transporte opens the ticket; an ambiguous address needs a choice; Simular and Finalizar stay separate", async ({ page }) => {
  const opcoes = ["Rua Fictícia, 100 - Centro", "Rua Fictícia, 100 - Batel"];
  const chamadas = await prepararTela(page, (etapa, corpo) => {
    if (etapa === "preparar") return [200, { ...PREPARADO, status: "endereco_ambiguo", endereco: "", opcoes_endereco: opcoes }];
    if (etapa === "escolher-endereco") return [200, { status: "preparado", session_id: SESSION, serial: "LENTO", endereco: corpo.endereco }];
    return [200, corpo.enviar ? { status: "enviado", ticket: "445566" } : { status: "preenchido" }];
  });
  const modal = await gerarPlanilha(page);
  expect(chamadas[0]).toEqual({ etapa: "preparar", corpo: expect.objectContaining({ serial: "LENTO", entrega_cep: "80000-000", entrega_contato: "Maria Teste" }) });
  expect(chamadas[0].corpo).not.toHaveProperty("conferido");
  await expect(modal.getByRole("status")).toContainText("Escolha o endereço");
  const registro = modal.getByLabel("Registro");
  // Default Registro = the F2 "Texto para Transporte" (same function as the button); Deslocamento stays in the Home (F1).
  await expect(registro).toHaveValue(TRANSPORTE_INICIO);
  await expect(registro).toHaveValue(TRANSPORTE_ENDERECOS);
  const textoTransporte = await registro.inputValue();
  await expect(modal.getByLabel("Nome", { exact: true })).toHaveValue(SOLICITANTE.nome);
  await semRolagemHorizontal(page);
  // Layout only (not a visual review): the open modal fits 320 to 2560 px in dark mode with reduced motion.
  const original = page.viewportSize();
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  for (const width of [320, 2560]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(modal).toBeVisible();
    await semRolagemHorizontal(page);
  }
  await page.setViewportSize(original);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });

  const simular = modal.getByRole("button", { name: "Simular preenchimento" });
  const finalizar = modal.getByRole("button", { name: "Revisar e finalizar" });
  await expect(simular).toBeDisabled();
  await expect(modal.getByRole("button", { name: "Confirmar endereço" })).toBeDisabled();
  await modal.getByLabel(opcoes[1]).check();
  await modal.getByRole("button", { name: "Confirmar endereço" }).click();
  await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
  expect(chamadas[1]).toEqual({ etapa: "escolher-endereco", corpo: { session_id: SESSION, serial: "LENTO", endereco: opcoes[1] } });

  // The default text is valid; an empty Registro, or one with a line ending in ":", stays blocked with a visible reason.
  await expect(simular).toBeEnabled();
  await registro.fill("");
  await expect(simular).toBeDisabled();
  await expect(modal.locator("#ux-ticket-motivo")).toHaveText("Preencha o Registro.");
  await registro.fill("Prezados,\nColaborador(a) Novo(a):");
  await expect(simular).toBeDisabled();
  await expect(modal.locator("#ux-ticket-motivo")).toContainText("terminam com “:”");
  await registro.fill(REGISTRO_OK);
  await expect(simular).toBeEnabled();

  await simular.click();
  await expect(modal.getByRole("status")).toContainText("Nenhum ticket foi enviado");
  expect(chamadas.at(-1).corpo).toMatchObject({ enviar: false, confirmado: false, descricao: REGISTRO_OK, solicitante: SOLICITANTE });

  await finalizar.click();
  const confirmacao = page.getByRole("dialog", { name: "Finalizar ticket no UX" });
  await expect(confirmacao).toContainText(opcoes[1]);
  expect(chamadas.filter(({ corpo }) => corpo.enviar === true)).toHaveLength(0);
  await confirmacao.getByRole("button", { name: "Finalizar ticket" }).click();
  await expect(modal.getByRole("status")).toContainText("Ticket nº 445566");
  expect(chamadas.filter(({ corpo }) => corpo.enviar === true).map(({ corpo }) => corpo)).toEqual([{
    session_id: SESSION, serial: "LENTO", descricao: REGISTRO_OK, solicitante: SOLICITANTE, chamado_interno: "", enviar: true, confirmado: true,
  }]);
  await expect(finalizar).toBeDisabled();
  await modal.getByRole("button", { name: "Fechar" }).click();
  await expect(modal).toBeHidden();
  expect(chamadas.map(({ etapa }) => etapa)).not.toContain("cancelar");
});

test("a failed /preparar keeps the download and shows the detail with only Preparar novamente", async ({ page }) => {
  const aviso = "Não foi possível abrir ou conectar o Chrome de automação. Feche as janelas desse Chrome e tente de novo.";
  const chamadas = await prepararTela(page, () => [503, { detail: aviso, codigo: "chrome_indisponivel" }]);
  const modal = await gerarPlanilha(page);
  await expect(modal.getByRole("alert")).toHaveText(aviso);
  await expect(page.locator("#toast-container")).toContainText("Planilha Exportada com Sucesso!");
  await expect(modal.getByRole("button", { name: "Simular preenchimento" })).toBeDisabled();
  await expect(modal.getByRole("button", { name: "Revisar e finalizar" })).toBeDisabled();
  await expect(modal.getByRole("button", { name: "Preparar novamente" })).toBeVisible();
  await page.waitForTimeout(300);
  expect(chamadas).toHaveLength(1); // no automatic retry
  await modal.getByRole("button", { name: "Preparar novamente" }).click();
  await expect.poll(() => chamadas.length).toBe(2);
  await semRolagemHorizontal(page);
});

test("ux_tentativas_esgotadas on Simular shows its detail; Cancelar calls /cancelar", async ({ page }) => {
  const aviso = "O UX não respondeu depois de 3 tentativas. Use Preparar novamente.";
  const chamadas = await prepararTela(page, etapa => {
    if (etapa === "enviar") return [503, { detail: aviso, codigo: "ux_tentativas_esgotadas" }];
    if (etapa === "cancelar") return [200, { status: "cancelado" }];
    return [200, PREPARADO];
  });
  const modal = await gerarPlanilha(page);
  await modal.getByLabel("Registro").fill(REGISTRO_OK);
  await modal.getByRole("button", { name: "Simular preenchimento" }).click();
  await expect(modal.getByRole("alert")).toHaveText(aviso);
  await expect(modal.getByRole("button", { name: "Preparar novamente" })).toBeVisible();
  await modal.getByRole("button", { name: "Cancelar" }).click();
  await expect(modal).toBeHidden();
  await expect.poll(() => chamadas.at(-1)).toEqual({ etapa: "cancelar", corpo: { session_id: SESSION } });
});

test("the unedited default Registro is the descricao sent to the UX ticket", async ({ page }) => {
  const chamadas = await prepararTela(page, (etapa, corpo) => [200, etapa === "preparar" ? PREPARADO : (corpo.enviar ? { status: "enviado", ticket: "1" } : { status: "preenchido" })]);
  const modal = await gerarPlanilha(page);
  await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
  const registro = modal.getByLabel("Registro");
  await expect(registro).toHaveValue(TRANSPORTE_ENDERECOS);
  const textoTransporte = await registro.inputValue();
  // Same function the F2 "Texto para Transporte" button uses.
  expect(await page.evaluate(() => window.montarTextoSolicitacaoTransporte().texto)).toBe(textoTransporte);
  await modal.getByRole("button", { name: "Simular preenchimento" }).click();
  await expect(modal.getByRole("status")).toContainText("Nenhum ticket foi enviado");
  expect(chamadas.at(-1)).toEqual({ etapa: "enviar", corpo: expect.objectContaining({ enviar: false, descricao: textoTransporte }) });
});

test("Texto para Transporte (F2) fills the request text with the pickup and delivery addresses", async ({ page }) => {
  const chamadas = await prepararTela(page, () => [200, PREPARADO]);
  await page.getByRole("button", { name: "Texto para Transporte" }).click();
  const texto = page.locator("#textarea-texto-transporte");
  await expect(page.locator("#modal-texto-transporte")).toBeVisible();
  await expect(texto).toBeFocused();
  await expect(texto).toHaveValue(/^Prezados,\n\nSolicito o transporte do equipamento da unidade do Sebrae de .+ para a unidade do Sebrae de Cidade Teste/);
  await expect(texto).toHaveValue(/\nEndereço para Retirada: \S.*\nEndereço para Entrega: Rua Fictícia, 100/);
  expect(chamadas).toEqual([]); // the text is local: no UX ticket call
  await page.getByRole("button", { name: "Fechar texto de solicitação" }).click();
  await expect(page.locator("#modal-texto-transporte")).toBeHidden();
});

test("Alterar Endereço lights up with only the série and both addresses and never builds the workbook", async ({ page }) => {
  const chamadas = await prepararTela(page, (etapa, corpo) => {
    if (etapa === "preparar-alterar-endereco") {
      return [200, { status: "preparado", tipo: "endereco", session_id: SESSION, serial: "LENTO", modelo: PREPARADO.modelo, solicitante: SOLICITANTE, ultimo_envio: null }];
    }
    return [200, corpo.enviar ? { status: "enviado", ticket: "445566" } : { status: "preenchido" }];
  }, { contatos: false });
  const planilhas = [];
  page.on("request", req => { if (req.url().includes("/api/gerar-planilha")) planilhas.push(req.url()); });
  const botoes = page.locator(".ck-acoes-barra button span");
  await expect(botoes.filter({ hasText: /^(Transporte|Alterar Endereço)$/ })).toHaveText(["Transporte", "Alterar Endereço"]);
  const alterar = page.locator("#btn-alterar-endereco");
  await expect(alterar).toBeEnabled(); // no representative name, phone or e-mail needed
  await alterar.click();
  const modal = page.getByRole("dialog", { name: "Alterar Endereço no UX" });
  await expect(modal).toBeVisible();
  expect(chamadas[0]).toEqual({ etapa: "preparar-alterar-endereco", corpo: { serial: "LENTO" } });
  await expect(modal.getByRole("status")).toContainText("Transferência Fisica de Equipamentos");
  const registro = modal.getByLabel("Registro");
  await expect(registro).toHaveValue(/^Prezados,\n\nSolicito apenas o endereço do equipamento da unidade do Sebrae Rua Fictícia, 100.* para \S.*\.$/);
  for (const id of ["#ux-ticket-cnpj-instalacao", "#ux-ticket-cnpj-faturamento", "#ux-ticket-anexo", "#ux-ticket-chamado-interno"]) {
    await expect(modal.locator(id)).toBeHidden();
  }
  await semRolagemHorizontal(page);

  await modal.getByRole("button", { name: "Simular preenchimento" }).click();
  await expect(modal.getByRole("status")).toContainText("Nenhum ticket foi enviado");
  expect(chamadas.at(-1)).toMatchObject({ etapa: "enviar", corpo: { enviar: false, confirmado: false, chamado_interno: "", solicitante: SOLICITANTE } });
  expect(planilhas).toEqual([]);
  expect(chamadas.filter(({ corpo }) => corpo.enviar === true)).toHaveLength(0);
});
