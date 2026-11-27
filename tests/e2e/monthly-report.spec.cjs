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

// Sub-abas do F8 (Novo layout, 18/11/2026: a comparação saiu): [chave, rótulo exato]. A ordem é a da tablist.
const ABAS_RELATORIO = [["visao", "Visão geral"], ["os", "OS e pedidos do mês"], ["sebrae", "Chamados (F5)"], ["base", "Base atual"], ["tendencias", "Tendências"]];

// Só um painel fica visível; trocar de aba é clicar nela. As seções das outras abas existem, mas escondidas.
async function openReportTab(page, key) {
  await page.locator(`#rel-aba-${key}`).click();
  await expect(page.locator(`#rel-aba-${key}`)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`#rel-painel-${key}`)).toBeVisible();
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
    // Contagem do mês feita no servidor (etapa 2). 27206 (número antigo) não existe no F5: sem link.
    // UTIC-2026-11 é chamado novo da busca, com série vazia: a tela completa pela série do F5 (SN-UTIC-11).
    sebrae: {
      abertos: 3, finalizados: 2, sem_data: 4,
      linhas: [
        { chave: "27206", chamado: "27206", titulo: "Chamado antigo", serie: "SN-ANTIGO", abertura: null, finalizacao: "2026-10-08", situacoes: ["Finalizado no mês"] },
        { chave: "UTIC-2026-10", chamado: "UTIC-2026-10", titulo: "Notebook sem rede", serie: "SN-UTIC-10", abertura: "2026-10-12", finalizacao: null, situacoes: ["Aberto no mês"] },
        { chave: "UTIC-2026-11", chamado: "UTIC-2026-11", titulo: "Monitor apagado", serie: "", abertura: "2026-10-02", finalizacao: null, situacoes: ["Aberto no mês"] },
        { chave: "UTIC-2026-12", chamado: "UTIC-2026-12", titulo: "Já finalizado", serie: "SN-UTIC-12", abertura: "2026-10-01", finalizacao: "2026-10-20", situacoes: ["Aberto no mês", "Finalizado no mês"] },
      ],
    },
  };
}

function sebraeNovos() {
  return {
    // UTIC-2026-12 foi finalizado pelo site e ainda está em `abertos` (antes de reimportar): o F5 já não o conta como aberto.
    importado: {
      abertos: [
        { numero: "UTIC-2026-10", titulo: "Notebook sem rede", automaticos: { K: "SN-UTIC-10" }, leitura_softexpert: { habilitada_em: "12/10/2026 10:00" } },
        { numero: "linha:7", chamado: "", titulo: "Sem data", automaticos: {} },
        { numero: "UTIC-2026-12", titulo: "Já finalizado", automaticos: { K: "SN-UTIC-12" }, leitura_softexpert: { habilitada_em: "01/10/2026 09:00" } },
      ],
      finalizados: [{ numero: "UTIC-2026-12", encerrado_em: "20/10/2026 15:00", em: "2026-10-20T15:01:00-03:00", ficha: { titulo: "Já finalizado", fatos: [["Série", "SN-UTIC-12"]] } }],
    },
    novos: { formulario: [{ numero: "UTIC-2026-11", linha: { G: "Monitor apagado", K: "SN-UTIC-11", P: "02/09/2026 08:30" } }] },
  };
}

function tendencias(dias) {
  return {
    dias, inicio: "2026-08-01",
    tempo_medio_os: { encerradas: 12, encerradas_sem_data: 0, media_dias: 4.5, media_dias_anterior: 6.0 },
    sem_acesso_7_dias: { historico_desde: "2026-08-01", pontos: [{ data: "2026-10-01", total: 40 }, { data: "2026-10-10", total: 35 }, { data: "2026-10-20", total: 30 }] },
  };
}

const tendenciasVazias = dias => ({ dias, inicio: "2026-08-01", tempo_medio_os: { encerradas: 0, encerradas_sem_data: 0, media_dias: null, media_dias_anterior: null }, sem_acesso_7_dias: { pontos: [] } });

