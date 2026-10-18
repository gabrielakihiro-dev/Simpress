const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

function originConfig(contato = "", email = "", telefone = "") {
  return {
    retirada_contato: contato, retirada_email: email, retirada_telefone: telefone,
    contato_origem_configurado: Boolean(contato && email && telefone),
    contato_origem_fontes: {
      retirada_contato: contato ? "arquivo" : "", retirada_email: email ? "arquivo" : "",
      retirada_telefone: telefone ? "arquivo" : "",
    },
    contato_origem_arquivo_invalido: false,
  };
}

async function openTransferTab(page) {
  const sidebarButton = page.locator("#btn-sidebar-open");
  const shell = page.locator("#simpress-app-shell");
  if (await sidebarButton.isVisible() && await shell.getAttribute("data-sidebar-open") !== "true") {
    await sidebarButton.click();
    await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  }
  await page.locator("#tab-retirada-entrega").click();
}

test("an installation without origin contact warns and saves it from the transfer tab", async ({ page }) => {
  const saved = [];
  await page.route("**/api/config/transferencia", route => route.fulfill({ json: originConfig() }));
  await page.route("**/api/config/transferencia/contato-origem", async route => {
    const payload = route.request().postDataJSON();
    saved.push(payload);
    await route.fulfill({ json: originConfig(payload.contato, payload.email, payload.telefone) });
  });
  await page.goto("/");
  await openTransferTab(page);

  const warning = page.locator("#aviso-contato-origem");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Contato de origem não configurado nesta instalação.");
  await expect(page.locator("#retirada-contato")).toHaveValue("");

  await page.locator("#btn-configurar-contato-origem").click();
  const dialog = page.getByRole("dialog", { name: "Contato de origem" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#contato-origem-nome")).toBeFocused();

  await page.locator("#btn-salvar-contato-origem").click();
  await expect(page.locator("#status-contato-origem")).toHaveText('Preencha o campo "Nome".');
  expect(saved).toEqual([]);

  await page.locator("#contato-origem-nome").fill("Contato Teste");
  await page.locator("#contato-origem-email").fill("contato@exemplo.invalid");
  await page.locator("#contato-origem-telefone").fill("(41) 90000-0000");
  const audit = await new AxeBuilder({ page }).include("#modal-contato-origem").analyze();
  expect(audit.violations.map(violation => violation.id)).toEqual([]);
  await page.locator("#btn-salvar-contato-origem").click();

  await expect(dialog).toBeHidden();
  expect(saved).toEqual([{ contato: "Contato Teste", email: "contato@exemplo.invalid", telefone: "(41) 90000-0000" }]);
  await expect(warning).toBeHidden();
  await expect(page.locator("#retirada-contato")).toHaveValue("Contato Teste");
  await expect(page.locator("#retirada-email")).toHaveValue("contato@exemplo.invalid");
  await expect(page.locator("#retirada-telefone")).toHaveValue("(41) 90000-0000");
});

test("a configured installation keeps the origin contact warning hidden", async ({ page }) => {
  await page.route("**/api/config/transferencia", route => route.fulfill({
    json: originConfig("Contato Teste", "contato@exemplo.invalid", "(41) 90000-0000"),
  }));
  await page.goto("/");
  await openTransferTab(page);
  await expect(page.locator("#retirada-contato")).toHaveValue("Contato Teste");
  await expect(page.locator("#aviso-contato-origem")).toBeHidden();
});
