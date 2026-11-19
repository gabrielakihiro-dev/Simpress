const { test, expect } = require("@playwright/test");

// Cobertura (F10) sobre o roteador real da cobertura, servido pela fixture com dados sintéticos e data fixa.
// Cenário base V1-V4 em Cidade A: SINT-001 local (Atendível), SINT-002 vem de Cidade B (Transferência),
// SINT-003 volta em 15/11 (Condicionada) e a quarta vaga fica Sem cobertura.
// Layout novo (opção B, bento): Necessidades e quatro cartões (Disponíveis, Reservas, Em movimento, Devoluções);
// Reservas, Em movimento e Devoluções abrem numa folha ("Abrir/Acompanhar/Receber — <série>").

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

// No celular mostra um bloco por vez (chips "Lista de equipamentos"); no desktop o grupo de chips nem aparece.
async function chip(page, rotulo) {
  const grupo = page.locator(".cob__chips");
  if (await grupo.isVisible()) await grupo.getByRole("button", { name: rotulo, exact: true }).click();
}

// Abre a folha de um item pelo botão do cartão e devolve o diálogo (o mesmo título da folha).
async function abrirFolha(page, rotuloDoChip, botao, tituloDaFolha) {
  await chip(page, rotuloDoChip);
  await page.getByRole("button", { name: botao, exact: true }).click();
  const folha = page.getByRole("dialog", { name: tituloDaFolha });
  await expect(folha).toBeVisible();
  return folha;
}

const confirmacao = page => page.locator("#modal-confirmar-acao");
const ehCelular = testInfo => testInfo.project.name === "mobile";

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

test("contagens, selos aprovados, alertas e blocos por chip no celular", async ({ page }, testInfo) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);
  // Cinco contagens, nesta ordem; a "Lista de disponíveis" tem selo de contagem próprio, sem data-cobertura-n.
  await expect(page.locator("[data-cobertura-n]")).toHaveText(["4", "2", "0", "0", "1"]);
  await expect(page.locator('[data-cobertura-alerta="sem_cobertura"]')).toContainText("Vagas sem cobertura: 1");
  await chip(page, "Necessidades");
  const lista = page.locator("#cobertura-lista-necessidades");
  for (const texto of ["Atendível", "Condicionada", "Sem cobertura", "Transferência"]) await expect(lista.getByText(texto, { exact: true }).first()).toBeVisible();
  await expect(lista.getByRole("button", { name: "Reservar em espera" })).toBeVisible();
  // "Reservar" mora no cartão Disponíveis, nunca na lista de Necessidades.
  await expect(lista.getByRole("button", { name: /^Reservar — / })).toHaveCount(0);

  const blocos = [
    ["Necessidades", "#cobertura-lista-necessidades"], ["Disponíveis", "#cobertura-lista-disponiveis"], ["Reservas", "#cobertura-lista-reservas"],
    ["Em movimento", "#cobertura-lista-movimento"], ["Devoluções", "#cobertura-lista-devolucoes"],
  ];
  if (ehCelular(testInfo)) {
    const grupo = page.locator(".cob__chips");
    for (const [rotulo, seletor] of blocos) {
      await grupo.getByRole("button", { name: rotulo, exact: true }).click();
      await expect(grupo.getByRole("button", { name: rotulo, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(seletor)).toBeVisible();
      for (const [, outro] of blocos.filter(([, s]) => s !== seletor)) await expect(page.locator(outro)).toBeHidden();
    }
  } else {
    await expect(page.locator(".cob__chips")).toBeHidden();
    for (const [, seletor] of blocos) await expect(page.locator(seletor)).toBeVisible();
  }
  // Listas vazias com o texto aprovado.
  await expect(page.locator("#cobertura-lista-reservas")).toContainText("Nenhuma reserva");
  await expect(page.locator("#cobertura-lista-movimento")).toContainText("Nada em movimento");
  await expect(page.locator("#cobertura-lista-devolucoes")).not.toContainText("Nenhuma devolução");
});

