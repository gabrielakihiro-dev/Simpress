const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
// Includes repeated filtering, polling and two theme audits on slower Windows hosts.
test.setTimeout(60000);

// The fixture answers the Automação routes with fictional runs; no process or Chrome is started.
async function openAutomation(page, request, count = 0, sebrae = "padrao") {
  await request.get(`/__fixture_automacao?quantidade=${count}&sebrae=${sebrae}`);
  await page.goto("/");
  const sidebarButton = page.locator("#btn-sidebar-open");
  const shell = page.locator("#simpress-app-shell");
  if (await sidebarButton.isVisible() && await shell.getAttribute("data-sidebar-open") !== "true") {
    await sidebarButton.click();
    await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  }
  await page.locator("#tab-automacao").click();
  const panel = page.locator("#tab-panel-automacao");
  await expect(panel).toBeVisible();
  await expect(page.locator("#tab-automacao")).toHaveAttribute("aria-selected", "true");
  return panel;
}

test("Automação starts a routine, shows the login warning and the live log, then cancels", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  const status = panel.locator("#automacao-estado");
  const cancel = panel.getByRole("button", { name: "Cancelar", exact: true });
  await expect(status).toContainText("Livre");
  await expect(status).toContainText("Última execução: Inventários, Concluído");
  await expect(cancel).toBeDisabled();
  await expect(panel.locator("#automacao-aviso-login")).toBeHidden();

  const started = page.waitForRequest(req => req.url().endsWith("/api/automacao/executar") && req.method() === "POST");
  await panel.getByRole("button", { name: "Rotina de OS", exact: true }).click();
  expect((await started).postDataJSON()).toEqual({ rotina: "os" });

  await expect(status).toContainText("Em andamento");
  await expect(status).toContainText("Rotina de OS");
  await expect(status).toContainText("pelo site");
  const warning = panel.getByRole("alert");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Faça o login no Chrome de automação (Oracle).");
  await expect(panel.getByRole("log")).toContainText("AÇÃO NECESSÁRIA: faça o login");
  for (const name of ["Rotina de OS", "Inventários", "Ambas", "Abrir Chrome para login"]) {
    await expect(panel.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await expect(cancel).toBeEnabled();

  await cancel.click();
  await expect(page.locator("#toast-container")).toContainText("O Chrome de automação continua aberto.");
  await expect(status).toContainText("Livre");
  await expect(warning).toBeHidden();
  await expect(panel.getByRole("button", { name: "Inventários", exact: true })).toBeEnabled();
  await expect(cancel).toBeDisabled();
  const firstRow = panel.locator("#automacao-historico tbody tr").first();
  await expect(firstRow).toContainText("Rotina de OS");
  await expect(firstRow).toContainText("Cancelado");
});

test("Automação pages and filters executions without growing the history", async ({ page, request }) => {
  const panel = await openAutomation(page, request, 12);
  const rows = panel.locator("#automacao-historico tbody tr");
  await expect(rows).toHaveCount(5);
  await expect(panel.locator("#automacao-historico-pagina")).toHaveText("Página 1 de 3");
  await panel.getByRole("button", {name: "Próxima", exact: true}).click();
  await expect(panel.locator("#automacao-historico-pagina")).toHaveText("Página 2 de 3");
  await panel.getByRole("button", {name: "Próxima", exact: true}).click();
  await expect(rows).toHaveCount(2);
  await panel.getByRole("combobox", {name: "Execuções por página", exact: true}).selectOption("10");
  await expect(rows).toHaveCount(10);
  await panel.locator("#automacao-historico-filtros summary").click();
  await panel.getByLabel("De", {exact: true}).fill("2026-10-19");
  await panel.getByLabel("Até", {exact: true}).fill("2026-10-19");
  await panel.getByRole("button", {name: "Aplicar filtros", exact: true}).click();
  await expect(rows).toHaveCount(4);
  await expect(panel.locator("#automacao-historico-resumo")).toContainText("4 execuções · de 19/10/2026 · até 19/10/2026");
  await panel.getByRole("combobox", {name: "Status", exact: true}).selectOption("falha");
  await panel.getByRole("button", {name: "Aplicar filtros", exact: true}).click();
  await expect(rows).toHaveCount(2);
  await panel.locator("#automacao-historico-filtros summary").click();
  await panel.getByRole("button", {name: "Atualizar", exact: true}).click();
  await expect(rows).toHaveCount(2);
  await expect(panel.locator("#automacao-historico-resumo")).toContainText("Falha");
  await panel.locator("#automacao-historico-filtros summary").click();
  await panel.getByLabel("De", {exact: true}).fill("2026-10-21");
  await panel.getByRole("button", {name: "Aplicar filtros", exact: true}).click();
  await expect(panel.locator("#automacao-historico-resumo")).toContainText("A data inicial deve ser anterior");
  await expect(panel.getByLabel("Até", {exact: true})).toBeFocused();
  await panel.getByRole("button", {name: "Limpar filtros", exact: true}).click();
  await expect(rows).toHaveCount(10);
  await panel.getByLabel("De", {exact: true}).fill("2026-01-01");
  await panel.getByLabel("Até", {exact: true}).fill("2026-01-01");
  await panel.getByRole("button", {name: "Aplicar filtros", exact: true}).click();
  await expect(panel.locator("#automacao-historico")).toContainText("Nenhuma execução encontrada");
  await expect(panel.locator("#automacao-historico-proxima")).toBeDisabled();
});

test("Automação consults a bounded historical log and keeps it through live polling", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  await panel.locator("#automacao-historico tbody tr").nth(1).getByRole("button", {name: "Ver log", exact: false}).click();
  const log = panel.getByRole("log");
  await expect(log).toContainText("Histórico 20261019_170000_os");
  await expect(panel.getByLabel("Data do log", {exact: true})).toHaveValue("2026-10-19");
  await expect(log).toHaveAttribute("aria-live", "off");
  await expect(log).toContainText("<script>texto</script>");
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

test("Automação collapses and expands panels with keyboard restoration in both themes", async ({ page, request }, testInfo) => {
  const panel = await openAutomation(page, request);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    await panel.getByRole("button", {name: "Recolher Andamento", exact: true}).click();
    await expect(panel.locator("#automacao-andamento-conteudo")).toBeHidden();
    await panel.getByRole("button", {name: "Ampliar Andamento", exact: true}).click();
    await expect(panel.locator("#automacao-andamento-conteudo")).toBeVisible();
    await expect(panel.getByRole("button", {name: "Restaurar Andamento", exact: true})).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", {name: "Ampliar Últimas execuções", exact: true}).click();
    await expect(panel.locator(".automation-card--expanded")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(panel.locator(".automation-card--expanded")).toHaveCount(0);
    await expect(panel.getByRole("button", {name: "Ampliar Últimas execuções", exact: true})).toBeFocused();
    await panel.locator("#automacao-historico-filtros summary").click();
    await panel.locator("#automacao-log-filtros summary").click();
    const audit = await new AxeBuilder({ page }).include("#tab-panel-automacao")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations.map(item => item.id)).toEqual([]);
    await page.screenshot({path: `logs/prints-automacao/depois-automacao-${testInfo.project.name}-${theme}.png`, fullPage: true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await panel.locator("#automacao-historico-filtros summary").click();
    await panel.locator("#automacao-log-filtros summary").click();
  }
});

test("Automação shows the 409 message when another run is in progress", async ({ page, request }) => {
  await page.route("**/api/automacao/executar", route => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ detail: "Já há uma rotina em andamento: Inventários desde 07:30. Aguarde terminar ou cancele." }),
  }));
  const panel = await openAutomation(page, request);
  await panel.getByRole("button", { name: "Ambas" }).click();
  await expect(page.locator("#toast-container")).toContainText("Já há uma rotina em andamento: Inventários desde 07:30.");
  await expect(panel.getByRole("button", { name: "Ambas" })).toBeEnabled();
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
    await expect(panel.getByRole("log")).not.toContainText("LATE HISTORICAL RESPONSE");
  } finally { release(); }
});

