const { test, expect } = require("@playwright/test");

// Janela Chamado × OS: na aba OS (F6), o prefixo UTIC de uma OS vinculada abre #modal-chamado-os.
// O fixture tem a OS 7285070 (série DEMO-SN-001) e o chamado UTIC-2026-1378 entre os novos do F5;
// o vínculo salvo vem só desta rota (nada é gravado no servidor de fixture).

// F5 e F6 ficam na barra principal; abaixo de 1200px só o menu Ferramentas os oferece.
async function abrirAba(page, botaoBarra, itemMenu, titulo) {
  const naBarra = await page.locator(botaoBarra).isVisible();
  if (!naBarra) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra ? botaoBarra : itemMenu).click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText(titulo);
}

// A OS com marca ativa fica na sub-aba Finalizadas; as demais, em Abertas (a padrão).
async function abrirAbaOsComVinculo(page, numero, { finalizadas = false } = {}) {
  const vinculo = { fonte: "oracle", serie: "DEMO-SN-001", os: "7285070", ano: 2026, numero, origem: "manual", chamado: `UTIC-2026-${numero}` };
  await page.route("**/api/operacoes/chamados/vinculos-os", route => route.request().method() === "GET"
    ? route.fulfill({ json: { vinculos: [vinculo] } })
    : route.fallback());
  await page.goto("/");
  await abrirAba(page, "#btn-acompanhamento-chamados", "#btn-chamados-menu", "OS");
  if (finalizadas) await page.locator("#os-aba-finalizadas").click();
  const gatilho = page.locator('#cockpit-tickets-os tbody tr[data-serial="DEMO-SN-001"] button.ticket-os-link-goto').first();
  await expect(gatilho).toBeVisible();
  await expect(gatilho).toHaveAttribute("aria-haspopup", "dialog");
  return gatilho;
}

test("Chamado × OS: o UTIC da OS vinculada na aba OS (F6) abre a janela com o chamado e a OS; Esc fecha e devolve o foco", async ({ page }) => {
  const gatilho = await abrirAbaOsComVinculo(page, "1378");
  await gatilho.click();
  const modal = page.locator("#modal-chamado-os");
  await expect(modal).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Chamado × OS" })).toBeVisible();
  await expect(page.locator("#chamado-os-janela-chamado")).toContainText("UTIC-2026-1378");
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await expect(page.locator("#chamado-os-janela-f6")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(gatilho).toBeFocused();
});

test("Chamado × OS: chamado ausente da F5 avisa e ainda mostra a OS", async ({ page }) => {
  const gatilho = await abrirAbaOsComVinculo(page, "9999");
  await gatilho.click();
  await expect(page.locator("#modal-chamado-os")).toBeVisible();
  await expect(page.locator("#chamado-os-janela-chamado")).toHaveText("Chamado não encontrado na aba Chamados (F5).");
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await page.locator('#modal-chamado-os button:text-is("Fechar")').click();
  await expect(page.locator("#modal-chamado-os")).toBeHidden();
  await expect(gatilho).toBeFocused();
});

test("Chamado × OS: o botão da OS no cartão do chamado na aba Chamados (F5) abre a janela; Esc fecha e devolve o foco", async ({ page }) => {
  // A OS do UTIC-2026-1378 no fixture (7303022) não está no relatório da aba OS: só no navegador, a lista
  // de chamados passa a trazer 7285070 (série DEMO-SN-001), que existe lá. Nada é gravado no servidor.
  await page.route("**/api/sebrae/novos", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const resposta = await route.fetch();
    await route.fulfill({ response: resposta, body: (await resposta.text()).replaceAll("7303022", "7285070") });
  });
  await page.goto("/");
  await abrirAba(page, "#btn-sebrae-chamados-aba", "#btn-sebrae-chamados-menu", "Chamados");
  const gatilho = page.locator('#sebrae-novos-lista article.sebrae-chamado[data-numero="UTIC-2026-1378"] button.sebrae-chamado__os');
  await expect(gatilho).toHaveText("7285070");
  await gatilho.click();
  const modal = page.locator("#modal-chamado-os");
  await expect(page.getByRole("dialog", { name: "Chamado × OS" })).toBeVisible();
  await expect(page.locator("#chamado-os-janela-chamado")).toContainText("UTIC-2026-1378");
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(gatilho).toBeFocused();
});

