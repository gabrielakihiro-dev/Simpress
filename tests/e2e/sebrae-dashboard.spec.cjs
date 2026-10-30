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

// A lista, os antigos, a exportação e Atualizar Dashboard moram no painel Chamados Sebrae (menu Ferramentas ou botão do cartão).
async function abrirPainel(page, request) {
  const cartao = await abrirCartao(page, request);
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("novo(s)"); // a lista já foi carregada
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  return { cartao, painel };
}

test("Chamados novos mostra o Dashboard importado, os formulários e os avisos de pendência e erro", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  await expect(cartao.locator("#sebrae-dashboard-status")).toContainText("331 chamados já lançados");
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("2 novo(s), 36 já no Dashboard, 1 pendente(s)");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1387: pendente");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1457: não foi lido");
  // O cartão não lista mais os chamados: só o botão que abre o painel.
  await expect(cartao.locator("#sebrae-novos-lista, #btn-sebrae-exportar, #btn-sebrae-atualizar")).toHaveCount(0);
  await expect(cartao.locator("#btn-sebrae-abrir-chamados")).toHaveText("Chamados Sebrae");
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados Sebrae");
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado")).toHaveCount(2);
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado").first()).toContainText("DEMO0001");
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado").nth(1)).toContainText("mais de um equipamento");
  await expect(painel.locator("#btn-sebrae-exportar")).toBeDisabled();
});

test("Chamados novos só exporta os prontos e mostra a mensagem aprovada com os dois blocos", async ({ page, request }) => {
  const { painel: cartao } = await abrirPainel(page, request);
  const primeiro = cartao.locator("#sebrae-novos-lista .sebrae-chamado").first();
  await primeiro.locator('[data-sebrae-campo="A"]').selectOption("CLIENTE"); // lista da aba LISTAS do Dashboard
  await expect(primeiro.locator('[data-sebrae-campo="D"]')).toHaveValue("EM ABERTO"); // padrão dos novos
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
  const { painel: cartao } = await abrirPainel(page, request);
  const atualizar = cartao.locator("#btn-sebrae-atualizar");
  await expect(atualizar).toBeEnabled(); // os 2 chamados novos da fixture já bastam; antes de a lista carregar o botão nasce desabilitado
  await cartao.locator("#sebrae-antigos > summary").click();
  const antigo = cartao.locator("#sebrae-antigos-lista .sebrae-chamado");
  await expect(antigo).toHaveCount(1);
  await expect(antigo.locator('[data-sebrae-campo="A"]')).toHaveValue("SIMPRESS");
  // O que o Atualizar Dashboard vai preencher aparece como prévia, sem virar campo editável.
  await expect(antigo.locator(".sebrae-chamado__auto")).toContainText("Camila Vitoria Lopes de Oliveira");
  await expect(antigo.locator(".sebrae-chamado__auto")).toContainText("DEMO0001 (será preenchido)");
  await expect(antigo.locator(".sebrae-chamado__auto")).toContainText("7303022 (será preenchido)");
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await antigo.locator('[data-sebrae-campo="R"]').fill("2026-10-28T09:05");
  await expect(cartao.locator("#sebrae-antigos-resumo")).toContainText("1 com alteração");
  await expect(atualizar).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent("download"), atualizar.click()]);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  await expect(cartao.locator("#sebrae-atualizar-status")).toContainText("2 novo(s) e 1 alterado(s)");
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

test("Chamados Sebrae abre pelo menu Ferramentas, sem recarregar a lista, e passa no axe nos dois temas", async ({ page, request }) => {
  await abrirCartao(page, request);
  await expect(page.locator("#sebrae-novos-resumo")).toContainText("novo(s)");
  await page.locator("#cockpit-tools-trigger").click();
  const item = page.locator("#btn-sebrae-chamados-menu");
  await expect(item).toHaveText("Chamados Sebrae");
  await expect(item.locator("kbd, .ck-badge")).toHaveCount(0);
  await item.click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados Sebrae");
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado")).toHaveCount(2);
  // Abrir o painel de novo não pode zerar o que foi preenchido nos chamados antigos.
  await painel.locator("#sebrae-antigos > summary").click();
  const antigo = painel.locator("#sebrae-antigos-lista .sebrae-chamado");
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await page.locator("#cockpit-tools-trigger").click();
  await item.click();
  await expect(antigo.locator('[data-sebrae-campo="D"]')).toHaveValue("FINALIZADO");
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="sebrae-chamados"]').analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
});

test("Chamados Sebrae não tem rolagem horizontal de 320px a 2560px", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request);
  for (const largura of [320, 360, 768, 1280, 2560]) {
    await page.setViewportSize({ width: largura, height: 800 });
    await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${largura}px`).toBe(true);
  }
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
