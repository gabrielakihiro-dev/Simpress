const { test, expect } = require("@playwright/test");

// Bloco 2 da migração React: o bundle de static/dist roda sob o CSP real, sem mudar a tela.
test("React bundle runs under the real CSP without violations", async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", event => {
      window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const response = await page.goto("/");
  expect(response.headers()["content-security-policy"]).toContain("script-src 'self'");
  const src = await page.locator('script[src*="/static/dist/react-entry.js"]').evaluate(element => element.src);
  expect(new URL(src).searchParams.get("v")).toMatch(/^[a-f0-9]{16}$/);
  await expect(page.locator("html")).toHaveAttribute("data-react-pronto", "");
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
});
