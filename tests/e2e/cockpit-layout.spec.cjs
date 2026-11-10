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

test("Home exposes status actions outside its listbox and keyboard activation opens the correct panels", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  try {
    await page.goto("/");
    const equipmentRequests = [];
    page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/equipamento/")) equipmentRequests.push(req.url()); });
    const row = page.locator("#home-equipment-list [role=option]").first();
    await expect(row).toContainText("Divergente");
    await expect(row.locator("button")).toHaveCount(0);

    const list = page.locator("#home-equipment-list");
    await list.focus();
    await page.keyboard.press("ArrowDown");
    await expect(list).toHaveAttribute("aria-activedescendant", await row.getAttribute("id"));
    const actions = page.locator("#home-equipment-actions");
    await expect(actions).toHaveAccessibleName("Ações de LENTO");
    const staleAccess = actions.locator('button[data-categoria="sem_acesso_7_dias"]');
    const divergent = actions.locator('button[data-categoria="divergencias_local"]');
    await expect(actions.locator("button[data-destino]")).toHaveCount(2);
    await expect(staleAccess).toHaveAccessibleName("Sem acesso 7+ d: abrir LENTO no Resumo (F3)");
    await expect(divergent).toHaveAccessibleName("Divergente: abrir LENTO no Resumo (F3)");
    await expect(divergent).toHaveAttribute("title", "Abrir no Resumo");

    await page.keyboard.press("Tab");
    await expect(staleAccess).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-cockpit-tool-panel="comparacao"]')).toBeVisible();
    await expect(page.locator('#comparacao-planilhas-conteudo [data-comparison-category="sem_acesso_7_dias"][data-comparison-serial="LENTO"]:visible').first()).toBeInViewport();

    await page.keyboard.press("Escape");
    await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
    await list.focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(divergent).toBeFocused();
    await page.keyboard.press("Space");
    // A série abre no Resumo já posicionada na linha dela dentro do resultado completo.
    await expect(page.locator('[data-cockpit-tool-panel="comparacao"]')).toBeVisible();
    const target = page.locator('#comparacao-planilhas-conteudo [data-comparison-category="divergencias_local"][data-comparison-serial="LENTO"]:visible').first();
    await expect(target).toContainText("LENTO");
    await expect(target).toBeInViewport();
    await expect(page.locator("#comparacao-planilhas-conteudo")).toContainText("Localidade divergente");
    expect(equipmentRequests).toEqual([]);
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

test("Resumo: irParaSecaoComparacao clears the active filters that hide the target section", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  try {
    await page.goto("/");
    await page.locator("#btn-resumo-aba").click();
    await expect(page.locator('[data-cockpit-tool-panel="comparacao"]')).toBeVisible();
    await page.locator("#resumo-aba-sem-acesso").click();
    const heading = page.locator("#comparacao-secao-sem-acesso-7");
    await expect(heading).toBeVisible();
    // LENTO (Sem acesso 7+) não tem anotação: "Só anotadas" esconde a seção inteira.
    const annotated = page.locator("#comparacao-planilhas-conteudo [data-history-filter-annotated]");
    await annotated.check();
    await expect(heading).toBeHidden();

    expect(await page.evaluate(() => window.irParaSecaoComparacao("comparacao-secao-sem-acesso-7"))).toBe(true);
    await expect(heading).toBeVisible();
    await expect(annotated).not.toBeChecked();
    await expect(page.locator("#comparacao-planilhas-conteudo [data-history-filter-category]")).toHaveValue("");
    await expect(page.locator("#comparacao-planilhas-conteudo [data-history-filter-search]")).toHaveValue("");
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

test("Resumo: KPI e irParaSecaoComparacao abrem a sub-aba da seção antes de rolar até ela", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  try {
    await page.goto("/");
    await page.locator("#btn-resumo-aba").click();
    await expect(page.locator("#resumo-aba-visao")).toHaveAttribute("aria-selected", "true");
    // O KPI mora em Visão geral; a seção "Localidade divergente" mora em Divergências.
    await page.locator('#comparacao-planilhas-conteudo [data-comparison-section-target="comparacao-secao-localidade-divergente"]').click();
    await expect(page.locator("#resumo-aba-divergencias")).toHaveAttribute("aria-selected", "true");
    const divergente = page.locator("#comparacao-secao-localidade-divergente");
    await expect(divergente).toBeVisible();
    await expect(divergente).toBeInViewport();

    // Sem clicar na aba antes: a seção "Sem acesso há 7 dias" abre a aba Sem acesso sozinha.
    await page.locator("#resumo-aba-visao").click();
    await expect(divergente).toBeHidden();
    expect(await page.evaluate(() => window.irParaSecaoComparacao("comparacao-secao-sem-acesso-7"))).toBe(true);
    await expect(page.locator("#resumo-aba-sem-acesso")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#comparacao-secao-sem-acesso-7")).toBeVisible();
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

test("Resumo: navegarParaLinhaComparacao abre a sub-aba da linha antes de procurá-la", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  try {
    await page.goto("/");
    await page.locator("#btn-resumo-aba").click();
    // Visão geral já vem selecionada antes do render: espera as linhas (mesmo ocultas) existirem.
    await expect(page.locator('#comparacao-planilhas-conteudo [data-comparison-category="sem_acesso_60_dias"]').first()).toBeAttached();
    await expect(page.locator("#resumo-aba-visao")).toHaveAttribute("aria-selected", "true");
    // SAIU60 só existe em "Passou de 60 dias sem acesso" (aba Sem acesso), aqui sem categoria.
    await page.evaluate(() => window.navegarParaLinhaComparacao({ serial: "SAIU60" }));
    await expect(page.locator("#resumo-aba-sem-acesso")).toHaveAttribute("aria-selected", "true");
    const saiu = page.locator('#comparacao-planilhas-conteudo [data-comparison-category="sem_acesso_60_dias"][data-comparison-serial="SAIU60"]:visible').first();
    await expect(saiu).toBeInViewport();

    // LENTO está em duas abas e a chamada vem sem categoria: vale a categoria de maior prioridade (PRIORIDADE_CATEGORIAS_SERIE), Divergências.
    await page.locator("#resumo-aba-visao").click();
    await page.evaluate(() => window.navegarParaLinhaComparacao({ serial: "LENTO" }));
    await expect(page.locator("#resumo-aba-divergencias")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('#comparacao-planilhas-conteudo [data-comparison-category="divergencias_local"][data-comparison-serial="LENTO"]:visible').first()).toBeInViewport();
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

test("Sino: Ver Resumo do aviso de 60 dias abre o Resumo na sub-aba Sem acesso", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  await request.get("/__fixture_alertas_painel?estado=visiveis");
  try {
    await page.goto("/");
    await page.locator("#btn-notificacoes").click();
    await page.locator("#notification-center-panel #alerta-sem-acesso-60").getByRole("button", { name: "Ver Resumo" }).click();
    await expect(page.locator('[data-cockpit-tool-panel="comparacao"]')).toBeVisible();
    await expect(page.locator("#resumo-aba-sem-acesso")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('#comparacao-planilhas-conteudo [data-comparison-category="sem_acesso_60_dias"][data-comparison-serial="SAIU60"]:visible').first()).toBeVisible();
  } finally {
    await request.get("/__fixture_alertas_painel?estado=ocultos");
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

test("Home chips Sem acesso, Divergente and Sem usuário open the Resumo on the exact row of their section", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  const semUsuario = { serial: "NOTE-SEM-USUARIO", apelido: "PRNOTEDEMO02", categoria: "notebook", modelo: "Notebook", retirada_cidade: "Curitiba", usuarios_logados: "" };
  try {
    await page.route("**/api/buscar-expandida?*", async route => {
      if (new URL(route.request().url()).searchParams.get("usuario") === "sem") {
        await route.fulfill({ json: { items: [semUsuario], total: 1, offset: 0, limit: 100, has_more: false, filters: { categories: [], cities: [], users: { sem: 1, com: 1 } } } });
        return;
      }
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, items: [...data.items, semUsuario], total: 2 } });
    });
    await page.goto("/");
    const list = page.locator("#home-equipment-list");
    await expect(list.locator("[role=option]")).toHaveCount(2);
    const actions = page.locator("#home-equipment-actions");
    const cases = [
      { serial: "LENTO", categoria: "sem_acesso_7_dias", name: "Sem acesso 7+ d: abrir LENTO no Resumo (F3)" },
      { serial: "LENTO", categoria: "divergencias_local", name: "Divergente: abrir LENTO no Resumo (F3)" },
      { serial: "NOTE-SEM-USUARIO", categoria: "sem_usuario", name: "Sem usuário: abrir NOTE-SEM-USUARIO no Resumo (F3)" },
    ];
    for (const { serial, categoria, name } of cases) {
      await list.locator(`[role=option][data-serial="${serial}"]`).click();
      const chip = actions.locator(`button[data-categoria="${categoria}"]`);
      await expect(chip).toHaveAccessibleName(name);
      await chip.click();
      await expect(page.locator('[data-cockpit-tool-panel="comparacao"]')).toBeVisible();
      const row = page.locator(`#comparacao-planilhas-conteudo [data-comparison-category="${categoria}"][data-comparison-serial="${serial}"]:visible`).first();
      await expect(row).toBeInViewport();
      if (categoria === "sem_usuario") await expect(page.locator("#comparacao-secao-sem-usuario")).toHaveText("Sem usuário");
      await page.keyboard.press("Escape");
      await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
    }
  } finally {
    // O Resumo ainda pode ter um GET da lista em andamento quando o teste acaba; sem isso o erro do route.fetch vaza para o teste seguinte.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

test("Home updates the external status actions when keyboard navigation or selection changes equipment", async ({ page, request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  try {
    await page.route("**/api/buscar-expandida?*", async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, items: [...data.items, { serial: "SEM-SELOS", modelo: "Notebook", usuarios_logados: "Usuário" }], total: 2 } });
    });
    await page.goto("/");
    const list = page.locator("#home-equipment-list");
    const actions = page.locator("#home-equipment-actions");
    await expect(list.locator("[role=option]")).toHaveCount(2);
    await expect(list.locator("[role=option]").first()).toContainText("Divergente");
    await list.focus();
    await page.keyboard.press("Home");
    await expect(actions).toHaveAccessibleName("Ações de LENTO");
    await expect(actions.locator("button")).toHaveCount(2);
    await page.keyboard.press("End");
    await expect(actions).toBeHidden();
    await page.keyboard.press("ArrowUp");
    await expect(actions).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("#card-serial")).toHaveText("LENTO");
    await expect(list.locator('[aria-selected="true"]')).toHaveAttribute("data-serial", "LENTO");
    await expect(actions).toHaveAccessibleName("Ações de LENTO");
  } finally {
    await request.get("/__fixture_cockpit?comparacao=0");
  }
});

for (const completion of ["pagination", "late selection"]) {
  test(`Home preserves real keyboard focus when ${completion} finishes with unchanged status actions`, async ({ page, request }) => {
    await request.get("/__fixture_cockpit?comparacao=1");
    let release;
    const held = new Promise(resolve => { release = resolve; });
    try {
      if (completion === "pagination") {
        await page.route("**/api/buscar-expandida?*", async route => {
          const params = new URL(route.request().url()).searchParams;
          const response = await route.fetch();
          const data = await response.json();
          const nextPage = Number(params.get("offset")) > 0;
          if (nextPage) await held;
          await route.fulfill({ response, json: { ...data, items: nextPage ? [{ serial: "SEGUNDO", usuarios_logados: "Usuário" }] : data.items, total: 2, has_more: !nextPage } });
        });
      } else {
        await page.route("**/api/equipamento/LENTO", async route => {
          const response = await route.fetch();
          await held;
          await route.fulfill({ response });
        });
      }
      await page.goto("/");
      const list = page.locator("#home-equipment-list");
      await expect(list.locator("[role=option]").first()).toContainText("Divergente");
      if (completion === "pagination") {
        await list.locator("[role=option]").first().click();
        await expect(page.locator("#card-serial")).toHaveText("LENTO");
        await expect(list.locator('[aria-selected="true"]')).toHaveAttribute("data-serial", "LENTO");
      }
      const inFlight = page.waitForRequest(req => completion === "pagination"
        ? new URL(req.url()).searchParams.get("offset") === "1"
        : new URL(req.url()).pathname === "/api/equipamento/LENTO");
      if (completion === "pagination") {
        await list.focus();
        await page.keyboard.press("Home");
        await page.locator("#btn-home-list-more").click();
      } else await list.locator("[role=option]").first().click();
      await inFlight;
      const action = page.locator('#home-equipment-actions button[data-categoria="sem_acesso_7_dias"]');
      await action.focus();
      const originalAction = completion === "pagination" ? await action.elementHandle() : null;
      release();
      if (completion === "pagination") {
        await expect(list.locator("[role=option]")).toHaveCount(2);
        expect(await originalAction.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true);
      }
      else await expect(page.locator("#card-serial")).toHaveText("LENTO");
      await expect(action).toBeFocused();
    } finally {
      release();
      await request.get("/__fixture_cockpit?comparacao=0");
    }
  });
}

test("Home filters are an equal-width segmented control and the footer has no Lista sem usuário link", async ({ page }) => {
  await page.goto("/");
  const widths = await page.locator(".ck-filtros .ck-filtro").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().width)));
  expect(widths).toHaveLength(4);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  const clipped = await page.locator(".ck-filtros .ck-filtro").evaluateAll(els => els.filter(el => el.scrollWidth > el.clientWidth).map(el => el.dataset.filter));
  expect(clipped).toEqual([]);
  await expect(page.locator("#btn-listar-sem-usuario")).toHaveCount(0);
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
    for (const [tab, panel] of [["tab-home", "tab-panel-home"], ["tab-retirada-entrega", "tab-panel-retirada-entrega"], ["tab-automacao", "tab-panel-automacao"]]) {
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
// [botão da barra, item do menu Ferramentas, painel, atalho, título]; Resumo F3 fica na barra principal; Histórico F7 e Relatório F8 só no menu (kbd).
const toolButtons = [
  ["#btn-sebrae-chamados-aba", "#btn-sebrae-chamados-menu", "sebrae-chamados", "F5", "Chamados"],
  ["#btn-acompanhamento-chamados", "#btn-chamados-menu", "chamados", "F6", "OS"],
  ["#btn-resumo-aba", "#btn-resumo-aba", "comparacao", "F3", "Resumo"],
  ["#btn-historico-apelidos", "#btn-historico-apelidos", "apelidos", "F7", "Histórico de apelidos"],
  ["#btn-relatorio-mensal", "#btn-relatorio-mensal", "relatorio", "F8", "Relatório mensal"],
];

for (const width of [320, 390, 768, 1024, 1200, 1440, 1920, 2560]) {
  test(`tool panels fit a ${width}px window and keep the F3 and F5–F8 shortcuts`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [toolComparison] } }));
    await page.route("**/api/historico-comparacoes/review-comparison", route => route.fulfill({ json: { evento: toolComparison } }));
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    for (const [barra, item, tool, key, titulo] of toolButtons) {
      const naBarra = barra === "#btn-resumo-aba" || (barra !== item && width >= 1200);
      if (naBarra) {
        await expect(page.locator(barra)).toHaveAttribute("title", `${titulo} (${key})`);
        await expect(page.locator(barra)).toBeVisible();
        // Mesma linha de Home/Transporte/Resumo/Automação.
        const linhaAba = await page.locator("#tab-home").boundingBox();
        const linhaBotao = await page.locator(barra).boundingBox();
        expect(Math.abs(linhaBotao.y - linhaAba.y), tool).toBeLessThanOrEqual(2);
      } else {
        await page.locator("#cockpit-tools-trigger").click();
        if (key) await expect(page.locator(`${item} kbd`)).toHaveText(key);
        else await expect(page.locator(`${item} kbd`)).toHaveCount(0);
      }
      await page.locator(naBarra ? barra : item).click();
      const panel = page.locator(`[data-cockpit-tool-panel="${tool}"]`);
      await expect(panel).toBeVisible();
      await expect(page.locator("#cockpit-tool-title")).toHaveText(titulo);
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      expect(dimensions.document, tool).toBeLessThanOrEqual(dimensions.viewport);
      expect(dimensions.body, tool).toBeLessThanOrEqual(dimensions.viewport);
      expect(await overflowingRight(page, "#cockpit-tool-panels"), tool).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      if (key) {
        await page.keyboard.press(key);
        await expect(panel, `${key} abre ${tool}`).toBeVisible();
      }
    }
  });
}

