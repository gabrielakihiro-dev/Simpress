const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// Chamados e OS ficam na barra principal; abaixo de 1200px a barra os esconde e o menu Ferramentas os oferece.
const itemDeMenuDaBarra = { "#btn-acompanhamento-chamados": "#btn-chamados-menu", "#btn-sebrae-chamados-aba": "#btn-sebrae-chamados-menu" };

async function openTool(page, id) {
  const menu = page.locator("#cockpit-tools-dropdown");
  // O Resumo (F3) é uma aba da barra principal, visível em qualquer largura: não passa pelo menu Ferramentas.
  const naBarra = id === "#btn-resumo-aba" || (id in itemDeMenuDaBarra && await page.locator(id).isVisible());
  if (!naBarra && !(await menu.evaluate(node => node.open))) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra || !(id in itemDeMenuDaBarra) ? id : itemDeMenuDaBarra[id]).click();
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
}

const comparison = {
  id: "review-comparison", horario: "2026-10-24T09:00:00-03:00", tipo: "atualizacao",
  comparacao: {
    total_detalhes: 2, total_endpoint: 2, equipamentos_sincronizados: 1,
    divergencias_local: [{ serie: "LENTO", modelo: "Notebook de demonstração", local_detalhes: "Londrina", local_previsto: "Curitiba" }],
    ausentes_no_endpoint: [], ausentes_em_detalhes: [],
  },
};

async function mockComparison(page) {
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [comparison] } }));
  await page.route("**/api/historico-comparacoes/review-comparison", route => route.fulfill({ json: { evento: comparison } }));
}

test("Home hides the unselected equipment and never displays reference serials", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#home-detail-empty")).toBeAttached();
  await expect(page.locator("#card-equipamento")).toBeHidden();
  await expect(page.locator("#card-serial")).not.toHaveText("5CG6051BVN");
});

test("main navigation shortcuts and Ctrl+K leave the active tool", async ({ page }) => {
  await page.goto("/");
  for (const [key, panel] of [["F1", "home"], ["F2", "retirada-entrega"], ["F4", "automacao"], ["Control+k", "home"]]) {
    await openTool(page, "#btn-acompanhamento-chamados");
    await page.keyboard.press(key);
    await expect(page.locator("#cockpit-tool-panels"), key).toBeHidden();
    await expect(page.locator(`#tab-panel-${panel}`), key).toBeVisible();
  }
  await expect(page.locator("#input-serial")).toBeFocused();
});

test("closing a tool returns keyboard focus to its visible trigger", async ({ page }) => {
  await page.goto("/");
  await openTool(page, "#btn-acompanhamento-chamados");
  await page.keyboard.press("Escape");
  const naBarra = await page.locator("#btn-acompanhamento-chamados").isVisible();
  await expect(page.locator(naBarra ? "#btn-acompanhamento-chamados" : "#cockpit-tools-trigger")).toBeFocused();
});

test("comparison tab shows the full result and survives an empty history refresh", async ({ page }) => {
  await mockComparison(page);
  await page.goto("/");
  await openTool(page, "#btn-resumo-aba");
  const result = page.locator("#comparacao-planilhas-conteudo");
  // Tabela no desktop e card no mobile: só a variante visível conta.
  const row = result.locator('[data-comparison-category="divergencias_local"][data-comparison-serial="LENTO"]:visible').first();
  await expect(row).toContainText("LENTO");
  await expect(result).toContainText("Localidade divergente");
  await expect(result.locator("[data-history-filter-bar]")).toBeVisible();
  await expect(page.locator("#btn-exportar-resultado-comparacao")).toBeEnabled();
  await expect(page.locator("#comparacao-planilhas-fontes")).toBeVisible();
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [] } }));
  await openTool(page, "#btn-resumo-aba");
  await expect(page.locator("#btn-exportar-resultado-comparacao")).toBeDisabled();
  await expect(result).not.toContainText("LENTO");
  await expect(page.locator("#comparacao-planilhas-fontes")).toBeHidden();
});

