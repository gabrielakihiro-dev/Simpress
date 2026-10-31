const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

function readiness(ready = false) {
  const status = { available: ready, state: ready ? "ready" : "awaiting_import", missing_files: ready ? [] : ["Importe os arquivos necessários"] };
  return {
    backend: "files",
    functions: Object.fromEntries([
      "consulta_equipamentos", "geracao_transferencia", "comparacao_atualizacao_inventarios",
      "exportacao_equipamentos", "acompanhamento_chamados",
    ].map(key => [key, status])),
    files: {
      inventario_equipamentos: { ...status, file: "EquipamentosDetalhes_atual.xlsx", reason: ready ? "OK" : "ausente" },
      inventario_detalhes_atualizacao: { ...status, file: "EquipamentosDetalhes_atual.xlsx", reason: ready ? "OK" : "ausente" },
      inventario_endpoint: { ...status, file: "InvAllComputersSummary_atual.xlsx", reason: ready ? "OK" : "ausente" },
      template_transferencia: { ...status, file: "modelo_transferencia.xlsx", reason: ready ? "OK" : "ausente" },
      modelo_exportacao: { ...status, file: "modelo_exportacao.xlsx", reason: ready ? "OK" : "ausente" },
      catalogos_locais: { available: true, state: "ready", reason: "OK", file: "catálogos e históricos JSON" },
      historico_chamados: { ...status, file: "historico_chamados.json", reason: ready ? "OK" : "ausente" },
      nomes_entra: { ...status, file: "usuarios_entra.json", reason: ready ? "OK" : "aguardando a primeira importação" },
    },
  };
}

async function mockReadiness(page, getReport) {
  await page.route("**/api/prontidao", route => route.fulfill({ json: getReport() }));
}

