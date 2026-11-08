const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// Chamados × OS: o fixture já traz um antigo (UTIC-2026-1200) cuja série não está na importação de OS;
// o primeiro novo passa a apontar para a série DEMO-SN-001 / OS 7285070, que está no relatório do fixture.
async function prepararChamados(page) {
  await page.route("**/api/sebrae/novos", async route => {
    const resposta = await route.fetch();
    const dados = await resposta.json();
    Object.assign(dados.novos.formulario[0].linha, { K: "DEMO-SN-001", E: "7285070" });
    await route.fulfill({ response: resposta, json: dados });
  });
  await page.goto("/");
  const naBarra = await page.locator("#btn-sebrae-chamados-aba").isVisible();
  if (!naBarra) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra ? "#btn-sebrae-chamados-aba" : "#btn-sebrae-chamados-menu").click();
  await expect(page.locator('[data-cockpit-tool-panel="sebrae-chamados"]')).toBeVisible();
}

test("Chamados × OS abre pelo F5, liga UTIC e OS, passa no axe e volta pelo caminho de origem", async ({ page }) => {
  await prepararChamados(page);
  await page.locator("#btn-chamados-os-f5").click();
  const painel = page.locator('[data-cockpit-tool-panel="chamados-os"]');
  await expect(painel).toBeVisible();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados × OS");
  const linhas = painel.locator("tbody tr");
  await expect(linhas).toHaveCount(2);
  const encontrada = linhas.filter({ hasText: "UTIC-2026-1378" });
  await expect(encontrada).toContainText("Em atendimento");
  await expect(encontrada.locator(".ck-badge").filter({ hasText: "Conferida" })).toBeVisible();
  await expect(linhas.filter({ hasText: "UTIC-2026-1200" })).toContainText("Série não encontrada na importação atual.");
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="chamados-os"]').analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`), tema).toEqual([]);
  }
  // Busca: só o número da OS fica.
  await page.locator("#cockpit-chamados-os-busca").fill("7285070");
  await expect(linhas).toHaveCount(1);
  await encontrada.getByRole("button", { name: "Abrir a OS 7285070 na aba OS (F6)" }).click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("OS");
  await expect(page.locator('#cockpit-tickets-os tbody tr[data-serial="DEMO-SN-001"]').first()).toBeVisible();
  const voltar = page.locator('#cockpit-tool-panels [data-on-click="fecharPainelCockpit"]');
  await voltar.click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados × OS");
  await voltar.click();
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
});

test("Chamados × OS abre pela aba OS (F6), volta a ela e não rola na horizontal de 320 a 1366 px", async ({ page }) => {
  await prepararChamados(page);
  const naBarra = await page.locator("#btn-acompanhamento-chamados").isVisible();
  if (!naBarra) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra ? "#btn-acompanhamento-chamados" : "#btn-chamados-menu").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("OS");
  await page.locator("#btn-chamados-os-f6").click();
  const painel = page.locator('[data-cockpit-tool-panel="chamados-os"]');
  await expect(painel.locator("tbody tr")).toHaveCount(2);
  for (const largura of [320, 390, 768, 1366]) {
    await page.setViewportSize({ width: largura, height: 800 });
    await expect(painel.locator("tbody tr").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${largura}px`).toBe(true);
  }
  await page.locator('#cockpit-tool-panels [data-on-click="fecharPainelCockpit"]').click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("OS");
});
