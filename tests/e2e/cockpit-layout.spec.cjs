const { test, expect } = require("@playwright/test");

test("Cockpit keeps one global search and one complete readiness disclosure", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".ck-busca #input-serial")).toHaveCount(1);
  await expect(page.locator("#btn-buscar-serial")).toBeVisible();
  for (const id of [
    "readiness-panel",
    "readiness-title",
    "readiness-summary",
    "readiness-summary-short",
    "readiness-details-content",
  ]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
});

test("Home loads the real first page and derives its total from the API", async ({ page }) => {
  const listRequest = page.waitForRequest(request =>
    new URL(request.url()).pathname === "/api/buscar-expandida"
      && new URL(request.url()).searchParams.get("listar_todos") === "true");
  await page.goto("/");

  const request = await listRequest;
  expect(new URL(request.url()).searchParams.get("limit")).toBe("50");
  await expect(page.locator("#home-filter-total")).toHaveText("1");
  await expect(page.locator("#home-equipment-list [role=option]")).toHaveCount(1);
  await expect(page.locator("#home-equipment-list")).toContainText("LENTO");
});

test("Resumo uses the latest comparison and opens its series in Home", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  try {
    await page.goto("/");
    await page.locator("#tab-resumo").click();

    const locality = page.locator('#cockpit-summary-kpis [data-metric="divergencias_local"]');
    await expect(locality.locator(".ck-kpi__valor")).toHaveText("1");
    await expect(page.locator("#cockpit-summary-rows tr")).toHaveCount(1);
    await expect(page.locator("#cockpit-summary-rows")).toContainText("LENTO");
    await expect(page.locator("#cockpit-summary-rows tr").first().locator("td").nth(2)).toHaveText("Londrina");
    await expect(page.locator("#cockpit-summary-rows tr").first().locator("td").nth(3)).toHaveText("Curitiba");
    await expect(page.locator("#cockpit-summary-region-list")).toContainText("Curitiba");

    await page.locator('#cockpit-summary-kpis [data-metric="total"]').click();
    await expect(page.locator("#cockpit-summary-rows tr")).toHaveCount(1);
    await expect(page.locator("#cockpit-summary-rows")).toContainText("Na base local");
    await expect(page.locator("#cockpit-summary-count")).toHaveText("Mostrando 1–1 de 1");

    await page.locator('#cockpit-summary-kpis [data-metric="sincronizados"]').click();
    await expect(page.locator('#cockpit-summary-kpis [data-metric="sincronizados"] .ck-kpi__valor')).toHaveText("0");
    await expect(page.locator("#cockpit-summary-rows tr")).toHaveCount(0);
    await expect(page.locator("#cockpit-summary-status")).toContainText("lista detalhada não é armazenada");

    await page.locator('#cockpit-summary-kpis [data-metric="sem_acesso_7_dias"]').click();
    await expect(page.locator("#cockpit-summary-table-title")).toHaveText("Sem acesso há 7+ dias · 1");
    await expect(page.locator("#cockpit-summary-rows")).toContainText("9 dias");
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

test("Home status badges are buttons that open Comparação and Resumo without opening the equipment", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  try {
    await page.goto("/");
    const equipmentRequests = [];
    page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/equipamento/")) equipmentRequests.push(req.url()); });
    const row = page.locator("#home-equipment-list [role=option]").first();
    await expect(row.locator("button.ck-status--link")).toHaveCount(2);

    const divergent = row.locator('button.ck-status--link[data-destino="comparacao"]');
    const stale = row.locator('button.ck-status--link[data-destino="resumo"]');
    await expect(divergent).toHaveAccessibleName(/Divergente: abrir LENTO/);
    await expect(stale).toHaveAccessibleName(/abrir LENTO na aba Resumo/);

    await stale.click();
    await expect(page.locator("#tab-resumo")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('#cockpit-summary-kpis [data-metric="sem_acesso_7_dias"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#cockpit-summary-rows tr.ck-linha-destaque")).toHaveCount(1);

    await page.locator("#tab-home").click();
    await divergent.click();
    await expect(page.locator("#cockpit-comparison-list .ck-linha-destaque, #cockpit-comparison-list [data-row-key].ck-linha-destaque").first()).toBeVisible();
    await expect(page.locator("#cockpit-comparison-list")).toContainText("LENTO");
    await expect(page.locator('[aria-label="Filtrar resultados da comparação"] button[aria-pressed="true"]')).toContainText("Localidade");
    expect(equipmentRequests).toEqual([]);
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

test("Home filters are an equal-width segmented control and the footer keeps Lista sem usuário", async ({ page }) => {
  await page.goto("/");
  const widths = await page.locator(".ck-filtros .ck-filtro").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().width)));
  expect(widths).toHaveLength(4);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  const clipped = await page.locator(".ck-filtros .ck-filtro").evaluateAll(els => els.filter(el => el.scrollWidth > el.clientWidth).map(el => el.dataset.filter));
  expect(clipped).toEqual([]);
  await expect(page.locator(".ck-lista__rodape #btn-listar-sem-usuario")).toHaveText("Lista sem usuário");
});

test("Cockpit never scrolls horizontally in narrow or wide windows", async ({ page }) => {
  await page.goto("/");
  for (const width of [320, 390, 768, 1199, 1200, 1440, 2560]) {
    await page.setViewportSize({ width, height: 844 });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document, `document at ${width}px`).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body, `body at ${width}px`).toBeLessThanOrEqual(dimensions.viewport);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#cockpit-tools-trigger").click();
  await expect(page.locator("#btn-relatorio-mensal")).toBeVisible();
});

function overflowingRight(page, rootSelector) {
  return page.evaluate(selector => {
    const limit = document.documentElement.clientWidth + 1;
    return [...document.querySelectorAll(`${selector}, ${selector} *`)]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.right <= limit) return false;
        if (getComputedStyle(el).visibility === "hidden") return false;
        // Conteúdo dentro de um contêiner com rolagem horizontal própria não estoura a página.
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= limit) return false;
        }
        return true;
      })
      .map(el => `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).split(" ")[0]}`);
  }, rootSelector);
}

