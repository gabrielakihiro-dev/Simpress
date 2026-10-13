const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

test("header summary and sidebar switch at 767/768 pixels in both themes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#stat-equipamentos")).toHaveText("1");
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

test("the theme icon switches modes, persists the choice, and works on login", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.removeItem("simpress:theme"));
  await page.reload();

  const root = page.locator("html");
  const lightModeButton = page.getByRole("button", { name: "Ativar modo claro" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(lightModeButton.locator("svg")).toHaveClass(/lucide-sun/);
  await lightModeButton.click();
  const darkModeButton = page.getByRole("button", { name: "Ativar modo escuro" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(darkModeButton.locator("svg")).toHaveClass(/lucide-moon/);
  await expect(page.locator("#btn-buscar-serial")).toHaveCSS("color", "rgb(255, 255, 255)");
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

  await page.route("**/api/auth/session", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ enabled: true, authenticated: false, csrf_token: "fixture-token" }),
  }));
  const loginHtml = fs.readFileSync(path.resolve(__dirname, "../../static/pages/login.html"), "utf8");
  await page.route("**/login", route => route.fulfill({ status: 200, contentType: "text/html", body: loginHtml }));
  await page.goto("/login");
  await page.getByRole("button", { name: "Ativar modo claro" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(page.locator("main")).toHaveCSS("background-color", "rgb(255, 255, 255)");
});
