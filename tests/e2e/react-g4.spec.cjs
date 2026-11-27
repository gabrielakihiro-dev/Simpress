// Migração React, Dia 2, grupo G4: "Nomes do Microsoft Entra" (modal Atualizar planilhas) e "Abrir chamado no UX" (Home).
// O baseline de screenshots e os testes de invariante foram gravados com o código antigo (JS puro), antes da troca
// para React: os painéis em React têm de sair iguais nos dois tamanhos (390 e 1366 px) e nos dois temas.
const { test, expect } = require("@playwright/test");

const ESTADO_ENTRA = { updated_at: "2026-01-01T10:00:00", users: 1200, logins_ignorados: 3 };
const SOLICITANTE = {
  nome: "Pessoa Exemplo", email: "nome.exemplo@pr.sebrae.com.br",
  telefone: "(41) 90000-0000", departamento_cargo: "Setor Exemplo / Cargo Exemplo",
};
const DESCRICAO = "O teclado do notebook não funciona.";
const PREPARADO = { status: "preparado", serial: "LENTO", modelo: "Notebook de teste", session_id: "fixture", opcoes: ["Notebook - Teclado"], solicitante: SOLICITANTE };
const AVISO_CHROME = "Não foi possível abrir ou conectar o Chrome de automação. Feche as janelas desse Chrome e tente de novo.";
const CAPTURA = { animations: "disabled", maxDiffPixelRatio: 0.01 };

async function prepararPagina(page, tema = "light") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
}

async function rotaEstadoEntra(page, estado) {
  await page.route("**/api/usuarios-entra/estado", route => route.fulfill({ json: estado }));
}

async function selecionarLento(page) {
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
}

async function abrirEntra(page) {
  await page.evaluate(() => window.abrirModalAtualizarPlanilhas());
  await expect(page.locator("#esc-inv-entra")).toBeVisible();
  await expect(page.locator("#entra-import-status")).not.toHaveText("Consultando cadastro…");
  await page.mouse.move(0, 0);
}

// Abre o modal do UX como o usuário: série LENTO, aba "Kit teclado + mouse", descrição preenchida.
async function abrirChamado(page) {
  await page.goto("/");
  await selecionarLento(page);
  await page.getByRole("tab", { name: "Kit teclado + mouse" }).click();
  await page.locator("#texto-chamado-teclado-mouse").fill(DESCRICAO);
  await page.getByRole("button", { name: "Abrir chamado no UX" }).click();
  return page.getByRole("dialog", { name: "Abrir chamado no UX" });
}

// Rota do UX que guarda cada pedido; `responder(caminho, corpo)` devolve { status?, json } ou "abortar".
async function rotaUx(page, responder) {
  const pedidos = [];
  await page.route("**/api/ux/abrir-chamado/**", async route => {
    const caminho = new URL(route.request().url()).pathname;
    const corpo = route.request().postDataJSON();
    pedidos.push({ caminho, corpo });
    const resposta = await responder(caminho, corpo);
    if (resposta === "abortar") return route.abort();
    return route.fulfill(resposta);
  });
  return pedidos;
}

const padraoUx = (caminho, corpo) => ({
  json: caminho.endsWith("/preparar") ? PREPARADO
    : caminho.endsWith("/cancelar") ? { status: "cancelado" }
      : corpo.enviar ? { status: "enviado", os: "98765" } : { status: "preenchido" },
});

