const { test, expect } = require("@playwright/test");

function reportWith(calledOrders = ["7285070", "7285071"]) {
  return {
    chamados: [
      {
        serie: "DEMO-SN-001",
        simpress: { ordens_servico: calledOrders },
        oracle: [
          { solicitacao: "REQ-1", ordem_servico: "7285070", descricao: "Solicito suporte técnico." },
          { solicitacao: "REQ-2", ordem_servico: "7285070", descricao: "<img src=x onerror=alert(1)>" },
          { solicitacao: "REQ-3", ordem_servico: "7285072", status: "Encerrada", descricao: "" },
          { solicitacao: "REQ-SEM-OS", ordem_servico: "", descricao: "Não deve aparecer." },
        ],
      },
      {
        serie: "DEMO-SN-AMB",
        simpress: { ordens_servico: [] },
        oracle: [{ solicitacao: "REQ-AMB", ordem_servico: "7285073", descricao: "Equipamento ambíguo." }],
      },
      {
        serie: "",
        simpress: { ordens_servico: ["7285099"] },
        oracle: [{ solicitacao: "REQ-SEM-SERIE", ordem_servico: "7285098", descricao: "Não deve aparecer." }],
      },
    ],
  };
}

function normalized(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function linkKey(link) {
  return JSON.stringify([link.fonte, normalized(link.serie), String(link.os || "").replace(/\s+/g, "").toUpperCase()]);
}

async function installSummaryRoutes(page, { links = new Map(), onReportRequest = null, getUsers = null } = {}) {
  await page.route("**/api/operacoes/chamados", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    if (onReportRequest) await onReportRequest(route);
    else await route.fulfill({ json: reportWith() });
  });
  await page.route("**/api/operacoes/chamados/vinculos-os", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { vinculos: [...links.values()] } });
    const payload = route.request().postDataJSON();
    if (payload.numero) {
      const vinculo = { ...payload, chamado: `UTIC-${payload.ano}-${payload.numero}` };
      links.set(linkKey(payload), vinculo);
      return route.fulfill({ json: { vinculo } });
    }
    links.delete(linkKey(payload));
    return route.fulfill({ json: { vinculo: null } });
  });
  await page.route("**/api/equipamentos/usuarios-logados", async route => {
    const body = route.request().postDataJSON();
    const users = {};
    for (const serie of body.series || []) {
      users[serie] = getUsers ? getUsers(serie) : serie === "DEMO-SN-AMB"
        ? { usuario: "", candidatos: ["alice", "bob"], hostname: "", hostname_ambiguo: true,
            hostname_candidatos: ["PRNOTEDEMO-A", "PRNOTEDEMO-B"] }
        : { usuario: "usuario.demo", candidatos: [], hostname: "PRNOTEDEMO01", hostname_ambiguo: false,
            hostname_candidatos: [] };
    }
    return route.fulfill({ json: { usuarios: users } });
  });
}

// A tabela de OS vive no painel Chamados (F5): "#cockpit-tickets-os .ck-os".
const SECAO = "#cockpit-tickets-os .ck-os";

async function openChamados(page) {
  // Chamados fica na barra principal; abaixo de 1200px só o menu Ferramentas o oferece.
  const naBarra = await page.locator("#btn-acompanhamento-chamados").isVisible();
  if (!naBarra) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra ? "#btn-acompanhamento-chamados" : "#btn-chamados-menu").click();
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
}

async function selectSummary(page) {
  await openChamados(page);
  await expect(page.locator(SECAO)).toBeVisible();
  await expect(page.locator(SECAO)).toContainText(" OS · ");
}

async function openSummary(page) {
  await page.goto("/");
  await expect(page.locator("#stat-equipamentos")).toHaveText("1");
  await selectSummary(page);
}