async function routeMonthly(page) {
  await page.route("**/api/relatorio-mensal/tendencias**", route => route.fulfill({ json: tendencias(Number(new URL(route.request().url()).searchParams.get("dias"))) }));
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
  await expect(page.locator("#cockpit-monthly-period")).toHaveText("Parcial até 25/10/2026");
  // O status vira texto só para leitor de tela (aria-live): a linha visível saiu do desenho.
  await expect(page.locator("#cockpit-monthly-status")).toHaveClass(/sr-only/);
  await expect(page.locator("#cockpit-monthly-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator(".ck-rel__previa")).not.toHaveAttribute("open", "");
  await expect(page.locator("#cockpit-monthly-preview")).toBeHidden();
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("OS Oracle pendentes no fim do período: 1");
  await expect(page.locator("#cockpit-monthly-preview")).not.toContainText("indisponível");

  const attention = page.locator("#cockpit-monthly-kpis");
  // Cartões de atenção: OS pendentes, Chamados (F5, fixo no partial) e Fora das contagens; a comparação saiu da tela.
  await expect(attention.locator(".ck-rel__atencao")).toHaveCount(2);
  await expect(attention.locator(".ck-rel__atencao").first()).toContainText("OS pendentes no fim do período");
  await expect(attention.locator("#cockpit-monthly-chamados")).toBeVisible();
  await expect(attention).not.toContainText("Comparação");
  const outside = attention.locator('.ck-rel__atencao[data-status="alerta"]');
  await expect(outside).toContainText("Fora das contagens");
  await expect(outside.locator("#cockpit-monthly-fora")).toBeHidden();
  await outside.getByRole("button", { name: "Mostrar registros" }).click();
  await expect(outside.locator("#cockpit-monthly-fora")).toContainText("OS-1");
  await expect(outside.getByRole("button", { name: "Ocultar registros" })).toHaveAttribute("aria-expanded", "true");

  const details = page.locator("#cockpit-monthly-details");
  await expect(details.locator('[data-rel-secao="movimento"] td[data-label="Encerradas"]').nth(1)).toHaveText("1");
  await openReportTab(page, "os");
  await expect(details.locator('[data-rel-secao="os"] tbody tr')).toHaveCount(2);
  await details.getByRole("button", { name: "Pendentes" }).click();
  await expect(details.locator('[data-rel-secao="os"] tbody tr')).toHaveCount(1);
  await expect(details.getByRole("button", { name: "Pendentes" })).toHaveAttribute("aria-pressed", "true");
  await expect(details.getByRole("button", { name: "Pendentes" })).toBeFocused();
  await openReportTab(page, "base");
  const base = details.locator('[data-rel-secao="base"]');
  await expect(base).toContainText("Não muda com o mês");
  await expect(base.locator(".ck-rel__unidade")).toHaveCount(8);
  await base.getByRole("button", { name: "Ver todas as 10 unidades" }).click();
  await expect(base.locator(".ck-rel__unidade")).toHaveCount(10);
  await expect(base.getByRole("button", { name: "Ver menos" })).toBeFocused();
  await openReportTab(page, "visao");
  await page.locator(".ck-rel__previa summary").click();
  await expect(page.locator("#cockpit-monthly-preview")).toBeVisible();

  await month.fill("2026-09");
  await expect(page.locator("#cockpit-monthly-period")).toHaveText("Mês encerrado");
  await expect(page.locator("#cockpit-monthly-status")).toContainText("Mês encerrado");
  const download = page.waitForEvent("download");
  await page.locator("#cockpit-monthly-export").click();
  expect((await download).suggestedFilename()).toBe("Relatorio-mensal-2026-09.xlsx");
  expect(requestedData).toContain("2026-09");
  expect(requestedWorkbook).toEqual(["2026-09"]);
  await expect(page.locator("#toast-container")).toContainText("Planilha Exportada com Sucesso!");
});

test("the Cockpit report shows local API errors in its status region and in a toast", async ({ page }) => {
  await page.route("**/api/relatorio-mensal/dados**", route => route.fulfill({
    status: 503, json: { detail: "A base oficial EquipamentosDetalhes não está carregada." },
  }));
  await page.goto("/");
  await openMonthlyReport(page);
  await expect(page.locator("#cockpit-monthly-status")).toHaveText("A base oficial EquipamentosDetalhes não está carregada.");
  await expect(page.locator("#toast-container")).toContainText("A base oficial EquipamentosDetalhes não está carregada.");
  // O erro vai para #cockpit-monthly-estado, fora dos painéis: as abas continuam na tela.
  await expect(page.locator("#cockpit-monthly-estado .ck-nota--erro")).toHaveText("A base oficial EquipamentosDetalhes não está carregada.");
  await expect(page.getByRole("tablist", { name: "Assuntos do relatório" })).toBeVisible();
  await expect(page.locator("#cockpit-monthly-export")).toBeEnabled();
});

// O bento anima a entrada dos cartões (opacity 0→1): o Axe só mede contraste com a animação concluída (mesmo molde de color-contrast.spec.cjs).
const esperarAnimacoes = page => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations()
    .filter(item => item.playState === "running" && item.effect?.getTiming().iterations !== Infinity)
    .map(item => item.finished.catch(() => undefined))),
  new Promise(resolve => setTimeout(resolve, 3000)),
]));

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
    await esperarAnimacoes(page);
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
  await openReportTab(page, "os");
  await expect(details.locator('[data-rel-secao="os"] td[data-label="Série"]').first()).toHaveText("SN-OS-1");
  await openReportTab(page, "sebrae");
  await expect(details.locator('[data-rel-secao="sebrae"] td[data-label="Situação no mês"]').first()).toHaveText("Finalizado no mês");
  await openReportTab(page, "base");
  const { width } = page.viewportSize();
  const grid = (await details.locator(".ck-rel__base-grade").evaluate(el => getComputedStyle(el).gridTemplateColumns)).trim().split(/\s+/);
  // Base atual (Bloco 2): totais num cartão inteiro e tipos e unidades lado a lado embaixo; uma coluna abaixo de 640px.
  expect(grid).toHaveLength(width < 640 ? 1 : 2);
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

  await openReportTab(page, "sebrae");
  const sebrae = details.locator('[data-rel-secao="sebrae"]');
  // Título e selo "Situação atual" ficam fora dos cartões; dois cartões (novos âmbar, antigos fúcsia) e o cartão da contagem do mês.
  await expect(sebrae.locator(".ck-rel__secao-cab")).toContainText("Situação atual");
  const cartoes = sebrae.locator(".nf8-cham-cartao");
  await expect(cartoes).toHaveCount(2);
  await expect(cartoes.first()).toContainText("Chamados novos");
  await expect(cartoes.first()).toContainText("1");
  await expect(cartoes.first()).toHaveAttribute("data-tom", "ambar");
  // A seta é aria-hidden: o nome acessível é "Ver novos"; o texto visível leva a seta.
  await expect(cartoes.first().getByRole("button", { name: "Ver novos" })).toContainText("Ver novos →");
  await expect(cartoes.nth(1)).toContainText("Antigos em aberto");
  await expect(cartoes.nth(1)).toContainText("2");
  await expect(cartoes.nth(1)).toHaveAttribute("data-tom", "fucsia");
  await expect(cartoes.nth(1).getByRole("button", { name: "Ver antigos" })).toContainText("Ver antigos →");
  // Contagem do mês (report.sebrae), depois da situação atual; o "sem data" é um chip no cabeçalho do cartão.
  const mes = sebrae.locator(".nf8-cham-info");
  await expect(mes.locator("h4")).toHaveText("Com data em outubro de 2026");
  await expect(mes.locator(".nf8-chip")).toHaveText("4 sem data");
  await expect(mes.locator(".ck-rel__numero")).toHaveCount(2);
  await expect(mes.locator(".ck-rel__numero").first()).toHaveText(/Abertos\s*3/);
  await expect(mes.locator(".ck-rel__numero").nth(1)).toHaveText(/Finalizados\s*2/);
  await expect(sebrae).not.toContainText("Só entram chamados com data conhecida");
  await expect(sebrae).not.toContainText("fora da contagem");
  await expect(sebrae.locator("tbody tr")).toHaveCount(4);
  const old = sebrae.locator("tbody tr").first();
  await expect(old).toContainText("27206");
  await expect(old.getByRole("button", { name: /na aba Chamados \(F5\)/ })).toHaveCount(0);
  await expect(old.getByRole("button", { name: "Abrir SN-ANTIGO na Home" })).toBeVisible();
  const fresh = sebrae.locator("tbody tr", { hasText: "UTIC-2026-11" });
  await expect(fresh.locator('td[data-label="Série"]')).toHaveText("SN-UTIC-11");
  await expect(fresh.locator('td[data-label="Abertura"]')).toHaveText("02/10/2026");
  const both = sebrae.locator("tbody tr", { hasText: "UTIC-2026-12" });
  await expect(both).toContainText("Aberto no mês");
  await expect(both).toContainText("Finalizado no mês");
  await expect(both.locator('td[data-label="Finalização"]')).toHaveText("20/10/2026");
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("Chamados (F5), situação atual: 1 novo · 2 antigos em aberto");
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("Chamados (F5), com data em outubro de 2026: Abertos no mês 3 · Finalizados no mês 2 · Sem data de abertura ou de encerramento: 4 (fora da contagem)");

  await openReportTab(page, "os");
  await details.getByRole("button", { name: "Ver OS-FIC-1 na aba OS (F6), pela série SN-OS-1" }).click();
  await expect(page.locator('[data-cockpit-tool-panel="chamados"]')).toBeVisible();
  await expect(page.locator("#cockpit-tickets-search")).toHaveValue("SN-OS-1");

  await openMonthlyReport(page);
  await openReportTab(page, "sebrae");
  await details.locator('[data-rel-secao="sebrae"]').getByRole("button", { name: "Abrir UTIC-2026-10 na aba Chamados (F5)" }).click();
  await expect(page.locator('[data-cockpit-tool-panel="sebrae-chamados"]')).toBeVisible();
  // Mesmos números nas duas abas: o F8 segue a regra do F5 (finalizado pelo site sai de Novos e Antigos).
  await expect(page.locator("#sebrae-novos-contagem")).toHaveText("1");
  await expect(page.locator("#sebrae-antigos-contagem")).toHaveText("2");

  await openMonthlyReport(page);
  await openReportTab(page, "os");
  await details.getByRole("button", { name: "Abrir SN-OS-1 na Home" }).click();
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
  await expect(page.locator("#input-serial")).toHaveValue("SN-OS-1");
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
  await openReportTab(page, "os");
  await details.getByRole("button", { name: "Concluídas" }).click();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("simpress:chamados-atualizados")));
  await expect(page.locator("#cockpit-monthly-kpis .ck-rel__atencao").first()).toContainText("9");
  await expect(details.getByRole("button", { name: "Concluídas" })).toHaveAttribute("aria-pressed", "true");
  // A recarga quieta também não tira o usuário da aba em que está.
  await expect(page.locator("#rel-aba-os")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#rel-painel-os")).toBeVisible();
  await expect(page.locator("#cockpit-monthly-status")).not.toContainText("Carregando");
});

