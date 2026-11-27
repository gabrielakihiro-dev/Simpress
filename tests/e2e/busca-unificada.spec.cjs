const { test, expect } = require("@playwright/test");

// Campo de busca da Home: chamados (UTIC) e OS ao lado dos equipamentos. Todo /api/* usado aqui é simulado com
// dados sintéticos.
const EQUIPAMENTO = { serial: "BRJ0001", tipo: "Notebook", modelo: "Modelo de teste", apelido: "PRTESTE001", retirada_cidade: "Curitiba", usuarios_logados: "usuario.teste" };
const OS_SINTETICA = { fonte: "oracle", os: "7285001", serie: "BRJ0001", status: "Em atendimento", utic: "UTIC-2026-15", campo: "os" };

async function preparar(page, { chamadosOs = { chamados: [], os: [] }, equipamentos = [], falhaExtra = false } = {}) {
  const pedidosExtra = [];
  await page.route("**/api/buscar-expandida*", route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("listar_todos") === "true") return route.fallback();
    return route.fulfill({ json: { items: equipamentos, total: equipamentos.length, has_more: false } });
  });
  await page.route("**/api/buscar/chamados-os*", route => {
    pedidosExtra.push(new URL(route.request().url()).searchParams.get("q"));
    return falhaExtra ? route.fulfill({ status: 500, json: { detail: "erro" } }) : route.fulfill({ json: chamadosOs });
  });
  await page.route("**/api/equipamento/*", route => route.fulfill({ json: EQUIPAMENTO }));
  await page.route("**/api/equipamento/*/dossie", route => route.fulfill({
    json: { serie: "BRJ0001", modelo: "Modelo de teste", os: { estado: "ok", mensagem: "", total_importacoes: 1, ultima_importacao_em: null, presente_na_ultima: true, ultima_vez_observada_em: null, ordens: [], historico: { titulo: "Histórico", eventos: [], total: 0 } } },
  }));
  await page.goto("/");
  return pedidosExtra;
}

const CHAMADOS = { chamados: [{ numero: "UTIC-2026-15", aba: "novos", campo: "numero" }, { numero: "UTIC-2026-16", aba: "finalizados", campo: "numero" }], os: [] };

