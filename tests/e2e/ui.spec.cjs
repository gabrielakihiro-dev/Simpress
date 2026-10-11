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

test("sidebar tools keep their accent colors and aligned primary action sizes", async ({ page }) => {
  await openSidebarIfNeeded(page);
  const updateButton = page.locator("#btn-atualizar-planilhas");
  const exportButton = page.locator("#btn-exportar-equipamentos");
  const ticketButton = page.getByRole("button", { name: "Acompanhamento de Chamados" });
  const analysisButton = page.locator('.header-action-group[data-action-group="analysis"] > summary');
  await expect(exportButton).toBeVisible();
  await expect(ticketButton).toBeVisible();
  const heights = await Promise.all([updateButton, exportButton, ticketButton].map(button =>
    button.evaluate(element => element.getBoundingClientRect().height)
  ));
  expect(heights[1]).toBe(heights[0]);
  expect(heights[2]).toBe(heights[0]);

  const ticketBackground = await ticketButton.evaluate(element => getComputedStyle(element).backgroundColor);
  const analysisBackground = await analysisButton.evaluate(element => getComputedStyle(element).backgroundColor);
  const updateBackground = await updateButton.evaluate(element => getComputedStyle(element).backgroundColor);
  const exportBackground = await exportButton.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(updateBackground).toContain("67, 56, 202");
  expect(exportBackground).toContain("5, 150, 105");
  expect(ticketBackground).toContain("13, 148, 136");
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
  const search = page.getByRole("button", { name: "Buscar Equipamento" });
  await page.getByRole("combobox", { name: "Série, apelido, modelo ou cidade do equipamento" }).fill("FALHA");
  await search.click();
  await expect(page.getByRole("alert").filter({ hasText: "Falha simulada para teste de interface." })).toBeVisible({ timeout: 8_000 });
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
  await page.getByRole("button", { name: "Acompanhamento de Chamados" }).click();
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
  await auditAccessibility(page, "#modal-acompanhamento-chamados");
  await page.locator("#arquivo-chamados-simpress").setInputFiles({
    name: "Acompanhamento_de_Pedidos.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("fixture xlsx"),
  });
  await page.locator("#arquivo-chamados-oracle").setInputFiles({
    name: "Gestao_de_Solicitacoes.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("fixture xlsx"),
  });
  await page.getByRole("button", { name: "Importar planilhas" }).click();
  await expect(page.locator("#status-importacao-chamados")).toContainText("Planilhas importadas");
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
    { width: 768, height: 1024 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
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

test("reduced-motion preference preserves modal operation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
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
