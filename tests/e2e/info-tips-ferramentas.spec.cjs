const { test, expect } = require("@playwright/test");

// Limpeza dos textos explicativos, Bloco 3 (Ferramentas: Lembretes, Termos, Planilhas e Conflitos do Dashboard do Sebrae):
// o texto sai da tela e fica num ⓘ (.info-tip) escondido até o mouse, o toque ou o foco; Esc fecha só o balão.
// Só a fixture (porta 8765).

async function abrirLembretes(page) {
  expect((await page.request.get("/__fixture_lembretes?itens=0")).ok()).toBeTruthy();
  await page.goto("/");
  const menu = page.locator("#cockpit-tools-dropdown");
  if (!(await menu.evaluate(no => no.open))) await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-lembretes").click();
  await expect(page.locator("#termos-painel-lembretes")).toBeVisible();
}

async function abrirTermo(page, termo) {
  await abrirLembretes(page);
  await page.locator(`#termos-aba-${termo}`).click();
  await expect(page.locator(`#termos-painel-${termo}`)).toBeVisible();
}

// Abre o painel Chamados (F5) da fixture; `extra` entra em run= (por exemplo &conflitos=1).
async function abrirPainelSebrae(page, request, extra = "") {
  await request.get(`/__fixture_automacao?quantidade=0&sebrae=padrao&run=${extra}&antigos=`);
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const cartao = page.locator("#sebrae-novos-painel");
  await expect(cartao).toBeVisible();
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("novo(s)");
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  return painel;
}

// No celular o balão é fixed e, com o ⓘ abaixo da dobra, podia abrir fora da tela sem que toBeVisible reclamasse:
// confere que ele cabe na janela e que o centro dele recebe o clique (nada por cima).
async function balaoNaJanelaEPorCima(balao) {
  await expect.poll(() => balao.evaluate(no => {
    const c = no.getBoundingClientRect();
    const dentro = c.left >= -1 && c.top >= -1 && c.right <= innerWidth + 1 && c.bottom <= innerHeight + 1;
    const topo = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    return dentro && Boolean(topo && no.contains(topo));
  })).toBe(true);
}

// Mouse no desktop, toque no mobile; o balão aparece (no mobile, também dentro da janela).
async function abrirComMouseOuToque(trigger, balao, testInfo) {
  await expect(balao).toBeHidden();
  const toque = testInfo.project.use.hasTouch;
  if (toque) await trigger.tap();
  else await trigger.hover();
  await expect(balao).toBeVisible();
  if (toque) await balaoNaJanelaEPorCima(balao);
}

// Foco pelo teclado abre; o primeiro Esc fecha só o balão (o painel ou o diálogo continua) e o foco fica no ⓘ.
async function focoEscFechaSoOBalao(page, trigger, balao, contexto) {
  await trigger.focus();
  await expect(balao).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(balao).toBeHidden();
  await expect(contexto).toBeVisible();
  await expect(trigger).toBeFocused();
}

// O balão traz o texto exato, o botão descreve a si mesmo e `aria-describedby` aponta para o balão; depois testa mouse/toque e foco/Esc.
async function conferirDica(page, { trigger, balao, texto, rotulo, contexto }, testInfo) {
  await expect(balao).toHaveText(texto);
  await expect(trigger).toHaveAttribute("aria-label", rotulo);
  await expect(trigger).toHaveAttribute("aria-describedby", await balao.getAttribute("id"));
  await abrirComMouseOuToque(trigger, balao, testInfo);
  await page.mouse.move(0, 0);
  await focoEscFechaSoOBalao(page, trigger, balao, contexto);
}

const PDF = "Na janela que abrir, escolha Salvar como PDF e a pasta.";

