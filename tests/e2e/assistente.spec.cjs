const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const PRONTO = { online: true, modelo: "modelo-teste", aguardando_confirmacao: false };

// Todas as rotas /api/assistente/* são simuladas; `respostas` mapeia o final da URL para o JSON devolvido.
async function mockAssistente(page, respostas) {
  const chamadas = [];
  await page.route("**/api/assistente/**", async route => {
    const nome = new URL(route.request().url()).pathname.split("/").pop();
    chamadas.push({ nome, corpo: route.request().postDataJSON?.() ?? null });
    const resposta = typeof respostas[nome] === "function" ? respostas[nome](chamadas.at(-1).corpo) : respostas[nome];
    if (resposta?.status) await route.fulfill({ status: resposta.status, json: { detail: resposta.detail } });
    else await route.fulfill({ json: resposta ?? { ok: true } });
  });
  return chamadas;
}

async function abrirAssistente(page) {
  if (await page.locator("#btn-assistente").isVisible()) await page.locator("#btn-assistente").click();
  else {
    await page.locator("#cockpit-tools-trigger").click();
    await page.locator("#btn-assistente-menu").click();
  }
  await expect(page.locator('[data-cockpit-tool-panel="assistente"]')).toBeVisible();
}

test("Assistente desligado mostra a orientação e bloqueia a entrada", async ({ page }) => {
  await mockAssistente(page, { estado: { online: false, modelo: "", aguardando_confirmacao: false } });
  await page.goto("/");
  await abrirAssistente(page);
  await expect(page.locator("#assistente-status")).toHaveText("Assistente desligado. Abra iniciar_jarvis_leve.bat na pasta do Jarvis.");
  await expect(page.locator("#assistente-texto")).toBeDisabled();
  await expect(page.locator("#assistente-enviar")).toBeDisabled();
  await expect(page.locator("#assistente-tentar")).toBeVisible();
});

test("envia mensagem, mostra resposta e ferramentas; Shift+Enter quebra a linha", async ({ page }) => {
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    mensagem: { texto: "Olá!\nTudo certo.", ferramentas: ["buscar_equipamento", "contar"], pendente: null },
  });
  await page.goto("/");
  await abrirAssistente(page);
  const campo = page.locator("#assistente-texto");
  await expect(campo).toBeEnabled();
  await campo.focus();
  await page.keyboard.type("linha 1");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("linha 2");
  await expect(campo).toHaveValue("linha 1\nlinha 2");
  await expect(page.locator("#assistente-contador")).toHaveText("15 / 4000");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ck-assist__msg--usuario")).toContainText("linha 1\nlinha 2");
  await expect(page.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText("Olá!\nTudo certo.");
  await expect(page.locator(".ck-assist__ferramentas")).toHaveText("Ferramentas: buscar_equipamento, contar");
  await expect(page.locator("#assistente-anuncio")).toHaveText("Olá!\nTudo certo.");
  expect(chamadas.find(c => c.nome === "mensagem").corpo).toEqual({ texto: "linha 1\nlinha 2" });
  await expect(campo).toHaveValue("");
  await expect(campo).toBeFocused();
});

test("ação pendente: confirmar envia confirmado=true; Esc cancela sem fechar o painel", async ({ page }) => {
  let rodada = 0;
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    mensagem: () => ({ texto: `Posso executar? (${++rodada})`, ferramentas: [], pendente: { descricao: "Abrir a pasta de entrada" } }),
    confirmar: corpo => ({ texto: corpo.confirmado ? "Feito." : "Cancelado.", ferramentas: [], pendente: null }),
  });
  await page.goto("/");
  await abrirAssistente(page);
  const cartao = page.locator("#assistente-pendente");

  await page.locator("#assistente-texto").fill("abra a pasta");
  await page.locator("#assistente-enviar").click();
  await expect(cartao).toBeVisible();
  await expect(cartao).toBeFocused();
  await expect(page.locator("#assistente-pendente-descricao")).toHaveText("Abrir a pasta de entrada");
  await expect(page.locator("#assistente-texto")).toBeDisabled();
  await page.getByRole("button", { name: "Confirmar e executar" }).click();
  await expect(cartao).toBeHidden();
  await expect(page.locator(".ck-assist__msg--assistente").last()).toHaveText(/Feito\./);

  await page.locator("#assistente-texto").fill("de novo");
  await page.keyboard.press("Enter");
  await expect(cartao).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(cartao).toBeHidden();
  await expect(page.locator(".ck-assist__msg--assistente").last()).toHaveText(/Cancelado\./);
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
  expect(chamadas.filter(c => c.nome === "confirmar").map(c => c.corpo)).toEqual([{ confirmado: true }, { confirmado: false }]);

  await page.locator("#assistente-nova").click();
  await expect(page.locator(".ck-assist__msg")).toHaveCount(0);
  expect(chamadas.some(c => c.nome === "limpar")).toBe(true);
});