test("Chamados associa OS aos chamados UTIC com prefixo anual e preserva dados do chamado", async ({ page }) => {
  const links = new Map();
  await installSummaryRoutes(page, { links });
  await openSummary(page);

  const section = page.locator(SECAO);
  await expect(section).toContainText("7285072");
  // Uma linha por OS (Oracle e Simpress unidas), na mesma tabela (no mobile o CSS a apresenta como cards).
  const rows = page.locator("#ck-os-tabela tbody tr");
  await expect(rows).toHaveCount(4);
  const seriesGroup = rows.filter({ hasText: "DEMO-SN-001" });
  await expect(seriesGroup).toHaveCount(3);
  await expect(section).toContainText("usuario.demo");
  await expect(section).toContainText("PRNOTEDEMO01");
  await expect(section).toContainText("Ambíguo: alice / bob");
  await expect(section).toContainText("Ambíguo: PRNOTEDEMO-A / PRNOTEDEMO-B");
  await expect(section).toContainText("Solicitação REQ-1: Solicito suporte técnico.");
  await expect(section).toContainText("Solicitação REQ-2: <img src=x onerror=alert(1)>");
  await expect(section.locator("img")).toHaveCount(0);
  await expect(section).toContainText("Descrição não informada");

  const mobile = await page.locator(".ticket-summary-mobile").count() > 0;
  expect(mobile).toBe(false);
  const unitedRow = seriesGroup.filter({ hasText: "7285070" });
  await expect(unitedRow).toHaveCount(1);
  await expect(unitedRow.locator(".ck-os-fonte .ck-tag")).toHaveText(["Oracle", "Simpress"]);
  await expect(unitedRow.locator(".ticket-os-link-input")).toHaveCount(1);
  await expect(unitedRow.locator(".ticket-summary-description-entry")
    .filter({ hasText: "Solicito suporte técnico." })).toHaveCount(1);
  const simpressOnly = seriesGroup.filter({ hasText: "7285071" });
  await expect(simpressOnly.locator(".ck-tag")).toHaveText(["Simpress"]);
  await expect(simpressOnly.locator(".ticket-summary-description")).toHaveText("Descrição não informada");
  await expect(seriesGroup.locator(".ticket-summary-description-label")).toHaveCount(0);
  // A célula da OS fica alinhada ao topo, como as demais.
  const osTop = await unitedRow.locator('td[data-label="OS"] button').evaluate(b => b.getBoundingClientRect().top - b.closest("td").getBoundingClientRect().top);
  const serieTop = await unitedRow.locator('td[data-label="Série"]').evaluate(td => { const r = document.createRange(); r.selectNodeContents(td); return r.getBoundingClientRect().top - td.getBoundingClientRect().top; });
  expect(Math.abs(osTop - serieTop)).toBeLessThan(6);
  const serialFont = await seriesGroup.first().locator('td[data-label="Série"]').evaluate(element => getComputedStyle(element).fontFamily);
  const hostFont = await seriesGroup.first().locator('td[data-label="Hostname"]').evaluate(element => getComputedStyle(element).fontFamily);
  expect(serialFont).toBe(hostFont);

  await expect(section).toContainText("4 OS · 2 séries");
  const orderContainer = unitedRow;
  const oracleSlot = orderContainer.locator(".ck-os-fonte").filter({ has: page.getByLabel(/fonte Oracle/) });
  const input = oracleSlot.locator("input.ticket-os-link-input");
  const prefix = oracleSlot.locator(".ticket-os-link-prefix");
  const year = new Date().getFullYear();
  await expect(prefix).toHaveText(`UTIC-${year}-`);
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await expect(input).toHaveAttribute("placeholder", "0000");
  await input.fill("1116");
  await oracleSlot.getByRole("button", { name: "Salvar" }).click();
  await expect(section.locator(".ticket-summary-status")).toHaveText(`Vínculo salvo: UTIC-${year}-1116.`);
  await expect(prefix).toHaveText(`UTIC-${year}-`);
  await expect(input).toHaveValue("1116");

  await page.reload();
  await selectSummary(page);
  const reloadedSeriesGroup = page.locator("#ck-os-tabela tbody tr").filter({ hasText: "DEMO-SN-001" });
  const linkedOrder = reloadedSeriesGroup.filter({ hasText: "7285070" });
  const linkedOracle = linkedOrder.locator(".ck-os-fonte").filter({ has: page.getByLabel(/fonte Oracle/) });
  await expect(linkedOracle.locator(".ticket-os-link-prefix")).toHaveText(`UTIC-${year}-`);
  await expect(linkedOracle.locator("input")).toHaveValue("1116");

  await linkedOrder.getByRole("button", {
    name: "Abrir acompanhamento de chamados: Oracle + Simpress, série DEMO-SN-001, OS 7285070",
  }).click();
  const dialog = page.locator("#modal-acompanhamento-chamados");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#filtro-acompanhamento-chamados")).toHaveValue("7285070");
  const ticketCards = dialog.locator("#lista-acompanhamento-chamados article[data-ticket-serial]");
  await expect(ticketCards).toHaveCount(1);
  const selectedTicket = ticketCards.first();
  await expect(selectedTicket).toHaveAttribute("data-ticket-serial", "DEMO-SN-001");
  await expect(selectedTicket.locator(".ticket-card-identifiers")).toContainText("7285070");
  await expect(selectedTicket.locator(".ticket-card-identifiers")).not.toContainText("7285071");
  await expect(selectedTicket.locator(".ticket-card-identifiers")).not.toContainText("7285072");
  await expect(selectedTicket).not.toContainText("REQ-3");
  await expect(selectedTicket.locator('details[data-ticket-section="details"]')).toHaveAttribute("open", "");
  await expect(selectedTicket.locator(".ticket-oracle-description").first()).toHaveAttribute("open", "");
  await expect(selectedTicket.locator(".ticket-oracle-description-content").first())
    .toContainText("Solicito suporte técnico.");
});

