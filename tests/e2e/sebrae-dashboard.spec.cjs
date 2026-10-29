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
  await expect(cartao.locator("#sebrae-novos-lista .sebrae-chamado")).toHaveCount(2);
  await expect(cartao.locator("#sebrae-novos-lista .sebrae-chamado").first()).toContainText("DEMO0001");
  await expect(cartao.locator("#sebrae-novos-lista .sebrae-chamado").nth(1)).toContainText("mais de um equipamento");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1387: pendente");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1457: não foi lido");
  await expect(cartao.locator("#btn-sebrae-exportar")).toBeDisabled();
});

test("Chamados novos só exporta os prontos e mostra a mensagem aprovada com os dois blocos", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  const primeiro = cartao.locator("#sebrae-novos-lista .sebrae-chamado").first();
  await primeiro.locator('[data-sebrae-campo="A"]').selectOption("CLIENTE"); // lista da aba LISTAS do Dashboard
  await primeiro.locator('[data-sebrae-campo="D"]').selectOption("EM ABERTO");
  await expect(cartao.locator("#btn-sebrae-exportar")).toBeDisabled();
  await primeiro.locator('[data-sebrae-campo="J"]').selectOption("INCIDENTE");
  await primeiro.locator('[data-sebrae-campo="R"]').fill("2026-10-28T09:05");
  await expect(primeiro.locator('[data-sebrae-campo="S"]')).toHaveValue("DISPONIBILIDADE"); // padrão, sem preencher
  await expect(cartao.locator("#sebrae-exportacao-status")).toHaveText("1 de 2 chamado(s) com Responsável, Status e Tipo preenchidos.");
  await cartao.locator("#btn-sebrae-exportar").click();
  await expect(cartao.locator("#sebrae-exportacao-status")).toHaveText("Planilha Exportada com Sucesso!");
  await expect(cartao.locator("#sebrae-bloco-a-p")).toHaveValue("CLIENTE\t\tUTIC-2026-1378\tEM ABERTO");
  await expect(cartao.locator("#sebrae-bloco-r-s")).toHaveValue("28/10/2026 09:05\tDISPONIBILIDADE");
});

test("Atualizar Dashboard baixa a cópia com os novos e as alterações dos antigos, sem tocar no original", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  const atualizar = cartao.locator("#btn-sebrae-atualizar");
  await expect(atualizar).toBeDisabled();
  await cartao.locator("#sebrae-antigos > summary").click();
  const antigo = cartao.locator("#sebrae-antigos-lista .sebrae-chamado");
  await expect(antigo).toHaveCount(1);
  await expect(antigo.locator('[data-sebrae-campo="A"]')).toHaveValue("SIMPRESS");
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await antigo.locator('[data-sebrae-campo="R"]').fill("2026-10-28T09:05");
  await expect(cartao.locator("#sebrae-antigos-resumo")).toContainText("1 com alteração");
  await expect(atualizar).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent("download"), atualizar.click()]);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE (atualizado).xlsx");
  await expect(cartao.locator("#sebrae-atualizar-status")).toContainText("0 novo(s) e 1 alterado(s)");
  await expect(cartao.locator("#sebrae-atualizar-status")).toContainText("importe a versão atual antes");
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