for (const width of [320, 390, 768, 1024, 1200, 1440, 1920, 2560]) {
  test(`every tab fits a ${width}px window without horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    for (const [tab, panel] of [["tab-home", "tab-panel-home"], ["tab-retirada-entrega", "tab-panel-retirada-entrega"], ["tab-resumo", "tab-panel-resumo"], ["tab-automacao", "tab-panel-automacao"]]) {
      await page.locator(`#${tab}`).click();
      await expect(page.locator(`#${panel}`)).toBeVisible();
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      expect(dimensions.document, panel).toBeLessThanOrEqual(dimensions.viewport);
      expect(dimensions.body, panel).toBeLessThanOrEqual(dimensions.viewport);
      expect(await overflowingRight(page, `#${panel}`), panel).toEqual([]);
    }
  });
}

const toolComparison = {
  id: "review-comparison", horario: "2026-10-24T09:00:00-03:00", tipo: "atualizacao",
  comparacao: {
    total_detalhes: 2, total_endpoint: 2, equipamentos_sincronizados: 1,
    divergencias_local: [{ serie: "LENTO", modelo: "Notebook de demonstração", local_detalhes: "Londrina", local_previsto: "Curitiba" }],
    ausentes_no_endpoint: [], ausentes_em_detalhes: [],
  },
};
const toolButtons = [["#btn-acompanhamento-chamados", "chamados", "F5"], ["#btn-cockpit-comparacao", "comparacao", "F6"], ["#btn-historico-apelidos", "apelidos", "F7"], ["#btn-relatorio-mensal", "relatorio", "F8"]];

for (const width of [320, 390, 768, 1024, 1200, 1440, 1920, 2560]) {
  test(`tool panels fit a ${width}px window and keep the F5–F8 shortcuts`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [toolComparison] } }));
    await page.route("**/api/historico-comparacoes/review-comparison", route => route.fulfill({ json: { evento: toolComparison } }));
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    for (const [button, tool, key] of toolButtons) {
      const naBarra = tool === "chamados" && width >= 1200;
      if (naBarra) await expect(page.locator(button)).toHaveAttribute("title", `Chamados (${key})`);
      else {
        await page.locator("#cockpit-tools-trigger").click();
        await expect(page.locator(`${tool === "chamados" ? "#btn-chamados-menu" : button} kbd`)).toHaveText(key);
      }
      await page.locator(tool === "chamados" && !naBarra ? "#btn-chamados-menu" : button).click();
      const panel = page.locator(`[data-cockpit-tool-panel="${tool}"]`);
      await expect(panel).toBeVisible();
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      expect(dimensions.document, tool).toBeLessThanOrEqual(dimensions.viewport);
      expect(dimensions.body, tool).toBeLessThanOrEqual(dimensions.viewport);
      expect(await overflowingRight(page, "#cockpit-tool-panels"), tool).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await page.keyboard.press(key);
      await expect(panel, `${key} abre ${tool}`).toBeVisible();
    }
  });
}

test("a real modal stays reachable on a short compact screen", async ({ page }) => {
  await page.route("**/api/historico-alteracoes", route => route.fulfill({ json: { eventos: [], total: 0 } }));
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto("/");
  await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-historico-apelidos").click();
  await page.locator("#cockpit-alias-legacy").click();
  const dialog = page.getByRole("dialog", { name: "Histórico de alterações" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("[aria-label='Fechar histórico']")).toBeInViewport();
});