test("necessidade até o recebimento sem Transporte", async ({ page }) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);

  // O formulário de necessidade só existe dentro da folha "Registrar necessidade".
  await expect(page.locator("#cobertura-form-necessidade")).toHaveCount(0);
  await page.getByRole("button", { name: "Registrar necessidade", exact: true }).click();
  const folhaNecessidade = page.getByRole("dialog", { name: "Registrar necessidade" });
  const form = folhaNecessidade.locator("#cobertura-form-necessidade");
  await form.getByLabel("Data").fill("2026-11-25");
  await form.getByLabel("Cidade").fill("Cidade C");
  await form.getByLabel("Quantidade").fill("1");
  await form.getByRole("button", { name: "Registrar necessidade" }).click();
  await expect(folhaNecessidade).toBeHidden();
  await expect(page.locator("[data-cobertura-n='necessidades']")).toHaveText("5");
  await expect(page.locator('[data-cobertura-alerta="sem_cobertura"]')).toContainText("Vagas sem cobertura: 2");

  await page.getByRole("button", { name: "Reservar — SINT-001 para Cidade A" }).click();
  await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Reservar SINT-001?");
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("1");

  const reservas = await abrirFolha(page, "Reservas", "Abrir — SINT-001", "Reservas");
  // Rótulo do kit numa linha só: a célula herda overflow-wrap:anywhere e partia "Note book".
  const linhasPorRotulo = await reservas.locator(".cob__check span").evaluateAll(spans => spans.map(span => {
    const faixa = document.createRange();
    faixa.selectNodeContents(span);
    return new Set([...faixa.getClientRects()].map(r => Math.round(r.top))).size;
  }));
  expect(linhasPorRotulo).toEqual([1, 1, 1]);
  for (const rotulo of ["Notebook", "Carregador", "Preparação"]) {
    await reservas.getByRole("checkbox", { name: rotulo }).check();
    await expect(reservas.getByRole("checkbox", { name: rotulo })).toBeChecked();
    // O kit ignora clique enquanto grava (trava no ref, sem desabilitar a caixa): espera a gravação e a releitura terminarem.
    await expect(reservas.locator("fieldset.cob__kit")).not.toHaveAttribute("aria-busy", "true");
    // Sem `disabled` o foco não cai para o body.
    await expect(reservas.getByRole("checkbox", { name: rotulo })).toBeFocused();
  }
  await expect(reservas.getByText("Kit pronto", { exact: true })).toBeVisible();
  await expect(reservas.getByRole("button", { name: "Renovar reserva — SINT-001" })).toBeVisible();
  await reservas.getByRole("button", { name: "Entregar sem Transporte — SINT-001" }).click();

  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("1");
  // A reserva saiu da lista: a folha fecha sozinha.
  await expect(reservas).toBeHidden();
  const movimento = await abrirFolha(page, "Em movimento", "Acompanhar — SINT-001", "Em movimento");
  await expect(movimento).toContainText("Sem Transporte");
  await movimento.getByLabel("Recebido por").fill("Pessoa Sintética");
  await expect(movimento.getByLabel("Data do recebimento")).toHaveValue("2026-11-06");
  await movimento.getByRole("button", { name: "Confirmar recebimento — SINT-001" }).click();
  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("0");
  await expect(movimento).toBeHidden();
  await chip(page, "Necessidades");
  await expect(page.locator("#cobertura-lista-necessidades").getByText("Entregue", { exact: true })).toBeVisible();
});

