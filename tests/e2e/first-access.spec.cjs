const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

function readiness(ready = false) {
  const status = { available: ready, state: ready ? "ready" : "awaiting_import", missing_files: ready ? [] : ["Importe os arquivos necessários"] };
  return {
    backend: "files",
    functions: Object.fromEntries([
      "consulta_equipamentos", "geracao_transferencia", "comparacao_atualizacao_inventarios",
      "exportacao_equipamentos", "acompanhamento_chamados",
    ].map(key => [key, status])),
    files: { inventario_equipamentos: { ...status, file: "EquipamentosDetalhes_atual.xlsx", reason: ready ? "OK" : "ausente" },
      catalogos_locais: { available: true, state: "ready", reason: "OK", file: "catálogos e históricos JSON" } },
  };
}

async function mockReadiness(page, getReport) {
  await page.route("**/api/prontidao", route => route.fulfill({ json: getReport() }));
}

test("first access opens pending files and every import action", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockReadiness(page, () => readiness());
  await page.goto("/");
  const panel = page.locator("#readiness-panel");
  await expect(panel).toHaveAttribute("open", "");
  await expect(page.locator("#readiness-details")).toHaveAttribute("open", "");
  await expect(page.locator("#readiness-summary")).toContainText("Base ainda não importada");
  await expect(panel.getByRole("button", { name: /Importar/ })).toHaveCount(5);
  await expect(panel).toContainText("Catálogos e históricos locais");
  const audit = await new AxeBuilder({ page }).include("#readiness-panel")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(audit.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await panel.getByRole("button", { name: "Importar inventários — Consulta de equipamentos", exact: true }).click();
  await expect(page.locator("#upload-endpoint-file")).toBeFocused();
  await expect(page.locator("#upload-details-file")).toHaveAttribute("accept", /\.zip/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-atualizar-planilhas")).toBeHidden();

  await panel.getByRole("button", { name: "Importar arquivos — Geração de transferência", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Arquivos para transferência" })).toBeVisible();
  const modalAudit = await new AxeBuilder({ page }).include("#modal-importar-modelo")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(modalAudit.violations).toEqual([]);
  await page.getByRole("button", { name: "Importar inventários Simpress e Endpoint", exact: true }).click();
  await expect(page.locator("#upload-endpoint-file")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-atualizar-planilhas")).toBeHidden();
  await panel.getByRole("button", { name: /Importar chamados —/ }).click();
  await expect(page.locator("#painel-dados-acompanhamento-chamados")).toHaveAttribute("open", "");
  await expect(page.locator("#arquivo-chamados-simpress")).toBeVisible();
  expect(errors).toEqual([]);
});

test("model import handles failure and refreshes availability after success", async ({ page }) => {
  let ready = false;
  let calls = 0;
  await mockReadiness(page, () => readiness(ready));
  await page.route("**/api/modelos/exportacao/importar", async route => {
    calls += 1;
    expect(route.request().postData()).toContain('filename="modelo.xlsx"');
    if (calls === 1) return route.fulfill({ status: 400, json: { detail: "Modelo incompatível com a base." } });
    ready = true;
    return route.fulfill({ json: { sucesso: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Importar arquivos — Exportação de equipamentos", exact: true }).click();
  await page.locator("#arquivo-modelo-local").setInputFiles({ name: "modelo.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("synthetic browser upload; backend validation is tested in Python") });
  await page.locator("#btn-importar-modelo").click();
  await expect(page.locator("#status-modelo-local")).toHaveText("Modelo incompatível com a base.");
  await expect(page.locator("#btn-importar-modelo")).toBeEnabled();
  await page.locator("#btn-importar-modelo").click();
  await expect(page.locator("#readiness-summary")).toHaveText("Todas as 5 funções estão disponíveis.");
  await expect(page.locator("#status-modelo-local")).toContainText("Modelo importado");
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-importar-modelo")).toBeHidden();
  await expect(page.locator("#readiness-panel").getByRole("button", { name: /Importar/ })).toHaveCount(5);
});

test("ready setup starts collapsed and preserves user's disclosure choice", async ({ page }) => {
  await mockReadiness(page, () => readiness(true));
  await page.goto("/");
  const panel = page.locator("#readiness-panel");
  await expect(page.locator("#readiness-summary")).toContainText("Todas as 5");
  await expect(panel).not.toHaveAttribute("open", "");
  await panel.locator(":scope > summary").click();
  await page.locator("#readiness-details > summary").click();
  await page.locator("#readiness-refresh").click();
  await expect(panel).toHaveAttribute("open", "");
  await expect(panel.getByRole("button", { name: /Importar/ })).toHaveCount(5);
});
