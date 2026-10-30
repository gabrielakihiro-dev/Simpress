const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const PRONTO = { online: true, modelo: "modelo-teste", aguardando_confirmacao: false };

// Todas as rotas /api/assistente/* são simuladas; `respostas` mapeia o final da URL para o JSON devolvido.
async function mockAssistente(page, respostas) {
  const chamadas = [];
  await page.route("**/api/assistente/**", async route => {
    const caminho = new URL(route.request().url()).pathname;
    // DELETE /anexo/{id} vira "anexo/remover" (o id muda a cada teste).
    // PATCH/DELETE /notas/{id} vira "notas/item" pelo mesmo motivo.
    const nome = /\/anexo\/[^/]+$/.test(caminho) ? "anexo/remover" : /\/notas\/[^/]+$/.test(caminho) ? "notas/item" : caminho.split("/").pop();
    // O áudio (WAV) e o anexo chegam como bytes; só eles não são JSON.
    const audio = nome === "audio" || nome === "anexo" ? route.request().postDataBuffer() : null;
    chamadas.push({
      nome, metodo: route.request().method(), corpo: audio ? null : route.request().postDataJSON?.() ?? null, audio,
      cabecalhos: route.request().headers(), caminho,
    });
    const resposta = typeof respostas[nome] === "function" ? respostas[nome](chamadas.at(-1).corpo, chamadas.at(-1).metodo, caminho) : respostas[nome];
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

test("Instruções permanentes: abre, carrega, conta, salva e limpa", async ({ page }) => {
  let salvo = "Sempre responda em tabela.";
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    instrucoes: corpo => (corpo ? { texto: (salvo = corpo.texto), limite: 4000 } : { texto: salvo, limite: 4000 }),
  });
  await page.goto("/");
  await abrirAssistente(page);
  const botao = page.getByRole("button", { name: "Instruções" });
  await expect(botao).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#assistente-instrucoes")).toBeHidden();
  await botao.click();
  await expect(botao).toHaveAttribute("aria-expanded", "true");
  const campo = page.getByLabel("Regras e preferências para o Assistente");
  await expect(campo).toHaveValue("Sempre responda em tabela.");
  await expect(page.locator("#assistente-instrucoes-contador")).toHaveText("26 / 4000");
  await campo.fill("Quando eu disser 'fechamento', rode a comparação.");
  await expect(page.locator("#assistente-instrucoes-contador")).toHaveText("49 / 4000");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page.locator("#assistente-instrucoes-status")).toHaveText("Instruções salvas. Valem a partir da próxima mensagem.");
  expect(chamadas.filter(c => c.nome === "instrucoes" && c.metodo === "PUT").map(c => c.corpo)).toEqual([{ texto: "Quando eu disser 'fechamento', rode a comparação." }]);
  await page.getByRole("button", { name: "Limpar" }).click();
  await expect(page.locator("#assistente-instrucoes-status")).toHaveText("Instruções removidas.");
  await expect(campo).toHaveValue("");
  expect(salvo).toBe("");
  // Fechar e abrir de novo não busca outra vez: o texto já está na tela.
  await botao.click();
  await expect(page.locator("#assistente-instrucoes")).toBeHidden();
  await botao.click();
  expect(chamadas.filter(c => c.nome === "instrucoes" && c.metodo === "GET")).toHaveLength(1);
});

