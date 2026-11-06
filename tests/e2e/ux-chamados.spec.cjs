const { test, expect } = require("@playwright/test");

test("Home prepares a UX ticket and separates the dry run from the final action", async ({ page }) => {
  const requests = [];
  await page.route("**/api/ux/abrir-chamado/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    requests.push({ path, body });
    await route.fulfill({ json: path.endsWith("/preparar")
      ? { status: "preparado", serial: "LENTO", modelo: "Notebook de teste", session_id: "fixture", opcoes: ["Notebook - Teclado"] }
      : body.enviar ? { status: "enviado", os: "98765" } : { status: "preenchido" } });
  });
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await page.getByRole("tab", { name: "Kit teclado + mouse" }).click();
  await page.locator("#texto-chamado-teclado-mouse").fill("O teclado do notebook não funciona.");
  await page.getByRole("button", { name: "Abrir chamado no UX" }).click();
  const modal = page.getByRole("dialog", { name: "Abrir chamado no UX" });
  await expect(modal.getByText("Notebook de teste")).toBeVisible();
  await modal.getByLabel("Problema").selectOption("Notebook - Teclado");
  await modal.getByRole("button", { name: "Simular preenchimento" }).click();
  await expect(modal.getByRole("status")).toContainText("Nenhuma solicitação foi enviada");
  await modal.getByRole("button", { name: "Revisar e enviar" }).click();
  const confirmacao = page.getByRole("dialog", { name: "Confirmar chamado no UX" });
  await expect(confirmacao).toContainText("O teclado do notebook não funciona.");
  expect(requests.filter(({ body }) => body.enviar === true)).toHaveLength(0);
  await confirmacao.getByRole("button", { name: "Enviar solicitação" }).click();
  await expect(modal.getByRole("status")).toContainText("OS #98765");
  expect(requests.filter(({ body }) => body.enviar === true).map(({ body }) => body)).toEqual([{
    session_id: "fixture", serial: "LENTO", problema: "Notebook - Teclado", descricao: "O teclado do notebook não funciona.",
    enviar: true, confirmado: true,
  }]);
});

