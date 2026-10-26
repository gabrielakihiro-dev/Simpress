const { test, expect } = require("@playwright/test");

test("Cockpit keeps one global search and one complete readiness disclosure", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".ck-busca #input-serial")).toHaveCount(1);
  await expect(page.locator("#btn-buscar-serial")).toBeVisible();
  for (const id of [
    "readiness-panel",
    "readiness-title",
    "readiness-summary",
    "readiness-summary-short",
    "readiness-details-content",
  ]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
});

test("Home loads the real first page and derives its total from the API", async ({ page }) => {
  const listRequest = page.waitForRequest(request =>
    new URL(request.url()).pathname === "/api/buscar-expandida"
      && new URL(request.url()).searchParams.get("listar_todos") === "true");
  await page.goto("/");

  const request = await listRequest;
  expect(new URL(request.url()).searchParams.get("limit")).toBe("50");
  await expect(page.locator("#home-filter-total")).toHaveText("1");
  await expect(page.locator("#home-equipment-list [role=option]")).toHaveCount(1);
  await expect(page.locator("#home-equipment-list")).toContainText("LENTO");
});

test("Resumo uses the latest comparison and opens its series in Home", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  try {
    await page.goto("/");
    await page.locator("#tab-resumo").click();

    const locality = page.locator('#cockpit-summary-kpis [data-metric="divergencias_local"]');
    await expect(locality.locator(".ck-kpi__valor")).toHaveText("1");
    await expect(page.locator("#cockpit-summary-rows tr")).toHaveCount(1);
    await expect(page.locator("#cockpit-summary-rows")).toContainText("LENTO");
    await expect(page.locator("#cockpit-summary-rows tr").first().locator("td").nth(2)).toHaveText("Londrina");
    await expect(page.locator("#cockpit-summary-rows tr").first().locator("td").nth(3)).toHaveText("Curitiba");
    await expect(page.locator("#cockpit-summary-region-list")).toContainText("Curitiba");

    await page.locator('#cockpit-summary-kpis [data-metric="total"]').click();
    await expect(page.locator("#cockpit-summary-rows tr")).toHaveCount(1);
    await expect(page.locator("#cockpit-summary-rows")).toContainText("Na base local");
    await expect(page.locator("#cockpit-summary-count")).toHaveText("Mostrando 1–1 de 1");

    await page.locator('#cockpit-summary-kpis [data-metric="sincronizados"]').click();
    await expect(page.locator('#cockpit-summary-kpis [data-metric="sincronizados"] .ck-kpi__valor')).toHaveText("0");
    await expect(page.locator("#cockpit-summary-rows tr")).toHaveCount(0);
    await expect(page.locator("#cockpit-summary-status")).toContainText("lista detalhada não é armazenada");

    await page.locator('#cockpit-summary-kpis [data-metric="sem_acesso_7_dias"]').click();
    await expect(page.locator("#cockpit-summary-table-title")).toHaveText("Sem acesso há 7+ dias · 1");
    await expect(page.locator("#cockpit-summary-rows")).toContainText("9 dias");
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

test("Cockpit never scrolls horizontally in narrow or wide windows", async ({ page }) => {
  await page.goto("/");
  for (const width of [320, 390, 768, 1199, 1200, 1440, 2560]) {
    await page.setViewportSize({ width, height: 844 });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document, `document at ${width}px`).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body, `body at ${width}px`).toBeLessThanOrEqual(dimensions.viewport);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#cockpit-tools-trigger").click();
  await expect(page.locator("#btn-relatorio-mensal")).toBeVisible();
});
