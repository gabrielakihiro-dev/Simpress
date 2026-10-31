const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
// Includes repeated filtering, polling and two theme audits on slower Windows hosts.
test.setTimeout(60000);

// The fixture answers the Automação routes with fictional runs; no process or Chrome is started.
async function openAutomation(page, request, count = 0, sebrae = "padrao", run = "") {
  await request.get(`/__fixture_automacao?quantidade=${count}&sebrae=${sebrae}&run=${run}`);
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const panel = page.locator("#tab-panel-automacao");
  await expect(panel).toBeVisible();
  await expect(page.locator("#tab-automacao")).toHaveAttribute("aria-selected", "true");
  return panel;
}

test("Automação transforma as linhas do log ativo em eventos seguros e atualiza o indicador ao vivo", async ({ page, request }) => {
  const panel = await openAutomation(page, request, 0, "padrao", "os");
  const events = panel.locator("#cockpit-automation-events");
  const stateResponse = await request.get("/api/automacao/estado?offset=0&arquivo=");
  const state = await stateResponse.json();

  expect(state.estado).toBe("em_andamento");
  expect(state.log.linhas).toHaveLength(3);
  await expect(page.locator("#automacao-estado")).toHaveCount(1);
  await expect(page.locator("#automacao-estado-titulo")).toHaveCount(1);
  await expect(panel.locator("#automacao-estado")).toContainText("Ocupado");
  await expect(page.locator("#cockpit-automation-shell-title")).toHaveText("Chrome ocupado");
  await expect(panel.locator("#automacao-log")).toContainText("Reaproveitando o Chrome de automação na porta 9333.");
  await expect(events).toContainText("Reaproveitando o Chrome de automação na porta 9333.");
  await expect(events).toContainText("Abrindo https://simpress.custhelp.com/AgentWeb/");
  await expect(events).toContainText("AÇÃO NECESSÁRIA: faça o login");
  await expect(events.locator(".ck-log__linha")).toHaveCount(3);
  await expect(events.locator('[data-state="waiting"]')).toHaveCount(1);
  await expect(panel.locator("#cockpit-automation-live")).toBeVisible();
  await expect(panel.locator("#automacao-log")).toContainText("AÇÃO NECESSÁRIA: faça o login");
});

test("Automação deixa as últimas execuções visíveis ao abrir a aba", async ({ page, request }) => {
  const panel = await openAutomation(page, request);

  await expect(panel.locator("#automacao-historico")).toBeVisible();
  await expect(panel.locator("#automacao-historico tbody tr")).toHaveCount(3);
  await expect(panel.locator("#automacao-andamento-painel")).toBeVisible();
});

test("Automação starts a routine, shows the login warning and the live log, then cancels", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  const status = panel.locator("#automacao-estado");
  const cancel = panel.getByRole("button", { name: "Cancelar execução", exact: true });
  const detalhe = panel.locator("#automacao-estado-detalhe");
  await expect(status).toContainText("Livre");
  await expect(detalhe).toContainText("Última execução: Inventários, Concluído");
  await expect(cancel).toBeDisabled();
  await expect(panel.locator("#automacao-aviso-login")).toBeHidden();

  const started = page.waitForRequest(req => req.url().endsWith("/api/automacao/executar") && req.method() === "POST");
  await panel.locator("#btn-automacao-os").click();
  expect((await started).postDataJSON()).toEqual({ rotina: "os" });

  await expect(status).toContainText("Ocupado");
  await expect(detalhe).toContainText("Rotina de OS em andamento");
  await expect(panel.locator("#btn-automacao-os")).toContainText("Acompanhar");
  await expect(page.locator("#cockpit-automation-shell-title")).toHaveText("Chrome ocupado");
  const warning = panel.getByRole("alert");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Faça o login no Chrome de automação (Oracle).");
  await expect(panel.locator("#cockpit-automation-events")).toContainText("AÇÃO NECESSÁRIA: faça o login");
  for (const id of ["#btn-automacao-inventarios", "#btn-automacao-ambas", "#btn-automacao-usuarios", "#btn-automacao-login"]) {
    await expect(panel.locator(id)).toBeDisabled();
  }
  await expect(panel.locator("#btn-automacao-os")).toBeEnabled();
  await expect(cancel).toBeEnabled();

  await cancel.click();
  await expect(page.locator("#toast-container")).toContainText("O Chrome de automação continua aberto.");
  await expect(status).toContainText("Livre");
  await expect(page.locator("#cockpit-automation-shell-title")).toHaveText("Chrome livre");
  await expect(warning).toBeHidden();
  await expect(panel.locator("#btn-automacao-inventarios")).toBeEnabled();
  await expect(cancel).toBeDisabled();
  const firstRow = panel.locator("#automacao-historico tbody tr").first();
  await expect(firstRow).toContainText("Rotina de OS");
  await expect(firstRow).toContainText("Cancelado");
});

