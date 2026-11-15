// Migração React, Dia 2, grupo G5 (Resumo e comparação): diálogo "Relatório mensal" e sub-aba Backups do Resumo (F3).
// Escrito e com baseline de screenshots gravado com os módulos antigos (JS puro), antes da troca para React:
// a versão em React tem de sair igual nos dois tamanhos (390 e 1366 px) e nos dois temas, com o mesmo comportamento.
// Dados só sintéticos: séries TST*, apelidos "Estacao Teste N".
const { test, expect } = require("@playwright/test");

// As datas da tela saem no fuso do navegador: fixo, para o baseline não depender da máquina.
test.use({ timezoneId: "America/Sao_Paulo" });

const PAINEL = "#resumo-painel-backups";
const CONTEUDO = "#comparacao-planilhas-conteudo";
const SELO_ABA = "#resumo-backups-contagem";
const APELIDO = "Estacao Teste";

async function zerarFixture(request) {
  await request.get("/__fixture_cockpit?comparacao=0");
  await request.get("/__fixture_alertas_painel?estado=ocultos");
  await request.get("/__fixture_base_desatualizada?estado=atualizada");
  await request.get("/__fixture_backups?estado=padrao");
}

test.beforeEach(({ request }) => zerarFixture(request));
test.afterEach(({ request }) => zerarFixture(request));

async function prepararPagina(page, tema) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
}

// Troca só o campo `backups_regionais` da resposta da fixture (os outros cartões também leem /api/painel).
async function rotaBackups(page, backups) {
  await page.route("**/api/painel", async route => {
    const resposta = await route.fetch();
    await route.fulfill({ response: resposta, json: { ...(await resposta.json()), backups_regionais: backups } });
  });
}

async function abrirBackups(page) {
  await page.goto("/");
  await page.locator("#btn-resumo-aba").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Resumo");
  await expect(page.locator(CONTEUDO)).toHaveAttribute("data-estado", /^(pronto|vazio|erro)$/);
  await expect(page.locator("#resumo-regionais")).toHaveAttribute("data-estado", /^(pronto|erro)$/);
  await expect(page.locator("#cockpit-comparison-status")).not.toContainText("Carregando");
  await page.locator("#resumo-aba-backups").click();
  await expect(page.locator("#resumo-aba-backups")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(PAINEL)).toBeVisible();
  // O brilho do bento segue o ponteiro (--mx/--my): o mouse fica fora dos cartões.
  await page.mouse.move(0, 0);
}

const linha = (page, cidade) => page.locator(`${PAINEL} tbody tr`).filter({ has: page.locator(".ck-backups__cidade", { hasText: cidade }) });
const botaoConfirmar = (page, serie, cidade) => page.getByRole("button", { name: `Confirmar disponível por 7 dias: série ${serie}, ${cidade}` });
const botaoDesfazer = (page, serie, cidade) => page.getByRole("button", { name: `Desfazer confirmação: série ${serie}, ${cidade}` });

