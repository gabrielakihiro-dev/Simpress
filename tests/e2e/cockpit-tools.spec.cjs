const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

async function openTool(page, id) {
  const menu = page.locator("#cockpit-tools-dropdown");
  // Chamados fica na barra principal; abaixo de 1200px a barra o esconde e o menu Ferramentas o oferece.
  const naBarra = id === "#btn-acompanhamento-chamados" && await page.locator(id).isVisible();
  if (!naBarra && !(await menu.evaluate(node => node.open))) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra || id !== "#btn-acompanhamento-chamados" ? id : "#btn-chamados-menu").click();
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
}

const comparison = {
  id: "review-comparison", horario: "2026-10-24T09:00:00-03:00", tipo: "atualizacao",
  comparacao: {
    total_detalhes: 2, total_endpoint: 2, equipamentos_sincronizados: 1,
    divergencias_local: [{ serie: "LENTO", modelo: "Notebook de demonstração", local_detalhes: "Londrina", local_previsto: "Curitiba" }],
    ausentes_no_endpoint: [], ausentes_em_detalhes: [],
  },
};

async function mockComparison(page) {
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [comparison] } }));
  await page.route("**/api/historico-comparacoes/review-comparison", route => route.fulfill({ json: { evento: comparison } }));
}

test("Home hides the unselected equipment and never displays reference serials", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#home-detail-empty")).toBeAttached();
  await expect(page.locator("#card-equipamento")).toBeHidden();
  await expect(page.locator("#card-serial")).not.toHaveText("5CG6051BVN");
});

test("main navigation shortcuts and Ctrl+K leave the active tool", async ({ page }) => {
  await page.goto("/");
  for (const [key, panel] of [["F1", "home"], ["F2", "retirada-entrega"], ["F3", "resumo"], ["F4", "automacao"], ["Control+k", "home"]]) {
    await openTool(page, "#btn-acompanhamento-chamados");
    await page.keyboard.press(key);
    await expect(page.locator("#cockpit-tool-panels"), key).toBeHidden();
    await expect(page.locator(`#tab-panel-${panel}`), key).toBeVisible();
  }
  await expect(page.locator("#input-serial")).toBeFocused();
});

test("closing a tool returns keyboard focus to its visible trigger", async ({ page }) => {
  await page.goto("/");
  await openTool(page, "#btn-acompanhamento-chamados");
  await page.keyboard.press("Escape");
  const naBarra = await page.locator("#btn-acompanhamento-chamados").isVisible();
  await expect(page.locator(naBarra ? "#btn-acompanhamento-chamados" : "#cockpit-tools-trigger")).toBeFocused();
});

test("comparison fields stay in columns and survive an empty history refresh", async ({ page }) => {
  await mockComparison(page);
  await page.goto("/");
  await openTool(page, "#btn-cockpit-comparacao");
  const row = page.locator(".cockpit-comparison-row").first();
  await expect(row).toContainText("LENTO");
  const cells = await row.locator(":scope > *").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
  // Compacto (< 768px): a linha vira card e os campos empilham; a partir de 768px ficam em colunas.
  if (page.viewportSize().width >= 768) expect(Math.max(...cells) - Math.min(...cells)).toBeLessThan(5);
  else expect(Math.max(...cells)).toBeGreaterThan(Math.min(...cells));
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [] } }));
  await page.locator("#cockpit-comparison-refresh").click();
  await expect(page.locator("#cockpit-comparison-export")).toBeDisabled();
  await expect(page.locator("#cockpit-comparison-list")).not.toContainText("LENTO");
});

test("each tool is accessible in both themes and remains reachable below 1200px", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await mockComparison(page);
  await page.goto("/");
  for (const [id, tool] of [["#btn-acompanhamento-chamados", "chamados"], ["#btn-cockpit-comparacao", "comparacao"], ["#btn-historico-apelidos", "apelidos"], ["#btn-relatorio-mensal", "relatorio"], ["#btn-sebrae-chamados-menu", "sebrae-chamados"]]) {
    await openTool(page, id);
    for (const theme of ["dark", "light"]) {
      await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
      const selector = `[data-cockpit-tool-panel="${tool}"]`;
      const audit = await new AxeBuilder({ page }).include(selector).analyze();
      expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), `${tool} ${theme}`).toEqual([]);

      const bounds = await page.locator(selector).boundingBox();
      const width = await page.evaluate(() => document.body.scrollWidth);
      expect(bounds.width).toBeLessThanOrEqual(width + 1);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    }
  }
});


test("visual snapshots cover the Cockpit workspaces", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await mockComparison(page);
  await page.goto("/");
  const phase = process.env.COCKPIT_PRINT_PHASE || "depois";
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    await page.locator("#tab-home").click();
    for (const [id, name] of [["#tab-home", "home"], ["#tab-retirada-entrega", "transporte"], ["#tab-resumo", "resumo"], ["#tab-automacao", "automacao"]]) {
      await page.locator(id).click();
      await page.screenshot({ path: `.claude/prints/cockpit-review/${phase}-${name}-${testInfo.project.name}-${theme}.png`, fullPage: true });
    }
    for (const [id, name] of [["#btn-acompanhamento-chamados", "chamados"], ["#btn-cockpit-comparacao", "comparacao"], ["#btn-historico-apelidos", "apelidos"], ["#btn-relatorio-mensal", "relatorio"]]) {
      await openTool(page, id);
      await page.screenshot({ path: `.claude/prints/cockpit-review/${phase}-${name}-${testInfo.project.name}-${theme}.png`, fullPage: true });
    }
  }
});