test("comparison tab without a saved comparison still lists the notebooks without user", async ({ page }) => {
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [] } }));
  await page.route("**/api/buscar-expandida?*", async route => {
    if (new URL(route.request().url()).searchParams.get("usuario") !== "sem") return route.fallback();
    const item = { serial: "NOTE-SEM-USUARIO", apelido: "PRNOTEDEMO02", retirada_cidade: "Curitiba", modelo: "Notebook" };
    await route.fulfill({ json: { items: [item], total: 1, offset: 0, limit: 100, has_more: false } });
  });
  await page.goto("/");
  await openTool(page, "#btn-resumo-aba");
  const result = page.locator("#comparacao-planilhas-conteudo");
  await expect(result).toContainText("Não há comparação de inventários disponível neste histórico.");
  await expect(result.locator("#comparacao-secao-sem-usuario")).toHaveText("Sem usuário");
  await expect(result.locator('[data-comparison-category="sem_usuario"][data-comparison-serial="NOTE-SEM-USUARIO"]:visible').first()).toContainText("PRNOTEDEMO02");
  await expect(page.locator("#btn-exportar-resultado-comparacao")).toBeDisabled();
});

test("each tool is accessible in both themes and remains reachable below 1200px", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await mockComparison(page);
  await page.goto("/");
  for (const [id, tool] of [["#btn-acompanhamento-chamados", "chamados"], ["#btn-resumo-aba", "comparacao"], ["#btn-historico-apelidos", "apelidos"], ["#btn-relatorio-mensal", "relatorio"], ["#btn-sebrae-chamados-aba", "sebrae-chamados"]]) {
    await openTool(page, id);
    for (const theme of ["dark", "light"]) {
      await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
      const selector = `[data-cockpit-tool-panel="${tool}"]`;
      const audit = await new AxeBuilder({ page }).include(selector).analyze();
      expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), `${tool} ${theme}`).toEqual([]);

      const bounds = await page.locator(selector).boundingBox();
      const width = await page.evaluate(() => document.body.scrollWidth);
      expect(bounds.width).toBeLessThanOrEqual(width + 1);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    }
  }
});


test("visual snapshots cover the Cockpit workspaces", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await mockComparison(page);
  await page.goto("/");
  const phase = process.env.COCKPIT_PRINT_PHASE || "depois";
  for (const theme of ["dark", "light"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    await page.locator("#tab-home").click();
    for (const [id, name] of [["#tab-home", "home"], ["#tab-retirada-entrega", "transporte"], ["#btn-resumo-aba", "resumo"], ["#tab-automacao", "automacao"]]) {
      await page.locator(id).click();
      await page.screenshot({ path: `.claude/prints/cockpit-review/${phase}-${name}-${testInfo.project.name}-${theme}.png`, fullPage: true });
    }
    for (const [id, name] of [["#btn-acompanhamento-chamados", "chamados"], ["#btn-resumo-aba", "comparacao"], ["#btn-historico-apelidos", "apelidos"], ["#btn-relatorio-mensal", "relatorio"]]) {
      await openTool(page, id);
      await page.screenshot({ path: `.claude/prints/cockpit-review/${phase}-${name}-${testInfo.project.name}-${theme}.png`, fullPage: true });
    }
  }
});


