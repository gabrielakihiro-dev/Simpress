const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function auditAccessibility(page, scope = null) {
  let audit = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (scope) audit = audit.include(scope);
  const results = await audit.analyze();
  const summary = results.violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    description: violation.help,
    nodes: violation.nodes.map(node => ({ target: node.target, summary: node.failureSummary })),
  }));
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

async function openSidebarIfNeeded(page) {
  const sidebarButton = page.locator("#btn-sidebar-open");
  const shell = page.locator("#simpress-app-shell");
  if (await sidebarButton.isVisible() && await shell.getAttribute("data-sidebar-open") !== "true") {
    await sidebarButton.click();
    await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  }
}

async function openAnalysisMenu(page) {
  await openSidebarIfNeeded(page);
  const menu = page.locator("#cockpit-tools-dropdown");
  if (!(await menu.evaluate(node => node.open))) await page.locator("#cockpit-tools-trigger").click();
}

// O menu abre a tela Comparação; o modal completo abre pelo botão "Histórico e ações completas".
async function openHistoryModal(page) {
  await openAnalysisMenu(page);
  await page.locator("#btn-cockpit-comparacao").click();
  await expect(page.locator("#cockpit-comparison-legacy")).toBeVisible();
  await page.locator("#cockpit-comparison-legacy").click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

// O resultado completo da comparação abre na aba Comparação do Cockpit (não há mais modal).
const COMPARISON_PANEL = '[data-cockpit-tool-panel="comparacao"]';

async function openFixtureComparison(page) {
  await openHistoryModal(page);
  await page.getByRole("button", { name: "Consultar resultado" }).first().click();
  await expect(page.locator(COMPARISON_PANEL)).toBeVisible();
  await expect(page.locator('#comparacao-planilhas-conteudo textarea[data-comparison-annotation]:visible').first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  let statsResponse;
  for (let attempt = 0; attempt < 2; attempt++) {
    const statsResponsePromise = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/stats", { timeout: 5_000 }).catch(() => null);
    if (attempt === 0) await page.goto("/");
    else await page.reload();
    statsResponse = await statsResponsePromise;
    if (statsResponse) break;
  }
  expect(statsResponse, "home should load the statistics endpoint").not.toBeNull();
  expect(statsResponse.status()).toBe(200);
  await expect(page.locator("#stat-equipamentos")).toHaveText("1");
});

test("home has no WCAG 2.2 A/AA axe violations", async ({ page }) => {
  await auditAccessibility(page);
});

test("Cockpit keeps compact typography and a single tools disclosure", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "mobile";
  if (!mobile) await expect(page.locator(".ck-topbar")).toHaveCSS("height", "48px");
  const searchFontSize = mobile ? "16px" : "12.5px";
  await expect(page.locator("#input-serial")).toHaveCSS("font-size", searchFontSize);
  await expect(page.locator("#card-equipamento")).toBeHidden();
  await openAnalysisMenu(page);
  await expect(page.locator("#btn-cockpit-comparacao")).toBeVisible();
  await expect(page.locator("#btn-atualizar-planilhas, #cockpit-tools-menu #btn-exportar-equipamentos")).toHaveCount(0);
  await expect(page.locator(`${COMPARISON_PANEL} #btn-exportar-equipamentos`)).toHaveCount(1);
  await expect(page.locator("#btn-acompanhamento-chamados:visible, #btn-chamados-menu:visible")).toHaveCount(1);
  await expect(page.locator("#btn-historico-comparacoes")).toHaveCount(0);
  await expect(page.locator("#badge-total-historico-comparacoes")).toHaveCount(0);
  const styles = await page.locator(".ck-menu__item:visible").evaluateAll(nodes => nodes.map(node => ({
    image: getComputedStyle(node).backgroundImage, wraps: getComputedStyle(node).whiteSpace,
  })));
  expect(styles.every(style => style.image === "none")).toBe(true);
});

