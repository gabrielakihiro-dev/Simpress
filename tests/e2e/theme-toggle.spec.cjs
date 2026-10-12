const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

test("the theme icon switches modes, persists the choice, and works on login", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.removeItem("simpress:theme"));
  await page.reload();

  const root = page.locator("html");
  const lightModeButton = page.getByRole("button", { name: "Ativar modo claro" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(lightModeButton.locator("svg")).toHaveClass(/lucide-sun/);
  const darkCardBackground = await page.locator(".home-search-card").evaluate(
    element => getComputedStyle(element).backgroundColor,
  );

  await lightModeButton.click();
  const darkModeButton = page.getByRole("button", { name: "Ativar modo escuro" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(darkModeButton.locator("svg")).toHaveClass(/lucide-moon/);
  await expect(page.locator("#btn-buscar-serial")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect.poll(() => page.locator(".home-search-card").evaluate(
    element => getComputedStyle(element).backgroundColor,
  )).not.toBe(darkCardBackground);
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
