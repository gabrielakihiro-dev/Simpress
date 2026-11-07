const { test, expect } = require("@playwright/test");

// Cobertura (F10) sobre o roteador real da cobertura, servido pela fixture com dados sintéticos e data fixa.
// Cenário base V1-V4 em Cidade A: SINT-001 local (Atendível), SINT-002 vem de Cidade B (Transferência),
// SINT-003 volta em 15/11 (Condicionada) e a quarta vaga fica Sem cobertura.

async function cenario(page, nome = "base") {
  const resposta = await page.request.get(`/__fixture_cobertura?cenario=${nome}`);
  expect(resposta.ok()).toBeTruthy();
}

async function api(page, caminho, corpo) {
  const resposta = corpo === undefined ? await page.request.get(caminho) : await page.request.post(caminho, { data: corpo });
  expect(resposta.ok(), await resposta.text()).toBeTruthy();
  return resposta.json();
}

// Reserva a série e marca o kit inteiro pela API, deixando a reserva pronta para preparar a movimentação.
async function reservaPronta(page, serie) {
  const leitura = await api(page, "/api/cobertura");
  const vaga = leitura.vagas.find(v => v.serie === serie);
  let reserva = await api(page, "/api/cobertura/reservas", { demanda_id: vaga.demanda_id, serie });
  for (const item of Object.keys(reserva.kit)) {
    reserva = await api(page, `/api/cobertura/reservas/${reserva.id}/kit`, { item, marcado: true, rev: reserva.rev });
  }
  return reserva;
}

async function abrirCobertura(page) {
  await page.locator("#input-serial").focus();
  await page.keyboard.press("F10");
  await expect(page.locator('[data-cockpit-tool-panel="cobertura"]')).toBeVisible();
  await expect(page.locator("#cobertura-status")).toContainText("Cobertura atualizada");
}

const aba = (page, nome) => page.locator(`#cobertura-aba-${nome}`).click();

test("F10 abre a Cobertura mesmo com o cursor num campo e F1-F9 continuam iguais", async ({ page }) => {
  await cenario(page);
  await page.goto("/");
  await page.evaluate(() => window.addEventListener("keydown", event => { if (event.key === "F10") window.__f10 = event.defaultPrevented; }));
  await page.locator("#input-serial").fill("SINT");
  await abrirCobertura(page);
  expect(await page.evaluate(() => window.__f10)).toBe(true);
  await expect(page.locator("#input-serial")).toHaveValue("SINT");
  await expect(page.locator("#cockpit-tool-kbd")).toHaveText("F10");
  for (const [tecla, seletor] of [["F8", '[data-cockpit-tool-panel="relatorio"]'], ["F1", "#tab-panel-home"], ["F2", "#tab-panel-retirada-entrega"]]) {
    await page.keyboard.press(tecla);
    await expect(page.locator(seletor), tecla).toBeVisible();
  }
});

test("abas com contagens, selos aprovados, alertas e navegação por teclado", async ({ page }) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);
  const contagens = page.locator("[data-cobertura-n]");
  await expect(contagens).toHaveText(["4", "2", "0", "0", "1"]);
  await expect(page.locator('[data-cobertura-alerta="sem_cobertura"]')).toContainText("Vagas sem cobertura: 1");
  const lista = page.locator("#cobertura-lista-necessidades");
  for (const texto of ["Atendível", "Condicionada", "Sem cobertura", "Transferência"]) await expect(lista.getByText(texto, { exact: true }).first()).toBeVisible();
  await expect(lista.getByRole("button", { name: "Reservar em espera" })).toBeVisible();

  await page.locator("#cobertura-aba-necessidades").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#cobertura-aba-disponiveis")).toBeFocused();
  await expect(page.locator("#cobertura-aba-disponiveis")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#cobertura-painel-disponiveis")).toBeVisible();
  await expect(page.locator("#cobertura-painel-necessidades")).toBeHidden();
  await page.keyboard.press("End");
  await expect(page.locator("#cobertura-aba-devolucoes")).toBeFocused();
});