test("tab navigation updates selected state and supports arrow keys", async ({ page }, testInfo) => {
  await openSidebarIfNeeded(page);
  const transferTab = page.locator("#tab-retirada-entrega");
  const homeTab = page.getByRole("tab", { name: "Home" });
  await transferTab.click();
  await expect(transferTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await transferTab.focus();
  await transferTab.press("ArrowLeft");
  await expect(homeTab).toBeFocused();
  await expect(homeTab).toHaveAttribute("aria-selected", "true");
});

test("search displays an announced skeleton, then the fictional result", async ({ page }) => {
  test.setTimeout(45_000);
  await page.route("**/api/buscar-expandida*", route => route.fulfill({ json: {
    items: [], total: 0, has_more: false, filters: { categories: [], cities: [] },
  } }));
  const autocompleteResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/buscar-expandida", { timeout: 20_000 });
  const equipmentResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/equipamento/LENTO", { timeout: 20_000 });
  await page.getByRole("combobox", { name: "Série, apelido, modelo, cidade ou nome do usuário do equipamento" }).fill("LENTO");
  const autocompleteResponse = await autocompleteResponsePromise;
  expect(autocompleteResponse.status()).toBe(200);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator(".ui-skeleton").first()).toBeVisible();
  const equipmentResponse = await equipmentResponsePromise;
  expect(equipmentResponse.status()).toBe(200);
  const equipmentCard = page.locator("#card-equipamento");
  await expect(equipmentCard).toBeVisible({ timeout: 15_000 });
  await expect(equipmentCard.locator("#badge-apelido")).toHaveText("DEMO-001");
});

test("search shortcuts focus Home search except while typing or with a dialog open", async ({ page }) => {
  const input = page.locator("#input-serial");
  const homeTab = page.locator("#tab-home");
  await expect(input).toHaveAttribute("aria-keyshortcuts", "/ Control+K Meta+K");
  // O chip visual Ctrl+K saiu da caixa de busca; o atalho segue anunciado por aria-keyshortcuts.
  await expect(page.locator(".ck-busca__campo > .ck-kbd")).toHaveCount(0);

  await openSidebarIfNeeded(page);
  await page.locator("#tab-retirada-entrega").click();
  await expect(homeTab).toHaveAttribute("aria-selected", "false");
  await page.locator("#main-content").focus();
  await page.keyboard.press("/");
  await expect(homeTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tab-panel-home")).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");

  await openSidebarIfNeeded(page);
  await page.locator("#tab-retirada-entrega").click();
  const notes = page.locator("#entrega-obs");
  await notes.fill("");
  await notes.focus();
  await page.keyboard.press("/");
  await expect(notes).toHaveValue("/");
  await expect(notes).toBeFocused();
  await page.keyboard.press("Control+K");
  await expect(homeTab).toHaveAttribute("aria-selected", "true");
  await expect(input).toBeFocused();

  await openAnalysisMenu(page);
  await openHistoryModal(page);
  const dialog = page.getByRole("dialog");
  await page.keyboard.press("Control+K");
  await page.keyboard.press("/");
  await expect(dialog).toBeVisible();
  await expect(input).not.toBeFocused();
});

test("recent lookups reopen the result and can be cleared", async ({ page }) => {
  test.setTimeout(45_000);
  const recentSection = page.locator("#home-recentes");
  await expect(recentSection).toBeHidden();
  await page.evaluate(() => localStorage.setItem("simpress:recent-equipment", JSON.stringify([
    { serial: "OUTRO", apelido: "DEMO-002", cidade: "Londrina" },
    { serial: "LENTO", apelido: "DEMO-001", cidade: "Curitiba" },
  ])));
  await page.reload();
  await expect(recentSection).toBeVisible();
  const items = recentSection.getByRole("listitem");
  await expect(items).toHaveCount(2);
  const lento = recentSection.getByRole("button", { name: "LENTO, apelido DEMO-001, cidade Curitiba. Abrir resultado" });
  await expect(lento).toContainText("LENTO");
  await expect(lento).toContainText("DEMO-001");
  await expect(lento).toContainText("Curitiba");

  const lookup = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/equipamento/LENTO", { timeout: 20_000 });
  await lento.click();
  await expect(page.locator("#input-serial")).toHaveValue("LENTO");
  expect((await lookup).status()).toBe(200);
  await expect(page.locator("#card-equipamento")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await expect(recentSection.locator(".ck-recente__serie")).toHaveText(["LENTO", "OUTRO"]);
  await auditAccessibility(page, "#home-recentes");

  await recentSection.getByRole("button", { name: "Limpar pesquisas recentes" }).click();
  await expect(recentSection).toBeHidden();
  await expect(page.locator("#input-serial")).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("simpress:recent-equipment"))).toBeNull();
});

test("failed search restores the controls and exposes a recoverable error", async ({ page }) => {
  test.setTimeout(45_000);
  const search = page.getByRole("button", { name: "Buscar Equipamento" });
  const errorAlert = page.getByRole("alert").filter({ hasText: "Falha simulada para teste de interface." });
  const errorAlertVisible = expect(errorAlert).toBeVisible({ timeout: 15_000 });
  const failedLookup = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/equipamento/FALHA";
  }, { timeout: 30_000 });
  await page.getByRole("combobox", { name: "Série, apelido, modelo, cidade ou nome do usuário do equipamento" }).fill("FALHA");
  await search.click();
  expect((await failedLookup).status()).toBe(503);
  await errorAlertVisible;
  await expect(search).toBeEnabled();
});

