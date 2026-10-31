const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// The fixture answers /api/sebrae/* with fictional tickets; no Chrome, SoftExpert or Dashboard file is touched.
async function abrirCartao(page, request, extra = "") {
  await request.get(`/__fixture_automacao?quantidade=0&sebrae=padrao&run=${extra}`);
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const cartao = page.locator("#sebrae-novos-painel");
  await expect(cartao).toBeVisible();
  return cartao;
}

// A lista, os antigos, a exportação e Atualizar Dashboard moram no painel Chamados Sebrae (menu Ferramentas ou botão do cartão).
async function abrirPainel(page, request, extra = "") {
  const cartao = await abrirCartao(page, request, extra);
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("novo(s)"); // a lista já foi carregada
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  return { cartao, painel };
}

test("Chamados novos mostra o Dashboard importado, os formulários e os avisos de pendência e erro", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  await expect(cartao.locator("#sebrae-dashboard-status")).toContainText("331 chamados já lançados");
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("2 novo(s), 36 já no Dashboard, 1 pendente(s)");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1387: pendente");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1457: não foi lido");
  // O cartão não lista mais os chamados: só o botão que abre o painel.
  await expect(cartao.locator("#sebrae-novos-lista, #btn-sebrae-exportar, #btn-sebrae-atualizar")).toHaveCount(0);
  await expect(cartao.locator("#btn-sebrae-abrir-chamados")).toHaveText("Chamados Sebrae");
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados Sebrae");
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado")).toHaveCount(2);
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado").first()).toContainText("DEMO0001");
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado").nth(1)).toContainText("mais de um equipamento");
  await expect(painel.locator("#btn-sebrae-exportar")).toBeDisabled();
  await expect(painel.locator("#sebrae-atualizar-status")).toContainText("Gere o Dashboard atualizado antes de enviar");
});

test("Chamados novos só exporta os prontos e mostra a mensagem aprovada com os dois blocos", async ({ page, request }) => {
  const { painel: cartao } = await abrirPainel(page, request);
  const primeiro = cartao.locator("#sebrae-novos-lista .sebrae-chamado").first();
  await primeiro.locator('[data-sebrae-campo="A"]').selectOption("CLIENTE"); // lista da aba LISTAS do Dashboard
  await expect(primeiro.locator('[data-sebrae-campo="D"]')).toHaveValue("EM ABERTO"); // padrão dos novos
  await primeiro.locator('[data-sebrae-campo="D"]').selectOption("EM ABERTO");
  await expect(cartao.locator("#btn-sebrae-exportar")).toBeDisabled();
  await primeiro.locator('[data-sebrae-campo="J"]').selectOption("INCIDENTE");
  await primeiro.locator('[data-sebrae-campo="R"]').fill("2026-10-28T09:05");
  await expect(primeiro.locator('[data-sebrae-campo="S"]')).toHaveValue("DISPONIBILIDADE"); // padrão, sem preencher
  await expect(cartao.locator("#sebrae-exportacao-status")).toHaveText("1 de 2 chamado(s) com Responsável, Status e Tipo preenchidos.");
  await cartao.locator("#btn-sebrae-exportar").click();
  await expect(cartao.locator("#sebrae-exportacao-status")).toHaveText("Planilha Exportada com Sucesso!");
  await expect(cartao.locator("#sebrae-bloco-a-p")).toHaveValue("CLIENTE\t\tUTIC-2026-1378\tEM ABERTO");
  await expect(cartao.locator("#sebrae-bloco-r-s")).toHaveValue("28/10/2026 09:05\tDISPONIBILIDADE");
});

test("Atualizar Dashboard baixa a cópia com os novos e as alterações dos antigos, sem tocar no original", async ({ page, request }) => {
  const { painel: cartao } = await abrirPainel(page, request);
  const atualizar = cartao.locator("#btn-sebrae-atualizar");
  await expect(atualizar).toBeEnabled(); // os 2 chamados novos da fixture já bastam; antes de a lista carregar o botão nasce desabilitado
  await cartao.locator("#sebrae-antigos > summary").click();
  const antigo = cartao.locator("#sebrae-antigos-lista .sebrae-chamado");
  await expect(antigo).toHaveCount(1);
  await expect(antigo.locator('[data-sebrae-campo="A"]')).toHaveValue("SIMPRESS");
  // O que o Atualizar Dashboard vai preencher aparece como prévia, sem virar campo editável.
  await expect(antigo.locator(".sebrae-chamado__auto")).toContainText("Camila Vitoria Lopes de Oliveira");
  await expect(antigo.locator(".sebrae-chamado__auto")).toContainText("DEMO0001 (será preenchido)");
  await expect(antigo.locator(".sebrae-chamado__auto")).toContainText("7303022 (será preenchido)");
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await antigo.locator('[data-sebrae-campo="R"]').fill("2026-10-28T09:05");
  await expect(cartao.locator("#sebrae-antigos-resumo")).toContainText("1 com alteração");
  await expect(atualizar).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent("download"), atualizar.click()]);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  await expect(cartao.locator("#sebrae-atualizar-status")).toContainText("2 novo(s) e 1 alterado(s)");
  await expect(cartao.locator("#sebrae-atualizar-status")).toContainText("importe a versão atual antes");
});

