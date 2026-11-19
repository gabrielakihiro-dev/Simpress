// Rede de segurança da migração React do Grupo 6: painéis Cobertura (F10), Termos e Lembretes (Ferramentas).
// Gravado com o JS puro de frontend/src/aplicacao/pontes.ts, termos.js e lembretes.js, ANTES da troca para React:
// o painel em React tem de sair igual nos dois tamanhos (390 e 1366 px) e nos dois temas, e os invariantes
// (confirmações antes de gravar, Preparar Transporte sem gerar planilha) têm de continuar valendo.
// Dados só sintéticos (fixtures de tests/support/serve_ui_motion_preview.py).
const { test, expect } = require("@playwright/test");

// Mesmo "agora" do servidor da fixture da Cobertura (COBERTURA_AGORA): uma sexta, para "amanhã" ficar na semana de Em breve.
const AGORA = "2026-11-06T09:00:00-03:00";
// O painel rola dentro de #cockpit-tool-panels (altura da janela): com a janela alta o elemento cabe inteiro na foto.
const ALTURA_ALTA = 4000;

// ----- Cobertura -----
async function cenario(page, nome = "base") {
  const resposta = await page.request.get(`/__fixture_cobertura?cenario=${nome}`);
  expect(resposta.ok()).toBeTruthy();
}

async function api(page, caminho, corpo) {
  const resposta = corpo === undefined ? await page.request.get(caminho) : await page.request.post(caminho, { data: corpo });
  expect(resposta.ok(), await resposta.text()).toBeTruthy();
  return resposta.json();
}

// Reserva a série pela API; com `kitCompleto` marca o kit inteiro, com `primeiroItem` só o primeiro.
async function reservar(page, serie, { kitCompleto = false, primeiroItem = false } = {}) {
  const leitura = await api(page, "/api/cobertura");
  const vaga = leitura.vagas.find(v => v.serie === serie);
  let reserva = await api(page, "/api/cobertura/reservas", { demanda_id: vaga.demanda_id, serie });
  const itens = Object.keys(reserva.kit).slice(0, kitCompleto ? undefined : primeiroItem ? 1 : 0);
  for (const item of itens) {
    reserva = await api(page, `/api/cobertura/reservas/${reserva.id}/kit`, { item, marcado: true, rev: reserva.rev });
  }
  return reserva;
}

async function abrirCobertura(page) {
  await page.locator("#input-serial").focus();
  await page.keyboard.press("F10");
  await expect(page.locator('[data-cockpit-tool-panel="cobertura"]')).toBeVisible();
  await expect(page.locator("#cobertura-status")).toContainText("Cobertura atualizada");
  await expect(page.locator("[id^='cobertura-lista-'][aria-busy], #cobertura-alertas[aria-busy]")).toHaveCount(0);
}

// Celular: um bloco por vez (chips "Lista de equipamentos"); no desktop o grupo de chips nem aparece.
async function chip(page, rotulo) {
  const grupo = page.locator(".cob__chips");
  if (await grupo.isVisible()) await grupo.getByRole("button", { name: rotulo, exact: true }).click();
}

// Abre a folha de um item pelo botão do cartão ("Abrir/Acompanhar/Receber — <série>") e devolve o diálogo.
async function abrirFolha(page, rotuloDoChip, botao, tituloDaFolha) {
  await chip(page, rotuloDoChip);
  await page.getByRole("button", { name: botao, exact: true }).click();
  const folha = page.getByRole("dialog", { name: tituloDaFolha });
  await expect(folha).toBeVisible();
  return folha;
}

// ----- Termos e Lembretes (mesmo painel: data-cockpit-tool-panel="lembretes") -----
async function abrirFerramentaLembretes(page) {
  const menu = page.locator("#cockpit-tools-dropdown");
  if (!(await menu.evaluate(node => node.open))) await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-lembretes").click();
  await expect(page.locator('[data-cockpit-tool-panel="lembretes"]')).toBeVisible();
}

const pendentes = page => page.locator("#lembretes-lista li.lembretes__item");