test("Automação pages and filters executions without growing the history", async ({ page, request }) => {
  const panel = await openAutomation(page, request, 12);
  const rows = panel.locator("#automacao-historico tbody tr");
  await expect(rows).toHaveCount(5);
  await expect(panel.locator("#automacao-historico-pagina")).toHaveText("1 de 3");
  await panel.getByRole("button", {name: "Próxima", exact: true}).click();
  await expect(panel.locator("#automacao-historico-pagina")).toHaveText("2 de 3");
  await panel.getByRole("button", {name: "Próxima", exact: true}).click();
  await expect(rows).toHaveCount(3);
  await panel.getByRole("combobox", {name: "Execuções por página", exact: true}).selectOption("10");
  await expect(rows).toHaveCount(10);
  await panel.getByLabel("De", {exact: true}).fill("2026-10-19");
  await panel.getByLabel("Até", {exact: true}).fill("2026-10-19");
  await panel.getByRole("button", {name: "Aplicar", exact: true}).click();
  await expect(rows).toHaveCount(4);
  await expect(panel.locator("#automacao-historico-resumo")).toContainText("4 execuções · de 19/10/2026 · até 19/10/2026");
  await panel.getByRole("combobox", {name: "Status", exact: true}).selectOption("falha");
  await panel.getByRole("button", {name: "Aplicar", exact: true}).click();
  await expect(rows).toHaveCount(2);
  await expect(rows).toHaveCount(2);
  await expect(panel.locator("#automacao-historico-resumo")).toContainText("Falha");
  await panel.getByLabel("De", {exact: true}).fill("2026-10-21");
  await panel.getByRole("button", {name: "Aplicar", exact: true}).click();
  await expect(panel.locator("#automacao-historico-resumo")).toContainText("A data inicial deve ser anterior");
  await expect(panel.getByLabel("Até", {exact: true})).toBeFocused();
  await panel.getByRole("button", {name: "Limpar", exact: true}).click();
  await expect(rows).toHaveCount(10);
  await panel.getByLabel("De", {exact: true}).fill("2026-01-01");
  await panel.getByLabel("Até", {exact: true}).fill("2026-01-01");
  await panel.getByRole("button", {name: "Aplicar", exact: true}).click();
  await expect(panel.locator("#automacao-historico")).toContainText("Nenhuma execução encontrada");
  await expect(panel.locator("#automacao-historico-proxima")).toBeDisabled();
});

test("Automação consults a bounded historical log and keeps it through live polling", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  await panel.locator("#automacao-historico tbody tr").nth(1).getByRole("button", {name: "Ver log", exact: false}).click();
  const log = panel.locator("#automacao-log");
  const events = panel.locator("#cockpit-automation-events");
  await expect(log).toContainText("Histórico 20261019_170000_os");
  await expect(panel.getByLabel("Data do log", {exact: true})).toHaveValue("2026-10-19");
  await expect(log).toHaveAttribute("aria-live", "off");
  await expect(log).toContainText("<script>texto</script>");
  await expect(events).toContainText("<script>texto</script>");
  await expect(events.locator("script")).toHaveCount(0);
  await expect.poll(async () => (await log.innerText()).split("\n").length).toBe(200);
  await panel.getByRole("combobox", {name: "Linhas do log", exact: true}).selectOption("100");
  await expect.poll(async () => (await log.innerText()).split("\n").length).toBe(100);
  await panel.getByRole("combobox", {name: "Linhas do log", exact: true}).selectOption("500");
  await expect.poll(async () => (await log.innerText()).split("\n").length).toBe(500);
  await page.waitForResponse(response => response.url().includes("/api/automacao/estado?"));
  await expect(log).toContainText("Histórico 20261019_170000_os");
  await panel.getByRole("button", {name: "Voltar ao vivo", exact: true}).click();
  await expect(log).toHaveAttribute("aria-live", "polite");
  await expect(log).not.toContainText("Histórico 20261019_170000_os");
  await panel.getByLabel("Data do log", {exact: true}).fill("2026-01-01");
  await expect(panel.getByRole("combobox", {name: "Execução", exact: true})).toBeDisabled();
  await expect(panel.getByRole("combobox", {name: "Execução", exact: true})).toContainText("Nenhuma execução nesta data");
});

