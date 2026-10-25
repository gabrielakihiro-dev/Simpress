const { test, expect } = require("@playwright/test");

test("Cockpit keeps one global search and one complete readiness disclosure", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".cockpit-bar__search #input-serial")).toHaveCount(1);
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
    await expect(locality.locator(".cockpit-summary-kpi-value")).toHaveText("1");
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
    await expect(page.locator('#cockpit-summary-kpis [data-metric="sincronizados"] .cockpit-summary-kpi-value')).toHaveText("0");
    await expect(page.locator("#cockpit-summary-rows tr")).toHaveCount(0);
    await expect(page.locator("#cockpit-summary-status")).toContainText("lista detalhada não é armazenada");

    // Compacto: as linhas viram cards rotulados (data-label) e o cabeçalho da tabela some.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#cockpit-summary-kpis [data-metric="divergencias_local"]').click();
    const cells = page.locator("#cockpit-summary-rows tr").first().locator("td");
    await expect(cells.first()).toHaveAttribute("data-label", "Série");
    await expect(cells.last()).toHaveAttribute("data-label", "Ação");
    await expect(page.locator(".cockpit-summary-table thead")).toBeHidden();

    await page.locator('#cockpit-summary-kpis [data-metric="sem_acesso_7_dias"]').click();
    await expect(page.locator("#cockpit-summary-table-title")).toHaveText("Sem acesso há 7+ dias · 1");
    await expect(page.locator("#cockpit-summary-rows")).toContainText("9 dias");
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

function overflowingRight(page, rootSelector) {
  return page.evaluate(selector => {
    const limit = document.documentElement.clientWidth + 1;
    return [...document.querySelectorAll(`${selector}, ${selector} *`)]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height || el.closest("[hidden], .hidden, .sr-only")) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || rect.right <= limit) return false;
        // Conteúdo dentro de um contêiner com rolagem horizontal própria (ex.: tabela do histórico) não estoura a página.
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= limit) return false;
        }
        return true;
      })
      .map(el => `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).split(" ")[0]}`);
  }, rootSelector);
}

for (const width of [320, 390, 768, 1024, 1200, 1440, 1920]) {
  test(`Cockpit bar and Home fit a ${width}px window without horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    await expect(page.locator(".cockpit-bar")).toBeVisible();
    for (const id of ["tab-home", "tab-retirada-entrega", "tab-resumo", "tab-automacao", "cockpit-tools-trigger", "input-serial"]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    expect(await overflowingRight(page, ".cockpit-bar")).toEqual([]);
    expect(await overflowingRight(page, "#tab-panel-home")).toEqual([]);
    await page.locator("#cockpit-tools-trigger").click();
    await expect(page.locator("#btn-relatorio-mensal")).toBeVisible();
    expect(await overflowingRight(page, ".cockpit-bar")).toEqual([]);
  });
}

test("the compact bar keeps status behind an accessible toggle that Esc closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const toggle = page.locator("#cockpit-bar-status-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#cockpit-bar-status")).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#cockpit-automation-shell-status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await expect(page.locator("#cockpit-bar-status")).toBeHidden();
});

test("the wide bar has no status toggle and keeps the 240px search", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#cockpit-bar-status-toggle")).toBeHidden();
  await expect(page.locator("#cockpit-bar-status")).toBeVisible();
  const box = await page.locator(".cockpit-bar__search").boundingBox();
  expect(Math.round(box.width)).toBe(240);
  expect(Math.round((await page.locator(".cockpit-bar").boundingBox()).height)).toBe(48);
});

test("compact Home goes list -> detail -> back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#btn-home-voltar-lista")).toBeHidden();
  await page.locator("#home-equipment-list [role=option]").first().click();
  await expect(page.locator(".cockpit-home-detail")).toBeVisible();
  await expect(page.locator(".cockpit-home-list")).toBeHidden();
  await page.locator("#btn-home-voltar-lista").click();
  await expect(page.locator(".cockpit-home-list")).toBeVisible();
  await expect(page.locator("#btn-home-voltar-lista")).toBeHidden();
});

for (const width of [320, 390, 768, 1024, 1200, 1440, 1920]) {
  test(`Transporte, Resumo e Automação fit a ${width}px window without horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    for (const [tab, panel] of [["tab-retirada-entrega", "tab-panel-retirada-entrega"], ["tab-resumo", "tab-panel-resumo"], ["tab-automacao", "tab-panel-automacao"]]) {
      await page.locator(`#${tab}`).click();
      await expect(page.locator(`#${panel}`)).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(dimensions.document, panel).toBeLessThanOrEqual(dimensions.viewport);
      expect(dimensions.body, panel).toBeLessThanOrEqual(dimensions.viewport);
      expect(await overflowingRight(page, `#${panel}`), panel).toEqual([]);
    }
  });
}