// Mesma cópia do termo que tests/e2e/lembretes.spec.cjs (campos, 11 itens e observação).
const vazios = quantidade => Array(quantidade).fill("");
const TERMO_ENTREGA = {
  campos: {
    nome: "Maria Teste", unidade: "Curitiba", data: "2026-11-12", modelo_anterior: "Dell 5420",
    modelo_entregue: "HP 640 G11", serie_anterior: "ANTIGA123", serie_entregue: "NOVA456",
  },
  itens: ["", "sim", "sim", ...vazios(8)],
  obs: "Sem avarias.",
};

// ----- Fotos: o mesmo preparo da página em todos os baselines -----
async function prepararPagina(page, tema) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  await page.clock.setFixedTime(new Date(AGORA));
  const { width } = page.viewportSize();
  await page.setViewportSize({ width, height: ALTURA_ALTA });
}

async function irParaInicio(page, tema) {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
}

// O brilho do bento segue o ponteiro e o foco pinta anel: tira o foco e deixa o mouse fora, com as fontes carregadas.
// A seção estica até o fim da janela alta; corta o vazio para que a tolerância de 1% dos pixels valha para o conteúdo, não para o branco.
async function prepararFoto(page, painel) {
  await page.evaluate(async () => {
    document.activeElement?.blur?.();
    await document.fonts.ready;
  });
  const altura = await page.evaluate(seletor => {
    let fundo = 0;
    for (const no of document.querySelector(seletor).querySelectorAll("*")) {
      const caixa = no.getBoundingClientRect();
      // As dicas (info-tip) ficam invisíveis e fixas no fim da janela: só conta o que aparece.
      if (caixa.width > 1 && caixa.height > 1 && no.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) fundo = Math.max(fundo, caixa.bottom);
    }
    return Math.ceil(fundo) + 24;
  }, painel);
  await page.setViewportSize({ width: page.viewportSize().width, height: altura });
  await page.evaluate(() => new Promise(feito => requestAnimationFrame(() => requestAnimationFrame(feito))));
  await page.mouse.move(0, 0);
}

const FOTO = { animations: "disabled", maxDiffPixelRatio: 0.01 };

// Lembretes sintéticos: sem sequência de dígitos na descrição (número de chamado/OS vira link e dispara leituras do Sebrae).
// Datas relativas a AGORA (sex 06/11/2026): atrasado, hoje com hora, amanhã (sábado, ainda na semana de Em breve), sem data e um termo.
const LEMBRETES_BASELINE = [
  { descricao: "Enviar relatório semanal", data_agendada: "2026-11-05", criado_em: "2026-11-02T08:10:00-03:00" },
  { descricao: "Ligar para o fornecedor de toner", data_agendada: "2026-11-06", hora_agendada: "14:00", criado_em: "2026-11-03T09:20:00-03:00" },
  { descricao: "Reunião com a regional", data_agendada: "2026-11-07", criado_em: "2026-11-04T10:30:00-03:00" },
  { descricao: "Pedir mochilas para a unidade", criado_em: "2026-11-05T11:40:00-03:00" },
  { descricao: "Termo de entrega de Maria Teste", origem: "entrega", termo: TERMO_ENTREGA, data_agendada: "2026-11-06", criado_em: "2026-11-05T15:50:00-03:00" },
];

// Zera a fixture e cria os itens pela API; o GET devolve o criado_em fixo (o do servidor é a hora real da gravação).
async function semearLembretesBaseline(page) {
  expect((await page.request.get("/__fixture_lembretes?itens=0")).ok()).toBeTruthy();
  for (const { criado_em: criado, ...item } of LEMBRETES_BASELINE) {
    expect((await page.request.post("/api/lembretes", { data: item })).ok()).toBeTruthy();
  }
  const criadoPorDescricao = new Map(LEMBRETES_BASELINE.map(item => [item.descricao, item.criado_em]));
  await page.route("**/api/lembretes", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const resposta = await route.fetch();
    const corpo = await resposta.json();
    corpo.lembretes = corpo.lembretes.map(item => ({ ...item, criado_em: criadoPorDescricao.get(item.descricao) ?? item.criado_em }));
    await route.fulfill({ response: resposta, json: corpo });
  });
}