test("Lembretes: o estado vazio é uma linha curta e a dica de Criar lembrete fica no ⓘ do rótulo Descrição", async ({ page }, testInfo) => {
  await abrirLembretes(page);
  await expect(page.locator("#lembretes-vazio")).toHaveText("Nenhum lembrete.");
  await expect(page.locator("#lembretes-vazio")).toBeVisible();

  await page.locator('#termos-aba-entrega').click();
  await page.locator("#termos-entrega-nome").fill("Maria Teste");
  await page.locator("#termos-entrega-serie-entregue").fill("NOVA456");
  await page.locator("#termos-painel-entrega").getByRole("button", { name: "Criar lembrete" }).click();
  const dialogo = page.locator("#lembretes-criar");
  await expect(dialogo).toBeVisible();
  const rotulo = dialogo.locator(".ck-rotulo-info");
  await expect(rotulo.locator("label")).toHaveText("Descrição");
  await expect(rotulo.locator("label")).toBeVisible();
  // A dica deixou de ser um parágrafo: só existe o balão, e a caixa de texto ainda a cita em aria-describedby.
  await expect(dialogo.locator("p.lembretes__dica")).toHaveCount(0);
  await expect(page.locator("#lembretes-criar-descricao")).toHaveAttribute("aria-describedby", "lembretes-criar-dica lembretes-criar-erro");
  // O diálogo corta o que passa das bordas (overflow-x: hidden): o balão aberto tem de caber nele.
  await rotulo.locator(".info-tip-trigger").focus();
  const caixa = await page.locator("#lembretes-criar-dica").boundingBox();
  const moldura = await dialogo.locator(".lembretes__dialogo").boundingBox();
  expect(caixa.x).toBeGreaterThanOrEqual(moldura.x);
  expect(caixa.x + caixa.width).toBeLessThanOrEqual(moldura.x + moldura.width);
  // No celular o balão fixo cai onde o último toque ficou; tira o mouse de cima dele para só o foco o manter aberto.
  await page.mouse.move(0, 0);
  await page.locator("#lembretes-criar-descricao").focus();
  await conferirDica(page, {
    trigger: rotulo.locator(".info-tip-trigger"),
    balao: page.locator("#lembretes-criar-dica"),
    texto: "Texto montado com os dados do termo. Revise antes de criar.",
    rotulo: "Sobre a descrição",
    contexto: dialogo,
  }, testInfo);
});

test("Termo Entrega: dicas dos itens e das observações ficam no ⓘ da legenda e o aviso do PDF no ⓘ de Gerar PDF", async ({ page }, testInfo) => {
  await abrirTermo(page, "entrega");
  const painel = page.locator("#termos-painel-entrega");
  await expect(painel.locator(".termos__dica, .termos__aviso")).toHaveCount(0);

  // A legenda continua sendo o nome do grupo (o ⓘ não entra no nome acessível).
  const itens = painel.getByRole("group", { name: "Equipamentos e acessórios entregues", exact: true });
  await expect(itens).toBeVisible();
  await conferirDica(page, {
    trigger: itens.locator("legend .info-tip-trigger"),
    balao: painel.locator("#termos-entrega-itens-dica"),
    texto: "Assinale Sim ou Não para cada item apresentado no ato da entrega.",
    rotulo: "Sobre os itens entregues",
    contexto: painel,
  }, testInfo);

  const obs = painel.getByRole("group", { name: "Observações", exact: true });
  await expect(obs).toBeVisible();
  await expect(painel.locator("#termos-entrega-obs")).toHaveAttribute("aria-describedby", "termos-entrega-obs-dica");
  await conferirDica(page, {
    trigger: obs.locator("legend .info-tip-trigger"),
    balao: painel.locator("#termos-entrega-obs-dica"),
    texto: "Registre avarias no equipamento anterior ou itens pendentes.",
    rotulo: "Sobre as observações",
    contexto: painel,
  }, testInfo);

  await expect(painel.getByRole("button", { name: "Gerar PDF", exact: true })).toBeVisible();
  // getByRole casa por trecho do nome: o ⓘ ("Sobre o PDF") não pode virar um segundo botão "Gerar PDF" (quebrava termos.spec.cjs).
  await expect(painel.getByRole("button", { name: "Gerar PDF" })).toHaveCount(1);
  await conferirDica(page, {
    trigger: painel.locator(".termos__acoes .info-tip-trigger"),
    balao: painel.locator("#termos-pdf-dica-entrega"),
    texto: PDF,
    rotulo: "Sobre o PDF",
    contexto: painel,
  }, testInfo);
  // O estado do PDF (role=status) continua na tela.
  await expect(painel.locator("#termos-status-entrega")).toHaveAttribute("role", "status");
});

test("Termo Devolução: o aviso do PDF fica no ⓘ de Gerar PDF e as Observações não ganham ⓘ", async ({ page }, testInfo) => {
  await abrirTermo(page, "devolucao");
  const painel = page.locator("#termos-painel-devolucao");
  await expect(painel.locator(".termos__dica, .termos__aviso")).toHaveCount(0);
  await expect(painel.locator("legend .info-tip")).toHaveCount(0);
  await expect(painel.getByRole("button", { name: "Gerar PDF" })).toHaveCount(1);
  await conferirDica(page, {
    trigger: painel.locator(".termos__acoes .info-tip-trigger"),
    balao: painel.locator("#termos-pdf-dica-devolucao"),
    texto: PDF,
    rotulo: "Sobre o PDF",
    contexto: painel,
  }, testInfo);
});

