// Migração React, grupo G8: Chamados (gestão das importações do F6 e chamados abertos da Home), Atualizar planilhas
// (inventários) e o envio ao SharePoint do Dashboard Sebrae (F5).
// Os baselines de screenshot e os testes de invariante foram gravados com o código antigo (JS puro), antes da troca para
// React: o que for migrado tem de sair igual (390 e 1366 px, claro e escuro) e mandar os mesmos pedidos, só no clique.
// Já cobertos em outras specs (não repetidos aqui): Exportar Excel dos chamados com filtros (ticket-requests.spec.cjs),
// Exportar Excel dos equipamentos seguido do POST /api/automacao/ux-apelidos (cockpit-tools.spec.cjs) e as escolhas do
// diálogo de Atualizar Dashboard (sebrae-dashboard.spec.cjs).
const { test, expect } = require("@playwright/test");

// As datas das importações e a idade dos chamados viram texto: fuso e relógio fixos deixam o screenshot estável.
test.use({ timezoneId: "America/Sao_Paulo" });
const AGORA = new Date("2026-10-12T15:00:00Z");
const TOAST = "#toast-container .ck-toast";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const arquivo = (name, texto = "fixture xlsx") => ({ name, mimeType: XLSX, buffer: Buffer.from(texto) });

async function prepararTema(page, tema) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.setFixedTime(AGORA);
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
}

// ---------------------------------------------------------------------------------------------------------------
// Chamados (F6): bloco "Importar e gerenciar" (versões, fontes, comparação, importar, excluir antigas).

async function abrirGestaoChamados(page, { tema = "light" } = {}) {
  await prepararTema(page, tema);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  await page.evaluate(() => { abrirPainelCockpit("chamados"); abrirGestaoChamadosCockpit(); });
  const painel = page.locator("#cockpit-tickets-manage-panel");
  await expect(painel).toHaveAttribute("open", "");
  await expect(painel.locator("#cockpit-tickets-evolution")).toContainText("1 alteradas");
  return painel;
}

