// Migração React, Dia 2, grupo G2 (Ferramentas): configuracao-local, units-catalog e inventory-upload.
// Os baselines de screenshots foram gravados com o código antigo (JS puro), antes da troca para React:
// cada painel em React tem de sair igual nos dois tamanhos (390 e 1366 px) e nos dois temas.
const { test, expect } = require("@playwright/test");

async function prepararTema(page, tema) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
}

async function abrirApp(page, tema) {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  // As pontes esperam o bundle React: a marca de vida vem depois do primeiro commit.
  await expect(page.locator("html")).toHaveAttribute("data-react-pronto", /.*/);
  await page.mouse.move(0, 0);
}

// ---------------------------------------------------------------- Configuração local
// Mesmo contrato de routers/configuracao_local.py, só com dados fictícios.
function leituraConfiguracao() {
  const conta = (id, rotulo, extra) => ({
    id, rotulo, placeholder: "nome@exemplo.invalid", ajuda: "Usada para: Dashboard", tipo: "email",
    valor: "", fonte: "", somente_leitura: false, usar_no_outlook: null, valido: true, ...extra,
  });
  return {
    status: { state: "ready", faltando: [], reason: "" },
    contas: [
      conta("conta_simpress", "Conta Simpress (e-mail)", { valor: "pessoa@exemplo.invalid", usar_no_outlook: true }),
      conta("conta_sebrae", "Conta Sebrae (e-mail)", { usar_no_outlook: false, valido: false }),
      conta("usuario_endpoint", "Usuário do Endpoint Central", { valor: "usuario.exemplo", somente_leitura: true, fonte: "ambiente" }),
    ],
    links: [{
      chave: "dashboard_pasta_url", rotulo: "Link da pasta do Dashboard (SharePoint)", placeholder: "https://exemplo.invalid/pasta",
      ajuda: "Usado para: Dashboard", valor: "https://exemplo.invalid/pasta", fonte: "arquivo", somente_leitura: false, valido: true,
    }],
    contas_arquivo_invalido: false,
    cliente: { configurado: true, arquivo_invalido: false, valido: true },
    assistente: {
      openrouter: { configurada: true, final: "…abcd", fonte: "arquivo" },
      deepseek: { configurada: true, final: "…wxyz", fonte: "ambiente" },
    },
  };
}
const CLIENTE = { contrato: "10101", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: ["ABC123", "XYZ789"], cliente_fontes: {} };

async function rotasConfiguracao(page, { falhar = false } = {}) {
  const requisicoes = [];
  let leitura = leituraConfiguracao();
  let cliente = { ...CLIENTE };
  const registrar = route => requisicoes.push({
    metodo: route.request().method(), url: new URL(route.request().url()).pathname, corpo: route.request().postDataJSON?.() ?? null,
  });
  await page.route("**/api/config/local", route => (falhar
    ? route.fulfill({ status: 500, json: { detail: "Falha sintética ao ler a configuração." } })
    : route.fulfill({ json: leitura })));
  await page.route("**/api/config/local/contas", route => { registrar(route); return route.fulfill({ json: leitura }); });
  await page.route("**/api/config/local/assistente", route => {
    registrar(route);
    leitura = { ...leitura, assistente: { ...leitura.assistente, openrouter: { configurada: true, final: "…9876", fonte: "arquivo" } } };
    return route.fulfill({ json: leitura.assistente });
  });
  await page.route("**/api/config/local/assistente/*", route => {
    registrar(route);
    leitura = { ...leitura, assistente: { ...leitura.assistente, openrouter: { configurada: false, final: "", fonte: "" } } };
    return route.fulfill({ json: leitura.assistente });
  });
  await page.route("**/api/config/cliente", route => {
    if (route.request().method() === "PUT") {
      registrar(route);
      cliente = { ...cliente, ...route.request().postDataJSON() };
    }
    return route.fulfill({ json: cliente });
  });
  return requisicoes;
}

async function abrirConfiguracao(page, { tema = "light", falhar = false } = {}) {
  await prepararTema(page, tema);
  const requisicoes = await rotasConfiguracao(page, { falhar });
  await abrirApp(page, tema);
  await page.evaluate(() => window.abrirConfiguracaoLocal());
  await expect(page.locator("#modal-configuracao-local")).toBeVisible();
  return requisicoes;
}

const dialogo = page => page.locator("#modal-configuracao-local .ckp-dialogo");