test("a Sebrae failure keeps the monthly report and explains it in the Chamados block", async ({ page }) => {
  await page.route(/\/api\/relatorio-mensal\/dados(?:\?|$)/, route => route.fulfill({ json: monthlyReport(new URL(route.request().url()).searchParams.get("mes")) }));
  await page.route("**/api/sebrae/novos", route => route.fulfill({ status: 503, json: { detail: "Estado do Sebrae ilegível." } }));
  await page.goto("/");
  await openMonthlyReport(page);
  await openReportTab(page, "sebrae");
  await expect(page.locator('[data-rel-secao="sebrae"] .ck-nota--erro')).toHaveText("Estado do Sebrae ilegível.");
  await expect(page.locator('[data-rel-secao="os"] tbody tr')).toHaveCount(2);
  await expect(page.locator("#cockpit-monthly-copy")).toBeEnabled();
  await expect(page.locator("#cockpit-monthly-preview")).not.toContainText("Chamados (F5), situação atual");
  // A contagem do mês vem do relatório, não do F5: continua na tela (chip "4 sem data") e na prévia, sem link para o F5.
  await expect(page.locator('[data-rel-secao="sebrae"] .nf8-chip')).toHaveText("4 sem data");
  await expect(page.locator('[data-rel-secao="sebrae"]').getByRole("button", { name: /na aba Chamados \(F5\)/ })).toHaveCount(0);
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("Chamados (F5), com data em outubro de 2026: Abertos no mês 3");
});

