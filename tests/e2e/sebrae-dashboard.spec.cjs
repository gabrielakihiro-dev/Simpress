const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// The fixture answers /api/sebrae/* with fictional tickets; no Chrome, SoftExpert or Dashboard file is touched.
async function abrirCartao(page, request) {
  await request.get("/__fixture_automacao?quantidade=0&sebrae=padrao&run=");
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const cartao = page.locator("#sebrae-novos-painel");
  await expect(cartao).toBeVisible();
  return cartao;
}

test("Chamados novos mostra o Dashboard importado, os formulários e os avisos de pendência e erro", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  await expect(cartao.locator("#sebrae-dashboard-status")).toContainText("331 chamados já lançados");
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("2 novo(s), 36 já no Dashboard, 1 pendente(s)");
  await expect(cartao.locator(".sebrae-chamado")).toHaveCount(2);
  await expect(cartao.locator(".sebrae-chamado").first()).toContainText("DEMO0001");
  await expect(cartao.locator(".sebrae-chamado").nth(1)).toContainText("mais de um equipamento");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1387: pendente");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1457: não foi lido");
  await expect(cartao.locator("#btn-sebrae-exportar")).toBeDisabled();
});

test("Chamados novos só exporta os prontos e mostra a mensagem aprovada com os dois blocos", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  const primeiro = cartao.locator(".sebrae-chamado").first();
  await primeiro.locator('[data-sebrae-campo="A"]').fill("CLIENTE");
  await primeiro.locator('[data-sebrae-campo="D"]').selectOption("EM ABERTO");
  await expect(cartao.locator("#btn-sebrae-exportar")).toBeDisabled();
  await primeiro.locator('[data-sebrae-campo="J"]').selectOption("INCIDENTE");
  await primeiro.locator('[data-sebrae-campo="R"]').fill("2026-10-28T09:05");
  await primeiro.locator('[data-sebrae-campo="S"]').fill("DISPONIBILIDADE");
  await expect(cartao.locator("#sebrae-exportacao-status")).toHaveText("1 de 2 chamado(s) com Responsável, Status e Tipo preenchidos.");
  await cartao.locator("#btn-sebrae-exportar").click();
  await expect(cartao.locator("#sebrae-exportacao-status")).toHaveText("Planilha Exportada com Sucesso!");
  await expect(cartao.locator("#sebrae-bloco-a-p")).toHaveValue("CLIENTE\t\tUTIC-2026-1378\tEM ABERTO");
  await expect(cartao.locator("#sebrae-bloco-r-s")).toHaveValue("28/10/2026 09:05\tDISPONIBILIDADE");
});

test("Chamados novos não tem violações de acessibilidade nos temas claro e escuro", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include("#sebrae-novos-painel").analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
  await expect(cartao).toBeVisible();
});

test("Histórico mostra os três últimos registros no cartão e abre o painel completo pelo botão", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  const mini = cartao.locator("#sebrae-historico-resumo li");
  await expect(mini).toHaveCount(3);
  await expect(mini.first()).toContainText("2 lidos, 36 já no Dashboard, 1 pendente, 1 com erro");
  await expect(mini.nth(1)).toContainText("Reimportado 2 vezes");
  await cartao.getByRole("button", { name: "Histórico", exact: true }).click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Histórico de importações do Dashboard Sebrae");
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-historico"]');
  await expect(painel.locator("#sebrae-historico-lista-corpo tr")).toHaveCount(3);
  await expect(painel.locator("#sebrae-historico-kpis")).toContainText("Importações");
  await painel.locator("#sebrae-historico-lista-corpo tr").nth(1).click();
  await expect(painel.locator("#sebrae-historico-detalhe-grupos")).toContainText("UTIC-2026-1200: EM ABERTO → FINALIZADO (encerrado em 27/10/2026 16:00)");
  await painel.locator("#sebrae-historico-filtro").selectOption("busca");
  await expect(painel.locator("#sebrae-historico-lista-corpo tr")).toHaveCount(1);
});

test("Histórico vira cartões no celular, sem rolagem horizontal, e passa no axe", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  await page.setViewportSize({ width: 360, height: 800 });
  await cartao.getByRole("button", { name: "Histórico", exact: true }).click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-historico"]');
  await expect(painel.locator("#sebrae-historico-lista-corpo td[data-label]").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="sebrae-historico"]').analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
});