test("Instruções permanentes: erro ao salvar mostra o motivo e mantém o texto; erro ao carregar bloqueia a edição", async ({ page }) => {
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    instrucoes: corpo => (corpo ? { status: 422, detail: "As instruções passam de 4000 caracteres." } : { texto: "antigo", limite: 4000 }),
  });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-instrucoes-botao").click();
  await page.locator("#assistente-instrucoes-texto").fill("novo texto");
  await page.locator("#assistente-instrucoes-salvar").click();
  await expect(page.locator("#assistente-instrucoes-status")).toHaveText("As instruções passam de 4000 caracteres.");
  await expect(page.locator("#assistente-instrucoes-texto")).toHaveValue("novo texto");
  expect(chamadas.filter(c => c.nome === "instrucoes" && c.metodo === "PUT")).toHaveLength(1);

  const falha = await page.context().newPage();
  await mockAssistente(falha, { estado: PRONTO, instrucoes: { status: 500, detail: "Falha interna." } });
  await falha.goto("/");
  await abrirAssistente(falha);
  await falha.locator("#assistente-instrucoes-botao").click();
  await expect(falha.locator("#assistente-instrucoes-status")).toContainText("Falha interna.");
  await expect(falha.locator("#assistente-instrucoes-texto")).toBeDisabled();
  await expect(falha.locator("#assistente-instrucoes-salvar")).toBeDisabled();
  await expect(falha.locator("#assistente-instrucoes-limpar")).toBeDisabled();
});

test("Instruções permanentes: tela estreita cabe sem rolagem, devolve o Enviar ao fechar e passa no axe nos dois temas", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await mockAssistente(page, { estado: PRONTO, instrucoes: { texto: "Sempre responda em tabela.", limite: 4000 } });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-instrucoes-botao").click();
  await expect(page.locator("#assistente-instrucoes-texto")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator("#assistente-instrucoes-salvar")).toBeInViewport();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="assistente"]').analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), theme).toEqual([]);
  }
  await page.locator("#assistente-instrucoes-botao").click();
  await expect(page.locator("#assistente-instrucoes")).toBeHidden();
  await expect(page.locator("#assistente-enviar")).toBeInViewport();
});

// Anexos: o servidor é simulado; `lista` faz o papel da memória dele.
function mockAnexos(proximo) {
  const lista = [];
  return {
    lista,
    respostas: {
      anexos: () => ({ anexos: lista }),
      anexo: () => {
        const resposta = proximo();
        if (!resposta.status) lista.push(resposta);
        return resposta;
      },
      "anexo/remover": () => ({ ok: true }),
    },
  };
}

const PDF = { id: "a1b2c3d4e5f6", nome: "Ata final.pdf", tipo: "pdf", tamanho: 52000, paginas: 3, aviso: "" };
const IMAGEM = { id: "f6e5d4c3b2a1", nome: "foto.png", tipo: "imagem", tamanho: 2200000, paginas: 0, aviso: "" };

test("Anexos: anexa PDF, mostra o chip, envia os bytes com o nome e remove", async ({ page }) => {
  let proximo = PDF;
  const { lista, respostas } = mockAnexos(() => proximo);
  const chamadas = await mockAssistente(page, { estado: PRONTO, ...respostas });
  await page.goto("/");
  await abrirAssistente(page);
  await expect(page.locator("#assistente-anexos")).toBeHidden();
  await expect(page.getByRole("button", { name: "Anexar" })).toBeEnabled();

  await page.locator("#assistente-anexo-arquivo").setInputFiles({ name: "Ata final.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 teste") });
  const chip = page.locator("#assistente-anexos li");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("Ata final.pdf");
  await expect(chip).toContainText("PDF · 51 KB · 3 páginas de texto");
  await expect(page.locator("#assistente-anexos-status")).toHaveText("Ata final.pdf anexado.");
  await expect(page.locator("#assistente-anexos-aviso")).toBeHidden();
  const envio = chamadas.find(c => c.nome === "anexo");
  expect(envio.metodo).toBe("POST");
  expect(envio.audio.toString("latin1")).toBe("%PDF-1.4 teste");
  expect(decodeURIComponent(envio.cabecalhos["x-nome-arquivo"])).toBe("Ata final.pdf");

  await page.getByRole("button", { name: "Remover anexo Ata final.pdf" }).click();
  await expect(chip).toHaveCount(0);
  await expect(page.locator("#assistente-anexos")).toBeHidden();
  await expect(page.locator("#assistente-anexos-status")).toHaveText("Anexo removido.");
  const remocao = chamadas.find(c => c.nome === "anexo/remover");
  expect(remocao.metodo).toBe("DELETE");
  expect(remocao.caminho).toBe("/api/assistente/anexo/a1b2c3d4e5f6");
});