test("delete confirmation opens above the history dialog and cancelling keeps the record", async ({ page }) => {
  await openHistoryModal(page);
  const history = page.locator("#modal-historico-comparacoes");
  const deleteButton = history.getByRole("button", { name: /^Excluir atualização de/ }).first();
  await deleteButton.click();
  const confirmation = page.getByRole("dialog", { name: "Excluir atualização?" });
  await expect(confirmation).toBeVisible();
  const zIndex = selector => page.locator(selector).evaluate(element => Number(getComputedStyle(element).zIndex));
  expect(await zIndex("#modal-confirmar-acao")).toBeGreaterThan(await zIndex("#modal-historico-comparacoes"));
  await expect(page.locator("#btn-confirmar-acao-ok")).toHaveAttribute("data-variant", "danger");
  await confirmation.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
  await expect(history).toBeVisible();
  await expect(deleteButton).toBeFocused();
});

test("comparison result tab takes focus, passes axe and closes with Escape", async ({ page }) => {
  test.setTimeout(45_000);
  await openFixtureComparison(page);
  const panel = page.locator(COMPARISON_PANEL);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#modal-historico-comparacoes")).toBeHidden();
  await expect(page.locator("#cockpit-tool-title")).toBeFocused();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Comparação");
  await expect(panel.locator("#btn-exportar-resultado-comparacao")).toBeVisible();
  await auditAccessibility(page, COMPARISON_PANEL);

  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
  await expect(page.locator("#main-content")).toBeVisible();
});

test("fixture annotation autosaves to the isolated in-memory endpoint", async ({ page }) => {
  await openFixtureComparison(page);
  const annotation = page.locator('textarea[data-comparison-annotation]:visible').first();
  await annotation.fill("Nota de usabilidade fictícia");
  await annotation.blur();
  await expect(annotation.locator("xpath=..").locator("[data-annotation-status]")).toHaveText("Salvo automaticamente");
  await expect.poll(async () => (await page.request.get("/__fixture_state")).json()).toEqual({
    annotation: "Nota de usabilidade fictícia",
  });
});

for (const outcome of ["network failure", "success"]) {
  test(`annotation A -> B -> A waits for the latest save after stale ${outcome}`, async ({ page }) => {
    await openFixtureComparison(page);
    await page.clock.install();
    const requests = [];
    await page.route("**/api/historico-comparacoes/*/anotacoes/*", route => {
      requests.push({ route, body: route.request().postDataJSON() });
    });
    const annotation = page.locator('textarea[data-comparison-annotation]:visible').first();
    const status = annotation.locator("xpath=..").locator("[data-annotation-status]");
    const draftKey = await annotation.evaluate(el => window.HistoryAnnotationAutosave.createDraftStorageKey(
      "fixture-event-001", el.dataset.annotationId
    ));
    await annotation.fill("A");
    await annotation.blur();
    await expect.poll(() => requests.length).toBe(1);
    await annotation.fill("B");
    await annotation.fill("A");
    // Expire the debounce while the old request is still pending.
    await page.clock.runFor(501);
    if (outcome === "network failure") await requests[0].route.abort("failed");
    else await requests[0].route.fulfill({ json: {
      sucesso: true, anotacao_revisoes: [requests[0].body.revisao_id],
    } });
    await expect.poll(() => requests.length).toBe(2);
    await expect(annotation).toHaveAttribute("data-annotation-pending", "true");
    await expect(status).not.toHaveText("Salvo automaticamente");
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).text, draftKey)).toBe("A");
    if (outcome === "success") {
      expect(requests[1].body.base_revisoes).toEqual([requests[0].body.revisao_id]);
    }
    await requests[1].route.fulfill({ json: {
      sucesso: true, anotacao_revisoes: [requests[1].body.revisao_id],
    } });
    await expect(status).toHaveText("Salvo automaticamente");
    await expect(annotation).toHaveAttribute("data-annotation-pending", "false");
    expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBeNull();
    await page.clock.runFor(5_000);
    expect(requests).toHaveLength(2);
  });
}

