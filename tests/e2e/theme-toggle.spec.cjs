const { test, expect } = require("@playwright/test");

test("header summary and sidebar switch at 767/768 pixels in both themes", async ({ page }) => {
  await page.goto("/");
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    for (const width of [767, 768, 767]) {
      await page.setViewportSize({ width, height: 1024 });
      await page.locator(".app-workspace").evaluate(async workspace => {
        await Promise.all(workspace.getAnimations().map(animation => animation.finished.catch(() => undefined)));
      });
      const summary = page.locator(".header-base-summary");
      const menu = page.locator("#btn-sidebar-open");
      if (width === 767) {
        await expect(summary).toBeHidden();
        await expect(menu).toBeVisible();
        await menu.click();
        await expect(page.locator("#simpress-app-shell")).toHaveAttribute("data-sidebar-open", "true");
        await expect(page.locator("#btn-nova-transferencia")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator("#simpress-app-shell")).toHaveAttribute("data-sidebar-open", "false");
      } else {
        await expect(summary).toBeVisible();
        await expect(menu).toBeHidden();
        await expect(page.locator("#btn-nova-transferencia")).toBeVisible();
      }
      await expect.poll(() => page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      )).toBe(true);
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
