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

test("o menu Ferramentas não tem mais o botão Termos: os termos abrem pela pílula de Lembretes", async ({ page }) => {
  await page.goto("/");
  await page.locator("#cockpit-tools-trigger").click();
  await expect(page.locator("#cockpit-tools-dropdown").getByRole("menuitem", { name: "Termos", exact: true })).toHaveCount(0);
  await page.locator("#btn-lembretes").click();
  await expect(page.locator('[data-cockpit-tool-panel="lembretes"]')).toBeVisible();
  await page.locator("#termos-aba-entrega").click();
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

// Termo → Lembrete: o botão Criar lembrete dos dois termos monta a descrição, abre o diálogo e só cria no clique.
const AVISO_SEM_DADOS = "Preencha o número de série e o nome do colaborador.";
const botaoCriarLembrete = (page, termo) => page.locator(`#termos-painel-${termo}`).getByRole("button", { name: "Criar lembrete" });
const dialogoCriar = page => page.locator("#lembretes-criar");
const descricaoCriar = page => page.locator("#lembretes-criar-descricao");
const confirmarCriar = page => page.locator("#lembretes-criar-ok");
const postsDeLembretes = page => {
  const posts = [];
  page.on("request", requisicao => {
    if (requisicao.method() === "POST" && requisicao.url().endsWith("/api/lembretes")) posts.push(requisicao.postDataJSON());
  });
  return posts;
};

async function abrirTermo(page, termo, opcoes) {
  await abrirLembretes(page, opcoes);
  await page.locator(`#termos-aba-${termo}`).click();
  await expect(page.locator(`#termos-painel-${termo}`)).toBeVisible();
}

// Termo novo abre com todos os itens em Sim; os testes partem de itens sem resposta para escolher os do texto.
async function desmarcarItens(page, termo) {
  await page.locator(`#termos-form-${termo} input[type="radio"]`).evaluateAll(radios => radios.forEach(r => { r.checked = false; }));
}

async function preencherEntrega(page) {
  await desmarcarItens(page, "entrega");
  await page.locator("#termos-entrega-nome").fill("Maria Teste");
  await page.locator("#termos-entrega-unidade").fill("Curitiba");
  await page.locator("#termos-entrega-data").fill("2026-11-12");
  await page.locator("#termos-entrega-modelo-anterior").fill("Dell 5420");
  await page.locator("#termos-entrega-modelo-entregue").fill("HP 640 G11");
  await page.locator("#termos-entrega-serie-anterior").fill("ANTIGA123");
  await page.locator("#termos-entrega-serie-entregue").fill("NOVA456");
  await page.locator("#termos-entrega-item-02-sim").check();
  await page.locator("#termos-entrega-item-03-sim").check();
  await page.locator("#termos-entrega-obs").fill("Sem avarias.");
}

async function preencherDevolucao(page) {
  await desmarcarItens(page, "devolucao");
  await page.locator("#termos-devolucao-nome").fill("Maria Teste");
  await page.locator("#termos-devolucao-unidade").fill("Curitiba");
  await page.locator("#termos-devolucao-data").fill("2026-11-12");
  await page.locator("#termos-devolucao-modelo").fill("HP 640 G10");
  await page.locator("#termos-devolucao-serie").fill("BRJ123");
  await page.locator("#termos-devolucao-item-01-sim").check();
  await page.locator("#termos-devolucao-item-02-nao").check();
  await page.locator("#termos-devolucao-item-03-sim").check();
}

// Cópia do termo que o POST leva (e o servidor devolve) para o que preencherEntrega / preencherDevolucao digitam:
// itens traz só as 11 respostas ("sim", "nao" ou vazio), na ordem do formulário.
const vazios = quantidade => Array(quantidade).fill("");
const TERMO_ENTREGA = {
  campos: {
    nome: "Maria Teste", unidade: "Curitiba", data: "2026-11-12", modelo_anterior: "Dell 5420",
    modelo_entregue: "HP 640 G11", serie_anterior: "ANTIGA123", serie_entregue: "NOVA456",
  },
  itens: ["", "sim", "sim", ...vazios(8)],
  obs: "Sem avarias.",
};
const termoDevolucao = (obs = "") => ({
  campos: { nome: "Maria Teste", unidade: "Curitiba", data: "2026-11-12", modelo: "HP 640 G10", serie: "BRJ123" },
  itens: ["sim", "nao", "sim", ...vazios(8)],
  obs,
});

test("Criar lembrete sem série ou sem nome mostra só o aviso e nada abre", async ({ page }) => {
  await abrirTermo(page, "entrega");
  await botaoCriarLembrete(page, "entrega").click();
  await expect(page.locator("#termos-status-entrega")).toHaveText(AVISO_SEM_DADOS);
  await expect(dialogoCriar(page)).toBeHidden();

  // Só o nome, ou só a série: também bloqueia.
  await page.locator("#termos-entrega-nome").fill("Maria Teste");
  await botaoCriarLembrete(page, "entrega").click();
  await expect(page.locator("#termos-status-entrega")).toHaveText(AVISO_SEM_DADOS);
  await page.locator("#termos-entrega-nome").fill("");
  await page.locator("#termos-entrega-serie-entregue").fill("NOVA456");
  await botaoCriarLembrete(page, "entrega").click();
  await expect(page.locator("#termos-status-entrega")).toHaveText(AVISO_SEM_DADOS);

  await page.locator("#termos-aba-devolucao").click();
  await botaoCriarLembrete(page, "devolucao").click();
  await expect(page.locator("#termos-status-devolucao")).toHaveText(AVISO_SEM_DADOS);
  await expect(dialogoCriar(page)).toBeHidden();
  expect(await apiLembretes(page)).toEqual([]);
});

test("Termo Entrega: o diálogo abre com o texto montado, Esc cancela sem criar e o foco volta ao botão", async ({ page }) => {
  await abrirTermo(page, "entrega");
  await preencherEntrega(page);
  const botao = botaoCriarLembrete(page, "entrega");
  await botao.click();

  await expect(dialogoCriar(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Criar lembrete" })).toBeVisible();
  await expect(descricaoCriar(page)).toHaveValue(
    "Entrada: Maria Teste (Curitiba) recebeu HP 640 G11, série NOVA456 em 12/11/2026. "
    + "Itens: 02 Notebook, 03 Teclado. Anterior: Dell 5420, série ANTIGA123. Obs.: Sem avarias.",
  );
  await expect(page.locator("#lembretes-criar-dica")).toHaveText("Texto montado com os dados do termo. Revise antes de criar.");
  await expect(page.locator("#lembretes-criar-cancelar")).toHaveText("Cancelar");
  await expect(confirmarCriar(page)).toHaveText("Criar lembrete");
  await expect(confirmarCriar(page)).toBeEnabled();
  await expect(descricaoCriar(page)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialogoCriar(page)).toBeHidden();
  await expect(botao).toBeFocused();
  // O Esc só fechou o diálogo: o painel e o termo continuam abertos, e nada foi criado.
  await expect(page.locator("#termos-painel-entrega")).toBeVisible();
  expect(await apiLembretes(page)).toEqual([]);

  await botao.click();
  await page.locator("#lembretes-criar-cancelar").click();
  await expect(dialogoCriar(page)).toBeHidden();
  await expect(botao).toBeFocused();
  expect(await apiLembretes(page)).toEqual([]);
});

test("Termo Entrega: confirmar cria o lembrete com origem entrega e oferece Ver em Lembretes", async ({ page }) => {
  await abrirTermo(page, "entrega");
  await preencherEntrega(page);
  const posts = postsDeLembretes(page);
  await botaoCriarLembrete(page, "entrega").click();
  // O usuário revisa e muda o texto antes de criar; o que vai é o texto do campo.
  const revisado = "Entrada: Maria Teste recebeu HP 640 G11, série NOVA456. Conferir carregador.";
  await descricaoCriar(page).fill(revisado);
  await confirmarCriar(page).click();

  await expect(dialogoCriar(page)).toBeHidden();
  await expect(page.locator("#termos-status-entrega")).toHaveText("Lembrete criado.Ver em Lembretes");
  expect(posts).toEqual([{ descricao: revisado, origem: "entrega", termo: TERMO_ENTREGA }]);
  const [criado] = await apiLembretes(page);
  expect(criado).toMatchObject({ descricao: revisado, origem: "entrega", termo: TERMO_ENTREGA });

  await page.locator("#termos-status-entrega").getByRole("button", { name: "Ver em Lembretes" }).click();
  await expect(page.locator("#termos-aba-lembretes")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#termos-painel-lembretes")).toBeVisible();
  await expect(pendentes(page).filter({ hasText: "Conferir carregador." })).toHaveCount(1);
  await expect(page.locator("#lembretes-pendentes")).toHaveText("1");
});

test("Termo Devolução: a quebra de linha das Observações vira espaço e o POST leva origem devolucao", async ({ page }) => {
  await abrirTermo(page, "devolucao");
  await preencherDevolucao(page);
  await page.locator("#termos-devolucao-obs").fill("Carregador\ntrocado.\n\n\tRiscos na tampa.");
  const posts = postsDeLembretes(page);
  await botaoCriarLembrete(page, "devolucao").click();
  const esperado = "Saída: Maria Teste (Curitiba) devolveu HP 640 G10, série BRJ123 em 12/11/2026. "
    + "Itens: 1 - Mochila, 3 - Teclado. Obs.: Carregador trocado. Riscos na tampa.";
  await expect(descricaoCriar(page)).toHaveValue(esperado);
  await confirmarCriar(page).click();

  await expect(page.locator("#termos-status-devolucao")).toHaveText("Lembrete criado.Ver em Lembretes");
  // A cópia do termo leva as Observações como digitadas (com a quebra de linha e o tab); só a descrição é limpa.
  const termo = termoDevolucao("Carregador\ntrocado.\n\n\tRiscos na tampa.");
  expect(posts).toEqual([{ descricao: esperado, origem: "devolucao", termo }]);
  const [criado] = await apiLembretes(page);
  expect(criado).toMatchObject({ descricao: esperado, origem: "devolucao", termo });
});

// Dados do termo no lembrete: bloco recolhível, PDF da cópia salva e Preencher no Termo.
// Substitui window.print como em termos.spec.cjs: guarda título e texto da folha e não abre a janela do navegador.
async function interceptarImpressao(page) {
  await page.evaluate(() => {
    window.__impressoes = [];
    window.print = () => {
      const folha = document.getElementById("termos-impressao");
      window.__impressoes.push({ titulo: document.title, folhaFilhos: folha.childElementCount, texto: folha.textContent });
    };
  });
}
const impressoes = page => page.evaluate(() => window.__impressoes);
const esperarImpressao = (page, n = 1) => page.waitForFunction(total => window.__impressoes.length >= total, n);
const encerrarImpressao = page => page.evaluate(() => window.dispatchEvent(new Event("afterprint")));

async function criarLembreteDoTermo(page, termo, preencher, opcoes) {
  await abrirTermo(page, termo, opcoes);
  await preencher(page);
  await botaoCriarLembrete(page, termo).click();
  await confirmarCriar(page).click();
  await expect(page.locator(`#termos-status-${termo}`)).toContainText("Lembrete criado.");
}

const blocoDoTermo = page => pendentes(page).first().locator("details.lembretes__termo");
const verEmLembretes = (page, termo) => page.locator(`#termos-status-${termo}`).getByRole("button", { name: "Ver em Lembretes" }).click();
const confirmarSubstituir = async page => {
  await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Substituir o termo?");
  await expect(page.locator("#btn-confirmar-acao-ok")).toHaveText("Substituir");
  await expect(page.locator("#btn-confirmar-acao-cancelar")).toHaveText("Cancelar");
};

test("Lembrete do Termo Entrega: Dados do termo mostra os valores salvos, Gerar PDF imprime a cópia salva e Preencher no Termo devolve os dados ao formulário", async ({ page }) => {
  await criarLembreteDoTermo(page, "entrega", preencherEntrega);
  expect((await apiLembretes(page))[0].termo).toEqual(TERMO_ENTREGA);

  // O formulário muda depois de criado: o lembrete segue com a cópia salva, e é ela que o bloco e o PDF usam.
  await page.locator("#termos-entrega-nome").fill("Outro Nome");
  await page.locator("#termos-entrega-serie-entregue").fill("ZZZ999");
  await page.locator("#termos-entrega-item-02-nao").check();
  await page.locator("#termos-entrega-obs").fill("Texto alterado depois.");
  await verEmLembretes(page, "entrega");
  await expect(page.locator("#termos-painel-lembretes")).toBeVisible();

  const bloco = blocoDoTermo(page);
  await expect(bloco).toHaveJSProperty("open", false);
  await expect(bloco.locator("summary")).toHaveText("Dados do termo");
  await expect(bloco.getByRole("button", { name: "Gerar PDF" })).toBeHidden();
  await bloco.locator("summary").click();
  await expect(bloco).toHaveJSProperty("open", true);
  await expect(bloco.locator("h3")).toHaveText([
    "Dados do colaborador", "Identificação do equipamento", "Equipamentos e acessórios entregues", "Observações",
  ]);
  await expect(bloco.locator("dt")).toHaveText([
    "Nome do colaborador", "Unidade / Departamento", "Data da entrega / troca",
    "Modelo do computador, equipamento anterior", "Modelo do computador, equipamento entregue",
    "Número de série / Service Tag, equipamento anterior", "Número de série / Service Tag, equipamento entregue",
    "01 Mochila", "02 Notebook", "03 Teclado", "04 Mouse", "05 Hub USB", "06 Suporte notebook",
    "07 Headset (modelo 8225 ou 3220)", "08 Case headset", "09 Mousepad",
    "10 Monitor (HDMI / DisplayPort / Cabo de força / USB)", "11 Cabo de Segurança",
  ]);
  await expect(bloco.locator("dd")).toHaveText([
    "Maria Teste", "Curitiba", "12/11/2026", "Dell 5420", "HP 640 G11", "ANTIGA123", "NOVA456",
    "—", "Sim", "Sim", ...Array(8).fill("—"),
  ]);
  await expect(bloco.locator(".lembretes__termo-obs")).toHaveText("Sem avarias.");

  // Gerar PDF: título "<SÉRIE> - <Nome>" e folha com a cópia salva, não com o que está no formulário agora.
  await interceptarImpressao(page);
  await bloco.getByRole("button", { name: "Gerar PDF" }).click();
  await esperarImpressao(page);
  const [impressao] = await impressoes(page);
  expect(impressao.titulo).toBe("NOVA456 - Maria Teste");
  expect(impressao.folhaFilhos).toBeGreaterThan(0);
  expect(impressao.texto).toContain("Maria Teste");
  expect(impressao.texto).toContain("NOVA456");
  expect(impressao.texto).not.toContain("Outro Nome");
  expect(impressao.texto).not.toContain("ZZZ999");
  await encerrarImpressao(page);
  await expect(bloco).toHaveJSProperty("open", true);

  // Preencher no Termo: o formulário tem conteúdo, então pede confirmação e só troca ao confirmar.
  await bloco.getByRole("button", { name: "Preencher no Termo" }).click();
  await confirmarSubstituir(page);
  await expect(page.locator("#termos-aba-lembretes")).toHaveAttribute("aria-selected", "true");
  await page.locator("#btn-confirmar-acao-ok").click();

  await expect(page.locator("#termos-aba-entrega")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#termos-painel-entrega")).toBeVisible();
  await expect(page.locator("#termos-status-entrega")).toHaveText("Termo preenchido com os dados do lembrete.");
  const nome = page.locator("#termos-entrega-nome");
  await expect(nome).toHaveValue("Maria Teste");
  await expect(nome).toBeFocused();
  await expect(page.locator("#termos-entrega-unidade")).toHaveValue("Curitiba");
  await expect(page.locator("#termos-entrega-data")).toHaveValue("2026-11-12");
  await expect(page.locator("#termos-entrega-modelo-anterior")).toHaveValue("Dell 5420");
  await expect(page.locator("#termos-entrega-modelo-entregue")).toHaveValue("HP 640 G11");
  await expect(page.locator("#termos-entrega-serie-anterior")).toHaveValue("ANTIGA123");
  await expect(page.locator("#termos-entrega-serie-entregue")).toHaveValue("NOVA456");
  await expect(page.locator("#termos-entrega-item-02-sim")).toBeChecked();
  await expect(page.locator("#termos-entrega-item-02-nao")).not.toBeChecked();
  await expect(page.locator("#termos-entrega-item-03-sim")).toBeChecked();
  await expect(page.locator("#termos-entrega-item-01-sim")).not.toBeChecked();
  await expect(page.locator("#termos-entrega-obs")).toHaveValue("Sem avarias.");

  // Os campos seguem editáveis, e editar o formulário não muda o lembrete salvo.
  await expect(nome).toBeEditable();
  await nome.fill("Maria Editada");
  await expect(nome).toHaveValue("Maria Editada");
  await page.locator("#termos-entrega-item-04-sim").check();
  await expect(page.locator("#termos-entrega-item-04-sim")).toBeChecked();
  await page.locator("#termos-entrega-obs").fill("Nova observação.");
  await expect(page.locator("#termos-entrega-obs")).toHaveValue("Nova observação.");
  expect((await apiLembretes(page))[0].termo).toEqual(TERMO_ENTREGA);
});

test("Preencher no Termo: Cancelar não troca nada no formulário e fica na pílula de Lembretes", async ({ page }) => {
  await criarLembreteDoTermo(page, "entrega", preencherEntrega);
  await page.locator("#termos-entrega-nome").fill("Outro Nome");
  await page.locator("#termos-entrega-serie-entregue").fill("ZZZ999");
  await verEmLembretes(page, "entrega");
  const bloco = blocoDoTermo(page);
  await bloco.locator("summary").click();
  await bloco.getByRole("button", { name: "Preencher no Termo" }).click();
  await confirmarSubstituir(page);
  await page.locator("#btn-confirmar-acao-cancelar").click();

  await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
  await expect(page.locator("#termos-aba-lembretes")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#termos-painel-lembretes")).toBeVisible();
  await page.locator("#termos-aba-entrega").click();
  await expect(page.locator("#termos-entrega-nome")).toHaveValue("Outro Nome");
  await expect(page.locator("#termos-entrega-serie-entregue")).toHaveValue("ZZZ999");
  await expect(page.locator("#termos-status-entrega")).not.toContainText("Termo preenchido");
});

test("Preencher no Termo com o formulário vazio não pede confirmação; o termo salvo sobrevive a recarregar a página", async ({ page }) => {
  await criarLembreteDoTermo(page, "entrega", preencherEntrega);
  // Recarregar esvazia o formulário (nada do termo é guardado no navegador); o lembrete volta do servidor com o termo.
  await abrirLembretes(page, { reiniciar: false });
  await expect(pendentes(page)).toHaveCount(1);
  const bloco = blocoDoTermo(page);
  await expect(bloco).toHaveJSProperty("open", false);
  await bloco.locator("summary").click();
  await expect(bloco.locator("dd").first()).toHaveText("Maria Teste");

  await bloco.getByRole("button", { name: "Preencher no Termo" }).click();
  await expect(page.locator("#termos-aba-entrega")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#termos-status-entrega")).toHaveText("Termo preenchido com os dados do lembrete.");
  await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
  await expect(page.locator("#termos-entrega-nome")).toHaveValue("Maria Teste");
  await expect(page.locator("#termos-entrega-serie-entregue")).toHaveValue("NOVA456");
  await expect(page.locator("#termos-entrega-item-03-sim")).toBeChecked();
  await expect(page.locator("#termos-entrega-obs")).toHaveValue("Sem avarias.");
});

test("Lembrete do Termo Devolução: só as seções da devolução, Não e — formatados, PDF com a série da devolução e Preencher restaura os itens", async ({ page }) => {
  await criarLembreteDoTermo(page, "devolucao", preencherDevolucao);
  expect((await apiLembretes(page))[0].termo).toEqual(termoDevolucao());
  await abrirLembretes(page, { reiniciar: false });
  const bloco = blocoDoTermo(page);
  await bloco.locator("summary").click();

  await expect(bloco.locator("h3")).toHaveText(["Dados do colaborador", "Equipamentos e acessórios devolvidos", "Observações"]);
  await expect(bloco.locator("dt")).toHaveText([
    "Nome do colaborador", "Unidade", "Data", "Modelo do computador", "Número de série",
    "1 - Mochila", "2 - Notebook", "3 - Teclado", "4 - Mouse", "5 - Hub USB", "6 - Suporte notebook",
    "7 - Headset", "8 - Case headset (modelo 8225)", "9 - Mousepad",
    "10 - Monitor (HDMI / DisplayPort / Cabo de força / USB)", "11 - Cabo de Segurança",
  ]);
  await expect(bloco.locator("dd")).toHaveText([
    "Maria Teste", "Curitiba", "12/11/2026", "HP 640 G10", "BRJ123", "Sim", "Não", "Sim", ...Array(8).fill("—"),
  ]);
  await expect(bloco.locator(".lembretes__termo-obs")).toHaveText("—"); // Observações vazias viram —

  await interceptarImpressao(page);
  await bloco.getByRole("button", { name: "Gerar PDF" }).click();
  await esperarImpressao(page);
  expect((await impressoes(page))[0].titulo).toBe("BRJ123 - Maria Teste");
  await encerrarImpressao(page);

  await bloco.getByRole("button", { name: "Preencher no Termo" }).click();
  await expect(page.locator("#termos-aba-devolucao")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#termos-devolucao-nome")).toHaveValue("Maria Teste");
  await expect(page.locator("#termos-devolucao-modelo")).toHaveValue("HP 640 G10");
  await expect(page.locator("#termos-devolucao-serie")).toHaveValue("BRJ123");
  await expect(page.locator("#termos-devolucao-item-01-sim")).toBeChecked();
  await expect(page.locator("#termos-devolucao-item-02-nao")).toBeChecked();
  await expect(page.locator("#termos-devolucao-item-02-sim")).not.toBeChecked();
  await expect(page.locator("#termos-devolucao-item-03-sim")).toBeChecked();
  await expect(page.locator("#termos-devolucao-item-04-sim")).not.toBeChecked();
  await expect(page.locator("#termos-devolucao-item-04-nao")).not.toBeChecked();
});

test("lembrete criado à mão não tem o bloco Dados do termo; o do termo tem, e o bloco aberto continua aberto ao adicionar outro", async ({ page }) => {
  await criarLembreteDoTermo(page, "devolucao", preencherDevolucao);
  await verEmLembretes(page, "devolucao");
  const bloco = blocoDoTermo(page);
  await bloco.locator("summary").click();
  await expect(bloco).toHaveJSProperty("open", true);

  await adicionarPelaTela(page, "Lembrete escrito à mão");
  await expect(pendentes(page)).toHaveCount(2);
  await expect(pendentes(page).filter({ hasText: "Lembrete escrito à mão" }).locator("details.lembretes__termo")).toHaveCount(0);
  await expect(page.locator("details.lembretes__termo")).toHaveCount(1);
  // A lista foi redesenhada com o novo item: o bloco que estava aberto segue aberto.
  await expect(pendentes(page).filter({ has: page.locator("details.lembretes__termo") }).locator("details.lembretes__termo")).toHaveJSProperty("open", true);
});

test("Criar lembrete: quebra de linha digitada no diálogo também é limpa antes do POST", async ({ page }) => {
  await abrirTermo(page, "devolucao");
  await preencherDevolucao(page);
  await botaoCriarLembrete(page, "devolucao").click();
  await descricaoCriar(page).fill("Primeira linha\nSegunda linha");
  await confirmarCriar(page).click();
  await expect(page.locator("#termos-status-devolucao")).toContainText("Lembrete criado.");
  expect((await apiLembretes(page)).map(l => l.descricao)).toEqual(["Primeira linha Segunda linha"]);
});

test("Criar lembrete: acima de 2000 caracteres desabilita o botão e mostra o aviso; nada é cortado", async ({ page }) => {
  await abrirTermo(page, "devolucao");
  await preencherDevolucao(page);
  await page.locator("#termos-devolucao-obs").fill("o".repeat(2100));
  await botaoCriarLembrete(page, "devolucao").click();
  await expect(dialogoCriar(page)).toBeVisible();
  // O texto montado não é cortado: passa de 2000 e o botão fica desligado.
  expect((await descricaoCriar(page).inputValue()).length).toBeGreaterThan(2000);
  await expect(confirmarCriar(page)).toBeDisabled();
  await expect(page.locator("#lembretes-criar-erro")).toHaveText("A descrição pode ter até 2000 caracteres.");
  expect(await apiLembretes(page)).toEqual([]);

  await descricaoCriar(page).fill("a".repeat(2000));
  await expect(confirmarCriar(page)).toBeEnabled();
  await expect(page.locator("#lembretes-criar-erro")).toBeHidden();
  await descricaoCriar(page).fill("a".repeat(2001));
  await expect(confirmarCriar(page)).toBeDisabled();
  await descricaoCriar(page).fill("   ");
  await expect(confirmarCriar(page)).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(await apiLembretes(page)).toEqual([]);
});

test("Criar lembrete: falha ao gravar mantém o diálogo aberto com o texto", async ({ page }) => {
  await abrirTermo(page, "entrega");
  await preencherEntrega(page);
  await page.route("**/api/lembretes", route => route.request().method() === "POST"
    ? route.fulfill({ status: 503, json: { detail: "Aviso de teste: gravação indisponível.", codigo: "lembretes_gravacao" } })
    : route.fallback());
  await botaoCriarLembrete(page, "entrega").click();
  const texto = await descricaoCriar(page).inputValue();
  await confirmarCriar(page).click();
  await expect(page.getByText("Aviso de teste: gravação indisponível.")).toBeVisible();
  await expect(dialogoCriar(page)).toBeVisible();
  await expect(descricaoCriar(page)).toHaveValue(texto);
  await expect(confirmarCriar(page)).toBeEnabled();
  await expect(page.locator("#termos-status-entrega")).toHaveText("");
  expect(await apiLembretes(page)).toEqual([]);
});

test("Criar lembrete cabe em 320px sem rolagem horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await abrirTermo(page, "entrega");
  await preencherEntrega(page);
  await botaoCriarLembrete(page, "entrega").click();
  await expect(dialogoCriar(page)).toBeVisible();
  const medidas = await page.evaluate(() => {
    const raiz = document.documentElement;
    const caixa = document.querySelector("#lembretes-criar > .ck-dialogo").getBoundingClientRect();
    return { janela: raiz.clientWidth, documento: raiz.scrollWidth, direita: caixa.right, esquerda: caixa.left };
  });
  expect(medidas.documento).toBeLessThanOrEqual(medidas.janela);
  expect(medidas.direita).toBeLessThanOrEqual(medidas.janela);
  expect(medidas.esquerda).toBeGreaterThanOrEqual(0);
});

test("editar um item e concluir outro não apaga o texto ainda não salvo", async ({ page }) => {
  await abrirLembretes(page);
  await adicionarPelaTela(page, "Item A");
  await adicionarPelaTela(page, "Item B");
  await pendentes(page).filter({ hasText: "Item A" }).getByRole("button", { name: "Editar lembrete" }).click();
  await campoEdicao(page).fill("Item A revisado");
  await page.getByRole("button", { name: "Concluir: Item B" }).click();
  await expect(concluidos(page)).toHaveCount(1);
  await expect(campoEdicao(page)).toHaveValue("Item A revisado");
  expect((await apiLembretes(page)).find(l => l.descricao === "Item A")).toBeTruthy();
});

// ----- Chamado e OS no texto: o número vira link e abre a janela Chamado × OS (#modal-chamado-os), só leitura -----
// Dados sintéticos. A fixture tem a OS 7285070 (série DEMO-SN-001) no relatório da aba OS e, no F5, os chamados
// UTIC-2026-1378 (OS 7303022, fora do relatório), UTIC-2026-1336 (sem OS) e UTIC-2026-1200. Vínculos e ajustes do F5 vêm só
// de page.route: nada é gravado no servidor da fixture.
const OS_RELATORIO = "7285070";
const OS_INEXISTENTE = "1234567";
const janelaChamadoOs = page => page.locator("#modal-chamado-os");
const ladoChamado = page => page.locator("#chamado-os-janela-chamado");
const ladoOs = page => page.locator("#chamado-os-janela-os");
const ladosVisiveis = page => page.locator("#modal-chamado-os .chamado-os-janela__lado:visible");
const linhaDaOs = page => ladoOs(page).locator('tbody tr[data-serial="DEMO-SN-001"]');
const cartaoDoChamado = page => ladoChamado(page).locator("article.sebrae-chamado");
const linkChamado = (page, numero) => page.getByRole("button", { name: `Abrir o chamado ${numero} na janela Chamado × OS` });
const linkOs = (page, numero) => page.getByRole("button", { name: `Abrir a OS ${numero} na janela Chamado × OS` });
const vinculoSalvo = (chamado, os = OS_RELATORIO) => ({ fonte: "oracle", serie: "DEMO-SN-001", os, ano: 2026, numero: chamado.slice(-4), chamado });

async function simularVinculos(page, vinculos) {
  const leituras = { total: 0 };
  await page.route("**/api/operacoes/chamados/vinculos-os", route => {
    if (route.request().method() !== "GET") return route.fallback();
    leituras.total += 1;
    return route.fulfill({ json: { vinculos } });
  });
  return leituras;
}

async function simularSebrae(page, ajustar) {
  await page.route("**/api/sebrae/novos", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const dados = await (await route.fetch()).json();
    ajustar(dados);
    await route.fulfill({ json: dados });
  });
}

// O chamado UTIC-2026-1378 passa a ter a OS que existe no relatório da aba OS.
const chamado1378ComOsDoRelatorio = dados => { dados.novos.formulario[0].linha.E = OS_RELATORIO; };

// Chame depois dos page.route do teste: o goto de abrirLembretes já dispara as leituras.
async function abrirComLembrete(page, descricao) {
  expect((await page.request.get("/__fixture_lembretes?itens=0")).ok()).toBeTruthy();
  expect((await page.request.post("/api/lembretes", { data: { descricao } })).ok()).toBeTruthy();
  await abrirLembretes(page, { reiniciar: false });
}

async function clicarEEsperarJanela(page, link) {
  await link.click();
  await expect(janelaChamadoOs(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Chamado × OS" })).toBeVisible();
}

test("link de chamado com OS no cartão do F5: abre o cartão do chamado e a OS dele lado a lado", async ({ page }, testInfo) => {
  await simularVinculos(page, []);
  await simularSebrae(page, chamado1378ComOsDoRelatorio);
  await abrirComLembrete(page, "Conferir UTIC-2026-1378 com o cliente");
  await clicarEEsperarJanela(page, linkChamado(page, "UTIC-2026-1378"));
  await expect(cartaoDoChamado(page)).toContainText("UTIC-2026-1378");
  await expect(linhaDaOs(page)).toContainText(OS_RELATORIO);
  await expect(ladoOs(page)).not.toContainText("Carregando…");
  await expect(ladosVisiveis(page)).toHaveCount(2);
  await expect(page.locator("#chamado-os-janela-f6")).toBeVisible();
  if (testInfo.project.name === "desktop") {
    // Acima de 900px os dois lados dividem a mesma linha; abaixo disso empilham.
    const [esquerda, direita] = [await ladoChamado(page).boundingBox(), await ladoOs(page).boundingBox()];
    expect(direita.x).toBeGreaterThan(esquerda.x + esquerda.width - 1);
    expect(Math.abs(direita.y - esquerda.y)).toBeLessThan(8);
  }
});

test("link de chamado sem OS no cartão e sem vínculo: avisa à direita que não há OS", async ({ page }) => {
  await simularVinculos(page, []);
  await abrirComLembrete(page, "Ver UTIC-2026-1336");
  await clicarEEsperarJanela(page, linkChamado(page, "UTIC-2026-1336"));
  await expect(cartaoDoChamado(page)).toContainText("UTIC-2026-1336");
  await expect(ladoOs(page)).toHaveText("Nenhuma OS vinculada por série na importação atual.");
  await expect(ladosVisiveis(page)).toHaveCount(2);
  await expect(page.locator("#chamado-os-janela-f6")).toBeHidden();
});

test("link de chamado sem OS no cartão, mas com vínculo salvo: mostra a OS do vínculo", async ({ page }) => {
  await simularVinculos(page, [vinculoSalvo("UTIC-2026-1336")]);
  await abrirComLembrete(page, "Ver UTIC-2026-1336");
  await clicarEEsperarJanela(page, linkChamado(page, "UTIC-2026-1336"));
  await expect(cartaoDoChamado(page)).toContainText("UTIC-2026-1336");
  await expect(linhaDaOs(page)).toContainText(OS_RELATORIO);
  await expect(ladoOs(page)).not.toContainText(/Nenhuma OS vinculada|Carregando…/);
  await expect(ladosVisiveis(page)).toHaveCount(2);
  await expect(page.locator("#chamado-os-janela-f6")).toBeVisible();
});

test("link de OS ligada a um chamado por vínculo salvo: mostra o cartão do chamado e a OS", async ({ page }) => {
  await simularVinculos(page, [vinculoSalvo("UTIC-2026-1378")]);
  await abrirComLembrete(page, `Verificar a OS ${OS_RELATORIO} hoje`);
  await clicarEEsperarJanela(page, linkOs(page, OS_RELATORIO));
  await expect(cartaoDoChamado(page)).toContainText("UTIC-2026-1378");
  await expect(linhaDaOs(page)).toContainText(OS_RELATORIO);
  await expect(ladosVisiveis(page)).toHaveCount(2);
});

test("link de OS sem vínculo: o chamado vem dos chamados abertos do F5", async ({ page }) => {
  await simularVinculos(page, []);
  await simularSebrae(page, chamado1378ComOsDoRelatorio);
  await abrirComLembrete(page, `Verificar a OS ${OS_RELATORIO} hoje`);
  await clicarEEsperarJanela(page, linkOs(page, OS_RELATORIO));
  await expect(cartaoDoChamado(page)).toContainText("UTIC-2026-1378");
  await expect(linhaDaOs(page)).toContainText(OS_RELATORIO);
  await expect(ladosVisiveis(page)).toHaveCount(2);
});

test("link de OS sem chamado: só o lado da OS fica visível", async ({ page }) => {
  await simularVinculos(page, []);
  await abrirComLembrete(page, `Verificar a OS ${OS_RELATORIO} hoje`);
  await clicarEEsperarJanela(page, linkOs(page, OS_RELATORIO));
  await expect(linhaDaOs(page)).toContainText(OS_RELATORIO);
  await expect(ladoChamado(page)).toBeHidden();
  await expect(ladosVisiveis(page)).toHaveCount(1);
});

test("link de OS ligada a dois chamados na mesma prioridade: avisa da ambiguidade e mostra a OS", async ({ page }) => {
  await simularVinculos(page, [vinculoSalvo("UTIC-2026-1378"), vinculoSalvo("UTIC-2026-1379")]);
  await abrirComLembrete(page, `Verificar a OS ${OS_RELATORIO} hoje`);
  await clicarEEsperarJanela(page, linkOs(page, OS_RELATORIO));
  await expect(ladoChamado(page)).toContainText("OS ligada a mais de um chamado (UTIC-2026-1378, UTIC-2026-1379).");
  await expect(cartaoDoChamado(page)).toHaveCount(0);
  await expect(linhaDaOs(page)).toContainText(OS_RELATORIO);
  await expect(ladosVisiveis(page)).toHaveCount(2);
});

test("link de chamado inexistente: avisa que não achou e o lado da OS fica oculto", async ({ page }) => {
  const vinculos = await simularVinculos(page, []);
  await abrirComLembrete(page, "Ver UTIC-2026-9999");
  await clicarEEsperarJanela(page, linkChamado(page, "UTIC-2026-9999"));
  await expect(ladoChamado(page)).toContainText("Chamado não encontrado na aba Chamados (F5).");
  await expect.poll(() => vinculos.total).toBeGreaterThan(0); // o vínculo salvo já foi consultado
  await page.waitForTimeout(300); // prova de ausência: se o lado da OS fosse se preencher, já teria acontecido
  await expect(ladoOs(page)).toBeHidden();
  await expect(ladosVisiveis(page)).toHaveCount(1);
  await expect(page.locator("#chamado-os-janela-f6")).toBeHidden();
});

test("link de OS inexistente: avisa que a OS não está na importação e o lado do chamado fica oculto", async ({ page }) => {
  await simularVinculos(page, []);
  await abrirComLembrete(page, `Cobrar a OS ${OS_INEXISTENTE}`);
  await clicarEEsperarJanela(page, linkOs(page, OS_INEXISTENTE));
  await expect(ladoOs(page)).toContainText("OS não encontrada na importação atual.");
  await expect(ladoOs(page).locator("tbody tr")).toHaveCount(0);
  await expect(ladoChamado(page)).toBeHidden();
  await expect(ladosVisiveis(page)).toHaveCount(1);
});

test("vários números no mesmo lembrete: cada número vira link e a data dd/mm/aaaa não", async ({ page }) => {
  const descricao = `Chamados UTIC-2026-0833 e UTIC-2026-1378, OS ${OS_INEXISTENTE} e 7654321, prazo 12/11/2026.`;
  await abrirComLembrete(page, descricao);
  const item = pendentes(page).first();
  const links = item.locator("button.lembretes__ref");
  await expect(links).toHaveText(["UTIC-2026-0833", "UTIC-2026-1378", OS_INEXISTENTE, "7654321"]);
  const nomes = await links.evaluateAll(botoes => botoes.map(botao => botao.getAttribute("aria-label")));
  expect(nomes).toEqual([
    "Abrir o chamado UTIC-2026-0833 na janela Chamado × OS",
    "Abrir o chamado UTIC-2026-1378 na janela Chamado × OS",
    `Abrir a OS ${OS_INEXISTENTE} na janela Chamado × OS`,
    "Abrir a OS 7654321 na janela Chamado × OS",
  ]);
  // A data fica como texto puro e o texto do lembrete segue inteiro.
  await expect(links).toHaveCount(4); // só os 4 números; nenhum pedaço da data virou link
  await expect(item.locator(".lembretes__texto")).toHaveText(descricao);
  expect((await apiLembretes(page)).map(l => l.descricao)).toEqual([descricao]);
});

test("Esc fecha a janela do link e o foco volta ao link", async ({ page }) => {
  await simularVinculos(page, []);
  await simularSebrae(page, chamado1378ComOsDoRelatorio);
  await abrirComLembrete(page, "Conferir UTIC-2026-1378 com o cliente");
  const link = linkChamado(page, "UTIC-2026-1378");
  await clicarEEsperarJanela(page, link);
  await expect(linhaDaOs(page)).toContainText(OS_RELATORIO);
  await page.keyboard.press("Escape");
  await expect(janelaChamadoOs(page)).toBeHidden();
  await expect(link).toBeFocused();
  await expect(page.locator('[data-cockpit-tool-panel="lembretes"]')).toBeVisible(); // o Esc fecha só a janela
});

test("clicar no link não abre a edição do lembrete nem o conclui", async ({ page }) => {
  await simularVinculos(page, []);
  await abrirComLembrete(page, "Conferir UTIC-2026-1378 com o cliente");
  const alteracoes = [];
  page.on("request", requisicao => {
    if (["PATCH", "PUT", "DELETE"].includes(requisicao.method()) && requisicao.url().includes("/api/lembretes")) alteracoes.push(requisicao.method());
  });
  await clicarEEsperarJanela(page, linkChamado(page, "UTIC-2026-1378"));
  await page.keyboard.press("Escape");
  await expect(janelaChamadoOs(page)).toBeHidden();
  await expect(page.locator("#lembretes-lista textarea")).toHaveCount(0);
  await expect(campoEdicao(page)).toHaveCount(0);
  await expect(pendentes(page)).toHaveCount(1);
  await expect(page.locator("#lembretes-pendentes")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Concluir: Conferir UTIC-2026-1378 com o cliente" })).toBeVisible();
  expect(alteracoes).toEqual([]);
  expect(await apiLembretes(page)).toMatchObject([{ descricao: "Conferir UTIC-2026-1378 com o cliente", concluido: false }]);
});

test("320px: a janela aberta pelo link não causa rolagem horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await simularVinculos(page, []);
  await simularSebrae(page, chamado1378ComOsDoRelatorio);
  await abrirComLembrete(page, "Conferir UTIC-2026-1378 com o cliente");
  await clicarEEsperarJanela(page, linkChamado(page, "UTIC-2026-1378"));
  await expect(cartaoDoChamado(page)).toContainText("UTIC-2026-1378");
  await expect(linhaDaOs(page)).toContainText(OS_RELATORIO);
  const medidas = await page.evaluate(() => {
    const raiz = document.documentElement;
    const caixa = document.querySelector("#modal-chamado-os > .ck-dialogo").getBoundingClientRect();
    return { janela: raiz.clientWidth, documento: raiz.scrollWidth, pagina: document.body.scrollWidth, esquerda: caixa.left, direita: caixa.right };
  });
  expect(medidas.documento).toBeLessThanOrEqual(medidas.janela);
  expect(medidas.pagina).toBeLessThanOrEqual(medidas.janela);
  expect(medidas.esquerda).toBeGreaterThanOrEqual(0);
  expect(medidas.direita).toBeLessThanOrEqual(medidas.janela);
});
