// Migração React, Dia 3, grupo G7b: Assistente (widget global #assistente-widget, static/js/features/assistant-chat.js).
// Invariantes gravados com o código antigo (JS puro), antes da troca para React: o widget em React tem de abrir, fechar,
// listar o histórico, copiar rascunho, pedir confirmação e mostrar texto exatamente como o antigo. O baseline de
// screenshots do widget e os testes de clique duplo em confirmar e de cancelar com confirmado false ficam em
// react-g7.spec.cjs; aqui não se repetem. Todas as rotas /api/assistente/* são simuladas: nenhum teste toca no modelo.
const { test, expect } = require("@playwright/test");

const PRONTO = { online: true, modelo: "modelo-teste", aguardando_confirmacao: false };
const PENDENTE = { descricao: "Abrir a pasta de entrada" };

// Copiado de assistente.spec.cjs (com `await` na função de resposta, para o portão segurar o pedido).
// `respostas` mapeia o final da URL para o JSON devolvido.
async function mockAssistente(page, respostas) {
  const chamadas = [];
  await page.route("**/api/assistente/**", async route => {
    const caminho = new URL(route.request().url()).pathname;
    // DELETE /anexo/{id} vira "anexo/remover" (o id muda a cada teste).
    // PATCH/DELETE /notas/{id} vira "notas/item" pelo mesmo motivo.
    // GET/DELETE /conversas/{id} vira "conversas/item".
    const nome = /\/anexo\/[^/]+$/.test(caminho) ? "anexo/remover" : /\/notas\/[^/]+$/.test(caminho) ? "notas/item" : /\/conversas\/[^/]+$/.test(caminho) ? "conversas/item" : caminho.split("/").pop();
    // O áudio (WAV) e o anexo chegam como bytes; só eles não são JSON.
    const audio = nome === "audio" || nome === "anexo" ? route.request().postDataBuffer() : null;
    chamadas.push({
      nome, metodo: route.request().method(), corpo: audio ? null : route.request().postDataJSON?.() ?? null, audio,
      cabecalhos: route.request().headers(), caminho,
    });
    const resposta = typeof respostas[nome] === "function" ? await respostas[nome](chamadas.at(-1).corpo, chamadas.at(-1).metodo, caminho) : respostas[nome];
    if (resposta?.status) await route.fulfill({ status: resposta.status, json: { detail: resposta.detail } });
    else await route.fulfill({ json: resposta ?? { ok: true } });
  });
  return chamadas;
}

async function abrirAssistente(page) {
  await page.locator("#btn-assistente").click();
  await expect(page.locator("#assistente-widget")).toBeVisible();
}

// Portão (como em react-g7.spec.cjs): segura uma resposta simulada até `liberar()`, para o pedido ficar em voo.
function portao() {
  const porta = {};
  porta.espera = new Promise(resolve => { porta.liberar = resolve; });
  return porta;
}

const CONVERSAS = [
  { id: "aaa111", titulo: "Quantos notebooks temos?", atualizada_em: "2026-10-30T10:15:00-03:00", mensagens: 2 },
  { id: "bbb222", titulo: "Resumo do mês", atualizada_em: "2026-10-29T09:00:00-03:00", mensagens: 4 },
];
const LEITURA = [{ papel: "usuario", texto: "Quantos notebooks temos?" }, { papel: "assistente", texto: "Temos 120 notebooks." }];

// Envia uma mensagem pela caixa de texto (Enter).
async function enviarTexto(page, texto) {
  await page.locator("#assistente-texto").fill(texto);
  await page.keyboard.press("Enter");
}