for (const tema of ["light", "dark"]) {
  test(`baseline: bloco Importar e gerenciar dos chamados, tema ${tema}`, async ({ page }) => {
    const painel = await abrirGestaoChamados(page, { tema });
    await painel.locator("details", { hasText: "Comparação com a importação anterior" }).evaluate(no => { no.open = true; });
    await painel.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expect(painel).toHaveScreenshot(`chamados-gestao-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}

test.describe("chamados: comportamento", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento: basta um tamanho");

  test("IDs, ARIA e textos do bloco ficam iguais", async ({ page }) => {
    const painel = await abrirGestaoChamados(page);
    await expect(page.locator("#cockpit-tickets-manage-version")).toHaveText("Atualizado 09/10/2026, 09:00:00");
    await expect(painel.locator("#cockpit-tickets-sources")).toHaveText("Simpress: Acompanhamento_de_Pedidos.xlsx · Oracle: Gestao_de_Solicitacoes.xlsx");
    const versao = painel.locator("#cockpit-tickets-version");
    await expect(versao).toBeEnabled();
    await expect(versao).toHaveValue("20261009_120000");
    await expect(versao.locator("option")).toHaveText([
      "Nenhuma importação",
      "09/10/2026, 09:00:00 · Acompanhamento_de_Pedidos.xlsx + Gestao_de_Solicitacoes.xlsx",
      "02/10/2026, 06:00:00 · Acompanhamento_de_Pedidos.xlsx + Gestao_de_Solicitacoes.xlsx",
    ]);
    await expect(versao).toHaveAttribute("aria-describedby", "cockpit-tickets-version-hint");
    await expect(painel.locator("#cockpit-tickets-delete-old")).toBeEnabled();
    await expect(page.locator("#cockpit-tickets-export")).toBeEnabled();
    const evolucao = painel.locator("#cockpit-tickets-evolution");
    await expect(evolucao).toHaveAttribute("role", "status");
    await expect(evolucao.locator(".ck-chamados-evolucao__resumo")).toHaveText("Comparação com a versão anterior · 0 novas · 1 alteradas · 0 sem mudança · 0 ausentes");
    await expect(evolucao).toContainText("Ausência na planilha não confirma resolução.");
    await expect(evolucao.locator(".ck-chamados-evolucao__lista li")).toHaveText(["DEMO-SN-001: Status Oracle"]);
    await expect(painel.locator("#cockpit-tickets-import-status")).toHaveAttribute("role", "status");
    await expect(painel.locator("#cockpit-tickets-file-simpress")).toHaveAttribute("name", "simpress_file");
    await expect(page.locator("#cockpit-tickets-file-simpress")).toBeFocused(); // abrirGestaoChamadosCockpit foca o primeiro arquivo
    const ids = await page.evaluate(() => [...document.querySelectorAll("[id]")].map(no => no.id));
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test("versão mais antiga: sem comparação e sem exportar enquanto não houver versão", async ({ page }) => {
    const painel = await abrirGestaoChamados(page);
    const versao = painel.locator("#cockpit-tickets-version");
    await versao.selectOption("20261002_090000");
    await expect(painel.locator("#cockpit-tickets-evolution")).toHaveText("Esta é a importação mais antiga disponível. Selecione uma versão mais recente para comparar.");
    await versao.selectOption("");
    await expect(painel.locator("#cockpit-tickets-evolution")).toHaveText("Nenhuma importação selecionada.");
    await expect(page.locator("#cockpit-tickets-export")).toBeDisabled();
  });

  test("importar: sem as duas planilhas não envia; com elas envia uma vez, limpa, fecha e avisa", async ({ page }) => {
    const envios = [];
    await page.route("**/api/operacoes/chamados/importar", route => {
      if (route.request().method() === "POST") envios.push(route.request());
      return route.fallback();
    });
    const painel = await abrirGestaoChamados(page);
    await page.evaluate(() => {
      window.__eventosChamados = [];
      document.addEventListener("simpress:chamados-atualizados", evento => window.__eventosChamados.push(evento.detail));
    });
    const status = painel.locator("#cockpit-tickets-import-status");
    await painel.locator("#cockpit-tickets-file-simpress").setInputFiles(arquivo("Acompanhamento_de_Pedidos.xlsx"));
    await painel.getByRole("button", { name: "Importar planilhas", exact: true }).click();
    await expect(status).toHaveText("Selecione as duas planilhas para importar.");
    expect(envios).toHaveLength(0);
    await painel.locator("#cockpit-tickets-file-oracle").setInputFiles(arquivo("Gestao_de_Solicitacoes.xlsx"));
    await painel.getByRole("button", { name: "Importar planilhas", exact: true }).click();
    await expect(status).toHaveText("Planilhas importadas. As OS foram relacionadas pela série.");
    expect(envios).toHaveLength(1);
    const corpo = envios[0].postDataBuffer().toString("latin1");
    expect(corpo).toContain('name="simpress_file"; filename="Acompanhamento_de_Pedidos.xlsx"');
    expect(corpo).toContain('name="oracle_file"; filename="Gestao_de_Solicitacoes.xlsx"');
    await expect(painel).not.toHaveAttribute("open", "");
    await expect(page.locator("#cockpit-tickets-file-simpress-name")).toHaveText("Escolher arquivo");
    await expect(page.locator("#cockpit-tickets-file-oracle-name")).toHaveText("Escolher arquivo");
    await expect(page.locator(TOAST).filter({ hasText: "Acompanhamento de chamados atualizado." })).toBeVisible();
    await expect(painel.locator("#cockpit-tickets-import")).toBeEnabled();
    await expect(painel.locator("#cockpit-tickets-form")).not.toHaveAttribute("aria-busy", /.*/);
    expect(await page.evaluate(() => window.__eventosChamados)).toEqual([{ snapshot_id: "20261009_120000" }]);
  });

  test("excluir antigas: pede confirmação, cancelar não apaga e confirmar manda um DELETE", async ({ page }) => {
    const apagados = [];
    await page.route("**/api/operacoes/chamados/historico/antigas", route => {
      apagados.push(route.request().method());
      return route.fulfill({ json: { removidas: 1 } });
    });
    const painel = await abrirGestaoChamados(page);
    const modal = page.locator("#modal-confirmar-acao");
    await painel.locator("#cockpit-tickets-delete-old").click();
    await expect(modal).toContainText("Excluir importações antigas?");
    await expect(modal.locator("#mensagem-confirmar-acao")).toHaveText("Excluir 1 importação antiga e manter somente a mais recente? Esta ação não poderá ser desfeita.");
    await expect(modal.locator("#btn-confirmar-acao-ok")).toHaveText("Excluir");
    await modal.locator("#btn-confirmar-acao-cancelar").click();
    await expect(modal).toBeHidden();
    expect(apagados).toEqual([]);
    await painel.locator("#cockpit-tickets-delete-old").click();
    await modal.locator("#btn-confirmar-acao-ok").click();
    await expect(page.locator(TOAST).filter({ hasText: "1 importação antiga removida. A importação mais recente foi mantida." })).toBeVisible();
    expect(apagados).toEqual(["DELETE"]);
    await expect(painel.locator("#cockpit-tickets-delete-old")).toHaveText("Excluir importações antigas");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Home: cartão "Chamados abertos" da série buscada (Oracle da importação mais recente + chamados do F5).

const SERIE = "G8-SN-1";
const RELATORIO_HOME = {
  snapshot_id: "s1", atualizado_em: "2026-10-12T12:00:00Z",
  historico: [{ id: "s1", atualizado_em: "2026-10-12T12:00:00Z", fontes: {} }],
  fontes: {}, resumo: {},
  chamados: [{
    serie: SERIE, relacao: "conferida",
    oracle: [
      { ordem_servico: "7000002", status: "Em atendimento", sub_status: "Execução Pendente", fila: "Mesa de Operações", nome_filial: "Curitiba", ultima_atualizacao: "2026-10-11" },
      { ordem_servico: "7000010", status: "Aguardando peça", fila: "", cidade: "Londrina", ultima_atualizacao: "2026-10-01" },
      { ordem_servico: "", status: "", ultima_atualizacao: "2026-10-12" },
      { ordem_servico: "7000001", status: "Encerrado", fila: "Mesa", data_conclusao: "2026-10-05", ultima_atualizacao: "2026-10-05" },
    ],
  }],
};
const SEBRAE_HOME = {
  importado: {
    abertos: [
      { numero: "UTIC-2026-9", titulo: "Teclado sem resposta", automaticos: { K: SERIE } },
      { numero: "linha:5", chamado: "UTIC-2026-8", titulo: "Mouse", automaticos_sugeridos: { K: SERIE.toLowerCase() } },
      { numero: "UTIC-2026-7", titulo: "Outra série", automaticos: { K: "OUTRA" } },
      { numero: "UTIC-2026-6", titulo: "Já finalizado", automaticos: { K: SERIE } },
    ],
    finalizados: [{ numero: "UTIC-2026-6" }],
  },
  novos: { formulario: [{ numero: "N-1", linha: { G: "Chamado novo", K: SERIE } }] },
};

async function abrirHome(page, { tema = "light", sebrae = SEBRAE_HOME } = {}) {
  await prepararTema(page, tema);
  await page.route("**/api/equipamento/*", route => route.fulfill({ json: { serial: SERIE, modelo: "Notebook de teste", tipo: "Notebook", apelido: "TESTE-G8" } }));
  await page.route("**/api/operacoes/chamados", route => route.fulfill({ json: RELATORIO_HOME }));
  await page.route("**/api/sebrae/novos", route => (sebrae ? route.fulfill({ json: sebrae }) : route.fulfill({ status: 500, json: { detail: "falha" } })));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  await page.locator("#input-serial").fill(SERIE);
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText(SERIE);
  const cartao = page.locator('aside[aria-labelledby="home-open-tickets-title"]');
  await expect(cartao.locator("#home-open-tickets-body")).toHaveAttribute("aria-busy", "false");
  return cartao;
}

for (const tema of ["light", "dark"]) {
  test(`baseline: chamados abertos da Home, tema ${tema}`, async ({ page }) => {
    const cartao = await abrirHome(page, { tema });
    await expect(cartao.locator("#home-open-tickets-count")).toHaveText("6 abertos");
    await cartao.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expect(cartao).toHaveScreenshot(`home-chamados-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}

test.describe("Home chamados abertos: comportamento", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento: basta um tamanho");

  test("lista OS abertas (mais nova primeiro) e os chamados do F5 da série", async ({ page }) => {
    const cartao = await abrirHome(page);
    await expect(cartao.locator("#home-open-tickets-title")).toHaveText("Chamados abertos");
    await expect(cartao.locator("#home-open-tickets-count")).toHaveAttribute("role", "status");
    await expect(cartao.locator("#home-open-tickets-count")).toHaveText("6 abertos");
    const itens = cartao.locator("ul.ck-abertos > li.ck-aberto");
    await expect(itens).toHaveCount(3);
    await expect(itens.locator(".ck-aberto__numero")).toHaveText(["7000010", "7000002", "Sem OS"]);
    await expect(itens.first().locator(".ck-badge")).toHaveText("Aguardando peça");
    await expect(itens.nth(1).locator(".ck-badge")).toHaveText("Em atendimento · Execução Pendente");
    await expect(itens.nth(2).locator(".ck-badge")).toHaveText("Status não informado");
    await expect(itens.first().locator(".ck-aberto__titulo")).toHaveText("Fila não informada");
    await expect(itens.first().locator(".ck-aberto__meta").first()).toHaveText("Londrina");
    await expect(itens.nth(2).locator(".ck-aberto__meta").first()).toHaveText("Unidade não informada");
    await expect(itens.nth(1).getByRole("button", { name: `Abrir a OS 7000002 da série ${SERIE} em Chamados` })).toBeVisible();
    const sebrae = cartao.locator(".ck-abertos__sebrae");
    await expect(sebrae.locator(".ck-abertos__rotulo")).toHaveText("3 chamados na aba Chamados (F5)");
    await expect(sebrae.locator("button.ck-aberto__meta")).toHaveText(["UTIC-2026-9 · Teclado sem resposta", "UTIC-2026-8 · Mouse", "N-1 · Chamado novo"]);
    await expect(sebrae.getByRole("button", { name: "Abrir na aba Chamados (F5): UTIC-2026-8 · Mouse" })).toBeVisible();
    await expect(sebrae.locator(".ck-abertos__ver")).toHaveText("Ver na aba Chamados (F5)");
    await expect(cartao.getByRole("alert")).toHaveCount(0);
  });

  test("os botões chamam abrirChamadoDaOs e o botão do F5", async ({ page }) => {
    const cartao = await abrirHome(page);
    await page.evaluate(() => {
      window.__chamadasOs = [];
      window.abrirChamadoDaOs = (...args) => { window.__chamadasOs.push(args); };
      window.__cliquesF5 = 0;
      document.getElementById("btn-sebrae-chamados-aba")?.addEventListener("click", evento => { window.__cliquesF5 += 1; evento.stopImmediatePropagation(); }, { capture: true });
    });
    await cartao.getByRole("button", { name: `Abrir a OS 7000002 da série ${SERIE} em Chamados` }).click();
    expect(await page.evaluate(() => window.__chamadasOs)).toEqual([[[], SERIE, "7000002"]]);
    await cartao.locator(".ck-abertos__ver").click();
    expect(await page.evaluate(() => window.__cliquesF5)).toBe(1);
  });

  test("falha na consulta do F5 preserva as OS e avisa", async ({ page }) => {
    const cartao = await abrirHome(page, { sebrae: null });
    await expect(cartao.locator("#home-open-tickets-count")).toHaveText("3 abertos · consulta parcial");
    await expect(cartao.locator("li.ck-aberto")).toHaveCount(3);
    await expect(cartao.getByRole("alert")).toHaveText("Não foi possível consultar os chamados do Sebrae. Os resultados do Oracle foram preservados.");
    await expect(cartao.locator(".ck-abertos__sebrae")).toHaveCount(0);
  });

  test("série sem chamados mostra o texto vazio", async ({ page }) => {
    const cartao = await abrirHome(page, { sebrae: { importado: { abertos: [], finalizados: [] }, novos: { formulario: [] } } });
    await page.route("**/api/equipamento/*", route => route.fulfill({ json: { serial: "SEM-NADA", modelo: "Notebook", tipo: "Notebook" } }));
    await page.locator("#input-serial").fill("SEM-NADA");
    await page.getByRole("button", { name: "Buscar Equipamento" }).click();
    await expect(cartao.locator("#home-open-tickets-body")).toHaveText("Nenhum chamado aberto para esta série.");
    await expect(cartao.locator("#home-open-tickets-count")).toHaveText("");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Atualizar planilhas (inventários): prévia obrigatória, token da prévia e chave de idempotência.

const PREVIA = {
  preview_token: "tok-g8",
  arquivos: { endpoint: { nome: "endpoint.xlsx", linhas: 1234 }, detalhes: { nome: "detalhes.xlsx", linhas: 1200 } },
  alteracoes: {
    endpoint: { series_novas: 3, series_removidas: 1, series_duplicadas_no_arquivo_novo: 0 },
    detalhes: { series_novas: 0, series_removidas: 2, series_duplicadas_no_arquivo_novo: 1 },
  },
};

async function abrirPlanilhas(page, { tema = "light", atualizar = [] } = {}) {
  const pedidos = { previa: [], atualizar: [] };
  await page.route("**/api/planilhas/previsualizar", route => {
    pedidos.previa.push(route.request());
    return route.fulfill({ json: PREVIA });
  });
  await page.route("**/api/planilhas/atualizar", route => {
    pedidos.atualizar.push(route.request());
    const resposta = atualizar[pedidos.atualizar.length - 1] || { status: 500, detail: "falha simulada" };
    return route.fulfill({ status: resposta.status, json: { detail: resposta.detail } });
  });
  await prepararTema(page, tema);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  await page.evaluate(() => abrirModalAtualizarPlanilhas());
  const modal = page.locator("#modal-atualizar-planilhas");
  await expect(modal).toBeVisible();
  return { modal, pedidos };
}

async function gerarPrevia(page, modal) {
  await modal.locator("#upload-endpoint-file").setInputFiles(arquivo("endpoint.xlsx", "endpoint"));
  await modal.locator("#upload-details-file").setInputFiles(arquivo("detalhes.xlsx", "detalhes"));
  await modal.locator("#btn-previsualizar-planilhas").click();
  await expect(modal.locator("#btn-confirmar-planilhas")).toBeVisible();
}

const previaAtual = page => page.evaluate(() => {
  const previa = window.SimpressApp.state.previaPlanilhasAtual;
  return previa && { chaves: Object.keys(previa).sort(), token: previa.previewToken, endpoint: previa.endpointFile?.name, detalhes: previa.detailsFile?.name };
});

for (const tema of ["light", "dark"]) {
  test(`baseline: Atualizar planilhas na etapa de impacto, tema ${tema}`, async ({ page }) => {
    const { modal } = await abrirPlanilhas(page, { tema });
    await gerarPrevia(page, modal);
    await page.mouse.move(0, 0);
    await expect(modal.locator(".ckp-dialogo")).toHaveScreenshot(`planilhas-impacto-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}

test.describe("Atualizar planilhas: invariantes", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento: basta um tamanho");

  test("sem os dois arquivos não pede prévia; a prévia guarda o token no estado compartilhado", async ({ page }) => {
    const { modal, pedidos } = await abrirPlanilhas(page);
    await modal.locator("#btn-previsualizar-planilhas").click();
    await expect(modal.locator("#upload-planilhas-status")).toHaveText("Selecione Endpoint e EquipamentosDetalhes antes de gerar a prévia.");
    expect(pedidos.previa).toHaveLength(0);
    await gerarPrevia(page, modal);
    expect(pedidos.previa).toHaveLength(1);
    expect(pedidos.atualizar).toHaveLength(0); // a prévia nunca substitui nada
    expect(await previaAtual(page)).toEqual({ chaves: ["detailsFile", "endpointFile", "previewToken"], token: "tok-g8", endpoint: "endpoint.xlsx", detalhes: "detalhes.xlsx" });
    await expect(modal.locator("#upload-planilhas-status")).toHaveText("Confira as contagens e confirme somente se este impacto estiver correto.");
    await expect(modal.locator("#upload-planilhas-preview")).toHaveText([
      "Resumo da substituição (contagens por número de série):",
      "Endpoint — endpoint.xlsx (1.234 linhas)",
      "Séries novas: 3; removidas: 1; duplicadas no arquivo novo: 0.",
      "Simpress — detalhes.xlsx (1.200 linhas)",
      "Séries novas: 0; removidas: 2; duplicadas no arquivo novo: 1.",
    ].join("\n"));
    await expect(modal.locator("#btn-previsualizar-planilhas")).toBeHidden();
    await modal.locator("#btn-voltar-planilhas").click();
    expect(await previaAtual(page)).toBeNull();
    await expect(modal.locator("#btn-confirmar-planilhas")).toBeHidden();
    await gerarPrevia(page, modal);
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    expect(await previaAtual(page)).toBeNull();
    expect(pedidos.atualizar).toHaveLength(0);
  });

  test("confirmar sem prévia ou com arquivo trocado não envia nada", async ({ page }) => {
    const { modal, pedidos } = await abrirPlanilhas(page);
    await page.evaluate(() => enviarPlanilhas());
    await expect(modal.locator("#upload-planilhas-status")).toHaveText("Gere uma prévia dos arquivos antes de confirmar a substituição.");
    await gerarPrevia(page, modal);
    await modal.locator("#upload-endpoint-file").setInputFiles(arquivo("outro.xlsx", "outro"));
    await page.evaluate(() => enviarPlanilhas());
    await expect(modal.locator("#upload-planilhas-status")).toHaveText(/Gere (uma nova prévia|uma prévia)/);
    expect(await previaAtual(page)).toBeNull();
    expect(pedidos.atualizar).toHaveLength(0);
  });

  test("confirmar manda o token e repete a mesma Idempotency-Key; erro do cliente anula a prévia", async ({ page }) => {
    const { modal, pedidos } = await abrirPlanilhas(page, {
      atualizar: [{ status: 500, detail: "falha temporária" }, { status: 500, detail: "falha temporária" }, { status: 409, detail: "prévia vencida" }],
    });
    await gerarPrevia(page, modal);
    const confirmar = modal.locator("#btn-confirmar-planilhas");
    for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
      await confirmar.click();
      await expect.poll(() => pedidos.atualizar.length).toBe(tentativa);
      if (tentativa < 3) await expect(confirmar).toBeEnabled(); // depois do erro 4xx o botão some
      await expect(modal).not.toHaveAttribute("aria-busy", /.*/);
      if (tentativa < 3) expect(await previaAtual(page)).not.toBeNull(); // 5xx mantém a prévia para tentar de novo
    }
    const chaves = pedidos.atualizar.map(r => r.headers()["idempotency-key"]);
    expect(chaves[0]).toBeTruthy();
    expect(new Set(chaves).size).toBe(1);
    for (const pedido of pedidos.atualizar) {
      const corpo = pedido.postDataBuffer().toString("latin1");
      expect(corpo).toMatch(/name="preview_token"\r\n\r\ntok-g8\r\n/);
      expect(corpo).toContain('filename="endpoint.xlsx"');
      expect(corpo).toContain('filename="detalhes.xlsx"');
    }
    expect(await previaAtual(page)).toBeNull(); // o 409 invalidou a prévia
    await expect(modal.locator("#upload-planilhas-status")).toContainText("prévia vencida");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Envio ao SharePoint (Atualizar Dashboard, F5): o POST só sai no clique, uma vez, com a versão importada.

async function abrirSebrae(page, request) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await request.get("/__fixture_automacao?quantidade=0&sebrae=padrao&run=&antigos=");
  // A fixture não manda a versão da importação: acrescenta uma para provar que ela vai no corpo do envio.
  await page.route("**/api/sebrae/novos", async route => {
    const resposta = await route.fetch();
    const dados = await resposta.json();
    if (dados.importado) dados.importado.versao = "versao-g8";
    await route.fulfill({ response: resposta, json: dados });
  });
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const cartao = page.locator("#sebrae-novos-painel");
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("novo(s)");
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  return painel;
}

test.describe("envio ao SharePoint: invariantes", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento: basta um tamanho");

  test("nada sai antes do clique; o clique manda um POST com a versão importada e trava o botão até a resposta", async ({ page, request }) => {
    const envios = [];
    let liberar;
    const espera = new Promise(resolve => { liberar = resolve; });
    await page.route("**/api/sebrae/dashboard/atualizar", async route => {
      envios.push(route.request().postDataJSON());
      await espera;
      await route.fallback();
    });
    const painel = await abrirSebrae(page, request);
    const botao = painel.locator("#btn-sebrae-atualizar");
    await expect(botao).toBeEnabled();
    await page.waitForTimeout(300);
    expect(envios).toHaveLength(0);
    const download = page.waitForEvent("download");
    await botao.click();
    await expect.poll(() => envios.length).toBe(1);
    await expect(botao).toBeDisabled();
    await expect(botao).toHaveAttribute("aria-busy", "true");
    await botao.evaluate(no => no.click()); // botão desabilitado: um segundo clique não manda outro POST
    await page.waitForTimeout(200);
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({ versao_importacao: "versao-g8", finalizar_softexpert: false, enviar_sharepoint: true, edicoes: [] });
    expect(envios[0].chamados.length).toBe(2);
    liberar();
    expect((await download).suggestedFilename()).toBe("Dashboard Operacional_SEBRAE.xlsx");
    await expect(botao).not.toHaveAttribute("aria-busy", /.*/);
  });

  test("erro do servidor mostra o motivo e não baixa nada", async ({ page, request }) => {
    const detalhe = "O Dashboard foi reimportado ou a tela está desatualizada. Recarregue e confira os campos antes de atualizar ou finalizar. Nada foi gravado ou finalizado.";
    await page.route("**/api/sebrae/dashboard/atualizar", route => route.fulfill({ status: 409, json: { detail: detalhe } }));
    const downloads = [];
    page.on("download", d => downloads.push(d));
    const painel = await abrirSebrae(page, request);
    await painel.locator("#btn-sebrae-atualizar").click();
    const status = painel.locator("#sebrae-atualizar-status");
    await expect(status).toHaveText(detalhe);
    await expect(status).toHaveAttribute("data-estado", "erro");
    await expect(page.locator(TOAST).filter({ hasText: "O Dashboard foi reimportado" })).toBeVisible();
    await page.waitForTimeout(200);
    expect(downloads).toHaveLength(0);
    await expect(painel.locator("#btn-sebrae-atualizar")).toBeEnabled();
  });
});
