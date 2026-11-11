const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// The fixture answers /api/sebrae/* with fictional tickets; no Chrome, SoftExpert or Dashboard file is touched.
async function abrirCartao(page, request, extra = "", antigos = "") {
  await request.get(`/__fixture_automacao?quantidade=0&sebrae=padrao&run=${extra}&antigos=${antigos}`);
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const cartao = page.locator("#sebrae-novos-painel");
  await expect(cartao).toBeVisible();
  return cartao;
}

// A lista, os antigos, a exportação e Atualizar Dashboard moram no painel Chamados (F5; barra principal, menu Ferramentas ou botão do cartão).
async function abrirPainel(page, request, extra = "", antigos = "") {
  const cartao = await abrirCartao(page, request, extra, antigos);
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("novo(s)"); // a lista já foi carregada
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  return { cartao, painel };
}

// Cada antigo é um `details.sebrae-antigo` recolhido (resumo + cartão): abre o do cartão `antigo` se ainda estiver fechado.
async function abrirItemAntigo(antigo) {
  const item = antigo.locator("xpath=..");
  if (!(await item.evaluate(no => no.open))) await item.locator("> summary").click();
  await expect(antigo).toBeVisible();
}

// "Chamados antigos em aberto" é a sub-aba Antigos do F5 (07/11/2026): seleciona a aba e espera o painel.
async function abrirSecaoAntigos(painel) {
  await painel.locator("#sebrae-aba-antigos").click();
  await expect(painel.locator("#sebrae-antigos-lista")).toBeVisible();
}

test("Chamados novos mostra o Dashboard importado, os formulários e os avisos de pendência e erro", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  await expect(cartao.locator("#sebrae-dashboard-status")).toContainText("331 chamados já lançados");
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("2 novo(s), 36 já no Dashboard, 1 pendente(s)");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1387: pendente");
  await expect(cartao.locator("#sebrae-novos-avisos")).toContainText("UTIC-2026-1457: não foi lido");
  // O cartão não lista mais os chamados: só o botão que abre o painel. Ler chamados antigos (botão, status e falhas) também mora no painel F5.
  await expect(cartao.locator("#sebrae-novos-lista, #btn-sebrae-atualizar, #btn-sebrae-ler-antigos, #sebrae-antigos-leitura-status, #sebrae-antigos-leitura-falhas")).toHaveCount(0);
  await expect(cartao.locator("#btn-sebrae-abrir-chamados")).toHaveText("Chamados");
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados");
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  for (const id of ["btn-sebrae-ler-antigos", "sebrae-antigos-leitura-status", "sebrae-antigos-leitura-falhas"]) await expect(painel.locator(`#${id}`)).toHaveCount(1);
  await expect(page.locator("#btn-sebrae-ler-antigos, #sebrae-antigos-leitura-status, #sebrae-antigos-leitura-falhas")).toHaveCount(3); // e em nenhum outro lugar da página
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado")).toHaveCount(2);
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado").first()).toContainText("DEMO0001");
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado").nth(1)).toContainText("mais de um equipamento");
  await expect(painel.locator("#btn-sebrae-exportar")).toHaveCount(0); // Exportar linhas foi removido
  await expect(painel.locator("#sebrae-atualizar-status")).toContainText("Gere o Dashboard atualizado antes de enviar");
  await expect(painel.locator("#sebrae-atualizar-status")).toHaveAttribute("data-estado", "alerta"); // o CSS pinta o aviso
});

test("Chamados novos: campos manuais com padrão, sem botão de exportar", async ({ page, request }) => {
  const { painel: cartao } = await abrirPainel(page, request);
  const primeiro = cartao.locator("#sebrae-novos-lista .sebrae-chamado").first();
  await expect(primeiro.getByLabel("Descrição para Finalizar o Chamado")).toBeVisible(); // novos também finalizam, sozinhos ou em massa
  await expect(primeiro.getByRole("button", { name: "Finalizar no SoftExpert" })).toBeEnabled(); // clicável: sem campos, o clique avisa o que falta
  await primeiro.locator('[data-sebrae-campo="A"]').selectOption("CLIENTE"); // lista da aba LISTAS do Dashboard
  await expect(primeiro.locator('[data-sebrae-campo="D"]')).toHaveValue("EM ABERTO"); // padrão dos novos
  await primeiro.locator('[data-sebrae-campo="D"]').selectOption("EM ABERTO");
  await primeiro.locator('[data-sebrae-campo="J"]').selectOption("INCIDENTE");
  await primeiro.locator('[data-sebrae-campo="R"]').fill("2026-10-28T09:05");
  await expect(primeiro.locator('[data-sebrae-campo="S"]')).toHaveValue("DISPONIBILIDADE"); // padrão, sem preencher
  await expect(cartao.locator("#btn-sebrae-exportar, #sebrae-exportacao-status, #sebrae-exportacao-blocos")).toHaveCount(0);
});

test("Chamados finalizados é a sub-aba Finalizados, escondida até ser escolhida e só com leitura", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request);
  const secao = painel.locator("#sebrae-finalizados");
  await expect(secao).toBeHidden(); // o F5 abre em Novos
  await expect(painel.locator("#sebrae-aba-finalizados")).toHaveAttribute("aria-label", "Finalizados: 1 chamado");
  await painel.locator("#sebrae-aba-finalizados").click();
  await expect(secao).toBeVisible();
  await expect(secao.locator("#sebrae-finalizados-resumo")).toContainText("1 chamado(s) finalizado(s)");
  const cartao = secao.locator('#sebrae-finalizados-lista details.sebrae-finalizado[data-numero="UTIC-2026-1100"]');
  await expect(cartao.locator("> summary")).toHaveText("UTIC-2026-1100 · encerrado em 27/10/2026 14:05", { useInnerText: true });
  await expect(cartao).not.toHaveAttribute("open", ""); // cada chamado finalizado também nasce minimizado
  await cartao.locator("> summary").click();
  await expect(cartao.locator('[data-sebrae-campo="D"]')).toHaveValue("FINALIZADO");
  await expect(cartao.locator('[data-sebrae-campo="R"]')).toHaveValue("27/10/2026 14:05");
  await expect(cartao.getByLabel("Descrição para Finalizar o Chamado")).toHaveValue("Teclado trocado.");
  await expect(cartao.locator('input:not([disabled]), select, button:not([data-sebrae-destaque]):not(.sebrae-chamado__recolher), textarea:not([readonly])')).toHaveCount(0); // só leitura (Recolher chamado só fecha a linha)
});

