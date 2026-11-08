const { test, expect } = require("@playwright/test");

// Janela Chamado × OS: na aba OS (F6), o prefixo UTIC de uma OS vinculada abre #modal-chamado-os.
// O fixture tem a OS 7285070 (série DEMO-SN-001) e o chamado UTIC-2026-1378 entre os novos do F5;
// o vínculo salvo vem só desta rota (nada é gravado no servidor de fixture).
async function abrirAbaOsComVinculo(page, numero) {
  const vinculo = { fonte: "oracle", serie: "DEMO-SN-001", os: "7285070", ano: 2026, numero, origem: "manual", chamado: `UTIC-2026-${numero}` };
  await page.route("**/api/operacoes/chamados/vinculos-os", route => route.request().method() === "GET"
    ? route.fulfill({ json: { vinculos: [vinculo] } })
    : route.fallback());
  await page.goto("/");
  // OS fica na barra principal; abaixo de 1200px só o menu Ferramentas a oferece.
  const naBarra = await page.locator("#btn-acompanhamento-chamados").isVisible();
  if (!naBarra) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra ? "#btn-acompanhamento-chamados" : "#btn-chamados-menu").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("OS");
  const gatilho = page.locator('#cockpit-tickets-os tbody tr[data-serial="DEMO-SN-001"] button.ticket-os-link-goto').first();
  await expect(gatilho).toBeVisible();
  await expect(gatilho).toHaveAttribute("aria-haspopup", "dialog");
  return gatilho;
}

test("Chamado × OS: o UTIC da OS vinculada na aba OS (F6) abre a janela com o chamado e a OS; Esc fecha e devolve o foco", async ({ page }) => {
  const gatilho = await abrirAbaOsComVinculo(page, "1378");
  await gatilho.click();
  const modal = page.locator("#modal-chamado-os");
  await expect(modal).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Chamado × OS" })).toBeVisible();
  await expect(page.locator("#chamado-os-janela-chamado")).toContainText("UTIC-2026-1378");
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await expect(page.locator("#chamado-os-janela-f6")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(gatilho).toBeFocused();
});

test("Chamado × OS: chamado ausente da F5 avisa e ainda mostra a OS", async ({ page }) => {
  const gatilho = await abrirAbaOsComVinculo(page, "9999");
  await gatilho.click();
  await expect(page.locator("#modal-chamado-os")).toBeVisible();
  await expect(page.locator("#chamado-os-janela-chamado")).toHaveText("Chamado não encontrado na aba Chamados (F5).");
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await page.locator('#modal-chamado-os button:text-is("Fechar")').click();
  await expect(page.locator("#modal-chamado-os")).toBeHidden();
  await expect(gatilho).toBeFocused();
});