test("Home ticket pills show the selected original template and copy that template", async ({ page }) => {
  await page.goto("/");
  await page.locator("#home-equipment-list [role=option]").first().click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await expect(page.locator("#home-detail-empty")).toBeHidden();
  await page.locator("#pill-chamado-deslocamento").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#pill-chamado-teclado-mouse")).toBeFocused();
  await expect(page.locator("#pill-chamado-teclado-mouse")).toHaveAttribute("aria-selected", "true");
  for (const type of ["deslocamento", "teclado-mouse", "mau-funcionamento", "uso-inadequado"]) {
    await page.locator(`#pill-chamado-${type}`).click();
    await expect(page.locator(`#visualizacao-chamado-${type}`)).toBeVisible();
    await expect(page.locator(`#pill-chamado-${type}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#btn-copiar-chamado-atual")).toHaveAttribute("data-args", JSON.stringify([`texto-chamado-${type}`]));
  }
});

test("comparison skips restoration and synchronized-note entries and uses the Endpoint user contract", async ({ page }) => {
  const restored = { id: "restored", horario: "2026-10-25", tipo: "restauracao" };
  const notes = { id: "notes", horario: "2026-10-25", somente_anotacoes_sincronizadas: true };
  await mockComparison(page);
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [restored, notes, comparison] } }));
  await page.route("**/api/historico-comparacoes/review-comparison", route => route.fulfill({ json: { evento: {
    ...comparison, comparacao: { ...comparison.comparacao, ausentes_em_detalhes: [{ serie: "SN-ENDPOINT", usuario: "usuario.endpoint", local_previsto: "Curitiba" }] },
  } } }));
  await page.goto("/");
  await openTool(page, "#btn-resumo-aba");
  await expect(page.locator("#cockpit-comparison-event")).toHaveValue(comparison.id);
  // O resultado completo (cartões de resumo + tabelas) vem de renderizarResultadoComparacao, só do evento real.
  const result = page.locator("#comparacao-planilhas-conteudo");
  await expect(result.locator('[data-comparison-category="ausentes_em_detalhes"][data-comparison-serial="SN-ENDPOINT"]:visible').first()).toContainText("Curitiba");
  await expect(page.getByRole("button", { name: "Exportar este resultado para Excel" })).toBeEnabled();
});

test("a failed comparison switch cannot export the previously displayed event", async ({ page }) => {
  await mockComparison(page);
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [comparison, { id: "failed", horario: "2026-10-23", tipo: "atualizacao" }] } }));
  let release;
  await page.route("**/api/historico-comparacoes/failed", async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: 503, json: { detail: "Não foi possível abrir a versão." } });
  });
  await page.goto("/");
  await openTool(page, "#btn-resumo-aba");
  await expect(page.locator("#btn-exportar-resultado-comparacao")).toBeEnabled();
  await expect(page.locator("#comparacao-planilhas-conteudo")).toContainText("LENTO");
  await page.locator("#cockpit-comparison-event").selectOption("failed");
  await expect(page.locator("#btn-exportar-resultado-comparacao")).toBeDisabled();
  await expect(page.locator("#comparacao-planilhas-conteudo")).not.toContainText("LENTO");
  await expect.poll(() => typeof release).toBe("function");
  release();
  await expect(page.locator("#cockpit-comparison-status")).toContainText("Não foi possível abrir a versão.");
  await expect(page.locator("#btn-exportar-resultado-comparacao")).toBeDisabled();
  await expect(page.locator("#comparacao-planilhas-conteudo")).not.toContainText("LENTO");
});


test("setas e Enter escolhem o equipamento nas sugestões da busca", async ({ page }) => {
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  const linha = page.locator("#autocomplete-list .autocomplete-row").first();
  await expect(linha).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(linha).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#input-serial")).toHaveAttribute("aria-activedescendant", "autocomplete-option-0");
  await page.keyboard.press("Enter");
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
});

test("typing stays error-free and Home shortcuts use the selected equipment", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await page.locator("#home-equipment-list [role=option]").first().click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await page.keyboard.press("e");
  // v2: a tecla E liga a edição cadastral em linha (sem modal); Esc cancela.
  await expect(page.locator("#btn-editar-equipamento")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#modal-editar-equipamento")).toBeHidden();
  await expect(page.locator("input[data-campo-edicao]").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#btn-editar-equipamento")).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => { window.copiarTextoParaAreaTransferencia = async text => { window.reviewCopiedText = text; }; });
  await page.keyboard.press("c");
  await expect.poll(() => page.evaluate(() => window.reviewCopiedText)).toContain("Prezados");
  await page.keyboard.press("t");
  await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible();
  await page.locator("#tab-home").click();
  await page.locator("#btn-clear-serial").click();
  await expect(page.locator("#home-detail-empty")).toBeAttached();
  await expect(page.locator("#card-equipamento")).toBeHidden();
  expect(errors).toEqual([]);
});


test("tool shortcuts cannot submit the hidden transfer form and Escape closes one layer", async ({ page }) => {
  await page.goto("/");
  await page.locator("#tab-retirada-entrega").click();
  await page.evaluate(() => {
    window.reviewTransferClicks = 0;
    const button = document.getElementById("btn-gerar-planilha");
    button.disabled = false;
    button.addEventListener("click", event => {
      event.stopImmediatePropagation();
      window.reviewTransferClicks += 1;
    });
  });
  await openTool(page, "#btn-acompanhamento-chamados");
  await page.keyboard.press("Control+Enter");
  expect(await page.evaluate(() => window.reviewTransferClicks)).toBe(0);
  await page.locator("#cockpit-tools-trigger").click();
  await expect(page.locator("#cockpit-tools-dropdown")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tools-dropdown")).not.toHaveAttribute("open", "");
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
});

test("Chamados e OS: rótulos, atalhos e títulos dos painéis na barra e no menu Ferramentas", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#btn-sebrae-chamados-aba")).toHaveAttribute("title", "Chamados (F5)");
  await expect(page.locator("#btn-sebrae-chamados-aba")).toHaveAttribute("aria-keyshortcuts", "F5");
  await expect(page.locator("#btn-acompanhamento-chamados")).toHaveAttribute("title", "OS (F6)");
  await expect(page.locator("#btn-acompanhamento-chamados")).toHaveAttribute("aria-keyshortcuts", "F6");
  await expect(page.locator("#btn-sebrae-chamados-menu")).toHaveText(/^Chamados\s*F5$/);
  await expect(page.locator("#btn-chamados-menu")).toHaveText(/^OS\s*F6$/);
  await expect(page.locator("#btn-cockpit-comparacao")).toHaveCount(0);
  await expect(page.locator("#btn-resumo-aba")).toHaveAttribute("title", "Resumo (F3)");
  await expect(page.locator("#btn-resumo-aba")).toHaveAttribute("aria-keyshortcuts", "F3");
  await expect(page.locator("#btn-historico-apelidos")).toHaveText(/^Histórico de apelidos\s*F7$/);
  await expect(page.locator("#btn-relatorio-mensal")).toHaveText(/^Relatório mensal\s*F8$/);
  await expect(page.locator("#btn-assistente")).toHaveAttribute("title", "Assistente (F9)");
  await expect(page.locator("#btn-assistente")).toHaveAttribute("aria-keyshortcuts", "F9");
  await expect(page.locator("#btn-atualizar-planilhas, #ck-menu-g-planilhas")).toHaveCount(0);
  // sem blur: no desktop a busca nasce com foco e F3 e F5-F8 precisam valer mesmo assim (senão F5 recarrega a página)
  for (const [key, painel, titulo] of [["F3", "comparacao", "Resumo"], ["F5", "sebrae-chamados", "Chamados"], ["F6", "chamados", "OS"], ["F7", "apelidos", "Histórico de apelidos"], ["F8", "relatorio", "Relatório mensal"]]) {
    await page.keyboard.press(key);
    await expect(page.locator("#cockpit-tool-title"), key).toHaveText(titulo);
    await expect(page.locator("#cockpit-tool-kbd"), key).toHaveText(key);
    await expect(page.locator(`[data-cockpit-tool-panel="${painel}"]`), key).toBeVisible();
    await expect(page.locator("#cockpit-tool-title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
  }
});

test("o item Chamados do menu Ferramentas abre o painel e volta com Esc", async ({ page }) => {
  await page.goto("/");
  await openTool(page, "#btn-sebrae-chamados-aba");
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados");
  await expect(page.locator('[data-cockpit-tool-panel="sebrae-chamados"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
});

test("abas principais mostram o atalho F1-F6 sem mudar o rótulo nem o nome acessível", async ({ page }) => {
  await page.goto("/");
  const abas = [["#tab-home", "Home", "F1"], ["#tab-retirada-entrega", "Transporte", "F2"], ["#btn-resumo-aba", "Resumo", "F3"],
    ["#tab-automacao", "Automação", "F4"], ["#btn-sebrae-chamados-aba", "Chamados", "F5"], ["#btn-acompanhamento-chamados", "OS", "F6"]];
  const larguraComAtalho = page.viewportSize().width >= 1290;
  for (const [id, rotulo, atalho] of abas) {
    await expect(page.locator(`${id} span`)).toHaveText(rotulo);
    await expect(page.locator(id)).toHaveAttribute("aria-label", rotulo);
    const kbd = page.locator(`${id} .ck-aba__kbd`);
    await expect(kbd).toHaveText(atalho);
    await expect(kbd).toHaveAttribute("aria-hidden", "true");
    if (larguraComAtalho) await expect(kbd).toBeVisible();
    else if (page.viewportSize().width < 768) await expect(kbd).toBeHidden();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("em todos os painéis o cabeçalho sobe junto com o conteúdo e a página não rola", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  for (const id of ["#btn-sebrae-chamados-aba", "#btn-acompanhamento-chamados", "#btn-resumo-aba", "#btn-historico-apelidos", "#btn-relatorio-mensal", "#btn-catalogo-unidades"]) {
    await openTool(page, id);
    const r = await page.evaluate(() => {
      const raiz = document.querySelector("#cockpit-tool-panels");
      const painel = [...document.querySelectorAll(".ck-ferr-painel")].find(e => !e.hidden);
      const espaco = document.createElement("div");
      espaco.style.cssText = "height:2500px;flex:none";
      painel.append(espaco);
      const cab = document.querySelector(".ck-ferramenta__cab");
      const antes = Math.round(cab.getBoundingClientRect().top);
      raiz.scrollTop = 400;
      const out = { antes, depois: Math.round(cab.getBoundingClientRect().top), rolou: raiz.scrollTop, pagina: document.documentElement.scrollHeight > innerHeight, barra: Math.round(document.querySelector("#ck-topbar").getBoundingClientRect().top) };
      espaco.remove();
      return out;
    });
    expect(r.rolou, `${id}: o painel rola`).toBeGreaterThan(0);
    expect(r.depois, `${id}: o cabeçalho saiu da tela junto`).toBeLessThan(r.antes);
    expect(r.pagina, `${id}: a página não rola`).toBe(false);
    expect(r.barra, `${id}: a barra superior continua no topo`).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Escape");
  }
});

test("trocar de painel abre no topo, com o cabeçalho visível", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await openTool(page, "#btn-sebrae-chamados-aba");
  await page.evaluate(() => {
    const espaco = document.createElement("div");
    espaco.id = "teste-espaco";
    espaco.style.cssText = "height:2500px;flex:none";
    document.querySelector("#cockpit-tool-panels .ck-ferr-painel:not([hidden])").append(espaco);
    document.querySelector("#cockpit-tool-panels").scrollTop = 400;
  });
  await page.keyboard.press("F6");
  await expect(page.locator("#cockpit-tool-title")).toHaveText("OS");
  expect(await page.evaluate(() => document.querySelector("#cockpit-tool-panels").scrollTop)).toBe(0);
  await expect(page.locator("#cockpit-tool-title")).toBeInViewport();
});

test("OS: Importar e gerenciar abre o painel sem rolar o shell nem esconder a barra superior", async ({ page }) => {
  for (const altura of [900, 700]) {
    await page.setViewportSize({ width: 1280, height: altura });
    await page.goto("/");
    await openTool(page, "#btn-acompanhamento-chamados");
    await page.locator("#cockpit-tickets-manage").click();
    const painel = page.locator("#cockpit-tickets-manage-panel");
    await expect(painel, `${altura}px: painel de importação aberto`).toHaveJSProperty("open", true);
    await expect(painel.locator("summary").first(), `${altura}px: título do painel visível`).toBeInViewport();
    await page.waitForTimeout(700);
    const medidas = await page.evaluate(() => ({
      shell: document.querySelector("#simpress-app-shell").scrollTop,
      topo: document.querySelector("#ck-topbar").getBoundingClientRect().top,
      pagina: document.scrollingElement.scrollTop,
    }));
    expect(medidas.shell, `${altura}px: o shell não rola`).toBe(0);
    expect(medidas.pagina, `${altura}px: a página não rola`).toBe(0);
    expect(medidas.topo, `${altura}px: a barra superior continua na tela`).toBeGreaterThanOrEqual(0);
  }
});

test("Exportar Excel (apelidos e IdCliente) fica no Resumo e some sem alterações exportáveis", async ({ page }) => {
  const stats = (exportavel, total) => ({ total_equipamentos: 1, total_unidades: 0, exportacao_disponivel: exportavel, total_alteracoes_exportaveis: total });
  let corpo = stats(true, 0);
  await page.route("**/api/stats", route => route.fulfill({ json: corpo }));
  let exportacoes = 0;
  const uploadsUx = [];
  await page.route("**/api/automacao/ux-apelidos", route => {
    uploadsUx.push(route.request().postDataBuffer().toString("utf8"));
    return route.fulfill({ status: 202, json: { estado: "livre", ultima: {
      rotina: "ux_apelidos", status: "interrompido", mensagem: "Processo interrompido após salvar: resultado incerto. Confira o UX manualmente.",
    } } });
  });
  await page.route("**/api/exportar-equipamentos", route => {
    exportacoes += 1;
    return route.fulfill({ status: 200, headers: { "Content-Disposition": 'attachment; filename="EquipamentosDetalhes-atualizados.xlsx"' }, contentType: "application/octet-stream", body: "xlsx" });
  });
  await mockComparison(page);
  await page.goto("/");
  await expect(page.locator("#cockpit-tools-dropdown #btn-exportar-equipamentos")).toHaveCount(0);
  await openTool(page, "#btn-resumo-aba");
  const botao = page.locator('[data-cockpit-tool-panel="comparacao"] .ck-barra-ferr #btn-exportar-equipamentos');
  await expect(botao).toBeHidden();
  corpo = stats(true, 3);
  await page.reload();
  await openTool(page, "#btn-resumo-aba");
  await expect(botao).toBeVisible();
  await expect(botao).toHaveText("Exportar Excel");
  await expect(botao).toHaveAttribute("aria-label", /^Exportar Excel/);
  await expect(page.locator("#btn-exportar-resultado-comparacao")).toHaveText("Exportar");
  const download = page.waitForEvent("download");
  await botao.click();
  expect((await download).suggestedFilename()).toBe("EquipamentosDetalhes-atualizados.xlsx");
  await expect.poll(() => exportacoes).toBe(1);
  await expect.poll(() => uploadsUx.length).toBe(1);
  expect(uploadsUx[0]).toContain('filename="EquipamentosDetalhes-atualizados.xlsx"');
  expect(uploadsUx[0]).toContain("\r\n\r\nxlsx\r\n");
  await expect(page.locator("#toast-container [role=alert]")).toContainText("resultado incerto");
  await expect(botao).toBeEnabled();
  await expect(botao).not.toHaveAttribute("aria-busy", "true");
  await expect(botao).toHaveText("Exportar Excel");
});

test("Catálogo de unidades: SEDE, CNPJ e edição pelo lápis sem o modal antigo", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const units = [
    { id: 1, label: "Curitiba Sede", cidade: "Curitiba", uf: "PR", endereco: "Rua XV, 100", cep: "80020000", cnpj: "03209636000100", is_sede: true },
    { id: 2, label: "Londrina", cidade: "Londrina", uf: "PR", endereco: "Av. Paraná, 50", cep: "86010000", cnpj: "03209636000200", is_sede: false },
  ];
  let saved = null;
  await page.route("**/api/unidades", route => route.fulfill({ json: units }));
  await page.route("**/api/unidade/salvar", async route => {
    saved = route.request().postDataJSON();
    Object.assign(units.find(unit => unit.id === saved.id), { cnpj: saved.cnpj, cep: saved.cep, endereco: saved.endereco, cidade: saved.cidade });
    await route.fulfill({ json: { sucesso: true, mensagem: "Unidade salva com sucesso!" } });
  });
  await page.goto("/");
  await openTool(page, "#btn-catalogo-unidades");
  await expect(page.locator('[data-cockpit-tool-panel="unidades"]')).toBeVisible();
  await expect(page.locator("#modal-gerenciar-unidades, #cockpit-units-legacy, #cockpit-units-edit")).toHaveCount(0);
  const list = page.locator("#cockpit-units-list-body");
  await expect(list).toContainText("Curitiba Sede");
  await expect(list).toContainText("SEDE");
  await expect(page.locator("#cockpit-units-detail-badge")).toHaveText("SEDE");
  await expect(page.locator("#cockpit-units-detail-pares")).toContainText("03209636000100");
  await expect(page.locator("#cockpit-units-copy-cnpj")).toBeEnabled();
  await expect(page.locator("#cockpit-units-copy-cep")).toBeEnabled();
  // Sem rolagem horizontal da página.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.locator("#cockpit-units-new").click();
  await expect(page.locator("#form-nova-unidade")).toBeVisible();
  await expect(page.locator("#form-unidade-titulo")).toBeVisible();
  await page.locator("#form-nova-unidade").getByRole("button", { name: "Cancelar" }).click();
  await expect(page.locator("#form-nova-unidade")).toBeHidden();

  const pencil = list.getByRole("button", { name: "Editar CNPJ da unidade Curitiba" }).first();
  await pencil.click();
  await expect(page.locator("#form-nova-unidade")).toBeVisible();
  await expect(page.locator("#form-unidade-titulo")).toContainText("Curitiba");
  await expect(page.locator("#form-unidade-cnpj")).toBeFocused();
  await expect(page.locator("#form-unidade-cnpj")).toHaveValue("03209636000100");
  await page.locator("#form-unidade-cnpj").fill("03209636000999");
  await page.locator("#btn-salvar-unidade").click();
  await expect(page.locator("#form-nova-unidade")).toBeHidden();
  expect(saved).toMatchObject({ id: 1, cnpj: "03209636000999" });
  await expect(list).toContainText("03209636000999");
  await expect(page.locator("#cockpit-units-detail-pares")).toContainText("03209636000999");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
  expect(errors).toEqual([]);
});

test("Resumo (F3) abre o painel pela barra e pelo atalho, tem um só botão Resumo e restaura a aba anterior", async ({ page }) => {
  await mockComparison(page);
  await page.goto("/");
  const botao = page.locator("#btn-resumo-aba");
  await expect(page.getByRole("tab", { name: "Resumo", exact: true })).toHaveCount(1);
  await expect(page.locator('button:visible:has(> span:text-is("Resumo"))')).toHaveCount(1);
  await expect(page.locator("#tab-resumo")).toHaveCount(0);
  await expect(botao).toHaveAttribute("title", "Resumo (F3)");
  await expect(botao.locator("kbd")).toHaveText("F3");
  await expect(botao).toHaveAttribute("aria-selected", "false");

  await page.locator("#tab-retirada-entrega").click();
  await botao.click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Resumo");
  await expect(page.locator('[data-cockpit-tool-panel="comparacao"]')).toBeVisible();
  await expect(botao).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#tab-retirada-entrega")).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
  await expect(botao).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#tab-retirada-entrega")).toHaveAttribute("aria-selected", "true");

  await page.locator("#input-serial").focus();
  await page.keyboard.press("F3");
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Resumo");
  await expect(botao).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
});

test("Resumo mostra Ativos por regional e Total de ativos ao abrir, sem erros de console", async ({ page }) => {
  await mockComparison(page);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await openTool(page, "#btn-resumo-aba");
  const painel = page.locator('[data-cockpit-tool-panel="comparacao"]');
  await expect(painel.getByRole("heading", { name: "Ativos por regional" })).toBeVisible();
  await expect(painel.getByRole("heading", { name: "Total de ativos" })).toBeVisible();
  await expect(page.locator("#resumo-regionais .ck-barra")).toHaveCount(1);
  await expect(page.locator("#resumo-regionais .ck-barra__nome")).toHaveText("Curitiba");
  await expect(page.locator("#resumo-regionais .ck-barra__valor")).toHaveText("1");
  await expect(page.locator("#resumo-total-ativos tr")).toHaveCount(1);
  await expect(page.locator("#resumo-total-contagem")).toHaveText("Mostrando 1–1 de 1");
  await expect(page.locator("#resumo-total-paginacao")).toBeHidden();
  const abrir = page.locator("#resumo-total-ativos tr").first().getByRole("button", { name: "Abrir" });
  await expect(abrir).toBeEnabled();
  await abrir.click();
  await expect(page.locator("#cockpit-tool-panels")).toBeHidden();
  await expect(page.locator("#tab-panel-home")).toBeVisible();
  await expect(page.locator("#input-serial")).not.toHaveValue("");
  expect(errors.filter(text => !/404|Failed to load resource/.test(text))).toEqual([]);
});

test("Resumo passa pela auditoria de acessibilidade", async ({ page }) => {
  await mockComparison(page);
  await page.goto("/");
  await openTool(page, "#btn-resumo-aba");
  await expect(page.locator("#resumo-total-ativos tr")).toHaveCount(1);
  const results = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="comparacao"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target).join(",")}`)).toEqual([]);
  const nav = await new AxeBuilder({ page }).include("#ck-abas").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(nav.violations.map(v => v.id)).toEqual([]);
});
