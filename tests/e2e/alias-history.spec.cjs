const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

function fixtureHistory() {
  const types = ["usuario", "apelido", "aviso_endpoint", "endereco"];
  return Array.from({ length: 32 }, (_, index) => {
    const tipo = types[index % types.length];
    const serial = index === 4 ? "SN-001" : `SN-${String(index + 1).padStart(3, "0")}`;
    return {
      id: `history-event-${index + 1}`,
      horario: new Date(Date.parse("2026-10-20T12:00:00-03:00") - index * 60_000).toISOString(),
      tipo,
      serial,
      equipamento: "Notebook de demonstração",
      acao: "alteracao",
      apelido_anterior: `old-host-${index + 1}`,
      apelido_novo: `new-host-${index + 1}`,
      usuario_anterior: `old.usuario.${String(index + 1).padStart(2, "0")}`,
      usuario_novo: `new.usuario.${String(index + 1).padStart(2, "0")}`,
      endereco_anterior: { endereco: "Rua de teste, 10", cidade: "Curitiba", uf: "PR" },
      endereco_novo: { endereco: "Rua de teste, 20", cidade: "Maringá", uf: "PR" },
      motivo: tipo === "aviso_endpoint" ? "usuario_removido" : undefined,
    };
  });
}

async function openHistory(page) {
  const sidebarButton = page.locator("#btn-sidebar-open");
  const shell = page.locator("#simpress-app-shell");
  if (await sidebarButton.isVisible() && await shell.getAttribute("data-sidebar-open") !== "true") {
    await sidebarButton.click();
    await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  }
  const menu = page.locator('.header-action-group[data-action-group="analysis"]');
  if (!(await menu.evaluate(element => element.open))) await menu.locator("> summary").click();
  await page.locator("#btn-historico-apelidos").click();
  const dialog = page.getByRole("dialog", { name: "Histórico de alterações" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".alias-history-row")).toHaveCount(25);
  return dialog;
}

test("history can be searched, filtered, and paged without changing event actions", async ({ page }) => {
  test.setTimeout(60_000);
  const eventos = fixtureHistory();
  await page.route("**/api/historico-alteracoes", route => route.fulfill({ json: { eventos, total: eventos.length } }));
  await page.goto("/");
  await openHistory(page);

  await expect(page.locator("#total-historico-apelidos")).toHaveText("32 registros");
  await expect(page.locator("#resultado-filtros-historico-apelidos")).toHaveText("Exibindo 1–25 de 32 registros");
  await page.locator("#proxima-pagina-historico-apelidos").click();
  await expect(page.locator("#pagina-atual-historico-apelidos")).toHaveText("Página 2 de 2");
  await expect(page.locator(".alias-history-row")).toHaveCount(7);
  await page.locator("#pagina-anterior-historico-apelidos").click();

  await page.locator("#tipo-historico-apelidos").selectOption("usuario");
  await expect(page.locator(".alias-history-row")).toHaveCount(8);
  await expect(page.locator("#resultado-filtros-historico-apelidos")).toContainText("8 de 32 registros");
  await page.locator("#busca-historico-apelidos").fill("SN-001");
  await expect(page.locator(".alias-history-row")).toHaveCount(2);
  await expect(page.locator(".alias-history-row").first()).toContainText("old.usuario.01");

  await page.locator("#busca-historico-apelidos").fill("");
  await page.locator("#tipo-historico-apelidos").selectOption("todos");
  await page.locator("#apenas-acoes-historico-apelidos").check();
  await expect(page.locator(".alias-history-row")).toHaveCount(23);
  await expect(page.locator(".alias-history-row").filter({ hasText: "SN-001" }).first().getByRole("button", { name: /Desfazer/ })).toBeEnabled();

  await page.locator("#limpar-filtros-historico-apelidos").click();
  await expect(page.locator("#busca-historico-apelidos")).toHaveValue("");
  await expect(page.locator("#tipo-historico-apelidos")).toHaveValue("todos");
  await expect(page.locator("#apenas-acoes-historico-apelidos")).not.toBeChecked();
  await expect(page.locator(".alias-history-row")).toHaveCount(25);
});

test("history stays in the viewport, adapts rows, and passes axe in both themes", async ({ page }) => {
  test.setTimeout(60_000);
  const eventos = fixtureHistory();
  await page.route("**/api/historico-alteracoes", route => route.fulfill({ json: { eventos, total: eventos.length } }));
  await page.goto("/");
  const dialog = await openHistory(page);
  await expect(page.locator("[aria-label='Fechar histórico']")).toBeFocused();

  const firstCell = page.locator(".alias-history-row").first().locator("td").first();
  const expectedCellDisplay = page.viewportSize().width <= 1200 ? "grid" : "table-cell";
  await expect.poll(() => firstCell.evaluate(element => getComputedStyle(element).display)).toBe(expectedCellDisplay);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include("#modal-historico-apelidos").analyze();
    expect(audit.violations.map(violation => violation.id), theme).toEqual([]);
  }
});