test("Anexos: imagem mostra o aviso de que sai sem ocultar dados; erro do servidor aparece em português; Nova conversa limpa", async ({ page }) => {
  let proximo = IMAGEM;
  const { respostas } = mockAnexos(() => proximo);
  await mockAssistente(page, { estado: PRONTO, ...respostas });
  await page.goto("/");
  await abrirAssistente(page);
  const entrada = page.locator("#assistente-anexo-arquivo");

  await entrada.setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: Buffer.from("\x89PNG\r\n\x1a\n") });
  await expect(page.locator("#assistente-anexos li")).toContainText("Imagem · 2,1 MB");
  await expect(page.locator("#assistente-anexos-aviso")).toBeVisible();
  await expect(page.locator("#assistente-anexos-aviso")).toContainText("sem ocultar CPF, nome, e-mail");

  proximo = { status: 415, detail: "Arquivos .doc (Word antigo) não são aceitos. Abra o arquivo no Word e salve como .docx; depois anexe de novo." };
  await entrada.setInputFiles({ name: "antigo.doc", mimeType: "application/msword", buffer: Buffer.from("x") });
  await expect(page.locator("#assistente-anexos-status")).toHaveText(`antigo.doc: ${proximo.detail}`);
  await expect(page.locator("#assistente-anexos li")).toHaveCount(1);

  proximo = { ...PDF, aviso: "Este PDF não tem texto selecionável (parece digitalizado) e o assistente não faz OCR." };
  await entrada.setInputFiles({ name: "Ata final.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  await expect(page.locator("#assistente-anexos li").nth(1)).toContainText("não faz OCR");

  await page.getByRole("button", { name: "Nova conversa" }).click();
  await expect(page.locator("#assistente-anexos li")).toHaveCount(0);
  await expect(page.locator("#assistente-anexos-aviso")).toBeHidden();
});

test("Anexos: a lista do servidor volta ao recarregar e o anexo é texto puro, não HTML", async ({ page }) => {
  const { lista, respostas } = mockAnexos(() => PDF);
  lista.push({ ...PDF, nome: "<img src=x onerror=alert(1)>.pdf" });
  await mockAssistente(page, { estado: PRONTO, ...respostas });
  await page.goto("/");
  await abrirAssistente(page);
  await expect(page.locator("#assistente-anexos li")).toContainText("<img src=x onerror=alert(1)>.pdf");
  await expect(page.locator("#assistente-anexos img")).toHaveCount(0);
});

test("Anexos: arquivo grande demais nem sobe; tela de 360 px cabe sem rolagem e passa no axe nos dois temas", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const { respostas } = mockAnexos(() => IMAGEM);
  const chamadas = await mockAssistente(page, { estado: PRONTO, ...respostas });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-anexo-arquivo").setInputFiles({ name: "enorme.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await expect(page.locator("#assistente-anexos-status")).toHaveText("enorme.pdf: o arquivo é grande demais. O limite é 10 MB.");
  expect(chamadas.some(c => c.nome === "anexo")).toBe(false);

  await page.locator("#assistente-anexo-arquivo").setInputFiles({ name: "foto-com-um-nome-muito-comprido-para-testar-a-quebra-de-linha.png", mimeType: "image/png", buffer: Buffer.from("x") });
  await expect(page.locator("#assistente-anexos-aviso")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator("#assistente-anexar")).toBeInViewport();
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="assistente"]').analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), theme).toEqual([]);
  }
});