// Painel com datas fixas e todos os casos do desenho: os quatro status (e um desconhecido), excedente, motivo desconhecido,
// confirmação invalidada, conferência com Desfazer, excluídos, sobras dentro e fora das prioritárias, candidatos das demais
// regionais e limitações.
const BACKUPS_FIXOS = {
  gerado_em: "2026-10-25T09:00:00-03:00",
  minimo: 1,
  limitacoes: ["Cobertura ilegível: reservas e movimentações não conferidas."],
  pendencias: { sem_backup: ["Cascavel"], conferir: ["Londrina"] },
  prioritarias: [
    { cidade: "Cascavel", status: "sem_backup", contados: 0, minimo: 1, excedente: 0, backups: [], candidatos: [], conferencia: [],
      excluidos: [{ serie: "TSTG50005", motivo: "usuario_vigente" }, { serie: "TSTG50010", apelido: "Estacao Teste 10", motivo: "bloqueio:manutencao" }] },
    { cidade: "Londrina", status: "conferir", contados: 0, minimo: 1, excedente: 0, backups: [],
      candidatos: [
        { serie: "TSTG50001", apelido: "Estacao Teste 1", motivo: "sem_verificacao_7_dias", dias_sem_verificacao: 9, ultima_verificacao: "2026-10-16T10:00:00-03:00",
          confirmacao: { estado: "invalidada", motivo: "expirada" } },
        { serie: "TSTG50011", apelido: "", motivo: "motivo_novo_do_servidor", dias_sem_verificacao: 1, ultima_verificacao: null, confirmacao: null },
      ],
      conferencia: [{ serie: "TSTG50002", apelido: "Estacao Teste 2", motivo: "cidade_divergente", confirmacao: { estado: "vigente" } }],
      excluidos: [] },
    { cidade: "Pato Branco", status: "ok", contados: 2, minimo: 1, excedente: 1,
      backups: [
        { serie: "TSTG50003", apelido: "Estacao Teste 3", origem: "marca", ultima_verificacao: "2026-10-23T08:30:00-03:00", confirmado_ate: null },
        { serie: "TSTG50004", apelido: "Estacao Teste 4", origem: "confirmacao", ultima_verificacao: null, confirmado_ate: "2026-10-30T09:00:00-03:00" },
      ],
      candidatos: [], conferencia: [], excluidos: [] },
    { cidade: "Maringá", status: "dados_insuficientes", contados: 0, minimo: 1, excedente: 0, backups: [], candidatos: [], conferencia: [], excluidos: [] },
    { cidade: "Ponta Grossa", status: "status_novo", contados: 1, minimo: 1, excedente: 0,
      backups: [{ serie: "TSTG50007", apelido: "Estacao Teste 7", origem: "marca", ultima_verificacao: "2026-10-24T14:00:00-03:00", confirmado_ate: "2026-10-31T09:00:00-03:00" }],
      candidatos: [], conferencia: [], excluidos: [] },
  ],
  sobras: [
    { cidade: "Pato Branco", quantidade: 1, series: ["TSTG50004"], itens: [{ serie: "TSTG50004", origem: "confirmacao", confirmado_ate: "2026-10-30T09:00:00-03:00" }], prioritaria: true },
    { cidade: "Curitiba", quantidade: 2, series: ["TSTG50008", "TSTG50009"], prioritaria: false,
      itens: [{ serie: "TSTG50008", origem: "marca", confirmado_ate: null }, { serie: "TSTG50009", origem: "confirmacao", confirmado_ate: "2026-10-29T09:00:00-03:00" }] },
  ],
  outras_candidatos: [
    { cidade: "Foz do Iguaçu", candidatos: [{ serie: "TSTG50012", apelido: "Estacao Teste 12", motivo: "ausente_no_endpoint", dias_sem_verificacao: null, ultima_verificacao: null, confirmacao: null }] },
    { cidade: "Sem candidatos", candidatos: [] },
  ],
};

