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