test("comparison history filters rows and autosaves their original annotations", async ({ page }) => {
  await openFixtureComparison(page);
  const dialog = page.locator(COMPARISON_PANEL);
  await expect(dialog).toBeVisible();
  await auditAccessibility(page, COMPARISON_PANEL);
  await dialog.locator("[data-history-filter-search]").fill("DEMO-SN-001");
  await dialog.locator("[data-history-filter-category]").selectOption("apelidos_sem_atualizacao");
  const row = dialog.locator('[data-history-filter-group="apelidos_sem_atualizacao"] [data-comparison-item-id]:visible');
  await expect(row).toHaveCount(1);
  const annotation = row.locator("textarea[data-comparison-annotation]");
  await annotation.fill("Revisar com a unidade");
  await annotation.blur();
  await expect(annotation.locator("xpath=..").locator("[data-annotation-status]")).toHaveText("Salvo automaticamente");
  await expect(row).toHaveClass(/history-row-annotated/);
  await dialog.locator("[data-history-filter-annotated]").check();
  await expect(row).toBeVisible();
  await expect.poll(async () => (await page.request.get("/__fixture_state")).json()).toEqual({
    annotation: "Revisar com a unidade",
  });
});

test("comparison summary cards jump to their section and clear filters that hide it", async ({ page }) => {
  await openFixtureComparison(page);
  const dialog = page.locator(COMPARISON_PANEL);
  // Only "Apelidos para conferência" has rows in the fixture; zero-count cards stay static.
  const links = dialog.locator("[data-comparison-section-target]");
  await expect(links).toHaveCount(1);
  const card = dialog.getByRole("button", { name: /Apelidos para conferência: 1\. Ir para Linhas mantidas para conferência/ });
  await expect(card).toHaveCSS("cursor", "pointer");

  await dialog.locator("[data-history-filter-search]").fill("nenhuma linha corresponde");
  const heading = dialog.locator("#comparacao-secao-linhas-conferencia");
  await expect(heading).toBeHidden();
  await card.click();
  await expect(dialog.locator("[data-history-filter-search]")).toHaveValue("");
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
});

test("ticket tracking imports both workbooks in the OS panel and relates each serial to its OS", async ({ page }, testInfo) => {
  // The complete import flow includes two Axe scans and the native file chooser.
  test.slow();
  await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 390 : 1366, height: 640 });
  await openSidebarIfNeeded(page);
  await openAnalysisMenu(page);
  await page.locator("#btn-acompanhamento-chamados:visible, #btn-chamados-menu:visible").click();
  await page.locator("#cockpit-tickets-manage").click();
  // "Importar e gerenciar" abre o bloco do próprio painel, não o modal antigo.
  await expect(page.locator("#modal-acompanhamento-chamados")).toHaveCount(0);
  const managementPanel = page.locator("#cockpit-tickets-manage-panel");
  await expect(managementPanel).toHaveAttribute("open", "");
  await expect(page.locator("#cockpit-tickets-search")).toBeVisible();
  await expect(page.locator("#cockpit-tickets-attention")).toBeVisible();
  await expect(page.locator("#cockpit-tickets-triage")).toBeVisible();
  const oraclePortalLink = managementPanel.getByRole("link", { name: "Abrir portal Oracle AgentWeb" });
  const simpressPortalLink = managementPanel.getByRole("link", { name: "Abrir acompanhamento de chamados Simpress" });
  await expect(oraclePortalLink).toHaveAttribute("href", "https://simpress.custhelp.com/AgentWeb/");
  await expect(simpressPortalLink).toHaveAttribute("href", "https://ux.simpress.com.br/equipamentos/acompanhamento");
  await expect(oraclePortalLink.locator("svg")).toBeVisible();
  await expect(simpressPortalLink.locator("svg")).toBeVisible();
  const seletorSimpress = page.locator("label.ckp-arquivo", { has: page.locator("#cockpit-tickets-file-simpress") });
  const seletorOracle = page.locator("label.ckp-arquivo", { has: page.locator("#cockpit-tickets-file-oracle") });
  await expect(seletorSimpress).toBeVisible();
  await expect(seletorOracle).toBeVisible();
  await expect(seletorSimpress).toHaveAttribute("data-estado", "vazio");
  await expect(seletorOracle).toHaveAttribute("data-estado", "vazio");
  if (testInfo.project.name === "desktop") {
    const caixaSimpress = await seletorSimpress.boundingBox();
    const caixaOracle = await seletorOracle.boundingBox();
    expect(Math.abs(caixaSimpress.y - caixaOracle.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(caixaSimpress.height - caixaOracle.height)).toBeLessThanOrEqual(1);
  }
  await auditAccessibility(page, "#cockpit-tickets-manage-panel");
  await page.locator("#cockpit-tickets-file-simpress").setInputFiles({
    name: "Acompanhamento_de_Pedidos.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("fixture xlsx"),
  });
  const oracleFileChooserPromise = page.waitForEvent("filechooser");
  await seletorOracle.click();
  const oracleFileChooser = await oracleFileChooserPromise;
  await oracleFileChooser.setFiles({
    name: "Gestao_de_Solicitacoes.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("fixture xlsx"),
  });
  await expect(page.locator("#cockpit-tickets-file-oracle-name")).toHaveText("Gestao_de_Solicitacoes.xlsx");
  await page.getByRole("button", { name: "Importar planilhas", exact: true }).click();
  await expect(page.locator("#cockpit-tickets-import-status")).toContainText("Planilhas importadas");
  await expect(page.locator("#cockpit-tickets-file-simpress-name")).toHaveText("Escolher arquivo");
  await expect(page.locator("#cockpit-tickets-file-oracle-name")).toHaveText("Escolher arquivo");
  await expect(managementPanel).not.toHaveAttribute("open", "");
  await expect(page.locator("#cockpit-tickets-os")).toContainText("DEMO-SN-001");
  await expect(page.locator("#cockpit-tickets-os")).toContainText("7285070");
  await expect(page.locator("#cockpit-tickets-kpis")).toContainText("Séries");
  await expect.poll(async () => {
    const state = await (await page.request.get("/__ticket_import_state")).json();
    return state.imports;
  }).toBeGreaterThan(0);
  // Versões, fontes e comparação ficam no mesmo bloco, que reabre pelo botão da barra.
  await page.locator("#cockpit-tickets-manage").click();
  await expect(managementPanel).toHaveAttribute("open", "");
  await expect(page.locator("#cockpit-tickets-sources")).toContainText("Acompanhamento_de_Pedidos.xlsx");
  await expect(page.locator("#cockpit-tickets-version option")).toHaveCount(3);
  await expect(page.locator("#cockpit-tickets-export")).toBeEnabled();
  await auditAccessibility(page, "#cockpit-tickets-manage-panel");
  await expect(page.locator("#modal-acompanhamento-chamados")).toHaveCount(0);
});

