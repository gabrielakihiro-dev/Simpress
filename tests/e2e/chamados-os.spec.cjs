const { test, expect } = require("@playwright/test");

// Janela Chamado × OS: na aba OS (F6), o prefixo UTIC de uma OS vinculada abre #modal-chamado-os.
// O fixture tem a OS 7285070 (série DEMO-SN-001) e o chamado UTIC-2026-1378 entre os novos do F5;
// o vínculo salvo vem só desta rota (nada é gravado no servidor de fixture).

// F5 e F6 ficam na barra principal; abaixo de 1200px só o menu Ferramentas os oferece.
async function abrirAba(page, botaoBarra, itemMenu, titulo) {
  const naBarra = await page.locator(botaoBarra).isVisible();
  if (!naBarra) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra ? botaoBarra : itemMenu).click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText(titulo);
}

async function abrirAbaOsComVinculo(page, numero) {
  const vinculo = { fonte: "oracle", serie: "DEMO-SN-001", os: "7285070", ano: 2026, numero, origem: "manual", chamado: `UTIC-2026-${numero}` };
  await page.route("**/api/operacoes/chamados/vinculos-os", route => route.request().method() === "GET"
    ? route.fulfill({ json: { vinculos: [vinculo] } })
    : route.fallback());
  await page.goto("/");
  await abrirAba(page, "#btn-acompanhamento-chamados", "#btn-chamados-menu", "OS");
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

test("Chamado × OS: o botão da OS no cartão do chamado na aba Chamados (F5) abre a janela; Esc fecha e devolve o foco", async ({ page }) => {
  // A OS do UTIC-2026-1378 no fixture (7303022) não está no relatório da aba OS: só no navegador, a lista
  // de chamados passa a trazer 7285070 (série DEMO-SN-001), que existe lá. Nada é gravado no servidor.
  await page.route("**/api/sebrae/novos", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const resposta = await route.fetch();
    await route.fulfill({ response: resposta, body: (await resposta.text()).replaceAll("7303022", "7285070") });
  });
  await page.goto("/");
  await abrirAba(page, "#btn-sebrae-chamados-aba", "#btn-sebrae-chamados-menu", "Chamados");
  const gatilho = page.locator('#sebrae-novos-lista article.sebrae-chamado[data-numero="UTIC-2026-1378"] button.sebrae-chamado__os');
  await expect(gatilho).toHaveText("7285070");
  await gatilho.click();
  const modal = page.locator("#modal-chamado-os");
  await expect(page.getByRole("dialog", { name: "Chamado × OS" })).toBeVisible();
  await expect(page.locator("#chamado-os-janela-chamado")).toContainText("UTIC-2026-1378");
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(gatilho).toBeFocused();
});