for (const tema of ["light", "dark"]) {
  test(`baseline: seção Nomes do Microsoft Entra, tema ${tema}`, async ({ page }) => {
    await prepararPagina(page, tema);
    await rotaEstadoEntra(page, ESTADO_ENTRA);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
    await abrirEntra(page);
    await expect(page.locator("#entra-import-status")).toHaveText("1.200 nomes PR importados. 3 login(s) ignorado(s) por nomes conflitantes ou dados inválidos.");
    await expect(page.locator("#btn-exportar-nomes-entra")).toBeEnabled();
    await expect(page.locator("#esc-inv-entra")).toHaveScreenshot(`entra-${tema}.png`, CAPTURA);
  });

  test(`baseline: chamado no UX preparado, tema ${tema}`, async ({ page }) => {
    await prepararPagina(page, tema);
    await rotaUx(page, padraoUx);
    const modal = await abrirChamado(page);
    await expect(modal.getByText("Notebook de teste")).toBeVisible();
    await expect(modal.getByLabel("Problema")).toBeEnabled();
    await expect(page.locator("#ux-chamado-motivo")).toHaveText("Escolha um problema para liberar a simulação e o envio.");
    await page.mouse.move(0, 0);
    await expect(page.locator("#modal-chamado-ux .ck-dialogo")).toHaveScreenshot(`ux-preparado-${tema}.png`, CAPTURA);
  });

  test(`baseline: chamado no UX com a preparação falhando, tema ${tema}`, async ({ page }) => {
    await prepararPagina(page, tema);
    await rotaUx(page, () => ({ status: 503, json: { detail: AVISO_CHROME, codigo: "chrome_indisponivel" } }));
    await abrirChamado(page);
    await expect(page.locator("#ux-chamado-status")).toHaveText(AVISO_CHROME);
    await expect(page.locator("#ux-chamado-motivo")).toContainText("preparação no UX não foi concluída");
    await page.mouse.move(0, 0);
    await expect(page.locator("#modal-chamado-ux .ck-dialogo")).toHaveScreenshot(`ux-falha-${tema}.png`, CAPTURA);
  });
}