test("Reservar confirma com a cidade da vaga, avisa e Desfazer cancela sem nova confirmação", async ({ page }) => {
  await cenario(page);
  const corpos = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith("/api/cobertura/reservas")) corpos.push(request.postDataJSON());
  });
  await page.goto("/");
  await abrirCobertura(page);
  const avisos = page.locator(".cob__avisos");
  await expect(avisos).toHaveAttribute("role", "status");
  await expect(avisos).toHaveAttribute("aria-live", "polite");
  await expect(avisos).toBeEmpty();

  const reservar = page.getByRole("button", { name: "Reservar — SINT-001 para Cidade A" });
  await reservar.click();
  await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Reservar SINT-001?");
  await expect(page.locator("#mensagem-confirmar-acao")).toHaveText("Cidade A");
  await expect(page.locator("#btn-confirmar-acao-ok")).toHaveText("Confirmar");
  await expect(page.locator("#btn-confirmar-acao-cancelar")).toHaveText("Cancelar");
  await page.locator("#btn-confirmar-acao-cancelar").click();
  expect(corpos).toEqual([]);
  await expect(avisos).toBeEmpty();

  await reservar.click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("1");
  await expect(avisos).toContainText("SINT-001 reservado");
  expect(corpos).toEqual([expect.objectContaining({ serie: "SINT-001", manutencao_conferida: false })]);

  await avisos.getByRole("button", { name: "Desfazer", exact: true }).click();
  await expect(avisos).toContainText("SINT-001 voltou para Disponíveis");
  // Sem janela de confirmação: o cancelamento é direto.
  await expect(confirmacao(page)).toBeHidden();
  await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("0");
  const leitura = await api(page, "/api/cobertura");
  expect(Object.values(leitura.casos.reservas).filter(reserva => reserva.estado === "ativa")).toEqual([]);
});

test("divergência no recebimento oferece as três resoluções", async ({ page }) => {
  await cenario(page);
  const reserva = await reservaPronta(page, "SINT-001");
  await api(page, "/api/cobertura/movimentacoes", { reserva_id: reserva.id, rev: reserva.rev, tipo: "local" });
  await page.goto("/");
  await abrirCobertura(page);
  const movimento = await abrirFolha(page, "Em movimento", "Acompanhar — SINT-001", "Em movimento");
  await movimento.getByLabel("Recebido por").fill("Pessoa Sintética");
  await movimento.getByLabel("Tipo da divergência").selectOption("serie_diferente");
  await movimento.getByLabel("Série recebida").fill("SINT-009");
  await movimento.getByRole("button", { name: "Registrar divergência — SINT-001" }).click();
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
  const reservas = await abrirFolha(page, "Reservas", "Abrir — SINT-002", "Reservas");
  await expect(reservas.getByRole("button", { name: "Entregar sem Transporte — SINT-002" })).toHaveCount(0);
  await reservas.getByRole("button", { name: "Preparar Transporte — SINT-002" }).click();
  await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible({ timeout: 10_000 });
  expect(preparos).toEqual([expect.objectContaining({ tipo: "transporte", rev: expect.any(Number) })]);
  expect(geracoes).toEqual([]);

  // Sair da Cobertura fecha a folha: ao voltar ela não reaparece aberta.
  await abrirCobertura(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  let movimento = await abrirFolha(page, "Em movimento", "Acompanhar — SINT-002", "Em movimento");
  await movimento.getByRole("button", { name: "Vincular transferência já gerada — SINT-002" }).click();
  await expect(movimento).toContainText("Gere a planilha de novo no Transporte.");
  // F1 com a folha aberta sai da Cobertura e fecha a folha: ao voltar pelo F10 ela não reaparece aberta nem deixa o véu na frente.
  await page.keyboard.press("F1");
  await abrirCobertura(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".nl-veu")).toHaveCount(0);

  await api(page, "/__fixture_cobertura?historico=SINT-002&cidade=Cidade%20A");
  await page.keyboard.press("F1");
  await abrirCobertura(page);
  movimento = await abrirFolha(page, "Em movimento", "Acompanhar — SINT-002", "Em movimento");
  await movimento.getByRole("button", { name: "Vincular transferência já gerada — SINT-002" }).click();
  await movimento.getByRole("button", { name: /^Vincular esta planilha — / }).click();
  await expect(movimento.getByText("Planilha gerada", { exact: true })).toBeVisible();
  await expect(movimento.getByRole("button", { name: "Marcar coletada — SINT-002" })).toBeVisible();
  expect(geracoes).toEqual([]);
});

test("planilha baixada sem vínculo fica pendente e Tentar vincular de novo liga a movimentação", async ({ page }) => {
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
  await alerta.getByRole("button", { name: "Tentar vincular de novo — série SINT-002" }).click();
  await expect(alerta).toHaveCount(0);
  const movimento = await abrirFolha(page, "Em movimento", "Acompanhar — SINT-002", "Em movimento");
  await expect(movimento.getByText("Planilha gerada", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("simpress:cobertura:sem-vinculo"))).toBeNull();
});