test("Atualizar Dashboard baixa a cópia com os novos e as alterações dos antigos, sem tocar no original", async ({ page, request }) => {
  const { painel: cartao } = await abrirPainel(page, request);
  const atualizar = cartao.locator("#btn-sebrae-atualizar");
  await expect(atualizar).toBeEnabled(); // os 2 chamados novos da fixture já bastam; antes de a lista carregar o botão nasce desabilitado
  await cartao.locator("#sebrae-aba-antigos").click();
  const antigo = cartao.locator("#sebrae-antigos-lista .sebrae-chamado");
  await expect(antigo).toHaveCount(1);
  await abrirItemAntigo(antigo);
  await expect(antigo.locator('[data-sebrae-campo="A"]')).toHaveValue("SIMPRESS");
  // O que o Atualizar Dashboard vai preencher aparece como prévia, sem virar campo editável.
  await expect(antigo.locator(".sebrae-chamado__auto")).toContainText("Camila Vitoria Lopes de Oliveira");
  await expect(antigo.locator(".sebrae-chamado__auto")).toContainText("DEMO0001 (será preenchido)");
  await expect(antigo.locator(".sebrae-chamado__auto")).toContainText("7303022 (será preenchido)");
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await antigo.locator('[data-sebrae-campo="R"]').fill("2026-10-28T09:05");
  await expect(cartao.locator("#sebrae-antigos-resumo")).toContainText("1 com alteração");
  await expect(atualizar).toBeEnabled();
  // Nenhum chamado vai ser finalizado e um FINALIZADO foi pulado: o diálogo pergunta antes de enviar ao SharePoint; este teste só atualiza.
  await atualizar.click();
  const confirmar = page.locator("#modal-confirmar-acao");
  await expect(confirmar.locator("#btn-confirmar-acao-cancelar")).toHaveText("Atualizar sem enviar");
  const [download] = await Promise.all([page.waitForEvent("download"), confirmar.locator("#btn-confirmar-acao-cancelar").click()]);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  await expect(cartao.locator("#sebrae-atualizar-status")).toContainText("2 novo(s) e 1 alterado(s)");
  // FINALIZADO sem descrição não vira finalização: a linha avisa o número e o motivo, em alerta, em vez de calar.
  await expect(cartao.locator("#sebrae-atualizar-status")).toContainText("Não serão finalizados no SoftExpert: UTIC-2026-1200 (sem descrição para finalizar).");
  await expect(cartao.locator("#sebrae-atualizar-status")).toHaveAttribute("data-estado", "alerta");
  await expect(cartao.locator("#sebrae-atualizar-status")).toContainText("importe a versão atual antes");
});

test("Título (G): o campo existe no novo e no antigo, vai só ao corpo do Atualizar Dashboard e o SoftExpert não é chamado", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request);
  const novo = painel.locator("#sebrae-novos-lista .sebrae-chamado").first();
  const campoNovo = novo.locator('[data-sebrae-campo="G"]');
  await expect(campoNovo).toHaveAttribute("maxlength", "300");
  await expect(novo.getByLabel("Título (G)")).toBeVisible();
  await campoNovo.fill("Teclado sem resposta (título corrigido)");
  await expect(novo.locator(".sebrae-chamado__assunto")).toHaveText("Teclado sem resposta (título corrigido)"); // o assunto do cartão acompanha a digitação
  await painel.locator("#sebrae-aba-antigos").click();
  const antigo = painel.locator("#sebrae-antigos-lista .sebrae-chamado");
  await abrirItemAntigo(antigo);
  await antigo.locator('[data-sebrae-campo="G"]').fill("Título corrigido do antigo");
  await expect(painel.locator("#sebrae-antigos-resumo")).toContainText("1 com alteração"); // só o título editado já conta como alteração
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO"); // sem descrição: o diálogo pergunta antes do SharePoint e "Atualizar sem enviar" só baixa a cópia
  const envio = page.waitForRequest(r => r.method() === "POST" && r.url().endsWith("/api/sebrae/dashboard/atualizar"));
  const chamadasSoftExpert = [];
  page.on("request", r => { if (r.method() !== "GET" && /finalizar-softexpert|antigos\/ler/.test(r.url())) chamadasSoftExpert.push(r.url()); });
  await painel.locator("#btn-sebrae-atualizar").click();
  const confirmar = page.locator("#modal-confirmar-acao");
  const [download] = await Promise.all([page.waitForEvent("download"), confirmar.locator("#btn-confirmar-acao-cancelar").click()]);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  const corpo = (await envio).postDataJSON();
  expect(corpo.chamados.some(c => c.G === "Teclado sem resposta (título corrigido)")).toBe(true);
  expect(corpo.edicoes).toHaveLength(1);
  expect(corpo.edicoes[0].G).toBe("Título corrigido do antigo");
  expect(corpo.finalizar_softexpert).toBe(false); // "Atualizar sem finalizar": o título nunca aciona o SoftExpert
  expect(chamadasSoftExpert).toHaveLength(0);
  expect(JSON.stringify(corpo)).not.toContain('"H"'); // a descrição H nunca viaja nos corpos de chamados e edições
});

test("Chamados novos não tem violações de acessibilidade nos temas claro e escuro",async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include("#sebrae-novos-painel").analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
  await expect(cartao).toBeVisible();
});

// Chamados fica na barra principal; abaixo de 1200px o menu Ferramentas o oferece (item so-compacto).
async function abrirChamadosPelaNavegacao(page) {
  const naBarra = await page.locator("#btn-sebrae-chamados-aba").isVisible();
  if (!naBarra) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra ? "#btn-sebrae-chamados-aba" : "#btn-sebrae-chamados-menu").click();
}

test("Chamados abre pela barra ou pelo menu Ferramentas, sem recarregar a lista, e passa no axe nos dois temas", async ({ page, request }) => {
  await abrirCartao(page, request);
  await expect(page.locator("#sebrae-novos-resumo")).toContainText("novo(s)");
  await expect(page.locator("#btn-sebrae-chamados-aba span")).toHaveText("Chamados");
  await expect(page.locator("#btn-sebrae-chamados-menu")).toHaveText(/^Chamados\s*F5$/);
  await abrirChamadosPelaNavegacao(page);
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Chamados");
  await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado")).toHaveCount(2);
  // Abrir o painel de novo não pode zerar o que foi preenchido nos chamados antigos.
  await painel.locator("#sebrae-aba-antigos").click();
  const antigo = painel.locator("#sebrae-antigos-lista .sebrae-chamado");
  await abrirItemAntigo(antigo);
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await abrirChamadosPelaNavegacao(page);
  await expect(antigo.locator('[data-sebrae-campo="D"]')).toHaveValue("FINALIZADO");
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="sebrae-chamados"]').analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
});

