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
  await page.locator('.header-action-group[data-action-group="analysis"] > summary').click();
}

async function openFixtureComparison(page) {
  await openAnalysisMenu(page);
  await page.locator("#btn-historico-comparacoes").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Consultar resultado" }).first().click();
  await expect(page.locator('textarea[data-comparison-annotation]:visible').first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  let sessionResponse;
  let statsResponse;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sessionResponsePromise = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/auth/session", { timeout: 5_000 }).catch(() => null);
    const statsResponsePromise = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/stats", { timeout: 5_000 }).catch(() => null);
    if (attempt === 0) await page.goto("/");
    else await page.reload();
    [sessionResponse, statsResponse] = await Promise.all([sessionResponsePromise, statsResponsePromise]);
    if (sessionResponse && statsResponse) break;
  }
  expect(sessionResponse, "home should load the session endpoint").not.toBeNull();
  expect(statsResponse, "home should load the statistics endpoint").not.toBeNull();
  expect(sessionResponse.status()).toBe(200);
  expect(await sessionResponse.json()).toEqual({ enabled: false, authenticated: false });
  expect(statsResponse.status()).toBe(200);
  await expect(page.locator("#stat-equipamentos")).toHaveText("1");
});

test("home has no WCAG 2.2 A/AA axe violations", async ({ page }) => {
  await auditAccessibility(page);
});

test("home preserves typography and spacing around hidden panels", async ({ page }) => {
  await expect(page.locator("#input-serial")).toHaveCSS("font-family", /JetBrains Mono Variable/);
  await expect(page.locator("#btn-buscar-serial")).toHaveCSS("font-weight", "700");
  await expect(page.locator("#readiness-panel")).toHaveCSS("margin-bottom", "0px");
  await expect(page.locator("#tab-panel-home")).toHaveCSS("margin-top", "24px");
  await expect(page.locator("#tab-panel-home")).toHaveCSS("margin-bottom", "0px");
});

test("sidebar tools keep accent colors and fit the multiline ticket label", async ({ page }) => {
  await openSidebarIfNeeded(page);
  const updateButton = page.locator("#btn-atualizar-planilhas");
  const exportButton = page.locator("#btn-exportar-equipamentos");
  const ticketButton = page.getByRole("button", { name: "Acompanhamento de Chamados", exact: true });
  const analysisButton = page.locator('.header-action-group[data-action-group="analysis"] > summary');
  await expect(ticketButton).toBeVisible();
  const analysisGroup = page.locator('.header-action-group[data-action-group="analysis"]');
  if (!(await analysisGroup.evaluate(element => element.open))) await analysisButton.click();
  await expect(updateButton).toBeVisible();
  await expect(exportButton).toBeVisible();
  const heights = await Promise.all([exportButton, ticketButton].map(button =>
    button.evaluate(element => element.getBoundingClientRect().height)
  ));
  // The committed ticket label intentionally spans two lines with extra leading.
  expect(heights[1]).toBeGreaterThanOrEqual(heights[0]);
  const labelLayout = await ticketButton.locator(".sidebar-item-label").evaluate(label => {
    const button = label.closest("button").getBoundingClientRect();
    const text = label.getBoundingClientRect();
    return { breaks: label.querySelectorAll("br").length,
      fits: text.top >= button.top && text.bottom <= button.bottom && text.right <= button.right,
      clipped: label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight };
  });
  expect(labelLayout).toEqual({ breaks: 1, fits: true, clipped: false });

  const ticketBackground = await ticketButton.evaluate(element => getComputedStyle(element).backgroundColor);
  const analysisBackground = await analysisButton.evaluate(element => getComputedStyle(element).backgroundColor);
  const updateStyle = await updateButton.evaluate(element => {
    const style = getComputedStyle(element);
    return { backgroundImage: style.backgroundImage, fontWeight: style.fontWeight };
  });
  const exportStyle = await exportButton.evaluate(element => {
    const style = getComputedStyle(element);
    return { backgroundImage: style.backgroundImage, fontWeight: style.fontWeight };
  });
  expect(updateStyle.backgroundImage).toContain("linear-gradient");
  expect(updateStyle.fontWeight).toBe("700");
  expect(exportStyle.backgroundImage).toContain("linear-gradient");
  expect(exportStyle.fontWeight).toBe("700");
  expect(ticketBackground).toContain("234, 88, 12");
  expect(analysisBackground).toContain("109, 40, 217");
});