test("widget global: continua aberto e com a conversa ao trocar de aba do app; F9 abre e fecha", async ({ page }) => {
  await mockAssistente(page, { estado: PRONTO, mensagem: { texto: "Temos 12 notebooks.", ferramentas: [], pendente: null } });
  await page.goto("/");
  await abrirAssistente(page);
  await enviarTexto(page, "quantos?");
  await expect(page.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText("Temos 12 notebooks.");

  const widget = page.locator("#assistente-widget");
  // F2 (Transporte) e F1 (Home) trocam de aba; no celular o widget cobre as abas, então o clique não chega a elas.
  for (const [tecla, aba] of [["F2", "#tab-retirada-entrega"], ["F1", "#tab-home"]]) {
    await page.keyboard.press(tecla);
    await expect(page.locator(aba)).toHaveAttribute("aria-selected", "true");
    await expect(widget).toBeVisible();
    await expect(page.locator("#btn-assistente")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".ck-assist__msg--usuario .ck-assist__texto")).toHaveText("quantos?");
    await expect(page.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText("Temos 12 notebooks.");
  }

  await page.keyboard.press("F9");
  await expect(widget).toBeHidden();
  await expect(page.locator("#btn-assistente")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("F9");
  await expect(widget).toBeVisible();
  await expect(page.locator("#btn-assistente")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText("Temos 12 notebooks.");
});

test("abrir e fechar: ícone, botão X e Esc alternam aria-expanded e devolvem o foco ao ícone", async ({ page }) => {
  await mockAssistente(page, { estado: PRONTO });
  await page.goto("/");
  const icone = page.locator("#btn-assistente");
  const widget = page.locator("#assistente-widget");
  const caixa = page.locator("#assistente-texto");

  await icone.click();
  await expect(widget).toBeVisible();
  await expect(icone).toHaveAttribute("aria-expanded", "true");
  await icone.click();
  await expect(widget).toBeHidden();
  await expect(icone).toHaveAttribute("aria-expanded", "false");

  await icone.click();
  await expect(caixa).toBeFocused(); // o foco já está dentro do widget
  await page.getByRole("button", { name: "Fechar Assistente" }).click();
  await expect(widget).toBeHidden();
  await expect(icone).toHaveAttribute("aria-expanded", "false");
  await expect(icone).toBeFocused();

  await icone.click();
  await expect(caixa).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(widget).toBeHidden();
  await expect(icone).toHaveAttribute("aria-expanded", "false");
  await expect(icone).toBeFocused();
});

test("minimizar e maximizar mudam data-modo e o rótulo dos botões; reabrir volta ao modo normal", async ({ page }) => {
  await mockAssistente(page, { estado: PRONTO });
  await page.goto("/");
  await abrirAssistente(page);
  const widget = page.locator("#assistente-widget");
  const minimizar = page.locator("#assistente-minimizar");
  const maximizar = page.locator("#assistente-maximizar");
  await expect(minimizar).toHaveAttribute("aria-label", "Minimizar Assistente");
  await expect(maximizar).toHaveAttribute("aria-label", "Maximizar Assistente");

  await minimizar.click();
  await expect(widget).toHaveAttribute("data-modo", "minimizado");
  await expect(minimizar).toHaveAttribute("aria-label", "Restaurar Assistente");
  await expect(minimizar).toHaveAttribute("aria-expanded", "false");
  await expect(maximizar).toHaveAttribute("aria-label", "Maximizar Assistente");
  await minimizar.click();
  await expect(widget).toHaveAttribute("data-modo", "normal");
  await expect(minimizar).toHaveAttribute("aria-label", "Minimizar Assistente");
  await expect(minimizar).toHaveAttribute("aria-expanded", "true");

  await maximizar.click();
  await expect(widget).toHaveAttribute("data-modo", "maximizado");
  await expect(maximizar).toHaveAttribute("aria-label", "Restaurar tamanho do Assistente");
  await expect(minimizar).toHaveAttribute("aria-label", "Minimizar Assistente");
  await maximizar.click();
  await expect(widget).toHaveAttribute("data-modo", "normal");
  await expect(maximizar).toHaveAttribute("aria-label", "Maximizar Assistente");

  await minimizar.click();
  await page.getByRole("button", { name: "Fechar Assistente" }).click();
  await expect(widget).toBeHidden();
  await abrirAssistente(page);
  await expect(widget).toHaveAttribute("data-modo", "normal");
  await expect(minimizar).toHaveAttribute("aria-label", "Minimizar Assistente");
  await expect(page.locator("#assistente-texto")).toBeVisible();
});

test("histórico: lista as conversas, abre uma, e apagar pede confirmação inline (Cancelar mantém, Apagar chama DELETE)", async ({ page }) => {
  let conversas = [...CONVERSAS];
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    conversas: () => ({ conversas }),
    "conversas/item": (_corpo, metodo, caminho) => {
      const id = caminho.split("/").pop();
      if (metodo === "DELETE") { conversas = conversas.filter(c => c.id !== id); return { ok: true }; }
      return { id, titulo: "Quantos notebooks temos?", mensagens: LEITURA };
    },
  });
  await page.goto("/");
  await abrirAssistente(page);
  const painel = page.locator("#assistente-historico");
  const itens = painel.locator("#assistente-historico-lista li");
  await page.getByRole("button", { name: "Histórico de conversas", exact: true }).click();
  await expect(painel).toBeVisible();
  await expect(itens).toHaveCount(2);
  await expect(itens.nth(0)).toContainText("Quantos notebooks temos?");
  await expect(itens.nth(1)).toContainText("Resumo do mês");

  // Abrir uma conversa mostra as mensagens.
  await painel.getByRole("button", { name: "Quantos notebooks temos?", exact: true }).click();
  const leitura = painel.locator("#assistente-historico-leitura");
  await expect(leitura).toBeVisible();
  await expect(leitura.locator(".ck-assist__msg--usuario .ck-assist__texto")).toHaveText("Quantos notebooks temos?");
  await expect(leitura.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText("Temos 120 notebooks.");
  await painel.getByRole("button", { name: "Ver todas as conversas" }).click();
  await expect(itens).toHaveCount(2);

  // Apagar pede confirmação inline; Cancelar mantém a conversa e não chama DELETE.
  await painel.getByRole("button", { name: "Apagar conversa: Resumo do mês" }).click();
  await expect(painel).toContainText("Apagar esta conversa?");
  await painel.getByRole("button", { name: "Cancelar" }).click();
  await expect(painel).not.toContainText("Apagar esta conversa?");
  await expect(itens).toHaveCount(2);
  expect(chamadas.some(c => c.metodo === "DELETE")).toBe(false);

  // Confirmar apaga: DELETE em conversas/{id}.
  await painel.getByRole("button", { name: "Apagar conversa: Resumo do mês" }).click();
  await expect(painel).toContainText("Apagar esta conversa?");
  await painel.getByRole("button", { name: "Confirmar: apagar conversa Resumo do mês" }).click();
  await expect(itens).toHaveCount(1);
  await expect(itens.first()).toContainText("Quantos notebooks temos?");
  const apagar = chamadas.filter(c => c.metodo === "DELETE");
  expect(apagar).toHaveLength(1);
  expect(apagar[0].nome).toBe("conversas/item");
  expect(apagar[0].caminho).toBe("/api/assistente/conversas/bbb222");
});

test("histórico lateral: só no modo maximizado e com largura de 900px ou mais", async ({ page, isMobile }) => {
  test.skip(isMobile, "a lateral só existe a partir de 900px");
  await mockAssistente(page, { estado: PRONTO, conversas: () => ({ conversas: CONVERSAS }) });
  await page.goto("/");
  await abrirAssistente(page);
  const lista = page.locator("#assistente-lateral-conversas-lista");
  await expect(lista).toBeHidden(); // modo normal
  await page.locator("#assistente-maximizar").click();
  await expect(page.locator("#assistente-widget")).toHaveAttribute("data-modo", "maximizado");
  expect(page.viewportSize().width).toBeGreaterThanOrEqual(900);
  await expect(lista).toBeVisible();
  await expect(lista.locator("li")).toHaveCount(2);
  await expect(lista.locator("li").first()).toContainText("Quantos notebooks temos?");
  await page.setViewportSize({ width: 899, height: page.viewportSize().height }); // abaixo de 900px a lateral some
  await expect(lista).toBeHidden();
  await page.setViewportSize({ width: 900, height: page.viewportSize().height });
  await expect(lista).toBeVisible();
});

test("rascunho: 'Copiar texto' só aparece com montar_rascunho e avisa 'Texto copiado.'", async ({ page }) => {
  // O Chromium sem tela recusa a área de transferência real; o stub só guarda o que seria copiado.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async texto => { window.__copiado = texto; } } });
  });
  const rascunho = "Prezado Fulano,\nSegue o texto pronto.";
  const respostas = [
    { texto: "Temos 12 notebooks.", ferramentas: ["buscar_equipamento"], pendente: null },
    { texto: rascunho, ferramentas: ["buscar_equipamento", "montar_rascunho"], pendente: null },
  ];
  await mockAssistente(page, { estado: PRONTO, mensagem: () => respostas.shift() });
  await page.goto("/");
  await abrirAssistente(page);
  const copiar = page.getByRole("button", { name: "Copiar texto" });

  await enviarTexto(page, "quantos?");
  await expect(page.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText("Temos 12 notebooks.");
  await expect(page.locator("#assistente-texto")).toBeEnabled();
  await expect(copiar).toHaveCount(0);

  await enviarTexto(page, "monte um rascunho");
  await expect(page.locator(".ck-assist__msg--assistente").last()).toContainText("Segue o texto pronto.");
  await expect(copiar).toHaveCount(1);
  await copiar.click();
  await expect(page.locator("#assistente-status")).toHaveText("Texto copiado.");
  expect(await page.evaluate(() => window.__copiado)).toBe(rascunho);
});

test("confirmação de envio: o cartão mostra a descrição e Esc cancela (confirmado false) sem fechar o widget", async ({ page }) => {
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    mensagem: { texto: "Posso executar?", ferramentas: [], pendente: PENDENTE },
    confirmar: corpo => ({ texto: corpo.confirmado ? "Feito." : "Cancelado.", ferramentas: [], pendente: null }),
  });
  await page.goto("/");
  await abrirAssistente(page);
  const cartao = page.locator("#assistente-pendente");
  await enviarTexto(page, "abra a pasta");
  await expect(cartao).toBeVisible();
  await expect(cartao).toBeFocused();
  await expect(page.locator("#assistente-pendente-descricao")).toHaveText(PENDENTE.descricao);
  expect(chamadas.filter(c => c.nome === "confirmar")).toEqual([]); // o cartão aparecer não confirma nada

  await page.keyboard.press("Escape");
  await expect(cartao).toBeHidden();
  await expect(page.locator(".ck-assist__msg--assistente").last()).toHaveText(/Cancelado\./);
  await expect(page.locator("#assistente-widget")).toBeVisible();
  await expect(page.locator("#btn-assistente")).toHaveAttribute("aria-expanded", "true");
  expect(chamadas.filter(c => c.nome === "confirmar").map(c => c.corpo)).toEqual([{ confirmado: false }]);
});