test("Chamados não tem rolagem horizontal de 320px a 2560px", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request);
  for (const largura of [320, 360, 768, 1280, 2560]) {
    await page.setViewportSize({ width: largura, height: 800 });
    await expect(painel.locator("#sebrae-novos-lista .sebrae-chamado").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${largura}px`).toBe(true);
  }
});

test("Histórico mostra os três últimos registros no cartão, sem botão nem painel completo", async ({ page, request }) => {
  const cartao = await abrirCartao(page, request);
  const mini = cartao.locator("#sebrae-historico-resumo li");
  await expect(mini).toHaveCount(3);
  await expect(mini.first()).toContainText("2 lidos, 36 já no Dashboard, 1 pendente, 1 com erro");
  await expect(mini.nth(1)).toContainText("Reimportado 2 vezes");
  await expect(cartao.getByRole("button", { name: "Histórico", exact: true })).toHaveCount(0);
  await expect(page.locator("#btn-sebrae-historico-menu, [data-cockpit-tool-panel=\"sebrae-historico\"]")).toHaveCount(0);
});

// ---- Finalizar no SoftExpert (fixture: nada chega ao SoftExpert nem ao SharePoint reais) ----

const ROTULO_DESCRICAO = "Descrição para Finalizar o Chamado";
const BOTAO_FINALIZAR = "Finalizar no SoftExpert";
const BOTAO_REENVIAR = "Tentar substituir de novo";

async function abrirAntigo(page, request, extra = "") {
  const { painel } = await abrirPainel(page, request, extra);
  await abrirSecaoAntigos(painel);
  const antigo = painel.locator("#sebrae-antigos-lista .sebrae-chamado");
  await expect(antigo).toHaveCount(1);
  await abrirItemAntigo(antigo);
  return { painel, antigo };
}

async function descreverChamado(antigo, texto = "Troquei o teclado e testei a digitação.") {
  const campo = antigo.getByLabel(ROTULO_DESCRICAO);
  await campo.fill(texto);
  await expect(antigo.locator(".sebrae-chamado__feedback").first()).toHaveText("Descrição salva.");
  return campo;
}

/** Deixa o chamado antigo da fixture pronto para finalizar: Status FINALIZADO e um Encerramento manual (A e J já vêm preenchidos). */
async function completarCampos(antigo, encerramento = "2026-10-27T09:00") {
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await antigo.locator('[data-sebrae-campo="R"]').fill(encerramento);
}

const TOAST = "#toast-container .ck-toast";

test("cada chamado em aberto tem o campo de descrição e o botão avisa na tela o que falta preencher", async ({ page, request }) => {
  const { antigo } = await abrirAntigo(page, request);
  const botao = antigo.getByRole("button", { name: BOTAO_FINALIZAR, exact: true });
  const campo = antigo.getByLabel(ROTULO_DESCRICAO);
  await expect(campo).toHaveAttribute("maxlength", "4000");
  await expect(botao).toBeEnabled();
  const posts = [];
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/sebrae/finalizar-softexpert")) posts.push(r.url()); });
  await botao.click(); // Status em aberto, sem Encerramento e sem descrição
  const aviso = page.locator(TOAST).filter({ hasText: "antes de finalizar, preencha" }).last();
  await expect(aviso).toContainText("Status (D) em FINALIZADO (está EM ABERTO)");
  await expect(aviso).toContainText("Descrição para Finalizar o Chamado");
  await expect(aviso).not.toContainText("Encerramento (R)"); // R é opcional
  await expect(aviso).not.toContainText("Responsável (A)"); // A e J já estão preenchidos
  await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
  expect(posts).toHaveLength(0);
  await campo.fill("   ");
  await botao.click();
  await expect(page.locator(TOAST).filter({ hasText: "Descrição para Finalizar o Chamado" }).last()).toBeVisible();
  await campo.fill("Troquei o teclado.");
  await expect(antigo.locator(".sebrae-chamado__feedback").first()).toHaveText("Descrição salva.");
  await completarCampos(antigo);
  await botao.click();
  await expect(page.locator("#modal-confirmar-acao")).toBeVisible(); // nada falta: pede a confirmação
  await page.locator("#btn-confirmar-acao-cancelar").click();
  expect(posts).toHaveLength(0);
  await campo.fill("");
  await expect(antigo.locator(".sebrae-chamado__feedback").first()).toHaveText("Descrição salva.");
  // A descrição salva volta quando a lista é carregada de novo.
  await campo.fill("Texto que fica salvo");
  await expect(antigo.locator(".sebrae-chamado__feedback").first()).toHaveText("Descrição salva.");
  await page.reload();
  await page.locator("#tab-automacao").click();
  await page.locator("#btn-sebrae-abrir-chamados").click();
  await page.locator("#sebrae-aba-antigos").click();
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
  await completarCampos(antigo);
  await antigo.locator('[data-sebrae-campo="B"]').selectOption("REDE");
  await antigo.locator("[data-sebrae-pdf]").setInputFiles({ name: "comprovante.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 teste") });
  await expect(antigo.locator(".sebrae-chamado__pdf")).toContainText("comprovante.pdf");
  const posts = [];
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/sebrae/finalizar-softexpert")) posts.push(r.postDataJSON()); });
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
  const cartao = page.locator('#sebrae-finalizados-lista details.sebrae-finalizado[data-numero="UTIC-2026-1200"]');
  await expect(cartao).toHaveCount(1, { timeout: 10000 }); // o `ok` vai na hora para Chamados finalizados
  await page.locator("#sebrae-aba-finalizados").click(); // innerText de painel escondido vem vazio: abre a aba Finalizados
  await expect(cartao.locator("> summary")).toHaveText("UTIC-2026-1200 · Teclado sem resposta · Camila Vitoria Lopes de Oliveira · encerrado em 28/10/2026 10:10", { useInnerText: true });
  await expect(page.locator("#sebrae-antigos-lista .sebrae-chamado")).toHaveCount(0); // e sai dos antigos em aberto
  await expect(page.getByText("Finalização no SoftExpert terminada")).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0].confirmado).toBe(true);
  // O finalizar individual leva só as edições mudadas (B é novo, D e R vêm da edição) e nenhum novo em branco (só com os padrões D/S).
  expect(posts[0].edicoes).toEqual([expect.objectContaining({ numero: "UTIC-2026-1200", B: "REDE", D: "FINALIZADO" })]);
  expect(posts[0].chamados).toEqual([]);
  await cartao.locator("> summary").click();
  await expect(cartao.locator('[data-sebrae-campo="B"]')).toHaveValue("REDE");
  await expect(cartao.locator('[data-sebrae-campo="D"]')).toHaveValue("FINALIZADO");
  await expect(cartao.locator('[data-sebrae-campo="R"]')).toHaveValue("28/10/2026 10:10");
  await expect(page.locator("#sebrae-sharepoint-aviso")).toBeHidden();
});

test("Finalizar leva só os novos já trabalhados e o toast mostra o erro 422 do outro chamado", async ({ page, request }) => {
  const { painel, antigo } = await abrirAntigo(page, request);
  await descreverChamado(antigo);
  await completarCampos(antigo);
  await painel.locator("#sebrae-aba-novos").click();
  // um chamado aberto por vez: abrir o antigo fechou o 1378 (primeiro novo), e abrir o 1378 fecha o antigo
  const novo = painel.locator('#sebrae-novos-lista .sebrae-chamado[data-numero="UTIC-2026-1378"]');
  await abrirItemAntigo(novo);
  await expect(antigo).toBeHidden();
  await novo.locator('[data-sebrae-campo="A"]').selectOption("CLIENTE");
  const detalhe = "UTIC-2026-1378: A coluna A só aceita os valores da lista do Dashboard (aba LISTAS).";
  const posts = [];
  await page.route("**/api/sebrae/finalizar-softexpert", rota => {
    if (rota.request().method() !== "POST") return rota.fallback();
    posts.push(rota.request().postDataJSON());
    return rota.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: detalhe }) });
  });
  await painel.locator("#sebrae-aba-antigos").click();
  await abrirItemAntigo(antigo);
  await antigo.getByRole("button", { name: BOTAO_FINALIZAR, exact: true }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(page.locator(TOAST).filter({ hasText: detalhe })).toHaveCount(1);
  await expect(page.locator(TOAST).filter({ hasText: "este chamado" })).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0].chamados.map(c => c.numero)).toEqual(["UTIC-2026-1378"]); // 1336 está em branco e não vai
});

test("Cancelar aparece ao lado de Finalizar só enquanto a rotina roda e interrompe a finalização", async ({ page, request }) => {
  const { antigo } = await abrirAntigo(page, request);
  const botao = antigo.getByRole("button", { name: BOTAO_FINALIZAR, exact: true });
  const cancelar = antigo.locator("[data-sebrae-cancelar-finalizar]");
  await expect(cancelar).toBeHidden();
  await descreverChamado(antigo);
  await completarCampos(antigo);
  await botao.click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(cancelar).toBeVisible();
  await expect(cancelar).toHaveText("Cancelar");
  const posicaoBotao = await botao.boundingBox();
  const posicaoCancelar = await cancelar.boundingBox();
  if (page.viewportSize().width >= 768) expect(posicaoCancelar.x).toBeGreaterThan(posicaoBotao.x); // à direita do Finalizar
  else { // abaixo de 768px os botões ocupam a largura toda, empilhados com o Finalizar por último (ao alcance do polegar)
    expect(posicaoCancelar.y).toBeLessThan(posicaoBotao.y);
    expect(Math.abs(posicaoCancelar.x - posicaoBotao.x)).toBeLessThan(1);
  }
  await cancelar.click();
  await expect(antigo.locator(".sebrae-chamado__resultado")).toContainText("Finalização cancelada.", { timeout: 10000 });
  await expect(cancelar).toBeHidden();
  await expect(botao).toBeEnabled(); // pode tentar de novo
});

test("Status FINALIZADO fica verde e volta ao normal em EM ABERTO", async ({ page, request }) => {
  const { antigo } = await abrirAntigo(page, request);
  const status = antigo.locator('[data-sebrae-campo="D"]');
  await expect(status).not.toHaveClass(/sebrae-status--finalizado/);
  await status.selectOption("FINALIZADO");
  await expect(status).toHaveClass(/sebrae-status--finalizado/);
  await status.selectOption("EM ABERTO");
  await expect(status).not.toHaveClass(/sebrae-status--finalizado/);
});

test("o horário do SoftExpert substitui o Encerramento (R) manual e o resultado traz título e solicitante", async ({ page, request }) => {
  const { painel, antigo } = await abrirAntigo(page, request);
  await descreverChamado(antigo);
  await completarCampos(antigo); // R manual 27/10/2026 09:00
  await expect(antigo.locator('[data-sebrae-campo="R"]')).toHaveValue("2026-10-27T09:00");
  await antigo.getByRole("button", { name: BOTAO_FINALIZAR, exact: true }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  const cartao = painel.locator('#sebrae-finalizados-lista details.sebrae-finalizado[data-numero="UTIC-2026-1200"]');
  await expect(cartao.locator("> summary")).toContainText("UTIC-2026-1200 · Teclado sem resposta · Camila Vitoria Lopes de Oliveira", { timeout: 10000 });
  await painel.locator("#sebrae-aba-finalizados").click();
  await cartao.locator("> summary").click();
  await expect(cartao.locator('[data-sebrae-campo="R"]')).toHaveValue("28/10/2026 10:10"); // horário do SoftExpert, não o manual 09:00
});

test("finalizar sem Encerramento (R) manual não é bloqueado", async ({ page, request }) => {
  const { antigo } = await abrirAntigo(page, request);
  await descreverChamado(antigo);
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO"); // R continua vazio
  await antigo.getByRole("button", { name: BOTAO_FINALIZAR, exact: true }).click();
  await expect(page.locator("#modal-confirmar-acao")).toBeVisible();
  await page.locator("#btn-confirmar-acao-cancelar").click();
});

test("Atualizar Dashboard confirma, finaliza em massa e mostra o resultado por chamado", async ({ page, request }) => {
  const { painel, antigo } = await abrirAntigo(page, request);
  await descreverChamado(antigo);
  await completarCampos(antigo);
  await painel.locator("#btn-sebrae-atualizar").click();
  const modal = page.locator("#modal-confirmar-acao");
  await expect(modal).toBeVisible();
  await expect(modal.locator("#mensagem-confirmar-acao")).toContainText("UTIC-2026-1200");
  await expect(modal.locator("#mensagem-confirmar-acao")).toContainText("não tem volta");
  await expect(modal.locator("#btn-confirmar-acao-ok")).toHaveText("Atualizar e finalizar");
  const envio = page.waitForRequest(r => r.method() === "POST" && r.url().endsWith("/api/sebrae/dashboard/atualizar"));
  const [download] = await Promise.all([page.waitForEvent("download"), modal.locator("#btn-confirmar-acao-ok").click()]);
  const corpoEnvio = (await envio).postDataJSON();
  expect(corpoEnvio.finalizar_softexpert).toBe(true);
  expect(corpoEnvio.enviar_sharepoint).toBe(true);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  await expect(painel.locator("#sebrae-fechar-status")).toContainText("Finalizando no SoftExpert");
  const cartao = painel.locator('#sebrae-finalizados-lista details.sebrae-finalizado[data-numero="UTIC-2026-1200"]');
  await expect(cartao.locator("> summary")).toContainText("UTIC-2026-1200 · Teclado sem resposta · Camila Vitoria Lopes de Oliveira", { timeout: 10000 });
  await expect(painel.getByText("Finalização no SoftExpert terminada")).toHaveCount(0); // o cartão finalizado substitui o texto e a linha de resultado
  await expect(painel.locator("#sebrae-fechar-lista li")).toHaveCount(0);
  await expect(painel.locator("#sebrae-antigos-lista .sebrae-chamado")).toHaveCount(0);
  await expect(painel.locator("#sebrae-sharepoint-aviso")).toBeHidden();
});

test("Atualizar sem finalizar e Esc só atualizam e baixam: não finalizam nem enviam ao SharePoint", async ({ page, request }) => {
  const { painel, antigo } = await abrirAntigo(page, request);
  await descreverChamado(antigo);
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  const envios = [];
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/sebrae/dashboard/atualizar")) envios.push(r.postDataJSON()); });
  const modal = page.locator("#modal-confirmar-acao");
  await painel.locator("#btn-sebrae-atualizar").click();
  await expect(modal.locator("#btn-confirmar-acao-ok")).toHaveText("Atualizar e finalizar");
  await expect(modal.locator("#btn-confirmar-acao-cancelar")).toHaveText("Atualizar sem finalizar");
  await expect(modal.locator("#mensagem-confirmar-acao")).toContainText("NÃO finaliza no SoftExpert nem envia ao SharePoint");
  const [download] = await Promise.all([page.waitForEvent("download"), modal.locator("#btn-confirmar-acao-cancelar").click()]);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  await expect(modal).toBeHidden();
  await expect(painel.locator("#sebrae-atualizar-status")).toContainText("nenhum chamado foi finalizado no SoftExpert");
  await expect(page.locator(TOAST).filter({ hasText: "Dashboard atualizado. Use Enviar ao SharePoint para sobrepor o arquivo." }).last()).toBeVisible();
  await expect(painel.locator("#sebrae-fechar-status")).toContainText("não confirmada");
  await expect(painel.locator("#btn-sebrae-atualizar")).toBeEnabled();
  expect(envios).toHaveLength(1);
  expect(envios[0].finalizar_softexpert).toBe(false);
  expect(envios[0].enviar_sharepoint).toBe(false); // D FINALIZADO sem SoftExpert nunca vai ao SharePoint por este clique
  await painel.locator("#btn-sebrae-atualizar").click(); // Esc também nunca finaliza nem envia
  await expect(modal).toBeVisible();
  const [segundo] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Escape")]);
  expect(segundo.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  expect(envios).toHaveLength(2);
  expect(envios[1].finalizar_softexpert).toBe(false);
  expect(envios[1].enviar_sharepoint).toBe(false);
});

test("chamado FINALIZADO sem descrição é pulado; o envio ao SharePoint pede confirmação e Esc só atualiza", async ({ page, request }) => {
  const { painel, antigo } = await abrirAntigo(page, request);
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  const envios = [];
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/sebrae/dashboard/atualizar")) envios.push(r.postDataJSON()); });
  const modal = page.locator("#modal-confirmar-acao");
  await painel.locator("#btn-sebrae-atualizar").click(); // Esc: atualiza sem finalizar nem enviar
  await expect(modal.locator("#btn-confirmar-acao-ok")).toHaveText("Atualizar e enviar");
  await expect(modal.locator("#btn-confirmar-acao-cancelar")).toHaveText("Atualizar sem enviar");
  await expect(modal.locator("#mensagem-confirmar-acao")).toContainText("sem serem finalizados no SoftExpert");
  const [primeiro] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Escape")]);
  expect(primeiro.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  expect(envios).toHaveLength(1);
  expect(envios[0].finalizar_softexpert).toBe(false);
  expect(envios[0].enviar_sharepoint).toBe(false);
  await painel.locator("#btn-sebrae-atualizar").click(); // confirmar: atualiza e envia, sem finalizar
  await expect(modal).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), modal.locator("#btn-confirmar-acao-ok").click()]);
  expect(download.suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
  expect(envios).toHaveLength(2);
  expect(envios[1].finalizar_softexpert).toBe(false);
  expect(envios[1].enviar_sharepoint).toBe(true);
  await expect(modal).toBeHidden();
  await expect(painel.locator("#sebrae-atualizar-status")).toContainText("Não serão finalizados no SoftExpert: UTIC-2026-1200 (sem descrição para finalizar).");
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
  await completarCampos(antigo);
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
  await completarCampos(antigo);
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
  await painel.locator("#sebrae-aba-antigos").click();
  await abrirItemAntigo(painel.locator("#sebrae-antigos-lista .sebrae-chamado"));
  await painel.locator("#sebrae-antigos-lista .sebrae-chamado").locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  const posts = [];
  page.on("request", r => { if (r.method() === "POST") posts.push(r.url()); });
  await page.reload(); // a "internet caiu": nada passou por Atualizar Dashboard
  const { painel: depois } = await abrirPainel(page, request);
  const novo = depois.locator("#sebrae-novos-lista .sebrae-chamado").first();
  await expect(novo.locator('[data-sebrae-campo="A"]')).toHaveValue("CLIENTE");
  await expect(novo.locator('[data-sebrae-campo="J"]')).toHaveValue("INCIDENTE");
  await expect(depois.locator("#sebrae-rascunho-status")).toContainText("Rascunho restaurado");
  await depois.locator("#sebrae-aba-antigos").click();
  await expect(depois.locator("#sebrae-antigos-lista details.sebrae-antigo")).not.toHaveJSProperty("open", true); // restaurar o rascunho não reabre o antigo
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

// Ler chamados antigos: botão próprio (rotina `antigos`); a fixture simula POST/GET /api/sebrae/antigos/ler (1.º GET andando, 2.º concluído).
test("Ler chamados antigos dispara o POST, mostra andamento e resultado e o antigo passa a ter a leitura do SoftExpert", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request, "", "leitura"); // o botão mora no topo do painel Chamados (F5), não no cartão da Automação (F4)
  const botao = painel.locator("#btn-sebrae-ler-antigos");
  const status = painel.locator("#sebrae-antigos-leitura-status");
  await expect(botao).toHaveText("Ler chamados antigos");
  await expect(botao).toBeEnabled();
  const posts = [];
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/sebrae/antigos/ler")) posts.push(r.url()); });
  await botao.click();
  await expect(status).toContainText("Lendo chamados antigos no SoftExpert");
  await expect(page.locator("#btn-automacao-cancelar")).toBeEnabled(); // o Cancelar execução da Automação vale para esta rotina
  await expect(status).toContainText("1 lido(s), 0 com falha, 1 já lido(s) antes, 1 sem UTIC (não dá para ler).", { timeout: 10000 });
  expect(posts).toHaveLength(1);
  await expect(page.locator(TOAST).filter({ hasText: "Leitura dos antigos: 1 lido(s)" })).toHaveAttribute("data-status", "ok");
  await abrirSecaoAntigos(painel); // a lista recarregou com a leitura e os antigos voltam recolhidos
  const lido = painel.locator('#sebrae-antigos-lista .sebrae-chamado[data-numero="UTIC-2026-1211"]');
  await expect(lido.locator(".sebrae-chamado__assunto")).toHaveText("Notebook não liga");
  await expect(painel.locator('#sebrae-antigos-lista details.sebrae-antigo:has(.sebrae-chamado[data-numero="UTIC-2026-1211"]) > summary .sebrae-selo:not(.sebrae-selo--auto):not(.sebrae-selo-obs)')).toHaveText("Lido"); // agora lido: o selo do resumo muda
  await expect(lido.locator("[data-leitura='pendente']")).toHaveCount(0);
  await expect(lido.locator(".sebrae-chamado__auto")).toContainText("Diego Martins Costa");
});

test("antigo lido mostra título, solicitante, abertura, descrição e atendimento do SoftExpert; sem leitura, só a dica", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request, "", "leitura");
  await painel.locator("#sebrae-aba-antigos").click();
  const lista = painel.locator("#sebrae-antigos-lista");
  const lido = lista.locator('.sebrae-chamado[data-numero="UTIC-2026-1210"]');
  const resumoDe = numero => lista.locator(`details.sebrae-antigo:has(.sebrae-chamado[data-numero="${numero}"]) > summary.sebrae-antigo__resumo`);
  const seloLeitura = numero => resumoDe(numero).locator(".sebrae-selo:not(.sebrae-selo--auto):not(.sebrae-selo-obs)");
  await expect(resumoDe("UTIC-2026-1210")).toContainText("UTIC-2026-1210");
  await expect(resumoDe("UTIC-2026-1210")).toContainText("Monitor sem imagem");
  await expect(resumoDe("UTIC-2026-1210")).toContainText("Bruna Alves Teixeira");
  await expect(seloLeitura("UTIC-2026-1210")).toHaveText("Lido");
  await abrirItemAntigo(lido);
  await expect(lido.locator(".sebrae-chamado__assunto")).toHaveText("Monitor sem imagem"); // o Dashboard não trouxe título
  await expect(lido.locator(".sebrae-chamado__auto")).toContainText("Bruna Alves Teixeira");
  await expect(lido.locator(".sebrae-chamado__auto")).toContainText("20/10/2026 09:15");
  await expect(lido.locator(".sebrae-chamado__auto")).toContainText("Londrina (será preenchido)");
  const descricao = lido.locator("details.sebrae-chamado__texto").filter({ hasText: "Descrição" }).first();
  await descricao.locator("summary").click();
  await expect(descricao.locator("p")).toHaveText("O monitor da sala 3 ficou sem imagem.");
  const atendimento = lido.locator("details.sebrae-chamado__texto").filter({ hasText: "Atendimento realizado" });
  await atendimento.locator("summary").click();
  await expect(atendimento.locator("p")).toHaveText("Cabo HDMI trocado <b>hoje</b>."); // texto escapado, nunca HTML
  await expect(atendimento.locator("b")).toHaveCount(0);
  const naoLido = lista.locator('.sebrae-chamado[data-numero="UTIC-2026-1211"]');
  await expect(seloLeitura("UTIC-2026-1211")).toHaveText("Não lido");
  await expect(naoLido.locator(".sebrae-chamado__assunto")).toHaveText("Sem título");
  await expect(naoLido.locator("[data-leitura='pendente']")).toContainText("Ler chamados antigos");
  await expect(naoLido.locator("details.sebrae-chamado__texto")).toHaveCount(1); // só a Descrição (H do Dashboard, com lápis desde 11/11/2026); sem Atendimento sem leitura
  await expect(naoLido.locator("details.sebrae-chamado__texto").filter({ hasText: "Atendimento realizado" })).toHaveCount(0);
  await abrirItemAntigo(naoLido); // o botão só entra na árvore de acessibilidade com o item aberto
  await expect(naoLido.getByRole("button", { name: "Editar descrição de UTIC-2026-1211" })).toBeVisible();
  const semUtic = lista.locator('.sebrae-chamado[data-numero="linha:27"]'); // sem UTIC não há leitura: nada é prometido
  await expect(semUtic.locator("[data-sebrae-editar-descricao]")).toHaveCount(0); // sem UTIC não há lápis
  await expect(seloLeitura("linha:27")).toHaveCount(0);
  await expect(semUtic.locator(".sebrae-chamado__assunto")).toHaveText("Impressora offline");
  await expect(semUtic.locator("[data-leitura='pendente']")).toHaveCount(0);
});

test("antigo não encontrado no SoftExpert na última leitura fica vermelho, com selo e aviso para conferir depois", async ({ page, request }) => {
  await page.route("**/api/sebrae/novos", async rota => {
    const resposta = await rota.fetch();
    const corpo = await resposta.json();
    corpo.importado.abertos.forEach(a => { if (a.numero === "UTIC-2026-1211") a.nao_encontrado_softexpert = true; });
    await rota.fulfill({ response: resposta, json: corpo });
  });
  const { painel } = await abrirPainel(page, request, "", "leitura");
  await painel.locator("#sebrae-aba-antigos").click();
  const lista = painel.locator("#sebrae-antigos-lista");
  const linha = numero => lista.locator(`details.sebrae-antigo:has(.sebrae-chamado[data-numero="${numero}"])`);
  const vermelho = await linha("UTIC-2026-1211").evaluate(no => getComputedStyle(no).borderLeftWidth);
  expect(vermelho).toBe("4px");
  await expect(linha("UTIC-2026-1211").locator("> summary .sebrae-selo:not(.sebrae-selo--auto):not(.sebrae-selo-obs)")).toHaveText("Não encontrado");
  await expect(linha("UTIC-2026-1211").locator("> summary .sebrae-selo:not(.sebrae-selo--auto):not(.sebrae-selo-obs)")).toHaveAttribute("data-status", "erro");
  const cartao = lista.locator('.sebrae-chamado[data-numero="UTIC-2026-1211"]');
  await abrirItemAntigo(cartao);
  await expect(cartao.locator("[data-leitura='nao_encontrado']")).toContainText("pode ter sido finalizado por outro técnico");
  await expect(cartao.locator("[data-leitura='pendente']")).toHaveCount(0);
  expect(await linha("UTIC-2026-1210").evaluate(no => getComputedStyle(no).borderLeftWidth)).toBe("1px"); // o lido segue normal
});

test("o lápis da Descrição do antigo lido edita o texto (vai à coluna H em Atualizar Dashboard) e Restaurar original volta ao lido",async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request, "", "leitura");
  await painel.locator("#sebrae-aba-antigos").click();
  const lido = painel.locator('#sebrae-antigos-lista .sebrae-chamado[data-numero="UTIC-2026-1210"]');
  await abrirItemAntigo(lido);
  const descricao = lido.locator("details.sebrae-chamado__texto").filter({ hasText: "Descrição" }).first();
  const lapis = lido.getByRole("button", { name: "Editar descrição de UTIC-2026-1210" });
  await lapis.click();
  await expect(descricao).toHaveJSProperty("open", true); // o lápis abre o bloco, não fecha
  await expect(lapis).toHaveAttribute("aria-expanded", "true");
  const campo = descricao.locator("textarea[data-sebrae-descricao-editada]");
  await expect(campo).toHaveValue("O monitor da sala 3 ficou sem imagem.");
  await campo.fill("O monitor da sala 3 ficou sem imagem. Cliente pediu troca do cabo.");
  await descricao.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(descricao.getByRole("status")).toHaveText("Descrição salva. Vai à coluna H do Dashboard em Atualizar Dashboard; o SoftExpert não recebe esse texto.");
  await expect(descricao.locator("p").first()).toHaveText("O monitor da sala 3 ficou sem imagem. Cliente pediu troca do cabo.");
  await expect(descricao.locator(".sebrae-descricao__selo")).toBeVisible();
  await lapis.click();
  await descricao.getByRole("button", { name: "Restaurar original" }).click();
  await expect(descricao.getByRole("status")).toHaveText("Descrição original restaurada neste site. Um H já enviado ao Dashboard não é desfeito.");
  await expect(descricao.locator("p").first()).toHaveText("O monitor da sala 3 ficou sem imagem.");
  await expect(descricao.locator(".sebrae-descricao__selo")).toBeHidden();
  await expect(lido.getByLabel("Descrição para Finalizar o Chamado")).toHaveValue(""); // a descrição de finalização é outro campo e não mudou
});

test("Ler chamados antigos com outra rotina em andamento (409) vira aviso e não acompanha nada", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request, "", "conflito");
  await painel.locator("#btn-sebrae-ler-antigos").click();
  await expect(page.locator(TOAST).filter({ hasText: "Já há uma rotina em andamento" })).toHaveAttribute("data-status", "alerta");
  await expect(painel.locator("#sebrae-antigos-leitura-status")).toContainText("Já há uma rotina em andamento");
  await expect(painel.locator("#btn-sebrae-ler-antigos")).not.toHaveAttribute("aria-busy", "true");
});

// ---- Redesenho visual do painel Chamados (01/11/2026): zonas, pendências, selos e lista vazia; só apresentação ----

test("o cartão tem três zonas e as pendências acendem ao escolher A, D FINALIZADO, J e digitar a descrição", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request);
  const novo = painel.locator("#sebrae-novos-lista .sebrae-chamado").first();
  await expect(novo.locator(".sebrae-zona__titulo")).toHaveText(["Solicitação", "Classificação operacional", "Finalização no SoftExpert"]);
  await expect(novo.locator(".sebrae-zona__selo")).toHaveText(["Somente leitura", "Preenchimento manual", "Irreversível"]);
  await expect(novo.locator(".sebrae-zona--finalizacao .sebrae-zona__aviso")).toHaveText("Finalizar não tem volta: o chamado será encerrado no SoftExpert com a descrição informada.");
  await expect(novo.locator(".sebrae-pendencias__rotulo")).toHaveText("Para finalizar:");
  await expect(novo.locator("li.sebrae-pend[data-req]")).toHaveCount(4);
  await expect(novo.locator(".sebrae-pend--opcional")).toHaveText("Encerramento (R): opcional");
  // Quem decide pendente/ok é o CSS (:has nos campos); o ícone visível de cada requisito troca de "falta" para "ok".
  const ok = req => novo.locator(`li.sebrae-pend[data-req="${req}"] svg.sebrae-pend__ok`);
  const falta = req => novo.locator(`li.sebrae-pend[data-req="${req}"] svg.sebrae-pend__falta`);
  const situacao = async (req, cumprido) => {
    await (cumprido ? expect(ok(req)).toBeVisible() : expect(ok(req)).toBeHidden());
    await (cumprido ? expect(falta(req)).toBeHidden() : expect(falta(req)).toBeVisible());
  };
  await situacao("A", false); await situacao("D", false); await situacao("J", false); await situacao("DESC", false); // D vem EM ABERTO nos novos
  await novo.locator('[data-sebrae-campo="A"]').selectOption("CLIENTE");
  await situacao("A", true); await situacao("D", false); await situacao("J", false); await situacao("DESC", false);
  await novo.locator('[data-sebrae-campo="J"]').selectOption("INCIDENTE");
  await situacao("J", true); await situacao("D", false); await situacao("DESC", false);
  await novo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await situacao("D", true); await situacao("DESC", false);
  const descricao = novo.getByLabel(ROTULO_DESCRICAO);
  const feedback = novo.locator(".sebrae-chamado__feedback").first();
  await descricao.fill("Troquei o teclado.");
  await situacao("DESC", true);
  await expect(feedback).toHaveText("Alteração ainda não salva…");
  await expect(feedback).toHaveAttribute("data-estado", "pendente");
  // (a fixture só grava a descrição dos antigos; o "ok" do feedback é conferido nos testes dos antigos.)
  // Desfazer volta a pendência (nenhum estado fica guardado no JS).
  await novo.locator('[data-sebrae-campo="D"]').selectOption("EM ABERTO");
  await situacao("D", false);
  await descricao.fill("");
  await situacao("DESC", false);
  await novo.locator('[data-sebrae-campo="A"]').selectOption("");
  await situacao("A", false);
  await situacao("J", true); // J continua escolhido
});

test("o antigo nasce recolhido e o resumo acende D: FINALIZADO e Pronto para finalizar sozinho", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request);
  await painel.locator("#sebrae-aba-antigos").click();
  const item = painel.locator("#sebrae-antigos-lista details.sebrae-antigo");
  await expect(item).toHaveCount(1);
  await expect(item).not.toHaveJSProperty("open", true);
  const resumo = item.locator("> summary.sebrae-antigo__resumo");
  await expect(resumo).toContainText("UTIC-2026-1200");
  const selo = sufixo => resumo.locator(`.sebrae-selo--${sufixo}`);
  for (const sufixo of ["d", "pronto", "andamento", "atencao", "erro"]) await expect(selo(sufixo)).toBeHidden(); // escondidos por padrão
  const antigo = item.locator(".sebrae-chamado");
  await expect(antigo).toBeHidden(); // recolhido: o cartão não aparece
  await resumo.click();
  await expect(antigo).toBeVisible();
  // aberto, o cartão substitui a linha (o resumo some); os selos são conferidos com a linha recolhida por `Recolher chamado`
  const recolher = item.getByRole("button", { name: "Recolher chamado" });
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("FINALIZADO");
  await recolher.click();
  await expect(antigo).toBeHidden();
  await expect(selo("d")).toBeVisible();
  await expect(selo("d")).toHaveText("D: FINALIZADO");
  await expect(selo("pronto")).toBeHidden(); // falta a descrição (A e J já vêm preenchidos)
  await resumo.click();
  await antigo.getByLabel(ROTULO_DESCRICAO).fill("Troquei o teclado.");
  await recolher.click(); // recolhido, o selo continua no resumo
  await expect(antigo).toBeHidden();
  await expect(selo("pronto")).toBeVisible();
  await expect(selo("pronto")).toHaveText("Pronto para finalizar");
  await expect(selo("d")).toBeHidden(); // as quatro condições valem: o selo "pronto" ocupa o lugar
  await resumo.click();
  await antigo.locator('[data-sebrae-campo="D"]').selectOption("EM ABERTO");
  await recolher.click();
  await expect(selo("pronto")).toBeHidden();
  await expect(selo("d")).toBeHidden();
});

test("Chamados novos mostra o carregamento (aria-busy) e, vazio, o texto gerado por CSS", async ({ page, request }) => {
  await request.get("/__fixture_automacao?quantidade=0&sebrae=padrao&run=&antigos=");
  let liberar;
  const portao = new Promise(resolver => { liberar = resolver; });
  await page.route("**/api/sebrae/novos", async rota => {
    const resposta = await rota.fetch();
    const corpo = await resposta.json();
    await portao;
    await rota.fulfill({ response: resposta, json: { ...corpo, novos: { ...corpo.novos, formulario: [] } } });
  });
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  await abrirChamadosPelaNavegacao(page);
  const lista = page.locator('[data-cockpit-tool-panel="sebrae-chamados"] #sebrae-novos-lista');
  await expect(lista).toBeVisible();
  await expect(lista).toHaveAttribute("aria-busy", "true");
  const pseudo = (nome) => lista.evaluate((no, alvo) => getComputedStyle(no, alvo).content, nome);
  expect(await pseudo("::before")).not.toContain("Nenhum chamado novo"); // ocupado: esqueleto, sem o texto de vazio
  liberar();
  await expect(lista).not.toHaveAttribute("aria-busy", /.*/);
  await expect(lista).toBeEmpty();
  expect(await pseudo("::before")).toBe('"Nenhum chamado novo na lista."');
  expect(await pseudo("::after")).toBe('"A importação do Dashboard e a busca ficam na aba Automação (F4)."');
});

// Destaque manual (nov/2026): a fixture não guarda observações; as rotas são simuladas aqui, com estado em memória.
async function simularDestaques(page, inicial = {}) {
  const observacoes = { ...inicial };
  await page.route("**/api/sebrae/observacoes", rota => rota.fulfill({ json: { observacoes } }));
  await page.route("**/api/sebrae/chamados/*/destaque", async rota => {
    const numero = decodeURIComponent(new URL(rota.request().url()).pathname.split("/")[4]);
    const ligado = rota.request().postDataJSON().destaque;
    if (ligado) observacoes[numero] = { observacao: "", atualizado_em: null, destaque: true, destaque_em: "2026-11-05T09:00:00-03:00" };
    else delete observacoes[numero];
    await rota.fulfill({ json: { numero, destaque: ligado, destaque_em: ligado ? "2026-11-05T09:00:00-03:00" : null } });
  });
  return observacoes;
}
const focoAtual = page => page.evaluate(() => { const no = document.activeElement; return { tag: no.tagName, id: no.id, texto: (no.textContent || "").trim().slice(0, 60) }; });

test("destaque: marcar e tirar anuncia o resultado, acende e apaga a aba Destaques e devolve o foco à aba (original em outra aba)", async ({ page, request }) => {
  await simularDestaques(page);
  const { painel } = await abrirPainel(page, request);
  const abaDestaques = painel.locator("#sebrae-aba-destaques");
  const contagem = painel.locator("#sebrae-destaques-contagem");
  await expect(abaDestaques).toHaveAttribute("data-zero", "");
  await painel.locator("#sebrae-aba-finalizados").click();
  const original = painel.locator('#sebrae-finalizados-lista .sebrae-chamado[data-numero="UTIC-2026-1100"]');
  const itemFinalizado = original.locator("xpath=ancestor::details[1]");
  await abrirItemAntigo(original); // o mesmo helper serve ao details interno do finalizado
  await original.locator("[data-sebrae-destaque]").click();
  await expect(painel.locator("#sebrae-destaque-anuncio")).toHaveText("Destaque marcado.");
  await expect(contagem).toHaveText("1");
  await expect(contagem).toHaveAttribute("data-status", "alerta");
  await expect(abaDestaques).not.toHaveAttribute("data-zero", /.*/);
  await itemFinalizado.getByRole("button", { name: "Recolher chamado" }).click(); // recolhe o item original: o cartão passa a morar num details fechado
  await expect(itemFinalizado).not.toHaveJSProperty("open", true);
  await abaDestaques.click();
  const daSecao = painel.locator('#sebrae-destaques-lista [data-sebrae-destaque="UTIC-2026-1100"]');
  await daSecao.focus();
  await daSecao.click();
  await expect(painel.locator("#sebrae-destaque-anuncio")).toHaveText("Destaque removido.");
  await expect(abaDestaques).toHaveAttribute("data-zero", "");
  await expect(contagem).not.toHaveAttribute("data-status", /.*/);
  const foco = await focoAtual(page);
  expect(foco.tag).not.toBe("BODY");
  const naoPerdeu = await page.evaluate(() => { const no = document.activeElement; return no !== document.body && no.getClientRects().length > 0; });
  expect(naoPerdeu).toBe(true); // o foco está num elemento visível
  await expect(abaDestaques).toBeFocused(); // o original está num painel escondido: o foco vai à aba
});

test("destaque: último destaque só no servidor (sem cartão original) leva o foco à aba Destaques", async ({ page, request }) => {
  await simularDestaques(page, { "UTIC-2026-0999": { observacao: "Antiga.", atualizado_em: "2026-10-01T08:00:00-03:00", destaque: true, destaque_em: "2026-11-01T10:00:00-03:00" } });
  const { painel } = await abrirPainel(page, request);
  await painel.locator("#sebrae-aba-destaques").click();
  const botao = painel.locator('#sebrae-destaques-lista [data-sebrae-destaque="UTIC-2026-0999"]');
  await expect(botao).toBeVisible();
  await botao.focus();
  await botao.click();
  await expect(painel.locator("#sebrae-destaque-anuncio")).toHaveText("Destaque removido.");
  await expect(painel.locator("#sebrae-aba-destaques")).toHaveAttribute("data-zero", "");
  await expect(painel.locator("#sebrae-aba-destaques")).toBeFocused();
});

// Sub-abas e filtro do F5 (07/11/2026): só apresentação e navegação.
test("F5 abre em Novos, lembra a aba ao voltar do F4, volta a Novos ao recarregar e a lupa filtra", async ({ page, request }) => {
  const { painel } = await abrirPainel(page, request);
  const aba = nome => painel.locator(`#sebrae-aba-${nome}`);
  await expect(aba("novos")).toHaveAttribute("aria-selected", "true");
  await expect(painel.locator("#sebrae-novos")).toBeVisible();
  await aba("antigos").click();
  await expect(aba("antigos")).toHaveAttribute("aria-selected", "true");
  await page.locator("#tab-automacao").click(); // F4
  await expect(page.locator("#sebrae-novos-painel")).toBeVisible();
  await abrirChamadosPelaNavegacao(page); // de volta ao F5
  await expect(painel).toBeVisible();
  await expect(aba("antigos")).toHaveAttribute("aria-selected", "true");
  await expect(painel.locator("#sebrae-antigos")).toBeVisible();
  await painel.locator("#btn-sebrae-filtro").click();
  await expect(painel.locator("#sebrae-filtro-termo")).toBeFocused();
  await painel.locator("#sebrae-filtro-termo").fill("UTIC-2026-1200");
  await expect(painel.locator("#sebrae-filtro-resultado")).toContainText("chamado(s) encontrado(s)");
  await expect(painel.locator("#sebrae-filtro-resultado")).toBeVisible();
  await page.reload();
  await page.locator("#tab-automacao").click();
  await abrirChamadosPelaNavegacao(page);
  await expect(aba("novos")).toHaveAttribute("aria-selected", "true"); // recarregar a página volta a Novos
});

test("no celular (390px) as quatro abas cabem na tela, sem rolagem horizontal", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { painel } = await abrirPainel(page, request);
  for (const nome of ["novos", "antigos", "destaques", "finalizados"]) {
    const caixa = await painel.locator(`#sebrae-aba-${nome}`).boundingBox();
    expect(caixa, nome).not.toBeNull();
    expect(caixa.x, nome).toBeGreaterThanOrEqual(0);
    expect(caixa.x + caixa.width, nome).toBeLessThanOrEqual(390);
  }
  expect(await painel.locator(".sebrae-abas").evaluate(no => no.scrollWidth <= no.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