test("Planilhas: os três passos de Ao atualizar vão para o ⓘ ao lado do título", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.evaluate(() => window.abrirPainelCockpit("planilhas"));
  const painel = page.locator('[data-cockpit-tool-panel="planilhas"]');
  await expect(painel).toBeVisible();
  const detalhe = painel.locator("#cockpit-sheets-detail");
  await expect(detalhe.getByRole("heading", { name: "Ao atualizar", exact: true })).toBeVisible();
  await expect(detalhe.locator("ol.ck-tempo")).toHaveCount(0);
  // O subtítulo do detalhe (arquivo da planilha) e o botão continuam visíveis.
  await expect(detalhe.locator("#cockpit-sheets-detail-sub")).toBeVisible();
  await expect(detalhe.locator("#cockpit-sheets-submit")).toBeVisible();
  const trigger = detalhe.locator(".ck-rotulo-info .info-tip-trigger");
  const balao = detalhe.locator("#cockpit-sheets-passos-dica");

  // Com o balão aberto: de 1200px em diante a coluna do detalhe rola e cortaria o balão; ele tem de caber na coluna e na tela, sem cortes.
  await trigger.focus();
  await expect(balao).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const c = document.querySelector("#cockpit-sheets-passos-dica").getBoundingClientRect();
    // Pontos perto de cada borda do balão ainda caem dentro dele (nada o corta por cima do resto).
    return [[c.left + 3, c.top + 3], [c.right - 3, c.top + 3], [c.left + 3, c.bottom - 3], [c.right - 3, c.bottom - 3]]
      .every(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest("#cockpit-sheets-passos-dica")));
  })).toBe(true);
  const caixa = await balao.boundingBox();
  const coluna = await detalhe.boundingBox();
  const largura = await page.evaluate(() => document.documentElement.clientWidth);
  expect(caixa.x).toBeGreaterThanOrEqual(0);
  expect(caixa.x + caixa.width).toBeLessThanOrEqual(largura);
  if (largura >= 1200) {
    expect(caixa.x).toBeGreaterThanOrEqual(coluna.x);
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(coluna.x + coluna.width);
  }
  expect(await detalhe.evaluate(no => no.scrollWidth <= no.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.evaluate(() => document.activeElement.blur());
  await page.mouse.move(0, 0);

  await conferirDica(page, {
    trigger,
    balao,
    texto: "1. A planilha é importada e substitui a versão atual. 2. A comparação com o Endpoint é refeita. 3. O resultado entra no histórico do Resumo.",
    rotulo: "Sobre Ao atualizar",
    contexto: painel,
  }, testInfo);
});

test("Conflitos do Dashboard: a ajuda fica no ⓘ ao lado do título, que continua dando nome à seção", async ({ page, request }, testInfo) => {
  await page.route("**/api/automacao/estado*", route => route.fulfill({ json: { estado: "livre", rotina: "", ultima: { status: "concluido" } } }));
  const painel = await abrirPainelSebrae(page, request, "&conflitos=1");
  const secao = painel.locator("#sebrae-conflitos");
  await expect(secao).toBeVisible();
  // Status de envio (regra E): "Nada foi enviado." continua visível; o resto da ajuda foi para o ⓘ.
  await expect(secao.locator("p.ck-campo__ajuda")).toBeVisible();
  await expect(secao.locator("p.ck-campo__ajuda")).toHaveText("Nada foi enviado.");
  await expect(secao).toHaveAttribute("aria-labelledby", "sebrae-conflitos-titulo");
  await expect(secao.locator("#sebrae-conflitos-titulo .info-tip")).toHaveCount(0); // o ⓘ é irmão do título: não entra no nome da seção
  await expect(page.getByRole("region", { name: "Conflitos de edição no Dashboard", exact: true })).toBeVisible();
  // O que decide a ação continua à vista: um grupo por célula, o botão e o estado.
  await expect(secao.getByRole("group")).toHaveCount(3);
  await expect(secao.locator("#sebrae-conflitos-status")).toHaveText("Escolha uma opção em cada célula (faltam 3).");
  await conferirDica(page, {
    trigger: secao.locator(".ck-rotulo-info .info-tip-trigger"),
    balao: secao.locator("#sebrae-conflitos-dica"),
    texto: "Estas células mudaram no SharePoint e também no site. Escolha qual valor manter em cada uma e reenvie.",
    rotulo: "Sobre os conflitos de edição",
    contexto: painel,
  }, testInfo);
});

test("Chamados antigos: o vazio da aba é uma linha curta", async ({ page, request }) => {
  await page.route("**/api/sebrae/novos", async route => {
    const resposta = await route.fetch();
    const dados = await resposta.json();
    dados.importado.abertos = [];
    await route.fulfill({ response: resposta, json: dados });
  });
  const painel = await abrirPainelSebrae(page, request);
  await expect(painel.locator("#sebrae-antigos-resumo")).toHaveText("Nenhum chamado antigo em aberto ou sem status.");
});
