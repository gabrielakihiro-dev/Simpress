const { test, expect } = require("@playwright/test");

test("the Cockpit tools remain reachable in narrow windows in both themes", async ({ page }) => {
  await page.goto("/");
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    for (const width of [390, 767, 768, 1200]) {
      await page.setViewportSize({ width, height: 1024 });
      await page.locator("#cockpit-tools-trigger").click();
      await expect(page.locator("#btn-nova-transferencia")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#cockpit-tools-trigger")).toBeFocused();
      await expect(page.locator("#cockpit-tools-dropdown")).not.toHaveAttribute("open", "");
      const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, body: document.body.scrollWidth }));
      expect(widths.body).toBeGreaterThanOrEqual(Math.max(1200, widths.viewport));
    }
  }
});

test("the theme icon switches modes and persists the choice", async ({ page }) => {
  await page.goto("/");

  const root = page.locator("html");
  const lightModeButton = page.getByRole("button", { name: "Ativar modo claro" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(lightModeButton.locator("svg")).toHaveClass(/lucide-sun/);
  await lightModeButton.click();
  const darkModeButton = page.getByRole("button", { name: "Ativar modo escuro" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(darkModeButton.locator("svg")).toHaveClass(/lucide-moon/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("simpress:theme"))).toBe("light");
  await page.locator(".app-workspace").evaluate(async workspace => {
    const transitions = workspace.getAnimations();
    await Promise.all(transitions.map(transition => transition.finished.catch(() => undefined)));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Ativar modo escuro" }).focus();
  await page.keyboard.press("Enter");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("simpress:theme"))).toBe("dark");
});