test("tab navigation updates selected state and supports arrow keys", async ({ page }, testInfo) => {
  await openSidebarIfNeeded(page);
  const transferTab = page.getByRole("tab", { name: "Transporte" });
  const homeTab = page.getByRole("tab", { name: "Home" });
  await transferTab.click();
  await expect(transferTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await expect(page.locator("#simpress-app-shell")).toHaveAttribute("data-sidebar-open", "false");
    await expect(page.locator("#main-content")).toBeFocused();
    return;
  }
  await transferTab.focus();
  await transferTab.press("ArrowLeft");
  await expect(homeTab).toBeFocused();
  await expect(homeTab).toHaveAttribute("aria-selected", "true");
});

test("search displays an announced skeleton, then the fictional result", async ({ page }) => {
  test.setTimeout(45_000);
  await page.getByRole("combobox", { name: "Série, apelido, modelo ou cidade do equipamento" }).fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator(".ui-skeleton").first()).toBeVisible();
  await expect(page.getByText("DEMO-001", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(page.locator("#card-equipamento")).toBeVisible();
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
  await page.getByRole("combobox", { name: "Série, apelido, modelo ou cidade do equipamento" }).fill("FALHA");
  await search.click();
  expect((await failedLookup).status()).toBe(503);
  await errorAlertVisible;
  await expect(search).toBeEnabled();
});

test("modal traps keyboard focus, restores it on Escape, and passes axe", async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await openFixtureComparison(page);
  const dialog = page.getByRole("dialog");
  await auditAccessibility(page, "#modal-comparacao-planilhas");
  const firstClose = dialog.getByRole("button", { name: "Fechar resultado" }).first();
  await expect(firstClose).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  const focusedInsideDialog = await dialog.evaluate((element) => element.contains(document.activeElement));
  expect(focusedInsideDialog).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const returnFocus = testInfo.project.name === "mobile"
    ? page.locator("#btn-sidebar-open")
    : page.locator("#btn-historico-comparacoes");
  await expect(returnFocus).toBeFocused();
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

test("central pending view filters rows and autosaves their original comparison annotations", async ({ page }) => {
  await openAnalysisMenu(page);
  await page.getByRole("button", { name: "Pendências" }).click();
  const dialog = page.locator("#modal-central-pendencias");
  await expect(dialog).toBeVisible();
  await auditAccessibility(page, "#modal-central-pendencias");
  await page.locator("#filtro-operacional-pendencias").fill("DEMO-SN-001");
  await expect(page.locator("#lista-central-pendencias [data-pending-row]")).toHaveCount(1);
  const annotation = page.locator("#lista-central-pendencias textarea[data-operational-annotation]");
  await annotation.fill("Revisar com a unidade");
  await annotation.blur();
  await expect(annotation.locator("xpath=..").locator("[data-annotation-status]")).toHaveText("Salvo automaticamente");
  await expect.poll(async () => (await page.request.get("/__fixture_state")).json()).toEqual({
    annotation: "Revisar com a unidade",
  });
});

test("inventory evolution compares two saved updates and shows their row annotations", async ({ page }) => {
  await openAnalysisMenu(page);
  await page.getByRole("button", { name: "Evolução das atualizações" }).click();
  const dialog = page.locator("#modal-evolucao-atualizacoes");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#resultado-evolucao-atualizacoes")).toContainText("Deixaram de aparecer");
  await expect(page.locator("#resultado-evolucao-atualizacoes")).toContainText("DEMO-SN-001");
  await expect(page.locator("#resultado-evolucao-atualizacoes textarea[data-operational-annotation]")).toBeVisible();
  await auditAccessibility(page, "#modal-evolucao-atualizacoes");
});

test("ticket tracking imports both workbooks and relates each serial to its OS", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: testInfo.project.name === "mobile" ? 390 : 1366, height: 640 });
  await openSidebarIfNeeded(page);
  await page.getByRole("button", { name: "Acompanhamento de Chamados", exact: true }).click();
  const dialog = page.locator("#modal-acompanhamento-chamados");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#filtros-avancados-acompanhamento-chamados")).toHaveCount(0);
  await expect(dialog.locator("#filtro-acompanhamento-chamados")).toBeVisible();
  await expect(dialog.locator("#somente-atencao-chamados")).toBeVisible();
  await expect(dialog.locator("#triagem-diaria-acompanhamento-chamados")).toBeVisible();
  const oraclePortalLink = dialog.getByRole("link", { name: "Abrir portal Oracle AgentWeb" });
  const simpressPortalLink = dialog.getByRole("link", { name: "Abrir acompanhamento de chamados Simpress" });
  await expect(oraclePortalLink).toHaveAttribute("href", "https://simpress.custhelp.com/AgentWeb/");
  await expect(simpressPortalLink).toHaveAttribute("href", "https://ux.simpress.com.br/equipamentos/acompanhamento");
  await expect(oraclePortalLink.locator("svg")).toBeVisible();
  await expect(simpressPortalLink.locator("svg")).toBeVisible();
  const managementPanel = page.locator("#painel-dados-acompanhamento-chamados");
  await expect(managementPanel).not.toHaveAttribute("open", "");
  await managementPanel.locator("summary").first().click();
  await expect(page.locator("#arquivo-chamados-simpress")).toBeVisible();
  await expect(page.locator("#arquivo-chamados-oracle")).toBeVisible();
  await expect(page.locator("#nome-arquivo-chamados-simpress")).toHaveText("Nenhum arquivo selecionado");
  await expect(page.locator("#nome-arquivo-chamados-oracle")).toHaveText("Nenhum arquivo selecionado");
  if (testInfo.project.name === "desktop") {
    const simpressLabelY = (await page.locator('label[for="arquivo-chamados-simpress"]').boundingBox()).y;
    const oracleLabelY = (await page.locator('label[for="arquivo-chamados-oracle"]').boundingBox()).y;
    const simpressPickerBox = await page.locator("#btn-escolher-arquivo-chamados-simpress")
      .evaluate(button => {
        const { y, height } = button.parentElement.getBoundingClientRect();
        return { y, height };
      });
    const oraclePickerBox = await page.locator("#btn-escolher-arquivo-chamados-oracle")
      .evaluate(button => {
        const { y, height } = button.parentElement.getBoundingClientRect();
        return { y, height };
      });
    const buttonStyles = await page.evaluate(() => {
      const simpress = document.querySelector("#btn-escolher-arquivo-chamados-simpress");
      const oracleButton = document.querySelector("#btn-escolher-arquivo-chamados-oracle");
      const buttonMetrics = style => ({
        height: style.height,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
        color: style.color,
      });
      const filenameMetrics = element => {
        const style = getComputedStyle(element);
        return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color };
      };
      const importButton = document.querySelector("#btn-importar-acompanhamento-chamados");
      const importRect = importButton.getBoundingClientRect();
      const simpressRect = document.querySelector("#btn-escolher-arquivo-chamados-simpress").parentElement.getBoundingClientRect();
      const oracleRect = document.querySelector("#btn-escolher-arquivo-chamados-oracle").parentElement.getBoundingClientRect();
      return {
        chooserButtons: {
          simpress: buttonMetrics(getComputedStyle(simpress)),
          oracle: buttonMetrics(getComputedStyle(oracleButton)),
        },
        filenames: {
          simpress: filenameMetrics(document.querySelector("#nome-arquivo-chamados-simpress")),
          oracle: filenameMetrics(document.querySelector("#nome-arquivo-chamados-oracle")),
        },
        importCenterOffset: Math.abs((importRect.top + importRect.height / 2) - (oracleRect.top + oracleRect.height / 2)),
        pickerHeights: { simpress: simpressRect.height, oracle: oracleRect.height },
      };
    });
    expect(Math.abs(simpressLabelY - oracleLabelY)).toBeLessThanOrEqual(1);
    expect(Math.abs(simpressPickerBox.y - oraclePickerBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(simpressPickerBox.height - oraclePickerBox.height)).toBeLessThanOrEqual(1);
    expect(buttonStyles.chooserButtons.oracle).toEqual(buttonStyles.chooserButtons.simpress);
    expect(buttonStyles.filenames.oracle).toEqual(buttonStyles.filenames.simpress);
    expect(buttonStyles.importCenterOffset).toBeLessThanOrEqual(1);
  }
  await auditAccessibility(page, "#modal-acompanhamento-chamados");
  await page.locator("#arquivo-chamados-simpress").setInputFiles({
    name: "Acompanhamento_de_Pedidos.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("fixture xlsx"),
  });
  const oracleFileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Escolher arquivo do Oracle - Gestão de Solicitações" }).click();
  const oracleFileChooser = await oracleFileChooserPromise;
  await oracleFileChooser.setFiles({
    name: "Gestao_de_Solicitacoes.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("fixture xlsx"),
  });
  await expect(page.locator("#nome-arquivo-chamados-oracle")).toHaveText("Gestao_de_Solicitacoes.xlsx");
  await page.getByRole("button", { name: "Importar planilhas", exact: true }).click();
  await expect(page.locator("#status-importacao-chamados")).toContainText("Planilhas importadas");
  await expect(page.locator("#nome-arquivo-chamados-simpress")).toHaveText("Nenhum arquivo selecionado");
  await expect(page.locator("#nome-arquivo-chamados-oracle")).toHaveText("Nenhum arquivo selecionado");
  await expect(page.locator("#lista-acompanhamento-chamados")).toContainText("DEMO-SN-001");
  await expect(page.locator("#lista-acompanhamento-chamados")).toContainText("7285070");
  await expect(page.locator("#lista-acompanhamento-chamados")).toContainText("261009-000816");
  await expect(managementPanel).not.toHaveAttribute("open", "");
  const ticketCard = page.locator('#lista-acompanhamento-chamados article[data-ticket-serial="DEMO-SN-001"]');
  await expect(ticketCard).toContainText("OS Simpress");
  await expect(ticketCard).toContainText("OS Oracle");
  await expect(ticketCard).toContainText("Pedido");
  const ticketDetails = ticketCard.locator('details[data-ticket-section="details"]');
  await expect(ticketDetails).toBeVisible();
  await expect(ticketDetails).not.toHaveAttribute("open", "");
  await ticketDetails.locator(":scope > summary").click();
  await expect(ticketDetails).toHaveAttribute("open", "");
  const ticketDescription = ticketCard.locator(".ticket-oracle-description").first();
  await expect(ticketDescription).toBeVisible();
  await expect(ticketDescription).not.toHaveAttribute("open", "");
  await expect(ticketDescription.locator("summary")).toContainText("Descrição do chamado");
  await ticketDescription.locator("summary").click();
  await expect(ticketDescription).toHaveAttribute("open", "");
  await expect(ticketDescription).toContainText("Solicito suporte técnico para o equipamento de demonstração.");
  await expect(ticketCard.locator('details[data-ticket-section="conference"]')).toHaveCount(0);
  await expect(ticketCard).not.toContainText("Conferência das relações");
  await page.locator("#filtro-acompanhamento-chamados").fill("DEMO-SN-001");
  await expect(ticketDetails).toHaveAttribute("open", "");
  await page.locator("#filtro-acompanhamento-chamados").fill("");
  const contentScroller = dialog.locator("#conteudo-acompanhamento-chamados");
  const scrollMetrics = await contentScroller.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(scrollMetrics.scrollWidth).toBeLessThanOrEqual(scrollMetrics.clientWidth);
  await contentScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => contentScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByRole("button", { name: "Fechar", exact: true })).toBeVisible();
  await expect.poll(async () => {
    const state = await (await page.request.get("/__ticket_import_state")).json();
    return state.imports;
  }).toBeGreaterThan(0);
  await auditAccessibility(page, "#modal-acompanhamento-chamados");
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
    ["#input-serial", "3px", "2px"],
    ["#theme-toggle", "2px", "2px"],
    ["#btn-nova-transferencia", "3px", "3px"],
    ['.sidebar-tabs [role="tab"]:first-child', "3px", "3px"],
    ['.header-action-group[data-action-group="analysis"] > summary', "3px", "3px"],
  ];
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    await page.keyboard.press("Tab");
    for (const [selector, width, offset] of controls) {
      const control = page.locator(selector);
      await control.focus();
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS("outline-style", "solid");
      await expect(control).toHaveCSS("outline-width", width);
      await expect(control).toHaveCSS("outline-offset", offset);
      await expect(control).toHaveCSS("outline-color", theme === "light" ? "rgb(2, 132, 199)" : "rgb(125, 211, 252)");
      await expect(control).toHaveCSS("box-shadow", `${theme === "light" ? "rgb(255, 255, 255)" : "rgb(2, 6, 23)"} 0px 0px 0px 2px`);
    }
  }
  await openFixtureComparison(page);
  const annotation = page.locator('textarea[data-comparison-annotation]:visible').first();
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    await page.keyboard.press("Tab");
    await annotation.focus();
    await expect(annotation).toHaveCSS("outline-width", "3px");
    await expect(annotation).toHaveCSS("outline-color", theme === "light" ? "rgb(2, 132, 199)" : "rgb(125, 211, 252)");
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
  const dialog = page.getByRole("dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("@profile UI route transitions retain responsive frame pacing", async ({ page }, testInfo) => {
  await page.waitForLoadState("networkidle");
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
