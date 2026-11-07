const { test, expect } = require("@playwright/test");

const SOLICITANTE = {
  nome: "Gabriel Akihiro Noda Souza", email: "gansouza@simpress.com.br",
  telefone: "(41)98751-2389", departamento_cargo: "Analista WP Junior",
};

test("Home prepares a UX ticket and separates the dry run from the final action", async ({ page }) => {
  const requests = [];
  await page.route("**/api/ux/abrir-chamado/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    requests.push({ path, body });
    await route.fulfill({ json: path.endsWith("/preparar")
      ? { status: "preparado", serial: "LENTO", modelo: "Notebook de teste", session_id: "fixture", opcoes: ["Notebook - Teclado"], solicitante: SOLICITANTE }
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
  await expect(modal.getByLabel("Nome", { exact: true })).toHaveValue(SOLICITANTE.nome);
  await expect(modal.getByLabel("E-mail")).toHaveValue(SOLICITANTE.email);
  await expect(modal.getByLabel("Telefone")).toHaveValue(SOLICITANTE.telefone);
  await expect(modal.getByLabel("Departamento/Cargo")).toHaveValue(SOLICITANTE.departamento_cargo);
  await modal.getByLabel("Telefone").fill("(41)90000-0000");
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
    solicitante: { ...SOLICITANTE, telefone: "(41) 90000-0000" }, enviar: true, confirmado: true,
  }]);
});

test("Home explains a failed UX preparation, keeps the description and disables the actions", async ({ page }) => {
  const aviso = "Não foi possível abrir ou conectar o Chrome de automação. Feche as janelas desse Chrome e tente de novo.";
  const requests = [];
  await page.route("**/api/ux/abrir-chamado/**", async route => {
    requests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 503, json: { detail: aviso, codigo: "chrome_indisponivel" } });
  });
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await page.getByRole("tab", { name: "Kit teclado + mouse" }).click();
  await page.locator("#texto-chamado-teclado-mouse").fill("O teclado do notebook não funciona.");
  await page.getByRole("button", { name: "Abrir chamado no UX" }).click();
  const modal = page.getByRole("dialog", { name: "Abrir chamado no UX" });
  await expect(modal.getByRole("status")).toContainText(aviso);
  await expect(modal.locator("#ux-chamado-descricao")).toHaveText("O teclado do notebook não funciona.");
  await expect(modal.locator("#ux-chamado-motivo")).toContainText("preparação no UX não foi concluída");
  for (const nome of ["Simular preenchimento", "Revisar e enviar"]) {
    const botao = modal.getByRole("button", { name: nome });
    await expect(botao).toBeDisabled();
    await expect(botao).toHaveAccessibleDescription(/preparação no UX não foi concluída/);
  }
  expect(requests).toEqual(["/api/ux/abrir-chamado/preparar"]);
});
