const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const PRONTO = { online: true, modelo: "modelo-teste", aguardando_confirmacao: false };

// Todas as rotas /api/assistente/* são simuladas; `respostas` mapeia o final da URL para o JSON devolvido.
async function mockAssistente(page, respostas) {
  const chamadas = [];
  await page.route("**/api/assistente/**", async route => {
    const nome = new URL(route.request().url()).pathname.split("/").pop();
    // O áudio chega como WAV binário; só ele não é JSON.
    const audio = nome === "audio" ? route.request().postDataBuffer() : null;
    chamadas.push({ nome, corpo: audio ? null : route.request().postDataJSON?.() ?? null, audio });
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
  await expect(page.locator("#assistente-status")).toHaveText("Assistente desligado. Preencha OPENROUTER_API_KEY no arquivo .env da pasta do Simpress.");
  await expect(page.locator("#assistente-texto")).toBeDisabled();
  await expect(page.locator("#assistente-enviar")).toBeDisabled();
  await expect(page.locator("#assistente-gravar")).toBeDisabled();
  await expect(page.locator("#assistente-tentar")).toBeVisible();
});

test("botão de gravar áudio fica ativo com o Assistente pronto e começa sem gravar", async ({ page }) => {
  await mockAssistente(page, { estado: PRONTO });
  await page.goto("/");
  await abrirAssistente(page);
  await expect(page.getByRole("button", { name: "Gravar áudio" })).toBeEnabled();
});

// Microfone falso: um oscilador vira o MediaStream, então o MediaRecorder grava um tom de verdade.
async function falsearMicrofone(page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const contexto = new AudioContext();
      await contexto.resume();
      const destino = contexto.createMediaStreamDestination();
      const oscilador = contexto.createOscillator();
      oscilador.connect(destino);
      oscilador.start();
      return destino.stream;
    };
  });
}

test("grava áudio, envia WAV de 16 kHz e coloca a transcrição na caixa sem enviar a mensagem", async ({ page }) => {
  await falsearMicrofone(page);
  const chamadas = await mockAssistente(page, { estado: PRONTO, audio: { texto: "quantos notebooks temos?" } });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill("Oi,");
  await page.getByRole("button", { name: "Gravar áudio" }).click();
  await expect(page.locator("#assistente-enviar")).toBeDisabled();
  const parar = page.getByRole("button", { name: /^Parar \(0:0[1-9]\)$/ });
  await expect(parar).toBeVisible();
  await parar.click();
  await expect(page.locator("#assistente-texto")).toHaveValue("Oi, quantos notebooks temos?");
  await expect(page.locator("#assistente-status")).toHaveText("Áudio transcrito. Revise o texto e envie.");
  await expect(page.locator("#assistente-contador")).toHaveText("28 / 4000");
  await expect(page.getByRole("button", { name: "Gravar áudio" })).toBeEnabled();

  const wav = chamadas.find(c => c.nome === "audio").audio;
  expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(wav.subarray(8, 12).toString("latin1")).toBe("WAVE");
  expect(wav.readUInt32LE(24)).toBe(16000);
  expect(wav.length).toBeGreaterThan(44);
  expect(chamadas.some(c => c.nome === "mensagem")).toBe(false);
});

