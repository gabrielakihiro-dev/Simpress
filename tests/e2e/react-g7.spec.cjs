// Migração React, Dia 3, grupo G7: ticket UX (Transporte), E-mail pelo Outlook, Automação do Chrome e Assistente.
// Os invariantes de envio e o baseline de screenshots foram gravados com o código antigo (JS puro), antes da troca
// para React: os painéis em React têm de enviar exatamente os mesmos pedidos e sair iguais nos dois tamanhos
// (390 e 1366 px) e nos dois temas. Todas as rotas são simuladas: nenhum teste toca no UX, no Outlook nem no modelo.
const { test, expect } = require("@playwright/test");

const CAPTURA = { animations: "disabled", maxDiffPixelRatio: 0.01 };

// ---- Ticket UX (Transporte, F2): dados sintéticos copiados de ux-ticket.spec.cjs ----
const SESSION = "b".repeat(32);
const UNIDADE = {
  id: 7, cidade: "Cidade Teste", cep: "80000-000", cnpj: "11.111.111/0001-11",
  endereco_completo: "Rua Fictícia, 100 - Centro - Cidade Teste/PR",
};
const SOLICITANTE = { nome: "Pessoa Teste", email: "pessoa@exemplo.com", telefone: "(41) 90000-0000" };
const PREPARADO = {
  status: "preparado", session_id: SESSION, serial: "LENTO", modelo: "Notebook de demonstração", endereco: "Rua Fictícia, 100",
  opcoes_endereco: [], cnpj_instalacao: UNIDADE.cnpj, cnpj_faturamento: "11.222.333/0001-81",
  arquivo: "Transferencia_LENTO.xlsx", solicitante: SOLICITANTE, ultimo_envio: null,
};
const REGISTRO_OK = "Prezados,\n\nSolicito o deslocamento de um técnico.\n\nContato no local: Maria Teste\nColaborador(a) Novo(a): Fulano\nData de Instalação: 10/11/2026\nHorário da Instalação: 09h";
// Forma real da recusa do backend (domains/ux_chamados.py: MSG_SERIE_TESTE e MSG_SEM_ENVIO; ErroUX 422 sem código).
const RECUSA_SERIE_TESTE = "Esta série é de teste: só a simulação é permitida.";
const RECUSA_UX_SEM_ENVIO = "O envio real está desativado (SIMPRESS_UX_SEM_ENVIO). Só a simulação é permitida.";

// ---- Outlook: dados sintéticos copiados de outlook-email.spec.cjs ----
const EQUIPAMENTO = { serial: "LENTO", modelo: "Notebook de teste", tipo: "Notebook", apelido: "TESTE-001", nome_pessoa: "Pessoa Teste" };
const CONTAS = [
  { id: "sebrae", rotulo: "Sebrae", email: "conta1@exemplo.test", padrao: true },
  { id: "simpress", rotulo: "Simpress", email: "conta2@exemplo.test", padrao: false },
];
const CABO_PADRAO = {
  id: "cabo", nome: "Modelo 1 - Cabo", conta: "sebrae", para: "Ana Exemplo <ana@exemplo.test>", cc: "",
  assunto: "Cabo de segurança para {nome}", corpo: "Olá, {nome} do setor {setor}. Segue o cabo de segurança.",
};
const OUTLOOK_SUCESSO = "E-mail enviado pelo Outlook.";
const OUTLOOK_INCERTO = "Não foi possível confirmar o envio. Confira os Itens Enviados no Outlook antes de tentar de novo.";
// Forma real da recusa (domains/outlook_mail.py: ErroOutlook 422, codigo envio_desativado).
const OUTLOOK_SEM_ENVIO = { status: 422, json: { detail: "O envio real está desativado neste computador.", codigo: "envio_desativado" } };

// ---- Assistente: dados sintéticos copiados de assistente.spec.cjs ----
const PRONTO = { online: true, modelo: "modelo-teste", aguardando_confirmacao: false };
const PENDENTE = { descricao: "Abrir a pasta de entrada" };

