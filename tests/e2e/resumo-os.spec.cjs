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

async function selectSummary(page) {
  const sidebarButton = page.locator("#btn-sidebar-open");
  const shell = page.locator("#simpress-app-shell");
  if (await sidebarButton.isVisible() && await shell.getAttribute("data-sidebar-open") !== "true") {
    await sidebarButton.click();
    await expect(shell).toHaveAttribute("data-sidebar-open", "true");
  }
  await page.locator("#tab-resumo").click();
  await expect(page.locator("#resumo-os-equipamento")).toBeVisible();
  await expect(page.locator("#resumo-os-equipamento")).toContainText(" OS · ");
}

async function openSummary(page) {
  await page.goto("/");
  await expect(page.locator("#stat-equipamentos")).toHaveText("1");
  await selectSummary(page);
}

test("Resumo associa OS aos chamados UTIC com prefixo anual e preserva dados do chamado", async ({ page }) => {
  const links = new Map();
  await installSummaryRoutes(page, { links });
  await openSummary(page);

  const section = page.locator("#resumo-os-equipamento");
  await expect(section).toContainText("7285072");
  const mobile = await page.locator(".ticket-summary-mobile").isVisible();
  const seriesGroup = mobile
    ? page.locator(".ticket-summary-card").filter({ hasText: "DEMO-SN-001" })
    : page.locator(".ticket-summary-table tbody tr").filter({ hasText: "DEMO-SN-001" });
  if (mobile) {
    await expect(page.locator(".ticket-summary-card")).toHaveCount(2);
    await expect(section).toContainText("usuario.demo");
    await expect(section).toContainText("PRNOTEDEMO01");
    await expect(section).toContainText("Ambíguo: alice / bob");
    await expect(section).toContainText("Ambíguo: PRNOTEDEMO-A / PRNOTEDEMO-B");
    await expect(section).toContainText("Solicitação REQ-1: Solicito suporte técnico.");
    await expect(section).toContainText("Solicitação REQ-2: <img src=x onerror=alert(1)>");
    await expect(section.locator("img")).toHaveCount(0);
    await expect(section).toContainText("Descrição não informada");
  } else {
    await expect(page.locator(".ticket-summary-table tbody tr")).toHaveCount(2);
    await expect(section).toContainText("usuario.demo");
    await expect(section).toContainText("PRNOTEDEMO01");
    await expect(section).toContainText("Ambíguo: alice / bob");
    await expect(section).toContainText("Ambíguo: PRNOTEDEMO-A / PRNOTEDEMO-B");
    await expect(section).toContainText("Solicitação REQ-1: Solicito suporte técnico.");
    await expect(section).toContainText("Solicitação REQ-2: <img src=x onerror=alert(1)>");
    await expect(section.locator("img")).toHaveCount(0);
    await expect(section).toContainText("Descrição não informada");
  }

  const summaryDescriptionEntry = seriesGroup.locator(".ticket-summary-description-entry")
    .filter({ hasText: "Solicito suporte técnico." });
  await expect(summaryDescriptionEntry).toHaveCount(1);
  await expect(summaryDescriptionEntry).not.toContainText("OS 7285070 · Oracle");
  await expect(seriesGroup.locator(".ticket-summary-description-label")).toHaveCount(0);
  if (!mobile) {
    const serialFont = await seriesGroup.locator("td:nth-child(2)").evaluate(element => getComputedStyle(element).fontFamily);
    const userFont = await seriesGroup.locator("td:nth-child(4)").evaluate(element => getComputedStyle(element).fontFamily);
    expect(serialFont).toBe(userFont);
  }

  await expect(section).toContainText("4 OS · 2 séries");
  const orderContainer = seriesGroup.locator(".ticket-os-link-entry")
    .filter({ hasText: "Oracle · OS 7285070" });
  const prefix = orderContainer.locator(".ticket-os-link-prefix");
  const input = orderContainer.locator("input.ticket-os-link-input");
  const year = new Date().getFullYear();
  await expect(prefix).toHaveText(`UTIC-${year}-`);
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await expect(input).toHaveAttribute("placeholder", "0000");
  await input.fill("1116");
  await orderContainer.getByRole("button", { name: "Salvar" }).click();
  await expect(section.locator(".ticket-summary-status")).toHaveText(`Vínculo salvo: UTIC-${year}-1116.`);
  await expect(orderContainer.locator(".ticket-os-link-prefix")).toHaveText(`UTIC-${year}-`);
  await expect(orderContainer.locator("input")).toHaveValue("1116");

  await page.reload();
  await selectSummary(page);
  const reloadedSeriesGroup = mobile
    ? page.locator(".ticket-summary-card").filter({ hasText: "DEMO-SN-001" })
    : page.locator(".ticket-summary-table tbody tr").filter({ hasText: "DEMO-SN-001" });
  const linkedOrder = reloadedSeriesGroup.locator(".ticket-os-link-entry")
    .filter({ hasText: "Oracle · OS 7285070" });
  await expect(linkedOrder.locator(".ticket-os-link-prefix")).toHaveText(`UTIC-${year}-`);
  await expect(linkedOrder.locator("input")).toHaveValue("1116");

  await reloadedSeriesGroup.getByRole("button", {
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

test("Resumo carrega as OS uma vez quando o painel responde depois da abertura", async ({ page }) => {
  let reportRequests = 0;
  await installSummaryRoutes(page, {
    onReportRequest: async route => {
      reportRequests += 1;
      await route.fulfill({ json: reportWith() });
    },
  });
  // A slow panel keeps "Resumo do parque" hidden, so opening the tab requests it again.
  await page.route("**/api/painel", async route => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fallback();
  });
  await page.goto("/");
  await selectSummary(page);
  await expect(page.locator("#ux-home-panel")).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);
  expect(reportRequests).toBe(1);
});

test("Resumo atualiza após mudanças e ignora respostas antigas", async ({ page }) => {
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
  const section = page.locator("#resumo-os-equipamento");

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