// ----- Marca de OS finalizada (célula Chamado da aba OS, F6) -----
// GET/PUT de marcas-finalizacao são simulados no navegador: o fixture nunca grava marcas e nada vai ao SoftExpert.
const EVENTO_PUT = { desfazer: "desfeita", refazer: "refeita", conferir: "conferida" };
const MARCA_SITE = {
  serie: "DEMO-SN-001", os: "7285070", chamado: "UTIC-2026-1378", origem: "site", motivo: "",
  finalizado_em: "2026-11-08T09:00:00-03:00", ativa: true, conferido_em: "",
  historico: [{ acao: "marcada", origem: "auto", em: "2026-11-08T09:00:00-03:00" }],
};
const MARCA_OUTRO = {
  ...MARCA_SITE, chamado: "UTIC-2026-1379", origem: "outro_tecnico", motivo: "saiu_do_dashboard",
};

async function simularMarcas(page, iniciais) {
  const estado = { marcas: iniciais.map(marca => ({ ...marca, historico: [...marca.historico] })), puts: [] };
  await page.route("**/api/operacoes/chamados/marcas-finalizacao", async route => {
    const pedido = route.request();
    if (pedido.method() === "GET") return route.fulfill({ json: { marcas: estado.marcas } });
    if (pedido.method() !== "PUT") return route.fallback();
    const corpo = pedido.postDataJSON();
    estado.puts.push(corpo);
    const marca = estado.marcas.find(item => item.chamado === corpo.chamado);
    if (!marca) return route.fulfill({ status: 422, json: { detail: "Marca inexistente." } });
    if (corpo.acao === "desfazer") marca.ativa = false;
    if (corpo.acao === "refazer") marca.ativa = true;
    if (corpo.acao === "conferir") marca.conferido_em = "2026-11-08T10:30:00-03:00";
    marca.historico.push({ acao: EVENTO_PUT[corpo.acao], origem: "manual", em: "2026-11-08T10:30:00-03:00" });
    return route.fulfill({ json: { marca } });
  });
  return estado;
}

// Marca ativa leva a OS para a sub-aba Finalizadas; Desfazer a devolve para Abertas (a padrão).
async function abrirF6ComMarcas(page, iniciais, aba = "finalizadas") {
  const estado = await simularMarcas(page, iniciais);
  await page.goto("/");
  await abrirAba(page, "#btn-acompanhamento-chamados", "#btn-chamados-menu", "OS");
  if (aba === "finalizadas") await page.locator("#os-aba-finalizadas").click();
  const linha = page.locator('#cockpit-tickets-os tbody tr[data-serial="DEMO-SN-001"]').first();
  await expect(linha).toBeVisible();
  return { estado, linha };
}