async function prepararPagina(page, tema = "light", { alto = false } = {}) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  // Datas fixas e timers rodando: nada na tela muda com o relógio da máquina.
  await page.clock.setFixedTime(new Date("2026-11-10T12:00:00"));
  // Painéis altos: o painel inteiro cabe na captura nos dois tamanhos.
  if (alto) await page.setViewportSize({ width: page.viewportSize().width, height: 2000 });
}

// Portão: segura uma resposta simulada até `liberar()`, para o clique duplo cair com o pedido ainda em voo.
function portao() {
  const porta = {};
  porta.espera = new Promise(resolve => { porta.liberar = resolve; });
  return porta;
}

// ---------------------------------------------------------------------------------------------------------------
// Ticket UX
// ---------------------------------------------------------------------------------------------------------------

const padraoTicket = (etapa, corpo) => {
  if (etapa === "preparar") return { json: PREPARADO };
  if (etapa === "cancelar") return { json: { status: "cancelado" } };
  return { json: corpo.enviar ? { status: "enviado", ticket: "445566" } : { status: "preenchido" } };
};

// Abre o modal como o usuário: série LENTO, F2, unidade de destino, contatos, "Transporte" (baixa a planilha e abre o ticket).
// `ticket(etapa, corpo)` devolve { status?, json } ou "abortar"; cada pedido (menos "solicitante") fica em `chamadas`.
async function abrirTicket(page, ticket = padraoTicket) {
  const chamadas = [];
  await page.route("**/api/unidades", route => route.fulfill({ json: [UNIDADE] }));
  await page.route("**/api/gerar-planilha", route => route.fulfill({
    status: 200, body: "planilha-ficticia",
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="Transferencia_LENTO.xlsx"',
    },
  }));
  await page.route("**/api/ux/gerar-ticket/**", async route => {
    const etapa = new URL(route.request().url()).pathname.split("/").pop();
    if (etapa === "solicitante") return route.fulfill({ json: SOLICITANTE });
    const corpo = route.request().postDataJSON();
    chamadas.push({ etapa, corpo });
    const resposta = await ticket(etapa, corpo);
    if (resposta === "abortar") return route.abort();
    return route.fulfill({ status: resposta.status ?? 200, json: resposta.json });
  });
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await page.locator("#input-serial").focus();
  await page.keyboard.press("F2");
  await expect(page.locator("#btn-gerar-planilha")).toBeVisible();
  await page.evaluate(() => {
    const select = document.getElementById("select-unidade-destino");
    select.value = "7";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#entrega-cnpj")).toHaveText(UNIDADE.cnpj);
  const campos = {
    "retirada-contato": "Pessoa Retirada", "retirada-email": "retirada@exemplo.com", "retirada-telefone": "(41) 91111-1111",
    "retirada-obs": "Notebook + kit", "entrega-contato": "Maria Teste", "entrega-email": "entrega@exemplo.com",
    "entrega-telefone": "(41) 3333-0000", "entrega-obs": "Nova contratação",
  };
  for (const [id, valor] of Object.entries(campos)) await page.locator(`#${id}`).fill(valor);
  const download = page.waitForEvent("download");
  await page.locator("#btn-gerar-planilha").click();
  expect((await download).suggestedFilename()).toBe("Transferencia_LENTO.xlsx");
  const modal = page.getByRole("dialog", { name: "Gerar ticket no UX" });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
  return { chamadas, modal };
}

const envios = chamadas => chamadas.filter(({ etapa }) => etapa === "enviar");
const enviosReais = chamadas => chamadas.filter(({ corpo }) => corpo.enviar === true);

// ---------------------------------------------------------------------------------------------------------------
// Outlook
// ---------------------------------------------------------------------------------------------------------------

// Servidor falso: guarda cada pedido e responde como routers/outlook_mail.py. `respostaEmail(corpo)` ajusta o POST /email.
async function abrirOutlook(page, respostaEmail = corpo => ({ json: { status: corpo.modo === "enviar" ? "enviado" : "aberto" } })) {
  const chamadas = [];
  await page.route("**/api/outlook/**", async route => {
    const pedido = route.request();
    const caminho = new URL(pedido.url()).pathname.replace("/api/outlook", "");
    const metodo = pedido.method();
    const corpo = pedido.postData() ? pedido.postDataJSON() : null;
    chamadas.push({ metodo, caminho, corpo });
    if (metodo === "GET" && caminho === "/email/configuracao") {
      return route.fulfill({ json: { contas: CONTAS, modelos: [{ ...CABO_PADRAO }], diretorio: { disponivel: true } } });
    }
    if (metodo === "GET" && caminho === "/contatos") return route.fulfill({ json: { contatos: [] } });
    if (metodo === "POST" && caminho === "/contatos/resolver") {
      return route.fulfill({ json: { resultados: corpo.tokens.map(token => ({ token, status: "nenhum" })) } });
    }
    if (metodo === "POST" && caminho === "/email") {
      const resposta = await respostaEmail(corpo);
      if (resposta === "abortar") return route.abort();
      return route.fulfill(resposta);
    }
    return route.fulfill({ status: 404, json: { detail: "Rota não simulada." } });
  });
  await page.route("**/api/equipamento/*", route => route.fulfill({ json: EQUIPAMENTO }));
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await page.locator("#btn-enviar-email").click();
  await expect(page.locator("#modal-email-outlook")).toBeVisible();
  await expect(page.locator("#email-modelo")).toBeEnabled(); // modelos carregados
  return chamadas;
}

const emails = chamadas => chamadas.filter(({ metodo, caminho }) => metodo === "POST" && caminho === "/email");

// ---------------------------------------------------------------------------------------------------------------
// Assistente
// ---------------------------------------------------------------------------------------------------------------

// Todas as rotas /api/assistente/* são simuladas; `respostas` mapeia o final da URL para o JSON (ou para uma função, que pode esperar).
async function mockAssistente(page, respostas) {
  const chamadas = [];
  await page.route("**/api/assistente/**", async route => {
    const nome = new URL(route.request().url()).pathname.split("/").pop();
    const corpo = route.request().postDataJSON?.() ?? null;
    chamadas.push({ nome, metodo: route.request().method(), corpo });
    const resposta = typeof respostas[nome] === "function" ? await respostas[nome](corpo) : respostas[nome];
    await route.fulfill({ json: resposta ?? { ok: true } });
  });
  return chamadas;
}

// Abre o widget e pede uma ação que fica pendente de confirmação (cartão "Confirmação necessária").
async function abrirAssistenteComPendente(page, confirmar) {
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    mensagem: { texto: "Posso executar?", ferramentas: [], pendente: PENDENTE },
    confirmar: confirmar ?? (corpo => ({ texto: corpo.confirmado ? "Feito." : "Cancelado.", ferramentas: [], pendente: null })),
  });
  await page.goto("/");
  await page.locator("#btn-assistente").click();
  await expect(page.locator("#assistente-widget")).toBeVisible();
  await page.locator("#assistente-texto").fill("abra a pasta");
  await page.locator("#assistente-enviar").click();
  await expect(page.locator("#assistente-pendente")).toBeVisible();
  await expect(page.locator("#assistente-pendente-descricao")).toHaveText(PENDENTE.descricao);
  return chamadas;
}

