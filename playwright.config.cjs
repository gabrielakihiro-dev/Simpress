const { defineConfig } = require("@playwright/test");
const fixtureUrl = `http://127.0.0.1:${process.env.SIMPRESS_UI_FIXTURE_PORT || "8765"}`;

const fixturePython = process.env.PYTHON
  ? `"${process.env.PYTHON}"`
  : process.platform === "win32" ? "python" : "python3";

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  // Windows CI runners vary in speed; a consistent failure still fails every attempt,
  // while timing flakes are retried and reported as "flaky" instead of failing the run.
  retries: process.env.CI ? 2 : 0,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["html", { outputFolder: "TEMP/playwright-report", open: "never" }]],
  outputDir: "TEMP/test-results",
  use: {
    baseURL: fixtureUrl,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      grepInvert: /@profile/,
      use: { browserName: "chromium", viewport: { width: 1366, height: 900 } },
    },
    {
      name: "mobile",
      grepInvert: /@profile/,
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: "desktop-profile",
      grep: /@profile/,
      use: { browserName: "chromium", viewport: { width: 1366, height: 900 }, trace: "off" },
    },
  ],
  webServer: {
    command: `${fixturePython} -B tests/support/serve_ui_motion_preview.py`,
    url: `${fixtureUrl}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
