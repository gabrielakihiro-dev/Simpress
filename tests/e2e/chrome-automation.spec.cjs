const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// The fixture answers the Automação routes with fictional runs; no process or Chrome is started.
async function openAutomation(page, request) {
  await request.get("/__fixture_automacao");
  await page.goto("/");
  const sidebarButton = page.locator("#btn-sidebar-open");
  const shell = page.locator("#simpress-app-shell");
  if (await sidebarButton.isVisible() && await shell.getAttribute("data-sidebar-open") !== "true") {
    await sidebarButton.click();
    await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  }
  await page.locator("#tab-automacao").click();
  const panel = page.locator("#tab-panel-automacao");
  await expect(panel).toBeVisible();
  await expect(page.locator("#tab-automacao")).toHaveAttribute("aria-selected", "true");
  return panel;
}

test("Automação starts a routine, shows the login warning and the live log, then cancels", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  const status = panel.locator("#automacao-estado");
  const cancel = panel.getByRole("button", { name: "Cancelar" });
  await expect(status).toContainText("Livre");
  await expect(status).toContainText("Última execução: Inventários, Concluído");
  await expect(cancel).toBeDisabled();
  await expect(panel.locator("#automacao-aviso-login")).toBeHidden();

  const started = page.waitForRequest(req => req.url().endsWith("/api/automacao/executar") && req.method() === "POST");
  await panel.getByRole("button", { name: "Rotina de OS" }).click();
  expect((await started).postDataJSON()).toEqual({ rotina: "os" });

  await expect(status).toContainText("Em andamento");
  await expect(status).toContainText("Rotina de OS");
  await expect(status).toContainText("pelo site");
  const warning = panel.getByRole("alert");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Faça o login no Chrome de automação (Oracle).");
  await expect(panel.getByRole("log")).toContainText("AÇÃO NECESSÁRIA: faça o login");
  for (const name of ["Rotina de OS", "Inventários", "Ambas", "Abrir Chrome para login"]) {
    await expect(panel.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await expect(cancel).toBeEnabled();

  await cancel.click();
  await expect(page.locator("#toast-container")).toContainText("O Chrome de automação continua aberto.");
  await expect(status).toContainText("Livre");
  await expect(warning).toBeHidden();
  await expect(panel.getByRole("button", { name: "Inventários", exact: true })).toBeEnabled();
  await expect(cancel).toBeDisabled();
  const firstRow = panel.locator("#automacao-historico tbody tr").first();
  await expect(firstRow).toContainText("Rotina de OS");
  await expect(firstRow).toContainText("Cancelado");
});

test("Automação shows the 409 message when another run is in progress", async ({ page, request }) => {
  await page.route("**/api/automacao/executar", route => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ detail: "Já há uma rotina em andamento: Inventários desde 07:30. Aguarde terminar ou cancele." }),
  }));
  const panel = await openAutomation(page, request);
  await panel.getByRole("button", { name: "Ambas" }).click();
  await expect(page.locator("#toast-container")).toContainText("Já há uma rotina em andamento: Inventários desde 07:30.");
  await expect(panel.getByRole("button", { name: "Ambas" })).toBeEnabled();
});

test("Automação history lists status, batches and capture links, and passes the accessibility audit", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  const history = panel.locator("#automacao-historico");
  const rows = history.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Concluído");
  await expect(rows.nth(0)).toContainText("lote-demo-001");
  await expect(rows.nth(0)).toContainText("6 min 30 s");
  await expect(rows.nth(1)).toContainText("fora do site");
  await expect(rows.nth(1)).toContainText("Falha");
  await expect(rows.nth(1)).toContainText("Login não concluído em 10 minutos.");
  const capture = rows.nth(1).getByRole("link", { name: "20261019_170210_Oracle.png" });
  await expect(capture).toHaveAttribute("href", "/api/automacao/capturas/20261019_170210_Oracle.png");
  await expect(capture).toHaveAttribute("target", "_blank");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).include("#tab-panel-automacao")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map(violation => violation.id)).toEqual([]);
});