test("Relatório gerado: mostra o botão Baixar com o arquivo, clicável e sem rolagem horizontal em 360 px", async ({ page }) => {
  const nome = "simpress-divergencias-localidade-20260101.xlsx";
  await mockAssistente(page, {
    estado: PRONTO,
    mensagem: {
      texto: "Pronto, o relatório está disponível.", ferramentas: ["gerar_relatorio"], pendente: null,
      arquivos: [{ id: "0123456789abcdef", nome, formato: "xlsx", tamanho: 2048 }, { id: "<img src=x>", nome: "invalido.xlsx", formato: "xlsx", tamanho: 1 }],
    },
  });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill("exporta as divergências de localidade em Excel");
  await page.locator("#assistente-enviar").click();
  const botao = page.getByRole("link", { name: `Baixar ${nome}` });
  await expect(botao).toBeVisible();
  await expect(botao).toHaveAttribute("href", "/api/assistente/relatorio/0123456789abcdef");
  await expect(botao).toHaveAttribute("download", nome);
  await expect(page.locator(".ck-assist__arquivo")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const [download] = await Promise.all([page.waitForEvent("download"), botao.click()]);
  expect(download.suggestedFilename()).toBe(nome);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="assistente"]').analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), theme).toEqual([]);
  }
});

// Lembretes: o servidor é simulado; `lista` faz o papel do arquivo dele.
function mockLembretes(lista) {
  return {
    notas: () => ({ notas: lista, limite_texto: 500, limite_quantidade: 200 }),
    "notas/item": (corpo, metodo, caminho) => {
      const id = caminho.split("/").pop();
      const indice = lista.findIndex(nota => nota.id === id);
      if (indice < 0) return { status: 404, detail: "Lembrete não encontrado." };
      if (metodo === "DELETE") lista.splice(indice, 1);
      else lista[indice].concluida = corpo.concluida;
      return metodo === "DELETE" ? { ok: true } : lista[indice];
    },
  };
}

const LEMBRETES = () => [
  { id: "aaaaaaaaaaaa", texto: "Conferir o lote X <b>agora</b>", criada_em: "2026-10-30T09:00:00-03:00", concluida: false, prazo: "2020-01-02" },
  { id: "bbbbbbbbbbbb", texto: "Série Y foi para manutenção", criada_em: "2026-10-30T09:05:00-03:00", concluida: false, prazo: null },
];

test("Lembretes: abre, lista com prazo, conclui e reabre sem exibir HTML", async ({ page }) => {
  const lista = LEMBRETES();
  const chamadas = await mockAssistente(page, { estado: PRONTO, ...mockLembretes(lista) });
  await page.goto("/");
  await abrirAssistente(page);
  const botao = page.getByRole("button", { name: "Lembretes" });
  await expect(page.locator("#assistente-lembretes")).toBeHidden();
  await expect(botao).toHaveAttribute("aria-expanded", "false");
  await botao.click();
  await expect(botao).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#assistente-lembretes")).toBeVisible();
  const itens = page.locator("#assistente-lembretes-lista li");
  await expect(itens).toHaveCount(2);
  await expect(itens.first()).toContainText("Conferir o lote X <b>agora</b>");
  await expect(itens.first()).toContainText("Prazo 02/01/2020 (vencido)");
  await expect(page.locator("#assistente-lembretes-lista b")).toHaveCount(0);
  await expect(page.locator("#assistente-lembretes-vazio")).toBeHidden();

  await page.getByRole("button", { name: "Concluir: Série Y foi para manutenção" }).click();
  await expect(page.locator("#assistente-lembretes-status")).toHaveText("Lembrete concluído.");
  expect(chamadas.find(c => c.nome === "notas/item" && c.metodo === "PATCH").corpo).toEqual({ concluida: true });
  await expect(itens.nth(1)).toContainText("Concluído");
  await expect(page.getByRole("button", { name: "Reabrir: Série Y foi para manutenção" })).toBeFocused();
  await page.getByRole("button", { name: "Reabrir: Série Y foi para manutenção" }).click();
  await expect(page.locator("#assistente-lembretes-status")).toHaveText("Lembrete reaberto.");
  expect(lista[1].concluida).toBe(false);

  await botao.click();
  await expect(page.locator("#assistente-lembretes")).toBeHidden();
  await expect(botao).toBeFocused();
});

