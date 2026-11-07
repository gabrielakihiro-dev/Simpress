const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

async function openMonthlyReport(page) {
  await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-relatorio-mensal").click();
  const panel = page.locator('[data-cockpit-tool-panel="relatorio"]');
  await expect(panel).toBeVisible();
  await expect(page.locator("#cockpit-tool-title")).toBeFocused();
  return panel;
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function monthlyReport(month) {
  return {
    mes: { key: month, label: month === "2026-09" ? "setembro de 2026" : "outubro de 2026", parcial: month === currentMonth(), data_corte: "2026-10-25" },
    gerado_em: "2026-10-25T09:00:00-03:00",
    inventario: {
      total: 1284, unidades: 30, linhas_sem_serie: 2, series_duplicadas: ["SN-DUP"], arquivo_origem: "EquipamentosDetalhes_atual.xlsx", carregada_em: "24/10/2026 08:00",
      por_tipo: [["Notebook", 1200], ["Monitor", 84]],
      por_unidade: [["Curitiba Sede", "Prado Velho", 412], ["Londrina", "Centro", 168], ...Array.from({ length: 8 }, (_, index) => [`Cidade ${index + 1}`, "Rua Fictícia", 10 - index])],
    },
    comparacao: {
      horario: "2026-10-20T09:00:00", evento_id: "fixture-event-001", atualizacoes_no_mes: 2,
      contagens: { "Sem correspondência — no endpoint": 23, "Sem correspondência — na Simpress": 15, "Localidade divergente": 18 },
      linhas: [{ secao: "Localidade divergente", hostname: "PRNOTEFIC01", serie: "SN-COMP-1", local_previsto: "Londrina", local_simpress: "Maringá" }],
    },
    os: {
      oracle: { abertas: 3, concluidas: 2, pendentes: 1, encerradas_sem_data: 0 },
      simpress: { abertas: 4, concluidas: 3, pendentes: 1, encerradas_sem_data: 1 },
      linhas: [
        { fonte: "Oracle", identificador: "OS-FIC-1", serie: "SN-OS-1", status: "Em atendimento", criacao: "2026-10-03", conclusao: null, situacao: ["Aberta no mês", "Pendente no fim do mês"] },
        { fonte: "Simpress", identificador: "PED-FIC-2", serie: "SN-OS-2", status: "Pedido entregue", criacao: "2026-10-04", conclusao: "2026-10-06", situacao: ["Aberta no mês", "Concluída no mês"] },
      ],
      dados_insuficientes: [{ fonte: "Oracle", serie: "ABC123", identificadores: ["OS-1"], motivo: "Sem data" }],
    },
  };
}

function sebraeNovos() {
  return {
    importado: { abertos: [{ numero: "UTIC-2026-10", titulo: "Notebook sem rede", automaticos: { K: "SN-UTIC-10" }, leitura_softexpert: { habilitada_em: "12/10/2026 10:00" } }, { numero: "linha:7", chamado: "", titulo: "Sem data", automaticos: {} }], finalizados: [] },
    novos: { formulario: [{ numero: "UTIC-2026-11", linha: { G: "Monitor apagado", K: "SN-UTIC-11", P: "02/09/2026 08:30" } }] },
  };
}

async function routeMonthly(page) {
  await page.route(/\/api\/relatorio-mensal\/dados(?:\?|$)/, route => route.fulfill({ json: monthlyReport(new URL(route.request().url()).searchParams.get("mes")) }));
  await page.route("**/api/sebrae/novos", route => route.fulfill({ json: sebraeNovos() }));
}

test("the Cockpit report loads the selected month and keeps the existing XLSX download", async ({ page }) => {
  const requestedData = [];
  const requestedWorkbook = [];
  await page.route(/\/api\/relatorio-mensal\/dados(?:\?|$)/, async route => {
    const month = new URL(route.request().url()).searchParams.get("mes");
    requestedData.push(month);
    await route.fulfill({ status: 200, json: monthlyReport(month) });
  });
  await page.route(/\/api\/relatorio-mensal\?/, async route => {
    const month = new URL(route.request().url()).searchParams.get("mes");
    requestedWorkbook.push(month);
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      headers: { "Content-Disposition": 'attachment; filename="Relatorio-mensal-2026-09.xlsx"' },
      body: Buffer.from("fixture"),
    });
  });
  await page.goto("/");
  await openMonthlyReport(page);

  const month = page.locator("#cockpit-monthly-month");
  await expect(month).toHaveValue(currentMonth());
  await expect(month).toHaveAttribute("max", currentMonth());
  await expect(page.locator(".ck-rel__previa")).not.toHaveAttribute("open", "");
  await expect(page.locator("#cockpit-monthly-preview")).toBeHidden();
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("OS Oracle pendentes no fim do período: 1");
  await expect(page.locator("#cockpit-monthly-preview")).not.toContainText("indisponível");

  const attention = page.locator("#cockpit-monthly-kpis");
  await expect(attention.locator(".ck-rel__atencao")).toHaveCount(3);
  await expect(attention.locator(".ck-rel__atencao").first()).toContainText("OS pendentes no fim do período");
  await expect(attention).toContainText("Comparação usada: 20/10/2026 às 09:00 · 2 atualizações de inventário no mês");
  const outside = attention.locator('.ck-rel__atencao[data-status="alerta"]');
  await expect(outside).toContainText("Fora das contagens");
  await expect(outside.locator("#cockpit-monthly-fora")).toBeHidden();
  await outside.getByRole("button", { name: "Mostrar registros" }).click();
  await expect(outside.locator("#cockpit-monthly-fora")).toContainText("OS-1");
  await expect(outside.getByRole("button", { name: "Ocultar registros" })).toHaveAttribute("aria-expanded", "true");

  const details = page.locator("#cockpit-monthly-details");
  await expect(details.locator('[data-rel-secao="movimento"] td[data-label="Encerradas sem data"]').nth(1)).toHaveText("1");
  await expect(details.locator('[data-rel-secao="os"] tbody tr')).toHaveCount(2);
  await details.getByRole("button", { name: "Pendentes" }).click();
  await expect(details.locator('[data-rel-secao="os"] tbody tr')).toHaveCount(1);
  await expect(details.getByRole("button", { name: "Pendentes" })).toHaveAttribute("aria-pressed", "true");
  await expect(details.getByRole("button", { name: "Pendentes" })).toBeFocused();
  const base = details.locator('[data-rel-secao="base"]');
  await expect(base).toContainText("Não muda com o mês");
  await expect(base.locator(".ck-rel__unidade")).toHaveCount(8);
  await base.getByRole("button", { name: "Ver todas as 10 unidades" }).click();
  await expect(base.locator(".ck-rel__unidade")).toHaveCount(10);
  await expect(base.getByRole("button", { name: "Ver menos" })).toBeFocused();
  await page.locator(".ck-rel__previa summary").click();
  await expect(page.locator("#cockpit-monthly-preview")).toBeVisible();

  await month.fill("2026-09");
  await expect(page.locator("#cockpit-monthly-status")).toContainText("Mês encerrado");
  const download = page.waitForEvent("download");
  await page.locator("#cockpit-monthly-export").click();
  expect((await download).suggestedFilename()).toBe("Relatorio-mensal-2026-09.xlsx");
  expect(requestedData).toContain("2026-09");
  expect(requestedWorkbook).toEqual(["2026-09"]);
  await expect(page.locator("#toast-container")).toContainText("Planilha Exportada com Sucesso!");
});