test("necessidade até o recebimento sem Transporte", async ({ page }) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);

  const form = page.locator("#cobertura-form-necessidade");
  await form.getByLabel("Data").fill("2026-11-25");
  await form.getByLabel("Cidade").fill("Cidade C");
  await form.getByLabel("Quantidade").fill("1");
  await form.getByRole("button", { name: "Registrar necessidade" }).click();
  await expect(page.locator("[data-cobertura-n='necessidades']")).toHaveText("5");
  await expect(page.locator('[data-cobertura-alerta="sem_cobertura"]')).toContainText("Vagas sem cobertura: 2");

  await page.getByRole("button", { name: "Reservar — SINT-001 para Cidade A" }).click();
  await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("1");
  await aba(page, "reservas");
  const reservas = page.locator("#cobertura-lista-reservas");
  for (const rotulo of ["Notebook", "Carregador", "Preparação"]) {
    await reservas.getByRole("checkbox", { name: rotulo }).check();
    await expect(reservas.getByRole("checkbox", { name: rotulo })).toBeChecked();
  }
  await expect(reservas.getByText("Kit pronto", { exact: true })).toBeVisible();
  await expect(reservas.getByRole("button", { name: "Renovar reserva — SINT-001" })).toBeVisible();
  await reservas.getByRole("button", { name: "Entregar sem Transporte — SINT-001" }).click();

  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("1");
  await aba(page, "movimento");
  const movimento = page.locator("#cobertura-lista-movimento");
  await expect(movimento).toContainText("Sem Transporte");
  await movimento.getByLabel("Recebido por").fill("Pessoa Sintética");
  await expect(movimento.getByLabel("Data do recebimento")).toHaveValue("2026-11-06");
  await movimento.getByRole("button", { name: "Recebida — SINT-001" }).click();
  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("0");
  await aba(page, "necessidades");
  await expect(page.locator("#cobertura-lista-necessidades").getByText("Entregue", { exact: true })).toBeVisible();
});

test("divergência no recebimento oferece as três resoluções", async ({ page }) => {
  await cenario(page);
  const reserva = await reservaPronta(page, "SINT-001");
  await api(page, "/api/cobertura/movimentacoes", { reserva_id: reserva.id, rev: reserva.rev, tipo: "local" });
  await page.goto("/");
  await abrirCobertura(page);
  await aba(page, "movimento");
  const movimento = page.locator("#cobertura-lista-movimento");
  await movimento.getByLabel("Recebido por").fill("Pessoa Sintética");
  await movimento.getByLabel("Tipo da divergência").selectOption("serie_diferente");
  await movimento.getByLabel("Série recebida").fill("SINT-009");
  await movimento.getByRole("button", { name: "Recebida com divergência — SINT-001" }).click();
  await expect(movimento.getByText("Recebida com divergência", { exact: true })).toBeVisible();
  await expect(movimento).toContainText("Série diferente");
  for (const rotulo of ["Aceitar e encerrar", "Corrigir série recebida", "Cancelar e reabrir vaga"]) {
    await expect(movimento.getByRole("button", { name: `${rotulo} — SINT-001` })).toBeVisible();
  }
  await movimento.getByRole("button", { name: "Aceitar e encerrar — SINT-001" }).click();
  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("0");
});

test("Preparar Transporte só preenche o Transporte e o vínculo usa a planilha já gerada", async ({ page }) => {
  await cenario(page);
  await reservaPronta(page, "SINT-002");
  const geracoes = [];
  const preparos = [];
  page.on("request", request => {
    if (request.url().includes("/api/gerar-planilha")) geracoes.push(request.url());
    if (request.method() === "POST" && request.url().endsWith("/api/cobertura/movimentacoes")) preparos.push(request.postDataJSON());
  });
  await page.goto("/");
  await abrirCobertura(page);
  await aba(page, "reservas");
  await expect(page.getByRole("button", { name: "Entregar sem Transporte — SINT-002" })).toHaveCount(0);
  await page.getByRole("button", { name: "Preparar Transporte — SINT-002" }).click();
  await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible({ timeout: 10_000 });
  expect(preparos).toEqual([expect.objectContaining({ tipo: "transporte", rev: expect.any(Number) })]);
  expect(geracoes).toEqual([]);

  await abrirCobertura(page);
  await aba(page, "movimento");
  const movimento = page.locator("#cobertura-lista-movimento");
  await movimento.getByRole("button", { name: "Vincular transferência já gerada — SINT-002" }).click();
  await expect(movimento).toContainText("Gere a planilha de novo no Transporte.");

  await api(page, "/__fixture_cobertura?historico=SINT-002&cidade=Cidade%20A");
  await page.keyboard.press("F1");
  await abrirCobertura(page);
  await aba(page, "movimento");
  await movimento.getByRole("button", { name: "Vincular transferência já gerada — SINT-002" }).click();
  await movimento.getByRole("button", { name: /^Vincular planilha de / }).click();
  await expect(movimento.getByText("Planilha gerada", { exact: true })).toBeVisible();
  await expect(movimento.getByRole("button", { name: "Coletada — SINT-002" })).toBeVisible();
  expect(geracoes).toEqual([]);
});

