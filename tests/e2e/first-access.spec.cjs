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
    files: {
      inventario_equipamentos: { ...status, file: "EquipamentosDetalhes_atual.xlsx", reason: ready ? "OK" : "ausente" },
      inventario_detalhes_atualizacao: { ...status, file: "EquipamentosDetalhes_atual.xlsx", reason: ready ? "OK" : "ausente" },
      inventario_endpoint: { ...status, file: "InvAllComputersSummary_atual.xlsx", reason: ready ? "OK" : "ausente" },
      template_transferencia: { ...status, file: "modelo_transferencia.xlsx", reason: ready ? "OK" : "ausente" },
      modelo_exportacao: { ...status, file: "modelo_exportacao.xlsx", reason: ready ? "OK" : "ausente" },
      catalogos_locais: { available: true, state: "ready", reason: "OK", file: "catálogos e históricos JSON" },
      historico_chamados: { ...status, file: "historico_chamados.json", reason: ready ? "OK" : "ausente" },
    },
  };
}

async function mockReadiness(page, getReport) {
  await page.route("**/api/prontidao", route => route.fulfill({ json: getReport() }));
}

test("first access centralizes the inventory import and keeps calls separate", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockReadiness(page, () => readiness());
  await page.goto("/");
  const panel = page.locator("#readiness-panel");
  await expect(panel).toHaveAttribute("open", "");
  await expect(page.locator("#readiness-details")).toHaveAttribute("open", "");
  await expect(page.locator("#readiness-summary")).toContainText("Base ainda não importada");
  await expect(panel.getByRole("button", { name: /Importar/ })).toHaveCount(3);
  await expect(panel).toContainText("Catálogos e históricos locais");
  await expect(panel.getByRole("heading", { name: "Ações com inventário" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Acompanhamento de chamados" })).toBeVisible();
  const audit = await new AxeBuilder({ page }).include("#readiness-panel")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(audit.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await panel.getByRole("button", { name: "Importar/atualizar inventários Simpress e Endpoint", exact: true }).click();
  await expect(page.locator("#upload-endpoint-file")).toBeFocused();
  await expect(page.locator("#upload-details-file")).toHaveAttribute("accept", /\.zip/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-atualizar-planilhas")).toBeHidden();

  await expect(panel.getByRole("button", { name: "Importar modelo — Modelo de transferência", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Importar planilhas para acompanhamento de chamados", exact: true }).click();
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
  await page.getByRole("button", { name: "Importar modelo — Modelo de exportação", exact: true }).click();
  await page.locator("#arquivo-modelo-local").setInputFiles({ name: "modelo.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("synthetic browser upload; backend validation is tested in Python") });
  await page.locator("#btn-importar-modelo").click();
  await expect(page.locator("#status-modelo-local")).toHaveText("Modelo incompatível com a base.");
  await expect(page.locator("#btn-importar-modelo")).toBeEnabled();
  await page.locator("#btn-importar-modelo").click();
  await expect(page.locator("#readiness-summary")).toHaveText("Todas as 5 funções estão disponíveis.");
  await expect(page.locator("#status-modelo-local")).toContainText("Modelo importado");
  await page.keyboard.press("Escape");
  await expect(page.locator("#modal-importar-modelo")).toBeHidden();
  await expect(page.locator("#readiness-panel").getByRole("button", { name: /Importar/ })).toHaveCount(3);
});

test("ready setup starts collapsed and preserves user's disclosure choice", async ({ page }) => {
  await mockReadiness(page, () => readiness(true));
  await page.goto("/");
  const panel = page.locator("#readiness-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  await expect(page.locator("#readiness-summary")).toContainText("Todas as 5");
  await expect(panel).not.toHaveAttribute("open", "");
  await panel.locator(":scope > summary").click();
  await page.locator("#readiness-details > summary").click();
  await page.locator("#readiness-refresh").click();
  await expect(panel).toHaveAttribute("open", "");
  await expect(panel.getByRole("button", { name: /Importar/ })).toHaveCount(3);
});