test("confirmação de envio: Confirmar e Cancelar ficam desabilitados enquanto o pedido está em voo", async ({ page }) => {
  const retido = portao();
  const chamadas = await mockAssistente(page, {
    estado: PRONTO,
    mensagem: { texto: "Posso executar?", ferramentas: [], pendente: PENDENTE },
    confirmar: async corpo => {
      await retido.espera;
      return { texto: corpo.confirmado ? "Feito." : "Cancelado.", ferramentas: [], pendente: null };
    },
  });
  await page.goto("/");
  await abrirAssistente(page);
  const confirmar = page.locator("#assistente-confirmar");
  const cancelar = page.locator("#assistente-cancelar");
  await enviarTexto(page, "abra a pasta");
  await expect(page.locator("#assistente-pendente")).toBeVisible();
  await expect(confirmar).toBeEnabled();
  await expect(cancelar).toBeEnabled();

  await confirmar.click();
  await expect.poll(() => chamadas.filter(c => c.nome === "confirmar").length).toBe(1);
  await expect(confirmar).toBeDisabled();
  await expect(cancelar).toBeDisabled();
  await expect(page.locator("#assistente-pendente")).toBeVisible(); // continua à vista até a resposta chegar

  retido.liberar();
  await expect(page.locator("#assistente-pendente")).toBeHidden();
  await expect(page.locator(".ck-assist__msg--assistente").last()).toHaveText(/Feito\./);
  expect(chamadas.filter(c => c.nome === "confirmar").map(c => c.corpo)).toEqual([{ confirmado: true }]);
});

