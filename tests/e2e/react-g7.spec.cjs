// Migração React, Dia 3, grupo G7: ticket UX (Transporte), E-mail pelo Outlook, Automação do Chrome e Assistente.
// Os invariantes de envio e o baseline de screenshots foram gravados com o código antigo (JS puro), antes da troca
// para React: os painéis em React têm de enviar exatamente os mesmos pedidos e sair iguais nos dois tamanhos
// (390 e 1366 px) e nos dois temas. Todas as rotas são simuladas: nenhum teste toca no UX, no Outlook nem no modelo.
const { test, expect } = require("@playwright/test");
const { abrirEtapaTransporte } = require("./support/etapas-transporte.cjs");

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
  await abrirEtapaTransporte(page, 2, 3);
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

// ---------------------------------------------------------------------------------------------------------------
// Ticket UX: casos que antes eram testados contra o JS antigo com DOM falso (tests/frontend/test_transporte_ux_ticket.cjs).
// Com o modal em React (frontend/src/paineis/ux-ticket/), o comportamento de tela é provado aqui, no navegador.
// ---------------------------------------------------------------------------------------------------------------

const SOLICITANTE_PADRAO = { nome: "Pessoa Padrão", email: "padrao@exemplo.com", telefone: "(41) 92222-2222" };
const PREPARADO_ENDERECO = {
  status: "preparado", tipo: "endereco", session_id: SESSION, serial: "LENTO", modelo: PREPARADO.modelo, solicitante: SOLICITANTE, ultimo_envio: null,
};
const TRANSPORTE_INICIO = /^Prezados,\n\nSolicito o transporte do equipamento da unidade do Sebrae de .+ para a unidade do Sebrae de Cidade Teste/;
const ALTERAR_INICIO = /^Prezados,\n\nSolicito alteração do endereço do equipamento da Unidade de .+ para .*Cidade Teste.*\.$/;
const FALHA_CHROME = { status: 503, json: { detail: "O Chrome de automação não abriu.", codigo: "chrome_indisponivel" } };