const confirmacoes = chamadas => chamadas.filter(({ nome }) => nome === "confirmar");

// ---------------------------------------------------------------------------------------------------------------
// Baselines de screenshot (390 e 1366 px, temas claro e escuro)
// ---------------------------------------------------------------------------------------------------------------

for (const tema of ["light", "dark"]) {
  test(`baseline: ticket UX preparado, tema ${tema}`, async ({ page }) => {
    await prepararPagina(page, tema, { alto: true });
    const { modal } = await abrirTicket(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
    await expect(modal.getByLabel("Registro")).not.toHaveValue("");
    await page.mouse.move(0, 0);
    await expect(page.locator("#modal-ticket-ux .ck-dialogo")).toHaveScreenshot(`ticket-ux-${tema}.png`, CAPTURA);
  });

  test(`baseline: e-mail pelo Outlook aberto, tema ${tema}`, async ({ page }) => {
    await prepararPagina(page, tema, { alto: true });
    await abrirOutlook(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
    await expect(page.locator("#email-nome-pessoa")).toHaveValue("Pessoa Teste");
    await expect(page.locator("#email-assunto")).toHaveValue(CABO_PADRAO.assunto);
    await page.mouse.move(0, 0);
    const dialogo = page.locator("#modal-email-outlook .ck-dialogo");
    await expect(dialogo).toHaveScreenshot(`outlook-${tema}.png`, CAPTURA);
    // No celular o diálogo passa do teto de 900 px e rola por dentro: a segunda captura mostra o rodapé (Cancelar, Copiar, Abrir, Enviar).
    if (await dialogo.evaluate(el => el.scrollHeight > el.clientHeight + 1)) {
      await dialogo.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(dialogo).toHaveScreenshot(`outlook-rodape-${tema}.png`, CAPTURA);
    }
  });

  test(`baseline: aba Automação do Chrome, tema ${tema}`, async ({ page, request }) => {
    await prepararPagina(page, tema, { alto: true });
    await request.get("/__fixture_automacao?quantidade=0&sebrae=padrao&run=");
    await page.goto("/");
    await page.locator("#tab-automacao").click();
    const painel = page.locator("#tab-panel-automacao");
    await expect(painel).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
    await expect(painel.locator("#automacao-estado")).toContainText("Livre");
    await expect(painel.locator("#automacao-historico tbody tr")).toHaveCount(3);
    await page.mouse.move(0, 0);
    await expect(painel).toHaveScreenshot(`automacao-${tema}.png`, CAPTURA);
  });

  test(`baseline: widget do Assistente aberto com ação pendente, tema ${tema}`, async ({ page }) => {
    await prepararPagina(page, tema, { alto: true });
    await abrirAssistenteComPendente(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
    await expect(page.locator(".ck-assist__msg--assistente").last()).toContainText("Posso executar?");
    await page.mouse.move(0, 0);
    await expect(page.locator("#assistente-widget")).toHaveScreenshot(`assistente-${tema}.png`, CAPTURA);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Invariantes de envio
// ---------------------------------------------------------------------------------------------------------------

test.describe("comportamento (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento não depende da largura: roda só no desktop");

  test.beforeEach(async ({ page }) => {
    await prepararPagina(page);
  });

  // ---- Ticket UX ----
  test("Ticket UX: Simular envia um POST com enviar false e nunca enviar true", async ({ page }) => {
    const { chamadas, modal } = await abrirTicket(page);
    await modal.getByLabel("Registro").fill(REGISTRO_OK);
    await modal.getByRole("button", { name: "Simular preenchimento" }).click();
    await expect(modal.getByRole("status")).toContainText("Nenhum ticket foi enviado");
    await page.waitForTimeout(300); // um segundo POST, se existisse, já teria chegado
    expect(envios(chamadas)).toHaveLength(1);
    expect(envios(chamadas)[0].corpo).toEqual({
      session_id: SESSION, serial: "LENTO", descricao: REGISTRO_OK, solicitante: SOLICITANTE, chamado_interno: "", enviar: false, confirmado: false,
    });
    expect(enviosReais(chamadas)).toEqual([]);
    expect(chamadas.some(({ corpo }) => corpo.confirmado === true)).toBe(false);
  });

  test("Ticket UX: Finalizar só envia depois da confirmação, com enviar e confirmado true, uma vez", async ({ page }) => {
    const { chamadas, modal } = await abrirTicket(page);
    await modal.getByLabel("Registro").fill(REGISTRO_OK);
    await modal.getByRole("button", { name: "Revisar e finalizar" }).click();
    const confirmacao = page.getByRole("dialog", { name: "Finalizar ticket no UX" });
    await expect(confirmacao).toBeVisible();
    await expect(confirmacao).toContainText(REGISTRO_OK);
    await page.waitForTimeout(300);
    expect(envios(chamadas)).toEqual([]); // abrir a confirmação não envia nada
    await confirmacao.getByRole("button", { name: "Finalizar ticket" }).click();
    await expect(modal.getByRole("status")).toContainText("Ticket nº 445566");
    await page.waitForTimeout(300);
    expect(enviosReais(chamadas).map(({ corpo }) => corpo)).toEqual([{
      session_id: SESSION, serial: "LENTO", descricao: REGISTRO_OK, solicitante: SOLICITANTE, chamado_interno: "", enviar: true, confirmado: true,
    }]);
    expect(envios(chamadas)).toHaveLength(1);
    await expect(modal.getByRole("button", { name: "Revisar e finalizar" })).toBeDisabled();
  });

  test("Ticket UX: Cancelar na confirmação não envia nada e devolve os botões", async ({ page }) => {
    const { chamadas, modal } = await abrirTicket(page);
    await modal.getByLabel("Registro").fill(REGISTRO_OK);
    await modal.getByRole("button", { name: "Revisar e finalizar" }).click();
    const confirmacao = page.getByRole("dialog", { name: "Finalizar ticket no UX" });
    await expect(confirmacao).toBeVisible();
    await confirmacao.getByRole("button", { name: "Cancelar" }).click();
    await expect(confirmacao).toBeHidden();
    await expect(modal.getByRole("button", { name: "Revisar e finalizar" })).toBeEnabled();
    await expect(modal.getByRole("button", { name: "Simular preenchimento" })).toBeEnabled();
    await page.waitForTimeout(300);
    expect(envios(chamadas)).toEqual([]);
  });

  test("Ticket UX: clique duplo em Revisar e finalizar e em Finalizar ticket envia só um pedido real", async ({ page }) => {
    const retido = portao();
    const { chamadas, modal } = await abrirTicket(page, async (etapa, corpo) => {
      if (etapa === "enviar" && corpo.enviar) await retido.espera;
      return padraoTicket(etapa, corpo);
    });
    await modal.getByLabel("Registro").fill(REGISTRO_OK);
    await modal.getByRole("button", { name: "Revisar e finalizar" }).dblclick();
    const confirmacao = page.getByRole("dialog", { name: "Finalizar ticket no UX" });
    await expect(confirmacao).toBeVisible();
    await confirmacao.getByRole("button", { name: "Finalizar ticket" }).dblclick();
    await expect.poll(() => enviosReais(chamadas).length).toBe(1);
    // Com o envio em voo, as duas ações ficam travadas.
    await expect(modal.getByRole("button", { name: "Revisar e finalizar" })).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Simular preenchimento" })).toBeDisabled();
    await page.waitForTimeout(300);
    expect(enviosReais(chamadas)).toHaveLength(1);
    retido.liberar();
    await expect(modal.getByRole("status")).toContainText("Ticket nº 445566");
    await page.waitForTimeout(300);
    expect(envios(chamadas)).toHaveLength(1);
    expect(enviosReais(chamadas)[0].corpo).toMatchObject({ enviar: true, confirmado: true });
  });

  test("Ticket UX: recusa do servidor (série de teste e SIMPRESS_UX_SEM_ENVIO) aparece como erro, nunca como sucesso", async ({ page }) => {
    let recusa = RECUSA_SERIE_TESTE;
    const { chamadas, modal } = await abrirTicket(page, (etapa, corpo) => (
      etapa === "enviar" && corpo.enviar ? { status: 422, json: { detail: recusa, codigo: "" } } : padraoTicket(etapa, corpo)
    ));
    await modal.getByLabel("Registro").fill(REGISTRO_OK);
    for (const motivo of [RECUSA_SERIE_TESTE, RECUSA_UX_SEM_ENVIO]) {
      recusa = motivo;
      const antes = enviosReais(chamadas).length;
      await modal.getByRole("button", { name: "Revisar e finalizar" }).click();
      await page.getByRole("dialog", { name: "Finalizar ticket no UX" }).getByRole("button", { name: "Finalizar ticket" }).click();
      await expect(modal.getByRole("alert")).toHaveText(motivo);
      await expect(page.locator("#ux-ticket-estado")).toHaveText("Erro");
      await expect(modal.getByRole("status")).not.toContainText("Ticket nº");
      await expect(modal.getByRole("status")).not.toContainText("Enviado");
      await expect(page.locator("#toast-container")).not.toContainText("Ticket enviado");
      await page.waitForTimeout(300);
      expect(enviosReais(chamadas)).toHaveLength(antes + 1); // sem nova tentativa automática
    }
  });

  test("Ticket UX: resposta perdida no envio real vira incerto, sem sucesso e sem repetir o envio", async ({ page }) => {
    const { chamadas, modal } = await abrirTicket(page, (etapa, corpo) => (
      etapa === "enviar" && corpo.enviar ? "abortar" : padraoTicket(etapa, corpo)
    ));
    await modal.getByLabel("Registro").fill(REGISTRO_OK);
    await modal.getByRole("button", { name: "Revisar e finalizar" }).click();
    await page.getByRole("dialog", { name: "Finalizar ticket no UX" }).getByRole("button", { name: "Finalizar ticket" }).click();
    await expect(page.locator("#ux-ticket-estado")).toHaveText("Incerto — confira no UX");
    await expect(modal.getByRole("status")).not.toContainText("Ticket nº");
    await expect(page.locator("#toast-container")).not.toContainText("Ticket enviado");
    await expect(modal.getByRole("button", { name: "Revisar e finalizar" })).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Simular preenchimento" })).toBeDisabled();
    await page.waitForTimeout(300);
    expect(enviosReais(chamadas)).toHaveLength(1);
  });

  // ---- Outlook ----
  test("Outlook: Cancelar na confirmação envia nada; confirmar envia um POST com confirmado true", async ({ page }) => {
    const chamadas = await abrirOutlook(page);
    await page.locator("#email-setor").fill("Setor Teste");
    await page.locator("#email-enviar").click();
    await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Enviar o e-mail pelo Outlook?");
    await page.locator("#btn-confirmar-acao-cancelar").click();
    await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
    await page.waitForTimeout(300);
    expect(emails(chamadas)).toEqual([]);

    await page.locator("#email-enviar").click();
    await page.locator("#btn-confirmar-acao-ok").click();
    await expect(page.locator("#email-status")).toHaveText(OUTLOOK_SUCESSO);
    await page.waitForTimeout(300);
    expect(emails(chamadas).map(({ corpo }) => corpo)).toEqual([{
      conta: "sebrae", para: CABO_PADRAO.para, cc: "", assunto: CABO_PADRAO.assunto, corpo: CABO_PADRAO.corpo,
      nome: "Pessoa Teste", setor: "Setor Teste", modo: "enviar", confirmado: true,
    }]);
  });

  test("Outlook: clique duplo em Enviar e em Enviar da confirmação envia só um e-mail", async ({ page }) => {
    const retido = portao();
    const chamadas = await abrirOutlook(page, async corpo => {
      if (corpo.modo === "enviar") await retido.espera;
      return { json: { status: corpo.modo === "enviar" ? "enviado" : "aberto" } };
    });
    await page.locator("#email-setor").fill("Setor Teste");
    await page.locator("#email-enviar").dblclick();
    await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Enviar o e-mail pelo Outlook?");
    await page.locator("#btn-confirmar-acao-ok").dblclick();
    await expect.poll(() => emails(chamadas).length).toBe(1);
    await expect(page.locator("#email-enviar")).toBeDisabled(); // travado com o envio em voo
    await page.waitForTimeout(300);
    expect(emails(chamadas)).toHaveLength(1);
    retido.liberar();
    await expect(page.locator("#email-status")).toHaveText(OUTLOOK_SUCESSO);
    await page.waitForTimeout(300);
    expect(emails(chamadas)).toHaveLength(1);
    expect(emails(chamadas)[0].corpo).toMatchObject({ modo: "enviar", confirmado: true });
  });

  test("Outlook: recusa SIMPRESS_OUTLOOK_SEM_ENVIO e resultado incerto nunca aparecem como sucesso", async ({ page }) => {
    let resposta = OUTLOOK_SEM_ENVIO;
    const chamadas = await abrirOutlook(page, corpo => (corpo.modo === "abrir" ? { json: { status: "aberto" } } : resposta));
    const status = page.locator("#email-status");
    await page.locator("#email-setor").fill("Setor Teste");
    const enviar = async () => {
      await page.locator("#email-enviar").click();
      await page.locator("#btn-confirmar-acao-ok").click();
    };

    await enviar();
    await expect(status).toHaveText(OUTLOOK_SEM_ENVIO.json.detail);
    await expect(status).toHaveAttribute("data-tipo", "erro");
    await expect(status).not.toContainText(OUTLOOK_SUCESSO);
    expect(emails(chamadas)).toHaveLength(1);

    // Só o envio real é recusado: abrir no Outlook continua funcionando.
    await page.locator("#email-abrir").click();
    await expect(status).toHaveText("E-mail aberto no Outlook. Revise e envie por lá.");
    expect(emails(chamadas).at(-1).corpo).toMatchObject({ modo: "abrir", confirmado: false });

    resposta = { json: { status: "incerto", aviso: OUTLOOK_INCERTO } };
    await enviar();
    await expect(status).toHaveText(OUTLOOK_INCERTO);
    await expect(status).toHaveAttribute("data-tipo", "aviso");
    await expect(status).not.toContainText(OUTLOOK_SUCESSO);

    resposta = "abortar"; // resposta perdida: o envio pode ou não ter saído
    await enviar();
    await expect(status).toHaveText(OUTLOOK_INCERTO);
    await expect(status).toHaveAttribute("data-tipo", "aviso");
    await expect(status).not.toContainText(OUTLOOK_SUCESSO);
    await page.waitForTimeout(300);
    expect(emails(chamadas).filter(({ corpo }) => corpo.modo === "enviar")).toHaveLength(3); // uma por clique do usuário, nenhuma automática
  });

  // ---- Assistente ----
  test("Assistente: confirmar dispara um pedido de confirmação com confirmado true, mesmo com clique duplo", async ({ page }) => {
    const retido = portao();
    const chamadas = await abrirAssistenteComPendente(page, async corpo => {
      await retido.espera;
      return { texto: corpo.confirmado ? "Feito." : "Cancelado.", ferramentas: [], pendente: null };
    });
    expect(confirmacoes(chamadas)).toEqual([]); // o cartão aparecer não confirma nada
    await page.getByRole("button", { name: "Confirmar e executar" }).dblclick();
    await expect.poll(() => confirmacoes(chamadas).length).toBe(1);
    await page.waitForTimeout(300);
    expect(confirmacoes(chamadas)).toHaveLength(1);
    retido.liberar();
    await expect(page.locator("#assistente-pendente")).toBeHidden();
    await expect(page.locator(".ck-assist__msg--assistente").last()).toHaveText(/Feito\./);
    await page.waitForTimeout(300);
    expect(confirmacoes(chamadas).map(({ corpo }) => corpo)).toEqual([expect.objectContaining({ confirmado: true })]);
  });

  test("Assistente: cancelar não confirma a ação (só avisa o servidor com confirmado false)", async ({ page }) => {
    const chamadas = await abrirAssistenteComPendente(page);
    await page.locator("#assistente-pendente").getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(page.locator("#assistente-pendente")).toBeHidden();
    await expect(page.locator(".ck-assist__msg--assistente").last()).toHaveText(/Cancelado\./);
    await page.waitForTimeout(300);
    expect(confirmacoes(chamadas).filter(({ corpo }) => corpo.confirmado === true)).toEqual([]);
    expect(confirmacoes(chamadas).map(({ corpo }) => corpo)).toEqual([expect.objectContaining({ confirmado: false })]);
    await expect(page.locator("#assistente-widget")).toBeVisible();
  });
});