test("a failed or missing month count keeps the current situation and the rest of the report", async ({ page }) => {
  let sebrae = { erro: "Não foi possível ler o Dashboard importado." };
  await page.route(/\/api\/relatorio-mensal\/dados(?:\?|$)/, route => route.fulfill({ json: { ...monthlyReport(new URL(route.request().url()).searchParams.get("mes")), sebrae } }));
  await page.route("**/api/sebrae/novos", route => route.fulfill({ json: sebraeNovos() }));
  await page.goto("/");
  await openMonthlyReport(page);
  await openReportTab(page, "sebrae");
  const block = page.locator('[data-rel-secao="sebrae"]');
  await expect(block.locator(".ck-nota--erro")).toHaveText("Não foi possível ler o Dashboard importado.");
  await expect(block.locator(".nf8-cham-cartao")).toHaveCount(2);
  await expect(block.locator(".ck-rel__numero")).toHaveCount(0);
  await expect(block).toContainText("Chamados novos");
  await expect(page.locator('[data-rel-secao="os"] tbody tr')).toHaveCount(2);
  await expect(page.locator("#cockpit-monthly-preview")).toContainText("Chamados (F5), situação atual");
  await expect(page.locator("#cockpit-monthly-preview")).not.toContainText("com data em");

  sebrae = null;
  await page.locator("#cockpit-monthly-month").fill("2026-09");
  await expect(block.locator(".nf8-cham-info h4")).toHaveText("Com data em setembro de 2026");
  await expect(block.locator(".ck-lista__vazio")).toHaveText("Nenhum Dashboard importado. A importação e a busca ficam na aba Automação (F4).");
  await expect(block.locator(".ck-nota--erro")).toHaveCount(0);
  await expect(page.locator("#cockpit-monthly-preview")).not.toContainText("com data em");
});

// Estado completo das quatro abas numa só leitura da página: aria-selected, tabindex rotativo (só a ativa entra na ordem do Tab) e um único painel visível.
async function expectReportTab(page, key, { focused = false } = {}) {
  const names = ABAS_RELATORIO.map(([name]) => name);
  const expected = Object.fromEntries(names.map(name => [name, { selected: String(name === key), tabindex: name === key ? "0" : "-1", visible: name === key }]));
  await expect.poll(() => page.evaluate(list => Object.fromEntries(list.map(name => {
    const tab = document.getElementById(`rel-aba-${name}`);
    const panel = document.getElementById(`rel-painel-${name}`);
    return [name, { selected: tab.getAttribute("aria-selected"), tabindex: tab.getAttribute("tabindex"), visible: panel.getClientRects().length > 0 }];
  })), names)).toEqual(expected);
  if (focused) await expect(page.locator(`#rel-aba-${key}`)).toBeFocused();
}