test.describe("comportamento (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento não depende da largura: roda só no desktop");

  // Entra: portado de tests/frontend/test_person_name.cjs (DOM falso) para a página real.
  test("Entra: sem CSV importado, avisa e mantém o download desabilitado", async ({ page }) => {
    await prepararPagina(page);
    await rotaEstadoEntra(page, { updated_at: null, users: 0, logins_ignorados: 0 });
    await page.goto("/");
    await abrirEntra(page);
    await expect(page.locator("#entra-import-status")).toHaveText("Nenhum CSV do Entra importado.");
    await expect(page.locator("#btn-exportar-nomes-entra")).toBeDisabled();
  });

  test("Entra: sem arquivo escolhido, avisa e não envia nada", async ({ page }) => {
    const enviados = [];
    await prepararPagina(page);
    await rotaEstadoEntra(page, ESTADO_ENTRA);
    await page.route("**/api/usuarios-entra/importar", route => { enviados.push(route.request().url()); return route.abort(); });
    await page.goto("/");
    await abrirEntra(page);
    await page.getByRole("button", { name: "Importar nomes" }).click();
    await expect(page.locator("#toast-container")).toContainText("Selecione o CSV exportado do Entra.");
    expect(enviados).toEqual([]);
  });

  async function importar(page, { importar: respostaImportar, equipamento }) {
    await prepararPagina(page);
    await rotaEstadoEntra(page, { updated_at: null, users: 0, logins_ignorados: 0 });
    await page.goto("/");
    await selecionarLento(page);
    let liberar;
    const portao = new Promise(resolve => { liberar = resolve; });
    const chamadas = [];
    await page.route("**/api/usuarios-entra/importar", async route => {
      chamadas.push(new URL(route.request().url()).pathname);
      await portao;
      return route.fulfill(respostaImportar);
    });
    await page.route("**/api/equipamento/LENTO", async route => {
      chamadas.push(new URL(route.request().url()).pathname);
      return equipamento(route);
    });
    await abrirEntra(page);
    await page.locator("#entra-csv-file").setInputFiles({ name: "usuarios-ficticios.csv", mimeType: "text/csv", buffer: Buffer.from("userPrincipalName,displayName\n") });
    await page.getByRole("button", { name: "Importar nomes" }).click();
    const botao = page.locator("#btn-importar-nomes-entra");
    await expect(botao).toBeDisabled();
    await expect(botao).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#entra-import-status")).toHaveText("Validando e importando o CSV…");
    liberar();
    await expect(botao).toBeEnabled();
    await expect(botao).not.toHaveAttribute("aria-busy", /.*/);
    return chamadas;
  }

  test("Entra: importa e atualiza o equipamento selecionado", async ({ page }) => {
    const chamadas = await importar(page, {
      importar: { json: { users: 1, logins_ignorados: 0 } },
      equipamento: async route => {
        const resposta = await route.fetch();
        return route.fulfill({ response: resposta, json: { ...(await resposta.json()), nome_pessoa: "Nome Fictício" } });
      },
    });
    await expect(page.locator("#toast-container")).toContainText("Nomes do Entra atualizados.");
    await expect(page.locator("#entra-import-status")).toHaveText("1 nomes PR importados.");
    expect(chamadas).toEqual(["/api/usuarios-entra/importar", "/api/equipamento/LENTO"]);
    expect(await page.evaluate(() => window.SimpressApp.state.currentEquipamento.nome_pessoa)).toBe("Nome Fictício");
    await expect(page.locator("#entra-csv-file")).toHaveValue("");
    await expect(page.locator("#entra-csv-name")).toHaveText("Escolher CSV ou arrastar aqui");
    await expect(page.locator("#btn-exportar-nomes-entra")).toBeEnabled();
  });

  test("Entra: importa mesmo quando a consulta do equipamento selecionado falha", async ({ page }) => {
    const antes = { valor: null };
    const chamadas = await importar(page, {
      importar: { json: { users: 2, logins_ignorados: 0 } },
      equipamento: async route => {
        antes.valor = await page.evaluate(() => window.SimpressApp.state.currentEquipamento.nome_pessoa ?? null);
        return route.fulfill({ status: 503, json: { detail: "consulta complementar indisponível" } });
      },
    });
    await expect(page.locator("#toast-container")).toContainText("Nomes do Entra importados, mas não foi possível atualizar o equipamento selecionado.");
    await expect(page.locator("#entra-import-status")).toHaveText(/^2 nomes PR importados\. Não foi possível atualizar o equipamento selecionado: .+/);
    expect(chamadas).toEqual(["/api/usuarios-entra/importar", "/api/equipamento/LENTO"]);
    expect(await page.evaluate(() => window.SimpressApp.state.currentEquipamento.nome_pessoa ?? null)).toBe(antes.valor);
    await expect(page.locator("#entra-csv-file")).toHaveValue("");
    await expect(page.locator("#btn-exportar-nomes-entra")).toBeEnabled();
  });

  test("Entra: falha na importação preserva o CSV escolhido e o download desabilitado", async ({ page }) => {
    const chamadas = await importar(page, {
      importar: { status: 400, json: { detail: "CSV inválido" } },
      equipamento: route => route.abort(),
    });
    await expect(page.locator("#entra-import-status")).toHaveText("CSV inválido");
    await expect(page.locator("#toast-container")).toContainText("CSV inválido");
    expect(chamadas).toEqual(["/api/usuarios-entra/importar"]);
    expect(await page.locator("#entra-csv-file").evaluate(input => input.files.length)).toBe(1);
    await expect(page.locator("#btn-exportar-nomes-entra")).toBeDisabled();
  });

  // Estado compartilhado (frontend/src/estado-app.ts): a revisão da seleção muda durante a consulta e a resposta atrasada é ignorada.
  test("Entra: ignora a consulta atrasada quando a revisão da seleção muda", async ({ page }) => {
    let liberarConsulta;
    const consulta = new Promise(resolve => { liberarConsulta = resolve; });
    let marcarIniciada;
    const iniciada = new Promise(resolve => { marcarIniciada = resolve; });
    await prepararPagina(page);
    await rotaEstadoEntra(page, { updated_at: null, users: 0, logins_ignorados: 0 });
    await page.goto("/");
    await selecionarLento(page);
    await page.route("**/api/usuarios-entra/importar", route => route.fulfill({ json: { users: 1, logins_ignorados: 0 } }));
    await page.route("**/api/equipamento/LENTO", async route => {
      marcarIniciada();
      await consulta;
      const resposta = await route.fetch();
      return route.fulfill({ response: resposta, json: { ...(await resposta.json()), nome_pessoa: "Nome Entra antigo" } });
    });
    await abrirEntra(page);
    await page.locator("#entra-csv-file").setInputFiles({ name: "usuarios-ficticios.csv", mimeType: "text/csv", buffer: Buffer.from("x\n") });
    await page.getByRole("button", { name: "Importar nomes" }).click();
    await iniciada;
    await page.evaluate(() => { window.SimpressApp.state.equipamentoSelectionRevision += 1; });
    liberarConsulta();
    await expect(page.locator("#toast-container")).toContainText("Nomes do Entra atualizados.");
    expect(await page.evaluate(() => window.SimpressApp.state.currentEquipamento.nome_pessoa ?? null)).not.toBe("Nome Entra antigo");
  });

  test("Entra: Baixar XLSX compacto abre o download do servidor local", async ({ page }) => {
    await prepararPagina(page);
    await rotaEstadoEntra(page, ESTADO_ENTRA);
    await page.route("**/api/usuarios-entra/exportar", route => route.fulfill({ body: "x", headers: { "Content-Disposition": "attachment; filename=nomes.xlsx" } }));
    await page.goto("/");
    await abrirEntra(page);
    // Por fetch + blob (leva o X-Simpress-Sessao): o pedido vai à rota e o nome sai do Content-Disposition.
    const pedido = page.waitForRequest("**/api/usuarios-entra/exportar");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Baixar XLSX compacto" }).click();
    await pedido;
    expect((await download).suggestedFilename()).toBe("nomes.xlsx");
  });

  // UX: invariante do envio real (só com enviar: true e confirmado: true, depois de "Enviar solicitação").
  test("UX: Simular envia enviar e confirmado falsos e o contexto continua síncrono", async ({ page }) => {
    const pedidos = await rotaUx(page, padraoUx);
    const modal = await abrirChamado(page);
    await modal.getByLabel("Problema").selectOption("Notebook - Teclado");
    await modal.getByRole("button", { name: "Simular preenchimento" }).click();
    await expect(page.locator("#ux-chamado-status")).toHaveText("Simulação concluída. Confira o formulário no Chrome de automação. Nenhuma solicitação foi enviada.");
    expect(pedidos.map(({ caminho, corpo }) => [caminho, corpo])).toEqual([
      ["/api/ux/abrir-chamado/preparar", { serial: "LENTO", conferido: false }],
      ["/api/ux/abrir-chamado/enviar", { session_id: "fixture", serial: "LENTO", problema: "Notebook - Teclado", descricao: DESCRICAO, solicitante: SOLICITANTE, enviar: false, confirmado: false }],
    ]);
    // O Assistente (assistant-chat.js) lê o contexto sem await.
    const contexto = await page.evaluate(() => {
      const lido = window.contextoChamadoUX();
      return lido instanceof Promise ? "promise" : lido;
    });
    expect(contexto).toEqual({ serial: "LENTO", descricao: DESCRICAO, revisao: expect.any(Number) });
  });

  test("UX: cancelar a confirmação não envia nada e devolve os botões", async ({ page }) => {
    const pedidos = await rotaUx(page, padraoUx);
    const modal = await abrirChamado(page);
    await modal.getByLabel("Problema").selectOption("Notebook - Teclado");
    await modal.getByRole("button", { name: "Revisar e enviar" }).click();
    const confirmacao = page.getByRole("alertdialog", { name: "Confirmar chamado no UX" });
    await expect(confirmacao).toContainText(DESCRICAO);
    await confirmacao.getByRole("button", { name: "Cancelar" }).click();
    await expect(modal.getByRole("button", { name: "Revisar e enviar" })).toBeEnabled();
    expect(pedidos.filter(({ caminho }) => caminho.endsWith("/enviar"))).toEqual([]);
  });

  test("UX: falha de rede no envio real não repete o envio e pede conferência no UX", async ({ page }) => {
    const pedidos = await rotaUx(page, (caminho, corpo) => (caminho.endsWith("/enviar") && corpo.enviar ? "abortar" : padraoUx(caminho, corpo)));
    const modal = await abrirChamado(page);
    await modal.getByLabel("Problema").selectOption("Notebook - Teclado");
    await modal.getByRole("button", { name: "Revisar e enviar" }).click();
    await page.getByRole("alertdialog", { name: "Confirmar chamado no UX" }).getByRole("button", { name: "Enviar solicitação" }).click();
    await expect(page.locator("#ux-chamado-status")).toHaveText("Não foi possível receber o resultado. Confira no UX se a solicitação foi criada antes de tentar novamente.");
    await expect(modal.getByRole("button", { name: "Conferi no UX; preparar de novo" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Revisar e enviar" })).toBeDisabled();
    await expect(page.locator("#ux-chamado-motivo")).toHaveText("Simulação e envio indisponíveis: esta sessão do UX já foi usada. Abra o chamado de novo se precisar.");
    const reais = pedidos.filter(({ corpo }) => corpo?.enviar === true);
    expect(reais.map(({ corpo }) => corpo)).toEqual([{ session_id: "fixture", serial: "LENTO", problema: "Notebook - Teclado", descricao: DESCRICAO, solicitante: SOLICITANTE, enviar: true, confirmado: true }]);
    // "Conferi no UX" prepara de novo com conferido: true; não reenvia.
    await modal.getByRole("button", { name: "Conferi no UX; preparar de novo" }).click();
    await expect(modal.getByLabel("Problema")).toBeEnabled();
    expect(pedidos.at(-1)).toEqual({ caminho: "/api/ux/abrir-chamado/preparar", corpo: { serial: "LENTO", conferido: true } });
    expect(pedidos.filter(({ corpo }) => corpo?.enviar === true)).toHaveLength(1);
  });

  test("UX: fechar o modal cancela a sessão preparada", async ({ page }) => {
    const pedidos = await rotaUx(page, padraoUx);
    const modal = await abrirChamado(page);
    await expect(modal.getByLabel("Problema")).toBeEnabled();
    await modal.getByRole("button", { name: "Fechar" }).click();
    await expect(page.locator("#modal-chamado-ux")).toBeHidden();
    await expect.poll(() => pedidos.map(({ caminho, corpo }) => [caminho, corpo]))
      .toEqual([["/api/ux/abrir-chamado/preparar", { serial: "LENTO", conferido: false }], ["/api/ux/abrir-chamado/cancelar", { session_id: "fixture" }]]);
    await expect(page.locator("#ux-chamado-descricao")).toHaveText("");
  });

  test("UX: troca da série durante a preparação descarta a sessão", async ({ page }) => {
    let liberar;
    const portao = new Promise(resolve => { liberar = resolve; });
    const pedidos = await rotaUx(page, async (caminho, corpo) => {
      if (caminho.endsWith("/preparar")) await portao;
      return padraoUx(caminho, corpo);
    });
    await abrirChamado(page);
    await expect(page.locator("#ux-chamado-status")).toHaveText("Preparando no UX… Se o Chrome de automação pedir login, entre manualmente.");
    await page.evaluate(() => { window.SimpressApp.state.equipamentoSelectionRevision += 1; });
    liberar();
    await expect.poll(() => pedidos.map(({ caminho }) => caminho)).toEqual(["/api/ux/abrir-chamado/preparar", "/api/ux/abrir-chamado/cancelar"]);
    expect(pedidos[1].corpo).toEqual({ session_id: "fixture" });
    await expect(page.locator("#ux-chamado-problema option")).toHaveCount(0);
  });

  // Caminho real da troca: equipment-search.js chama fecharChamadoUX pela ponte (assíncrona) antes de trocar a série.
  test("UX: trocar o equipamento pelo caminho real fecha o modal e cancela a sessão", async ({ page }) => {
    const pedidos = await rotaUx(page, padraoUx);
    const modal = await abrirChamado(page);
    await expect(modal.getByLabel("Problema")).toBeEnabled();
    await page.evaluate(() => window.definirEquipamentoAtual({ serial: "S2" }));
    await expect(page.locator("#modal-chamado-ux")).toBeHidden();
    await expect.poll(() => pedidos.map(({ caminho }) => caminho)).toEqual(["/api/ux/abrir-chamado/preparar", "/api/ux/abrir-chamado/cancelar"]);
  });

  test("UX: depois do envio real a sessão fica usada e o clique duplo pede uma confirmação só", async ({ page }) => {
    const pedidos = await rotaUx(page, padraoUx);
    const modal = await abrirChamado(page);
    await modal.getByLabel("Problema").selectOption("Notebook - Teclado");
    // #modal-confirmar-acao é um elemento só, reaproveitado: conta as chamadas, não os diálogos visíveis.
    await page.evaluate(() => {
      const original = window.confirmarAcao;
      window.__confirmacoesUx = 0;
      window.confirmarAcao = (...args) => { window.__confirmacoesUx += 1; return original(...args); };
    });
    await modal.getByRole("button", { name: "Revisar e enviar" }).dblclick();
    const confirmacao = page.getByRole("alertdialog", { name: "Confirmar chamado no UX" });
    await confirmacao.getByRole("button", { name: "Enviar solicitação" }).click();
    await expect(page.locator("#ux-chamado-status")).toHaveText("Chamado enviado. OS #98765.");
    await expect(confirmacao).toBeHidden();
    await expect(modal.getByRole("button", { name: "Revisar e enviar" })).toBeDisabled();
    await expect(page.locator("#ux-chamado-motivo")).toHaveText("Simulação e envio indisponíveis: esta sessão do UX já foi usada. Abra o chamado de novo se precisar.");
    // Chamada direta (o atalho do código antigo ainda existe em window) também não reenvia.
    await page.evaluate(() => window.executarChamadoUX(true));
    await expect(confirmacao).toBeHidden();
    expect(await page.evaluate(() => window.__confirmacoesUx)).toBe(1);
    expect(pedidos.filter(({ caminho }) => caminho.endsWith("/enviar"))).toHaveLength(1);
  });

  // Portado de tests/frontend/test_home_ux_chamado.cjs (DOM falso) para a página real.
  test("UX: sem solicitante salvo, os campos ficam editáveis e as duas ações esperam o preenchimento", async ({ page }) => {
    const pedidos = await rotaUx(page, (caminho, corpo) => (caminho.endsWith("/preparar")
      ? { json: { ...PREPARADO, solicitante: {} } } : padraoUx(caminho, corpo)));
    const modal = await abrirChamado(page);
    await modal.getByLabel("Problema").selectOption("Notebook - Teclado");
    const campos = { Nome: SOLICITANTE.nome, "E-mail": SOLICITANTE.email, Telefone: SOLICITANTE.telefone, "Departamento/Cargo": SOLICITANTE.departamento_cargo };
    for (const rotulo of Object.keys(campos)) await expect(modal.getByLabel(rotulo)).toHaveValue("");
    const motivo = page.locator("#ux-chamado-motivo");
    await expect(motivo).toHaveText("Preencha todos os campos do solicitante para liberar a simulação e o envio.");
    for (const nome of ["Simular preenchimento", "Revisar e enviar"]) {
      const botao = modal.getByRole("button", { name: nome });
      await expect(botao).toBeDisabled();
      await expect(botao).toHaveAttribute("title", "Preencha todos os campos do solicitante para liberar a simulação e o envio.");
    }
    // A guarda vale também na chamada direta (window.executarChamadoUX), sem passar pelo botão.
    await page.evaluate(() => window.executarChamadoUX(true));
    await expect(page.getByRole("alertdialog", { name: "Confirmar chamado no UX" })).toHaveCount(0);
    for (const [rotulo, valor] of Object.entries(campos)) await modal.getByLabel(rotulo).fill(valor);
    await expect(motivo).toBeHidden();
    await expect(modal.getByRole("button", { name: "Simular preenchimento" })).toBeEnabled();
    await expect(modal.getByRole("button", { name: "Revisar e enviar" })).toHaveAttribute("title", "");
    await modal.getByLabel("Nome").fill("  ");
    for (const nome of ["Simular preenchimento", "Revisar e enviar"]) await expect(modal.getByRole("button", { name: nome })).toBeDisabled();
    await page.evaluate(() => window.executarChamadoUX(true));
    await expect(page.getByRole("alertdialog", { name: "Confirmar chamado no UX" })).toHaveCount(0);
    expect(pedidos.map(({ caminho }) => caminho)).toEqual(["/api/ux/abrir-chamado/preparar"]);
    // Espaços nas pontas não vão para o UX.
    await modal.getByLabel("Nome").fill(SOLICITANTE.nome);
    await modal.getByLabel("Departamento/Cargo").fill(" " + SOLICITANTE.departamento_cargo + " ");
    await modal.getByRole("button", { name: "Simular preenchimento" }).click();
    await expect.poll(() => pedidos.at(-1)?.corpo?.solicitante).toEqual(SOLICITANTE);
  });

  // Formato real do backend sem data/state/ux_solicitante.json: os 4 campos com "".
  test("UX: solicitante com os 4 campos vazios do backend mantém o envio bloqueado", async ({ page }) => {
    const vazio = { nome: "", email: "", telefone: "", departamento_cargo: "" };
    const pedidos = await rotaUx(page, (caminho, corpo) => (caminho.endsWith("/preparar")
      ? { json: { ...PREPARADO, solicitante: vazio } } : padraoUx(caminho, corpo)));
    const modal = await abrirChamado(page);
    await modal.getByLabel("Problema").selectOption("Notebook - Teclado");
    for (const rotulo of ["Nome", "E-mail", "Telefone", "Departamento/Cargo"]) {
      await expect(modal.getByLabel(rotulo)).toHaveValue("");
      await expect(modal.getByLabel(rotulo)).toBeEditable();
    }
    await expect(page.locator("#ux-chamado-motivo")).toHaveText("Preencha todos os campos do solicitante para liberar a simulação e o envio.");
    for (const nome of ["Simular preenchimento", "Revisar e enviar"]) await expect(modal.getByRole("button", { name: nome })).toBeDisabled();
    await page.evaluate(() => window.executarChamadoUX(false));
    await page.evaluate(() => window.executarChamadoUX(true));
    await expect(page.getByRole("alertdialog", { name: "Confirmar chamado no UX" })).toHaveCount(0);
    expect(pedidos.map(({ caminho }) => caminho)).toEqual(["/api/ux/abrir-chamado/preparar"]);
  });

  test("UX: descrição com campo em branco não abre o modal", async ({ page }) => {
    const pedidos = await rotaUx(page, padraoUx);
    await page.goto("/");
    await selecionarLento(page);
    await page.getByRole("tab", { name: "Kit teclado + mouse" }).click();
    await page.locator("#texto-chamado-teclado-mouse").fill("Defeito: [descreva]");
    await page.getByRole("button", { name: "Abrir chamado no UX" }).click();
    await expect(page.locator("#toast-container")).toContainText("Preencha a descrição e substitua os campos em branco ou entre colchetes.");
    await expect(page.locator("#modal-chamado-ux")).toBeHidden();
    expect(pedidos).toEqual([]);
  });
});
