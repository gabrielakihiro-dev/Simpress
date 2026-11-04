const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// Guards the color tokens: every main screen must keep WCAG AA text contrast in both themes.
async function contrastViolations(page, scope) {
  const results = await new AxeBuilder({ page }).include(scope).withRules(["color-contrast"]).analyze();
  return results.violations.flatMap(violation => violation.nodes.map(node => ({
    target: node.target,
    summary: node.failureSummary,
  })));
}

async function openSidebarForTabs(page) {
  const menu = page.locator("#btn-sidebar-open");
  const shell = page.locator("#simpress-app-shell");
  if (await menu.isVisible() && await shell.getAttribute("data-sidebar-open") !== "true") await menu.click();
}

for (const theme of ["dark", "light"]) {
  test(`home, Transporte, Resumo and Automação keep AA text contrast in the ${theme} theme`, async ({ page }) => {
    // Four Axe scans create auxiliary pages; allow their measured Windows setup cost.
    test.slow();
    await page.goto("/");
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);

    expect(await contrastViolations(page, "#tab-panel-home")).toEqual([]);

    // On narrow screens the tabs live inside the sidebar drawer.
    const menu = page.locator("#btn-sidebar-open");
    if (await menu.isVisible()) await menu.click();
    await page.locator("#tab-retirada-entrega").click();
    await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible();
    expect(await contrastViolations(page, "#tab-panel-retirada-entrega")).toEqual([]);

    // Resumo (F3): Ativos por regional e Total de ativos dentro do painel de ferramenta.
    await openSidebarForTabs(page);
    await page.locator("#btn-resumo-aba").click();
    await expect(page.locator("#resumo-regionais .ck-barra")).toHaveCount(1);
    await expect(page.locator("#resumo-total-ativos tr")).toHaveCount(1);
    expect(await contrastViolations(page, '[data-cockpit-tool-panel="comparacao"]')).toEqual([]);

    await openSidebarForTabs(page);
    await page.locator("#tab-automacao").click();
    await expect(page.locator("#automacao-historico .ck-tabela")).toBeVisible();
    expect(await contrastViolations(page, "#tab-panel-automacao")).toEqual([]);
  });
}