test("the report has five tabs, opens on Visão geral and shows the counters and the Chamados card", async ({ page }) => {
  await routeMonthly(page);
  await page.goto("/");
  await openMonthlyReport(page);
  const tabs = page.getByRole("tablist", { name: "Assuntos do relatório" }).getByRole("tab");
  await expect(tabs).toHaveCount(5);
  for (const [index, [key, label]] of ABAS_RELATORIO.entries()) {
    await expect(tabs.nth(index).locator(".rel-aba__rotulo")).toHaveText(label);
    await expect(tabs.nth(index)).toHaveAttribute("id", `rel-aba-${key}`);
    await expect(tabs.nth(index)).toHaveAttribute("aria-controls", `rel-painel-${key}`);
    const panel = page.locator(`#rel-painel-${key}`);
    await expect(panel).toHaveAttribute("role", "tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", `rel-aba-${key}`);
  }
  await expectReportTab(page, "visao");
  await expect(page.locator("#cockpit-monthly-estado")).toBeEmpty();

  // Contadores: OS = linhas da lista (alerta com mais de zero); Chamados = linhas da contagem do mês (neutro). A comparação saiu.
  await expect(page.locator("#rel-os-contagem")).toHaveText("2");
  await expect(page.locator("#rel-os-contagem")).toHaveAttribute("data-status", "alerta");
  await expect(page.locator("#rel-comp-contagem")).toHaveCount(0);
  await expect(page.locator("#rel-sebrae-contagem")).toHaveText("4");
  await expect(page.locator("#rel-sebrae-contagem")).not.toHaveAttribute("data-status", /.+/);
  await expect(page.locator("#rel-aba-visao .rel-aba__n, #rel-aba-base .rel-aba__n")).toHaveCount(0);

  // Visão geral: atenção (com o cartão Chamados (F5)), movimento e prévia; as listas ficam nas outras abas.
  const overview = page.locator("#rel-painel-visao");
  await expect(overview.locator("#cockpit-monthly-attention")).toBeVisible();
  await expect(overview.locator('[data-rel-secao="movimento"]')).toBeVisible();
  const strip = overview.locator("#cockpit-monthly-chamados");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(/Abertos no mês\s*3/);
  await expect(strip).toContainText(/Finalizados\s*2/);
  await expect(strip.locator('.nf8-chip[data-nl-tom="ambar"]')).toHaveText(/1\s*novos/);
  await expect(strip.locator('.nf8-chip[data-nl-tom="fucsia"]')).toHaveText(/2\s*antigos/);
  await expect(strip.getByRole("button", { name: "Ver chamados →" })).toBeVisible();
  await expect(overview.locator(".ck-rel__previa")).toBeVisible();
  await expect(page.locator("#rel-painel-os tbody tr")).toHaveCount(2);
});

test("clicking, arrow keys, Home and End switch tabs with a roving tabindex", async ({ page }) => {
  await routeMonthly(page);
  await page.goto("/");
  await openMonthlyReport(page);

  for (const [key] of ABAS_RELATORIO) {
    await page.locator(`#rel-aba-${key}`).click();
    await expectReportTab(page, key);
  }

  await page.locator("#rel-aba-visao").click();
  await page.locator("#rel-aba-visao").focus();
  await page.keyboard.press("ArrowRight");
  await expectReportTab(page, "os", { focused: true });
  await page.keyboard.press("ArrowRight");
  await expectReportTab(page, "sebrae", { focused: true });
  await page.keyboard.press("ArrowLeft");
  await expectReportTab(page, "os", { focused: true });
  await page.keyboard.press("ArrowRight");
  await expectReportTab(page, "sebrae", { focused: true });
  await page.keyboard.press("ArrowRight");
  await expectReportTab(page, "base", { focused: true });
  await page.keyboard.press("ArrowRight");
  await expectReportTab(page, "tendencias", { focused: true });
  await page.keyboard.press("ArrowRight");
  await expectReportTab(page, "visao", { focused: true });
  await page.keyboard.press("ArrowLeft");
  await expectReportTab(page, "tendencias", { focused: true });
  await page.keyboard.press("Home");
  await expectReportTab(page, "visao", { focused: true });
  await page.keyboard.press("End");
  await expectReportTab(page, "tendencias", { focused: true });
  await page.keyboard.press("Home");
  await expectReportTab(page, "visao", { focused: true });

  // Só a aba ativa está na ordem do Tab: Tab sai da tablist em vez de percorrer as outras quatro.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).not.toBe("tab");
});

