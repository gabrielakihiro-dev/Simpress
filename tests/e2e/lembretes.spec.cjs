const { test, expect } = require("@playwright/test");

// Lembretes (Ferramentas): o painel real sobre o router real de /api/lembretes, num arquivo temporário da fixture.
// Cada teste recomeça de /__fixture_lembretes (lista vazia ou com N itens sintéticos).
const DATA = /^(Criado|Alterado) em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;
const CRIADO = /^Criado em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;
const ALTERADO = /^Alterado em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;

async function abrirLembretes(page, { itens = 0, reiniciar = true } = {}) {
  if (reiniciar) expect((await page.request.get(`/__fixture_lembretes?itens=${itens}`)).ok()).toBeTruthy();
  await page.goto("/");
  const menu = page.locator("#cockpit-tools-dropdown");
  if (!(await menu.evaluate(node => node.open))) await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-lembretes").click();
  await expect(page.locator('[data-cockpit-tool-panel="lembretes"]')).toBeVisible();
  await expect(page.locator("#termos-painel-lembretes")).toBeVisible();
}

const campoNovo = page => page.getByPlaceholder("O que você precisa fazer?");
const adicionar = page => page.getByRole("button", { name: "Adicionar", exact: true });
// getByLabel("Editar descrição") também casaria os lápis do Sebrae: o campo é achado pelo papel e pelo nome.
const campoEdicao = page => page.getByRole("textbox", { name: "Editar descrição" });
const pendentes = page => page.locator("#lembretes-lista > li");
const concluidos = page => page.locator("#lembretes-concluidos-lista > li");
const apiLembretes = async page => (await (await page.request.get("/api/lembretes")).json()).lembretes;

async function adicionarPelaTela(page, texto) {
  await campoNovo(page).fill(texto);
  await campoNovo(page).press("Enter");
  await expect(pendentes(page).filter({ hasText: texto })).toHaveCount(1);
}

