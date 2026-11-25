const path = require("node:path");
const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// Chave só para o teste: depois de enviada, nunca pode aparecer na tela.
const CHAVE_DIGITADA = "chave-ficticia-e2e-9876";

function prontidao(configuracaoLocal) {
  const status = { available: true, state: "ready" };
  const arquivo = { ...status, reason: "OK", file: "arquivo-sintetico.xlsx" };
  return {
    backend: "files",
    functions: Object.fromEntries(["consulta_equipamentos", "geracao_transferencia", "comparacao_atualizacao_inventarios",
      "exportacao_equipamentos", "acompanhamento_chamados"].map(chave => [chave, status])),
    files: Object.fromEntries(["inventario_equipamentos", "inventario_detalhes_atualizacao", "inventario_endpoint",
      "template_transferencia", "modelo_exportacao", "historico_chamados"].map(chave => [chave, arquivo])),
    configuracao_local: configuracaoLocal,
  };
}

// Servidor falso com estado: o mesmo contrato de routers/configuracao_local.py, só com dados fictícios.
function criarServidor() {
  const estado = {
    contas: { conta_simpress: "pessoa@exemplo.invalid", conta_sebrae: "", usuario_endpoint: "usuario.exemplo" },
    outlook: { conta_simpress: true, conta_sebrae: false },
    dashboard: "https://exemplo.invalid/pasta",
    chaves: { openrouter: "", deepseek: "" },
    cliente: { contrato: "10101", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: [] },
    requisicoes: [],
  };
  const rotulos = { conta_simpress: "Conta Simpress (e-mail)", conta_sebrae: "Conta Sebrae (e-mail)" };
  const usos = { conta_simpress: "Dashboard, UX Simpress, Oracle", conta_sebrae: "SoftExpert" };
  const final = chave => (chave ? `…${chave.slice(-4)}` : "");
  const assistente = () => Object.fromEntries(Object.entries(estado.chaves).map(([id, chave]) => [id,
    { configurada: Boolean(chave), final: final(chave), fonte: chave ? "arquivo" : "" }]));
  const status = () => {
    const faltando = [...Object.keys(rotulos).filter(id => !estado.contas[id]).map(id => rotulos[id]),
      ...(estado.dashboard ? [] : ["Link da pasta do Dashboard (SharePoint)"])];
    return {
      state: faltando.length ? "pending" : "ready", faltando, reason: faltando.length ? `Falta: ${faltando.join(", ")}` : "",
      assistente_ia: Object.values(estado.chaves).some(Boolean),
    };
  };
  const conta = (id, extra) => ({
    id, rotulo: rotulos[id], placeholder: "nome@exemplo.invalid", usado_para: usos[id], ajuda: `Usada para: ${usos[id]}`,
    tipo: "email", valor: estado.contas[id], fonte: estado.contas[id] ? "arquivo" : "", somente_leitura: false,
    usar_no_outlook: estado.outlook[id], valido: true, ...extra,
  });
  const leitura = () => ({
    status: status(),
    contas: [
      conta("conta_simpress"), conta("conta_sebrae"),
      {
        id: "usuario_endpoint", rotulo: "Usuário do Endpoint Central (login, sem domínio)", placeholder: "nome.usuario", usado_para: "Endpoint Central",
        ajuda: "Usada para: Endpoint Central", tipo: "usuario", valor: estado.contas.usuario_endpoint, fonte: "ambiente",
        somente_leitura: true, usar_no_outlook: null, valido: true,
      },
    ],
    links: [{
      chave: "dashboard_pasta_url", rotulo: "Link da pasta do Dashboard (SharePoint)", placeholder: "https://exemplo.invalid/sites/pasta-do-dashboard", usado_para: "Dashboard",
      ajuda: "Usado para: Dashboard", obrigatorio: true, valor: estado.dashboard, fonte: estado.dashboard ? "arquivo" : "",
      somente_leitura: false, valido: true,
    }],
    contas_arquivo_invalido: false,
    cliente: { configurado: true, arquivo_invalido: false, valido: true },
    assistente: assistente(),
  });
  return { estado, status, leitura, assistente };
}