test("Cancelar movimentação preparada pede confirmação e devolve a reserva", async ({ page }) => {
  await cenario(page);
  const reserva = await reservaPronta(page, "SINT-002");
  await api(page, "/api/cobertura/movimentacoes", { reserva_id: reserva.id, rev: reserva.rev, tipo: "transporte" });
  await page.goto("/");
  await abrirCobertura(page);
  const movimento = await abrirFolha(page, "Em movimento", "Acompanhar — SINT-002", "Em movimento");
  const cancelar = movimento.getByRole("button", { name: "Cancelar movimentação — SINT-002" });
  await cancelar.click();
  await page.locator("#btn-confirmar-acao-cancelar").click();
  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("1");
  await expect(movimento).toBeVisible();
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
  let movimento = await abrirFolha(page, "Em movimento", "Acompanhar — SINT-002", "Em movimento");
  let cancelar = movimento.getByRole("button", { name: "Cancelar movimentação — SINT-002" });
  await cancelar.click();
  const modal = confirmacao(page);
  await expect(modal).toContainText("continua no histórico de transferências");
  await expect(modal).not.toContainText("já coletou a máquina");
  await page.locator("#btn-confirmar-acao-cancelar").click();
  // Coletada: o aviso extra pede confirmar que a máquina voltou, pois a série fica livre para outra demanda.
  await api(page, `/api/cobertura/movimentacoes/${mov.id}/estado`, { estado: "coletada", rev: gerada.movimentacao.rev });
  await page.goto("/");
  await abrirCobertura(page);
  movimento = await abrirFolha(page, "Em movimento", "Acompanhar — SINT-002", "Em movimento");
  cancelar = movimento.getByRole("button", { name: "Cancelar movimentação — SINT-002" });
  await cancelar.click();
  await expect(modal).toContainText("O Transporte já coletou a máquina: confirme que ela voltou antes de cancelar");
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(page.locator("[data-cobertura-n='movimento']")).toHaveText("0");
  const leitura = await api(page, "/api/cobertura");
  expect(leitura.casos.reservas[reserva.id].estado).toBe("ativa");
});

test("manutenção não verificada pede só a confirmação de manutenção e reserva com manutencao_conferida", async ({ page }) => {
  await cenario(page, "manutencao");
  const corpos = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith("/api/cobertura/reservas")) corpos.push(request.postDataJSON());
  });
  await page.goto("/");
  await abrirCobertura(page);
  await expect(page.locator('[data-cobertura-alerta="manutencao"]')).toContainText("Manutenção não verificada");
  await page.getByRole("button", { name: "Reservar — SINT-001 para Cidade A" }).click();
  // Com manutenção não verificada vale só esta confirmação, sem a de "Reservar <série>?".
  await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Manutenção não verificada");
  await page.locator("#btn-confirmar-acao-cancelar").click();
  expect(corpos).toEqual([]);
  await page.getByRole("button", { name: "Reservar — SINT-001 para Cidade A" }).click();
  await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Manutenção não verificada");
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("1");
  await expect(confirmacao(page)).toBeHidden();
  expect(corpos).toEqual([expect.objectContaining({ serie: "SINT-001", manutencao_conferida: true })]);
});