test("Home ticket pills show the selected original template and copy that template", async ({ page }) => {
  await page.goto("/");
  await page.locator("#home-equipment-list [role=option]").first().click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await expect(page.locator("#home-detail-empty")).toBeHidden();
  await page.locator("#pill-chamado-deslocamento").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#pill-chamado-teclado-mouse")).toBeFocused();
  await expect(page.locator("#pill-chamado-teclado-mouse")).toHaveAttribute("aria-selected", "true");
  for (const type of ["deslocamento", "teclado-mouse", "mau-funcionamento", "uso-inadequado"]) {
    await page.locator(`#pill-chamado-${type}`).click();
    await expect(page.locator(`#visualizacao-chamado-${type}`)).toBeVisible();
    await expect(page.locator(`#pill-chamado-${type}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#btn-copiar-chamado-atual")).toHaveAttribute("data-args", JSON.stringify([`texto-chamado-${type}`]));
  }
});

test("comparison skips restoration and synchronized-note entries and uses the Endpoint user contract", async ({ page }) => {
  const restored = { id: "restored", horario: "2026-10-25", tipo: "restauracao" };
  const notes = { id: "notes", horario: "2026-10-25", somente_anotacoes_sincronizadas: true };
  await mockComparison(page);
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [restored, notes, comparison] } }));
  await page.route("**/api/historico-comparacoes/review-comparison", route => route.fulfill({ json: { evento: {
    ...comparison, comparacao: { ...comparison.comparacao, ausentes_em_detalhes: [{ serie: "SN-ENDPOINT", usuario: "usuario.endpoint", local_previsto: "Curitiba" }] },
  } } }));
  await page.goto("/");
  await openTool(page, "#btn-cockpit-comparacao");
  await expect(page.locator("#cockpit-comparison-event")).toHaveValue(comparison.id);
  await expect(page.locator("#cockpit-comparison-kpis")).toContainText("Correspondentes");
  await expect(page.locator("#cockpit-comparison-list")).toContainText("usuario.endpoint");
  await expect(page.locator("#cockpit-comparison-export")).toHaveText("Exportar comparações do dia");
});

test("a failed comparison switch cannot export the previously displayed event", async ({ page }) => {
  await mockComparison(page);
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [comparison, { id: "failed", horario: "2026-10-23", tipo: "atualizacao" }] } }));
  let release;
  await page.route("**/api/historico-comparacoes/failed", async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: 503, json: { detail: "Não foi possível abrir a versão." } });
  });
  await page.goto("/");
  await openTool(page, "#btn-cockpit-comparacao");
  await expect(page.locator("#cockpit-comparison-export")).toBeEnabled();
  await page.locator("#cockpit-comparison-event").selectOption("failed");
  await expect(page.locator("#cockpit-comparison-export")).toBeDisabled();
  await expect(page.locator("#cockpit-comparison-list")).not.toContainText("LENTO");
  await expect.poll(() => typeof release).toBe("function");
  release();
  await expect(page.locator("#cockpit-comparison-status")).toContainText("Não foi possível abrir a versão.");
  await expect(page.locator("#cockpit-comparison-export")).toBeDisabled();
});


test("typing stays error-free and Home shortcuts use the selected equipment", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await page.locator("#home-equipment-list [role=option]").first().click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await page.keyboard.press("e");
  // v2: a tecla E liga a edição cadastral em linha (sem modal); Esc cancela.
  await expect(page.locator("#btn-editar-equipamento")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modal-editar-equipamento")).toBeHidden();
  await expect(page.locator("input[data-campo-edicao]").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#btn-editar-equipamento")).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => { window.copiarTextoParaAreaTransferencia = async text => { window.reviewCopiedText = text; }; });
  await page.keyboard.press("c");
  await expect.poll(() => page.evaluate(() => window.reviewCopiedText)).toContain("Prezados");
  await page.keyboard.press("t");
  await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible();
  await page.locator("#tab-home").click();
  await page.locator("#btn-clear-serial").click();
  await expect(page.locator("#home-detail-empty")).toBeAttached();
  await expect(page.locator("#card-equipamento")).toBeHidden();
  expect(errors).toEqual([]);
});


test("tool shortcuts cannot submit the hidden transfer form and Escape closes one layer", async ({ page }) => {
  await page.goto("/");
  await page.locator("#tab-retirada-entrega").click();
  await page.evaluate(() => {
    window.reviewTransferClicks = 0;
    const button = document.getElementById("btn-gerar-planilha");
    button.disabled = false;
    button.addEventListener("click", event => {
      event.stopImmediatePropagation();
      window.reviewTransferClicks += 1;
    });
  });
  await openTool(page, "#btn-acompanhamento-chamados");
  await page.keyboard.press("Control+Enter");
  expect(await page.evaluate(() => window.reviewTransferClicks)).toBe(0);
  await page.locator("#cockpit-tools-trigger").click();
  await expect(page.locator("#cockpit-tools-dropdown")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tools-dropdown")).not.toHaveAttribute("open", "");
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
});

test("o item Chamados Sebrae do menu abre o painel e volta com Esc", async ({ page }) => {
  await page.goto("/");
  await page.locator("#cockpit-tools-trigger").click();
  await expect(page.locator("#btn-sebrae-chamados-menu")).toHaveText("Chamados Sebrae");
  await openTool(page, "#btn-sebrae-chamados-menu");
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados Sebrae");
  await expect(page.locator('[data-cockpit-tool-panel="sebrae-chamados"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
});