test("planilha baixada sem vínculo fica pendente e Tentar de novo liga a movimentação", async ({ page }) => {
  await cenario(page);
  const reserva = await reservaPronta(page, "SINT-002");
  const mov = await api(page, "/api/cobertura/movimentacoes", { reserva_id: reserva.id, rev: reserva.rev, tipo: "transporte" });
  const payload = {
    serial: "SINT-002", retirada_cidade: "Cidade B", entrega_cidade: "Cidade A", entrega_cnpj: "00.000.000/0001-91",
    entrega_endereco: "Rua Sintética, 1", entrega_contato: "Pessoa Sintética",
  };
  await page.addInitScript(item => {
    if (!sessionStorage.getItem("cobertura-semeada")) {
      localStorage.setItem("simpress:cobertura:sem-vinculo", JSON.stringify({ [item.movimentacao.id]: item }));
      sessionStorage.setItem("cobertura-semeada", "1");
    }
  }, { movimentacao: mov, payload, chave: mov.chave });
  await page.goto("/");
  await abrirCobertura(page);
  const alerta = page.locator('[data-cobertura-alerta="sem_vinculo"]');
  await expect(alerta).toContainText("Planilha baixada sem vínculo");
  await alerta.getByRole("button", { name: "Tentar de novo — série SINT-002" }).click();
  await expect(alerta).toHaveCount(0);
  await aba(page, "movimento");
  await expect(page.locator("#cobertura-lista-movimento").getByText("Planilha gerada", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("simpress:cobertura:sem-vinculo"))).toBeNull();
});

test("Cancelar movimentação preparada pede confirmação e devolve a reserva", async ({ page }) => {
  await cenario(page);
  const reserva = await reservaPronta(page, "SINT-002");
  await api(page, "/api/cobertura/movimentacoes", { reserva_id: reserva.id, rev: reserva.rev, tipo: "transporte" });
  await page.goto("/");
  await abrirCobertura(page);
  await aba(page, "movimento");
  const movimento = page.locator("#cobertura-lista-movimento");
  const cancelar = movimento.getByRole("button", { name: "Cancelar movimentação — SINT-002" });
  await cancelar.click();
  await page.locator("#btn-confirmar-acao-cancelar").click();
  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("1");
  await cancelar.click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("0");
  await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("1");
  const leitura = await api(page, "/api/cobertura");
  expect(leitura.casos.reservas[reserva.id].estado).toBe("ativa");
});