test("a real modal stays reachable on a short compact screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto("/");
  await page.locator("#btn-resumo-aba").click();
  await page.locator("#cockpit-comparison-legacy").click();
  const dialog = page.getByRole("dialog", { name: "Histórico de atualizações de planilhas" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("[aria-label='Fechar histórico de planilhas']")).toBeInViewport();
});

test("Transporte não tem mais OS por equipamento e a barra de ações fica na base da janela", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "a altura limitada da tela vale a partir de 1200px");
  await page.setViewportSize({ width: 1366, height: 600 });
  await page.goto("/");
  await page.locator("#tab-retirada-entrega").click();
  const tela = page.locator("#tab-panel-retirada-entrega");
  await expect(tela).toBeVisible();
  await expect(page.locator("#resumo-os-equipamento")).toHaveCount(0);
  await expect(page.locator("#ck-transp .ck-os, #ck-transp #ck-os-tabela")).toHaveCount(0);

  const barra = page.locator("#tab-panel-retirada-entrega .ck-acoes-barra");
  await expect(barra).toBeVisible();
  const medir = () => page.evaluate(() => {
    const painel = document.getElementById("tab-panel-retirada-entrega");
    const rect = document.querySelector("#tab-panel-retirada-entrega .ck-acoes-barra").getBoundingClientRect();
    return { bottom: rect.bottom, top: rect.top, inner: window.innerHeight, scroll: painel.scrollHeight, client: painel.clientHeight };
  });

  // Conteúdo mais alto que a janela: a tela rola por dentro e a barra continua colada na base.
  let medidas = await medir();
  expect(medidas.scroll, "o conteúdo precisa ser mais alto que a tela para provar a barra fixa").toBeGreaterThan(medidas.client);
  expect(Math.abs(medidas.bottom - medidas.inner)).toBeLessThanOrEqual(1);
  await tela.evaluate(node => { node.scrollTop = node.scrollHeight; });
  medidas = await medir();
  expect(Math.abs(medidas.bottom - medidas.inner)).toBeLessThanOrEqual(1);
  await tela.evaluate(node => { node.scrollTop = 0; });

  // Janela alta: a tela preenche a altura e a barra segue na base, sem rolagem da página.
  await page.setViewportSize({ width: 1920, height: 1080 });
  medidas = await medir();
  expect(Math.abs(medidas.bottom - medidas.inner)).toBeLessThanOrEqual(1);
  // A folga legada do body (app.css) não pode criar uma faixa vazia rolável sob a barra; sobra só o ajuste de poucos px da barra superior.
  expect(await page.evaluate(() => getComputedStyle(document.body).paddingBottom)).toBe("0px");
  const pagina = await page.evaluate(() => [document.documentElement.scrollHeight, window.innerHeight]);
  expect(pagina[0] - pagina[1], JSON.stringify(pagina)).toBeLessThanOrEqual(16);
});