test("estado ilegível (503) mostra o erro e não oferece nenhuma escrita", async ({ page }) => {
  await cenario(page, "ilegivel");
  await page.goto("/");
  await page.keyboard.press("F10");
  const painel = page.locator('[data-cockpit-tool-panel="cobertura"]');
  await expect(page.locator("#cobertura-status")).toContainText("ilegível");
  // O status é só para leitor de tela: o erro precisa aparecer também no aviso visível.
  await expect(page.locator("#toast-container")).toContainText("ilegível");
  // Sem dados lidos, a tabela não afirma "Nenhuma máquina registrada.".
  await expect(painel.getByText("Nenhuma máquina registrada.")).toHaveCount(0);
  // Os formulários de Disponíveis e Devoluções ficam no DOM, escondidos; o de necessidade só existe dentro da folha.
  await expect(painel.locator("form[data-cobertura-escrita]")).toHaveCount(2);
  for (const form of await painel.locator("form[data-cobertura-escrita]").all()) await expect(form).toBeHidden();
  await expect(painel.locator(".cob__item button")).toHaveCount(0);
  await expect(painel.getByRole("button", { name: /Registrar|Reservar|Confirmar disponível|Marcar|Abrir|Acompanhar|Receber/ })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // O erro também encerra o carregamento: nenhuma lista fica presa em aria-busy.
  await expect(painel.locator("[id^='cobertura-lista-'][aria-busy], #cobertura-alertas[aria-busy]")).toHaveCount(0);
});

test("enquanto lê a cobertura o status mostra Carregando… e as listas ficam com aria-busy", async ({ page }) => {
  await cenario(page);
  let soltar;
  const portao = new Promise(resolve => { soltar = resolve; });
  await page.route("**/api/cobertura", async route => {
    await portao;
    await route.continue();
  });
  try {
    await page.goto("/");
    await page.locator("#input-serial").focus();
    await page.keyboard.press("F10");
    await expect(page.locator('[data-cockpit-tool-panel="cobertura"]')).toBeVisible();
    const status = page.locator("#cobertura-status");
    await expect(status).toHaveText("Carregando…");
    await expect(page.locator("#cobertura-lista-necessidades")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("[id^='cobertura-lista-'][aria-busy='true']")).toHaveCount(5);
    await expect(page.locator("#cobertura-alertas")).toHaveAttribute("aria-busy", "true");
    // O aria-busy não pode subir para o aria-live: ancestral ocupado engole o anúncio.
    await expect(page.locator("[aria-busy]:has(#cobertura-status)")).toHaveCount(0);
    await expect(page.locator("[aria-busy]:has(.cob__avisos)")).toHaveCount(0);
  } finally {
    soltar();
  }
  await expect(page.locator("#cobertura-status")).toContainText("Cobertura atualizada");
  await expect(page.locator("[id^='cobertura-lista-'][aria-busy], #cobertura-alertas[aria-busy]")).toHaveCount(0);
});

test("409 recarrega a cobertura e mostra a mensagem do servidor", async ({ page }) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);
  const atual = (await api(page, "/api/cobertura")).casos.disponibilidade.SINT001;
  await api(page, "/api/cobertura/disponibilidade", { serie: "SINT-001", estado: "disponivel", rev: atual.rev });
  await page.getByRole("button", { name: "Marcar manutenção — SINT-001" }).click();
  await expect(page.locator("#cobertura-status")).toHaveText("Este registro foi alterado por outra ação. Recarregue e tente de novo.");
  // Recarregou: o rev novo já está na tela e a mesma ação agora grava.
  await page.getByRole("button", { name: "Marcar manutenção — SINT-001" }).click();
  await expect(page.locator("#cobertura-lista-disponiveis")).toContainText("Em manutenção");
});

test("404 recarrega a cobertura: a reserva que sumiu do servidor some da tela e a folha fecha", async ({ page }) => {
  await cenario(page);
  const leitura = await api(page, "/api/cobertura");
  const vaga = leitura.vagas.find(v => v.serie === "SINT-001");
  await api(page, "/api/cobertura/reservas", { demanda_id: vaga.demanda_id, serie: "SINT-001" });
  await page.goto("/");
  await abrirCobertura(page);
  const reservas = await abrirFolha(page, "Reservas", "Abrir — SINT-001", "Reservas");
  await expect(reservas.getByRole("checkbox", { name: "Notebook" })).toBeVisible();
  await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("1");

  // O cenário recria o estado do servidor: a reserva deixa de existir, mas continua na tela.
  await cenario(page);
  await reservas.getByRole("checkbox", { name: "Notebook" }).check();
  await expect(page.locator("#cobertura-status")).toHaveText("Reserva não encontrada.");
  await expect(reservas).toBeHidden();
  await expect(page.locator("[data-cobertura-n='reservas']")).toHaveText("0");
  // O botão que abriu a folha também sumiu: o foco vai para o título do painel, nunca para o body.
  await expect(page.locator("#cobertura-heading")).toBeFocused();
});