test("Lembretes: apagar pede confirmação no painel, Esc cancela e confirmar apaga", async ({ page }) => {
  const lista = LEMBRETES();
  const chamadas = await mockAssistente(page, { estado: PRONTO, ...mockLembretes(lista) });
  await page.goto("/");
  await abrirAssistente(page);
  await page.getByRole("button", { name: "Lembretes" }).click();
  await expect(page.locator("#assistente-lembretes-lista li")).toHaveCount(2);

  await page.getByRole("button", { name: "Apagar lembrete: Série Y foi para manutenção" }).click();
  await expect(page.getByText("Apagar este lembrete?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Apagar este lembrete?")).toHaveCount(0);
  await expect(page.locator("#assistente-lembretes")).toBeVisible();
  expect(chamadas.some(c => c.metodo === "DELETE")).toBe(false);

  await page.getByRole("button", { name: "Apagar lembrete: Série Y foi para manutenção" }).click();
  await page.getByRole("button", { name: "Confirmar: apagar lembrete Série Y foi para manutenção" }).click();
  await expect(page.locator("#assistente-lembretes-status")).toHaveText("Lembrete apagado.");
  await expect(page.locator("#assistente-lembretes-lista li")).toHaveCount(1);
  expect(chamadas.filter(c => c.metodo === "DELETE")).toHaveLength(1);
  expect(lista.map(nota => nota.id)).toEqual(["aaaaaaaaaaaa"]);

  await page.getByRole("button", { name: /^Apagar lembrete: / }).click();
  await page.getByRole("button", { name: /^Confirmar: apagar/ }).click();
  await expect(page.locator("#assistente-lembretes-vazio")).toBeVisible();
  await expect(page.locator("#assistente-lembretes-lista")).toBeHidden();
});

test("Lembretes: erro ao carregar mostra o motivo e Instruções fecha a área (nunca duas abertas)", async ({ page }) => {
  await mockAssistente(page, { estado: PRONTO, notas: { status: 500, detail: "Falha interna." }, instrucoes: { texto: "", limite: 4000 } });
  await page.goto("/");
  await abrirAssistente(page);
  await page.getByRole("button", { name: "Lembretes" }).click();
  await expect(page.locator("#assistente-lembretes-status")).toContainText("Falha interna.");
  await page.getByRole("button", { name: "Instruções" }).click();
  await expect(page.locator("#assistente-instrucoes")).toBeVisible();
  await expect(page.locator("#assistente-lembretes")).toBeHidden();
  await expect(page.locator("#assistente-lembretes-botao")).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Lembretes" }).click();
  await expect(page.locator("#assistente-lembretes")).toBeVisible();
  await expect(page.locator("#assistente-instrucoes")).toBeHidden();
  await expect(page.locator("#assistente-instrucoes-botao")).toHaveAttribute("aria-expanded", "false");
});

test("Lembretes: tela estreita cabe sem rolagem, devolve o Enviar ao fechar e passa no axe nos dois temas", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const lista = LEMBRETES();
  lista[0].texto = "Conferir o lote X com o fornecedor e anotar o número de série de cada caixa recebida na doca";
  lista[1].concluida = true;
  await mockAssistente(page, { estado: PRONTO, ...mockLembretes(lista) });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-lembretes-botao").click();
  await expect(page.locator("#assistente-lembretes-lista li")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator("#assistente-mensagens")).toBeHidden();
  await page.getByRole("button", { name: /^Apagar lembrete: Conferir/ }).click();
  await expect(page.getByRole("button", { name: "Cancelar", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="assistente"]').analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), theme).toEqual([]);
  }
  await page.locator("#assistente-lembretes-botao").click();
  await expect(page.locator("#assistente-lembretes")).toBeHidden();
  await expect(page.locator("#assistente-enviar")).toBeInViewport();
});

const RASCUNHO = ["Assunto: Equipamentos sem acesso há 7 dias ou mais (2)", "", "Olá, tudo bem?", "- BRJ111AAAA (PC-RECEPCAO) — 9 dias sem verificação", "- BRJ222BBBB (PC-JOSE) — 12 dias sem verificação", "", "Obrigado."].join("\n");