test("Chamados novos não tem violações de acessibilidade nos temas claro e escuro", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include("#sebrae-novos-painel").analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
  await expect(cartao).toBeVisible();
});

test("Chamados Sebrae abre pelo menu Ferramentas, sem recarregar a lista, e passa no axe nos dois temas", async ({ page, request }) => {
  await abrirCartao(page, request);
  await expect(page.locator("#sebrae-novos-resumo")).toContainText("novo(s)");
  await page.locator("#cockpit-tools-trigger").click();
  const item = page.locator("#btn-sebrae-chamados-menu");
  await expect(item).toHaveText("Chamados Sebrae");
  await expect(item.locator("kbd, .ck-badge")).toHaveCount(0);
  await item.click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados Sebrae");
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado")).toHaveCount(2);
  // Abrir o painel de novo não pode zerar o que foi preenchido nos chamados antigos.
  await painel.locator("#sebrae-antigos > summary").click();
  const antigo = painel.locator("#sebrae-antigos-lista .sebrae-chamado");
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await page.locator("#cockpit-tools-trigger").click();
  await item.click();
  await expect(antigo.locator('[data-sebrae-campo="D"]')).toHaveValue("FINALIZADO");
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="sebrae-chamados"]').analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
});

test("Chamados Sebrae não tem rolagem horizontal de 320px a 2560px", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request);
  for (const largura of [320, 360, 768, 1280, 2560]) {
    await page.setViewportSize({ width: largura, height: 800 });
    await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${largura}px`).toBe(true);
  }
});

test("Histórico mostra os três últimos registros no cartão e abre o painel completo pelo botão", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  const mini = cartao.locator("#sebrae-historico-resumo li");
  await expect(mini).toHaveCount(3);
  await expect(mini.first()).toContainText("2 lidos, 36 já no Dashboard, 1 pendente, 1 com erro");
  await expect(mini.nth(1)).toContainText("Reimportado 2 vezes");
  await cartao.getByRole("button", { name: "Histórico", exact: true }).click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Histórico de importações do Dashboard Sebrae");
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-historico"]');
  await expect(painel.locator("#sebrae-historico-lista-corpo tr")).toHaveCount(3);
  await expect(painel.locator("#sebrae-historico-kpis")).toContainText("Importações");
  await painel.locator("#sebrae-historico-lista-corpo tr").nth(1).click();
  await expect(painel.locator("#sebrae-historico-detalhe-grupos")).toContainText("UTIC-2026-1200: EM ABERTO → FINALIZADO (encerrado em 27/10/2026 16:00)");
  await painel.locator("#sebrae-historico-filtro").selectOption("busca");
  await expect(painel.locator("#sebrae-historico-lista-corpo tr")).toHaveCount(1);
});

test("Histórico vira cartões no celular, sem rolagem horizontal, e passa no axe", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  await page.setViewportSize({ width: 360, height: 800 });
  await cartao.getByRole("button", { name: "Histórico", exact: true }).click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-historico"]');
  await expect(painel.locator("#sebrae-historico-lista-corpo td[data-label]").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="sebrae-historico"]').analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
});

// ---- Finalizar no SoftExpert (fixture: nada chega ao SoftExpert nem ao SharePoint reais) ----

const ROTULO_DESCRICAO = "Descrição para Finalizar o Chamado";
const BOTAO_FINALIZAR = "Finalizar no SoftExpert";
const BOTAO_REENVIAR = "Tentar substituir de novo";

async function abrirAntigo(page, request, extra = "") {
  const { painel } = await abrirPainel(page, request, extra);
  await painel.locator("#sebrae-antigos > summary").click();
  const antigo = painel.locator("#sebrae-antigos-lista .sebrae-chamado");
  await expect(antigo).toHaveCount(1);
  return { painel, antigo };
}

async function descreverChamado(antigo, texto = "Troquei o teclado e testei a digitação.") {
  const campo = antigo.getByLabel(ROTULO_DESCRICAO);
  await campo.fill(texto);
  await expect(antigo.locator(".sebrae-chamado__feedback").first()).toHaveText("Descrição salva.");
  return campo;
}

test("cada chamado em aberto tem o campo de descrição e o botão fica desabilitado sem texto", async ({ page, request }) => {
  const { antigo } = await abrirAntigo(page, request);
  const botao = antigo.getByRole("button", { name: BOTAO_FINALIZAR, exact: true });
  const campo = antigo.getByLabel(ROTULO_DESCRICAO);
  await expect(campo).toHaveAttribute("maxlength", "4000");
  await expect(botao).toBeDisabled();
  await campo.fill("   ");
  await expect(botao).toBeDisabled();
  await campo.fill("Troquei o teclado.");
  await expect(antigo.locator(".sebrae-chamado__feedback").first()).toHaveText("Descrição salva.");
  await expect(botao).toBeEnabled();
  await campo.fill("");
  await expect(botao).toBeDisabled();
  await expect(antigo.locator(".sebrae-chamado__feedback").first()).toHaveText("Descrição salva.");
  // A descrição salva volta quando a lista é carregada de novo.
  await campo.fill("Texto que fica salvo");
  await expect(antigo.locator(".sebrae-chamado__feedback").first()).toHaveText("Descrição salva.");
  await page.reload();
  await page.locator("#tab-automacao").click();
  await page.locator("#btn-sebrae-abrir-chamados").click();
  await page.locator("#sebrae-antigos > summary").click();
  await expect(page.locator("#sebrae-antigos-lista").getByLabel(ROTULO_DESCRICAO)).toHaveValue("Texto que fica salvo");
});

test("o PDF opcional mostra nome e tamanho, pode ser trocado e removido", async ({ page, request }) => {
  const { antigo } = await abrirAntigo(page, request);
  const info = antigo.locator(".sebrae-chamado__pdf");
  await expect(info).toHaveText("Nenhum PDF anexado.");
  await expect(antigo.getByRole("button", { name: "Remover PDF" })).toBeHidden();
  const entrada = antigo.locator("[data-sebrae-pdf]");
  await entrada.setInputFiles({ name: "comprovante.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 teste") });
  await expect(info).toContainText("comprovante.pdf");
  await expect(info).toContainText(/\(\d+ B\)/);
  await expect(antigo.locator(".sebrae-chamado__feedback").nth(1)).toHaveText("PDF salvo.");
  await entrada.setInputFiles({ name: "novo.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 outro") });
  await expect(info).toContainText("novo.pdf");
  await expect(info).not.toContainText("comprovante.pdf");
  await antigo.getByRole("button", { name: "Remover PDF" }).click();
  await expect(info).toHaveText("Nenhum PDF anexado.");
  await expect(antigo.locator(".sebrae-chamado__feedback").nth(1)).toHaveText("PDF removido.");
});

test("Finalizar no SoftExpert pede confirmação explícita, mostra o andamento e o resultado", async ({ page, request }) => {
  const { antigo } = await abrirAntigo(page, request);
  const botao = antigo.getByRole("button", { name: BOTAO_FINALIZAR, exact: true });
  await descreverChamado(antigo);
  await antigo.locator("[data-sebrae-pdf]").setInputFiles({ name: "comprovante.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 teste") });
  await expect(antigo.locator(".sebrae-chamado__pdf")).toContainText("comprovante.pdf");
  const posts = [];
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/sebrae/finalizar-softexpert")) posts.push(r.url()); });
  await botao.click();
  const modal = page.locator("#modal-confirmar-acao");
  await expect(modal).toBeVisible();
  await expect(modal.locator("#mensagem-confirmar-acao")).toContainText("não tem volta");
  await expect(modal.locator("#mensagem-confirmar-acao")).toContainText("PDF anexado será enviado");
  await modal.locator("#btn-confirmar-acao-cancelar").click();
  await expect(modal).toBeHidden();
  expect(posts).toHaveLength(0); // cancelar não finaliza nada
  await expect(botao).toBeEnabled();
  await botao.click();
  await modal.locator("#btn-confirmar-acao-ok").click();
  await expect(antigo.locator(".sebrae-chamado__resultado")).toHaveText("Finalizando no SoftExpert…");
  await expect(botao).toBeDisabled(); // rotina rodando
  await expect(antigo.locator(".sebrae-chamado__resultado")).toContainText("Finalizado no SoftExpert (encerrado em 28/10/2026 10:10)", { timeout: 10000 });
  expect(posts).toHaveLength(1);
  await expect(botao).toBeDisabled(); // já finalizado
  await expect(page.locator("#sebrae-sharepoint-aviso")).toBeHidden();
});

test("Atualizar Dashboard confirma, finaliza em massa e mostra o resultado por chamado", async ({ page, request }) => {
  const { painel, antigo } = await abrirAntigo(page, request);
  await descreverChamado(antigo);
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await painel.locator("#btn-sebrae-atualizar").click();
  const modal = page.locator("#modal-confirmar-acao");
  await expect(modal).toBeVisible();
  await expect(modal.locator("#mensagem-confirmar-acao")).toContainText("UTIC-2026-1200");
  await expect(modal.locator("#mensagem-confirmar-acao")).toContainText("não tem volta");
  await expect(modal.locator("#btn-confirmar-acao-ok")).toHaveText("Atualizar e finalizar");
  const envio = page.waitForRequest(r => r.method() === "POST" && r.url().endsWith("/api/sebrae/dashboard/atualizar"));
  const [download] = await Promise.all([page.waitForEvent("download"), modal.locator("#btn-confirmar-acao-ok").click()]);
  expect((await envio).postDataJSON().finalizar_softexpert).toBe(true);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  await expect(painel.locator("#sebrae-fechar-status")).toContainText("Finalizando no SoftExpert");
  await expect(painel.locator("#sebrae-fechar-lista")).toContainText("UTIC-2026-1200: Finalizado no SoftExpert", { timeout: 10000 });
  await expect(painel.locator("#sebrae-fechar-status")).toContainText("Finalização no SoftExpert terminada: 1 finalizado(s).");
  await expect(painel.locator("#sebrae-sharepoint-aviso")).toBeHidden();
  await expect(antigo.locator(".sebrae-chamado__resultado")).toContainText("Finalizado no SoftExpert");
});

test("Só atualizar (botão ou Esc) baixa o Dashboard e não finaliza nada no SoftExpert", async ({ page, request }) => {
  const { painel, antigo } = await abrirAntigo(page, request);
  await descreverChamado(antigo);
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  const envios = [];
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/sebrae/dashboard/atualizar")) envios.push(r.postDataJSON()); });
  const modal = page.locator("#modal-confirmar-acao");
  await painel.locator("#btn-sebrae-atualizar").click();
  await expect(modal.locator("#btn-confirmar-acao-ok")).toHaveText("Atualizar e finalizar");
  await expect(modal.locator("#btn-confirmar-acao-cancelar")).toHaveText("Só atualizar");
  await expect(modal.locator("#mensagem-confirmar-acao")).toContainText("NÃO finaliza");
  const [download] = await Promise.all([page.waitForEvent("download"), modal.locator("#btn-confirmar-acao-cancelar").click()]);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  await expect(modal).toBeHidden();
  await expect(painel.locator("#sebrae-atualizar-status")).toContainText("nenhum chamado foi finalizado no SoftExpert");
  await expect(painel.locator("#sebrae-fechar-status")).toContainText("não confirmada");
  await expect(painel.locator("#btn-sebrae-atualizar")).toBeEnabled();
  expect(envios).toHaveLength(1);
  expect(envios[0].finalizar_softexpert).toBe(false);
  await painel.locator("#btn-sebrae-atualizar").click(); // Esc também nunca finaliza
  await expect(modal).toBeVisible();
  const [segundo] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Escape")]);
  expect(segundo.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  expect(envios).toHaveLength(2);
  expect(envios[1].finalizar_softexpert).toBe(false);
});

test("chamado FINALIZADO sem descrição é pulado e o motivo aparece, sem pedir confirmação", async ({ page, request }) => {
  const { painel, antigo } = await abrirAntigo(page, request);
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  const [download] = await Promise.all([page.waitForEvent("download"), painel.locator("#btn-sebrae-atualizar").click()]);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
  await expect(painel.locator("#sebrae-fechar-status")).toContainText("Nenhum chamado foi finalizado no SoftExpert");
  await expect(painel.locator("#sebrae-fechar-status")).toContainText("1 pulado(s)");
  await expect(painel.locator("#sebrae-fechar-lista")).toContainText("UTIC-2026-1200: não será finalizado no SoftExpert (sem descrição para finalizar).");
  await expect(painel.locator("#sebrae-atualizar-status")).toContainText("Baixado"); // a atualização não quebra
});

test("falha no SharePoint mostra o aviso com motivo, cópia local e sugestões, e Tentar substituir de novo reenvia", async ({ page, request }) => {
  const { painel, antigo } = await abrirAntigo(page, request, "&sharepoint_falha=1");
  const aviso = painel.locator("#sebrae-sharepoint-aviso");
  await expect(aviso).toBeHidden();
  await descreverChamado(antigo);
  await antigo.getByRole("button", { name: BOTAO_FINALIZAR, exact: true }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(aviso).toBeVisible({ timeout: 10000 });
  await expect(aviso).toContainText("O Dashboard não foi substituído no SharePoint.");
  await expect(aviso).toContainText("Motivo: o SharePoint pediu login de novo");
  await expect(aviso).toContainText("Cópia local pendente:");
  await expect(aviso.locator("code")).toContainText("Dashboard Operacional_SEBRAE (pendente 2026-10-28 1030).xlsx");
  await expect(aviso).toContainText("só neste computador");
  await expect(aviso.locator("ol li")).toHaveCount(3);
  await expect(aviso).toContainText("porta 9333");
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include("#sebrae-sharepoint-aviso").analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
  const reenviar = aviso.getByRole("button", { name: BOTAO_REENVIAR, exact: true });
  await expect(reenviar).toBeEnabled();
  await reenviar.click();
  await expect(aviso).toBeHidden({ timeout: 10000 });
});

test("o aviso do SharePoint e o resultado respeitam movimento reduzido e não criam rolagem horizontal no celular", async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  const { painel, antigo } = await abrirAntigo(page, request, "&sharepoint_falha=1");
  await descreverChamado(antigo);
  await antigo.getByRole("button", { name: BOTAO_FINALIZAR, exact: true }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  const aviso = painel.locator("#sebrae-sharepoint-aviso");
  await expect(aviso).toBeVisible({ timeout: 10000 });
  expect(await aviso.evaluate(elemento => getComputedStyle(elemento).animationName)).toBe("none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("Rascunho: o que foi selecionado sobrevive a recarregar a página, sem Atualizar Dashboard, e pode ser descartado", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request);
  const primeiro = painel.locator("#sebrae-novos-lista .sebrae-chamado").first();
  await expect(painel.locator("#sebrae-rascunho")).toBeHidden();
  await primeiro.locator('[data-sebrae-campo="A"]').selectOption("CLIENTE");
  await primeiro.locator('[data-sebrae-campo="J"]').selectOption("INCIDENTE");
  await expect(painel.locator("#sebrae-rascunho-status")).toContainText("Rascunho salvo automaticamente neste navegador");
  await painel.locator("#sebrae-antigos > summary").click();
  await painel.locator("#sebrae-antigos-lista .sebrae-chamado").locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  const posts = [];
  page.on("request", r => { if (r.method() === "POST") posts.push(r.url()); });
  await page.reload(); // a "internet caiu": nada passou por Atualizar Dashboard
  const { painel: depois } = await abrirPainel(page, request);
  const novo = depois.locator("#sebrae-novos-lista .sebrae-chamado").first();
  await expect(novo.locator('[data-sebrae-campo="A"]')).toHaveValue("CLIENTE");
  await expect(novo.locator('[data-sebrae-campo="J"]')).toHaveValue("INCIDENTE");
  await expect(depois.locator("#sebrae-rascunho-status")).toContainText("Rascunho restaurado");
  await depois.locator("#sebrae-antigos > summary").click();
  await expect(depois.locator("#sebrae-antigos-lista .sebrae-chamado").locator('[data-sebrae-campo="D"]')).toHaveValue("FINALIZADO");
  expect(posts.filter(url => url.includes("/api/sebrae/dashboard/atualizar") || url.includes("/finalizar-softexpert"))).toHaveLength(0); // restaurar nunca atualiza nem finaliza sozinho
  await depois.locator("#btn-sebrae-descartar-rascunho").click();
  const modal = page.locator("#modal-confirmar-acao");
  await expect(modal).toBeVisible();
  await modal.locator("#btn-confirmar-acao-cancelar").click();
  await expect(novo.locator('[data-sebrae-campo="A"]')).toHaveValue("CLIENTE"); // cancelar mantém
  await depois.locator("#btn-sebrae-descartar-rascunho").click();
  await modal.locator("#btn-confirmar-acao-ok").click();
  await expect(depois.locator("#sebrae-rascunho-status")).toHaveText("Rascunho descartado.");
  await expect(depois.locator("#sebrae-novos-lista .sebrae-chamado").first().locator('[data-sebrae-campo="A"]')).toHaveValue("");
  await expect(depois.locator("#sebrae-antigos-lista .sebrae-chamado").locator('[data-sebrae-campo="D"]')).toHaveValue("EM ABERTO");
});