test("máscara: [PESSOA_1] e HTML da resposta aparecem como texto literal e o POST leva o texto digitado", async ({ page }) => {
  const resposta = "Marina [PESSOA_1] usa PRNOTESJP01 <b>x</b>";
  const digitado = "onde está o equipamento da Marina?";
  const chamadas = await mockAssistente(page, { estado: PRONTO, mensagem: { texto: resposta, ferramentas: [], pendente: null } });
  await page.goto("/");
  await abrirAssistente(page);
  await enviarTexto(page, digitado);
  await expect(page.locator(".ck-assist__msg--assistente .ck-assist__texto")).toHaveText(resposta);
  await expect(page.locator(".ck-assist__msg--usuario .ck-assist__texto")).toHaveText(digitado);
  await expect(page.locator("#assistente-widget").locator("b")).toHaveCount(0);
  const posts = chamadas.filter(c => c.nome === "mensagem");
  expect(posts).toHaveLength(1);
  expect(posts[0].metodo).toBe("POST");
  expect(posts[0].corpo.texto).toBe(digitado);
});

test("máscara: resposta já desmascarada pelo servidor (hostname) aparece igual, como texto, sem elemento <b>", async ({ page }) => {
  const resposta = "PRNOTEXYZ01 está online <b>ok</b>";
  await mockAssistente(page, { estado: PRONTO, mensagem: { texto: resposta, ferramentas: [], pendente: null } });
  await page.goto("/");
  await abrirAssistente(page);
  await enviarTexto(page, "o PRNOTEXYZ01 está online?");
  const texto = page.locator("#assistente-mensagens .ck-assist__msg--assistente .ck-assist__texto");
  await expect(texto).toHaveText(resposta);
  expect(await texto.evaluate(no => no.textContent)).toBe(resposta);
  await expect(page.locator("#assistente-mensagens b")).toHaveCount(0);
});