test("layout stays within common responsive viewport widths", async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 740 },
    { width: 390, height: 844 },
    { width: 767, height: 1024 },
    { width: 768, height: 1024 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(
      () => [...document.querySelector(".app-workspace").getAnimations()]
        .every(animation => animation.playState !== "running"),
      null,
      { timeout: 1_000 },
    );
    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      overflowingElements: [...document.querySelectorAll("body *")]
        .map(element => ({
          element,
          rect: element.getBoundingClientRect(),
          style: getComputedStyle(element),
        }))
        .filter(({ element, rect, style }) => (
          style.display !== "none"
          && style.visibility !== "hidden"
          && !element.closest("[hidden]")
          && rect.width > 0
          && rect.right > document.documentElement.clientWidth + 1
        ))
        .sort((left, right) => right.rect.right - left.rect.right)
        .slice(0, 8)
        .map(({ element, rect, style }) => {
          const ancestors = [];
          let ancestor = element.parentElement;
          while (ancestor && ancestors.length < 5) {
            ancestors.push({
              tag: ancestor.tagName,
              id: ancestor.id,
              className: typeof ancestor.className === "string" ? ancestor.className : "",
              x: Math.round(ancestor.getBoundingClientRect().x),
              width: Math.round(ancestor.getBoundingClientRect().width),
              right: Math.round(ancestor.getBoundingClientRect().right),
              display: getComputedStyle(ancestor).display,
              marginLeft: getComputedStyle(ancestor).marginLeft,
              gridTemplateColumns: getComputedStyle(ancestor).gridTemplateColumns,
            });
            ancestor = ancestor.parentElement;
          }
          return {
            tag: element.tagName,
            id: element.id,
            className: typeof element.className === "string" ? element.className : "",
            text: (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            position: style.position,
            ancestors,
          };
        }),
    }));
    expect(widths.document, `horizontal overflow at ${viewport.width}×${viewport.height}: ${JSON.stringify(widths)}`)
      .toBeLessThanOrEqual(widths.viewport + 1);
  }
});