test("Chamados carrega as OS uma vez por abertura, mesmo com o painel da Home lento", async ({ page }) => {
  let reportRequests = 0;
  await installSummaryRoutes(page, {
    onReportRequest: async route => {
      reportRequests += 1;
      await route.fulfill({ json: reportWith() });
    },
  });
  // Um /api/painel lento não pode disparar nova carga das OS (só a abertura do painel Chamados carrega).
  await page.route("**/api/painel", async route => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fallback();
  });
  await page.goto("/");
  await selectSummary(page);
  await expect(page.locator(SECAO)).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);
  expect(reportRequests).toBe(1);
  // Cada nova abertura do painel faz uma única nova carga (a tabela já montada é atualizada, não duplicada).
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
  await openChamados(page);
  await expect.poll(() => reportRequests).toBe(2);
  await page.waitForTimeout(500);
  expect(reportRequests).toBe(2);
  await expect(page.locator(SECAO)).toHaveCount(1);
});

test("Chamados atualiza após mudanças e ignora respostas antigas", async ({ page }) => {
  let report = reportWith(["7285070"]);
  let reportRequests = 0;
  let delayedRequestNumber = null;
  let resolveDelayedCapture = null;
  let userName = "usuario.demo";
  await installSummaryRoutes(page, {
    onReportRequest: async route => {
      reportRequests += 1;
      const response = JSON.parse(JSON.stringify(report));
      if (reportRequests === delayedRequestNumber) {
        resolveDelayedCapture?.();
        resolveDelayedCapture = null;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      await route.fulfill({ json: response });
    },
    getUsers: () => ({ usuario: userName, candidatos: [], hostname: "PRNOTEDEMO01", hostname_ambiguo: false,
      hostname_candidatos: [] }),
  });
  await openSummary(page);
  const section = page.locator(SECAO);

  userName = "usuario.atualizado";
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("simpress:usuarios-equipamento-atualizados")));
  await expect(section).toContainText("usuario.atualizado");

  report = reportWith(["7285080"]);
  const beforeTicketRefresh = reportRequests;
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("simpress:chamados-atualizados")));
  await expect(section).toContainText("7285080");
  await expect.poll(() => reportRequests).toBeGreaterThan(beforeTicketRefresh);

  report = reportWith(["7285081"]);
  const beforeRace = reportRequests;
  delayedRequestNumber = beforeRace + 1;
  const staleResponseCaptured = new Promise(resolve => { resolveDelayedCapture = resolve; });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("simpress:chamados-atualizados")));
  await staleResponseCaptured;
  report = reportWith(["7285082"]);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("simpress:chamados-atualizados")));
  await expect(section).toContainText("7285082");
  await expect.poll(() => reportRequests).toBeGreaterThanOrEqual(beforeRace + 2);
  await page.waitForTimeout(350);
  await expect(section).toContainText("7285082");
  await expect(section).not.toContainText("7285081");
});