test.describe("baselines de screenshot", () => {
  test.use({ locale: "pt-BR", timezoneId: "America/Sao_Paulo" });

  for (const tema of ["light", "dark"]) {
    test(`baseline: Cobertura, bloco Necessidades com dados da fixture, tema ${tema}`, async ({ page }) => {
      await cenario(page);
      await prepararPagina(page, tema);
      await irParaInicio(page, tema);
      await abrirCobertura(page);
      await chip(page, "Necessidades");
      await expect(page.locator("[data-cobertura-n]")).toHaveText(["4", "2", "0", "0", "1"]);
      await prepararFoto(page, 'section[data-cockpit-tool-panel="cobertura"]');
      await expect(page.locator('section[data-cockpit-tool-panel="cobertura"]')).toHaveScreenshot(`cobertura-necessidades-${tema}.png`, FOTO);
    });

    test(`baseline: Cobertura, bloco Reservas com uma reserva em preparo e outra com kit pronto, tema ${tema}`, async ({ page }) => {
      await cenario(page);
      await reservar(page, "SINT-001", { primeiroItem: true });
      await reservar(page, "SINT-002", { kitCompleto: true });
      await prepararPagina(page, tema);
      await irParaInicio(page, tema);
      await abrirCobertura(page);
      await chip(page, "Reservas");
      await expect(page.locator("#cobertura-lista-reservas li.cob__item")).toHaveCount(2);
      await expect(page.locator("#cobertura-lista-reservas").getByText("Kit pronto", { exact: true })).toHaveCount(1);
      await prepararFoto(page, 'section[data-cockpit-tool-panel="cobertura"]');
      await expect(page.locator('section[data-cockpit-tool-panel="cobertura"]')).toHaveScreenshot(`cobertura-reservas-${tema}.png`, FOTO);
    });

    test(`baseline: Termos, aba Entrega com o formulário vazio, tema ${tema}`, async ({ page }) => {
      expect((await page.request.get("/__fixture_lembretes?itens=0")).ok()).toBeTruthy();
      await prepararPagina(page, tema);
      await irParaInicio(page, tema);
      await abrirFerramentaLembretes(page);
      await page.locator("#termos-aba-entrega").click();
      await expect(page.locator("#termos-aba-entrega")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#termos-painel-entrega")).toBeVisible();
      await expect(page.locator("#termos-entrega-nome")).toHaveValue("");
      await prepararFoto(page, 'section[data-cockpit-tool-panel="lembretes"]');
      await expect(page.locator('section[data-cockpit-tool-panel="lembretes"]')).toHaveScreenshot(`termos-entrega-vazio-${tema}.png`, FOTO);
    });

    test(`baseline: Lembretes, vista Hoje com itens, tema ${tema}`, async ({ page }) => {
      await semearLembretesBaseline(page);
      await prepararPagina(page, tema);
      await irParaInicio(page, tema);
      await abrirFerramentaLembretes(page);
      await expect(page.locator("#termos-painel-lembretes")).toBeVisible();
      await expect(page.locator("#lembretes-aba-hoje")).toHaveAttribute("aria-selected", "true");
      // Hoje: 1 atrasada, 2 de hoje (um deles é o termo) e 1 sem data = 4 itens; o de amanhã só aparece em Em breve.
      await expect(pendentes(page)).toHaveCount(4);
      await prepararFoto(page, 'section[data-cockpit-tool-panel="lembretes"]');
      await expect(page.locator('section[data-cockpit-tool-panel="lembretes"]')).toHaveScreenshot(`lembretes-hoje-${tema}.png`, FOTO);
    });

    test(`baseline: Lembretes, vista Em breve com itens, tema ${tema}`, async ({ page }) => {
      await semearLembretesBaseline(page);
      await prepararPagina(page, tema);
      await irParaInicio(page, tema);
      await abrirFerramentaLembretes(page);
      await page.locator("#lembretes-aba-embreve").click();
      await expect(page.locator("#lembretes-aba-embreve")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('#lembretes-lista section[data-grupo="2026-11-07"] li.lembretes__item')).toHaveCount(1);
      await prepararFoto(page, 'section[data-cockpit-tool-panel="lembretes"]');
      await expect(page.locator('section[data-cockpit-tool-panel="lembretes"]')).toHaveScreenshot(`lembretes-embreve-${tema}.png`, FOTO);
    });
  }
});

// ----- Invariantes de comportamento (1366 px): valem antes e depois do React -----
const modalConfirmar = page => page.locator("#modal-confirmar-acao");
const tituloConfirmar = page => page.locator("#titulo-confirmar-acao");
const recusar = page => page.locator("#btn-confirmar-acao-cancelar").click();
const aceitar = page => page.locator("#btn-confirmar-acao-ok").click();

function lerCorpo(requisicao) {
  try { return requisicao.postDataJSON(); } catch (erro) { return null; }
}

// Registra só escritas (não-GET): `page.request` das preparações não passa por aqui.
function gravarEscritas(page, trecho) {
  const escritas = [];
  page.on("request", requisicao => {
    if (requisicao.method() === "GET" || !requisicao.url().includes(trecho)) return;
    escritas.push({ metodo: requisicao.method(), caminho: new URL(requisicao.url()).pathname, corpo: lerCorpo(requisicao) });
  });
  return escritas;
}

test.describe("invariantes (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento não depende da largura: roda só no desktop");

  test("reserva com manutenção não verificada: confirma com o título aprovado; recusar não grava e confirmar grava manutencao_conferida true", async ({ page }) => {
    await cenario(page, "manutencao");
    await page.goto("/");
    await abrirCobertura(page);
    await expect(page.locator('[data-cobertura-alerta="manutencao"]')).toContainText("Manutenção não verificada");
    const escritas = gravarEscritas(page, "/api/cobertura/reservas");
    const reservarBotao = page.getByRole("button", { name: "Reservar — SINT-001 para Cidade A", exact: true });

    await reservarBotao.click();
    await expect(tituloConfirmar(page)).toHaveText("Manutenção não verificada");
    await recusar(page);
    await expect(modalConfirmar(page)).toBeHidden();
    expect(escritas).toEqual([]);
    await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("0");

    await reservarBotao.click();
    await expect(tituloConfirmar(page)).toHaveText("Manutenção não verificada");
    await aceitar(page);
    await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("1");
    // Um só POST: se a recusa tivesse gravado, haveria dois.
    expect(escritas).toHaveLength(1);
    expect(escritas[0].caminho).toBe("/api/cobertura/reservas");
    expect(escritas[0].corpo).toMatchObject({ serie: "SINT-001", manutencao_conferida: true });
  });

  test("reserva com manutenção verificada: confirma 'Reservar <série>?' com a cidade, recusar não grava e confirmar grava manutencao_conferida false", async ({ page }) => {
    await cenario(page);
    await page.goto("/");
    await abrirCobertura(page);
    await expect(page.locator('[data-cobertura-alerta="manutencao"]')).toHaveCount(0);
    const escritas = gravarEscritas(page, "/api/cobertura/reservas");
    const reservarBotao = page.getByRole("button", { name: "Reservar — SINT-001 para Cidade A", exact: true });

    await reservarBotao.click();
    await expect(tituloConfirmar(page)).toHaveText("Reservar SINT-001?");
    await expect(page.locator("#mensagem-confirmar-acao")).toHaveText("Cidade A");
    await recusar(page);
    await expect(modalConfirmar(page)).toBeHidden();
    expect(escritas).toEqual([]);
    await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("0");

    await reservarBotao.click();
    await expect(tituloConfirmar(page)).toHaveText("Reservar SINT-001?");
    await aceitar(page);
    await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("1");
    await expect(modalConfirmar(page)).toBeHidden();
    // Um só POST: se a recusa tivesse gravado, haveria dois.
    expect(escritas).toHaveLength(1);
    expect(escritas[0].corpo).toMatchObject({ serie: "SINT-001", manutencao_conferida: false });
  });

  // Cada cancelamento pede confirmação com o título aprovado, e só ao confirmar sai uma escrita.
  const preparaMovimentacao = async (page, serie, tipo = "transporte") => {
    const reserva = await reservar(page, serie, { kitCompleto: true });
    return api(page, "/api/cobertura/movimentacoes", { reserva_id: reserva.id, rev: reserva.rev, tipo });
  };
  const CANCELAMENTOS = [
    {
      nome: "necessidade", titulo: "Cancelar necessidade", botao: "Cancelar necessidade de Cidade A", chip: "Necessidades",
      caminho: /^\/api\/cobertura\/demandas\/[^/]+\/cancelar$/,
    },
    {
      nome: "reserva", titulo: "Cancelar reserva", botao: "Cancelar reserva — SINT-001", chip: "Reservas", abrir: "Abrir — SINT-001", folha: "Reservas",
      antes: page => reservar(page, "SINT-001"),
      caminho: /^\/api\/cobertura\/reservas\/[^/]+\/cancelar$/,
    },
    {
      nome: "movimentação", titulo: "Cancelar movimentação", botao: "Cancelar movimentação — SINT-002", chip: "Em movimento", abrir: "Acompanhar — SINT-002", folha: "Em movimento",
      antes: page => preparaMovimentacao(page, "SINT-002"),
      caminho: /^\/api\/cobertura\/movimentacoes\/[^/]+\/estado$/, corpo: { estado: "cancelada" },
    },
    {
      nome: "Cancelar e reabrir vaga", titulo: "Cancelar e reabrir vaga", botao: "Cancelar e reabrir vaga — SINT-001", chip: "Em movimento", abrir: "Acompanhar — SINT-001", folha: "Em movimento",
      antes: page => preparaMovimentacao(page, "SINT-001", "local"),
      // Mesmo caminho de cobertura.spec.cjs: a divergência é registrada pela tela e só então aparecem as três resoluções.
      depoisDeAbrir: async (page, movimento) => {
        await movimento.getByLabel("Recebido por").fill("Pessoa Sintética");
        await movimento.getByLabel("Tipo da divergência").selectOption("serie_diferente");
        await movimento.getByLabel("Série recebida").fill("SINT-009");
        await movimento.getByRole("button", { name: "Registrar divergência — SINT-001", exact: true }).click();
        await expect(movimento.getByText("Recebida com divergência", { exact: true })).toBeVisible();
      },
      caminho: /^\/api\/cobertura\/movimentacoes\/[^/]+\/resolver-divergencia$/, corpo: { resolucao: "cancelar" },
    },
    {
      nome: "devolução", titulo: "Cancelar devolução", botao: "Cancelar devolução — SINT-003", chip: "Devoluções", abrir: "Receber — SINT-003", folha: "Devoluções",
      caminho: /^\/api\/cobertura\/devolucoes\/[^/]+\/cancelar$/,
    },
  ];

  for (const caso of CANCELAMENTOS) {
    test(`cancelar ${caso.nome}: pede confirmação, recusar não grava e confirmar grava uma vez`, async ({ page }) => {
      await cenario(page);
      await caso.antes?.(page);
      await page.goto("/");
      await abrirCobertura(page);
      // Necessidade cancela na própria lista; os demais abrem a folha do item e cancelam lá dentro.
      const folha = caso.abrir ? await abrirFolha(page, caso.chip, caso.abrir, caso.folha) : null;
      if (!folha) await chip(page, caso.chip);
      await caso.depoisDeAbrir?.(page, folha);
      const escritas = gravarEscritas(page, "/api/cobertura");
      const botao = page.getByRole("button", { name: caso.botao, exact: true });

      await botao.click();
      await expect(tituloConfirmar(page)).toHaveText(caso.titulo);
      await recusar(page);
      await expect(modalConfirmar(page)).toBeHidden();
      expect(escritas).toEqual([]);

      await botao.click();
      await expect(tituloConfirmar(page)).toHaveText(caso.titulo);
      await aceitar(page);
      await expect.poll(() => escritas.length).toBeGreaterThan(0);
      // Um só POST: se a recusa tivesse gravado, haveria dois.
      expect(escritas).toHaveLength(1);
      expect(escritas[0].caminho).toMatch(caso.caminho);
      if (caso.corpo) expect(escritas[0].corpo).toMatchObject(caso.corpo);
    });
  }

  test("Preparar Transporte: um POST em /movimentacoes, só preenche o Transporte e nenhuma planilha é gerada nem enviada", async ({ page }) => {
    await cenario(page);
    await reservar(page, "SINT-002", { kitCompleto: true });
    await page.goto("/");
    await abrirCobertura(page);
    const reservas = await abrirFolha(page, "Reservas", "Abrir — SINT-002", "Reservas");
    // Antes: o Transporte está fechado e vazio.
    await expect(page.locator("#tab-panel-retirada-entrega")).toBeHidden();
    await expect(page.locator("#input-serial")).toHaveValue("");
    const escritas = gravarEscritas(page, "/api/");
    const geracoes = [];
    page.on("request", requisicao => { if (requisicao.url().includes("/api/gerar-planilha")) geracoes.push(`${requisicao.method()} ${requisicao.url()}`); });
    await reservas.getByRole("button", { name: "Preparar Transporte — SINT-002", exact: true }).click();
    // Ponto de parada: o Transporte abriu e foi preenchido com a série e a observação da necessidade.
    await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible();
    await expect(page.locator("#input-serial")).toHaveValue("SINT-002");
    await expect(page.locator("#entrega-obs")).toHaveValue("Necessidade sintética");
    // A única escrita é a da movimentação; /api/gerar-planilha (ou qualquer outra escrita) não saiu.
    expect(escritas).toHaveLength(1);
    expect(escritas[0].caminho).toBe("/api/cobertura/movimentacoes");
    expect(escritas[0].corpo).toMatchObject({ tipo: "transporte", rev: expect.any(Number) });
    expect(geracoes).toEqual([]);
  });

  test("Termos, Limpar: pede 'Limpar o termo?', recusar mantém os campos e confirmar volta ao padrão do termo novo", async ({ page }) => {
    expect((await page.request.get("/__fixture_lembretes?itens=0")).ok()).toBeTruthy();
    await page.goto("/");
    await abrirFerramentaLembretes(page);
    for (const termo of ["entrega", "devolucao"]) {
      await page.locator(`#termos-aba-${termo}`).click();
      await expect(page.locator(`#termos-painel-${termo}`)).toBeVisible();
      const nome = page.locator(`#termos-${termo}-nome`);
      const serie = page.locator(termo === "entrega" ? "#termos-entrega-serie-entregue" : "#termos-devolucao-serie");
      const obs = page.locator(`#termos-${termo}-obs`);
      await nome.fill("Maria Silva");
      await serie.fill("ABC123");
      await obs.fill("Sem avarias.");
      await page.locator(`#termos-${termo}-item-01-nao`).check();
      const limpar = page.locator(`#termos-painel-${termo}`).getByRole("button", { name: "Limpar", exact: true });

      await limpar.click();
      await expect(tituloConfirmar(page)).toHaveText("Limpar o termo?");
      await recusar(page);
      await expect(modalConfirmar(page)).toBeHidden();
      await expect(nome).toHaveValue("Maria Silva");
      await expect(serie).toHaveValue("ABC123");
      await expect(obs).toHaveValue("Sem avarias.");
      await expect(page.locator(`#termos-${termo}-item-01-nao`)).toBeChecked();

      await limpar.click();
      await expect(tituloConfirmar(page)).toHaveText("Limpar o termo?");
      await aceitar(page);
      await expect(nome).toHaveValue("");
      await expect(serie).toHaveValue("");
      await expect(obs).toHaveValue("");
      await expect(page.locator(`#termos-form-${termo} input[value="sim"]:checked`)).toHaveCount(11);
      await expect(page.locator(`#termos-form-${termo} input[value="nao"]:checked`)).toHaveCount(0);
    }
  });

  test("Termos, Preencher no Termo com o formulário preenchido: pede 'Substituir o termo?', recusar mantém o formulário e confirmar troca", async ({ page }) => {
    expect((await page.request.get("/__fixture_lembretes?itens=0")).ok()).toBeTruthy();
    const criado = await page.request.post("/api/lembretes", { data: { descricao: "Termo de entrega de Maria Teste", origem: "entrega", termo: TERMO_ENTREGA } });
    expect(criado.ok()).toBeTruthy();
    await page.goto("/");
    await abrirFerramentaLembretes(page);

    await page.locator("#termos-aba-entrega").click();
    await page.locator("#termos-entrega-nome").fill("Outro Nome");
    await page.locator("#termos-entrega-serie-entregue").fill("ZZZ999");
    await page.locator("#termos-entrega-obs").fill("Texto que já estava no formulário.");
    await page.locator("#termos-aba-lembretes").click();
    await expect(page.locator("#termos-painel-lembretes")).toBeVisible();

    const bloco = pendentes(page).first().locator("details.lembretes__termo");
    await bloco.locator("summary").click();
    const preencher = bloco.getByRole("button", { name: "Preencher no Termo", exact: true });

    await preencher.click();
    await expect(tituloConfirmar(page)).toHaveText("Substituir o termo?");
    await recusar(page);
    await expect(modalConfirmar(page)).toBeHidden();
    await expect(page.locator("#termos-aba-lembretes")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#termos-entrega-nome")).toHaveValue("Outro Nome");
    await expect(page.locator("#termos-entrega-serie-entregue")).toHaveValue("ZZZ999");
    await expect(page.locator("#termos-entrega-obs")).toHaveValue("Texto que já estava no formulário.");

    await preencher.click();
    await expect(tituloConfirmar(page)).toHaveText("Substituir o termo?");
    await aceitar(page);
    await expect(page.locator("#termos-aba-entrega")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#termos-entrega-nome")).toHaveValue("Maria Teste");
    await expect(page.locator("#termos-entrega-serie-entregue")).toHaveValue("NOVA456");
    await expect(page.locator("#termos-entrega-obs")).toHaveValue("Sem avarias.");
  });

  // Não há botão: a Home chama termosPreencherDoEquipamento a cada equipamento exibido, sem abrir o painel nem confirmar.
  // O mesmo equipamento reexibido não desfaz o que o usuário digitou; outra série troca os campos que a Home preenche.
  test("Busca na Home preenche Termos Entrega e Devolução; mesma série mantém o digitado e outra série troca", async ({ page }) => {
    // Três buscas e três aberturas do painel num navegador sem GPU: ~13 s de corpo, perto demais do limite de 20 s.
    test.slow();
    expect((await page.request.get("/__fixture_lembretes?itens=0")).ok()).toBeTruthy();
    const EQUIPAMENTOS = {
      "SINT-001": { modelo: "Notebook Sintético A", nome_pessoa: "Maria Teste" },
      "SINT-002": { modelo: "Notebook Sintético B", nome_pessoa: "João Teste" },
    };
    await page.route("**/api/equipamento/*", route => {
      const serie = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
      return route.fulfill({ json: { serial: serie, tipo: "Notebook", apelido: "DEMO-001", retirada_cidade: "Curitiba", ...EQUIPAMENTOS[serie] } });
    });
    // Sem movimento: a Home anima o cartão do equipamento e, sem isso, cada busca fica lenta no navegador de teste.
    await page.emulateMedia({ reducedMotion: "reduce" });
    // A lista da Home (a fixture demora 2 s por leitura) não faz parte do que se prova aqui.
    await page.route("**/api/buscar-expandida*", route => route.fulfill({ json: {
      items: [], total: 0, offset: 0, limit: 50, has_more: false, filters: { categories: [], cities: [], users: { sem: 0, com: 0 } },
    } }));
    await page.goto("/");

    // O apelido do Home é reescrito a cada exibição: serve de marcador de que a busca terminou, inclusive na mesma série.
    // Gravado sem checar visibilidade (com o painel aberto a Home pode estar escondida) para nunca sobrar o valor da busca anterior.
    const marcador = page.locator("#input-powershell-hostname");
    const painelLembretes = page.locator('[data-cockpit-tool-panel="lembretes"]');
    async function buscar(serie) {
      await marcador.evaluate(campo => { campo.value = "marcador"; });
      await page.locator("#input-serial").fill(serie);
      await page.locator("#btn-buscar-serial").click();
      await expect(page.locator("#card-serial")).toHaveText(serie);
      await expect(marcador).toHaveValue("DEMO-001");
    }
    const campos = {
      entrega: { nome: "#termos-entrega-nome", modelo: "#termos-entrega-modelo-entregue", serie: "#termos-entrega-serie-entregue" },
      devolucao: { nome: "#termos-devolucao-nome", modelo: "#termos-devolucao-modelo", serie: "#termos-devolucao-serie" },
    };
    async function conferir(serie) {
      const { modelo, nome_pessoa: nomePessoa } = EQUIPAMENTOS[serie];
      for (const termo of ["entrega", "devolucao"]) {
        await page.locator(`#termos-aba-${termo}`).click();
        await expect(page.locator(`#termos-painel-${termo}`)).toBeVisible();
        await expect(page.locator(campos[termo].nome)).toHaveValue(nomePessoa);
        await expect(page.locator(campos[termo].modelo)).toHaveValue(modelo);
        await expect(page.locator(campos[termo].serie)).toHaveValue(serie);
        // Item 02 (Notebook): o equipamento buscado é o notebook do termo.
        await expect(page.locator(`#termos-${termo}-item-02-sim`)).toBeChecked();
      }
    }
    const escritas = gravarEscritas(page, "/api/lembretes");

    await buscar("SINT-001");
    // A busca só preenche os formulários: o painel não abre sozinho e nada pede confirmação.
    await expect(painelLembretes).toBeHidden();
    await expect(modalConfirmar(page)).toBeHidden();
    await abrirFerramentaLembretes(page);
    await conferir("SINT-001");

    // O usuário muda o nome e reexibe a mesma série (salvar a edição cadastral faz isso): nada se desfaz.
    await page.locator("#termos-aba-entrega").click();
    await page.locator(campos.entrega.nome).fill("Digitado à mão");
    await buscar("SINT-001");
    await expect(modalConfirmar(page)).toBeHidden();
    await abrirFerramentaLembretes(page);
    await page.locator("#termos-aba-entrega").click();
    await expect(page.locator(campos.entrega.nome)).toHaveValue("Digitado à mão");
    await expect(page.locator(campos.entrega.modelo)).toHaveValue("Notebook Sintético A");

    // Outra série: os campos que a Home preenche voltam a ser os do novo equipamento.
    await buscar("SINT-002");
    await expect(modalConfirmar(page)).toBeHidden();
    await abrirFerramentaLembretes(page);
    await conferir("SINT-002");
    // Só preenche o formulário: nenhum lembrete é criado ou alterado.
    expect(escritas).toEqual([]);
  });

  test("Excluir lembrete: Cancelar e Esc não enviam DELETE; Excluir envia um só DELETE em /api/lembretes/<id>", async ({ page }) => {
    expect((await page.request.get("/__fixture_lembretes?itens=0")).ok()).toBeTruthy();
    const criado = await api(page, "/api/lembretes", { descricao: "Lembrete para excluir" });
    const id = criado.id ?? criado.lembrete?.id;
    expect(id).toBeTruthy();
    const exclusoes = [];
    page.on("request", requisicao => {
      const caminho = new URL(requisicao.url()).pathname;
      if (requisicao.method() === "DELETE" && caminho.startsWith("/api/lembretes")) exclusoes.push(caminho);
    });
    await page.goto("/");
    await abrirFerramentaLembretes(page);
    await expect(pendentes(page)).toHaveCount(1);
    const excluirItem = page.getByRole("button", { name: "Excluir lembrete", exact: true });
    const pergunta = page.getByRole("alertdialog", { name: "Excluir este lembrete?" });

    await excluirItem.click();
    await expect(pergunta).toBeVisible();
    await expect(pergunta).toContainText("Lembrete para excluir");
    await pergunta.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(pergunta).toBeHidden();
    expect(exclusoes).toEqual([]);
    await expect(pendentes(page)).toHaveCount(1);

    await excluirItem.click();
    await expect(pergunta).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pergunta).toBeHidden();
    expect(exclusoes).toEqual([]);
    await expect(pendentes(page)).toHaveCount(1);

    await excluirItem.click();
    await expect(pergunta).toBeVisible();
    await pergunta.getByRole("button", { name: "Excluir", exact: true }).click();
    await expect(pendentes(page)).toHaveCount(0);
    // Um só DELETE: se Cancelar ou Esc tivessem enviado, haveria mais de um.
    expect(exclusoes).toEqual([`/api/lembretes/${id}`]);
  });
});
