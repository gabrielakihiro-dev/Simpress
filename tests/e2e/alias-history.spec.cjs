const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const PANEL = '[data-cockpit-tool-panel="apelidos"]';
const ITEMS = "#cockpit-alias-list .ck-ferr-item";

function fixtureHistory(total = 32) {
  const types = ["usuario", "apelido", "aviso_endpoint", "endereco"];
  return Array.from({ length: total }, (_, index) => {
    const tipo = types[index % types.length];
    const serial = index === 4 ? "SN-001" : `SN-${String(index + 1).padStart(3, "0")}`;
    return {
      id: `history-event-${index + 1}`,
      horario: new Date(Date.parse("2026-10-20T12:00:00-03:00") - index * 60_000).toISOString(),
      tipo,
      serial,
      equipamento: "Notebook de demonstração",
      acao: "alteracao",
      apelido_anterior: `old-host-${index + 1}`,
      apelido_novo: `new-host-${index + 1}`,
      usuario_anterior: `old.usuario.${String(index + 1).padStart(2, "0")}`,
      usuario_novo: `new.usuario.${String(index + 1).padStart(2, "0")}`,
      endereco_anterior: { endereco: "Rua de teste, 10", cidade: "Curitiba", uf: "PR" },
      endereco_novo: { endereco: "Rua de teste, 20", cidade: "Maringá", uf: "PR" },
      motivo: tipo === "aviso_endpoint" ? "usuario_removido" : undefined,
    };
  });
}

async function openHistory(page, eventos) {
  await page.route("**/api/historico-alteracoes", route => route.fulfill({ json: { eventos, total: eventos.length } }));
  await page.goto("/");
  const menu = page.locator("#cockpit-tools-dropdown");
  if (!(await menu.evaluate(element => element.open))) await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-historico-apelidos").click();
  await expect(page.locator(PANEL)).toBeVisible();
  // "Carregar mais" mostra 50 registros por vez.
  await expect(page.locator(ITEMS)).toHaveCount(Math.min(eventos.length, 50));
}