test("Rascunho: Copiar texto copia a resposta, avisa em português e não rola na horizontal em 360 px", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockAssistente(page, { estado: PRONTO, mensagem: { texto: RASCUNHO, ferramentas: ["montar_rascunho"], pendente: null } });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill("escreve a cobrança dos equipamentos sem acesso há 7 dias");
  await page.locator("#assistente-enviar").click();
  const botao = page.getByRole("button", { name: "Copiar texto" });
  await expect(botao).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await botao.click();
  await expect(page.locator("#assistente-status")).toHaveText("Texto copiado.");
  // O Windows devolve a área de transferência com CRLF.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(RASCUNHO);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="assistente"]').analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), theme).toEqual([]);
  }
});

test("Rascunho: se a cópia falhar, avisa e só aparece quando a resposta usou montar_rascunho", async ({ page }) => {
  await mockAssistente(page, { estado: PRONTO, mensagem: { texto: RASCUNHO, ferramentas: ["montar_rascunho"], pendente: null } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("negado")) }, configurable: true });
    document.execCommand = () => false;
  });
  await page.goto("/");
  await abrirAssistente(page);
  await expect(page.getByRole("button", { name: "Copiar texto" })).toHaveCount(0);
  await page.locator("#assistente-texto").fill("rascunha o e-mail");
  await page.locator("#assistente-enviar").click();
  await page.getByRole("button", { name: "Copiar texto" }).click();
  await expect(page.locator("#assistente-status")).toContainText("Não foi possível copiar");
});

// Busca na web: o servidor é simulado; `estado` faz o papel do arquivo dele (desligada por padrão).
const FONTE_WEB = { titulo: "Apple Support", url: "https://support.apple.com/pt-br/111867", dominio: "support.apple.com" };
const BUSCA_WEB = [{
  consulta: "especificação técnica do MacBook Air M2",
  resumo: "O MacBook Air M2 tem até 24 GB de memória unificada.",
  fontes: [FONTE_WEB, { titulo: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)", dominio: "evil.example" }],
}];

test("Busca na web: começa desligada, avisa que a pergunta sai do computador ao ligar e desliga na hora", async ({ page }) => {
  const estado = { ativa: false };
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    instrucoes: { texto: "", limite: 4000 },
    "busca-web": corpo => (corpo ? { ativa: (estado.ativa = corpo.ativa), limite_consulta: 200 } : { ativa: estado.ativa, limite_consulta: 200 }),
  });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-instrucoes-botao").click();
  const interruptor = page.getByRole("switch", { name: "Busca na web" });
  await expect(interruptor).toBeEnabled();
  await expect(interruptor).not.toBeChecked();
  await expect(page.locator("#assistente-busca-web-aviso")).toBeEmpty();
  await interruptor.click();
  await expect(interruptor).toBeChecked();
  await expect(page.locator("#assistente-busca-web-aviso")).toContainText("a pergunta de pesquisa sai do computador");
  await expect(page.locator("#assistente-busca-web-status")).toHaveText("Busca na web ligada.");
  expect(chamadas.filter(c => c.nome === "busca-web" && c.metodo === "PUT").map(c => c.corpo)).toEqual([{ ativa: true }]);
  expect(estado.ativa).toBe(true);
  await interruptor.click();
  await expect(interruptor).not.toBeChecked();
  await expect(page.locator("#assistente-busca-web-aviso")).toBeEmpty();
  await expect(page.locator("#assistente-busca-web-status")).toContainText("Busca na web desligada");
  expect(estado.ativa).toBe(false);
  // Reabrir o painel lê o estado do servidor, que é a fonte da verdade.
  estado.ativa = true;
  await page.locator("#assistente-instrucoes-botao").click();
  await page.locator("#assistente-instrucoes-botao").click();
  await expect(interruptor).toBeChecked();
});