test("the report keeps its tab when the month changes and keeps the tablist while loading", async ({ page }) => {
  let release;
  await page.route("**/api/relatorio-mensal/dados**", async route => {
    const month = new URL(route.request().url()).searchParams.get("mes");
    if (month === "2026-09") await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: monthlyReport(month) });
  });
  await page.route("**/api/sebrae/novos", route => route.fulfill({ json: sebraeNovos() }));
  await page.goto("/");
  await openMonthlyReport(page);
  await openReportTab(page, "base");
  await expect(page.locator("#rel-os-contagem")).toHaveText("2");

  await page.locator("#cockpit-monthly-month").fill("2026-09");
  await expect(page.locator("#cockpit-monthly-estado")).toContainText("Carregando relatório mensal local…");
  // Carregando: abas à vista, painéis vazios e contadores ocultos (nada de número do mês anterior).
  await expect(page.getByRole("tablist", { name: "Assuntos do relatório" })).toBeVisible();
  await expect(page.locator("#rel-os-contagem")).toBeHidden();
  await expect(page.locator("#rel-painel-base")).toBeEmpty();
  await expect.poll(() => typeof release).toBe("function");
  release();

  await expect(page.locator("#cockpit-monthly-estado")).toBeEmpty();
  await expectReportTab(page, "base");
  await expect(page.locator("#rel-painel-base")).toContainText("Não muda com o mês");
  await expect(page.locator("#rel-os-contagem")).toHaveText("2");
  await expect(page.locator("#cockpit-monthly-status")).toContainText("Mês encerrado");
});

test("Ver lista and Ver chamados switch to the right tab and focus its title", async ({ page }) => {
  await routeMonthly(page);
  await page.goto("/");
  await openMonthlyReport(page);
  const details = page.locator("#cockpit-monthly-details");

  // OS: abre a aba OS já filtrada em Pendentes e foca o título da seção.
  await page.getByRole("button", { name: "Ver lista de OS e pedidos pendentes" }).click();
  await expectReportTab(page, "os");
  await expect(page.locator("#cockpit-monthly-os-title")).toBeFocused();
  await expect(details.getByRole("button", { name: "Pendentes" })).toHaveAttribute("aria-pressed", "true");
  await expect(details.locator('[data-rel-secao="os"] tbody tr')).toHaveCount(1);

  // Cartão Chamados (F5).
  await openReportTab(page, "visao");
  await page.getByRole("button", { name: "Ver chamados →" }).click();
  await expectReportTab(page, "sebrae");
  await expect(page.locator("#cockpit-monthly-sebrae-title")).toBeFocused();
  await expect(details.locator('[data-rel-secao="sebrae"] tbody tr')).toHaveCount(4);
});

test("the tablist scrolls on its own at 320px and the page never scrolls horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await routeMonthly(page);
  await page.goto("/");
  await openMonthlyReport(page);
  const noPageScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  const tablist = page.getByRole("tablist", { name: "Assuntos do relatório" });
  const box = await tablist.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  // As abas não cabem em 320px: quem rola é a própria barra, nunca a página.
  expect(await tablist.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await tablist.evaluate(el => getComputedStyle(el).overflowX)).toBe("auto");
  for (const [key] of ABAS_RELATORIO) {
    await openReportTab(page, key);
    expect(await noPageScroll(), key).toBe(true);
  }
  // A última aba é alcançável pelo teclado mesmo fora da área visível da barra.
  await page.locator("#rel-aba-visao").focus();
  await page.keyboard.press("End");
  await expectReportTab(page, "tendencias", { focused: true });
  expect(await noPageScroll()).toBe(true);
});

test("every report tab passes axe in both themes", async ({ page }) => {
  test.setTimeout(60_000); // oito análises axe (quatro abas, dois temas) passam de 20 s em máquina carregada
  await routeMonthly(page);
  await page.goto("/");
  await openMonthlyReport(page);
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    for (const [key] of ABAS_RELATORIO) {
      await openReportTab(page, key);
      await esperarAnimacoes(page);
      const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="relatorio"]').analyze();
      expect(audit.violations.map(violation => violation.id), `${theme}/${key}`).toEqual([]);
    }
  }
});

