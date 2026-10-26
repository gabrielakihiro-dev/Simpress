const { test, expect } = require("@playwright/test");

test("Cockpit keeps one global search and one complete readiness disclosure", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".cockpit-bar__search #input-serial")).toHaveCount(1);
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
    await expect(locality.locator(".cockpit-summary-kpi-value")).toHaveText("1");
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
    await expect(page.locator('#cockpit-summary-kpis [data-metric="sincronizados"] .cockpit-summary-kpi-value')).toHaveText("0");
    await expect(page.locator("#cockpit-summary-rows tr")).toHaveCount(0);
    await expect(page.locator("#cockpit-summary-status")).toContainText("lista detalhada não é armazenada");

    // Compacto: as linhas viram cards rotulados (data-label) e o cabeçalho da tabela some.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#cockpit-summary-kpis [data-metric="divergencias_local"]').click();
    const cells = page.locator("#cockpit-summary-rows tr").first().locator("td");
    await expect(cells.first()).toHaveAttribute("data-label", "Série");
    await expect(cells.last()).toHaveAttribute("data-label", "Ação");
    await expect(page.locator(".cockpit-summary-table thead")).toBeHidden();

    await page.locator('#cockpit-summary-kpis [data-metric="sem_acesso_7_dias"]').click();
    await expect(page.locator("#cockpit-summary-table-title")).toHaveText("Sem acesso há 7+ dias · 1");
    await expect(page.locator("#cockpit-summary-rows")).toContainText("9 dias");
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

function overflowingRight(page, rootSelector) {
  return page.evaluate(selector => {
    const limit = document.documentElement.clientWidth + 1;
    return [...document.querySelectorAll(`${selector}, ${selector} *`)]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height || el.closest("[hidden], .hidden, .sr-only")) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || rect.right <= limit) return false;
        // Conteúdo dentro de um contêiner com rolagem horizontal própria (ex.: tabela do histórico) não estoura a página.
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= limit) return false;
        }
        return true;
      })
      .map(el => `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).split(" ")[0]}`);
  }, rootSelector);
}

for (const width of [320, 390, 768, 1024, 1200, 1440, 1920, 2560]) {
  test(`Cockpit bar and Home fit a ${width}px window without horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
    await expect(page.locator(".cockpit-bar")).toBeVisible();
    for (const id of ["tab-home", "tab-retirada-entrega", "tab-resumo", "tab-automacao", "cockpit-tools-trigger", "input-serial"]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    expect(await overflowingRight(page, ".cockpit-bar")).toEqual([]);
    expect(await overflowingRight(page, "#tab-panel-home")).toEqual([]);
    await page.locator("#cockpit-tools-trigger").click();
    await expect(page.locator("#btn-relatorio-mensal")).toBeVisible();
    expect(await overflowingRight(page, ".cockpit-bar")).toEqual([]);
  });
}

test("the compact bar keeps status behind an accessible toggle that Esc closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const toggle = page.locator("#cockpit-bar-status-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#cockpit-bar-status")).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#cockpit-automation-shell-status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await expect(page.locator("#cockpit-bar-status")).toBeHidden();
});

test("the wide bar has no status toggle and keeps the 240px search", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#cockpit-bar-status-toggle")).toBeHidden();
  await expect(page.locator("#cockpit-bar-status")).toBeVisible();
  const box = await page.locator(".cockpit-bar__search").boundingBox();
  expect(Math.round(box.width)).toBe(240);
  expect(Math.round((await page.locator(".cockpit-bar").boundingBox()).height)).toBe(48);
});

test("compact Home goes list -> detail -> back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#btn-home-voltar-lista")).toBeHidden();
  await page.locator("#home-equipment-list [role=option]").first().click();
  await expect(page.locator(".cockpit-home-detail")).toBeVisible();
  await expect(page.locator(".cockpit-home-list")).toBeHidden();
  await page.locator("#btn-home-voltar-lista").click();
  await expect(page.locator(".cockpit-home-list")).toBeVisible();
  await expect(page.locator("#btn-home-voltar-lista")).toBeHidden();
});

for (const width of [320, 390, 768, 1024, 1200, 1440, 1920, 2560]) {
  test(`Transporte, Resumo e Automação fit a ${width}px window without horizontal scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    for (const [tab, panel] of [["tab-retirada-entrega", "tab-panel-retirada-entrega"], ["tab-resumo", "tab-panel-resumo"], ["tab-automacao", "tab-panel-automacao"]]) {
      await page.locator(`#${tab}`).click();
      await expect(page.locator(`#${panel}`)).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
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
      await page.locator("#cockpit-tools-trigger").click();
      await expect(page.locator(`${button} kbd`)).toHaveText(key);
      await expect(page.locator(`${button} kbd`)).toBeVisible();
      await page.locator(button).click();
      const panel = page.locator(`[data-cockpit-tool-panel="${tool}"]`);
      await expect(panel).toBeVisible();
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      expect(dimensions.document, tool).toBeLessThanOrEqual(dimensions.viewport);
      expect(dimensions.body, tool).toBeLessThanOrEqual(dimensions.viewport);
      expect(await overflowingRight(page, "#cockpit-tool-panels"), tool).toEqual([]);
      await page.keyboard.press("Escape");
      await page.keyboard.press(key);
      await expect(panel, `${key} abre ${tool}`).toBeVisible();
    }
  });
}