function reportComRelacoes() {
  return {
    snapshot_id: "snap-1",
    resumo: { series_total: 3, conferidas: 1, divergentes: 0, somente_oracle: 1, somente_simpress: 0, sem_os: 1 },
    chamados: [
      {
        serie: "REL-CONF-1", relacao: "conferida",
        simpress: { ordens_servico: ["9001"] },
        oracle: [{ solicitacao: "R-1", ordem_servico: "9001", descricao: "Troca de bateria." }],
      },
      {
        serie: "REL-SOR-2", relacao: "somente_oracle",
        simpress: { ordens_servico: [] },
        oracle: [{ solicitacao: "R-2", ordem_servico: "9002", descricao: "Tela quebrada." }],
      },
      { serie: "REL-SEMOS-3", relacao: "sem_os", simpress: { ordens_servico: [] }, oracle: [] },
    ],
  };
}

test("Chamados filtra a tabela de OS por Relação e busca, não lista séries sem OS e salva o UTIC com filtro ativo", async ({ page }) => {
  const links = new Map();
  await installSummaryRoutes(page, { links, onReportRequest: route => route.fulfill({ json: reportComRelacoes() }) });
  await openSummary(page);

  const section = page.locator(SECAO);
  const rows = page.locator("#ck-os-tabela tbody tr[data-serial]");
  const visible = page.locator("#ck-os-tabela tbody tr[data-serial]:visible");
  const status = section.locator(".ticket-summary-status");
  // A busca é a do painel; a tabela não cria a própria.
  await expect(page.locator("#cockpit-tickets-os #ck-os-busca")).toHaveCount(0);
  await expect(page.locator("#cockpit-tickets-kpis")).not.toContainText("Sem OS");
  await expect(page.locator("#cockpit-tickets-relation option[value=sem_os]")).toHaveCount(0);
  await expect(status).toHaveText("2 OS · 2 séries");
  await expect(rows).toHaveCount(2);
  await expect(page.locator("#ck-os-tabela")).not.toContainText("REL-SEMOS-3");

  const relation = page.locator("#cockpit-tickets-relation");
  await relation.selectOption("somente_oracle");
  await expect(visible).toHaveCount(1);
  await expect(visible).toHaveAttribute("data-serial", "REL-SOR-2");
  await expect(status).toHaveText("1 de 2 OS · 1 série");

  await relation.selectOption("todos");
  await expect(visible).toHaveCount(2);
  const search = page.locator("#cockpit-tickets-search");
  await search.fill("9001");
  await expect(visible).toHaveCount(1);
  await expect(visible).toHaveAttribute("data-serial", "REL-CONF-1");
  await search.fill("semos");
  await expect(visible).toHaveCount(0);
  // Busca e Relação se combinam.
  await search.fill("REL-");
  await relation.selectOption("conferida");
  await expect(visible).toHaveCount(1);
  await expect(visible).toHaveAttribute("data-serial", "REL-CONF-1");
  await search.fill("nao-existe");
  await expect(visible).toHaveCount(0);
  await search.fill("");
  await relation.selectOption("todos");
  await expect(visible).toHaveCount(2);
  await expect(status).toHaveText("2 OS · 2 séries");

  // Salvar o UTIC com um filtro ativo mantém o filtro depois que a tabela é recriada.
  await relation.selectOption("somente_oracle");
  await expect(visible).toHaveCount(1);
  const slot = visible.locator(".ck-os-fonte").filter({ has: page.getByLabel(/fonte Oracle/) });
  const year = new Date().getFullYear();
  await slot.locator("input.ticket-os-link-input").fill("4321");
  await slot.getByRole("button", { name: "Salvar" }).click();
  await expect(status).toContainText(`Vínculo salvo: UTIC-${year}-4321.`);
  expect([...links.values()].map(item => [item.serie, item.os, item.numero])).toEqual([["REL-SOR-2", "9002", "4321"]]);
  await expect(visible).toHaveCount(1);
  await expect(visible.locator("input.ticket-os-link-input").first()).toHaveValue("4321");
});

