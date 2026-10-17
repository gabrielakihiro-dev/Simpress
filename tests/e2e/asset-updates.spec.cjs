const { test, expect } = require("@playwright/test");

test("updated page avoids legacy asset URLs and styles the transfer banner", async ({ page }) => {
  const legacyRequests = [];
  await page.route(/\/static\/(?:app\.css|app\.js)$/, route => {
    legacyRequests.push(route.request().url());
    return route.fulfill({ body: "/* obsolete cached version */" });
  });
  await page.goto("/");
  for (const selector of ['link[href*="/static/app.css"]', 'script[src*="/static/app.js"]']) {
    const url = await page.locator(selector).evaluate(element => element.href || element.src);
    expect(new URL(url).searchParams.get("v")).toMatch(/^[a-f0-9]{16}$/);
  }
  const mobileSidebarButton = page.locator("#btn-sidebar-open");
  if (await mobileSidebarButton.isVisible()) {
    await mobileSidebarButton.click();
    await expect(page.locator("#simpress-app-shell")).toHaveAttribute("data-sidebar-open", "true");
  }
  await page.getByRole("tab", { name: "Transporte" }).click();
  await expect(page.locator("#tab-retirada-entrega")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#transfer-equipment-banner")).toBeVisible();
  await expect(page.locator("#transfer-equipment-banner")).toHaveCSS("border-radius", "18px");
  await expect(page.getByRole("button", { name: "Pesquisar equipamento na Home" })).toBeVisible();
  await expect(page.locator("#btn-copiar-serie")).toBeHidden();
  await expect(page.locator(".transfer-equipment-header #btn-historico-transferencias")).toBeVisible();
  expect(legacyRequests).toEqual([]);
});