for (const viewport of [{ width: 1366, height: 800 }, { width: 320, height: 700 }]) {
  test(`UTIC mostra o grupo Chamados, sem estado vazio, e abre o F5 (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await preparar(page, { chamadosOs: CHAMADOS });
    const entrada = page.locator("#input-serial");
    await entrada.fill("UTIC-2026-1");
    const opcoes = page.locator("#autocomplete-list [role=option]");
    await expect(opcoes).toHaveCount(2);
    await expect(page.getByRole("group", { name: "Chamados" })).toBeVisible();
    await expect(opcoes.first()).toContainText("UTIC-2026-15");
    await expect(opcoes.first()).toContainText("Novos");
    await expect(page.locator("#autocomplete-empty-state")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.keyboard.press("ArrowDown");
    await expect(entrada).toHaveAttribute("aria-activedescendant", "autocomplete-option-0");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page.locator("#autocomplete-box")).toBeHidden();
    await expect(page.locator('[data-cockpit-tool-panel="sebrae-chamados"]')).toBeVisible();
  });
}

// Relatório da F6 (mesmo formato de os-subabas.spec.cjs): a OS 5001 está Finalizada (marca ativa), a 5002 Aberta.
const EM = "2026-11-08T10:30:00-03:00";
async function simularF6(page) {
  await page.route("**/api/operacoes/chamados", route => route.request().method() === "GET" ? route.fulfill({ json: {
    snapshot_id: "snap-busca", historico: [{ id: "snap-busca", atualizado_em: "2026-11-08T12:00:00Z" }],
    chamados: [{
      serie: "SUB-A", relacao: "conferida", simpress: { ordens_servico: ["5001", "5002"] },
      oracle: [{ solicitacao: "R-1", ordem_servico: "5001", descricao: "Troca de bateria." }, { solicitacao: "R-2", ordem_servico: "5002", descricao: "Tela trincada." }],
    }],
  } }) : route.fallback());
  await page.route("**/api/operacoes/chamados/vinculos-os", route => route.fulfill({ json: { vinculos: [] } }));
  await page.route("**/api/operacoes/chamados/marcas-finalizacao", route => route.fulfill({ json: { marcas: [{
    serie: "SUB-A", os: "5001", chamado: "UTIC-2026-2001", origem: "site", motivo: "", finalizado_em: EM, ativa: true, conferido_em: "",
    historico: [{ acao: "marcada", origem: "auto", em: EM }],
  }] } }));
}

test("OS mostra o grupo OS e abre a F6 na sub-aba da OS, filtrada e destacada", async ({ page }) => {
  await simularF6(page);
  await preparar(page, { chamadosOs: { chamados: [], os: [{ fonte: "oracle", os: "5001", serie: "SUB-A", status: "Finalizada", utic: "UTIC-2026-2001", campo: "os" }] } });
  await page.locator("#input-serial").fill("5001");
  const opcao = page.locator("#autocomplete-list [role=option]");
  await expect(page.getByRole("group", { name: "OS", exact: true })).toBeVisible();
  await expect(opcao).toHaveCount(1);
  await expect(opcao).toContainText("5001");
  await expect(opcao).toContainText("Oracle");
  await expect(opcao).toContainText("SUB-A");
  await expect(opcao).toContainText("UTIC-2026-2001");
  await opcao.click();
  await expect(page.locator("#autocomplete-box")).toBeHidden();
  await expect(page.locator('[data-cockpit-tool-panel="chamados"]')).toBeVisible();
  await expect(page.locator("#os-aba-finalizadas")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#cockpit-tickets-search")).toHaveValue("5001");
  await expect(page.locator('#cockpit-tickets-os tbody tr[data-os="5001"]:visible')).toHaveCount(1);
  await expect(page.locator('#cockpit-tickets-os tbody tr[data-os="5002"]:visible')).toHaveCount(0);
});

test("OS que não está na F6 mostra aviso curto", async ({ page }) => {
  await simularF6(page);
  await preparar(page, { chamadosOs: { chamados: [], os: [{ fonte: "simpress", os: "7285999", serie: "SUB-X", status: "Aberta", utic: null, campo: "os" }] } });
  await page.locator("#input-serial").fill("7285");
  await page.locator("#autocomplete-list [role=option]").click();
  await expect(page.locator("#toast-container")).toContainText("OS 7285999 não apareceu na aba OS (F6).", { timeout: 8000 });
});

test("só equipamentos: nenhum cabeçalho de grupo", async ({ page }) => {
  await preparar(page, { equipamentos: [EQUIPAMENTO] });
  await page.locator("#input-serial").fill("BRJ");
  await expect(page.locator("#autocomplete-list [role=option]")).toHaveCount(1);
  await expect(page.locator("#autocomplete-list [role=group]")).toHaveCount(0);
  await expect(page.locator("#autocomplete-list .ck-ac__cab")).toHaveCount(0);
});

test("falha da rota de chamados e OS é silenciosa: equipamentos aparecem", async ({ page }) => {
  await preparar(page, { equipamentos: [EQUIPAMENTO], falhaExtra: true });
  await page.locator("#input-serial").fill("BRJ");
  await expect(page.locator("#autocomplete-list [role=option]")).toHaveCount(1);
  await expect(page.locator("#toast-container [role=alert], #toast-container .toast")).toHaveCount(0);
});

test("setas pulam cabeçalhos entre grupos", async ({ page }) => {
  await preparar(page, { equipamentos: [EQUIPAMENTO], chamadosOs: { chamados: CHAMADOS.chamados.slice(0, 1), os: [OS_SINTETICA] } });
  const entrada = page.locator("#input-serial");
  await entrada.fill("UTIC-2026-1");
  await expect(page.locator("#autocomplete-list [role=option]")).toHaveCount(3);
  await expect(page.locator("#autocomplete-list [role=group]")).toHaveCount(3);
  for (const indice of [0, 1, 2, 0]) {
    await page.keyboard.press("ArrowDown");
    await expect(entrada).toHaveAttribute("aria-activedescendant", `autocomplete-option-${indice}`);
    await expect(page.locator(`#autocomplete-option-${indice}`)).toHaveAttribute("aria-selected", "true");
  }
});

const POR_NOME = {
  chamados: [{ numero: "UTIC-2026-30", aba: "novos", campo: "solicitante" }],
  os: [{ fonte: "simpress", os: "7290001", serie: "BRJ0001", status: "Aberta", utic: null, campo: "equipamento" }],
};

for (const viewport of [{ width: 1366, height: 800 }, { width: 320, height: 700 }]) {
  test(`termo de nome mostra os três grupos e "encontrado em" (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await preparar(page, { equipamentos: [EQUIPAMENTO], chamadosOs: POR_NOME });
    await page.locator("#input-serial").fill("Ana Exemplo");
    await expect(page.locator("#autocomplete-list [role=group]")).toHaveCount(3);
    const chamado = page.locator("#autocomplete-list [role=option]", { hasText: "UTIC-2026-30" });
    const os = page.locator("#autocomplete-list [role=option]", { hasText: "7290001" });
    await expect(chamado.getByText("encontrado em: solicitante", { exact: true })).toBeVisible();
    await expect(os.getByText("encontrado em: equipamento", { exact: true })).toBeVisible();
    await expect(chamado).toHaveAttribute("aria-label", /encontrado em: solicitante/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("linha achada pelo número não mostra o rótulo", async ({ page }) => {
  await preparar(page, { chamadosOs: CHAMADOS });
  await page.locator("#input-serial").fill("UTIC-2026-1");
  await expect(page.locator("#autocomplete-list [role=option]")).toHaveCount(2);
  await expect(page.locator("#autocomplete-list .ck-ac__campo")).toHaveCount(0);
});