test("Automação history lists status, batches and capture links, and passes the accessibility audit", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  const history = panel.locator("#automacao-historico");
  const rows = history.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Concluído");
  await expect(rows.nth(0)).toContainText("lote-demo-001");
  await expect(rows.nth(0)).toContainText("6 min 30 s");
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
    expect(audit.violations.map(item => item.id)).toEqual([]);
    await page.screenshot({path: `logs/prints-automacao/depois-captura-${testInfo.project.name}-${theme}.png`});
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(thumb).toBeFocused();
  }
});

test("Sincronizar chamados Sebrae shows the summary, counters and pending items with reasons", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  const card = panel.locator("#sebrae-painel");
  await expect(card.getByRole("heading", { name: "Sincronizar chamados Sebrae", level: 2 })).toBeVisible();
  await expect(card).toContainText("Roda de segunda a sexta, das 09h15 às 17h45, a cada 30 minutos. O computador precisa estar ligado e o servidor local da Simpress em execução.");
  await expect(card.locator("#sebrae-estado")).toContainText("Agendamento pausado");
  await expect(card.locator("#sebrae-ultima")).toContainText("Concluída em");
  await expect(card.locator("#sebrae-incluidos")).toHaveText("2");
  await expect(card.locator("#sebrae-ignorados")).toHaveText("31");
  await expect(card.locator("#sebrae-pendentes")).toHaveText("3");
  await expect(card.locator("#sebrae-agendamento-aviso")).toContainText("ainda não pode ser ativado");
  await expect(card.locator("#sebrae-login-aviso")).toBeHidden();
  const rows = card.locator("#sebrae-pendencias tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("UTIC-2026-1253");
  await expect(rows.nth(0)).toContainText("Alerta automático do Endpoint");
  await expect(rows.nth(2)).toContainText("Sem indícios de incidente ou de solicitação.");
  await expect(panel.locator("#automacao-historico-rotina option[value=sebrae]")).toHaveText("Sincronizar chamados Sebrae");
});

