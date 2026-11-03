const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// Uses the in-memory /api/config/representantes-regionais endpoints of tests/support/serve_ui_motion_preview.py.
test.beforeEach(async ({ request }) => {
  await request.get("/__fixture_representantes");
});

async function openTransferTab(page) {
  const sidebarButton = page.locator("#btn-sidebar-open");
  const shell = page.locator("#simpress-app-shell");
  if (await sidebarButton.isVisible() && await shell.getAttribute("data-sidebar-open") !== "true") {
    await sidebarButton.click();
    await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  }
  await page.locator("#tab-retirada-entrega").click();
}

test("edits, validates and restores a regional representative from the transfer tab", async ({ page }) => {
  await page.goto("/");
  await openTransferTab(page);

  const editar = page.locator("#btn-editar-representante-retirada");
  await expect(editar).toBeDisabled();
  await page.locator("#retirada-representante").selectOption("Londrina");
  await page.locator("#entrega-representante").selectOption("Maringá");
  await expect(editar).toBeEnabled();
  await editar.click();

  const dialog = page.getByRole("dialog", { name: "Editar representante regional" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#representante-regional-nome")).toBeFocused();
  await expect(page.locator("#representante-regional-nome")).toHaveValue("Renata Custodio de Oliveira Varasquim");
  await expect(page.locator("#representante-regional-almoco-nao-fecha")).toBeChecked();
  await expect(page.locator("#btn-restaurar-representante-regional")).toBeDisabled();

  await page.locator("#representante-regional-email").fill("sem-arroba");
  await page.locator("#btn-salvar-representante-regional").click();
  const status = page.locator("#status-representante-regional");
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).not.toContainText("Value error");
  await expect(status).toContainText("e-mail");
  await expect(dialog).toBeVisible();

  await page.locator("#representante-regional-nome").fill("Renata Editada");
  await page.locator("#representante-regional-email").fill("renata@exemplo.invalid");
  await page.locator("#representante-regional-inicio").fill("09:00:00");
  await page.locator("#representante-regional-fim").fill("17:00:00");
  const audit = await new AxeBuilder({ page }).include("#modal-representante-regional").analyze();
  expect(audit.violations.map(violation => violation.id)).toEqual([]);
  await page.locator("#btn-salvar-representante-regional").click();

  await expect(dialog).toBeHidden();
  await expect(page.locator("#retirada-representante")).toHaveValue("Londrina");
  await expect(page.locator("#entrega-representante")).toHaveValue("Maringá");
  await expect(page.locator("#retirada-representante option[value='Londrina']")).toHaveText("Renata Editada — Londrina");
  await expect(page.locator("#retirada-contato")).toHaveValue("Renata Editada");
  await expect(page.locator("#retirada-horario")).toHaveValue("09:00:00 às 17:00:00");
  await expect(page.locator("#entrega-contato")).toHaveValue("Tatiane Matsuguma Sanches");

  // The edit survives a reload (it comes back from the API).
  await page.reload();
  await openTransferTab(page);
  await expect(page.locator("#retirada-representante option[value='Londrina']")).toHaveText("Renata Editada — Londrina");

  await page.locator("#retirada-representante").selectOption("Londrina");
  await editar.click();
  await expect(page.locator("#btn-restaurar-representante-regional")).toBeEnabled();
  await page.locator("#btn-restaurar-representante-regional").click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#retirada-representante option[value='Londrina']")).toHaveText("Renata Custodio de Oliveira Varasquim — Londrina");
  await expect(page.locator("#retirada-contato")).toHaveValue("Renata Custodio de Oliveira Varasquim");
});

test("Esc and Cancelar close the regional representative dialog without saving", async ({ page }) => {
  await page.goto("/");
  await openTransferTab(page);
  await page.locator("#entrega-representante").selectOption("Toledo");
  await page.locator("#btn-editar-representante-entrega").click();
  const dialog = page.getByRole("dialog", { name: "Editar representante regional" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.locator("#btn-editar-representante-entrega").click();
  await page.locator("#btn-cancelar-representante-regional").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#entrega-representante option[value='Toledo']")).toHaveText("Fernanda da Costa Goldacker — Toledo");
});

test("keeps a hand-typed field when the dialog changes it and warns which one was kept", async ({ page }) => {
  await page.goto("/");
  await openTransferTab(page);
  await page.locator("#retirada-representante").selectOption("Londrina");
  await page.locator("#retirada-telefone").fill("(43) 90000-0000");
  await page.locator("#btn-editar-representante-retirada").click();
  await page.locator("#representante-regional-nome").fill("Renata Editada");
  await page.locator("#representante-regional-telefone").fill("(43) 98888-7777");
  await page.locator("#btn-salvar-representante-regional").click();
  await expect(page.locator("#retirada-contato")).toHaveValue("Renata Editada");
  await expect(page.locator("#retirada-telefone")).toHaveValue("(43) 90000-0000");
  await expect(page.locator("#toast-container")).toContainText("O campo Celular de Londrina (Retirada) foi mantido porque foi editado à mão.");
});

test("when the defaults cannot be loaded the selectors stay empty, a toast explains and the page keeps working", async ({ page }) => {
  await page.route("**/api/config/representantes-regionais", route => route.abort());
  await page.goto("/");
  await openTransferTab(page);
  await expect(page.locator("#toast-container")).toContainText("Não foi possível carregar os representantes regionais. Recarregue a página.");
  await expect(page.locator("#retirada-representante option")).toHaveCount(1);
  await expect(page.locator("#btn-editar-representante-retirada")).toBeDisabled();
  await page.locator("#retirada-contato").fill("Contato digitado");
  await expect(page.locator("#retirada-contato")).toHaveValue("Contato digitado");
});

test("a failed first load is retried once and the cities appear without reloading, with no toast", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/config/representantes-regionais", route => (++requests === 1 ? route.abort() : route.continue()));
  await page.goto("/");
  await openTransferTab(page);
  await expect(page.locator("#retirada-representante option[value='Londrina']")).toHaveCount(1, { timeout: 8_000 });
  await expect(page.locator("#entrega-representante option[value='Maringá']")).toHaveCount(1);
  expect(requests).toBe(2);
  await expect(page.locator("#toast-container")).not.toContainText("Não foi possível carregar os representantes regionais");
});

test("a city chosen by the equipment search before the defaults arrive is filled when they load", async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/config/representantes-regionais", async route => { await gate; await route.continue(); });
  await page.goto("/");
  await page.route("**/api/buscar-expandida*", route => route.fulfill({ json: { items: [], total: 0, has_more: false, filters: { categories: [], cities: [] } } }));
  await page.route("**/api/equipamento/LENTO", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), retirada_cidade: "Londrina" } });
  });
  await page.locator("#input-serial").fill("LENTO");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-equipamento")).toBeVisible({ timeout: 15_000 });
  await openTransferTab(page);
  await expect(page.locator("#retirada-representante option")).toHaveCount(1);
  await expect(page.locator("#retirada-contato")).not.toHaveValue("Renata Custodio de Oliveira Varasquim");
  release();
  await expect(page.locator("#retirada-representante")).toHaveValue("Londrina");
  await expect(page.locator("#retirada-contato")).toHaveValue("Renata Custodio de Oliveira Varasquim");
  await expect(page.locator("#btn-editar-representante-retirada")).toBeEnabled();
});