async function openStatus(page) {
  const toggle = page.locator("#cockpit-bar-status-toggle");
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

test("first access centralizes the inventory import and keeps calls separate", async ({ page }) => {
  test.setTimeout(45_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockReadiness(page, () => readiness());
  const readinessResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/prontidao", { timeout: 20_000 });
  await page.goto("/");
  const readinessResponse = await readinessResponsePromise;
  expect(readinessResponse.status()).toBe(200);
  const panel = page.locator("#readiness-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
  await expect(page.locator("#readiness-summary")).toContainText("Nenhum dos 5 arquivos está disponível");
  // The panel starts as a compact disclosure on every screen.
  const statusToggle = page.locator("#cockpit-bar-status-toggle");
  if (await statusToggle.isVisible()) await statusToggle.click();
  await expect(panel).not.toHaveAttribute("open", "");
  await expect(page.locator("#readiness-summary-short")).toBeVisible();
  await expect(page.locator("#readiness-summary-short")).toHaveText("5 pendentes");
  expect((await page.locator("#readiness-panel > summary").boundingBox()).height).toBeLessThanOrEqual(48);
  await panel.locator(":scope > summary").click();
  await expect(panel).toHaveAttribute("open", "");
  await expect(page.locator("#readiness-summary-short")).toBeVisible();
  await expect(panel.getByRole("button", { name: /Importar/ })).toHaveCount(3);
  await expect(panel).not.toContainText("Catálogos e históricos locais");
  await expect(panel.getByRole("heading", { name: "Ações com inventário" })).toHaveCount(0);
  await expect(panel.locator(".ck-pront__titulo", { hasText: "Modelo de exportação" })).toBeVisible();
  await expect(panel.locator("#readiness-details-content")).toBeVisible();
  await expect(panel.locator(".ck-pront__titulo", { hasText: /^OS$/ })).toBeVisible();
  await expect(page.locator("#readiness-panel > summary")).toHaveCSS("display", "flex");
  await expect(panel).toHaveAccessibleName("Disponibilidade das funções");
  await expect(page.locator(".ck-pront__item").first()).toHaveCSS("display", "grid");
  await expect(panel.getByRole("button", { name: "Cadastrar regionais" })).toBeVisible();
  const audit = await new AxeBuilder({ page }).include("#readiness-panel")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(audit.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await panel.getByRole("button", { name: "Importar/atualizar inventários Simpress e Endpoint", exact: true }).click();
  await expect(page.locator("#upload-endpoint-file")).toBeFocused();
  await expect(page.locator("#upload-details-file")).toHaveAttribute("accept", /\.zip/);
  await expect(page.locator("#modal-atualizar-planilhas .ckp-sistemas")).toHaveCSS("display", "flex");
  await expect(page.locator("#btn-previsualizar-planilhas")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-atualizar-planilhas")).toBeHidden();

  await expect(panel.getByRole("button", { name: "Importar modelo — Modelo de transferência", exact: true })).toHaveCount(0);
  await openStatus(page);
  const ticketGroup = panel.locator(".ck-pront__item").filter({ has: page.locator(".ck-pront__titulo", { hasText: /^OS$/ }) });
  await ticketGroup.getByRole("button", { name: "Importar planilhas na aba OS", exact: true }).click();
  await expect(page.locator('[data-cockpit-tool-panel="chamados"]')).toBeVisible();
  await expect(page.locator("#cockpit-tickets-manage-panel")).toHaveAttribute("open", "");
  await expect(page.locator("#cockpit-tickets-file-simpress")).toBeFocused();
  await expect(page.locator("#modal-acompanhamento-chamados")).toHaveCount(0);

  await expect(panel.locator(".ck-pront__item").filter({ hasText: "Microsoft Entra" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("available local files still show five items and the inventory import", async ({ page }) => {
  await mockReadiness(page, () => readiness(true));
  await page.goto("/");
  const panel = page.locator("#readiness-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#readiness-summary")).toHaveText("Todos os 5 arquivos estão disponíveis.");
  await openStatus(page);
  await panel.locator("summary").click();
  await expect(panel.getByRole("button", { name: "Importar/atualizar inventários Simpress e Endpoint" })).toHaveCount(1);
});


test("model import handles failure and refreshes availability after success", async ({ page }) => {
  let ready = false;
  let calls = 0;
  await mockReadiness(page, () => readiness(ready));
  await page.route("**/api/modelos/exportacao/importar", async route => {
    calls += 1;
    expect(route.request().postData()).toContain('filename="modelo.xlsx"');
    if (calls === 1) return route.fulfill({ status: 400, json: { detail: "Modelo incompatível com a base." } });
    ready = true;
    return route.fulfill({ json: { sucesso: true } });
  });
  await page.goto("/");
  await expect(page.locator("#readiness-panel")).toHaveAttribute("aria-busy", "false");
  await openStatus(page);
  await page.locator("#readiness-panel > summary").click();
  const exportModelGroup = page.locator(".ck-pront__item").filter({ hasText: "Modelo de exportação" });
  await expect(exportModelGroup).toBeVisible();
  await exportModelGroup.getByRole("button", { name: "Importar modelo de exportação", exact: true }).click();
  const chooseFileButton = page.locator("label.ckp-arquivo", { has: page.locator("#arquivo-modelo-local") });
  await expect(chooseFileButton).toBeVisible();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await chooseFileButton.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: "modelo.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("synthetic browser upload; backend validation is tested in Python") });
  await expect(page.locator("#nome-arquivo-modelo-local")).toHaveText("modelo.xlsx");
  await page.locator("#btn-importar-modelo").click();
  await expect(page.locator("#status-modelo-local")).toHaveText("Modelo incompatível com a base.");
  await expect(page.locator("#btn-importar-modelo")).toBeEnabled();
  await page.locator("#btn-importar-modelo").click();
  await expect(page.locator("#readiness-summary")).toHaveText("Todos os 5 arquivos estão disponíveis.");
  await expect(page.locator("#status-modelo-local")).toContainText("Modelo importado");
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-importar-modelo")).toBeHidden();
  await openStatus(page);
  await expect(page.locator("#readiness-panel").getByRole("button", { name: /Importar/ })).toHaveCount(3);
});

test("ready setup starts collapsed and uses one disclosure for the availability panel", async ({ page }) => {
  test.setTimeout(45_000);
  await mockReadiness(page, () => readiness(true));
  const readinessResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/prontidao", { timeout: 20_000 });
  await page.goto("/");
  const readinessResponse = await readinessResponsePromise;
  expect(readinessResponse.status()).toBe(200);
  const panel = page.locator("#readiness-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });
  await openStatus(page);
  await expect(page.locator("#readiness-summary")).toContainText("Todos os 5 arquivos");
  await expect(panel).not.toHaveAttribute("open", "");
  await panel.locator(":scope > summary").click();
  await expect(panel).toHaveAttribute("open", "");
  await expect(panel.getByRole("button", { name: /Importar/ })).toHaveCount(3);
  await panel.locator(":scope > summary").click();
  await expect(panel).not.toHaveAttribute("open", "");
});

test("an older readiness response cannot overwrite or clear the newer request", async ({ page }) => {
  await mockReadiness(page, () => readiness(true));
  await page.goto("/");
  const panel = page.locator("#readiness-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  await expect(panel).toHaveAttribute("data-state", "ready");
  await page.unroute("**/api/prontidao");

  let releaseOld;
  let releaseLatest;
  let notifyOld;
  let notifyLatest;
  const oldStarted = new Promise(resolve => { notifyOld = resolve; });
  const latestStarted = new Promise(resolve => { notifyLatest = resolve; });
  let calls = 0;
  await page.route("**/api/prontidao", async route => {
    calls += 1;
    if (calls === 1) {
      notifyOld();
      await new Promise(resolve => { releaseOld = resolve; });
      await route.fulfill({ json: readiness(false) }).catch(() => {});
      return;
    }
    notifyLatest();
    await new Promise(resolve => { releaseLatest = resolve; });
    await route.fulfill({ json: readiness(true) }).catch(() => {});
  });

  try {
    await page.evaluate(() => { window.oldReadinessRequest = carregarProntidao(); });
    await oldStarted;
    await page.evaluate(() => { window.latestReadinessRequest = carregarProntidao(); });
    await latestStarted;
    releaseOld();
    await page.evaluate(() => window.oldReadinessRequest);
    await expect(panel).toHaveAttribute("aria-busy", "true");
    await expect(panel).toHaveAttribute("data-state", "ready");

    releaseLatest();
    await page.evaluate(() => window.latestReadinessRequest);
    await expect(panel).toHaveAttribute("aria-busy", "false");
    await expect(panel).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#readiness-summary")).toContainText("Todos os 5 arquivos estão disponíveis");
  } finally {
    releaseOld?.();
    releaseLatest?.();
  }
});

test("Cadastrar regionais abre o painel Catálogo de unidades com o formulário vazio", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockReadiness(page, () => readiness());
  await page.route("**/api/unidades", route => route.fulfill({ json: [] }));
  await page.goto("/");
  await expect(page.locator("#readiness-panel")).toHaveAttribute("aria-busy", "false");
  await openStatus(page);
  await page.locator("#readiness-panel > summary").click();
  const cadastrar = page.locator("#readiness-panel").getByRole("button", { name: "Cadastrar regionais" });
  await cadastrar.click();
  await expect(page.locator('[data-cockpit-tool-panel="unidades"]')).toBeVisible();
  await expect(page.locator("#modal-gerenciar-unidades")).toHaveCount(0);
  await expect(page.locator("#form-nova-unidade")).toBeVisible();
  await expect(page.locator("#form-unidade-titulo")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
  // Contrato compartilhado por todas as ferramentas: o foco volta ao gatilho do menu Ferramentas (não ao botão da Home).
  await expect(page.locator("#cockpit-tools-trigger")).toBeFocused();
  expect(errors).toEqual([]);
});
