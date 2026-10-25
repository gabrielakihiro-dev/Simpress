const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

async function openMonthlyReport(page) {
  await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-relatorio-mensal").click();
  const panel = page.locator('[data-cockpit-tool-panel="relatorio"]');
  await expect(panel).toBeVisible();
  await expect(page.locator("#cockpit-tool-title")).toBeFocused();
  return panel;
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function monthlyReport(month) {
  return {
    mes: { key: month, label: month === "2026-09" ? "setembro de 2026" : "outubro de 2026", parcial: month === currentMonth(), data_corte: "2026-10-25" },
    gerado_em: "2026-10-25T09:00:00-03:00",
    inventario: { total: 1284, unidades: 30, por_tipo: [["Notebook", 1200]], por_unidade: [["Curitiba Sede", "Prado Velho", 412], ["Londrina", "Centro", 168]] },
    comparacao: { atualizacoes_no_mes: 2, contagens: { "Sem correspondência — no endpoint": 23, "Sem correspondência — na Simpress": 15, "Localidade divergente": 18 }, linhas: [] },
    os: { oracle: { abertas: 3, concluidas: 2, pendentes: 1 }, simpress: { abertas: 4, concluidas: 3, pendentes: 1 }, linhas: [], dados_insuficientes: [] },
  };
}

test("the Cockpit report loads the selected month and keeps the existing XLSX download", async ({ page }) => {
  const requestedData = [];
  const requestedWorkbook = [];
  await page.route(/\/api\/relatorio-mensal\/dados(?:\?|$)/, async route => {
    const month = new URL(route.request().url()).searchParams.get("mes");
    requestedData.push(month);
    await route.fulfill({ status: 200, json: monthlyReport(month) });
  });
  await page.route(/\/api\/relatorio-mensal\?/, async route => {
    const month = new URL(route.request().url()).searchParams.get("mes");
    requestedWorkbook.push(month);
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      headers: { "Content-Disposition": 'attachment; filename="Relatorio-mensal-2026-09.xlsx"' },
      body: Buffer.from("fixture"),
    });
  });
  await page.goto("/");
  await openMonthlyReport(page);

  const month = page.locator("#cockpit-monthly-month");
  await expect(month).toHaveValue(currentMonth());
  await expect(month).toHaveAttribute("max", currentMonth());
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("Transportes solicitados: indisponível");

  await month.fill("2026-09");
  await expect(page.locator("#cockpit-monthly-status")).toContainText("Mês encerrado");
  const download = page.waitForEvent("download");
  await page.locator("#cockpit-monthly-export").click();
  expect((await download).suggestedFilename()).toBe("Relatorio-mensal-2026-09.xlsx");
  expect(requestedData).toContain("2026-09");
  expect(requestedWorkbook).toEqual(["2026-09"]);
  await expect(page.locator("#toast-container")).toContainText("Planilha Exportada com Sucesso!");
});

test("the Cockpit report shows local API errors in its status region", async ({ page }) => {
  await page.route("**/api/relatorio-mensal/dados**", route => route.fulfill({
    status: 503, json: { detail: "A base oficial EquipamentosDetalhes não está carregada." },
  }));
  await page.goto("/");
  await openMonthlyReport(page);
  await expect(page.locator("#cockpit-monthly-status")).toHaveText("A base oficial EquipamentosDetalhes não está carregada.");
  await expect(page.locator("#cockpit-monthly-export")).toBeEnabled();
});

test("the Cockpit report panel fits the screen and passes axe in both themes", async ({ page }) => {
  await page.goto("/");
  const panel = await openMonthlyReport(page);
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    expect(box.width).toBeGreaterThan(0);
    expect(box.width).toBeLessThanOrEqual(Math.max(1200, viewport.width));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="relatorio"]').analyze();
    expect(audit.violations.map(violation => violation.id), theme).toEqual([]);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
});


test("changing month clears the previous preview until the new response arrives", async ({ page }) => {
  let release;
  await page.route("**/api/relatorio-mensal/dados**", async route => {
    const month = new URL(route.request().url()).searchParams.get("mes");
    if (month === "2026-09") await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: monthlyReport(month) });
  });
  await page.goto("/");
  await openMonthlyReport(page);
  await expect(page.locator("#cockpit-monthly-copy")).toBeEnabled();
  await page.locator("#cockpit-monthly-month").fill("2026-09");
  await expect(page.locator("#cockpit-monthly-copy")).toBeDisabled();
  await expect(page.locator("#cockpit-monthly-preview")).toBeEmpty();
  await expect.poll(() => typeof release).toBe("function");
  release();
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("setembro de 2026");
  await expect(page.locator("#cockpit-monthly-copy")).toBeEnabled();
});