for (const tema of ["light", "dark"]) {
  test(`baseline: sub-aba Backups com todos os casos, tema ${tema}`, async ({ page }) => {
    await prepararPagina(page, tema);
    await rotaBackups(page, BACKUPS_FIXOS);
    await abrirBackups(page);
    await expect(page.locator(`${PAINEL} tbody tr`)).toHaveCount(5);
    await expect(page.locator(`${PAINEL} .ck-backups__meta`)).toHaveText("Atualizado em 25/10/2026, 09:00:00.");
    await page.locator(`${PAINEL} details[data-cidade="Cascavel"] > summary`).click();
    await expect(page.locator(`${PAINEL} details[data-cidade="Cascavel"]`)).toHaveAttribute("open", "");
    await page.mouse.move(0, 0);
    await expect(page.locator(PAINEL)).toHaveScreenshot(`backups-todos-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });

  test(`baseline: sub-aba Backups com o cálculo indisponível, tema ${tema}`, async ({ page }) => {
    await prepararPagina(page, tema);
    await rotaBackups(page, { indisponivel: true, limitacoes: ["Endpoint fora do ar."] });
    await abrirBackups(page);
    await expect(page.locator(PAINEL)).toContainText("Não foi possível calcular os backups regionais agora.");
    await expect(page.locator(PAINEL)).toHaveScreenshot(`backups-indisponivel-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });

  test(`baseline: diálogo Relatório mensal aberto e com erro, tema ${tema}`, async ({ page }) => {
    await prepararPagina(page, tema);
    await page.clock.setFixedTime(new Date("2026-09-15T12:00:00-03:00"));
    await page.goto("/");
    await page.evaluate(() => window.abrirRelatorioMensal());
    const dialogo = page.locator("#modal-relatorio-mensal .monthly-report-dialog");
    await expect(dialogo).toBeVisible();
    await expect(page.locator("#relatorio-mensal-mes")).toBeFocused();
    await page.locator("#relatorio-mensal-mes").blur();
    await expect(dialogo).toHaveScreenshot(`relatorio-mensal-aberto-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
    await page.locator("#relatorio-mensal-mes").fill("2026-12");
    await page.locator("#btn-exportar-relatorio-mensal").click();
    await expect(page.locator("#status-relatorio-mensal")).toHaveText("Selecione o mês atual ou um mês anterior.");
    await page.locator("#relatorio-mensal-mes").blur();
    await expect(dialogo).toHaveScreenshot(`relatorio-mensal-erro-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}

test.describe("comportamento (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento não depende da largura: roda só no desktop");

  // ---- Relatório mensal ----

  async function abrirRelatorio(page) {
    await page.clock.setFixedTime(new Date("2026-09-15T12:00:00-03:00"));
    await page.goto("/");
    await page.evaluate(() => window.abrirRelatorioMensal());
    await expect(page.locator("#modal-relatorio-mensal")).toBeVisible();
  }

  test("relatório mensal: abrir põe o mês atual, o limite e o foco no campo; Fechar e Esc fecham", async ({ page }) => {
    await abrirRelatorio(page);
    const mes = page.locator("#relatorio-mensal-mes");
    await expect(mes).toHaveValue("2026-09");
    await expect(mes).toHaveAttribute("max", "2026-09");
    await expect(mes).toHaveAttribute("min", "2000-01");
    await expect(mes).toBeFocused();
    await expect(page.locator("#modal-relatorio-mensal > div")).toHaveAttribute("role", "dialog");
    await expect(page.locator("#modal-relatorio-mensal > div")).toHaveAttribute("aria-labelledby", "modal-relatorio-mensal-titulo");
    await expect(page.locator("#status-relatorio-mensal")).toHaveText("");
    await page.getByRole("button", { name: "Fechar relatório mensal" }).click();
    await expect(page.locator("#modal-relatorio-mensal")).toBeHidden();
    // Reabrir com um mês antigo válido mantém o mês; com um mês futuro, volta ao atual.
    await mes.evaluate(campo => { campo.value = "2026-03"; });
    await page.evaluate(() => window.abrirRelatorioMensal());
    await expect(mes).toHaveValue("2026-03");
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-relatorio-mensal")).toBeHidden();
    await mes.evaluate(campo => { campo.value = "2027-01"; });
    await page.evaluate(() => window.abrirRelatorioMensal());
    await expect(mes).toHaveValue("2026-09");
  });

  test("relatório mensal: mês futuro ou vazio dá erro no status, sem pedir o servidor, e o foco volta ao campo", async ({ page }) => {
    const pedidos = [];
    page.on("request", pedido => { if (pedido.url().includes("/api/relatorio-mensal")) pedidos.push(pedido.url()); });
    await abrirRelatorio(page);
    const status = page.locator("#status-relatorio-mensal");
    for (const valor of ["2026-10", ""]) {
      await page.locator("#relatorio-mensal-mes").fill(valor);
      await page.locator("#btn-exportar-relatorio-mensal").focus();
      await page.keyboard.press("Enter");
      await expect(status).toHaveText("Selecione o mês atual ou um mês anterior.");
      await expect(status).toHaveAttribute("data-state", "error");
      await expect(page.locator("#relatorio-mensal-mes")).toBeFocused();
    }
    expect(pedidos).toEqual([]);
  });

  test("relatório mensal: exportar baixa o arquivo com o nome do servidor, limpa o status e mostra o toast aprovado", async ({ page }) => {
    let liberar;
    const segura = new Promise(resolve => { liberar = resolve; });
    const pedidos = [];
    await page.route(/\/api\/relatorio-mensal\?/, async route => {
      pedidos.push(new URL(route.request().url()).searchParams.get("mes"));
      await segura;
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="Relatorio-mensal-2026-08-teste.xlsx"' },
        body: "PK-teste",
      });
    });
    await abrirRelatorio(page);
    await page.locator("#relatorio-mensal-mes").fill("2026-08");
    const download = page.waitForEvent("download");
    await page.locator("#btn-exportar-relatorio-mensal").click();
    const botao = page.locator("#btn-exportar-relatorio-mensal");
    await expect(page.locator("#status-relatorio-mensal")).toHaveText("Gerando relatório...");
    await expect(botao).toBeDisabled();
    await expect(botao).toHaveAttribute("aria-busy", "true");
    // Exportando, Fechar e um segundo envio não fazem nada.
    await page.getByRole("button", { name: "Fechar relatório mensal" }).click();
    await expect(page.locator("#modal-relatorio-mensal")).toBeVisible();
    await page.evaluate(() => window.exportarRelatorioMensal());
    liberar();
    expect((await download).suggestedFilename()).toBe("Relatorio-mensal-2026-08-teste.xlsx");
    await expect(page.locator("#toast-container")).toContainText("Planilha Exportada com Sucesso!");
    await expect(page.locator("#status-relatorio-mensal")).toHaveText("");
    await expect(botao).toBeEnabled();
    await expect(botao).not.toHaveAttribute("aria-busy", /.*/);
    expect(pedidos).toEqual(["2026-08"]);
  });

  test("relatório mensal: sem nome no cabeçalho, o arquivo sai como Relatorio-mensal-<mês>.xlsx", async ({ page }) => {
    await page.route(/\/api\/relatorio-mensal\?/, route => route.fulfill({ status: 200, headers: { "Content-Type": "application/octet-stream" }, body: "PK" }));
    await abrirRelatorio(page);
    await page.locator("#relatorio-mensal-mes").fill("2026-07");
    const download = page.waitForEvent("download");
    await page.locator("#btn-exportar-relatorio-mensal").click();
    expect((await download).suggestedFilename()).toBe("Relatorio-mensal-2026-07.xlsx");
  });

  test("relatório mensal: erro do servidor vai para o status, o toast e o console, e a promessa não rejeita", async ({ page }) => {
    const erros = [];
    page.on("console", mensagem => { if (mensagem.type() === "error") erros.push(mensagem.text()); });
    await page.route(/\/api\/relatorio-mensal\?/, route => route.fulfill({ status: 500, json: { detail: "Falha sintética do servidor." } }));
    await abrirRelatorio(page);
    await page.locator("#relatorio-mensal-mes").fill("2026-08");
    const resultado = await page.evaluate(() => window.exportarRelatorioMensal().then(() => "resolvida", () => "rejeitada"));
    expect(resultado).toBe("resolvida");
    const status = page.locator("#status-relatorio-mensal");
    await expect(status).toHaveText("Falha sintética do servidor.");
    await expect(status).toHaveAttribute("data-state", "error");
    await expect(page.locator("#toast-container")).toContainText("Falha sintética do servidor.");
    await expect(page.locator("#btn-exportar-relatorio-mensal")).toBeEnabled();
    expect(erros.some(texto => texto.includes("Erro ao exportar o relatório mensal:"))).toBe(true);
  });

  // ---- Backups ----

  test("backups: um clique (ou duplo clique) manda um único POST com série e cidade", async ({ page }) => {
    const posts = [];
    page.on("request", pedido => { if (pedido.method() === "POST" && pedido.url().includes("/api/backups-regionais/")) posts.push({ url: new URL(pedido.url()).pathname, corpo: pedido.postDataJSON() }); });
    await abrirBackups(page);
    await botaoConfirmar(page, "TSTBK0001", "Londrina").dblclick();
    await expect(linha(page, "Londrina").locator(".ck-badge")).toHaveText("Backup disponível");
    await expect(page.locator("#toast-container")).toContainText("Backup confirmado por 7 dias: série TSTBK0001, Londrina.");
    expect(posts).toEqual([{ url: "/api/backups-regionais/confirmar", corpo: { serie: "TSTBK0001", cidade: "Londrina" } }]);
  });

  test("backups: depois de confirmar com um clique, o redesenho devolve o foco ao Desfazer da mesma série", async ({ page }) => {
    await abrirBackups(page);
    await botaoConfirmar(page, "TSTBK0001", "Londrina").click();
    await expect(linha(page, "Londrina").locator(".ck-badge")).toHaveText("Backup disponível");
    await expect(botaoDesfazer(page, "TSTBK0001", "Londrina")).toBeFocused();
  });

  test("backups: 422 mostra a mensagem do servidor, solta o botão com foco e pede o painel de novo", async ({ page }) => {
    await page.route("**/api/backups-regionais/confirmar", route => route.fulfill({ status: 422, json: { detail: { codigo: "serie_nao_elegivel", mensagem: "A série não é candidata a backup nesta cidade." } } }));
    let leituras = 0;
    page.on("request", pedido => { if (new URL(pedido.url()).pathname === "/api/painel") leituras += 1; });
    await abrirBackups(page);
    const antes = leituras;
    const botao = botaoConfirmar(page, "TSTBK0001", "Londrina");
    await botao.click();
    await expect(page.locator("#toast-container")).toContainText("A série não é candidata a backup nesta cidade.");
    await expect(botao).toBeEnabled();
    await expect(botao).not.toHaveAttribute("aria-busy", /.*/);
    await expect(botao).toBeFocused();
    await expect.poll(() => leituras).toBeGreaterThan(antes);
  });

  test("backups: erro de rede mostra a mensagem padrão, sem o texto cru do navegador", async ({ page }) => {
    await page.route("**/api/backups-regionais/desfazer", route => route.abort());
    await abrirBackups(page);
    await botaoDesfazer(page, "TSTBK0004", "Pato Branco").click();
    await expect(page.locator("#toast-container")).toContainText("Não foi possível desfazer a confirmação.");
    await expect(page.locator("#toast-container")).not.toContainText("Failed to fetch");
    await expect(botaoDesfazer(page, "TSTBK0004", "Pato Branco")).toBeEnabled();
  });

  test("backups: desfazer sem registro avisa que não havia confirmação", async ({ page }) => {
    await page.route("**/api/backups-regionais/desfazer", route => route.fulfill({ json: { removido: false } }));
    await abrirBackups(page);
    await botaoDesfazer(page, "TSTBK0004", "Pato Branco").click();
    await expect(page.locator("#toast-container")).toContainText("Não havia confirmação para desfazer: série TSTBK0004, Pato Branco.");
  });

  test("backups: a lista de excluídos aberta continua aberta quando o painel é redesenhado", async ({ page }) => {
    await abrirBackups(page);
    const excluidos = page.locator(`${PAINEL} details[data-cidade="Cascavel"]`);
    await excluidos.locator("summary").click();
    await expect(excluidos).toHaveAttribute("open", "");
    await botaoConfirmar(page, "TSTBK0001", "Londrina").click();
    await expect(linha(page, "Londrina").locator(".ck-badge")).toHaveText("Backup disponível");
    await expect(excluidos).toHaveAttribute("open", "");
  });

  test("backups: o apelido nunca vai ao console", async ({ page }) => {
    const mensagens = [];
    page.on("console", mensagem => mensagens.push(mensagem.text()));
    await page.route("**/api/backups-regionais/desfazer", route => route.fulfill({ status: 500, json: { detail: "Falha sintética." } }));
    await abrirBackups(page);
    await expect(page.locator(PAINEL)).toContainText(`${APELIDO} 1`);
    await botaoConfirmar(page, "TSTBK0001", "Londrina").click();
    await expect(linha(page, "Londrina").locator(".ck-badge")).toHaveText("Backup disponível");
    await botaoDesfazer(page, "TSTBK0004", "Pato Branco").click();
    await expect(page.locator("#toast-container")).toContainText("Falha sintética.");
    expect(mensagens.filter(texto => texto.toLowerCase().includes(APELIDO.toLowerCase()))).toEqual([]);
  });

  test("backups: textos de série, apelido e cidade aparecem escapados, sem executar HTML", async ({ page }) => {
    const malicioso = '<img src=x onerror="window.__xssG5=1">';
    await rotaBackups(page, {
      ...BACKUPS_FIXOS,
      prioritarias: [{ cidade: `Cidade ${malicioso}`, status: "conferir", contados: 0, minimo: 1, excedente: 0, backups: [], conferencia: [], excluidos: [],
        candidatos: [{ serie: `TSTG5${malicioso}`, apelido: `Apelido ${malicioso}`, motivo: malicioso, dias_sem_verificacao: 2, confirmacao: null }] }],
      limitacoes: [malicioso],
    });
    await abrirBackups(page);
    await expect(page.locator(PAINEL)).toContainText(`Apelido ${malicioso}`);
    await expect(page.locator(`${PAINEL} img`)).toHaveCount(0);
    expect(await page.evaluate(() => window.__xssG5)).toBeUndefined();
  });

  test("backups: serviço desligado (null) mostra o aviso e o selo vazio", async ({ page, request }) => {
    await request.get("/__fixture_backups?estado=nulo");
    await abrirBackups(page);
    await expect(page.locator(PAINEL)).toContainText("O cálculo de backups regionais está desligado neste servidor.");
    await expect(page.locator(SELO_ABA)).toHaveText("—");
    await expect(page.locator(`${PAINEL} .ck-backups__meta`)).toHaveCount(0);
  });

  test("backups: só o \"Atualizado em\" muda quando os dados são os mesmos (o painel não é recriado)", async ({ page }) => {
    let gerado = "2026-10-25T09:00:00-03:00";
    await page.route("**/api/painel", async route => {
      const resposta = await route.fetch();
      await route.fulfill({ response: resposta, json: { ...(await resposta.json()), backups_regionais: { ...BACKUPS_FIXOS, gerado_em: gerado } } });
    });
    await abrirBackups(page);
    const tabela = page.locator(`${PAINEL} table`);
    await tabela.evaluate(no => { no.dataset.marcaG5 = "mesma"; });
    gerado = "2026-10-25T10:30:00-03:00";
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("simpress:atualizar-notificacoes")));
    await expect(page.locator(`${PAINEL} .ck-backups__meta`)).toHaveText("Atualizado em 25/10/2026, 10:30:00.");
    await expect(tabela).toHaveAttribute("data-marca-g5", "mesma");
  });
});