test("Esc e Tab sobre a confirmação ficam na confirmação; a folha por baixo continua aberta", async ({ page }) => {
  await cenario(page);
  const leitura = await api(page, "/api/cobertura");
  const vaga = leitura.vagas.find(v => v.serie === "SINT-001");
  await api(page, "/api/cobertura/reservas", { demanda_id: vaga.demanda_id, serie: "SINT-001" });
  const cancelamentos = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/cancelar")) cancelamentos.push(request.url());
  });
  await page.goto("/");
  await abrirCobertura(page);
  const folha = await abrirFolha(page, "Reservas", "Abrir — SINT-001", "Reservas");
  const modal = confirmacao(page);
  const dentroDaConfirmacao = () => page.evaluate(() => Boolean(document.activeElement?.closest("#modal-confirmar-acao")));

  await folha.getByRole("button", { name: "Cancelar reserva — SINT-001" }).click();
  await expect(modal).toBeVisible();
  // Tab e Shift+Tab não escapam da confirmação para a folha de trás.
  for (const tecla of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(tecla);
    await expect.poll(dentroDaConfirmacao, { message: `foco depois de ${tecla}` }).toBe(true);
  }
  // Esc fecha só a confirmação: nada é cancelado e a folha continua aberta.
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(folha).toBeVisible();
  expect(cancelamentos).toEqual([]);
  // Sem confirmação por cima, o Esc seguinte fecha a folha e deixa o painel da Cobertura aberto.
  await page.keyboard.press("Escape");
  await expect(folha).toBeHidden();
  await expect(page.locator('[data-cockpit-tool-panel="cobertura"]')).toBeVisible();
});