test("Marca de OS finalizada: selo, Desfazer só com confirmação, Refazer e histórico; nada é gravado fora do PUT local", async ({ page }, testInfo) => {
  const { estado, linha } = await abrirF6ComMarcas(page, [MARCA_SITE]);
  const bloco = linha.locator(".ck-os-marca");
  await expect(bloco).toHaveCount(1);
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveText("Chamado finalizado");
  await expect(bloco).toContainText("UTIC-2026-1378");
  await expect(bloco.locator(".ck-os-marca__dica")).toHaveCount(0);
  await expect(bloco.getByRole("button", { name: /^Conferido/ })).toHaveCount(0);
  if (testInfo.project.name === "mobile") {
    // Telas menores: o bloco cabe na largura da tela, sem rolagem horizontal da página.
    const caixa = await bloco.boundingBox();
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(391);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
  // Animação de entrada entre 150 e 300 ms.
  const duracao = await bloco.evaluate(no => parseFloat(getComputedStyle(no).animationDuration));
  expect(duracao).toBeGreaterThanOrEqual(0.15);
  expect(duracao).toBeLessThanOrEqual(0.3);

  await bloco.locator("summary").click();
  await expect(bloco.locator("summary")).toHaveText("Histórico da marca");
  await expect(bloco.locator(".ck-os-marca__lista li")).toHaveText(["08/11/2026 às 09:00 · Marcada (automática)"]);

  // Cancelar a confirmação não envia nada.
  await bloco.getByRole("button", { name: "Desfazer, chamado UTIC-2026-1378" }).click();
  await expect(page.locator("#mensagem-confirmar-acao")).toContainText("não é reaberto no SoftExpert");
  await page.locator("#btn-confirmar-acao-cancelar").click();
  expect(estado.puts).toHaveLength(0);
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveCount(1);

  // Confirmar desfaz: a OS volta para Abertas (a linha sai das Finalizadas) e o foco vai para a aba ativa.
  await bloco.getByRole("button", { name: "Desfazer, chamado UTIC-2026-1378" }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  expect(estado.puts).toEqual([{ serie: "DEMO-SN-001", os: "7285070", chamado: "UTIC-2026-1378", acao: "desfazer" }]);
  await expect(linha).toBeHidden();
  await expect(page.locator("#os-aba-finalizadas")).toBeFocused();
  await page.locator("#os-aba-abertas").click();
  const desfeita = linha.locator('.ck-os-marca[data-ativa="false"]');
  await expect(desfeita).toHaveCount(1);
  await expect(linha).toHaveAttribute("data-finalizada", "false");
  await expect(desfeita.locator(".ck-os-marca__selo")).toHaveCount(0);
  await expect(desfeita.getByRole("button", { name: "Refazer, chamado UTIC-2026-1378" })).toBeVisible();
  await desfeita.locator("summary").click();
  await expect(desfeita.locator(".ck-os-marca__lista li")).toHaveText([
    "08/11/2026 às 09:00 · Marcada (automática)",
    "08/11/2026 às 10:30 · Desfeita (manual)",
  ]);

  // Refazer devolve a OS para Finalizadas.
  await desfeita.getByRole("button", { name: "Refazer, chamado UTIC-2026-1378" }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(linha).toBeHidden();
  await page.locator("#os-aba-finalizadas").click();
  await expect(linha.locator('.ck-os-marca[data-ativa="true"] .ck-os-marca__selo')).toHaveText("Chamado finalizado");
  expect(estado.puts.map(item => item.acao)).toEqual(["desfazer", "refazer"]);
});

test("Marca de OS finalizada: finalizado por outro técnico mostra motivo e dica; Conferido grava só a conferência", async ({ page }) => {
  const { estado, linha } = await abrirF6ComMarcas(page, [MARCA_OUTRO]);
  const bloco = linha.locator(".ck-os-marca");
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveText("Finalizado por outro técnico");
  await expect(bloco.locator(".ck-os-marca__dica")).toHaveText("Conferir no SoftExpert");
  await expect(bloco.locator(".ck-os-marca__motivo")).toHaveText("Saiu da lista de abertos do Dashboard sem finalização pelo site.");
  await bloco.getByRole("button", { name: "Conferido, chamado UTIC-2026-1379" }).click();
  // Conferir não abre confirmação: a dica e o botão saem e o histórico registra a conferência.
  await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
  await expect(bloco.locator(".ck-os-marca__dica")).toHaveCount(0);
  await expect(bloco.getByRole("button", { name: /^Conferido/ })).toHaveCount(0);
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveText("Finalizado por outro técnico");
  expect(estado.puts).toEqual([{ serie: "DEMO-SN-001", os: "7285070", chamado: "UTIC-2026-1379", acao: "conferir" }]);
  await bloco.locator("summary").click();
  await expect(bloco.locator(".ck-os-marca__lista li").last()).toHaveText("08/11/2026 às 10:30 · Conferida (manual)");
});

test("Marca de OS finalizada: falha do PUT mostra o erro, mantém a marca e reabilita os botões", async ({ page }) => {
  const { linha } = await abrirF6ComMarcas(page, [MARCA_SITE]);
  await page.route("**/api/operacoes/chamados/marcas-finalizacao", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, json: { detail: "Marcas indisponíveis no momento." } })
    : route.fallback());
  const bloco = linha.locator(".ck-os-marca");
  await bloco.getByRole("button", { name: "Desfazer, chamado UTIC-2026-1378" }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  // A mensagem de status da tabela fica na barra das sub-abas (#cockpit-tickets-contagem).
  await expect(page.locator("#cockpit-tickets-contagem")).toContainText("Marcas indisponíveis no momento.");
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveText("Chamado finalizado");
  await expect(bloco.getByRole("button", { name: "Desfazer, chamado UTIC-2026-1378" })).toBeEnabled();
});

test("Marca de OS finalizada: movimento reduzido desliga a animação de entrada", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { linha } = await abrirF6ComMarcas(page, [MARCA_SITE]);
  const duracao = await linha.locator(".ck-os-marca").evaluate(no => parseFloat(getComputedStyle(no).animationDuration));
  expect(duracao).toBeLessThan(0.01);
});

test("Marca de OS finalizada: a janela Chamado × OS (somente leitura) mostra só o selo do chamado, sem botões nem histórico", async ({ page }) => {
  // Duas marcas na mesma OS: a do chamado da janela (ativa) e outra de outro chamado; só a primeira aparece.
  await simularMarcas(page, [MARCA_SITE, { ...MARCA_OUTRO, chamado: "UTIC-2026-4000" }]);
  const gatilho = await abrirAbaOsComVinculo(page, "1378", { finalizadas: true });
  await gatilho.click();
  await expect(page.locator("#modal-chamado-os")).toBeVisible();
  const janela = page.locator("#chamado-os-janela-os");
  await expect(janela.locator(".ck-os-marca")).toHaveCount(1);
  await expect(janela.locator(".ck-os-marca__selo")).toHaveText("Chamado finalizado");
  await expect(janela.locator(".ck-os-marca button, .ck-os-marca details")).toHaveCount(0);
});

test("Marca de OS finalizada: marca desfeita não aparece na janela Chamado × OS", async ({ page }) => {
  await simularMarcas(page, [{ ...MARCA_SITE, ativa: false }]);
  const gatilho = await abrirAbaOsComVinculo(page, "1378");
  await gatilho.click();
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await expect(page.locator("#chamado-os-janela-os .ck-os-marca")).toHaveCount(0);
});

test("Aba OS (F6): selos Técnico e Aberta há N dias aparecem na célula da OS e na janela Chamado × OS", async ({ page }) => {
  // O fixture não calcula os campos; só no navegador a resposta de GET ganha os sinais da OS 7285070.
  await page.route("**/api/operacoes/chamados", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const corpo = await (await route.fetch()).json();
    Object.assign(corpo.chamados[0].oracle[0], { envio_tecnico: true, dias_aberta: 3 });
    await route.fulfill({ json: corpo });
  });
  const gatilho = await abrirAbaOsComVinculo(page, "1378");
  const celula = page.locator('#cockpit-tickets-os tbody tr[data-serial="DEMO-SN-001"] td[data-label="OS"]').first();
  const dias = celula.locator(".ck-os__selo--dias");
  const tecnico = celula.locator(".ck-os__selo--tecnico");
  await expect(dias).toHaveText("Aberta há 3 dias");
  await expect(tecnico).toHaveText("Técnico");
  await gatilho.click();
  await expect(page.locator("#chamado-os-janela-os .ck-os__selo--dias")).toHaveText("Aberta há 3 dias");
  await expect(page.locator("#chamado-os-janela-os .ck-os__selo--tecnico")).toHaveText("Técnico");
});