test("Automação passes the accessibility audit without horizontal overflow in both themes", async ({ page, request }, testInfo) => {
  const panel = await openAutomation(page, request);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include("#tab-panel-automacao")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations.map(item => `${item.id}: ${item.nodes.map(n => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await page.screenshot({path: `logs/prints-automacao/depois-automacao-${testInfo.project.name}-${theme}.png`, fullPage: true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
  await expect(panel.locator("#automacao-historico")).toBeVisible();
});

test("Automação shows the 409 message when another run is in progress", async ({ page, request }) => {
  await page.route("**/api/automacao/executar", route => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ detail: "Já há uma rotina em andamento: Inventários desde 07:30. Aguarde terminar ou cancele." }),
  }));
  const panel = await openAutomation(page, request);
  await panel.locator("#btn-automacao-ambas").click();
  await expect(page.locator("#toast-container")).toContainText("Já há uma rotina em andamento: Inventários desde 07:30.");
  await expect(panel.locator("#btn-automacao-ambas")).toBeEnabled();
});

test("Automação ignores a late historical response after returning to live mode", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  let release;
  let intercepted;
  const waiting = new Promise(resolve => { intercepted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/automacao/execucoes/20261019_170000_os/log?*", async route => {
    intercepted();
    await gate;
    await route.fulfill({json: {execucao: {rotina: "os", inicio: "2026-10-19T17:00:00-03:00"}, arquivo: "old.log", linhas: ["LATE HISTORICAL RESPONSE"]}});
  });
  try {
    await panel.locator("#automacao-historico tbody tr").nth(1).getByRole("button", {name: "Ver log", exact: false}).click();
    await waiting;
    await panel.getByRole("button", {name: "Voltar ao vivo", exact: true}).click();
    const response = page.waitForResponse(item => item.url().includes("/execucoes/20261019_170000_os/log?"));
    release();
    await response;
    await expect(panel.locator("#automacao-log-modo")).toContainText("Ao vivo");
    await expect(panel.locator("#automacao-log")).not.toContainText("LATE HISTORICAL RESPONSE");
  } finally { release(); }
});

test("Automação history lists status, batches and capture links, and passes the accessibility audit", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  const history = panel.locator("#automacao-historico");
  const rows = history.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Concluído");
  await expect(rows.nth(0).locator("td span[title^=\"Lotes:\"]")).toHaveAttribute("title", /lote-demo-001/);
  await expect(rows.nth(0)).toContainText("6m 30s");
  await expect(rows.nth(1)).toContainText("fora do site");
  await expect(rows.nth(1)).toContainText("Falha");
  await expect(rows.nth(1)).toContainText("Login não concluído em 10 minutos.");
  const capture = rows.nth(1).getByRole("link", { name: "20261019_170210_Oracle.png" });
  await expect(capture).toHaveAttribute("href", "/api/automacao/capturas/20261019_170210_Oracle.png");
  await expect(capture).toHaveAttribute("target", "_blank");
  await expect(rows.nth(1).locator(".automation-capture-thumb img")).toHaveCount(1);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).include("#tab-panel-automacao")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map(violation => violation.id)).toEqual([]);
});

test("Automação shows the failure screenshot as a thumbnail that opens enlarged and returns focus", async ({ page, request }, testInfo) => {
  const panel = await openAutomation(page, request);
  const row = panel.locator("#automacao-historico tbody tr").nth(1);
  const thumb = row.getByRole("button", { name: "Ampliar captura 20261019_170210_Oracle.png" });
  await expect(thumb).toBeVisible();
  await expect(row).toContainText("Login não concluído em 10 minutos.");
  const image = thumb.locator("img");
  // The thumbnail loads lazily: on small screens it sits below the fold until scrolled to.
  await thumb.scrollIntoViewIfNeeded();
  await expect(image).toHaveAttribute("alt", /Captura de tela da falha em Rotina de OS.*Login não concluído em 10 minutos\./);
  await expect.poll(() => image.evaluate(el => el.complete && el.naturalWidth)).toBeGreaterThan(0);

  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await thumb.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "20261019_170210_Oracle.png" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("img")).toHaveAttribute("alt", /Captura de tela da falha/);
    await expect(dialog).toContainText("Login não concluído em 10 minutos.");
    await expect(dialog.getByRole("button", { name: "Fechar", exact: true })).toBeFocused();
    const audit = await new AxeBuilder({ page }).include("#automacao-captura-dialogo")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations.map(item => `${item.id}: ${item.nodes.map(n => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await page.screenshot({path: `logs/prints-automacao/depois-captura-${testInfo.project.name}-${theme}.png`});
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(thumb).toBeFocused();
  }
});
