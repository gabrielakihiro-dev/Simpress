const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const PANEL = '[data-cockpit-tool-panel="apelidos"]';
const ITEMS = "#cockpit-alias-list .ck-ferr-item";

function fixtureHistory() {
  const types = ["usuario", "apelido", "aviso_endpoint", "endereco"];
  return Array.from({ length: 32 }, (_, index) => {
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
  await expect(page.locator(ITEMS)).toHaveCount(eventos.length);
}

test("the F8 panel is the full history: search, type, action filter and clear", async ({ page }) => {
  test.setTimeout(60_000);
  const eventos = fixtureHistory();
  await openHistory(page, eventos);
  await expect(page.locator("#modal-historico-apelidos")).toHaveCount(0);
  await expect(page.locator("#cockpit-alias-count-all")).toHaveText("32");

  await page.locator("#cockpit-alias-type").selectOption("usuario");
  await expect(page.locator(ITEMS)).toHaveCount(8);
  await page.locator("#cockpit-alias-search").fill("SN-001");
  await expect(page.locator(ITEMS)).toHaveCount(2);
  await expect(page.locator(ITEMS).first()).toContainText("old.usuario.01");

  await page.locator("#cockpit-alias-search").fill("");
  await page.locator("#cockpit-alias-type").selectOption("todos");
  await page.locator("#cockpit-alias-actions-only").check();
  await expect(page.locator(ITEMS)).toHaveCount(23);
  await page.locator(ITEMS).filter({ hasText: "SN-001" }).first().getByRole("button").click();
  const detail = page.locator("#cockpit-alias-detail");
  await expect(detail.getByRole("button", { name: "Restaurar anterior" })).toBeEnabled();
  await expect(detail.getByRole("button", { name: "Restaurar e excluir" })).toBeEnabled();

  await page.locator("#cockpit-alias-clear").click();
  await expect(page.locator("#cockpit-alias-search")).toHaveValue("");
  await expect(page.locator("#cockpit-alias-type")).toHaveValue("todos");
  await expect(page.locator("#cockpit-alias-actions-only")).not.toBeChecked();
  await expect(page.locator(ITEMS)).toHaveCount(32);
});

test("detail offers only the actions each record allows", async ({ page }) => {
  test.setTimeout(60_000);
  await openHistory(page, fixtureHistory());
  const detail = page.locator("#cockpit-alias-detail");

  await page.locator("#cockpit-alias-type").selectOption("aviso_endpoint");
  await page.locator(ITEMS).first().getByRole("button").click();
  await expect(detail).toContainText("Usuário logado removido no Endpoint");
  await expect(detail.getByRole("button", { name: "Excluir aviso" })).toBeEnabled();
  await expect(detail.getByRole("button", { name: "Restaurar anterior" })).toHaveCount(0);

  await page.locator("#cockpit-alias-type").selectOption("endereco");
  await page.locator(ITEMS).first().getByRole("button").click();
  await expect(detail.getByRole("button", { name: /Restaurar|Excluir/ })).toHaveCount(0);
  await expect(detail).toContainText("não podem ser restaurados manualmente");

  await page.locator("#cockpit-alias-type").selectOption("usuario");
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

  await page.locator("#cockpit-alias-type").selectOption("aviso_endpoint");
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