async function simularApi(page) {
  const servidor = criarServidor();
  const { estado } = servidor;
  const registrar = route => {
    const requisicao = route.request();
    estado.requisicoes.push({ metodo: requisicao.method(), url: new URL(requisicao.url()).pathname, corpo: requisicao.postDataJSON?.() ?? null });
  };
  await page.route("**/api/prontidao", route => route.fulfill({ json: prontidao(servidor.status()) }));
  await page.route("**/api/config/local", route => route.fulfill({ json: servidor.leitura() }));
  await page.route("**/api/config/local/contas", route => {
    registrar(route);
    const corpo = route.request().postDataJSON();
    ["conta_simpress", "conta_sebrae"].forEach(id => {
      if (corpo[id]) estado.contas[id] = corpo[id];
      estado.outlook[id] = Boolean(corpo[id.replace("conta_", "usar_no_outlook_")]);
    });
    if (corpo.links?.dashboard_pasta_url) estado.dashboard = corpo.links.dashboard_pasta_url;
    return route.fulfill({ json: servidor.leitura() });
  });
  await page.route("**/api/config/local/assistente", route => {
    registrar(route);
    const corpo = route.request().postDataJSON();
    ["openrouter", "deepseek"].forEach(id => { if (corpo[`${id}_api_key`]) estado.chaves[id] = corpo[`${id}_api_key`]; });
    return route.fulfill({ json: servidor.assistente() });
  });
  await page.route("**/api/config/local/assistente/*", route => {
    registrar(route);
    estado.chaves[new URL(route.request().url()).pathname.split("/").pop()] = "";
    return route.fulfill({ json: servidor.assistente() });
  });
  await page.route("**/api/config/cliente", route => {
    if (route.request().method() === "PUT") {
      registrar(route);
      Object.assign(estado.cliente, route.request().postDataJSON());
    }
    return route.fulfill({ json: { ...estado.cliente, cliente_fontes: {}, cliente_configurado: true } });
  });
  return servidor;
}

async function abrirPainelDeProntidao(page) {
  await expect(page.locator("#readiness-panel")).toHaveAttribute("aria-busy", "false");
  const alternar = page.locator("#cockpit-bar-status-toggle");
  if ((await alternar.isVisible()) && (await alternar.getAttribute("aria-expanded")) !== "true") await alternar.click();
  const painel = page.locator("#readiness-panel");
  if ((await painel.getAttribute("open")) === null) await painel.locator(":scope > summary").click();
  await expect(page.locator("#readiness-configuracao-local")).toBeVisible();
}