test("Registrar necessidade: botão da barra abre a folha, Esc fecha e devolve o foco ao botão", async ({ page }) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);
  const botao = page.getByRole("button", { name: "Registrar necessidade", exact: true });
  await botao.click();
  const folha = page.getByRole("dialog", { name: "Registrar necessidade" });
  await expect(folha).toBeVisible();
  // O botão da folha tem o mesmo nome do da barra: os dois existem, cada um no seu lugar.
  await expect(folha.getByRole("button", { name: "Registrar necessidade", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(folha).toBeHidden();
  await expect(botao).toBeFocused();
  await expect(page.locator('[data-cockpit-tool-panel="cobertura"]')).toBeVisible();
});

test("busca por série e cidade e filtro de tipo refazem os cartões", async ({ page }) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);
  const contagens = page.locator("[data-cobertura-n]");
  const busca = page.getByRole("searchbox", { name: "Buscar na Cobertura" });

  await busca.fill("sint-002");
  await expect(contagens).toHaveText(["1", "1", "0", "0", "0"]);
  await busca.fill("");
  await expect(contagens).toHaveText(["4", "2", "0", "0", "1"]);
  // Cidade sem acento nem caixa: a mesma busca dobrada que as outras abas usam.
  await busca.fill("CIDADE b");
  const leituraCidade = await api(page, "/api/cobertura");
  const emCidadeB = Object.values(leituraCidade.casos.disponibilidade).filter(reg => String(reg.cidade || "").toLowerCase().includes("cidade b")).length;
  await expect(page.locator("[data-cobertura-n='disponiveis']")).toHaveText(String(emCidadeB));
  await busca.fill("");
  // A cidade da vaga ligada também conta: SINT-002 está em Cidade B, mas a vaga que ele atende é de Cidade A; o Reservar não some.
  await busca.fill("cidade a");
  await expect(page.locator("[data-cobertura-n='disponiveis']")).toHaveText("2");
  await chip(page, "Disponíveis");
  await expect(page.getByRole("button", { name: "Reservar — SINT-002 para Cidade A" })).toBeVisible();
  await busca.fill("");

  // Tipo: o filtro lê o perfil da necessidade ligada; sem perfil conhecido o item só aparece em "Todos".
  await page.getByRole("button", { name: "Registrar necessidade", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Registrar necessidade" }).locator("#cobertura-form-necessidade");
  await form.getByLabel("Data").fill("2026-11-25");
  await form.getByLabel("Cidade").fill("Cidade C");
  await form.getByLabel("Perfil").fill("Notebook");
  await form.getByRole("button", { name: "Registrar necessidade" }).click();
  await expect(contagens).toHaveText(["5", "2", "0", "0", "1"]);
  const tipo = page.getByRole("group", { name: "Tipo de equipamento" });
  await expect(tipo.getByRole("button", { name: "Todos", exact: true })).toHaveAttribute("aria-pressed", "true");
  await tipo.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(tipo.getByRole("button", { name: "Notebook", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(contagens).toHaveText(["1", "0", "0", "0", "0"]);
  await tipo.getByRole("button", { name: "Desktop", exact: true }).click();
  await expect(contagens).toHaveText(["0", "0", "0", "0", "0"]);
  await tipo.getByRole("button", { name: "Todos", exact: true }).click();
  await expect(contagens).toHaveText(["5", "2", "0", "0", "1"]);
});

test("cada cartão mostra até 4 itens e Ver todos abre o resto", async ({ page }) => {
  await cenario(page);
  for (const serie of ["SINT-004", "SINT-005", "SINT-006"]) await api(page, "/api/cobertura/disponibilidade", { serie, estado: "disponivel", cidade: "Cidade A" });
  await page.goto("/");
  await abrirCobertura(page);
  const lista = page.locator("#cobertura-lista-disponiveis");
  await expect(page.locator("[data-cobertura-n='disponiveis']")).toHaveText("5");
  await expect(lista.locator("li.cob__item")).toHaveCount(4);
  const mais = page.getByRole("button", { name: "Ver todos os 5 →" });
  await expect(mais).toHaveAttribute("aria-expanded", "false");
  await mais.click();
  await expect(lista.locator("li.cob__item")).toHaveCount(5);
  await page.getByRole("button", { name: "Mostrar menos" }).click();
  await expect(lista.locator("li.cob__item")).toHaveCount(4);
});

test("tabela no desktop, cards com os mesmos dados e ações no celular", async ({ page }, testInfo) => {
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);
  const linha = page.locator('[data-cockpit-tool-panel="cobertura"] .nl-tabela__lin').first();
  const display = await linha.evaluate(node => getComputedStyle(node).display);
  expect(display).toBe(ehCelular(testInfo) ? "grid" : "table-row");
  await expect(linha.locator("td[data-rotulo='Situação']")).toContainText("Disponível");
  await expect(linha.locator("td[data-rotulo='Ações']").getByRole("button", { name: "Confirmar disponível — SINT-001" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Lista de disponíveis" })).toBeAttached();
  const largura = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(largura).toBeLessThanOrEqual(0);
});

test("no celular Registrar necessidade vira barra fixa embaixo e continua à vista ao rolar", async ({ page }, testInfo) => {
  test.skip(!ehCelular(testInfo), "barra fixa é só do celular");
  await cenario(page);
  await page.goto("/");
  await abrirCobertura(page);
  const botao = page.getByRole("button", { name: "Registrar necessidade", exact: true });
  const altura = page.viewportSize().height;
  const largura = page.viewportSize().width;
  const medir = async () => botao.evaluate(no => { const c = no.getBoundingClientRect(); return { fundo: c.bottom, topo: c.top, largura: c.width }; });
  const antes = await medir();
  expect(antes.fundo).toBeLessThanOrEqual(altura);
  expect(antes.largura).toBeGreaterThan(largura - 48);
  // Rola o painel até o fim: a barra acompanha, sempre dentro da janela.
  await page.evaluate(() => {
    for (const no of document.querySelectorAll("#cockpit-tool-panels, [data-cockpit-tool-panel='cobertura']")) no.scrollTop = no.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
  const depois = await medir();
  expect(depois.fundo).toBeLessThanOrEqual(altura);
  expect(depois.topo).toBeGreaterThanOrEqual(0);
});
