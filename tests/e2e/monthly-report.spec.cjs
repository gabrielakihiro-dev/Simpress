const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

async function openMonthlyReport(page) {
  const sidebarButton = page.locator("#btn-sidebar-open");
  const shell = page.locator("#simpress-app-shell");
  if (await sidebarButton.isVisible() && await shell.getAttribute("data-sidebar-open") !== "true") {
    await sidebarButton.click();
    await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  }
  const group = page.locator('.header-action-group[data-action-group="analysis"]');
  if (!(await group.evaluate(element => element.open))) await group.locator("> summary").click();
  await page.locator("#btn-relatorio-mensal").click();
  const dialog = page.getByRole("dialog", { name: "Relatório mensal" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

test("the monthly report downloads the chosen month and confirms with the approved text", async ({ page }) => {
  const requested = [];
  await page.route("**/api/relatorio-mensal**", async route => {
    requested.push(new URL(route.request().url()).searchParams.get("mes"));
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      headers: { "Content-Disposition": 'attachment; filename="Relatorio-mensal-2026-09.xlsx"' },
      body: Buffer.from("fixture"),
    });
  });
  await page.goto("/");
  await openMonthlyReport(page);

  const month = page.locator("#relatorio-mensal-mes");
  await expect(month).toBeFocused();
  await expect(month).toHaveValue(currentMonth());
  await expect(month).toHaveAttribute("max", currentMonth());

  await month.fill("2026-09");
  const download = page.waitForEvent("download");
  await page.locator("#btn-exportar-relatorio-mensal").click();
  expect((await download).suggestedFilename()).toBe("Relatorio-mensal-2026-09.xlsx");
  expect(requested).toEqual(["2026-09"]);
  await expect(page.locator("#toast-container")).toContainText("Planilha Exportada com Sucesso!");
  await expect(page.locator("#status-relatorio-mensal")).toHaveText("");
});

test("the monthly report shows API errors in the dialog", async ({ page }) => {
  await page.route("**/api/relatorio-mensal**", route => route.fulfill({
    status: 503, json: { detail: "A base oficial EquipamentosDetalhes não está carregada." },
  }));
  await page.goto("/");
  await openMonthlyReport(page);
  await page.locator("#btn-exportar-relatorio-mensal").click();
  await expect(page.locator("#status-relatorio-mensal")).toHaveText("A base oficial EquipamentosDetalhes não está carregada.");
  await expect(page.locator("#btn-exportar-relatorio-mensal")).toBeEnabled();
});

test("the monthly report dialog fits the screen and passes axe in both themes", async ({ page }) => {
  await page.goto("/");
  const dialog = await openMonthlyReport(page);
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(15);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 15);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const audit = await new AxeBuilder({ page }).include("#modal-relatorio-mensal").analyze();
    expect(audit.violations.map(violation => violation.id), theme).toEqual([]);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