// Limpeza dos textos explicativos (Bloco 2): as notas dos cartões ficam num ⓘ escondido até mouse, toque ou foco; Esc fecha só o balão.
test("the report keeps the card notes in an ⓘ that opens on hover, tap or focus and closes with Esc", async ({ page }, testInfo) => {
  await routeMonthly(page);
  await page.goto("/");
  const panel = await openMonthlyReport(page);
  const abrir = async (trigger, bubble) => {
    await expect(bubble).toBeHidden();
    if (testInfo.project.use.hasTouch) await trigger.tap();
    else await trigger.hover();
    await expect(bubble).toBeVisible();
    await page.mouse.move(0, 0);
    await trigger.focus();
    await page.keyboard.press("Escape");
    await expect(bubble).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(trigger).toBeFocused();
  };

  const pending = page.locator("#cockpit-monthly-pendentes-nota");
  await expect(pending).toHaveText("Criados até o corte e ainda sem conclusão ou entrega.");
  await expect(page.locator("#cockpit-monthly-kpis p.ck-rel__nota", { hasText: "Criados até o corte" })).toHaveCount(0);
  const pendingTrigger = page.locator('#cockpit-monthly-kpis .info-tip-trigger[aria-describedby="cockpit-monthly-pendentes-nota"]');
  await expect(pendingTrigger).toHaveAttribute("aria-label", "Sobre as OS pendentes");
  // O ⓘ (24px) não estica a linha do título até os 40px do botão padrão.
  expect(await pendingTrigger.evaluate(no => no.closest(".ck-rel__cartao-cab").getBoundingClientRect().height)).toBeLessThanOrEqual(28);
  await abrir(pendingTrigger, pending);

  const fora = page.locator("#cockpit-monthly-fora-nota");
  await expect(fora).toHaveText("Datas ou vínculo insuficientes: não entram nos números do mês.");
  await expect(page.locator("#cockpit-monthly-kpis p.ck-rel__nota", { hasText: "Datas ou vínculo" })).toHaveCount(0);
  const foraTrigger = page.locator('#cockpit-monthly-kpis .info-tip-trigger[aria-describedby="cockpit-monthly-fora-nota"]');
  await expect(foraTrigger).toHaveAttribute("aria-label", "Sobre fora das contagens");
  // O total e o botão de listar continuam na tela, fora do ⓘ.
  await expect(page.locator('#cockpit-monthly-kpis .ck-rel__atencao[data-status="alerta"]').getByRole("button", { name: "Mostrar registros" })).toBeVisible();
  await abrir(foraTrigger, fora);

  await openReportTab(page, "sebrae");
  const note = page.locator("#cockpit-monthly-sebrae-nota");
  await expect(note).toHaveText("Contagem pelo Dashboard importado (abertura em P, encerramento em R), pelos chamados novos da busca e pelos finalizados pelo site.");
  await expect(page.locator("#rel-painel-sebrae .nf8-cham-info h4")).toHaveText("Com data em outubro de 2026");
  // O que é número ou aviso de dado segue na tela, fora do ⓘ.
  await expect(page.locator("#rel-painel-sebrae .nf8-chip")).toHaveText("4 sem data");
  await abrir(page.locator('#rel-painel-sebrae .info-tip-trigger[aria-describedby="cockpit-monthly-sebrae-nota"]'), note);
});

// Novo layout (18/11/2026): rótulo do filtro, paginação de 20 e gráfico do movimento (segmentado Fonte, barras por semana, entrada escalonada).
test("the OS tab labels its filter and paginates by 20, and the movement chart groups bars by week", async ({ page }) => {
  await routeMonthly(page);
  // Mais específico que o de routeMonthly (o último registrado vale primeiro): 45 linhas de OS, todas dentro do mês pedido.
  await page.route(/\/api\/relatorio-mensal\/dados(?:\?|$)/, route => {
    const mes = new URL(route.request().url()).searchParams.get("mes");
    const report = monthlyReport(mes);
    report.mes = { key: mes, label: "mês de teste", parcial: false, data_corte: `${mes}-28` };
    report.os.linhas = Array.from({ length: 45 }, (_, index) => ({
      fonte: index % 2 ? "Simpress" : "Oracle", identificador: `OS-P-${index + 1}`, serie: `SN-P-${index + 1}`, status: "Em atendimento",
      criacao: `${mes}-${String((index % 20) + 1).padStart(2, "0")}`, conclusao: null, situacao: ["Aberta no mês", "Pendente no fim do mês"],
    }));
    return route.fulfill({ json: report });
  });
  await page.goto("/");
  await openMonthlyReport(page);

  // Gráfico: segmentado "Fonte", área com role="img", uma barra por série e semana, cada uma com title, entrada de 40 ms em 40 ms.
  const movimento = page.locator("#cockpit-monthly-movimento");
  const fonte = movimento.getByRole("group", { name: "Fonte" });
  await expect(fonte.getByRole("button")).toHaveText(["Ambas", "Oracle", "Simpress"]);
  await expect(fonte.getByRole("button", { name: "Ambas" })).toHaveAttribute("aria-pressed", "true");
  const plot = movimento.locator('.nf8-plot[role="img"]');
  await expect(plot).toBeVisible();
  await expect(plot).toHaveAttribute("aria-label", /^Movimento do mês por semana, Oracle e Simpress: /);
  const grupos = await movimento.locator(".nf8-gr").count();
  expect(grupos).toBeGreaterThanOrEqual(4);
  await expect(movimento.locator(".nf8-b")).toHaveCount(grupos * 3);
  expect(await movimento.locator(".nf8-b").evaluateAll(barras => barras.every(barra => barra.title.length > 0))).toBe(true);
  await expect(movimento.locator(".nf8-b").nth(0)).toHaveAttribute("style", /animation-delay: 0ms/);
  await expect(movimento.locator(".nf8-b").nth(1)).toHaveAttribute("style", /animation-delay: 40ms/);
  await expect(movimento.locator(".nf8-leg")).toContainText("Abertas");
  await fonte.getByRole("button", { name: "Oracle" }).click();
  await expect(fonte.getByRole("button", { name: "Oracle" })).toHaveAttribute("aria-pressed", "true");
  await expect(movimento.locator('.nf8-plot[role="img"]')).toHaveAttribute("aria-label", /^Movimento do mês por semana, Oracle: /);

  // OS: rótulo acima do segmentado e páginas de 20.
  await openReportTab(page, "os");
  const painel = page.locator("#rel-painel-os");
  await expect(painel.locator(".nf8-rotulo")).toHaveText("Filtrar por situação");
  await expect(painel.locator("tbody tr")).toHaveCount(20);
  await expect(painel.locator(".ck-rel__nota", { hasText: "Mostrando" })).toHaveText("Mostrando 20 de 45");
  await painel.getByRole("button", { name: "Carregar mais" }).click();
  await expect(painel.locator("tbody tr")).toHaveCount(40);
  await expect(painel.locator(".ck-rel__nota", { hasText: "Mostrando" })).toHaveText("Mostrando 40 de 45");
  await painel.getByRole("button", { name: "Carregar mais" }).click();
  await expect(painel.locator("tbody tr")).toHaveCount(45);
  await expect(painel.getByRole("button", { name: "Carregar mais" })).toHaveCount(0);
});