test("abre em Lembretes com as pílulas na ordem e o estado vazio", async ({ page }) => {
  await abrirLembretes(page);
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Lembretes");
  const abas = page.locator('[data-cockpit-tool-panel="lembretes"] [role="tablist"] [role="tab"]');
  await expect(abas).toHaveText([/^Termo Entrega$/, /^Termo Devolução$/, /^Lembretes 0 pendentes$/]);
  await expect(page.locator("#termos-aba-lembretes")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#termos-painel-entrega")).toBeHidden();
  await expect(page.locator("#termos-painel-devolucao")).toBeHidden();
  await expect(page.locator("#lembretes-vazio")).toHaveText("Nenhum lembrete. Anote o que precisa fazer.");
  await expect(page.locator("#lembretes-concluidos")).toBeHidden();
  await expect(adicionar(page)).toBeDisabled();

  // Os termos continuam nas outras abas, e as setas percorrem as três pílulas.
  await page.locator("#termos-aba-entrega").click();
  await expect(page.locator("#termos-painel-entrega")).toBeVisible();
  await expect(page.locator("#termos-painel-lembretes")).toBeHidden();
  await page.locator("#termos-aba-devolucao").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#termos-aba-lembretes")).toBeFocused();
  await expect(page.locator("#termos-painel-lembretes")).toBeVisible();
});

test("o botão Termos abre o painel na aba Termo Entrega", async ({ page }) => {
  await page.goto("/");
  await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-termos").click();
  await expect(page.locator('[data-cockpit-tool-panel="lembretes"]')).toBeVisible();
  await expect(page.locator("#termos-aba-entrega")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#termos-painel-entrega")).toBeVisible();
});

test("Enter adiciona, o campo vazio não adiciona e o contador acompanha", async ({ page }) => {
  await abrirLembretes(page);
  await expect(adicionar(page)).toBeDisabled();
  await campoNovo(page).fill("   ");
  await expect(adicionar(page)).toBeDisabled();
  await campoNovo(page).press("Enter");
  await expect(pendentes(page)).toHaveCount(0);
  expect(await apiLembretes(page)).toEqual([]);

  await campoNovo(page).fill("Ligar para o fornecedor");
  await expect(adicionar(page)).toBeEnabled();
  await campoNovo(page).press("Enter");
  const item = pendentes(page).filter({ hasText: "Ligar para o fornecedor" });
  await expect(item).toHaveCount(1);
  await expect(item.locator("time")).toHaveText(CRIADO);
  await expect(campoNovo(page)).toHaveValue("");
  await expect(campoNovo(page)).toBeFocused();
  await expect(adicionar(page)).toBeDisabled();
  await expect(page.locator("#lembretes-vazio")).toBeHidden();
  await expect(page.locator("#lembretes-pendentes")).toHaveText("1");
  expect((await apiLembretes(page)).map(l => l.descricao)).toEqual(["Ligar para o fornecedor"]);

  // O botão também adiciona.
  await campoNovo(page).fill("Pedir toner");
  await adicionar(page).click();
  await expect(pendentes(page)).toHaveCount(2);
  await expect(page.locator("#lembretes-pendentes")).toHaveText("2");
});

test("acima de 2000 caracteres desabilita o botão e mostra o aviso", async ({ page }) => {
  await abrirLembretes(page);
  await campoNovo(page).fill("a".repeat(2001));
  await expect(adicionar(page)).toBeDisabled();
  await expect(page.locator("#lembretes-novo-erro")).toHaveText("A descrição pode ter até 2000 caracteres.");
  await campoNovo(page).press("Enter");
  expect(await apiLembretes(page)).toEqual([]);
  await campoNovo(page).fill("a".repeat(2000));
  await expect(adicionar(page)).toBeEnabled();
  await expect(page.locator("#lembretes-novo-erro")).toBeHidden();
});

test("falha ao gravar mostra o aviso e mantém o texto digitado", async ({ page }) => {
  await abrirLembretes(page);
  await page.route("**/api/lembretes", route => route.request().method() === "POST"
    ? route.fulfill({ status: 503, json: { detail: "Aviso de teste: gravação indisponível.", codigo: "lembretes_gravacao" } })
    : route.fallback());
  await campoNovo(page).fill("Texto que deve ficar no campo");
  await campoNovo(page).press("Enter");
  await expect(page.getByText("Aviso de teste: gravação indisponível.")).toBeVisible();
  await expect(campoNovo(page)).toHaveValue("Texto que deve ficar no campo");
  await expect(pendentes(page)).toHaveCount(0);
});

test("editar: Esc cancela sem fechar o painel, Enter sem mudança não grava e Enter com mudança mostra Alterado em", async ({ page }) => {
  await abrirLembretes(page, { itens: 1 });
  const patches = [];
  page.on("request", requisicao => { if (requisicao.method() === "PATCH") patches.push(requisicao.url()); });
  const item = pendentes(page).first();
  const editar = item.getByRole("button", { name: "Editar lembrete" });
  const campo = campoEdicao(page);

  await editar.click();
  await expect(campo).toBeFocused();
  await expect(campo).toHaveValue("Lembrete sintético 1");
  await expect(page.getByText("Enter salva · Esc cancela")).toBeVisible();
  await campo.fill("Texto que será descartado");
  await page.keyboard.press("Escape");
  await expect(campo).toHaveCount(0);
  await expect(page.locator('[data-cockpit-tool-panel="lembretes"]')).toBeVisible();
  await expect(item).toContainText("Lembrete sintético 1");
  await expect(item.locator("time")).toHaveText(CRIADO);
  await expect(item.getByRole("button", { name: "Editar lembrete" })).toBeFocused();

  // Enter sem mudar o texto fecha a edição e não chama a API: a data não muda.
  await editar.click();
  await campo.press("Enter");
  await expect(campo).toHaveCount(0);
  await expect(item.locator("time")).toHaveText(CRIADO);
  expect(patches).toEqual([]);

  // Cancelar e Salvar pelos botões; texto vazio desabilita Salvar.
  await editar.click();
  await campo.fill("");
  await expect(page.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();
  await campo.fill("Outro texto descartado");
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(item).toContainText("Lembrete sintético 1");

  await editar.click();
  await campo.fill("Texto alterado");
  await campo.press("Enter");
  await expect(campo).toHaveCount(0);
  await expect(item).toContainText("Texto alterado");
  await expect(item.locator("time")).toHaveText(ALTERADO);
  await expect(item.getByRole("button", { name: "Editar lembrete" })).toBeFocused();
  expect(patches).toHaveLength(1);
  expect((await apiLembretes(page))[0]).toMatchObject({ descricao: "Texto alterado" });
});

test("o mais recente fica no topo, pela data exibida", async ({ page }) => {
  await abrirLembretes(page);
  await adicionarPelaTela(page, "Primeiro");
  await page.waitForTimeout(1100); // a data tem precisão de segundo
  await adicionarPelaTela(page, "Segundo");
  await expect(pendentes(page).locator(".lembretes__texto")).toHaveText(["Segundo", "Primeiro"]);

  await page.waitForTimeout(1100);
  await pendentes(page).filter({ hasText: "Primeiro" }).getByRole("button", { name: "Editar lembrete" }).click();
  await campoEdicao(page).fill("Primeiro editado");
  await campoEdicao(page).press("Enter");
  await expect(pendentes(page).locator(".lembretes__texto")).toHaveText(["Primeiro editado", "Segundo"]);

  // Depois de recarregar, a ordem vem das mesmas datas.
  await abrirLembretes(page, { reiniciar: false });
  await expect(pendentes(page).locator(".lembretes__texto")).toHaveText(["Primeiro editado", "Segundo"]);
  await expect(pendentes(page).first().locator("time")).toHaveText(ALTERADO);
  await expect(pendentes(page).nth(1).locator("time")).toHaveText(CRIADO);
});

test("concluir move o item para Concluídos (n), que recolhe e expande", async ({ page }) => {
  await abrirLembretes(page, { itens: 2 });
  await expect(pendentes(page)).toHaveCount(2);
  await expect(page.locator("#lembretes-pendentes")).toHaveText("2");

  await page.getByRole("button", { name: "Concluir: Lembrete sintético 1" }).click();
  await expect(pendentes(page)).toHaveCount(1);
  await expect(page.locator("#lembretes-pendentes")).toHaveText("1");
  const recolher = page.getByRole("button", { name: "Concluídos (1)" });
  await expect(recolher).toBeVisible();
  await expect(recolher).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#lembretes-concluidos-lista")).toBeHidden();
  await expect(recolher).toBeFocused(); // o item saiu da lista e o foco não se perde

  await recolher.click();
  await expect(recolher).toHaveAttribute("aria-expanded", "true");
  await expect(concluidos(page)).toHaveCount(1);
  await expect(concluidos(page).first()).toContainText("Lembrete sintético 1");

  await page.getByRole("button", { name: "Desmarcar: Lembrete sintético 1" }).click();
  await expect(pendentes(page)).toHaveCount(2);
  await expect(page.locator("#lembretes-concluidos")).toBeHidden();
  await expect(page.locator("#lembretes-pendentes")).toHaveText("2");
  expect((await apiLembretes(page)).every(l => l.concluido === false)).toBe(true);
});

test("excluir pede confirmação: Esc e Cancelar mantêm, Excluir remove e o foco vai para o próximo", async ({ page }) => {
  await abrirLembretes(page, { itens: 2 });
  const painel = page.locator('[data-cockpit-tool-panel="lembretes"]');
  const excluirDoItem = texto => pendentes(page).filter({ hasText: texto }).getByRole("button", { name: "Excluir lembrete" });
  const dialogo = page.getByRole("alertdialog", { name: "Excluir este lembrete?" });

  await excluirDoItem("Lembrete sintético 1").click();
  await expect(dialogo).toBeVisible();
  await expect(dialogo).toContainText("Lembrete sintético 1");
  await expect(dialogo).toContainText("Esta ação não pode ser desfeita.");
  await expect(dialogo.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  // O véu cobre a janela inteira (position:fixed fora do container do painel).
  const janela = page.viewportSize();
  const veu = await page.locator("#lembretes-confirmar").boundingBox();
  expect(veu.width).toBeGreaterThanOrEqual(janela.width - 1);
  expect(veu.height).toBeGreaterThanOrEqual(janela.height - 1);

  await page.keyboard.press("Escape");
  await expect(dialogo).toBeHidden();
  await expect(painel).toBeVisible(); // o Esc fecha só o diálogo
  await expect(pendentes(page)).toHaveCount(2);
  await expect(excluirDoItem("Lembrete sintético 1")).toBeFocused();

  await excluirDoItem("Lembrete sintético 1").click();
  await dialogo.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(dialogo).toBeHidden();
  await expect(pendentes(page)).toHaveCount(2);

  await excluirDoItem("Lembrete sintético 1").click();
  await dialogo.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(dialogo).toBeHidden();
  await expect(pendentes(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Concluir: Lembrete sintético 2" })).toBeFocused();
  expect((await apiLembretes(page)).map(l => l.descricao)).toEqual(["Lembrete sintético 2"]);

  await excluirDoItem("Lembrete sintético 2").click();
  await dialogo.getByRole("button", { name: "Excluir", exact: true }).click();
  await expect(pendentes(page)).toHaveCount(0);
  await expect(page.locator("#lembretes-vazio")).toBeVisible();
  await expect(campoNovo(page)).toBeFocused();
});

for (const largura of [320, 2560]) {
  test(`${largura}px sem rolagem horizontal, com texto longo e em edição`, async ({ page }) => {
    await page.setViewportSize({ width: largura, height: 800 });
    await abrirLembretes(page, { itens: 2 });
    await adicionarPelaTela(page, "x".repeat(300));
    await pendentes(page).first().getByRole("button", { name: "Editar lembrete" }).click();
    await expect(campoEdicao(page)).toBeVisible();
    await page.getByRole("button", { name: "Cancelar", exact: true }).click();
    await page.getByRole("button", { name: "Concluir: Lembrete sintético 1" }).click();
    await page.getByRole("button", { name: "Concluídos (1)" }).click();

    const medidas = await page.evaluate(() => {
      const raiz = document.documentElement;
      const fora = [...document.querySelectorAll('[data-cockpit-tool-panel="lembretes"] *')]
        .filter(el => !el.closest(".sr-only") && !el.classList.contains("sr-only") && el.getClientRects().length)
        .filter(el => el.getBoundingClientRect().width > 1 && el.getBoundingClientRect().right > raiz.clientWidth + 1)
        .map(el => el.className || el.tagName);
      return { janela: raiz.clientWidth, documento: raiz.scrollWidth, corpo: document.body.scrollWidth, fora };
    });
    expect(medidas.documento).toBeLessThanOrEqual(medidas.janela);
    expect(medidas.corpo).toBeLessThanOrEqual(medidas.janela);
    expect(medidas.fora).toEqual([]);

    if (largura === 320) {
      // Abaixo de 480px: ações sempre visíveis e alvos de 44px.
      const editar = pendentes(page).first().getByRole("button", { name: "Editar lembrete" });
      await expect(editar).toBeVisible();
      await expect(pendentes(page).first().locator(".lembretes__acoes")).toHaveCSS("opacity", "1");
      for (const botao of [editar, pendentes(page).first().getByRole("button", { name: "Excluir lembrete" }),
        pendentes(page).first().getByRole("button", { name: /^Concluir: / })]) {
        const caixa = await botao.boundingBox();
        expect(caixa.width).toBeGreaterThanOrEqual(44);
        expect(caixa.height).toBeGreaterThanOrEqual(44);
      }
    }
  });
}

test("tema escuro usa os tokens do Cockpit", async ({ page }) => {
  await abrirLembretes(page, { itens: 1 });
  const cores = () => page.evaluate(() => {
    const item = document.querySelector("#lembretes-lista > li");
    return {
      fundo: getComputedStyle(item).backgroundColor,
      texto: getComputedStyle(item.querySelector(".lembretes__texto")).color,
      token: getComputedStyle(document.documentElement).getPropertyValue("--cor-superficie").trim(),
    };
  });
  // O tema padrão do app é o escuro: força o claro antes de medir. O fundo do item tem transição
  // (--duracao), então espera o valor assentar em vez de ler o primeiro quadro.
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await expect.poll(async () => (await cores()).fundo).toBe("rgb(255, 255, 255)"); // --cor-superficie claro
  const claro = await cores();
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await expect.poll(async () => (await cores()).fundo).toBe("rgb(29, 32, 49)"); // --cor-superficie escuro
  const escuro = await cores();
  expect(escuro.fundo).not.toBe(claro.fundo);
  expect(escuro.texto).toBe("rgb(233, 233, 237)"); // --cor-texto escuro
  expect(escuro.token.toLowerCase()).toBe("#1d2031");
});

test("data de cada item aparece como Criado em / Alterado em no formato dd/mm/aaaa hh:mm", async ({ page }) => {
  await abrirLembretes(page, { itens: 2 });
  for (const rotulo of await pendentes(page).locator("time").allTextContents()) expect(rotulo).toMatch(DATA);
});

test("editar e excluir mostram o ícone da sprite (símbolo existe e o desenho tem tamanho)", async ({ page }) => {
  await abrirLembretes(page, { itens: 1 });
  for (const botao of [".lembretes__editar", ".lembretes__excluir"]) {
    const icone = await page.evaluate((seletor) => {
      const svg = document.querySelector(`#lembretes-lista ${seletor} svg`);
      const uso = svg?.querySelector("use");
      return { simbolo: Boolean(uso && document.querySelector(uso.getAttribute("href"))), largura: svg ? svg.getBoundingClientRect().width : 0 };
    }, botao);
    expect(icone.simbolo, botao).toBe(true);
    expect(icone.largura, botao).toBe(16);
  }
});