for (const tema of ["light", "dark"]) {
  test(`baseline: configuração local preenchida, tema ${tema}`, async ({ page }) => {
    await abrirConfiguracao(page, { tema });
    await expect(page.locator("#cfg-local-secao-contas")).toBeVisible();
    await expect(page.locator("#cfg-local-conta-conta_simpress")).toBeFocused();
    await expect(dialogo(page)).toHaveScreenshot(`configuracao-local-pronto-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
    // O diálogo rola: as seções de baixo ganham screenshot próprio.
    for (const secao of ["cliente", "assistente"]) {
      const alvo = page.locator(`#cfg-local-secao-${secao}`);
      await alvo.scrollIntoViewIfNeeded();
      await expect(alvo).toHaveScreenshot(`configuracao-local-${secao}-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
    }
  });

  test(`baseline: configuração local com falha ao ler, tema ${tema}`, async ({ page }) => {
    await abrirConfiguracao(page, { tema, falhar: true });
    await expect(page.locator("#cfg-local-carga")).toContainText("Falha sintética");
    await expect(dialogo(page)).toHaveScreenshot(`configuracao-local-erro-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}

// Comportamento do modal em React (antes coberto por tests/frontend/test_configuracao_local.cjs, com DOM falso).
// Cada rota responde com os dados fictícios acima; `respostas` troca uma rota por "MÉTODO /caminho".
async function rotasComportamento(page, { leitura = leituraConfiguracao(), cliente = { ...CLIENTE }, respostas = {} } = {}) {
  const requisicoes = [];
  const padroes = {
    "GET /api/config/local": () => ({ json: leitura }),
    "GET /api/config/cliente": () => ({ json: cliente }),
    "PUT /api/config/local/contas": () => ({ json: leitura }),
    "PUT /api/config/cliente": corpo => ({ json: { ...cliente, ...corpo, series_sebrae_fora: corpo.series_sebrae_fora ?? cliente.series_sebrae_fora } }),
    "PUT /api/config/local/assistente": () => ({ json: { ...leitura.assistente, openrouter: { configurada: true, final: "…novo", fonte: "arquivo" } } }),
    "DELETE /api/config/local/assistente/openrouter": () => ({ json: { ...leitura.assistente, openrouter: { configurada: false, final: "", fonte: "" } } }),
  };
  await page.route(/\/api\/config\/(local|cliente)(\/.*)?$/, async route => {
    const pedido = route.request();
    const chave = `${pedido.method()} ${new URL(pedido.url()).pathname}`;
    const corpo = pedido.postData() ? pedido.postDataJSON() : null;
    requisicoes.push({ chave, corpo });
    const responder = respostas[chave] ?? padroes[chave];
    if (!responder) return route.fulfill({ status: 404, json: { detail: `rota sem resposta no teste: ${chave}` } });
    const { status = 200, json } = await responder(corpo);
    return route.fulfill({ status, json });
  });
  return requisicoes;
}

// Abre o modal com toasts, prontidão e transferência contados em window.__registro.
async function abrirComportamento(page, { semAtalho = false, ...opcoes } = {}) {
  await prepararTema(page, "light");
  const requisicoes = await rotasComportamento(page, opcoes);
  await abrirApp(page, "light");
  await page.evaluate(sem => {
    const registro = { toasts: [], prontidao: 0, transferencia: 0 };
    window.__registro = registro;
    const showToast = window.showToast;
    window.showToast = (mensagem, tipo) => { registro.toasts.push([mensagem, tipo]); return showToast(mensagem, tipo); };
    window.carregarProntidao = () => { registro.prontidao += 1; };
    window.carregarConfiguracaoTransferencia = () => { registro.transferencia += 1; };
    if (sem) window.abrirConfiguracaoContatoOrigem = undefined;
  }, semAtalho);
  await page.evaluate(() => window.abrirConfiguracaoLocal());
  await expect(page.locator("#modal-configuracao-local")).toBeVisible();
  const registro = () => page.evaluate(() => window.__registro);
  const pedidos = metodo => requisicoes.filter(r => r.chave.startsWith(`${metodo} `));
  const ultima = chave => requisicoes.filter(r => r.chave === chave).at(-1);
  return { requisicoes, registro, pedidos, ultima };
}

const SECOES = ["contas", "links", "cliente", "assistente", "atalhos"];
const ESCONDIDA = /(^|\s)hidden(\s|$)/;
const CHAVE_DIGITADA = "chave-ficticia-para-teste";

test.describe("Configuração local em React: comportamento", () => {
  test("abrir monta contas, links, chaves e cliente a partir da API e foca o primeiro campo editável", async ({ page }) => {
    const { requisicoes } = await abrirComportamento(page);
    expect(requisicoes.map(r => r.chave).sort()).toEqual(["GET /api/config/cliente", "GET /api/config/local"]);
    const simpress = page.locator("#cfg-local-conta-conta_simpress");
    await expect(simpress).toBeFocused();
    await expect(simpress).toHaveAttribute("placeholder", "nome@exemplo.invalid");
    await expect(simpress).toHaveAttribute("aria-describedby", "cfg-local-conta-conta_simpress-ajuda");
    await expect(page.locator("#cfg-local-conta-conta_simpress-ajuda")).toHaveText("Usada para: Dashboard");
    await expect(page.locator("#cfg-local-contas label").first()).toHaveText("Conta Simpress (e-mail)");
    await expect(page.locator("#cfg-local-outlook-conta_simpress")).toBeChecked();
    await expect(page.locator("#cfg-local-outlook-conta_sebrae")).not.toBeChecked();
    const endpoint = page.locator("#cfg-local-conta-usuario_endpoint");
    await expect(endpoint).toHaveJSProperty("readOnly", true);
    await expect(endpoint).toHaveValue("usuario.exemplo");
    await expect(page.locator("#cfg-local-conta-usuario_endpoint-ambiente")).toHaveText("Definido por variável de ambiente");
    await expect(page.locator("#cfg-local-outlook-usuario_endpoint")).toHaveCount(0);
    await expect(page.locator("#cfg-local-link-dashboard_pasta_url")).toHaveAttribute("placeholder", "https://exemplo.invalid/pasta");
    await expect(page.locator("#cfg-local-link-dashboard_pasta_url-ajuda")).toHaveText("Usado para: Dashboard");
    await expect(page.locator("#cfg-local-contrato")).toHaveValue("10101");
    await expect(page.locator("#cfg-local-cnpj")).toHaveValue("11.222.333/0001-81");
    await expect(page.locator("#cfg-local-series")).toHaveValue("ABC123\nXYZ789");
    await expect(page.locator("#cfg-local-cliente-ambiente")).toBeHidden();
    for (const secao of SECOES) await expect(page.locator(`#cfg-local-secao-${secao}`), secao).not.toHaveClass(ESCONDIDA);
  });

  test("chaves de IA nascem vazias, mostram só o final e o Remover só aparece com chave própria", async ({ page }) => {
    await abrirComportamento(page);
    const openrouter = page.locator("#cfg-local-chave-openrouter");
    await expect(openrouter).toHaveValue("");
    await expect(openrouter).toHaveAttribute("placeholder", "…abcd");
    await expect(openrouter).toHaveAttribute("type", "password");
    await expect(openrouter).toHaveAttribute("autocomplete", "new-password");
    // A do DeepSeek vem do ambiente: somente leitura e sem Remover.
    await expect(page.locator("#cfg-local-chave-deepseek")).toHaveJSProperty("readOnly", true);
    await expect(page.locator("#cfg-local-chave-deepseek-ajuda")).toContainText("variável de ambiente");
    const botoes = page.locator("#cfg-local-chaves button");
    await expect(botoes).toHaveCount(1);
    await expect(botoes).toHaveText("Remover chave");
    await expect(botoes).toHaveAttribute("data-on-click", "removerChaveAssistenteConfiguracaoLocal");
    await expect(botoes).toHaveAttribute("data-args", '["openrouter"]');
  });

  test("chave não configurada mostra Não configurada", async ({ page }) => {
    const leitura = leituraConfiguracao();
    leitura.assistente.deepseek = { configurada: false, final: "", fonte: "" };
    await abrirComportamento(page, { leitura });
    await expect(page.locator("#cfg-local-chave-deepseek")).toHaveAttribute("placeholder", "Não configurada");
  });

  test("sem a função de contato de origem, a seção de atalhos fica escondida", async ({ page }) => {
    await abrirComportamento(page, { semAtalho: true });
    await expect(page.locator("#cfg-local-secao-atalhos")).toHaveClass(ESCONDIDA);
    await expect(page.locator("#cfg-local-secao-contas")).not.toHaveClass(ESCONDIDA);
  });

  test("falha ao ler esconde as seções, mostra o erro em alerta e salvar não dispara requisição", async ({ page }) => {
    const env = await abrirComportamento(page, {
      respostas: { "GET /api/config/local": () => ({ status: 500, json: { detail: "Servidor fora do ar." } }) },
    });
    const carga = page.locator("#cfg-local-carga");
    await expect(carga).toHaveText("Servidor fora do ar.");
    await expect(carga).toBeVisible();
    await expect(carga).toHaveAttribute("role", "alert");
    for (const secao of SECOES) await expect(page.locator(`#cfg-local-secao-${secao}`), secao).toHaveClass(ESCONDIDA);
    await page.evaluate(() => window.salvarContasConfiguracaoLocal());
    expect(env.pedidos("PUT")).toHaveLength(0);
  });

  test("salvar contas envia só as contas, deixa o somente leitura em branco e recarrega a prontidão", async ({ page }) => {
    const env = await abrirComportamento(page);
    await page.locator("#cfg-local-conta-conta_simpress").fill("  pessoa@exemplo.invalid ");
    await page.locator("#cfg-local-link-dashboard_pasta_url").fill("https://exemplo.invalid/nao-enviar");
    await page.locator("#cfg-local-outlook-conta_sebrae").check();
    await page.evaluate(() => window.salvarContasConfiguracaoLocal());
    expect(env.ultima("PUT /api/config/local/contas").corpo).toEqual({
      conta_simpress: "pessoa@exemplo.invalid", usar_no_outlook_simpress: true,
      conta_sebrae: "", usar_no_outlook_sebrae: true, usuario_endpoint: "", links: {},
    });
    const registro = await env.registro();
    expect(registro.toasts).toEqual([["Contas salvas.", "success"]]);
    expect(registro.prontidao).toBe(1);
    await expect(page.locator("#cfg-local-status-contas")).toHaveText("Contas salvas.");
    await expect(page.locator("#cfg-local-status-contas")).toHaveAttribute("role", "status");
  });

  test("salvar links envia só os links e mantém o texto não salvo das contas", async ({ page }) => {
    const env = await abrirComportamento(page);
    await page.locator("#cfg-local-conta-conta_simpress").fill("outra@exemplo.invalid");
    await page.locator("#cfg-local-link-dashboard_pasta_url").fill(" https://exemplo.invalid/pasta-nova ");
    await page.evaluate(() => window.salvarLinksConfiguracaoLocal());
    const corpo = env.ultima("PUT /api/config/local/contas").corpo;
    expect(corpo.conta_simpress).toBe("");
    expect(corpo.conta_sebrae).toBe("");
    expect(corpo.links).toEqual({ dashboard_pasta_url: "https://exemplo.invalid/pasta-nova" });
    expect((await env.registro()).toasts).toEqual([["Links salvos.", "success"]]);
    await expect(page.locator("#cfg-local-conta-conta_simpress")).toHaveValue("outra@exemplo.invalid");
  });

  test("erro 422 aparece na seção em alerta, sem toast de sucesso nem recarga", async ({ page }) => {
    const mensagem = "\"Conta Simpress (e-mail)\" não é um e-mail válido.";
    const env = await abrirComportamento(page, {
      respostas: { "PUT /api/config/local/contas": () => ({ status: 422, json: { detail: mensagem } }) },
    });
    await page.evaluate(() => window.salvarContasConfiguracaoLocal());
    const status = page.locator("#cfg-local-status-contas");
    await expect(status).toHaveText(mensagem);
    await expect(status).toHaveAttribute("role", "alert");
    const registro = await env.registro();
    expect(registro.toasts.filter(([, tipo]) => tipo === "success")).toHaveLength(0);
    expect(registro.prontidao).toBe(0);
    await expect(page.locator("#cfg-local-salvar-contas")).toBeEnabled();
  });

  test("cliente recusa contrato e CNPJ fora do formato antes de enviar e foca o campo errado", async ({ page }) => {
    const env = await abrirComportamento(page);
    await page.locator("#cfg-local-contrato").fill("12a");
    await page.evaluate(() => window.salvarClienteConfiguracaoLocal());
    await expect(page.locator("#cfg-local-status-cliente")).toHaveText("Informe o \"Contrato\" só com números (até 12 dígitos).");
    await expect(page.locator("#cfg-local-contrato")).toBeFocused();
    await page.locator("#cfg-local-contrato").fill("10101");
    await page.locator("#cfg-local-cnpj").fill("11222333000181");
    await page.evaluate(() => window.salvarClienteConfiguracaoLocal());
    await expect(page.locator("#cfg-local-status-cliente")).toHaveText("Informe o \"CNPJ de faturamento\" no formato 00.000.000/0000-00.");
    await expect(page.locator("#cfg-local-cnpj")).toBeFocused();
    expect(env.pedidos("PUT")).toHaveLength(0);
    expect((await env.registro()).toasts).toHaveLength(0);
  });

  test("salvar cliente envia as séries separadas e atualiza o formulário de transferência", async ({ page }) => {
    const env = await abrirComportamento(page);
    await page.locator("#cfg-local-contrato").fill(" 20202 ");
    await page.locator("#cfg-local-series").fill("SERIE001\nSERIE003, SERIE004;\n\n");
    await page.evaluate(() => window.salvarClienteConfiguracaoLocal());
    expect(env.ultima("PUT /api/config/cliente").corpo).toEqual({
      contrato: "20202", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: ["SERIE001", "SERIE003", "SERIE004"],
    });
    const registro = await env.registro();
    expect(registro.toasts).toEqual([["Dados do cliente salvos.", "success"]]);
    expect(registro.transferencia).toBe(1);
    expect(registro.prontidao).toBe(1);
    await expect(page.locator("#cfg-local-series")).toHaveValue("SERIE001\nSERIE003\nSERIE004");
  });

  test("cliente vindo do ambiente fica somente leitura e vai em branco ou null", async ({ page }) => {
    const env = await abrirComportamento(page, { cliente: { ...CLIENTE, cliente_fontes: { contrato: "ambiente", series_sebrae_fora: "ambiente" } } });
    await expect(page.locator("#cfg-local-contrato")).toHaveJSProperty("readOnly", true);
    await expect(page.locator("#cfg-local-series")).toHaveJSProperty("readOnly", true);
    await expect(page.locator("#cfg-local-cnpj")).toHaveJSProperty("readOnly", false);
    await expect(page.locator("#cfg-local-cliente-ambiente")).toBeVisible();
    await page.evaluate(() => window.salvarClienteConfiguracaoLocal());
    expect(env.ultima("PUT /api/config/cliente").corpo).toEqual({ contrato: "", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: null });
  });

  test("salvar assistente sem chave digitada não faz requisição e avisa que manteve as atuais", async ({ page }) => {
    const env = await abrirComportamento(page);
    await page.evaluate(() => window.salvarAssistenteConfiguracaoLocal());
    expect(env.requisicoes.filter(r => r.chave.includes("/assistente"))).toHaveLength(0);
    await expect(page.locator("#cfg-local-status-assistente")).toHaveText("Nenhuma chave nova digitada. As chaves atuais foram mantidas.");
  });

  test("a chave enviada sai do campo e nunca aparece em tela nem em toast, com sucesso ou com erro", async ({ page }) => {
    let falhar = false;
    const leitura = leituraConfiguracao();
    leitura.assistente.deepseek = { configurada: false, final: "", fonte: "" };
    const env = await abrirComportamento(page, {
      leitura,
      respostas: {
        "PUT /api/config/local/assistente": () => (falhar
          ? { status: 500, json: { detail: "Não foi possível salvar a chave." } }
          : { json: { openrouter: { configurada: true, final: "…novo", fonte: "arquivo" }, deepseek: { configurada: false, final: "", fonte: "" } } }),
      },
    });
    await page.locator("#cfg-local-chave-openrouter").fill(`  ${CHAVE_DIGITADA} `);
    await page.evaluate(() => window.salvarAssistenteConfiguracaoLocal());
    expect(env.ultima("PUT /api/config/local/assistente").corpo).toEqual({ openrouter_api_key: CHAVE_DIGITADA });
    await expect(page.locator("#cfg-local-chave-openrouter")).toHaveValue("");
    await expect(page.locator("#cfg-local-chave-openrouter")).toHaveAttribute("placeholder", "…novo");
    expect((await env.registro()).toasts).toEqual([["Chave salva.", "success"]]);

    falhar = true;
    await page.locator("#cfg-local-chave-deepseek").fill(CHAVE_DIGITADA);
    await page.evaluate(() => window.salvarAssistenteConfiguracaoLocal());
    await expect(page.locator("#cfg-local-chave-deepseek")).toHaveValue("");
    await expect(page.locator("#cfg-local-status-assistente")).toHaveText("Não foi possível salvar a chave.");
    const textos = await page.evaluate(() => [
      document.getElementById("modal-configuracao-local").textContent,
      JSON.stringify(window.__registro.toasts),
      [...document.querySelectorAll("#modal-configuracao-local input")].map(input => input.value).join(" "),
    ]);
    textos.forEach(texto => expect(texto).not.toContain(CHAVE_DIGITADA));
  });

  test("remover chave pede confirmação, só chama DELETE se confirmar e devolve o foco ao campo", async ({ page }) => {
    const env = await abrirComportamento(page);
    await page.evaluate(() => {
      window.__confirmar = false;
      window.confirmarAcao = async opcoes => { window.__pedido = opcoes; return window.__confirmar; };
    });
    await page.evaluate(() => window.removerChaveAssistenteConfiguracaoLocal("openrouter"));
    const pedido = await page.evaluate(() => window.__pedido);
    expect(pedido.titulo).toBe("Remover chave?");
    expect(pedido.confirmar).toBe("Remover chave");
    expect(env.pedidos("DELETE")).toHaveLength(0);

    await page.evaluate(() => { window.__confirmar = true; });
    await page.evaluate(() => window.removerChaveAssistenteConfiguracaoLocal("openrouter"));
    expect(env.pedidos("DELETE").map(r => r.chave)).toEqual(["DELETE /api/config/local/assistente/openrouter"]);
    expect((await env.registro()).toasts).toEqual([["Chave do OpenRouter removida.", "success"]]);
    await expect(page.locator("#cfg-local-chave-openrouter")).toHaveAttribute("placeholder", "Não configurada");
    await expect(page.locator("#cfg-local-chaves button")).toHaveCount(0);
    await expect(page.locator("#cfg-local-chave-openrouter")).toBeFocused();
  });

  test("remover aceita só identificadores conhecidos", async ({ page }) => {
    const env = await abrirComportamento(page);
    await page.evaluate(() => window.removerChaveAssistenteConfiguracaoLocal("../contas"));
    expect(env.pedidos("DELETE")).toHaveLength(0);
  });

  test("fechar é ignorado enquanto salva e depois devolve o foco ao botão Configurar", async ({ page }) => {
    let liberar;
    const espera = new Promise(resolve => { liberar = resolve; });
    const env = await abrirComportamento(page, {
      respostas: { "PUT /api/config/local/contas": async () => { await espera; return { json: leituraConfiguracao() }; } },
    });
    await page.evaluate(() => {
      window.__salvando = Promise.all([window.salvarContasConfiguracaoLocal(), window.salvarContasConfiguracaoLocal()]);
    });
    const modal = page.locator("#modal-configuracao-local");
    await expect(modal).toHaveAttribute("aria-busy", "true");
    for (const secao of ["contas", "links", "cliente", "assistente"]) await expect(page.locator(`#cfg-local-salvar-${secao}`), secao).toBeDisabled();
    await page.evaluate(() => window.fecharConfiguracaoLocal());
    await expect(modal).toBeVisible();

    liberar();
    await page.evaluate(() => window.__salvando);
    await expect(modal).not.toHaveAttribute("aria-busy", /.*/);
    expect(env.pedidos("PUT")).toHaveLength(1);
    for (const secao of ["contas", "links", "cliente", "assistente"]) await expect(page.locator(`#cfg-local-salvar-${secao}`), secao).toBeEnabled();

    // O botão Configurar só existe com a prontidão pendente (o clique real está em configuracao-local.spec.cjs).
    await page.evaluate(() => {
      if (!document.getElementById("btn-configuracao-local")) {
        document.body.append(Object.assign(document.createElement("button"), { id: "btn-configuracao-local", textContent: "Configurar" }));
      }
      window.fecharConfiguracaoLocal();
    });
    await expect(modal).toBeHidden();
    await expect(page.locator("#btn-configuracao-local")).toBeFocused();
  });

  test("arquivo de contas inválido avisa na seção de contas ao abrir", async ({ page }) => {
    const leitura = leituraConfiguracao();
    leitura.contas_arquivo_invalido = true;
    await abrirComportamento(page, { leitura });
    await expect(page.locator("#cfg-local-status-contas")).toHaveText("O arquivo de contas está inválido. Ao salvar, ele é regravado.");
    await expect(page.locator("#cfg-local-status-contas")).toHaveAttribute("role", "alert");
  });
});

// ---------------------------------------------------------------- Catálogo de unidades
// Unidades fictícias; o contrato é o de routers/units.py (GET /api/unidades, POST /api/unidade/salvar).
function unidadesFicticias() {
  return [
    { id: 1, label: "Curitiba Sede", cidade: "Curitiba", uf: "PR", endereco: "Rua Exemplo, 100", cep: "80000-000", cnpj: "00.000.000/0001-91", is_sede: true },
    { id: 2, label: "Londrina", cidade: "Londrina", uf: "PR", endereco: "Av. Fictícia, 50", cep: "86000-000", cnpj: "00.000.000/0002-72", is_sede: false },
    { id: 3, label: "", cidade: "Maringá", uf: "PR", endereco: "Rua Teste, 7", cep: "", cnpj: "", is_sede: false },
  ];
}

async function abrirUnidades(page, { tema = "light", unidades = unidadesFicticias() } = {}) {
  // Com rolagem, o cabeçalho fixo entra no topo da captura do painel (falha intermitente na CI, run 43733263939).
  // Viewport alto deixa o painel inteiro sem rolagem; a largura, que decide o layout, não muda.
  await page.setViewportSize({ width: page.viewportSize().width, height: 2000 });
  await prepararTema(page, tema);
  await page.route("**/api/unidades", route => route.fulfill({ json: unidades }));
  await abrirApp(page, tema);
  await page.evaluate(() => window.abrirModalGerenciarUnidades());
  await expect(page.locator('[data-cockpit-tool-panel="unidades"]')).toBeVisible();
}

const painelUnidades = page => page.locator('[data-cockpit-tool-panel="unidades"]');

for (const tema of ["light", "dark"]) {
  test(`baseline: catálogo de unidades em grade de cartões, tema ${tema}`, async ({ page }) => {
    await abrirUnidades(page, { tema });
    await expect(page.locator("#cockpit-units-status")).toHaveText("3 de 3");
    await expect(painelUnidades(page)).toHaveScreenshot(`unidades-lista-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });

  test(`baseline: catálogo de unidades com formulário de edição, tema ${tema}`, async ({ page }) => {
    await abrirUnidades(page, { tema });
    await page.locator("#cockpit-units-list-body").getByRole("button", { name: "Editar CNPJ da unidade Curitiba" }).first().click();
    await expect(page.locator("#form-unidade-cnpj")).toBeFocused();
    await page.locator("#form-unidade-cnpj").blur();
    await expect(painelUnidades(page)).toHaveScreenshot(`unidades-formulario-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });

  test(`baseline: catálogo de unidades vazio abre o formulário, tema ${tema}`, async ({ page }) => {
    await abrirUnidades(page, { tema, unidades: [] });
    await expect(page.locator("#form-nova-unidade")).toBeVisible();
    await expect(page.locator("#form-unidade-cidade")).toBeFocused();
    await page.locator("#form-unidade-cidade").blur();
    await expect(page.locator("#cockpit-units-list-body")).toContainText("O catálogo não contém unidades.");
    await expect(painelUnidades(page)).toHaveScreenshot(`unidades-vazio-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}

// Comportamento do catálogo em React. Substitui tests/frontend/test_units_catalog.cjs (carregarUnidades) e o caso
// 422 de salvarUnidadeForm que estava em tests/frontend/test_api_errors.cjs.
async function abrirUnidadesComportamento(page, { unidades = unidadesFicticias(), salvar = null } = {}) {
  await prepararTema(page, "light");
  const pedidos = [];
  let lista = unidades;
  await page.route("**/api/unidades", route => {
    pedidos.push("GET");
    return typeof lista === "function" ? lista(route) : route.fulfill({ json: lista });
  });
  await page.route("**/api/unidade/salvar", async route => {
    pedidos.push(["POST", route.request().postDataJSON()]);
    const { status = 200, json = { mensagem: "Unidade salva com sucesso!" } } = salvar ? await salvar() : {};
    return route.fulfill({ status, json });
  });
  await abrirApp(page, "light");
  await page.evaluate(() => {
    window.__toasts = [];
    const showToast = window.showToast;
    window.showToast = (mensagem, tipo) => { window.__toasts.push([mensagem, tipo]); return showToast(mensagem, tipo); };
  });
  return { pedidos, trocarLista: nova => { lista = nova; }, toasts: () => page.evaluate(() => window.__toasts) };
}

test.describe("Catálogo de unidades em React: comportamento", () => {
  test("busca filtra os cartões, marca o trecho achado, acha CNPJ só por dígitos e o lápis abre o formulário com o CNPJ", async ({ page }) => {
    await abrirUnidadesComportamento(page);
    await page.evaluate(() => window.abrirModalGerenciarUnidades());
    const corpo = page.locator("#cockpit-units-list-body");
    const busca = page.locator("#cockpit-units-search");
    await expect(page.locator("#cockpit-units-status")).toHaveText("3 de 3");
    await expect(page.locator("#cockpit-units-kpis .ck-kpi__valor")).toHaveText(["3", "3", "2"]);
    await expect(corpo.locator(".nlc-cartao")).toHaveCount(3);
    await expect(corpo.locator(".nlc-cartao--sede")).toContainText("SEDE");
    await expect(corpo.locator(".nlc-cartao").nth(2)).toContainText("Maringá/PR");
    await expect(page.locator("#cockpit-units-detail")).toHaveCount(0);

    await busca.fill("londrina");
    await expect(page.locator("#cockpit-units-status")).toHaveText("1 de 3");
    await expect(page.locator("#cockpit-units-status")).toHaveClass(/nlc-status--filtro/);
    await expect(corpo.locator(".nlc-cartao")).toHaveCount(1);
    await expect(corpo.locator("mark")).toHaveText("Londrina");
    // Sem acento e só com dígitos do CNPJ.
    await busca.fill("maringa");
    await expect(corpo.locator("mark")).toHaveText("Maringá");
    await busca.fill("000272");
    await expect(corpo.locator(".nlc-cartao")).toHaveCount(1);
    await expect(corpo).toContainText("Londrina");
    await busca.fill("nada disso");
    await expect(corpo).toHaveText("Nenhuma unidade corresponde à busca.");

    // X limpa e devolve o foco; Esc com texto limpa sem fechar o painel.
    await page.getByRole("button", { name: "Limpar busca" }).click();
    await expect(busca).toHaveValue("");
    await expect(busca).toBeFocused();
    await busca.fill("curitiba");
    await busca.press("Escape");
    await expect(busca).toHaveValue("");
    await expect(painelUnidades(page)).toBeVisible();

    await corpo.getByRole("button", { name: "Editar CNPJ da unidade Curitiba" }).click();
    await expect(page.locator("#form-nova-unidade")).toBeVisible();
    await expect(page.locator("#form-unidade-titulo")).toHaveText("Editar Unidade: Curitiba");
    await expect(page.locator("#form-unidade-cnpj")).toBeFocused();
    await expect(page.locator("#form-unidade-cnpj")).toHaveValue("00.000.000/0001-91");
    await expect(page.locator("#form-unidade-id")).toHaveValue("1");

    await page.locator('#form-nova-unidade [data-on-click="toggleFormNovaUnidade"]').click();
    await expect(page.locator("#form-nova-unidade")).toBeHidden();
    await expect(page.locator("#cockpit-units-new")).toBeFocused();
    await page.locator("#cockpit-units-new").click();
    await expect(page.locator("#form-unidade-titulo")).toHaveText("Cadastrar Nova Unidade / Filial");
    await expect(page.locator("#form-unidade-cnpj")).toHaveValue("");
    await expect(page.locator("#form-unidade-cidade")).toBeFocused();
  });

  test("adaptador: carregarUnidades grava SimpressApp.state.unidadesList e editarUnidade lê a lista trocada por fora", async ({ page }) => {
    await abrirUnidadesComportamento(page);
    await page.evaluate(() => window.carregarUnidades());
    expect(await page.evaluate(() => window.SimpressApp.state.unidadesList.map(u => u.id))).toEqual([1, 2, 3]);

    // O código antigo troca o valor: o React tem de ler o novo, não uma cópia.
    await page.evaluate(() => {
      window.SimpressApp.state.unidadesList = [{ id: 42, cidade: "Ponta Grossa", endereco: "Rua Nova, 1", cep: "84000-000", cnpj: "00.000.000/0003-53" }];
    });
    await page.evaluate(() => window.abrirModalGerenciarUnidades());
    await page.evaluate(() => window.editarUnidade(42));
    await expect(page.locator("#form-unidade-titulo")).toHaveText("Editar Unidade: Ponta Grossa");
    await expect(page.locator("#form-unidade-endereco")).toBeFocused();
    await page.evaluate(() => window.editarUnidade(1));
    await expect(page.locator("#form-unidade-titulo")).toHaveText("Editar Unidade: Ponta Grossa");
  });

  test("carregarUnidades atualiza o seletor do Transporte, mantém a filial válida e conta as filiais", async ({ page }) => {
    await abrirUnidadesComportamento(page);
    await page.evaluate(() => window.carregarUnidades());
    await page.locator("#select-unidade-destino").evaluate(select => { select.value = "2"; });
    await page.evaluate(() => window.carregarUnidades());
    await expect(page.locator("#select-unidade-destino option")).toHaveText(["Selecione a filial", "Curitiba Sede", "Londrina", "Maringá - Rua Teste, 7 ()"]);
    await expect(page.locator("#select-unidade-destino")).toHaveValue("2");
    await expect(page.locator("#filiais-count")).toHaveText("3 filiais catalogadas");
  });

  for (const falha of [404, 503, "rede"]) {
    test(`carregarUnidades com falha ${falha} avisa e preserva a lista, o seletor e o contador`, async ({ page }) => {
      const env = await abrirUnidadesComportamento(page);
      await page.evaluate(() => window.carregarUnidades());
      await page.locator("#select-unidade-destino").evaluate(select => { select.value = "1"; });
      env.trocarLista(route => falha === "rede" ? route.abort("failed") : route.fulfill({ status: falha, body: "indisponível" }));
      await page.evaluate(() => window.carregarUnidades());
      expect(await env.toasts()).toEqual([["Não foi possível carregar o catálogo de unidades. Recarregue a página e tente de novo.", "error"]]);
      expect(await page.evaluate(() => window.SimpressApp.state.unidadesList.length)).toBe(3);
      await expect(page.locator("#select-unidade-destino")).toHaveValue("1");
      await expect(page.locator("#select-unidade-destino option")).toHaveCount(4);
      await expect(page.locator("#filiais-count")).toHaveText("3 filiais catalogadas");
    });
  }

  test("painel mostra o erro da carga na lista e no status, sem KPIs", async ({ page }) => {
    await abrirUnidadesComportamento(page, { unidades: route => route.fulfill({ status: 503, json: { detail: "Catálogo indisponível." } }) });
    await page.evaluate(() => window.abrirModalGerenciarUnidades());
    await expect(page.locator("#cockpit-units-status")).toHaveText("Catálogo indisponível.");
    await expect(page.locator("#cockpit-units-list-body")).toHaveText("Catálogo indisponível.");
    await expect(page.locator("#cockpit-units-kpis .ck-kpi")).toHaveCount(0);
  });

  test("salvar valida obrigatórios, envia o contrato, recarrega e fecha o formulário", async ({ page }) => {
    const env = await abrirUnidadesComportamento(page);
    await page.evaluate(() => window.abrirModalGerenciarUnidades());
    await page.locator("#cockpit-units-new").click();
    await page.locator("#btn-salvar-unidade").click();
    await expect.poll(env.toasts).toEqual([["Cidade, endereço e CNPJ são campos obrigatórios.", "warning"]]);
    expect(env.pedidos.filter(p => p[0] === "POST")).toHaveLength(0);

    await page.locator("#form-unidade-cidade").fill(" Paranaguá ");
    await page.locator("#form-unidade-endereco").fill("Rua Fictícia, 9");
    await page.locator("#form-unidade-cep").fill("83203-000");
    await page.locator("#form-unidade-cnpj").fill("00.000.000/0004-34");
    const antes = env.pedidos.filter(p => p === "GET").length;
    await page.locator("#btn-salvar-unidade").click();
    await expect(page.locator("#form-nova-unidade")).toBeHidden();
    expect(env.pedidos.find(p => p[0] === "POST")[1]).toEqual({ id: null, cidade: "Paranaguá", endereco: "Rua Fictícia, 9", uf: "PR", cep: "83203-000", cnpj: "00.000.000/0004-34" });
    expect(env.pedidos.filter(p => p === "GET").length - antes).toBe(2);
    await expect.poll(async () => (await env.toasts()).at(-1)).toEqual(["Unidade salva com sucesso!", "success"]);
  });

  test("salvar com erro 422 mostra a mensagem da API e mantém o formulário aberto", async ({ page }) => {
    const env = await abrirUnidadesComportamento(page, { salvar: () => ({ status: 422, json: { detail: "CEP deve conter 8 dígitos." } }) });
    await page.evaluate(() => window.abrirModalGerenciarUnidades());
    await page.evaluate(() => window.editarUnidade(2));
    await page.locator("#form-unidade-cep").fill("123");
    await page.locator("#btn-salvar-unidade").click();
    await expect.poll(env.toasts).toEqual([["CEP deve conter 8 dígitos.", "error"]]);
    expect(env.pedidos.find(p => p[0] === "POST")[1].id).toBe(2);
    await expect(page.locator("#form-nova-unidade")).toBeVisible();
  });
});