test("Chamados só pede a linha do tempo ao expandir o Andamento da série", async ({ page }) => {
  const timelineRequests = [];
  await installSummaryRoutes(page, { onReportRequest: route => route.fulfill({ json: reportComRelacoes() }) });
  await page.route("**/api/operacoes/chamados/linha-do-tempo/**", route => {
    timelineRequests.push(new URL(route.request().url()));
    return route.fulfill({ json: { eventos: [{ tipo: "Atualização", atualizado_em: "2026-10-01 10:00", mudancas: [{ campo: "status", anterior: "Aberta", atual: "Encerrada" }] }] } });
  });
  await openSummary(page);
  await page.waitForTimeout(300);
  expect(timelineRequests).toHaveLength(0);
  await expect(page.locator("tr[data-andamento]")).toHaveCount(0);

  const toggle = page.locator('.ck-os__andamento-btn[data-serie="REL-CONF-1"]');
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const detail = page.locator('tr[data-andamento="REL-CONF-1"]');
  await expect(detail).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-controls", await detail.getAttribute("id"));
  await expect(detail).toContainText("Andamento registrado");
  await expect(detail).toContainText("status: Aberta → Encerrada");
  expect(timelineRequests).toHaveLength(1);
  expect(timelineRequests[0].pathname).toBe("/api/operacoes/chamados/linha-do-tempo/REL-CONF-1");
  expect(timelineRequests[0].searchParams.get("snapshot_id")).toBe("snap-1");

  // Filtrar por outra série esconde a linha de andamento junto com a série.
  await page.locator("#cockpit-tickets-relation").selectOption("somente_oracle");
  await expect(detail).toBeHidden();
  await page.locator("#cockpit-tickets-relation").selectOption("todos");
  await expect(detail).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("tr[data-andamento]")).toHaveCount(0);
  await toggle.click();
  await expect(page.locator('tr[data-andamento="REL-CONF-1"]')).toBeVisible();
  await expect.poll(() => timelineRequests.length).toBe(2);
});

test("OS deste equipamento abre Chamados já filtrado pela série", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "o atalho vive na aba Transporte do desktop");
  await installSummaryRoutes(page, { onReportRequest: route => route.fulfill({ json: reportComRelacoes() }) });
  await page.goto("/");
  await expect(page.locator("#stat-equipamentos")).toHaveText("1");
  await page.locator("#tab-retirada-entrega").click();
  // Simula o equipamento selecionado no Transporte (o preenchimento real vem da Home).
  await page.evaluate(() => {
    document.querySelector(".ck-selecionado")?.setAttribute("data-state", "selected");
    document.getElementById("transfer-serial").textContent = "rel-sor-2";
  });
  const link = page.locator("#ck-link-os");
  await expect(link).toBeVisible();
  expect(await link.evaluate(node => node.tagName)).toBe("BUTTON");
  await link.click();
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
  await expect(page.locator("#cockpit-tickets-search")).toHaveValue("REL-SOR-2");
  await expect(page.locator(SECAO)).toContainText(" OS · ");
  const visible = page.locator("#ck-os-tabela tbody tr[data-serial]:visible");
  await expect(visible).toHaveCount(1);
  await expect(visible).toHaveAttribute("data-serial", "REL-SOR-2");
});