test("the Cockpit report shows local API errors in its status region", async ({ page }) => {
  await page.route("**/api/relatorio-mensal/dados**", route => route.fulfill({
    status: 503, json: { detail: "A base oficial EquipamentosDetalhes não está carregada." },
  }));
  await page.goto("/");
  await openMonthlyReport(page);
  await expect(page.locator("#cockpit-monthly-status")).toHaveText("A base oficial EquipamentosDetalhes não está carregada.");
  await expect(page.locator("#cockpit-monthly-export")).toBeEnabled();
});

test("the Cockpit report panel fits the screen and passes axe in both themes", async ({ page }) => {
  await page.goto("/");
  const panel = await openMonthlyReport(page);
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    expect(box.width).toBeGreaterThan(0);
    expect(box.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="relatorio"]').analyze();
    expect(audit.violations.map(violation => violation.id), theme).toEqual([]);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
});


test("changing month clears the previous preview until the new response arrives", async ({ page }) => {
  let release;
  await page.route("**/api/relatorio-mensal/dados**", async route => {
    const month = new URL(route.request().url()).searchParams.get("mes");
    if (month === "2026-09") await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: monthlyReport(month) });
  });
  await page.goto("/");
  await openMonthlyReport(page);
  await expect(page.locator("#cockpit-monthly-copy")).toBeEnabled();
  await page.locator("#cockpit-monthly-month").fill("2026-09");
  await expect(page.locator("#cockpit-monthly-copy")).toBeDisabled();
  await expect(page.locator("#cockpit-monthly-preview")).toBeEmpty();
  await expect.poll(() => typeof release).toBe("function");
  release();
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("setembro de 2026");
  await expect(page.locator("#cockpit-monthly-copy")).toBeEnabled();
});