test("compact Comparação rows become cards with data-label and full-value titles", async ({ page }) => {
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [toolComparison] } }));
  await page.route("**/api/historico-comparacoes/review-comparison", route => route.fulfill({ json: { evento: toolComparison } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-cockpit-comparacao").click();
  const row = page.locator(".cockpit-comparison-row").first();
  await expect(row).toContainText("LENTO");
  await expect(row.locator(":scope > *").first()).toHaveAttribute("data-label", "Série");
  await expect(row.locator(":scope > *").last()).toHaveAttribute("data-label", "Resultado");
  await expect(row.locator(":scope > *").nth(2)).toHaveAttribute("title", "Londrina");
  await expect(page.locator(".cockpit-comparison-columns")).toBeHidden();
  const ys = await row.locator(":scope > *").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().y));
  expect(ys[ys.length - 1]).toBeGreaterThan(ys[0]);
});

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
  const box = await dialog.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(421);
});

test("at 1920px and wider the shell stays centered at 1920px; below that it fills the window", async ({ page }) => {
  for (const [width, expected] of [[1919, 1919], [1920, 1920], [2560, 1920]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const box = await page.locator("#simpress-app-shell").boundingBox();
    expect(Math.round(box.width)).toBe(expected);
    expect(Math.round(box.x)).toBe(Math.round((width - expected) / 2));
  }
});

test("compact fields use 16px so iOS does not zoom on focus", async ({ page, isMobile }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(await page.locator("#input-serial").evaluate(el => getComputedStyle(el).fontSize)).toBe("16px");
  test.skip(isMobile, "o perfil móvel emula viewport de celular e ignora o redimensionamento largo");
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.locator("#input-serial").evaluate(el => getComputedStyle(el).fontSize)).toBe("12.5px");
});

test.describe("touch targets", () => {
  test.use({ hasTouch: true });
  for (const width of [320, 360, 375, 390, 768, 1024, 1366]) {
    test(`bar and Home controls are at least 44px with a coarse pointer at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      // Abaixo de 375px os botões da barra não cabem com 44px de largura; a altura de 44px vale sempre.
      const small = await page.evaluate(narrow => [...document.querySelectorAll(
        ".cockpit-bar button, .cockpit-bar summary, .cockpit-bar input, .cockpit-bar [role=tab], #tab-panel-home button, #tab-panel-home input, #tab-panel-home select")]
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width && !el.closest("[hidden], .hidden") && (r.height < 43.5 || (r.width < 43.5 && !(narrow && el.closest(".cockpit-bar") && !el.matches("input"))));
        })
        .map(el => `${el.id || el.className}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`), width < 375);
      expect(small).toEqual([]);
      // Nenhum controle principal da barra pode ficar coberto por outro (as abas invadiam o botão de status).
      const covered = await page.evaluate(() => [...document.querySelectorAll(
        ".cockpit-bar [role=tab], #cockpit-bar-status-toggle, #cockpit-tools-trigger, #btn-notificacoes, #theme-toggle, .cockpit-bar__search input")]
        .filter(el => {
          const r = el.getBoundingClientRect();
          if (!r.width) return false;
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !(top && (el === top || el.contains(top)));
        }).map(el => el.id || el.className));
      expect(covered).toEqual([]);
      expect(await overflowingRight(page, ".cockpit-bar")).toEqual([]);
    });
  }
});

// Telas baixas: nada fica preso atrás de overflow:hidden e cada controle chega à janela por rolagem.
function unreachableControls(page, rootSelector) {
  return page.evaluate(root => {
    const lost = [];
    const bar = document.querySelector(".cockpit-bar").getBoundingClientRect().bottom;
    for (const el of document.querySelectorAll(`${root} :is(button, a[href], input, select, textarea, summary)`)) {
      if (el.closest("[hidden], .hidden, [inert]") || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
      // Conteúdo de <details> recolhido só aparece ao abrir; o próprio <summary> continua alcançável.
      if ([...document.querySelectorAll("details:not([open])")].some(d => d.contains(el) && !d.querySelector(":scope > summary")?.contains(el))) continue;
      const name = el.id || String(el.className).split(" ")[0] || el.tagName;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const r = el.getBoundingClientRect();
        const ar = a.getBoundingClientRect();
        if (/(hidden|clip)/.test(cs.overflowY) && (r.bottom > ar.bottom + 1 || r.top < ar.top - 1)) { lost.push(`${name} cortado por ${a.id || a.className}`); break; }
      }
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      if (r.top < bar - 1 || r.bottom > innerHeight + 1) lost.push(`${name} fora da janela após rolar`);
    }
    return lost;
  }, rootSelector);
}

for (const [width, height] of [[844, 390], [1024, 500]]) {
  test(`Home and Automação stay reachable in a short ${width}x${height} window`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator("#home-equipment-list [role=option]")).toHaveCount(1);
    await page.locator("#home-equipment-list [role=option]").first().click();
    expect(await unreachableControls(page, "#tab-panel-home")).toEqual([]);
    expect(await overflowingRight(page, "#tab-panel-home")).toEqual([]);

    await page.locator("#tab-automacao").click();
    await expect(page.locator("#tab-panel-automacao")).toBeVisible();
    expect(await unreachableControls(page, "#tab-panel-automacao")).toEqual([]);
    expect(await overflowingRight(page, "#tab-panel-automacao")).toEqual([]);
    const dims = await page.evaluate(() => ({ d: document.documentElement.scrollWidth, v: document.documentElement.clientWidth }));
    expect(dims.d).toBeLessThanOrEqual(dims.v);
  });
}