// Monta a tela como abrirTicket, mas sem apertar "Transporte": cada teste decide quando baixar a planilha ou usar "Alterar Endereço".
// `buscar: false` deixa a página sem equipamento; `escolher: false` busca o equipamento mas não escolhe a unidade de destino.
async function telaTicket(page, ticket, { unidade = UNIDADE, padrao = SOLICITANTE, buscar = true, escolher = true } = {}) {
  const chamadas = [];
  await page.route("**/api/unidades", route => route.fulfill({ json: [unidade] }));
  await page.route("**/api/gerar-planilha", route => route.fulfill({
    status: 200, body: "planilha-ficticia",
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="Transferencia_LENTO.xlsx"',
    },
  }));
  await page.route("**/api/ux/gerar-ticket/**", async route => {
    const etapa = new URL(route.request().url()).pathname.split("/").pop();
    if (etapa === "solicitante") return route.fulfill({ json: padrao });
    const corpo = route.request().postDataJSON();
    chamadas.push({ etapa, corpo });
    const resposta = await ticket(etapa, corpo);
    return route.fulfill({ status: resposta.status ?? 200, json: resposta.json });
  });
  await page.goto("/");
  if (!buscar) return chamadas;
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await page.locator("#input-serial").focus();
  await page.keyboard.press("F2");
  await expect(page.locator("#btn-gerar-planilha")).toBeVisible();
  if (!escolher) return chamadas;
  await page.evaluate(() => {
    const select = document.getElementById("select-unidade-destino");
    select.value = "7";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#entrega-cnpj")).toHaveText(unidade.cnpj);
  const campos = {
    "retirada-contato": "Pessoa Retirada", "retirada-email": "retirada@exemplo.com", "retirada-telefone": "(41) 91111-1111",
    "retirada-obs": "Notebook + kit", "entrega-contato": "Maria Teste", "entrega-email": "entrega@exemplo.com",
    "entrega-telefone": "(41) 3333-0000", "entrega-obs": "Nova contratação",
  };
  await abrirEtapaTransporte(page, 2, 3);
  for (const [id, valor] of Object.entries(campos)) await page.locator(`#${id}`).fill(valor);
  return chamadas;
}

// "Transporte": baixa a planilha e abre o modal "Gerar ticket no UX" (o download não espera o ticket).
async function baixarPlanilha(page) {
  const download = page.waitForEvent("download");
  await page.locator("#btn-gerar-planilha").click();
  expect((await download).suggestedFilename()).toBe("Transferencia_LENTO.xlsx");
  const modal = page.getByRole("dialog", { name: "Gerar ticket no UX" });
  await expect(modal).toBeVisible();
  return modal;
}

const etapasDe = chamadas => chamadas.map(({ etapa }) => etapa);

test.describe("ticket UX em React: casos do módulo antigo (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento não depende da largura: roda só no desktop");

  test.beforeEach(async ({ page }) => {
    await prepararPagina(page);
  });

  test("Transporte abre o modal com série, modelo, endereço e solicitante; Esc fecha pela ponte e cancela a sessão", async ({ page }) => {
    const chamadas = await telaTicket(page, (etapa, corpo) => padraoTicket(etapa, corpo));
    const modal = await baixarPlanilha(page);
    await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
    await expect(page.locator("#ux-ticket-serie")).toHaveText("LENTO");
    await expect(page.locator("#ux-ticket-modelo")).toHaveText(PREPARADO.modelo);
    await expect(page.locator("#ux-ticket-endereco")).toHaveText(PREPARADO.endereco);
    await expect(modal.getByLabel("Nome", { exact: true })).toHaveValue(SOLICITANTE.nome);
    await expect(modal.getByLabel("Registro")).toHaveValue(TRANSPORTE_INICIO);
    await expect(modal.getByRole("alert")).toBeHidden();
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].etapa).toBe("preparar");
    expect(chamadas[0].corpo).toMatchObject({ serial: "LENTO", entrega_cep: "80000-000", entrega_contato: "Maria Teste", entrega_telefone: "(41) 3333-0000", entrega_cnpj: UNIDADE.cnpj });
    expect(chamadas[0].corpo).not.toHaveProperty("conferido");
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect.poll(() => chamadas.at(-1)).toEqual({ etapa: "cancelar", corpo: { session_id: SESSION } });
    expect(enviosReais(chamadas)).toEqual([]);
  });

  test("Unidade sem CEP de 8 dígitos: o download sai, o alerta explica e /preparar nunca é chamado", async ({ page }) => {
    const chamadas = await telaTicket(page, (etapa, corpo) => padraoTicket(etapa, corpo), { unidade: { ...UNIDADE, cep: "" } });
    const modal = await baixarPlanilha(page);
    await expect(modal.getByRole("alert")).toContainText("CEP com 8 dígitos");
    await expect(page.locator("#ux-ticket-estado")).toHaveText("Erro");
    await expect(modal.getByRole("button", { name: "Simular preenchimento" })).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Revisar e finalizar" })).toBeDisabled();
    await page.waitForTimeout(300);
    expect(chamadas).toEqual([]);
  });

  test("Falha no /preparar mantém o Registro digitado: Preparar novamente refaz com o mesmo payload e sem conferido", async ({ page }) => {
    let falhar = true;
    const chamadas = await telaTicket(page, (etapa, corpo) => (etapa === "preparar" && falhar ? FALHA_CHROME : padraoTicket(etapa, corpo)));
    const modal = await baixarPlanilha(page);
    await expect(modal.getByRole("alert")).toHaveText(FALHA_CHROME.json.detail);
    await expect(page.locator("#ux-ticket-estado")).toHaveText("Erro");
    await expect(page.locator("#ux-ticket-conferido")).toBeHidden();
    await expect(modal.getByLabel("Registro")).toBeEnabled();
    await modal.getByLabel("Registro").fill(REGISTRO_OK);
    falhar = false;
    await modal.getByRole("button", { name: "Preparar novamente" }).click();
    await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
    expect(etapasDe(chamadas)).toEqual(["preparar", "preparar"]);
    expect(chamadas[1].corpo).toEqual(chamadas[0].corpo);
    expect(chamadas[1].corpo).not.toHaveProperty("conferido");
    await expect(modal.getByLabel("Registro")).toHaveValue(REGISTRO_OK);
    await expect(modal.getByRole("alert")).toBeHidden();
    await expect(modal.getByRole("button", { name: "Simular preenchimento" })).toBeEnabled();
  });

  test("envio_incerto no /preparar exige 'Conferi no UX', que manda conferido true; Preparar novamente não é oferecido", async ({ page }) => {
    let incerto = true;
    const chamadas = await telaTicket(page, (etapa, corpo) => (
      etapa === "preparar" && incerto
        ? { status: 409, json: { detail: "A última tentativa ficou incerta. Confira no UX.", codigo: "envio_incerto" } }
        : padraoTicket(etapa, corpo)
    ));
    const modal = await baixarPlanilha(page);
    await expect(page.locator("#ux-ticket-estado")).toHaveText("Incerto — confira no UX");
    await expect(modal.getByRole("button", { name: "Conferi no UX; preparar de novo" })).toBeVisible();
    await expect(page.locator("#ux-ticket-preparar")).toBeHidden();
    await page.waitForTimeout(300);
    expect(chamadas).toHaveLength(1);
    incerto = false;
    await modal.getByRole("button", { name: "Conferi no UX; preparar de novo" }).click();
    await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
    expect(etapasDe(chamadas)).toEqual(["preparar", "preparar"]);
    expect(chamadas[1].corpo).toEqual({ ...chamadas[0].corpo, conferido: true });
    await expect(page.locator("#ux-ticket-conferido")).toBeHidden();
  });

  test("/enviar com status incerto trava a sessão e o formulário; só a conferência explícita reabre", async ({ page }) => {
    const chamadas = await telaTicket(page, (etapa, corpo) => (
      etapa === "enviar" ? { json: { status: "incerto", mensagem: "Não deu para confirmar o ticket. Confira no UX." } } : padraoTicket(etapa, corpo)
    ));
    const modal = await baixarPlanilha(page);
    await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
    await modal.getByLabel("Registro").fill(REGISTRO_OK);
    await modal.getByRole("button", { name: "Revisar e finalizar" }).click();
    await page.getByRole("dialog", { name: "Finalizar ticket no UX" }).getByRole("button", { name: "Finalizar ticket" }).click();
    await expect(page.locator("#ux-ticket-estado")).toHaveText("Incerto — confira no UX");
    await expect(modal.getByRole("button", { name: "Revisar e finalizar" })).toBeDisabled();
    await expect(modal.getByLabel("Registro")).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Conferi no UX; preparar de novo" })).toBeVisible();
    await page.waitForTimeout(300);
    expect(enviosReais(chamadas)).toHaveLength(1);
    await modal.getByRole("button", { name: "Conferi no UX; preparar de novo" }).click();
    await expect.poll(() => chamadas.filter(({ etapa }) => etapa === "preparar").length).toBe(2);
    expect(chamadas.filter(({ etapa }) => etapa === "preparar")[1].corpo.conferido).toBe(true);
    await expect(modal.getByLabel("Registro")).toBeEnabled();
    await expect(modal.getByRole("button", { name: "Revisar e finalizar" })).toBeEnabled();
    expect(enviosReais(chamadas)).toHaveLength(1); // a conferência não reenvia nada
  });

  test("Cancelar chama /cancelar para a sessão aberta, engole o 409 e fecha o modal", async ({ page }) => {
    const chamadas = await telaTicket(page, (etapa, corpo) => (
      etapa === "cancelar" ? { status: 409, json: { detail: "Sessão já encerrada.", codigo: "sessao_inexistente" } } : padraoTicket(etapa, corpo)
    ));
    const modal = await baixarPlanilha(page);
    await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
    await expect(page.locator("#ux-ticket-cancelar")).toHaveText("Cancelar");
    await page.locator("#ux-ticket-cancelar").click();
    await expect(modal).toBeHidden();
    await expect.poll(() => chamadas.at(-1)).toEqual({ etapa: "cancelar", corpo: { session_id: SESSION } });
    await expect(page.locator("#toast-container")).not.toContainText("Sessão já encerrada");
  });

  test("O solicitante padrão aparece na hora, segue editável durante o /preparar e o valor editado sobrevive à falha", async ({ page }) => {
    const retido = portao();
    await telaTicket(page, async (etapa, corpo) => {
      if (etapa === "preparar") { await retido.espera; return FALHA_CHROME; }
      return padraoTicket(etapa, corpo);
    }, { padrao: SOLICITANTE_PADRAO });
    try {
      const modal = await baixarPlanilha(page);
      // O /preparar pode levar minutos no UX real: já dá para preencher o Registro e editar o solicitante.
      await expect(modal.getByLabel("Nome", { exact: true })).toHaveValue(SOLICITANTE_PADRAO.nome);
      await expect(modal.getByLabel("E-mail", { exact: true })).toHaveValue(SOLICITANTE_PADRAO.email);
      await expect(modal.getByLabel("Contato", { exact: true })).toHaveValue(SOLICITANTE_PADRAO.telefone);
      await expect(modal.getByLabel("Registro")).toBeEnabled();
      const registro = modal.getByLabel("Registro");
      await registro.fill("Prezados,\nColaborador(a) Novo(a):");
      await expect(modal.getByRole("button", { name: "Simular preenchimento" })).toBeDisabled();
      await modal.getByLabel("E-mail", { exact: true }).fill("outra@exemplo.com");
      // O ui-motion.ts tira aria-invalid do campo digitado; a atualização seguinte da tela (aqui, o e-mail) o repõe, como no módulo antigo.
      await expect(registro).toHaveAttribute("aria-invalid", "true");
      retido.liberar();
      await expect(modal.getByRole("alert")).toHaveText(FALHA_CHROME.json.detail);
      await expect(modal.getByLabel("Nome", { exact: true })).toHaveValue(SOLICITANTE_PADRAO.nome);
      await expect(modal.getByLabel("E-mail", { exact: true })).toHaveValue("outra@exemplo.com");
      await registro.fill(REGISTRO_OK);
      await expect(registro).toHaveAttribute("aria-invalid", "false");
    } finally {
      retido.liberar();
    }
  });

  test("Fechar durante o /preparar cancela a sessão que chega depois", async ({ page }) => {
    const retido = portao();
    const chamadas = await telaTicket(page, async (etapa, corpo) => {
      if (etapa === "preparar") await retido.espera;
      return padraoTicket(etapa, corpo);
    });
    try {
      const modal = await baixarPlanilha(page);
      await modal.getByRole("button", { name: "Cancelar" }).click();
      retido.liberar();
      await expect.poll(() => chamadas.at(-1)).toEqual({ etapa: "cancelar", corpo: { session_id: SESSION } });
      await expect(modal).toBeHidden();
      expect(etapasDe(chamadas)).toEqual(["preparar", "cancelar"]);
    } finally {
      retido.liberar();
    }
  });

  test("Fechar é ignorado com o envio real em voo; Cancelar volta depois do resultado", async ({ page }) => {
    const retido = portao();
    const chamadas = await telaTicket(page, async (etapa, corpo) => {
      if (etapa === "enviar" && corpo.enviar) await retido.espera;
      return padraoTicket(etapa, corpo);
    });
    try {
      const modal = await baixarPlanilha(page);
      await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
      await modal.getByLabel("Registro").fill(REGISTRO_OK);
      await modal.getByRole("button", { name: "Revisar e finalizar" }).click();
      await page.getByRole("dialog", { name: "Finalizar ticket no UX" }).getByRole("button", { name: "Finalizar ticket" }).click();
      await expect.poll(() => enviosReais(chamadas).length).toBe(1);
      const cancelar = page.locator("#ux-ticket-cancelar");
      await expect(cancelar).toBeDisabled();
      await page.evaluate(() => window.fecharTicketUX());
      await page.waitForTimeout(300);
      await expect(modal).toBeVisible();
      expect(chamadas.some(({ etapa }) => etapa === "cancelar")).toBe(false);
      retido.liberar();
      await expect(modal.getByRole("status")).toContainText("Ticket nº 445566");
      await expect(cancelar).toBeEnabled();
      expect(enviosReais(chamadas)).toHaveLength(1);
    } finally {
      retido.liberar();
    }
  });

  test("Simular manda o Nº de chamado interno digitado", async ({ page }) => {
    const chamadas = await telaTicket(page, (etapa, corpo) => padraoTicket(etapa, corpo));
    const modal = await baixarPlanilha(page);
    await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
    await modal.getByLabel("Registro").fill(REGISTRO_OK);
    await modal.getByLabel("Nº de chamado interno").fill("INT-1");
    await modal.getByRole("button", { name: "Simular preenchimento" }).click();
    await expect.poll(() => envios(chamadas).length).toBe(1);
    expect(envios(chamadas).map(({ corpo }) => corpo)).toEqual([{
      session_id: SESSION, serial: "LENTO", descricao: REGISTRO_OK, solicitante: SOLICITANTE, chamado_interno: "INT-1", enviar: false, confirmado: false,
    }]);
  });

  test("Alterar Endereço prepara só com a série, esconde os campos do Transporte e confirma com o incidente do Transporte", async ({ page }) => {
    const chamadas = await telaTicket(page, (etapa, corpo) => (
      etapa === "preparar-alterar-endereco" ? { json: PREPARADO_ENDERECO } : padraoTicket(etapa, corpo)
    ));
    await page.locator("#btn-alterar-endereco").click();
    const modal = page.getByRole("dialog", { name: "Alterar Endereço no UX" });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("status")).toContainText("Pronto para simular ou finalizar");
    expect(chamadas).toEqual([{ etapa: "preparar-alterar-endereco", corpo: { serial: "LENTO" } }]);
    const registro = modal.getByLabel("Registro");
    await expect(registro).toHaveValue(ALTERAR_INICIO);
    await expect(modal.locator("dt").filter({ hasText: "Endereço escolhido" })).toBeHidden();
    for (const id of ["#ux-ticket-endereco", "#ux-ticket-cnpj-instalacao", "#ux-ticket-cnpj-faturamento", "#ux-ticket-anexo", "#ux-ticket-chamado-interno"]) {
      await expect(page.locator(id)).toBeHidden();
    }
    const descricao = await registro.inputValue();
    await modal.getByRole("button", { name: "Revisar e finalizar" }).click();
    const confirmacao = page.getByRole("dialog", { name: "Finalizar ticket no UX" });
    await expect(confirmacao).toContainText("Série: LENTO");
    await expect(confirmacao).toContainText("Incidente: Transporte · Transferência Fisica de Equipamentos");
    await confirmacao.getByRole("button", { name: "Finalizar ticket" }).click();
    await expect(modal.getByRole("status")).toContainText("Ticket nº 445566");
    expect(enviosReais(chamadas).map(({ corpo }) => corpo)).toEqual([{
      session_id: SESSION, serial: "LENTO", descricao, solicitante: SOLICITANTE, chamado_interno: "", enviar: true, confirmado: true,
    }]);
    expect(etapasDe(chamadas)).not.toContain("preparar");
  });

  test("Alterar Endereço sem equipamento pesquisado só avisa e não chama o UX", async ({ page }) => {
    const chamadas = await telaTicket(page, (etapa, corpo) => padraoTicket(etapa, corpo), { buscar: false });
    await page.evaluate(() => window.alterarEnderecoTicketUX());
    await expect(page.locator("#toast-container")).toContainText("Pesquise e selecione o equipamento antes de alterar o endereço.");
    await page.waitForTimeout(300);
    expect(chamadas).toEqual([]);
    await expect(page.locator("#modal-ticket-ux")).toBeHidden();
  });

  test("Alterar Endereço com equipamento mas sem endereços carregados só avisa e não chama o UX", async ({ page }) => {
    const chamadas = await telaTicket(page, (etapa, corpo) => padraoTicket(etapa, corpo), { escolher: false });
    await page.evaluate(() => window.alterarEnderecoTicketUX());
    await expect(page.locator("#toast-container")).toContainText("Selecione o equipamento de origem e a unidade de destino para carregar os endereços.");
    await page.waitForTimeout(300);
    expect(chamadas).toEqual([]);
    await expect(page.locator("#modal-ticket-ux")).toBeHidden();
  });

  test("Depois de Alterar Endereço, Transporte restaura o modal completo e o Registro do Transporte", async ({ page }) => {
    await telaTicket(page, (etapa, corpo) => (
      etapa === "preparar-alterar-endereco" ? { json: PREPARADO_ENDERECO } : padraoTicket(etapa, corpo)
    ));
    await page.locator("#btn-alterar-endereco").click();
    const alterar = page.getByRole("dialog", { name: "Alterar Endereço no UX" });
    await expect(alterar).toBeVisible();
    await alterar.getByRole("button", { name: "Cancelar" }).click();
    await expect(alterar).toBeHidden();
    const modal = await baixarPlanilha(page);
    await expect(modal.getByRole("heading", { name: "Gerar ticket no UX" })).toBeVisible();
    await expect(modal.getByLabel("Registro")).toHaveValue(TRANSPORTE_INICIO);
    await expect(page.locator("#ux-ticket-cnpj-instalacao")).toBeVisible();
    await expect(page.locator("#ux-ticket-chamado-interno")).toBeVisible();
  });

  test("O evento simpress:transfer-generated sem payload não abre o modal nem chama o UX", async ({ page }) => {
    const chamadas = await telaTicket(page, (etapa, corpo) => padraoTicket(etapa, corpo), { buscar: false });
    // ux-ticket é painel sob demanda (frontend/src/paineis.ts): nunca entra em SimpressReact, só no carregador.
    await page.waitForFunction(() => Boolean(window.SimpressReactSobDemanda?.["ux-ticket"]));
    expect(await page.evaluate(() => Boolean(window.SimpressReact?.["ux-ticket"]))).toBe(false);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("simpress:transfer-generated", { detail: {} })));
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("simpress:transfer-generated")));
    await page.waitForTimeout(300);
    await expect(page.locator("#modal-ticket-ux")).toBeHidden();
    expect(chamadas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Outlook: casos do módulo antigo (a versão de tests/frontend/test_outlook_email_ui.cjs com módulo simulado) no painel React.
// O servidor falso salva modelos, devolve contatos e tem portões para segurar uma resposta; nada real é chamado.
// ---------------------------------------------------------------------------------------------------------------

const AVISO_MODELO = {
  id: "aviso", nome: "Modelo 2 - Aviso", conta: "simpress", para: "grupo@exemplo.test", cc: "copia@exemplo.test",
  assunto: "Aviso geral", corpo: "Texto do aviso geral.",
};
const ANA = { nome: "Ana Exemplo", email: "ana.exemplo@exemplo.test" };
const ANA_TESTE = { nome: "Ana Teste", email: "ana.teste@exemplo.test" };
const PESSOA = { nome: "Pessoa Teste", email: "pessoa.teste@exemplo.test" };

function resolverContato(token) {
  if (token === "unico") return { token, status: "unico", ...PESSOA };
  if (token === "ambiguo") return { token, status: "ambiguo", opcoes: [ANA, ANA_TESTE] };
  return { token, status: "nenhum" };
}

// `segurar*` guardam um portão() que a rota espera; `falharPut` e `recusarCampo` fazem o PUT do modelo falhar.
async function servidorOutlook(page, { diretorio = true, modelos = [CABO_PADRAO, AVISO_MODELO] } = {}) {
  const servidor = {
    chamadas: [], modelos: modelos.map(modelo => ({ ...modelo })), respostaEmail: null, respostaConfiguracao: null,
    falharPut: false, recusarCampo: null, contatos: null,
    segurarConfiguracao: null, segurarPut: null, segurarEmail: null, segurarContatos: {},
    de(metodo, caminho) { return this.chamadas.filter(chamada => chamada.metodo === metodo && chamada.caminho === caminho); },
    puts(id = "cabo") { return this.de("PUT", `/email/modelos/${id}`).map(({ corpo }) => corpo); },
  };
  await page.route("**/api/outlook/**", async route => {
    const pedido = route.request();
    const url = new URL(pedido.url());
    const metodo = pedido.method();
    const caminho = url.pathname.replace("/api/outlook", "");
    const corpo = pedido.postData() ? pedido.postDataJSON() : null;
    servidor.chamadas.push({ metodo, caminho, busca: url.search, corpo });
    const modelo = servidor.modelos.find(item => caminho.startsWith(`/email/modelos/${item.id}`));
    if (metodo === "GET" && caminho === "/email/configuracao") {
      if (servidor.segurarConfiguracao) await servidor.segurarConfiguracao.espera;
      return route.fulfill(servidor.respostaConfiguracao || {
        json: { contas: CONTAS, modelos: servidor.modelos, diretorio: { disponivel: diretorio } },
      });
    }
    if (metodo === "POST" && caminho === "/email/modelos") {
      const origem = servidor.modelos.find(item => item.id === corpo.copiar_de);
      const novo = origem
        ? { ...origem, id: `copia-${servidor.modelos.length}`, nome: `${origem.nome} (cópia)` }
        : { id: `novo-${servidor.modelos.length}`, nome: "Novo modelo", conta: "sebrae", para: "", cc: "", assunto: "", corpo: "" };
      servidor.modelos.push(novo);
      return route.fulfill({ json: novo });
    }
    if (metodo === "PUT" && modelo) {
      if (servidor.segurarPut) await servidor.segurarPut.espera;
      if (servidor.falharPut) return route.fulfill({ status: 500, json: { detail: "Falha de teste ao salvar." } });
      if (servidor.recusarCampo && servidor.recusarCampo in corpo) {
        return route.fulfill({ status: 422, json: { detail: "Campo recusado pelo servidor." } });
      }
      Object.assign(modelo, corpo);
      return route.fulfill({ json: modelo });
    }
    if (metodo === "DELETE" && modelo) return route.fulfill({ json: { ok: true } });
    if (metodo === "GET" && caminho === "/contatos") {
      const termo = url.searchParams.get("q") || "";
      if (servidor.segurarContatos[termo]) await servidor.segurarContatos[termo].espera;
      const contatos = servidor.contatos ? servidor.contatos(termo) : (termo.startsWith("an") ? [ANA, ANA_TESTE] : []);
      return route.fulfill({ json: { contatos } });
    }
    if (metodo === "POST" && caminho === "/contatos/resolver") {
      return route.fulfill({ json: { resultados: corpo.tokens.map(resolverContato) } });
    }
    if (metodo === "POST" && caminho === "/email") {
      if (servidor.segurarEmail) await servidor.segurarEmail.espera;
      return route.fulfill(servidor.respostaEmail || { json: { status: corpo.modo === "enviar" ? "enviado" : "aberto" } });
    }
    return route.fulfill({ status: 404, json: { detail: "Rota não simulada." } });
  });
  return servidor;
}

// Servidor falso e equipamento selecionado, com o modal ainda fechado.
async function prepararOutlook(page, opcoes) {
  const servidor = await servidorOutlook(page, opcoes);
  await page.route("**/api/equipamento/*", route => route.fulfill({ json: EQUIPAMENTO }));
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  return servidor;
}

async function abrirModalOutlook(page, opcoes) {
  const servidor = await prepararOutlook(page, opcoes);
  await page.locator("#btn-enviar-email").click();
  await expect(page.locator("#modal-email-outlook")).toBeVisible();
  await expect(page.locator("#email-modelo")).toBeEnabled(); // modelos carregados
  return servidor;
}

const statusOutlook = page => page.locator("#email-status");
const autosaveOutlook = page => page.locator("#email-autosave-status");

test.describe("Outlook em React: casos do módulo antigo (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento não depende da largura: roda só no desktop");

  test.beforeEach(async ({ page }) => {
    await prepararPagina(page);
  });

  test("Digitar grava só o campo editado depois de 800 ms; Enter, sair do campo e trocar a conta gravam na hora", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    await page.locator("#email-corpo").fill("Corpo novo para {nome}");
    await expect(autosaveOutlook(page)).toHaveText("Alteração ainda não salva…");
    expect(servidor.puts()).toEqual([]);
    await expect(autosaveOutlook(page)).toHaveText("Salva.");
    expect(servidor.puts()).toEqual([{ corpo: "Corpo novo para {nome}" }]);

    await page.locator("#email-assunto").fill("Assunto na hora");
    await page.locator("#email-assunto").press("Enter");
    await expect.poll(() => servidor.puts().length).toBe(2);
    expect(servidor.puts()[1]).toEqual({ assunto: "Assunto na hora" });

    await page.locator("#email-modelo-nome").fill("Nome ao sair");
    await page.locator("#email-modelo-nome").blur();
    await expect.poll(() => servidor.puts().length).toBe(3);
    expect(servidor.puts()[2]).toEqual({ nome: "Nome ao sair" });

    await page.locator("#email-conta").selectOption("simpress");
    await expect.poll(() => servidor.puts().length).toBe(4);
    expect(servidor.puts()[3]).toEqual({ conta: "simpress" });

    await page.waitForTimeout(1000); // o timer de 800 ms foi cancelado a cada gravação: nada é gravado de novo
    expect(servidor.puts()).toHaveLength(4);
  });

  test("Trocar de modelo com o salvamento falhando fica no modelo antigo e mostra o erro", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    servidor.falharPut = true;
    await page.locator("#email-assunto").fill("Edição que não salva");
    await page.locator("#email-modelo").selectOption("aviso");
    await expect(autosaveOutlook(page)).toHaveText("Não foi possível salvar: Falha de teste ao salvar.");
    await expect(autosaveOutlook(page)).toHaveAttribute("data-estado", "erro");
    await expect(page.locator("#email-modelo")).toHaveValue("cabo");
    await expect(page.locator("#email-assunto")).toHaveValue("Edição que não salva");
    expect(servidor.de("PUT", "/email/modelos/aviso")).toHaveLength(0);

    servidor.falharPut = false; // a edição continua pendente: a nova tentativa grava e só então troca
    await page.locator("#email-modelo").selectOption("aviso");
    await expect(page.locator("#email-modelo")).toHaveValue("aviso");
    await expect(page.locator("#email-assunto")).toHaveValue(AVISO_MODELO.assunto);
    expect(servidor.modelos[0].assunto).toBe("Edição que não salva");
  });

  test("Fechar grava o que está pendente, e uma falha nesse salvamento aparece em toast", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    await page.locator("#email-assunto").fill("Gravado ao fechar");
    await page.locator("#email-cancelar").click();
    await expect(page.locator("#modal-email-outlook")).toBeHidden();
    await expect.poll(() => servidor.puts()).toEqual([{ assunto: "Gravado ao fechar" }]);

    await page.locator("#btn-enviar-email").click();
    await expect(page.locator("#email-assunto")).toHaveValue("Gravado ao fechar");
    servidor.falharPut = true;
    await page.locator("#email-assunto").fill("Não grava");
    await page.locator("#email-cancelar").click();
    await expect(page.locator("#modal-email-outlook")).toBeHidden();
    await expect(page.locator("#toast-container")).toContainText("Não foi possível salvar: Falha de teste ao salvar.");
  });

  test("Um campo que o servidor recusa não faz perder os outros, e o próximo salvamento tenta de novo", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    servidor.recusarCampo = "assunto";
    await page.locator("#email-assunto").fill("Assunto recusado");
    await page.locator("#email-corpo").fill("Corpo aceito");
    await expect(autosaveOutlook(page)).toHaveText("Não foi possível salvar: Campo recusado pelo servidor.");
    // Um PUT por campo: sair do Assunto grava na hora (recusado); o salvamento de 800 ms tenta o Assunto de novo e grava o Corpo.
    await expect.poll(() => servidor.puts().length).toBe(3);
    expect(servidor.puts().filter(dados => "assunto" in dados)).toEqual([{ assunto: "Assunto recusado" }, { assunto: "Assunto recusado" }]);
    expect(servidor.puts().filter(dados => "corpo" in dados)).toEqual([{ corpo: "Corpo aceito" }]);
    expect(servidor.modelos[0].corpo).toBe("Corpo aceito");

    servidor.recusarCampo = null;
    await page.locator("#email-modelo-nome").fill("Nome novo");
    await page.locator("#email-modelo-nome").blur();
    await expect(autosaveOutlook(page)).toHaveText("Salva.");
    expect(servidor.modelos[0]).toMatchObject({ nome: "Nome novo", assunto: "Assunto recusado", corpo: "Corpo aceito" });
  });

  test("O navegador pergunta antes de sair com alteração pendente ou salvamento em andamento", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    const pergunta = () => page.evaluate(() => {
      const evento = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(evento);
      return evento.defaultPrevented;
    });
    expect(await pergunta()).toBe(false);
    await page.locator("#email-assunto").fill("Pendente");
    expect(await pergunta()).toBe(true);
    await expect(autosaveOutlook(page)).toHaveText("Salva.");
    expect(await pergunta()).toBe(false);

    servidor.segurarPut = portao();
    await page.locator("#email-assunto").fill("Em andamento");
    await page.locator("#email-assunto").press("Enter");
    await expect.poll(() => servidor.puts().length).toBe(2);
    expect(await pergunta()).toBe(true);
    servidor.segurarPut.liberar();
    await expect(autosaveOutlook(page)).toHaveText("Salva.");
    expect(await pergunta()).toBe(false);
  });

  test("A configuração que chega depois de fechar o modal é ignorada", async ({ page }) => {
    const servidor = await prepararOutlook(page);
    const porta = portao();
    servidor.segurarConfiguracao = porta;
    await page.locator("#btn-enviar-email").click();
    await expect(page.locator("#modal-email-outlook")).toBeVisible();
    await expect.poll(() => servidor.de("GET", "/email/configuracao").length).toBe(1);
    servidor.segurarConfiguracao = null; // só o primeiro pedido fica preso
    await page.locator("#email-cancelar").click();
    await expect(page.locator("#modal-email-outlook")).toBeHidden();
    porta.liberar();
    await page.waitForTimeout(300);
    await expect(page.locator("#email-modelo option")).toHaveCount(0); // a resposta atrasada não preencheu nada

    await page.locator("#btn-enviar-email").click();
    await expect(page.locator("#email-modelo")).toBeEnabled();
    await expect(page.locator("#email-modelo option")).toHaveCount(2);
  });

  test("Lembra o último modelo ao reabrir e explica a falha ao carregar a configuração", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    await page.locator("#email-modelo").selectOption("aviso");
    await expect(page.locator("#email-assunto")).toHaveValue(AVISO_MODELO.assunto);
    await page.locator("#email-cancelar").click();
    await expect(page.locator("#modal-email-outlook")).toBeHidden();
    await page.locator("#btn-enviar-email").click();
    await expect(page.locator("#email-modelo")).toHaveValue("aviso");
    await expect(page.locator("#email-assunto")).toHaveValue(AVISO_MODELO.assunto);
    await page.locator("#email-cancelar").click();
    await expect(page.locator("#modal-email-outlook")).toBeHidden();

    servidor.respostaConfiguracao = { status: 500, json: { detail: "Configuração indisponível no teste." } };
    await page.locator("#btn-enviar-email").click();
    await expect(statusOutlook(page)).toHaveText("Configuração indisponível no teste.");
    await expect(statusOutlook(page)).toHaveAttribute("data-tipo", "erro");
    await expect(page.locator("#email-modelo")).toBeDisabled();
    await expect(page.locator("#modal-email-outlook")).toBeVisible();
  });

  test("Uma ação lenta que termina depois de fechar e reabrir não tira o foco da nova sessão", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    servidor.segurarEmail = portao();
    await page.locator("#email-abrir").click();
    await expect.poll(() => servidor.de("POST", "/email").length).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-email-outlook")).toBeHidden();
    await page.locator("#btn-enviar-email").click();
    await expect(page.locator("#email-corpo")).toBeEnabled(); // configuração da nova sessão carregada
    await page.locator("#email-corpo").focus();
    servidor.segurarEmail.liberar();
    // O resultado da sessão antiga vai só para o toast; a linha de status da nova continua limpa.
    await expect(page.locator("#toast-container")).toContainText("E-mail aberto no Outlook. Revise e envie por lá.");
    await expect(page.locator("#email-corpo")).toBeFocused();
    await expect(statusOutlook(page)).toHaveText("");
  });

  test("A busca no Entra pede ao menos 2 letras, ignora e-mails e usa só o nome depois do último ponto e vírgula", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    const para = page.locator("#email-para");
    const buscas = () => servidor.de("GET", "/contatos").map(({ busca }) => busca);
    await para.fill("a");
    await page.waitForTimeout(500);
    expect(buscas()).toEqual([]);
    await para.fill("ana@exemplo.test");
    await page.waitForTimeout(500);
    expect(buscas()).toEqual([]);
    await para.fill(`${ANA.nome} <${ANA.email}>; an`);
    await expect.poll(buscas).toEqual(["?q=an"]);
    await expect(page.getByRole("listbox", { name: "Para" }).getByRole("option")).toHaveCount(2);
  });

  test("Uma resposta de contatos mais antiga nunca substitui a mais nova", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    servidor.contatos = termo => (termo === "ana" ? [ANA_TESTE] : [ANA]);
    servidor.segurarContatos.an = portao();
    const lista = page.getByRole("listbox", { name: "Para" });
    await page.locator("#email-para").fill("an");
    await expect.poll(() => servidor.de("GET", "/contatos").length).toBe(1);
    await page.locator("#email-para").fill("ana");
    await expect(lista.getByRole("option")).toHaveText([`${ANA_TESTE.nome} <${ANA_TESTE.email}>`]);
    servidor.segurarContatos.an.liberar(); // a resposta de "an" chega depois da de "ana"
    await page.waitForTimeout(300);
    await expect(lista.getByRole("option")).toHaveText([`${ANA_TESTE.nome} <${ANA_TESTE.email}>`]);
  });

  test("Enter sem opção ativa deixa o campo como está, e o Esc fecha a lista antes de fechar o diálogo", async ({ page }) => {
    await abrirModalOutlook(page);
    const para = page.locator("#email-para");
    const lista = page.getByRole("listbox", { name: "Para" });
    await para.fill("an");
    await expect(lista).toBeVisible();
    await para.press("Enter");
    await expect(para).toHaveValue("an");
    await expect(lista).toBeVisible();
    await para.press("Escape");
    await expect(lista).toBeHidden();
    await expect(page.locator("#modal-email-outlook")).toBeVisible();
    await para.press("Escape");
    await expect(page.locator("#modal-email-outlook")).toBeHidden();
  });

  test("A confirmação do envio cita o Cc só quando ele tem conteúdo", async ({ page }) => {
    await abrirModalOutlook(page);
    const mensagem = page.locator("#mensagem-confirmar-acao");
    await page.locator("#email-setor").fill("Setor Teste");
    await page.locator("#email-enviar").click();
    await expect(mensagem).toHaveText(
      "O e-mail será enviado de conta1@exemplo.test para Ana Exemplo <ana@exemplo.test>. Depois de enviado, não há como desfazer.",
    );
    await page.locator("#btn-confirmar-acao-cancelar").click();
    await expect(page.locator("#modal-confirmar-acao")).toBeHidden();

    await page.locator("#email-cc").fill("copia@exemplo.test");
    await page.locator("#email-enviar").click();
    await expect(mensagem).toHaveText(
      "O e-mail será enviado de conta1@exemplo.test para Ana Exemplo <ana@exemplo.test>, com cópia para copia@exemplo.test. Depois de enviado, não há como desfazer.",
    );
    await page.locator("#btn-confirmar-acao-cancelar").click();
    await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
  });

  test("Enviar confere o Para e os marcadores antes de abrir a confirmação", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    await page.locator("#email-para").fill("");
    await page.locator("#email-enviar").click();
    await expect(statusOutlook(page)).toHaveText("Informe o destinatário no campo Para.");
    await expect(statusOutlook(page)).toHaveAttribute("data-tipo", "erro");

    await page.locator("#email-para").fill("grupo@exemplo.test");
    await page.locator("#email-enviar").click(); // o Setor está vazio: o marcador [Setor] continua no texto
    await expect(statusOutlook(page)).toHaveText("Preencha o nome da pessoa e o setor antes de enviar.");
    await expect(statusOutlook(page)).toHaveAttribute("data-tipo", "erro");
    await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
    expect(servidor.de("POST", "/email")).toHaveLength(0);
  });

  test("Excluir com um único modelo avisa na hora, sem pedir confirmação nem chamar o servidor", async ({ page }) => {
    const servidor = await abrirModalOutlook(page, { modelos: [CABO_PADRAO] });
    await page.locator("#email-modelo-excluir").click();
    await expect(statusOutlook(page)).toHaveText("Mantenha ao menos um modelo.");
    await expect(statusOutlook(page)).toHaveAttribute("data-tipo", "aviso");
    await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
    expect(servidor.chamadas.filter(({ metodo }) => metodo === "DELETE")).toEqual([]);
    await expect(page.locator("#email-modelo option")).toHaveCount(1);
  });

  test("Novo e Duplicar gravam o que está pendente, criam o modelo e o selecionam", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    const escritas = () => servidor.chamadas.filter(({ metodo }) => metodo !== "GET").map(({ metodo, caminho, corpo }) => ({ metodo, caminho, corpo }));
    await page.locator("#email-assunto").fill("Antes do novo");
    await page.locator("#email-modelo-novo").click();
    await expect(page.locator("#email-modelo")).toHaveValue("novo-2");
    expect(escritas()).toEqual([
      { metodo: "PUT", caminho: "/email/modelos/cabo", corpo: { assunto: "Antes do novo" } },
      { metodo: "POST", caminho: "/email/modelos", corpo: {} },
    ]);
    await expect(page.locator("#email-modelo-nome")).toHaveValue("Novo modelo");
    await expect(page.locator("#email-assunto")).toHaveValue("");
    await expect(page.locator("#email-modelo-restaurar")).toBeHidden(); // só o Modelo 1 tem padrão para restaurar

    await page.locator("#email-modelo").selectOption("cabo");
    await expect(page.locator("#email-assunto")).toHaveValue("Antes do novo");
    await page.locator("#email-modelo-duplicar").click();
    await expect(page.locator("#email-modelo")).toHaveValue("copia-3");
    expect(servidor.de("POST", "/email/modelos")[1].corpo).toEqual({ copiar_de: "cabo" });
    await expect(page.locator("#email-modelo-nome")).toHaveValue("Modelo 1 - Cabo (cópia)");
    await expect(page.locator("#email-assunto")).toHaveValue("Antes do novo");
  });

  test("Copiar Texto troca {nome} e {setor} e avisa por toast", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await abrirModalOutlook(page);
    await page.locator("#email-setor").fill("Setor Teste");
    await page.locator("#email-copiar").click();
    await expect(page.locator("#toast-container")).toContainText("Texto copiado.");
    const copiado = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiado.replace(/\r\n/g, "\n")).toBe( // o Windows devolve a área de transferência com CRLF
      "Cabo de segurança para Pessoa Teste\n\nOlá, Pessoa Teste do setor Setor Teste. Segue o cabo de segurança.",
    );
  });

  test("Abrir no Outlook com aviso do servidor mostra só o aviso", async ({ page }) => {
    const servidor = await abrirModalOutlook(page);
    servidor.respostaEmail = { json: { status: "aberto", aviso: "Aviso de teste do servidor." } };
    await page.locator("#email-abrir").click();
    await expect(statusOutlook(page)).toHaveText("Aviso de teste do servidor.");
    await expect(statusOutlook(page)).toHaveAttribute("data-tipo", "aviso");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Automação do Chrome em React: casos que os testes Node do módulo antigo cobriam (test_chrome_automation_*.cjs e
// test_automation_tab_structure.cjs rodavam o JS antigo com um DOM falso; agora a tela real roda no navegador).
// /api/automacao/executar (e /estado, nos casos que mudam o estado) são simulados aqui; o resto vem da fixture.
// ---------------------------------------------------------------------------------------------------------------

const emAndamento = (rotina, extra = {}) => ({ estado: "em_andamento", rotina, inicio: "2026-11-10T11:59:00-03:00", log: { linhas: [], offset: 0 }, ...extra });
const terminou = (rotina, status) => ({ estado: "livre", ultima: { id: `${rotina}-${status}`, rotina, status }, log: { linhas: [], offset: 0 } });

async function abrirAutomacao(page, request, executar = () => ({ status: 202, json: emAndamento("os") })) {
  await request.get("/__fixture_automacao?quantidade=0&sebrae=padrao&run=");
  const servidor = { chamadas: [], estado: null, executar };
  await page.route(url => url.pathname === "/api/automacao/executar", async route => {
    servidor.chamadas.push(route.request().postDataJSON());
    const resposta = await servidor.executar(servidor.chamadas.at(-1));
    return route.fulfill({ status: resposta.status ?? 202, json: resposta.json });
  });
  await page.route(url => url.pathname === "/api/automacao/estado", route => (servidor.estado ? route.fulfill({ json: servidor.estado }) : route.fallback()));
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const painel = page.locator("#tab-panel-automacao");
  await expect(painel).toBeVisible();
  await expect(painel.locator("#automacao-estado-detalhe")).toContainText("Última execução"); // a fixture traz um histórico: o primeiro estado real chegou
  await expect(painel.locator("#automacao-estado")).toContainText("Livre");
  // Os botões de OS e Verificar usuários ficam na aba "Rotina Completa" do seletor (só o painel da aba escolhida aparece).
  await painel.getByRole("tab", { name: "Rotina Completa", exact: true }).click();
  return { painel, servidor };
}

// Chama a ação do painel React como o data-on-* e a ponte do código antigo chamam.
const acaoAutomacao = (page, nome, ...args) => page.evaluate(([acao, valores]) => window.SimpressReact["chrome-automation"][acao](...valores), [nome, args]);

test.describe("Automação em React: casos do módulo antigo (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento não depende da largura: roda só no desktop");

  test.beforeEach(async ({ page }) => {
    await prepararPagina(page);
  });

  test("404 em /api/automacao mostra um único aviso de servidor desatualizado, nunca 'Not Found'", async ({ page, request }) => {
    const { painel, servidor } = await abrirAutomacao(page, request, () => ({ status: 404, json: { detail: "Not Found" } }));
    const botao = painel.locator("#btn-automacao-os");
    const avisos = page.locator("#toast-container .ck-toast");
    await botao.click();
    await expect(avisos).toHaveCount(1);
    await expect(avisos.first()).toHaveAttribute("role", "alert");
    await expect(avisos.first()).toContainText("Servidor desatualizado: reinicie o Simpress");
    await expect(botao).not.toHaveAttribute("aria-busy", "true");
    await botao.click();
    await expect.poll(() => servidor.chamadas.length).toBe(2);
    await expect(botao).not.toHaveAttribute("aria-busy", "true");
    await expect(avisos).toHaveCount(1); // o segundo 404 fica em silêncio
    await expect(page.locator("#toast-container")).not.toContainText("Not Found");
    await expect(painel.locator("#automacao-estado")).toContainText("Livre");
  });

  test("outros erros continuam exibindo a mensagem original a cada tentativa", async ({ page, request }) => {
    const { painel, servidor } = await abrirAutomacao(page, request, () => ({ status: 409, json: { detail: "Rotina ocupada." } }));
    const botao = painel.locator("#btn-automacao-os");
    const avisos = page.locator("#toast-container .ck-toast", { hasText: "Rotina ocupada." });
    await botao.click();
    await expect(avisos).toHaveCount(1);
    await expect(botao).not.toHaveAttribute("aria-busy", "true");
    await botao.click();
    await expect(avisos).toHaveCount(2);
    expect(servidor.chamadas).toEqual([{ rotina: "os" }, { rotina: "os" }]);
    await expect(avisos.first()).toHaveAttribute("role", "alert");
  });

  test("Verificar usuários envia só { rotina: \"usuarios\" } e avisa que foi iniciada", async ({ page, request }) => {
    const { painel, servidor } = await abrirAutomacao(page, request, () => ({ status: 202, json: emAndamento("usuarios") }));
    servidor.estado = emAndamento("usuarios");
    await expect(painel.locator("#btn-automacao-usuarios")).toContainText("Executar");
    await painel.locator("#btn-automacao-usuarios").click();
    await expect(page.locator("#toast-container .ck-toast", { hasText: "Verificar usuários iniciada." })).toHaveAttribute("role", "status");
    expect(servidor.chamadas).toEqual([{ rotina: "usuarios" }]);
    await expect(painel.locator("#automacao-estado")).toContainText("Ocupado");
    await expect(painel.locator("#automacao-estado-detalhe")).toContainText("Verificar usuários em andamento");
    await expect(painel.locator("#btn-automacao-usuarios")).toContainText("Acompanhar");
  });

  test("clique duplo e chamadas seguidas não iniciam uma segunda rotina; abrir a aba nunca inicia nenhuma", async ({ page, request }) => {
    const porta = portao();
    const { painel, servidor } = await abrirAutomacao(page, request, async () => {
      await porta.espera;
      return { status: 202, json: emAndamento("os") };
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(300);
    expect(servidor.chamadas).toEqual([]); // sem clique, nada começa

    servidor.estado = emAndamento("os");
    await painel.locator("#btn-automacao-os").dblclick();
    await expect.poll(() => servidor.chamadas.length).toBe(1);
    await expect(painel.locator("#btn-automacao-os")).toHaveAttribute("aria-busy", "true");
    // Com o primeiro pedido em voo, a ação do painel recusa até outra rotina (a guarda não depende do botão desabilitado).
    await acaoAutomacao(page, "iniciarRotinaAutomacao", "os");
    await acaoAutomacao(page, "iniciarRotinaAutomacao", "inventarios");
    await page.waitForTimeout(300);
    expect(servidor.chamadas).toEqual([{ rotina: "os" }]);

    porta.liberar();
    await expect(page.locator("#toast-container .ck-toast", { hasText: "Rotina de OS iniciada." })).toBeVisible();
    await expect(painel.locator("#btn-automacao-os")).toContainText("Acompanhar");
    // Com a rotina em andamento, "Executar" de outra rotina também não envia nada: só a própria rotina vira Acompanhar.
    await acaoAutomacao(page, "iniciarRotinaAutomacao", "inventarios");
    await acaoAutomacao(page, "iniciarRotinaAutomacao", "os");
    await page.waitForTimeout(300);
    expect(servidor.chamadas).toEqual([{ rotina: "os" }]);
  });

  test("o atalho 'Ver backups no Resumo' aparece ao concluir inventários ou a rotina completa e some ao iniciar outra rotina", async ({ page, request }) => {
    const { painel, servidor } = await abrirAutomacao(page, request);
    const atalho = painel.locator("#automacao-ver-backups");
    const passo = async estado => {
      servidor.estado = estado;
      await acaoAutomacao(page, "atualizarEstadoAutomacao");
    };

    await expect(atalho).toBeHidden();
    await passo(terminou("os", "concluido"));
    await expect(atalho).toBeHidden(); // sem execução observada, continua escondido

    await passo(emAndamento("os"));
    await passo(terminou("os", "concluido"));
    await expect(atalho).toBeHidden(); // rotina de OS não mostra

    await passo(emAndamento("inventarios"));
    await expect(atalho).toBeHidden();
    await passo(terminou("inventarios", "falha"));
    await expect(atalho).toBeHidden(); // falha não mostra

    await passo(emAndamento("inventarios"));
    await passo(terminou("inventarios", "concluido"));
    await expect(atalho).toBeVisible();
    await expect(atalho).toHaveText("Ver backups no Resumo");
    await expect(atalho).toHaveAttribute("data-on-click", "abrirPainelCockpit");
    await expect(atalho).toHaveAttribute("data-args", '["comparacao","backups"]');

    await passo(emAndamento("os"));
    await expect(atalho).toBeHidden(); // nova rotina esconde

    await passo(emAndamento("ambas"));
    await passo(terminou("ambas", "concluido"));
    await expect(atalho).toBeVisible(); // a rotina completa também mostra
    await passo(emAndamento("usuarios"));
    await expect(atalho).toBeHidden();
  });

  test("polling e visibilitychange não vazam: montar de novo não duplica o pedido de estado", async ({ page, request }) => {
    const { painel } = await abrirAutomacao(page, request);
    let pedidos = 0;
    await page.route(url => url.pathname === "/api/automacao/estado", route => { pedidos += 1; return route.fallback(); });
    // Cada inicializarAutomacao desfaz o observador, o ouvinte e o timer do anterior: três chamadas seguidas = um só ciclo.
    for (let i = 0; i < 3; i += 1) await acaoAutomacao(page, "inicializarAutomacao");
    await expect(painel.locator("#automacao-estado")).toContainText("Livre");
    await page.waitForTimeout(300);
    const antes = pedidos;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(300);
    expect(pedidos - antes).toBe(1); // um único ouvinte de visibilitychange (três vazados dariam 3)
  });
});