test("Sincronizar chamados Sebrae explains the 409 when the routine is not complete yet", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  const toggle = panel.getByRole("button", { name: "Ativar agendamento", exact: true });
  const sent = page.waitForRequest(req => req.url().endsWith("/api/automacao/sebrae/agendamento") && req.method() === "PUT");
  await toggle.click();
  expect((await sent).postDataJSON()).toEqual({ ativo: true });
  await expect(page.locator("#toast-container")).toContainText("A sincronização ainda não está completa");
  await expect(toggle).toBeEnabled();
  await expect(panel.locator("#sebrae-estado")).toContainText("Agendamento pausado");
});

test("Sincronizar chamados Sebrae turns the schedule on and off when the routine is ready", async ({ page, request }) => {
  const panel = await openAutomation(page, request, 0, "pronta");
  const card = panel.locator("#sebrae-painel");
  await expect(card.locator("#sebrae-agendamento-aviso")).toBeHidden();
  await card.getByRole("button", { name: "Ativar agendamento", exact: true }).click();
  await expect(card.locator("#sebrae-estado")).toContainText("Agendamento ativo");
  await expect(card.locator("#sebrae-proxima")).toContainText("10:15");
  await expect(card.locator("#sebrae-agendamento-aviso")).toContainText("pulado: ocupada");
  await expect(page.locator("#toast-container")).toContainText("Agendamento ativado");
  await card.getByRole("button", { name: "Pausar agendamento", exact: true }).click();
  await expect(card.locator("#sebrae-estado")).toContainText("Agendamento pausado");
  await expect(card.locator("#sebrae-proxima")).toHaveText("—");
});

test("Sincronizar chamados Sebrae runs now and cancels only its own run", async ({ page, request }) => {
  const panel = await openAutomation(page, request);
  const card = panel.locator("#sebrae-painel");
  const cancel = card.getByRole("button", { name: "Cancelar sincronização", exact: true });
  await expect(cancel).toBeDisabled();
  const started = page.waitForRequest(req => req.url().endsWith("/api/automacao/executar") && req.method() === "POST");
  await card.getByRole("button", { name: "Executar agora", exact: true }).click();
  expect((await started).postDataJSON()).toEqual({ rotina: "sebrae" });
  await expect(card.locator("#sebrae-estado")).toContainText("Sincronizando");
  await expect(card.getByRole("button", { name: "Executar agora", exact: true })).toBeDisabled();
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(card.locator("#sebrae-estado")).toContainText("Agendamento pausado");
  await expect(cancel).toBeDisabled();
  await expect(panel.locator("#automacao-historico tbody tr").first()).toContainText("Sincronizar chamados Sebrae");
});

test("Sincronizar chamados Sebrae shows the login warning and passes the audit in both themes", async ({ page, request }, testInfo) => {
  const panel = await openAutomation(page, request, 0, "login");
  const card = panel.locator("#sebrae-painel");
  await expect(card.locator("#sebrae-login-aviso")).toBeVisible();
  await expect(card.locator("#sebrae-login-aviso")).toContainText("Login necessário");
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include("#sebrae-painel")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations.map(item => item.id)).toEqual([]);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `logs/prints-automacao/depois-sebrae-${testInfo.project.name}-${theme}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
  if (testInfo.project.name === "mobile") {
    // On small screens the pending table becomes cards: header hidden, one block per row with the same data.
    const row = card.locator("#sebrae-pendencias tbody tr").first();
    expect(await row.evaluate(el => getComputedStyle(el).display)).toBe("block");
    expect(await row.locator("td").first().evaluate(el => getComputedStyle(el, "::before").content)).toContain("Chamado");
  }
});