test("Busca na web: erro ao mudar volta o interruptor e erro ao ler deixa desligada", async ({ page }) => {
  await mockAssistente(page, {
    estado: PRONTO,
    instrucoes: { texto: "", limite: 4000 },
    "busca-web": corpo => (corpo ? { status: 500, detail: "Falha ao gravar." } : { ativa: false, limite_consulta: 200 }),
  });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-instrucoes-botao").click();
  const interruptor = page.getByRole("switch", { name: "Busca na web" });
  await interruptor.click();
  await expect(page.locator("#assistente-busca-web-status")).toHaveText("Falha ao gravar.");
  await expect(interruptor).not.toBeChecked();
  await expect(page.locator("#assistente-busca-web-aviso")).toBeEmpty();

  const falha = await page.context().newPage();
  await mockAssistente(falha, { estado: PRONTO, instrucoes: { texto: "", limite: 4000 }, "busca-web": { status: 500, detail: "Falha interna." } });
  await falha.goto("/");
  await abrirAssistente(falha);
  await falha.locator("#assistente-instrucoes-botao").click();
  await expect(falha.locator("#assistente-busca-web-status")).toContainText("A busca fica desligada.");
  await expect(falha.getByRole("switch", { name: "Busca na web" })).toBeDisabled();
  await expect(falha.getByRole("switch", { name: "Busca na web" })).not.toBeChecked();
});

test("Busca na web: cartão com a fonte (texto puro, só link http/https), 360 px sem rolagem e axe nos dois temas", async ({ page }) => {
  await mockAssistente(page, {
    estado: PRONTO,
    mensagem: { texto: "Segundo fonte externa (Apple Support): até 24 GB.", ferramentas: ["buscar_web"], pendente: null, busca_web: BUSCA_WEB },
  });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill("quanta memória tem o MacBook Air M2?");
  await page.locator("#assistente-enviar").click();
  const cartao = page.locator(".ck-assist__busca-card");
  await expect(cartao).toBeVisible();
  await expect(cartao).toContainText("Fonte externa");
  await expect(cartao).toContainText("especificação técnica do MacBook Air M2");
  await expect(cartao).toContainText("até 24 GB de memória unificada");
  const link = cartao.getByRole("link", { name: "Apple Support" });
  await expect(link).toHaveAttribute("href", FONTE_WEB.url);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(cartao).toContainText("support.apple.com");
  // Título malicioso entra como texto; URL que não é http/https não vira link.
  await expect(cartao.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  await expect(cartao.locator("a")).toHaveCount(1);
  await expect(cartao.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="assistente"]').analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), theme).toEqual([]);
  }
});

test("Busca na web: interruptor ligado em 360 px cabe sem rolagem e passa no axe nos dois temas", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await mockAssistente(page, { estado: PRONTO, instrucoes: { texto: "", limite: 4000 }, "busca-web": { ativa: true, limite_consulta: 200 } });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-instrucoes-botao").click();
  await expect(page.getByRole("switch", { name: "Busca na web" })).toBeChecked();
  await expect(page.locator("#assistente-busca-web-aviso")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="assistente"]').analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), theme).toEqual([]);
  }
});

test("Consultas encadeadas: a lista mostra a contagem e cada ferramenta uma vez, sem rolagem horizontal em 360 px", async ({ page }) => {
  const encadeadas = ["obter_totais_inventario", "listar_pendencias_operacionais", "comparar_periodos", "comparar_periodos", "consultar_historico_comparacao"];
  await mockAssistente(page, {
    estado: PRONTO,
    mensagem: { texto: "Resumo único, com a origem de cada número.", ferramentas: encadeadas, pendente: null },
  });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await abrirAssistente(page);
  await page.locator("#assistente-texto").fill("o que está sem acesso há 7 dias, onde, e o que mudou desde o mês passado?");
  await page.locator("#assistente-enviar").click();
  await expect(page.locator(".ck-assist__ferramentas")).toHaveText(
    "Ferramentas (5 chamadas): obter_totais_inventario, listar_pendencias_operacionais, comparar_periodos ×2, consultar_historico_comparacao",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    const audit = await new AxeBuilder({ page }).include('[data-cockpit-tool-panel="assistente"]').analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), theme).toEqual([]);
  }
});