test("Esc cancela a gravação: nada é enviado e o botão volta ao normal", async ({ page }) => {
  await falsearMicrofone(page);
  const chamadas = await mockAssistente(page, { estado: PRONTO });
  await page.goto("/");
  await abrirAssistente(page);
  await page.getByRole("button", { name: "Gravar áudio" }).click();
  await expect(page.getByRole("button", { name: /^Parar/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Gravar áudio" })).toBeEnabled();
  await expect(page.locator("#assistente-texto")).toHaveValue("");
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
  expect(chamadas.some(c => c.nome === "audio")).toBe(false);
});

// Síntese de voz falsa: guarda o que seria falado e deixa o teste decidir quando a fala termina.
async function falsearVoz(page, vozes = [{ name: "Maria", lang: "pt-BR", localService: true }]) {
  await page.addInitScript(vozesFalsas => {
    window.__faladas = [];
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } }; // o real recusa uma voz que não seja do navegador
    let atual = null;
    const sintese = {
      getVoices: () => vozesFalsas,
      cancel: () => { atual = null; },
      speak: fala => { window.__faladas.push(fala.text); atual = fala; fala.onstart?.(); },
      addEventListener: () => {},
    };
    window.__terminarFala = () => { const fala = atual; atual = null; fala?.onend?.(); };
    Object.defineProperty(window, "speechSynthesis", { value: sintese, configurable: true });
  }, vozes);
}

test("globo mostra os estados: parado, ouvindo na gravação e pensando ao enviar", async ({ page }) => {
  await falsearMicrofone(page);
  await mockAssistente(page, { estado: PRONTO }); await page.route("**/api/assistente/mensagem", () => {}); // nunca responde: a mensagem fica em andamento
  await page.goto("/");
  await abrirAssistente(page);
  const globo = page.locator("#assistente-globo");
  await expect(globo).toHaveAttribute("data-estado", "parado");
  await page.getByRole("button", { name: "Gravar áudio" }).click();
  await expect(globo).toHaveAttribute("data-estado", "ouvindo");
  await page.keyboard.press("Escape");
  await expect(globo).toHaveAttribute("data-estado", "parado");
  await page.locator("#assistente-texto").fill("oi");
  await page.keyboard.press("Enter");
  await expect(globo).toHaveAttribute("data-estado", "pensando");
});

test("voz ligada fala a resposta com voz local em português e o globo fica falando até acabar", async ({ page }) => {
  await falsearVoz(page);
  await mockAssistente(page, { estado: PRONTO, mensagem: { texto: "Temos 12 notebooks.", ferramentas: [], pendente: null } });
  await page.goto("/");
  await abrirAssistente(page);
  const voz = page.locator("#assistente-voz");
  await expect(voz).toHaveAttribute("aria-pressed", "false");
  await voz.click();
  await expect(voz).toHaveAttribute("aria-pressed", "true");
  await page.locator("#assistente-texto").fill("quantos?");
  await page.keyboard.press("Enter");
  await expect(page.locator("#assistente-globo")).toHaveAttribute("data-estado", "falando");
  expect(await page.evaluate(() => window.__faladas)).toEqual(["Temos 12 notebooks."]);
  await page.evaluate(() => window.__terminarFala());
  await expect(page.locator("#assistente-globo")).toHaveAttribute("data-estado", "parado");
});

test("voz desligada não fala; a preferência fica guardada ao recarregar", async ({ page }) => {
  await falsearVoz(page);
  await mockAssistente(page, { estado: PRONTO, mensagem: { texto: "Olá!", ferramentas: [], pendente: null } });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill("oi");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText("Olá!");
  expect(await page.evaluate(() => window.__faladas)).toEqual([]);

  await page.locator("#assistente-voz").click();
  await page.reload();
  await abrirAssistente(page);
  await expect(page.locator("#assistente-voz")).toHaveAttribute("aria-pressed", "true");
});

test("sem voz local em português: não fala e avisa", async ({ page }) => {
  await falsearVoz(page, [{ name: "Online", lang: "pt-BR", localService: false }, { name: "Zira", lang: "en-US", localService: true }]);
  await mockAssistente(page, { estado: PRONTO, mensagem: { texto: "Olá!", ferramentas: [], pendente: null } });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-voz").click();
  await expect(page.locator("#assistente-status")).toContainText("não há voz em português instalada");
  await page.locator("#assistente-texto").fill("oi");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText("Olá!");
  expect(await page.evaluate(() => window.__faladas)).toEqual([]);
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
    mensagem: { status: 503, detail: "Assistente desligado. Preencha OPENROUTER_API_KEY no arquivo .env da pasta do Simpress." },
  });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill("qual o total?");
  await page.locator("#assistente-enviar").click();
  await expect(page.locator("#assistente-status")).toHaveText("Assistente desligado. Preencha OPENROUTER_API_KEY no arquivo .env da pasta do Simpress.");
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