test("the Tendências tab loads 30 days, switches to 90 and ignores the month bar", async ({ page }) => {
  const pedidos = [];
  await routeMonthly(page);
  await page.route("**/api/relatorio-mensal/tendencias**", route => {
    const dias = new URL(route.request().url()).searchParams.get("dias");
    pedidos.push(dias);
    return route.fulfill({ json: tendencias(Number(dias)) });
  });
  await page.goto("/");
  await openMonthlyReport(page);
  expect(pedidos).toEqual([]);
  await openReportTab(page, "tendencias");
  const painel = page.locator("#rel-painel-tendencias");
  await expect(painel.locator("#rel-tend-tempo .nf8-tend__num")).toContainText("4,5");
  await expect(painel.locator("#rel-tend-acesso .nf8-tend__num")).toContainText("30");
  await expect(painel.locator("#rel-tend-acesso svg.nf8-tend__svg[role=img]")).toHaveAttribute("aria-label", /de 40 em 01\/10 para 30 em 20\/10/);
  await expect(painel.locator("#rel-tend-tempo .nf8-tend__bom")).toHaveText("−1,5 dia");
  await expect(painel).toContainText("Até hoje · não muda com o mês");
  expect(pedidos).toEqual(["30"]);
  const grupo = painel.getByRole("group", { name: "Período" });
  await expect(grupo.locator('[data-rel-periodo="30"]')).toHaveAttribute("aria-pressed", "true");
  await grupo.locator('[data-rel-periodo="90"]').click();
  await expect(grupo.locator('[data-rel-periodo="90"]')).toHaveAttribute("aria-pressed", "true");
  await expect(grupo.locator('[data-rel-periodo="30"]')).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => pedidos).toEqual(["30", "90"]);
  // Trocar o mês não pede tendências de novo.
  await page.locator("#cockpit-monthly-month").fill("2026-09");
  await expect(page.locator("#cockpit-monthly-status")).toContainText("Mês encerrado");
  await expect(painel.locator("#rel-tend-tempo")).toBeVisible();
  expect(pedidos).toEqual(["30", "90"]);
});

test("the Tendências tab shows the empty state in both cards", async ({ page }) => {
  await routeMonthly(page);
  await page.route("**/api/relatorio-mensal/tendencias**", route => route.fulfill({ json: tendenciasVazias(30) }));
  await page.goto("/");
  await openMonthlyReport(page);
  await openReportTab(page, "tendencias");
  const vazios = page.locator("#rel-painel-tendencias .nf8-tend__vazio[role=status]");
  await expect(vazios).toHaveCount(2);
  await expect(vazios.nth(0)).toContainText("Sem dados suficientes nos últimos 30 dias.");
  await expect(vazios.nth(0)).toContainText("Nenhuma OS Oracle encerrada com data no período.");
  await expect(vazios.nth(1)).toContainText("Menos de 2 atualizações de inventário no período.");
});

test("the Tendências tab explains a load failure", async ({ page }) => {
  await routeMonthly(page);
  await page.route("**/api/relatorio-mensal/tendencias**", route => route.fulfill({ status: 500, json: {} }));
  await page.goto("/");
  await openMonthlyReport(page);
  await openReportTab(page, "tendencias");
  await expect(page.locator("#rel-painel-tendencias p.nf8-tend__aviso")).toContainText("Falha ao carregar as tendências.");
});

test("the Tendências tab fits 320px and passes axe in both themes", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 320, height: 700 });
  await routeMonthly(page);
  await page.goto("/");
  await openMonthlyReport(page);
  await openReportTab(page, "tendencias");
  await expect(page.locator("#rel-tend-tempo")).toBeVisible();
  await expect(page.locator("#rel-tend-acesso")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    await esperarAnimacoes(page);
    const audit = await new AxeBuilder({ page }).include("#rel-painel-tendencias").analyze();
    expect(audit.violations.map(violation => violation.id), theme).toEqual([]);
  }
});