test("keyboard focus stays visible over component and theme styles", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const controls = [
    // The Home search ring sits on its field wrapper (:focus-within), not on the input.
    ["#input-serial", "2px", "2px", undefined, ".ck-busca__campo"],
    ["#theme-toggle", "2px", "2px"],
    ["#btn-nova-transferencia", "2px", "2px"],
    ['.ck-abas [role="tab"]:first-child', "2px", "2px"],
    ["#cockpit-tools-trigger", "2px", "2px"],
  ];
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    // Nova transferência fica na aba Retirada/Entrega; o clique vem antes do Tab para o foco por teclado seguir visível.
    await openSidebarIfNeeded(page);
    await page.locator("#tab-retirada-entrega").click();
    await openAnalysisMenu(page);
    await page.keyboard.press("Tab");
    for (const [selector, width, offset, shadow, ringSelector] of controls) {
      const focused = page.locator(selector);
      await focused.focus();
      await expect(focused).toBeFocused();
      const control = ringSelector ? page.locator(ringSelector) : focused;
      await expect(control).toHaveCSS("outline-style", "solid");
      await expect(control).toHaveCSS("outline-width", width);
      await expect(control).toHaveCSS("outline-offset", offset);
      expect(await control.evaluate(element => getComputedStyle(element).outlineColor)).not.toBe("rgba(0, 0, 0, 0)");
      if (shadow) await expect(control).toHaveCSS("box-shadow", shadow);
    }
  }
  await openFixtureComparison(page);
  const annotation = page.locator('textarea[data-comparison-annotation]:visible').first();
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    await page.keyboard.press("Tab");
    await annotation.focus();
    // Dentro da aba Comparação vale o anel do Cockpit (2px, cor de destaque), igual aos demais controles do shell; no tema claro theme.css mantém a cor `--focus-color`.
    await expect(annotation).toHaveCSS("outline-width", "2px");
    await expect(annotation).toHaveCSS("outline-color", theme === "light" ? "rgb(2, 132, 199)" : "rgb(145, 132, 217)");
  }
});

test("reduced-motion preference suppresses CSS motion and preserves modal operation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const movingElements = await page.evaluate(() => [...document.querySelectorAll("body *")].flatMap(element => {
    return [null, "::before", "::after"].flatMap(pseudo => {
      const style = getComputedStyle(element, pseudo);
      const tooLong = value => value.split(",").some(duration => Number.parseFloat(duration) > 0.0000101);
      if (tooLong(style.transitionDuration) || tooLong(style.animationDuration)
          || (style.animationName !== "none" && style.animationIterationCount.split(",").some(count => count === "infinite" || Number(count) > 1))) {
        return [{ tag: element.tagName, id: element.id, className: element.getAttribute("class"), pseudo,
          transition: style.transitionDuration, animation: style.animationDuration, iterations: style.animationIterationCount }];
      }
      return [];
    });
  }));
  expect(movingElements).toEqual([]);
  await expect(page.locator("html")).toHaveCSS("scroll-behavior", "auto");
  await openFixtureComparison(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(COMPARISON_PANEL)).toBeHidden();
});

