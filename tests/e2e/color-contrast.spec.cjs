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

for (const theme of ["dark", "light"]) {
  test(`home and Transporte keep AA text contrast in the ${theme} theme`, async ({ page }) => {
    await page.goto("/");
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);

    expect(await contrastViolations(page, "#tab-panel-home")).toEqual([]);

    // On narrow screens the tabs live inside the sidebar drawer.
    const menu = page.locator("#btn-sidebar-open");
    if (await menu.isVisible()) await menu.click();
    await page.locator("#tab-retirada-entrega").click();
    await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible();
    expect(await contrastViolations(page, "#tab-panel-retirada-entrega")).toEqual([]);
  });
}