const semRolagemHorizontal = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("Configuração local: pendente lista o que falta, salvar deixa Em dia e a chave some do campo", async ({ page }) => {
  test.setTimeout(45_000);
  const erros = [];
  page.on("pageerror", erro => erros.push(erro.message));
  const servidor = await simularApi(page);
  await page.goto("/");
  await abrirPainelDeProntidao(page);

  const cartao = page.locator("#readiness-configuracao-local");
  await expect(cartao).toContainText("Pendente · Falta: Conta Sebrae (e-mail)");
  await expect(cartao).toContainText("Assistente sem IA");
  const itens = await page.locator("#readiness-details-content [data-pendencia]").count();
  const prontos = () => page.locator('#readiness-details-content [data-pendencia][data-status="ok"]').count();
  const prontosAntes = await prontos();
  await expect(page.locator("#ckp-progresso-texto")).toHaveText(`${prontosAntes} de ${itens}`);

  await cartao.getByRole("button", { name: "Configurar contas, links e dados do cliente" }).click();
  const modal = page.getByRole("dialog", { name: "Configuração local" });
  await expect(modal).toBeVisible();
  await expect(page.locator("#cfg-local-conta-conta_sebrae")).toHaveAttribute("placeholder", "nome@exemplo.invalid");
  await expect(page.locator("#cfg-local-conta-conta_simpress-ajuda")).toHaveText("Usada para: Dashboard, UX Simpress, Oracle");
  await expect(page.locator("#cfg-local-outlook-conta_simpress")).toBeChecked();
  await expect(page.locator("#cfg-local-outlook-conta_sebrae")).not.toBeChecked();
  await expect(page.locator("#cfg-local-conta-usuario_endpoint")).toHaveJSProperty("readOnly", true);
  await expect(page.locator("#cfg-local-conta-usuario_endpoint-ambiente")).toHaveText("Definido por variável de ambiente");
  await expect(modal).toContainText("Senha e MFA você digita no Chrome de automação.");
  await expect(page.locator("#cfg-local-link-dashboard_pasta_url")).toHaveValue("https://exemplo.invalid/pasta");
  await expect(page.locator("#cfg-local-contrato")).toHaveValue("10101");
  await expect(page.locator("#cfg-local-chave-openrouter")).toHaveValue("");
  await expect(page.locator("#cfg-local-chaves").getByRole("button", { name: "Remover chave do OpenRouter" })).toHaveCount(0);
  const auditoria = await new AxeBuilder({ page }).include("#modal-configuracao-local")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(auditoria.violations.map(violacao => violacao.id)).toEqual([]);
  expect(await semRolagemHorizontal(page)).toBe(true);

  await page.locator("#cfg-local-conta-conta_sebrae").fill("equipe@exemplo.invalid");
  await page.locator("#cfg-local-outlook-conta_sebrae").check();
  await page.locator("#cfg-local-salvar-contas").click();
  await expect(page.locator("#cfg-local-status-contas")).toHaveText("Contas salvas.");
  await expect(cartao).toContainText("Em dia");
  await expect(cartao).toContainText("Assistente sem IA");
  expect(await prontos()).toBe(prontosAntes + 1);
  await expect(page.locator("#ckp-progresso-texto")).toHaveText(`${prontosAntes + 1} de ${itens}`);
  const gravacaoContas = servidor.estado.requisicoes.find(requisicao => requisicao.url === "/api/config/local/contas");
  expect(gravacaoContas.corpo).toMatchObject({
    conta_simpress: "pessoa@exemplo.invalid", conta_sebrae: "equipe@exemplo.invalid", usuario_endpoint: "",
    usar_no_outlook_simpress: true, usar_no_outlook_sebrae: true, links: {},
  });

  await page.locator("#cfg-local-chave-openrouter").fill(CHAVE_DIGITADA);
  await page.locator("#cfg-local-salvar-assistente").click();
  await expect(page.locator("#cfg-local-status-assistente")).toHaveText("Chave salva.");
  expect(servidor.estado.requisicoes.find(requisicao => requisicao.url === "/api/config/local/assistente").corpo)
    .toEqual({ openrouter_api_key: CHAVE_DIGITADA });
  await expect(page.locator("#cfg-local-chave-openrouter")).toHaveValue("");
  await expect(page.locator("#cfg-local-chave-openrouter")).toHaveAttribute("placeholder", "…9876");
  await expect(page.locator("body")).not.toContainText(CHAVE_DIGITADA);
  await expect(cartao).not.toContainText("Assistente sem IA");
  await expect(page.locator("#cfg-local-chaves").getByRole("button", { name: "Remover chave do OpenRouter" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page.locator("#btn-configuracao-local")).toBeFocused();
  expect(await semRolagemHorizontal(page)).toBe(true);
  expect(erros).toEqual([]);
});

test("Configuração local: dados do cliente validam antes de enviar e Remover chave pede confirmação", async ({ page }) => {
  test.setTimeout(45_000);
  const servidor = await simularApi(page);
  servidor.estado.chaves.deepseek = CHAVE_DIGITADA;
  await page.goto("/");
  await abrirPainelDeProntidao(page);
  await page.locator("#btn-configuracao-local").click();
  await expect(page.getByRole("dialog", { name: "Configuração local" })).toBeVisible();

  await page.locator("#cfg-local-cnpj").fill("11222333000181");
  await page.locator("#cfg-local-salvar-cliente").click();
  await expect(page.locator("#cfg-local-status-cliente")).toHaveText('Informe o "CNPJ de faturamento" no formato 00.000.000/0000-00.');
  await expect(page.locator("#cfg-local-cnpj")).toBeFocused();
  expect(servidor.estado.requisicoes).toEqual([]);

  await page.locator("#cfg-local-cnpj").fill("11.222.333/0001-81");
  await page.locator("#cfg-local-series").fill("SERIE001\nSERIE002");
  await page.locator("#cfg-local-salvar-cliente").click();
  await expect(page.locator("#cfg-local-status-cliente")).toHaveText("Dados do cliente salvos.");
  expect(servidor.estado.requisicoes.at(-1)).toMatchObject({
    metodo: "PUT", url: "/api/config/cliente",
    corpo: { contrato: "10101", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: ["SERIE001", "SERIE002"] },
  });

  const remover = page.locator("#cfg-local-chaves").getByRole("button", { name: "Remover chave do DeepSeek" });
  await remover.click();
  const confirmacao = page.getByRole("dialog", { name: "Remover chave?" });
  await expect(confirmacao).toBeVisible();
  await confirmacao.getByRole("button", { name: "Cancelar" }).click();
  await expect(confirmacao).toBeHidden();
  expect(servidor.estado.requisicoes.some(requisicao => requisicao.metodo === "DELETE")).toBe(false);

  await remover.click();
  await confirmacao.getByRole("button", { name: "Remover chave" }).click();
  await expect(page.locator("#cfg-local-status-assistente")).toHaveText("Chave do DeepSeek removida.");
  await expect(page.locator("#cfg-local-chave-deepseek")).toHaveAttribute("placeholder", "Não configurada");
  expect(servidor.estado.requisicoes.at(-1)).toMatchObject({ metodo: "DELETE", url: "/api/config/local/assistente/deepseek" });
});

// Linhas da captura (PNG) entre a tinta mais baixa acima da linha e a própria linha: decodifica numa página em branco.
async function distanciaDaTintaAteALinha(page, captura) {
  const aux = await page.context().newPage();
  try {
    return await aux.evaluate(async base64 => {
      const img = new Image();
      img.src = `data:image/png;base64,${base64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      const escura = (x, y) => data[(y * img.width + x) * 4] < 128;
      const linhas = [];
      for (let y = 0; y < img.height; y++) {
        let escuros = 0;
        for (let x = 0; x < img.width; x++) if (escura(x, y)) escuros++;
        linhas.push(escuros);
      }
      const linha = linhas.findIndex((total, y) => y > 3 && total > img.width * 0.5); // ignora a borda do quadro (escura no tema escuro)
      let baixo = -1;
      for (let y = linha - 1; y >= 0; y--) if (linhas[y] > 0) { baixo = y; break; }
      return { linha, baixo, distancia: baixo < 0 ? null : linha - baixo };
    }, captura.toString("base64"));
  } finally {
    await aux.close();
  }
}

test("Configuração local: assinatura do técnico valida, mostra a prévia ao vivo e grava só o gravado", async ({ page }) => {
  test.setTimeout(60_000);
  await simularApi(page);
  const gravacoes = [];
  let atual = { estilo: "desenho", nome: "" };
  await page.route("**/api/assinatura-tecnico/config", route => {
    if (route.request().method() === "PUT") {
      gravacoes.push(route.request().postDataJSON());
      atual = route.request().postDataJSON();
    }
    return route.fulfill({ json: atual });
  });
  await page.goto("/");
  await abrirPainelDeProntidao(page);
  await page.locator("#btn-configuracao-local").click();
  await expect(page.getByRole("dialog", { name: "Configuração local" })).toBeVisible();

  const nome = page.locator("#cfg-local-assinatura-nome");
  const aviso = page.locator("#cfg-local-assinatura-previa-aviso");
  const previa = page.locator(".cfg-assin-previa");
  const cartao = valor => page.locator(`.cfg-assin-opcao[data-estilo="${valor}"]`);
  const radio = valor => cartao(valor).locator("input[type=radio]");
  const ESTILOS = ["desenho", "digitada", "great-vibes", "dancing-script", "allura", "alex-brush", "sacramento"];
  await expect(page.getByRole("group", { name: "Estilo da assinatura" })).toBeVisible();
  await expect(radio("desenho")).toBeChecked();
  await expect(page.locator(".cfg-assin-opcao__nome")).toHaveText(["Desenho atual", "Digitada", "Great Vibes", "Dancing Script", "Allura", "Alex Brush", "Sacramento"]);
  await expect(cartao("desenho")).toContainText("O desenho atual aparece no PDF; não há prévia dele aqui.");
  await expect(previa).toHaveCount(0);

  // Cliente: nome inválido ou ausente não chega ao servidor.
  await cartao("allura").click();
  await expect(radio("allura")).toBeChecked();
  await expect(aviso).toHaveText("Digite o nome para ver as prévias.");
  await page.locator("#cfg-local-salvar-assinatura").click();
  await expect(page.locator("#cfg-local-status-assinatura")).toHaveText("Informe o nome para esse estilo de assinatura.");
  await expect(nome).toBeFocused();
  await nome.fill("Ana 2");
  await page.locator("#cfg-local-salvar-assinatura").click();
  await expect(page.locator("#cfg-local-status-assinatura")).toHaveText("Use até 80 caracteres: só letras, espaço, ponto, apóstrofo e hífen.");
  expect(gravacoes).toEqual([]);

  // Ao digitar, a grade mostra o nome nos 6 estilos de texto; cada cartão é uma mini-folha com a linha e o rótulo embaixo.
  await nome.fill("  Joaquim   Gonçalves Pereira ");
  for (const valor of ESTILOS.slice(1)) {
    await expect(cartao(valor).locator("svg")).toHaveAttribute("data-estilo", valor);
    await expect(cartao(valor).locator("svg text")).toHaveText("Joaquim Gonçalves Pereira");
    await expect(cartao(valor).locator(".cfg-assin-previa__bloco")).toContainText("Assinatura do técnico responsável");
    const borda = await cartao(valor).locator(".cfg-assin-previa__bloco").evaluate(el => getComputedStyle(el).borderTopWidth + " " + getComputedStyle(el).borderTopColor);
    expect(borda, valor).toBe("1px rgb(0, 0, 0)");
  }
  await expect(page.locator(".cfg-assin-opcao svg")).toHaveCount(6);
  await expect(previa.locator("svg")).toHaveAttribute("data-estilo", "allura");
  await expect(previa.locator(".cfg-assin-previa__bloco")).toContainText("Assinatura do técnico responsável");

  // Teclado: setas trocam de rádio (e o estilo).
  await radio("allura").focus();
  await page.keyboard.press("ArrowRight");
  await expect(radio("alex-brush")).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(radio("allura")).toBeChecked();

  // Clicar num cartão troca o estilo; a digitada fica rente à linha (tinta mais baixa a poucos pixels dela, sem tocá-la).
  await cartao("digitada").click();
  await expect(previa.locator("svg")).toHaveAttribute("data-estilo", "digitada");
  await expect(previa.locator("svg text")).toHaveText("Joaquim Gonçalves Pereira");
  await expect(previa.locator("svg text")).toHaveCSS("font-family", /Inter Variable/);
  const medida = await distanciaDaTintaAteALinha(page, await previa.screenshot());
  expect(medida.distancia, JSON.stringify(medida)).toBeGreaterThanOrEqual(1);
  expect(medida.distancia, JSON.stringify(medida)).toBeLessThanOrEqual(4);
  await expect(aviso).toHaveText("");

  // Cursiva com nome todo em maiúsculas: só a renderização vira Título; o valor digitado e o salvo não mudam.
  await nome.fill("JOÃO PAULO FERREIRA");
  await expect(cartao("sacramento").locator("svg text")).toHaveText("João Paulo Ferreira");
  await expect(cartao("digitada").locator("svg text")).toHaveText("JOÃO PAULO FERREIRA");

  // Nome longo: aviso não bloqueante; salvar continua valendo.
  const longo = "Maria Aparecida dos Santos Albuquerque de Oliveira Gonçalves Pereira Lima";
  await nome.fill(longo);
  await expect(aviso).toHaveText("Nome longo: a assinatura fica pequena. Considere abreviar (ex.: Maria A. S. Lima).");
  await nome.fill("Joaquim Gonçalves Pereira");
  await expect(aviso).toHaveText("");

  await cartao("great-vibes").click();
  await page.locator("#cfg-local-salvar-assinatura").click();
  await expect(page.locator("#cfg-local-status-assinatura")).toHaveText("Assinatura do técnico salva.");
  expect(gravacoes).toEqual([{ estilo: "great-vibes", nome: "Joaquim Gonçalves Pereira" }]);
  await expect(nome).toHaveValue("Joaquim Gonçalves Pereira");
  await expect(radio("great-vibes")).toBeChecked();
});

test("Configuração local: o modal não gera rolagem horizontal de 320 a 2560 px nos dois temas", async ({ page }) => {
  test.setTimeout(60_000);
  await simularApi(page);
  await page.goto("/");
  await abrirPainelDeProntidao(page);
  for (const tema of ["light", "dark"]) {
    await page.locator("html").evaluate((raiz, valor) => { raiz.dataset.theme = valor; }, tema);
    for (const largura of [320, 390, 768, 1366, 2560]) {
      await page.setViewportSize({ width: largura, height: 900 });
      await page.locator("#btn-configuracao-local").click();
      const modal = page.getByRole("dialog", { name: "Configuração local" });
      await expect(modal).toBeVisible();
      expect(await semRolagemHorizontal(page), `${tema} ${largura}px: página`).toBe(true);
      expect(await page.locator("#cfg-local-corpo").evaluate(corpo => corpo.scrollWidth <= corpo.clientWidth), `${tema} ${largura}px: corpo do modal`).toBe(true);
      await page.keyboard.press("Escape");
      await expect(modal).toBeHidden();
      await expect(page.locator("#btn-configuracao-local")).toBeFocused();
    }
  }
});

// Capturas sob demanda: SIMPRESS_CAPTURAS_DIR=<pasta fora de static/> npx playwright test tests/e2e/configuracao-local.spec.cjs
test("Configuração local: capturas do painel e do modal nos temas claro e escuro", async ({ page }, testInfo) => {
  test.skip(!process.env.SIMPRESS_CAPTURAS_DIR, "Defina SIMPRESS_CAPTURAS_DIR para salvar as capturas.");
  test.setTimeout(60_000);
  const pasta = process.env.SIMPRESS_CAPTURAS_DIR;
  const perfil = testInfo.project.name;
  await simularApi(page);
  await page.goto("/");
  await abrirPainelDeProntidao(page);
  for (const tema of ["light", "dark"]) {
    await page.locator("html").evaluate((raiz, valor) => { raiz.dataset.theme = valor; }, tema);
    await page.locator("#readiness-content").screenshot({ path: path.join(pasta, `depois-painel-${perfil}-${tema}.png`) });
    await page.locator("#btn-configuracao-local").click();
    await expect(page.getByRole("dialog", { name: "Configuração local" })).toBeVisible();
    await page.locator("#cfg-local-corpo").evaluate(corpo => { corpo.scrollTop = 0; });
    await page.waitForTimeout(500); // deixa a animação de entrada terminar
    await page.screenshot({ path: path.join(pasta, `depois-modal-topo-${perfil}-${tema}.png`) });
    await page.locator("#cfg-local-corpo").evaluate(corpo => { corpo.scrollTop = corpo.scrollHeight; });
    await page.screenshot({ path: path.join(pasta, `depois-modal-fim-${perfil}-${tema}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-configuracao-local")).toBeHidden();
  }
});

// Capturas da seção "Assinatura do técnico" com a grade: SIMPRESS_CAPTURAS_DIR=<pasta fora de static/> (desktop claro/escuro e 375 px).
test("Configuração local: capturas da seção da assinatura com a grade", async ({ page }) => {
  test.skip(!process.env.SIMPRESS_CAPTURAS_DIR, "Defina SIMPRESS_CAPTURAS_DIR para salvar as capturas.");
  test.setTimeout(90_000);
  const pasta = process.env.SIMPRESS_CAPTURAS_DIR;
  await simularApi(page);
  await page.route("**/api/assinatura-tecnico/config", route => route.fulfill({ json: { estilo: "allura", nome: "Maria Eduarda Souza" } }));
  await page.goto("/");
  await abrirPainelDeProntidao(page);
  for (const [nomeArquivo, tema, largura, altura] of [["desktop-claro", "light", 1366, 1000], ["desktop-escuro", "dark", 1366, 1000], ["mobile", "light", 375, 1500]]) {
    await page.setViewportSize({ width: largura, height: altura });
    await page.locator("html").evaluate((raiz, valor) => { raiz.dataset.theme = valor; }, tema);
    await page.locator("#btn-configuracao-local").click();
    await expect(page.getByRole("dialog", { name: "Configuração local" })).toBeVisible();
    await expect(page.locator(".cfg-assin-opcao svg")).toHaveCount(6);
    await page.waitForTimeout(500);
    await page.locator("#cfg-local-secao-assinatura").evaluate(secao => secao.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(pasta, `config-${nomeArquivo}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-configuracao-local")).toBeHidden();
  }
});