test("the Cockpit report detail keeps card rows on phones without horizontal scroll", async ({ page }) => {
  await routeMonthly(page);
  await page.goto("/");
  await openMonthlyReport(page);
  const details = page.locator("#cockpit-monthly-details");
  await expect(details.locator('[data-rel-secao="os"] td[data-label="Série"]').first()).toHaveText("SN-OS-1");
  await expect(details.locator('[data-rel-secao="comp"] td[data-label="Local na Simpress"]').first()).toHaveText("Maringá");
  const { width } = page.viewportSize();
  const grid = (await details.locator(".ck-rel__base-grade").evaluate(el => getComputedStyle(el).gridTemplateColumns)).trim().split(/\s+/);
  expect(grid).toHaveLength(width < 1200 ? 1 : 3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("the report links each row to Home, OS (F6), Resumo (F3) and Chamados (F5) without writing data", async ({ page }) => {
  await routeMonthly(page);
  const writes = [];
  // usuarios-logados é consulta (POST só para mandar a lista de séries; routers/aliases.py), feita pela aba OS ao abrir.
  const readOnlyPosts = ["/api/equipamentos/usuarios-logados"];
  page.on("request", request => {
    if (["GET", "HEAD"].includes(request.method()) || readOnlyPosts.includes(new URL(request.url()).pathname)) return;
    writes.push(`${request.method()} ${request.url()}`);
  });
  await page.goto("/");
  await openMonthlyReport(page);
  const details = page.locator("#cockpit-monthly-details");

  const sebrae = details.locator('[data-rel-secao="sebrae"]');
  await expect(sebrae).toContainText("Situação atual");
  await expect(sebrae.locator(".ck-rel__numero").first()).toContainText("1");
  await expect(sebrae.locator(".ck-rel__numero").nth(1)).toContainText("2");
  await page.locator("#cockpit-monthly-month").fill("2026-10");
  await expect(sebrae.locator("tbody tr")).toHaveCount(1);
  await expect(sebrae.locator("tbody tr")).toContainText("UTIC-2026-10");
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("Chamados (F5), situação atual: 1 novo · 2 antigos em aberto");

  await details.getByRole("button", { name: "Abrir no Resumo (F3)" }).click();
  await expect(page.locator('[data-cockpit-tool-panel="comparacao"]')).toBeVisible();

  await openMonthlyReport(page);
  await details.getByRole("button", { name: "Ver OS-FIC-1 na aba OS (F6), pela série SN-OS-1" }).click();
  await expect(page.locator('[data-cockpit-tool-panel="chamados"]')).toBeVisible();
  await expect(page.locator("#cockpit-tickets-search")).toHaveValue("SN-OS-1");

  await openMonthlyReport(page);
  await details.locator('[data-rel-secao="sebrae"]').getByRole("button", { name: "Abrir UTIC-2026-10 na aba Chamados (F5)" }).click();
  await expect(page.locator('[data-cockpit-tool-panel="sebrae-chamados"]')).toBeVisible();

  await openMonthlyReport(page);
  await details.locator('[data-rel-secao="comp"]').getByRole("button", { name: "Abrir SN-COMP-1 na Home" }).click();
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
  await expect(page.locator("#input-serial")).toHaveValue("SN-COMP-1");
  expect(writes).toEqual([]);
});

test("the report reloads quietly when OS are imported while it is open and keeps the filter", async ({ page }) => {
  let calls = 0;
  await page.route(/\/api\/relatorio-mensal\/dados(?:\?|$)/, route => {
    calls += 1;
    const report = monthlyReport(new URL(route.request().url()).searchParams.get("mes"));
    if (calls > 1) report.os.oracle.pendentes = 9;
    return route.fulfill({ json: report });
  });
  await page.route("**/api/sebrae/novos", route => route.fulfill({ json: sebraeNovos() }));
  await page.goto("/");
  await openMonthlyReport(page);
  const details = page.locator("#cockpit-monthly-details");
  await details.getByRole("button", { name: "Concluídas" }).click();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("simpress:chamados-atualizados")));
  await expect(page.locator("#cockpit-monthly-kpis .ck-rel__atencao").first()).toContainText("9");
  await expect(details.getByRole("button", { name: "Concluídas" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#cockpit-monthly-status")).not.toContainText("Carregando");
});

test("a Sebrae failure keeps the monthly report and explains it in the Chamados block", async ({ page }) => {
  await page.route(/\/api\/relatorio-mensal\/dados(?:\?|$)/, route => route.fulfill({ json: monthlyReport(new URL(route.request().url()).searchParams.get("mes")) }));
  await page.route("**/api/sebrae/novos", route => route.fulfill({ status: 503, json: { detail: "Estado do Sebrae ilegível." } }));
  await page.goto("/");
  await openMonthlyReport(page);
  await expect(page.locator('[data-rel-secao="sebrae"] .ck-nota--erro')).toHaveText("Estado do Sebrae ilegível.");
  await expect(page.locator('[data-rel-secao="os"] tbody tr')).toHaveCount(2);
  await expect(page.locator("#cockpit-monthly-copy")).toBeEnabled();
  await expect(page.locator("#cockpit-monthly-preview")).not.toContainText("Chamados (F5)");
});