test("@profile UI route transitions retain responsive frame pacing", async ({ page }, testInfo) => {
  await expect(page.locator("#tab-panel-home")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const profile = await page.evaluate(async () => {
    const longTasks = [];
    const toggles = [];
    const observer = typeof PerformanceObserver === "function"
      && PerformanceObserver.supportedEntryTypes.includes("longtask")
      ? new PerformanceObserver(list => list.getEntries().forEach(entry => longTasks.push({
        startTime: entry.startTime,
        durationMs: entry.duration,
        name: entry.name,
      attribution: entry.attribution?.map(item => ({
        containerType: item.containerType,
        containerName: item.containerName,
        containerId: item.containerId,
      })) || [],
      })))
      : null;
    observer?.observe({ type: "longtask", buffered: true });
    const sample = transition => new Promise(resolve => {
      const samples = [];
      const tabs = [document.getElementById("tab-home"), document.getElementById("tab-retirada-entrega")];
      let previous = null;
      let frame = 0;
      const tick = timestamp => {
        if (previous !== null) samples.push(timestamp - previous);
        previous = timestamp;
        frame += 1;
        if (transition && frame % 24 === 0) {
          const tab = tabs[(frame / 24) % 2];
          const clickStartedAt = performance.now();
          tab.click();
          toggles.push({ frame, timestamp, id: tab.id });
          toggles[toggles.length - 1].clickDurationMs = performance.now() - clickStartedAt;
        }
        if (frame < 180) requestAnimationFrame(tick);
        else {
          const sorted = [...samples].sort((left, right) => left - right);
          const percentile = fraction => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
          resolve({
            frames: samples.length,
            medianMs: percentile(0.5),
            p95Ms: percentile(0.95),
            maxMs: Math.max(...samples),
            over16_7ms: samples.filter(value => value > 16.7).length,
            over25ms: samples.filter(value => value > 25).length,
            over50ms: samples.filter(value => value > 50).length,
          });
        }
      };
      requestAnimationFrame(tick);
    });
    const idle = await sample(false);
    const transitionStart = performance.now();
    const transitions = await sample(true);
    observer?.disconnect();
    return {
      idle,
      transitions,
      toggles,
      longTasksDuringTransitions: longTasks.filter(task => task.startTime >= transitionStart),
    };
  });

  await testInfo.attach("ui-frame-profile.json", {
    body: JSON.stringify({ browser: "Chromium", viewport: "1366x900", ...profile }, null, 2),
    contentType: "application/json",
  });
  console.log(`[profile] ${JSON.stringify(profile)}`);
  expect(profile.idle.frames).toBeGreaterThanOrEqual(175);
  expect(profile.transitions.frames).toBeGreaterThanOrEqual(175);
  expect(profile.transitions.p95Ms,
    "repeated transitions should stay within two 60Hz frame budgets at p95")
    .toBeLessThan(34);
  expect(profile.transitions.over50ms / profile.transitions.frames,
    "severe dropped frames should remain exceptional")
    .toBeLessThan(0.02);
  expect(Math.max(...profile.toggles.map(toggle => toggle.clickDurationMs)),
    "tab handlers should return within the 150ms interaction budget")
    .toBeLessThan(150);
  expect(Math.max(0, ...profile.longTasksDuringTransitions.map(task => task.durationMs)),
    "a transient main-thread task should not block the page for a quarter second")
    .toBeLessThan(250);
});

test("Resumo tab does not show the removed usage panel", async ({ page }) => {
  await openSidebarIfNeeded(page);
  await page.locator("#tab-resumo").click();
  await expect(page.getByRole("heading", { name: "Uso nos últimos 30 dias" })).toHaveCount(0);
});

test("Resumo tab switches panels, keeps ARIA state and supports arrow keys", async ({ page }) => {
  const tabs = { home: "#tab-home", transporte: "#tab-retirada-entrega", resumo: "#tab-resumo", automacao: "#tab-automacao" };
  const panels = {
    home: "#tab-panel-home", transporte: "#tab-panel-retirada-entrega",
    resumo: "#tab-panel-resumo", automacao: "#tab-panel-automacao",
  };
  async function expectOnly(ativa) {
    for (const nome of Object.keys(tabs)) {
      const selecionada = nome === ativa;
      await expect(page.locator(tabs[nome])).toHaveAttribute("aria-selected", String(selecionada));
      await expect(page.locator(tabs[nome])).toHaveAttribute("tabindex", selecionada ? "0" : "-1");
      if (selecionada) await expect(page.locator(panels[nome])).toBeVisible();
      else await expect(page.locator(panels[nome])).toBeHidden();
    }
    await expect(page.locator("body")).toHaveClass(ativa === "transporte" ? /has-quick-actions/ : /^(?!.*has-quick-actions).*$/);
  }

  await openSidebarIfNeeded(page);
  await page.locator(tabs.resumo).click();
  await expectOnly("resumo");
  await expect(page.locator("#resumo-cards")).toBeVisible();

  await openSidebarIfNeeded(page);
  await page.locator(tabs.transporte).click();
  await expectOnly("transporte");

  await openSidebarIfNeeded(page);
  await page.locator(tabs.home).click();
  await expectOnly("home");

  // Setas: Home -> Transporte -> Resumo -> Automação -> (volta) Home; End vai para Automação.
  // No celular o menu lateral fecha ao escolher uma aba e o foco sai da lista, então só o desktop encadeia teclas.
  if (await page.locator("#btn-sidebar-open").isVisible()) return;
  await page.locator(tabs.home).focus();
  await page.keyboard.press("ArrowDown");
  await expectOnly("transporte");
  await page.keyboard.press("ArrowDown");
  await expectOnly("resumo");
  await page.keyboard.press("ArrowDown");
  await expectOnly("automacao");
  await page.keyboard.press("ArrowDown");
  await expectOnly("home");
  await page.keyboard.press("End");
  await expectOnly("automacao");
});

test("stale base alert shows the last update date and opens the base update", async ({ page, request }) => {
  const alert = page.locator("#alerta-base-desatualizada");
  await expect(alert).toBeHidden();
  try {
    await request.get("/__fixture_base_desatualizada?estado=desatualizada");
    await page.reload();
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("heading", { name: "Base desatualizada" })).toBeVisible();
    await expect(alert.locator("#alerta-base-desatualizada-texto")).toHaveText(
      "A base na Simpress foi atualizada pela última vez em 08/10/2026 às 20:15, há 9 dias. O limite é de 7 dias."
    );
    await auditAccessibility(page, "#alerta-base-desatualizada");

    await alert.getByRole("button", { name: "Atualizar base" }).click();
    await expect(page.locator("#modal-atualizar-planilhas")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-atualizar-planilhas")).toBeHidden();
    await expect(page.locator("#btn-alerta-base-atualizar")).toBeFocused();

    await request.get("/__fixture_base_desatualizada?estado=sem_base");
    await page.reload();
    await expect(alert.getByRole("heading", { name: "Base não encontrada" })).toBeVisible();
    await expect(alert.getByRole("button", { name: "Importar base" })).toBeVisible();
  } finally {
    await request.get("/__fixture_base_desatualizada?estado=atualizada");
  }
});

test("stale tickets and new divergences appear in the notification center", async ({ page, request }) => {
  const home = page.locator("#tab-panel-home");
  const trigger = page.locator("#btn-notificacoes");
  const badge = page.locator("#badge-notificacoes");
  const panel = page.locator("#notification-center-panel");
  const tickets = panel.locator("#alerta-os-paradas");
  const divergences = panel.locator("#alerta-divergencias-novas");
  const base = home.locator("#alerta-base-desatualizada");
  await request.get("/__fixture_alertas_painel?estado=ocultos");
  await request.get("/__fixture_base_desatualizada?estado=atualizada");
  await page.reload();
  await expect(home.locator("#alerta-os-paradas, #alerta-divergencias-novas")).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName("Notificações, nenhum aviso ativo");
  await expect(badge).toBeHidden();
  await expect(base).toBeHidden();
  try {
    await request.get("/__fixture_base_desatualizada?estado=desatualizada");
    await page.reload();
    await expect(base).toBeVisible();
    await expect(home.locator("#alerta-os-paradas, #alerta-divergencias-novas")).toHaveCount(0);

    await request.get("/__fixture_alertas_painel?estado=visiveis");
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(badge).toHaveText("2");
    await expect(trigger).toHaveAccessibleName("Notificações, 2 avisos ativos");
    await expect(tickets.getByRole("heading", { name: "OS paradas" })).toBeVisible();
    await expect(tickets.locator("#alerta-os-paradas-texto")).toHaveText(
      "3 chamados abertos estão sem atualização há 7 dias ou mais. O mais antigo está parado há 21 dias."
    );
    await expect(divergences.getByRole("heading", { name: "Divergências novas" })).toBeVisible();
    // v2 (fase 5): cada aviso leva um selo de gravidade.
    await expect(tickets.locator(".ck-badge")).toHaveText("Urgente");
    await expect(divergences.locator(".ck-badge")).toHaveText("Atenção");
    await expect(divergences.locator("#alerta-divergencias-novas-texto")).toHaveText(
      "A comparação de 18/10/2026 às 09:00 trouxe 5 linhas de divergência que não estavam na de 11/10/2026 às 08:00: 3 em Localidade divergente e 2 em Séries sem local definido."
    );
    await auditAccessibility(page, "#notification-center-panel");

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await tickets.getByRole("button", { name: "Ver OS" }).click();
    await expect(panel).toBeHidden();
    // O alerta leva ao painel OS da tela principal (F6), não a um modal.
    await expect(page.locator('[data-cockpit-tool-panel="chamados"]')).toBeVisible();
    await expect(page.locator("#modal-acompanhamento-chamados")).toHaveCount(0);

    await trigger.click();
    await divergences.getByRole("button", { name: "Ver evolução" }).click();
    await expect(panel).toBeHidden();
    // 31/10/2026: a tela Evolução saiu; "Ver evolução" abre a aba Comparações.
    await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
    await expect(page.locator("#cockpit-tool-title")).toHaveText("Comparação");
    await expect(page.locator(COMPARISON_PANEL)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
    await expect(page.locator("#cockpit-tools-trigger")).toBeFocused();

    await request.get("/__fixture_alertas_painel?estado=somente_os");
    await trigger.click();
    await expect(badge).toHaveText("1");
    await expect(trigger).toHaveAccessibleName("Notificações, 1 aviso ativo");
    await expect(tickets).toBeVisible();
    await expect(divergences).toBeHidden();

    await page.locator(".ck-marca").click();
    await expect(panel).toBeHidden();
    await request.get("/__fixture_alertas_painel?estado=ocultos");
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(badge).toBeHidden();
    await expect(panel.locator("#notification-center-summary")).toHaveText("Nenhum aviso ativo.");
    await expect(tickets).toBeHidden();
    await expect(divergences).toBeHidden();
    await page.locator(".ck-marca").click();
    await expect(panel).toBeHidden();
    await expect(base).toBeVisible();
  } finally {
    await request.get("/__fixture_alertas_painel?estado=ocultos");
    await request.get("/__fixture_base_desatualizada?estado=atualizada");
  }
});