test("the F7 panel is the full history: search, type, action filter and clear", async ({ page }) => {
  test.setTimeout(60_000);
  const eventos = fixtureHistory();
  await openHistory(page, eventos);
  await expect(page.locator("#modal-historico-apelidos")).toHaveCount(0);
  await expect(page.locator("#cockpit-alias-count-all")).toHaveText("32");

  await page.getByRole("tab", { name: /^Usuário/ }).click();
  await expect(page.locator(ITEMS)).toHaveCount(8);
  await page.locator("#cockpit-alias-search").fill("SN-001");
  await expect(page.locator(ITEMS)).toHaveCount(2);
  await expect(page.locator(ITEMS).first()).toContainText("old.usuario.01");

  await page.locator("#cockpit-alias-search").fill("");
  await page.getByRole("tab", { name: /^Todos/ }).click();
  await page.locator("#cockpit-alias-actions-only").check();
  await expect(page.locator(ITEMS)).toHaveCount(23);
  await page.locator(ITEMS).filter({ hasText: "SN-001" }).first().getByRole("button").click();
  const detail = page.locator("#cockpit-alias-detail");
  await expect(detail.getByRole("button", { name: "Restaurar anterior" })).toBeEnabled();
  await expect(detail.getByRole("button", { name: "Restaurar e excluir" })).toBeEnabled();

  await page.locator("#cockpit-alias-clear").click();
  await expect(page.locator("#cockpit-alias-search")).toHaveValue("");
  await expect(page.locator("#cockpit-alias-type")).toHaveValue("todos");
  await expect(page.getByRole("tab", { name: /^Todos/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#cockpit-alias-actions-only")).not.toBeChecked();
  await expect(page.locator(ITEMS)).toHaveCount(32);
});

test("the F7 panel follows the Novo layout: chips, search, secondary export and detail blocks", async ({ page }) => {
  test.setTimeout(60_000);
  // Cadastro atual sintético, para o detalhe mostrar o botão "Copiar apelido atual".
  await page.route("**/api/buscar-expandida*", route => route.fulfill({
    json: { items: [{ serial: "SN-001", apelido: "host-atual-01", modelo: "Notebook de demonstração", retirada_cidade: "Curitiba" }] },
  }));
  await openHistory(page, fixtureHistory());
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);

  // Exportar CSV é secundário; a busca tem rótulo acessível (só para leitor de tela) e nenhum placeholder.
  // Na tela larga ela tem até 300 px; no celular ocupa a linha toda.
  await expect(page.locator("#cockpit-alias-export")).toHaveClass(/ck-btn--secundario/);
  const search = page.getByRole("searchbox", { name: "Buscar no histórico" });
  await expect(search).not.toHaveAttribute("placeholder", /./);
  if (page.viewportSize().width >= 640) {
    expect(await search.evaluate(input => input.closest("label").getBoundingClientRect().width)).toBeLessThanOrEqual(300);
  }

  // Chips de tipo: 32 px (44 px em toque), contagem em mono dentro do chip.
  const todos = page.getByRole("tab", { name: /^Todos/ });
  expect((await todos.boundingBox()).height).toBe(coarse ? 44 : 32);
  await expect(todos.locator("[data-alias-tab-count]")).toHaveText("32");

  // Cabeçalho do grupo: a contagem fica num selo (número visível, complemento só para leitor de tela).
  const groupSeal = page.locator(".ck-alias-grupo__cab .ck-alias-selo-n").first();
  await expect(groupSeal).toHaveText(/^\d+ alterações$/);

  // Detalhe: ações em coluna, par "Restaurar anterior" + "Restaurar e excluir", contagem do histórico em selo.
  await page.locator("#cockpit-alias-actions-only").check();
  await page.locator(ITEMS).filter({ hasText: "SN-001" }).first().getByRole("button").click();
  const detail = page.locator("#cockpit-alias-detail");
  const home = detail.getByRole("button", { name: "Abrir na Home" });
  const pair = detail.locator(".ck-alias-det__par");
  await expect(pair.getByRole("button")).toHaveText(["Restaurar anterior", "Restaurar e excluir"]);
  const homeBox = await home.boundingBox();
  const pairBox = await pair.boundingBox();
  expect(Math.abs(homeBox.width - pairBox.width)).toBeLessThanOrEqual(1);
  await expect(detail.getByRole("heading", { name: "Histórico deste equipamento", exact: true })).toBeVisible();
  await expect(detail.locator(".ck-alias-bloco__cab .ck-alias-selo-n")).toHaveText(/^\d+ registros?$/);
  await expect(detail.getByText("Antes", { exact: true })).toBeVisible();
  await expect(detail.getByText("Depois", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Copiar apelido atual" })).toBeVisible();

  // Na tela larga, a lista ocupa o espaço que sobra e o detalhe tem 460 px.
  if (page.viewportSize().width >= 1024) {
    expect((await page.locator(".ck-alias-detalhe-cartao").boundingBox()).width).toBeCloseTo(460, 0);
  }
});

test("Carregar mais shows 50 records at a time, focuses the first new row and resets with the filters", async ({ page }) => {
  test.setTimeout(60_000);
  await openHistory(page, fixtureHistory(60));
  const rows = page.locator("#cockpit-alias-list .ck-alias-linha");
  const more = page.locator("#cockpit-alias-more");
  await expect(page.locator(ITEMS)).toHaveCount(50);
  await expect(more).toHaveText("Carregar mais");

  // O selo do grupo conta o dia inteiro no filtro atual, mesmo com parte ainda escondida.
  const total = await page.locator(".ck-alias-grupo__cab .ck-alias-selo-n")
    .evaluateAll(seals => seals.reduce((sum, seal) => sum + Number.parseInt(seal.textContent, 10), 0));
  expect(total).toBe(60);

  await more.click();
  await expect(page.locator(ITEMS)).toHaveCount(60);
  await expect(more).toHaveCount(0);
  await expect(rows.nth(50)).toBeFocused();

  await page.getByRole("tab", { name: /^Usuário/ }).click();
  await expect(page.locator(ITEMS)).toHaveCount(15);
  await page.getByRole("tab", { name: /^Todos/ }).click();
  await expect(page.locator(ITEMS)).toHaveCount(50);
  await expect(more).toBeVisible();
});

test("the type tabs follow the arrow, Home and End keys and wrap around", async ({ page }) => {
  test.setTimeout(60_000);
  await openHistory(page, fixtureHistory());
  const todos = page.getByRole("tab", { name: /^Todos/ });
  const apelido = page.getByRole("tab", { name: /^Apelido/ });
  const avisos = page.getByRole("tab", { name: /^Avisos do Endpoint/ });

  await todos.focus();
  await page.keyboard.press("ArrowRight");
  await expect(apelido).toBeFocused();
  await expect(apelido).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(ITEMS)).toHaveCount(8);

  await page.keyboard.press("End");
  await expect(avisos).toBeFocused();
  await expect(avisos).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowRight");
  await expect(todos).toBeFocused();
  await expect(todos).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(ITEMS)).toHaveCount(32);
});

test("the F7 panel hides VMWARE and GOOGLECLOUD serials", async ({ page }) => {
  test.setTimeout(60_000);
  const hidden = ["VMWARE423B6CB95FB", "vmwareead6764dfb", "GOOGLECLOUD58347873"].map((serial, index) => ({
    id: `hidden-${index}`, horario: "2026-10-30T12:15:59-03:00", tipo: "aviso_endpoint", serial, motivo: "hostname_removido",
  }));
  await page.route("**/api/historico-alteracoes", route => route.fulfill({ json: { eventos: [...hidden, ...fixtureHistory()] } }));
  await page.goto("/");
  await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-historico-apelidos").click();
  await expect(page.locator(ITEMS)).toHaveCount(32);
  await expect(page.locator("#cockpit-alias-count-all")).toHaveText("32");
  await expect(page.locator("#cockpit-alias-list")).not.toContainText(/VMWARE|GOOGLECLOUD/i);
});

test("detail offers only the actions each record allows", async ({ page }) => {
  test.setTimeout(60_000);
  await openHistory(page, fixtureHistory());
  const detail = page.locator("#cockpit-alias-detail");

  await page.getByRole("tab", { name: /^Avisos do Endpoint/ }).click();
  await page.locator(ITEMS).first().getByRole("button").click();
  await expect(detail).toContainText("Usuário logado removido no Endpoint");
  await expect(detail.getByRole("button", { name: "Excluir aviso" })).toBeEnabled();
  await expect(detail.getByRole("button", { name: "Restaurar anterior" })).toHaveCount(0);

  await page.getByRole("tab", { name: /^Endereço/ }).click();
  await page.locator(ITEMS).first().getByRole("button").click();
  await expect(detail.getByRole("button", { name: /Restaurar|Excluir/ })).toHaveCount(0);
  await expect(detail).toContainText("não podem ser restaurados manualmente");

  await page.getByRole("tab", { name: /^Usuário/ }).click();
  await page.locator(ITEMS).filter({ hasText: "old.usuario.05" }).getByRole("button").click();
  await expect(detail.getByRole("button", { name: /Restaurar|Excluir/ })).toHaveCount(0);
  await expect(detail).toContainText("alteração mais recente");
});

test("deleting an Endpoint warning confirms, calls the API and refreshes the list", async ({ page }) => {
  test.setTimeout(60_000);
  let eventos = fixtureHistory();
  const deleted = [];
  await page.route("**/api/historico-alteracoes/*", route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    deleted.push(id);
    eventos = eventos.filter(evento => evento.id !== id);
    return route.fulfill({ json: { sucesso: true, evento_id: id, tipo: "aviso_endpoint" } });
  });
  await page.route("**/api/historico-alteracoes", route => route.fulfill({ json: { eventos, total: eventos.length } }));
  await page.goto("/");
  await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-historico-apelidos").click();
  await expect(page.locator(ITEMS)).toHaveCount(32);

  await page.getByRole("tab", { name: /^Avisos do Endpoint/ }).click();
  await page.locator(ITEMS).first().getByRole("button").click();
  await page.locator("#cockpit-alias-detail").getByRole("button", { name: "Excluir aviso" }).click();
  await page.locator("#btn-confirmar-acao-ok").click();

  await expect.poll(() => deleted).toEqual(["history-event-3"]);
  await expect(page.locator(ITEMS)).toHaveCount(7);
});

test("the panel fits the viewport and passes axe in both themes", async ({ page }) => {
  test.setTimeout(60_000);
  await openHistory(page, fixtureHistory());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator("#cockpit-alias-actions-only")).toBeVisible();
  await expect(page.locator("#cockpit-alias-clear")).toBeVisible();

  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include(PANEL).analyze();
    expect(audit.violations.map(violation => violation.id), theme).toEqual([]);
  }
});