test("texto com HTML aparece como texto, sem virar elemento", async ({ page }) => {
  const ataque = '<img src=x onerror="window.__xss=1"><b>negrito</b>';
  await mockAssistente(page, {
    estado: PRONTO,
    mensagem: { texto: ataque, ferramentas: ["<script>alert(1)</script>"], pendente: { descricao: ataque } },
  });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill(ataque);
  await page.locator("#assistente-enviar").click();
  await expect(page.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText(ataque);
  await expect(page.locator(".ck-assist__msg--usuario .ck-assist__texto")).toHaveText(ataque);
  await expect(page.locator("#assistente-pendente-descricao")).toHaveText(ataque);
  const injetados = await page.locator('[data-cockpit-tool-panel="assistente"]').locator("img, b, script").count();
  expect(injetados).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test("tela estreita: painel ocupa a largura sem rolagem horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await mockAssistente(page, { estado: PRONTO });
  await page.goto("/");
  await abrirAssistente(page);
  const largura = await page.locator('[data-cockpit-tool-panel="assistente"]').evaluate(node => node.getBoundingClientRect().width);
  expect(largura).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator("#assistente-texto")).toBeInViewport();
  await expect(page.locator("#assistente-enviar")).toBeInViewport();
});

test("painel com conversa e cartão pendente passa no axe nos dois temas", async ({ page }) => {
  await mockAssistente(page, {
    estado: PRONTO,
    mensagem: { texto: "Posso executar?", ferramentas: ["abrir_pasta"], pendente: { descricao: "Abrir a pasta de entrada" } },
  });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill("abra a pasta");
  await page.locator("#assistente-enviar").click();
  await expect(page.locator("#assistente-pendente")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="assistente"]').analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), theme).toEqual([]);
  }
});

test("503 no envio: uma só chamada, aviso com Tentar novamente e texto devolvido ao campo", async ({ page }) => {
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    mensagem: { status: 503, detail: "Assistente desligado. Abra iniciar_jarvis_leve.bat na pasta do Jarvis." },
  });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill("qual o total?");
  await page.locator("#assistente-enviar").click();
  await expect(page.locator("#assistente-status")).toHaveText("Assistente desligado. Abra iniciar_jarvis_leve.bat na pasta do Jarvis.");
  await expect(page.locator("#assistente-tentar")).toBeVisible();
  await expect(page.locator("#assistente-texto")).toHaveValue("qual o total?");
  await expect(page.locator("#assistente-texto")).toBeDisabled();
  expect(chamadas.filter(c => c.nome === "mensagem")).toHaveLength(1);
});

test("painel aberto com ação pendente mostra a descrição dela, não um cartão genérico", async ({ page }) => {
  await mockAssistente(page, {
    estado: { ...PRONTO, aguardando_confirmacao: true, pendente: { descricao: "Alterar o apelido do serial ABC1 para 'Sala'." } },
  });
  await page.goto("/");
  await abrirAssistente(page);
  await expect(page.locator("#assistente-pendente")).toBeVisible();
  await expect(page.locator("#assistente-pendente-descricao")).toHaveText("Alterar o apelido do serial ABC1 para 'Sala'.");
});