test("Cancelar movimentação gerada avisa que a planilha continua no histórico e devolve a reserva", async ({ page }) => {
  await cenario(page);
  const reserva = await reservaPronta(page, "SINT-002");
  const mov = await api(page, "/api/cobertura/movimentacoes", { reserva_id: reserva.id, rev: reserva.rev, tipo: "transporte" });
  const gerada = await api(page, `/api/cobertura/movimentacoes/${mov.id}/registrar-transferencia`, {
    chave: mov.chave, rev: mov.rev,
    payload: {
      serial: "SINT-002", retirada_cidade: "Cidade B", entrega_cidade: "Cidade A", entrega_cnpj: "00.000.000/0001-91",
      entrega_endereco: "Rua Sintética, 1", entrega_contato: "Pessoa Sintética",
    },
  });
  await page.goto("/");
  await abrirCobertura(page);
  await aba(page, "movimento");
  const movimento = page.locator("#cobertura-lista-movimento");
  const cancelar = movimento.getByRole("button", { name: "Cancelar movimentação — SINT-002" });
  await cancelar.click();
  const modal = page.locator("#modal-confirmar-acao");
  await expect(modal).toContainText("continua no histórico de transferências");
  await expect(modal).not.toContainText("já coletou a máquina");
  await page.locator("#btn-confirmar-acao-cancelar").click();
  // Coletada: o aviso extra pede confirmar que a máquina voltou, pois a série fica livre para outra demanda.
  await api(page, `/api/cobertura/movimentacoes/${mov.id}/estado`, { estado: "coletada", rev: gerada.movimentacao.rev });
  await page.goto("/");
  await abrirCobertura(page);
  await aba(page, "movimento");
  await cancelar.click();
  await expect(modal).toContainText("O Transporte já coletou a máquina: confirme que ela voltou antes de cancelar");
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("0");
  const leitura = await api(page, "/api/cobertura");
  expect(leitura.casos.reservas[reserva.id].estado).toBe("ativa");
});

test("manutenção não verificada pede confirmação e reserva com manutencao_conferida", async ({ page }) => {
  await cenario(page, "manutencao");
  const corpos = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith("/api/cobertura/reservas")) corpos.push(request.postDataJSON());
  });
  await page.goto("/");
  await abrirCobertura(page);
  await expect(page.locator('[data-cobertura-alerta="manutencao"]')).toContainText("Manutenção não verificada");
  await page.getByRole("button", { name: "Reservar — SINT-001 para Cidade A" }).click();
  await page.locator("#btn-confirmar-acao-cancelar").click();
  expect(corpos).toEqual([]);
  await page.getByRole("button", { name: "Reservar — SINT-001 para Cidade A" }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("1");
  expect(corpos).toEqual([expect.objectContaining({ serie: "SINT-001", manutencao_conferida: true })]);
});

test("estado ilegível (503) mostra o erro e não oferece nenhuma escrita", async ({ page }) => {
  await cenario(page, "ilegivel");
  await page.goto("/");
  await page.keyboard.press("F10");
  const painel = page.locator('[data-cockpit-tool-panel="cobertura"]');
  await expect(page.locator("#cobertura-status")).toContainText("ilegível");
  await expect(painel.locator("form[data-cobertura-escrita]")).toHaveCount(3);
  for (const form of await painel.locator("form[data-cobertura-escrita]").all()) await expect(form).toBeHidden();
  await expect(painel.locator(".cob__lista button")).toHaveCount(0);
  await expect(painel.getByRole("button", { name: /Registrar|Reservar|Confirmar disponível|Marcar/ })).toHaveCount(0);
});

test("409 recarrega a cobertura e mostra a mensagem do servidor", async ({ page }) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);
  await aba(page, "disponiveis");
  const atual = (await api(page, "/api/cobertura")).casos.disponibilidade.SINT001;
  await api(page, "/api/cobertura/disponibilidade", { serie: "SINT-001", estado: "disponivel", rev: atual.rev });
  await page.getByRole("button", { name: "Marcar manutenção — SINT-001" }).click();
  await expect(page.locator("#cobertura-status")).toHaveText("Este registro foi alterado por outra ação. Recarregue e tente de novo.");
  // Recarregou: o rev novo já está na tela e a mesma ação agora grava.
  await page.getByRole("button", { name: "Marcar manutenção — SINT-001" }).click();
  await expect(page.locator("#cobertura-lista-disponiveis")).toContainText("Em manutenção");
});

test("tabela no desktop, cards com os mesmos dados e ações no celular", async ({ page }, testInfo) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);
  const linha = page.locator("#cobertura-lista-necessidades tbody tr").first();
  const display = await linha.evaluate(node => getComputedStyle(node).display);
  expect(display).toBe(testInfo.project.name === "mobile" ? "grid" : "table-row");
  await expect(linha.locator("td[data-label='Situação']")).toContainText("Atendível");
  await expect(linha.getByRole("button", { name: "Reservar — SINT-001 para Cidade A" })).toBeVisible();
  const largura = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(largura).toBeLessThanOrEqual(0);
});
