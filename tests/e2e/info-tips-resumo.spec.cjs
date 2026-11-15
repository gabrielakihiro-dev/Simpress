const { test, expect } = require("@playwright/test");

// Limpeza dos textos explicativos, Bloco 2 (Resumo F3, Comparação e Backups regionais; o Relatório mensal está em monthly-report.spec.cjs):
// o texto sai da tela e fica num ⓘ (.info-tip) escondido até o mouse, o toque ou o foco; Esc fecha só o balão.
// Só a fixture (porta 8765).

const PAINEL_RESUMO = '[data-cockpit-tool-panel="comparacao"]';
const CONTEUDO = "#comparacao-planilhas-conteudo";

async function zerarFixture(request) {
  await request.get("/__fixture_cockpit?comparacao=0");
  await request.get("/__fixture_alertas_painel?estado=ocultos");
  await request.get("/__fixture_base_desatualizada?estado=atualizada");
  await request.get("/__fixture_backups?estado=padrao");
}

test.beforeEach(({ request }) => zerarFixture(request));
test.afterEach(({ request }) => zerarFixture(request));

async function abrirResumo(page, aba) {
  await page.goto("/");
  await page.locator("#btn-resumo-aba").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Resumo");
  await expect(page.locator(CONTEUDO)).toHaveAttribute("data-estado", /^(pronto|vazio|erro)$/);
  await expect(page.locator("#resumo-regionais")).toHaveAttribute("data-estado", /^(pronto|erro)$/);
  await expect(page.locator("#resumo-backups-contagem")).toHaveText(/^\d+$/);
  await page.locator(`#resumo-aba-${aba}`).click();
  await expect(page.locator(`#resumo-painel-${aba}`)).toBeVisible();
}

// Mouse no desktop, toque no mobile; o balão aparece e traz o texto exato.
async function abrirComMouseOuToque(trigger, balao, testInfo) {
  await expect(balao).toBeHidden();
  if (testInfo.project.use.hasTouch) await trigger.tap();
  else await trigger.hover();
  await expect(balao).toBeVisible();
}

// Foco pelo teclado abre; o primeiro Esc fecha só o balão (o painel continua) e o foco fica no ⓘ.
async function focoEscFechaSoOBalao(page, trigger, balao, painel) {
  await trigger.focus();
  await expect(balao).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(balao).toBeHidden();
  await expect(painel).toBeVisible();
  await expect(trigger).toBeFocused();
}

test("Comparação (Resumo): descrição da seção fica no ⓘ ao lado do título e a dica de rolagem some", async ({ page, request }, testInfo) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  await abrirResumo(page, "sem-acesso");
  const titulo = page.locator("#comparacao-secao-sem-acesso-7");
  const dica = page.locator(`${CONTEUDO} .ck-bento-ancora:has(> #comparacao-secao-sem-acesso-7) .info-tip`);
  const trigger = dica.locator(".info-tip-trigger");
  const balao = dica.locator(".info-tip-text");
  await expect(titulo).toBeVisible();
  await expect(balao).toHaveText("Notebooks cuja última verificação com êxito ocorreu há 7 dias ou mais, contados a partir desta atualização.");
  await expect(trigger).toHaveAttribute("aria-label", "Sobre Sem acesso há 7 dias ou mais");
  await expect(trigger).toHaveAttribute("aria-describedby", await balao.getAttribute("id"));
  await expect(page.locator(`${CONTEUDO} .comparison-table-scroll-hint`)).toHaveCount(0);
  // O título continua sendo o alvo do foco (id e tabindex no h4); o ⓘ (24px) não estica a linha até os 40px do botão padrão.
  await expect(titulo).toHaveAttribute("tabindex", "-1");
  expect(await dica.evaluate(no => no.parentElement.getBoundingClientRect().height)).toBeLessThanOrEqual(28);

  await abrirComMouseOuToque(trigger, balao, testInfo);
  await page.mouse.move(0, 0);
  await focoEscFechaSoOBalao(page, trigger, balao, page.locator(PAINEL_RESUMO));
});

test("Backups: só o mínimo por regional vai para o ⓘ; Atualizado em fica visível", async ({ page }, testInfo) => {
  await abrirResumo(page, "backups");
  const painel = page.locator("#resumo-painel-backups");
  const balao = painel.locator("#resumo-backups-minimo");
  const trigger = painel.locator('.info-tip-trigger[aria-describedby="resumo-backups-minimo"]');
  await expect(painel.locator(".ck-backups__meta")).toHaveText(/^Atualizado em .+\.$/);
  await expect(painel.locator(".ck-backups__meta")).toBeVisible();
  await expect(balao).toHaveText(/^Mínimo: \d+ backups? por regional prioritária\.$/);
  await expect(painel.locator(".ck-backups__meta")).not.toContainText("Mínimo");

  await abrirComMouseOuToque(trigger, balao, testInfo);
  await page.mouse.move(0, 0);
  await focoEscFechaSoOBalao(page, trigger, balao, page.locator(PAINEL_RESUMO));
});

// O balão escondido do ⓘ conta na largura do conteúdo: preso à linha do título (info-tip--bloco), ele não cria rolagem horizontal no painel.
// Só no desktop: até 640px o balão fica fixo no rodapé da tela.
for (const largura of [641, 700]) {
  test(`Comparação (Resumo) a ${largura}px: ⓘ dos títulos não cria rolagem horizontal e o balão abre inteiro`, async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "No celular o balão fica fixo no rodapé.");
    await request.get("/__fixture_cockpit?comparacao=1");
    await page.setViewportSize({ width: largura, height: 900 });
    for (const aba of ["divergencias", "apelidos"]) {
      await abrirResumo(page, aba);
      const painel = page.locator("#cockpit-tool-panels");
      const { scrollWidth, clientWidth } = await painel.evaluate(no => ({ scrollWidth: no.scrollWidth, clientWidth: no.clientWidth }));
      expect(scrollWidth, `rolagem horizontal em ${aba}`).toBeLessThanOrEqual(clientWidth);
      const dica = page.locator(`#resumo-painel-${aba} .info-tip--bloco`).first();
      await dica.locator(".info-tip-trigger").hover();
      const caixa = await dica.locator(".info-tip-text").boundingBox();
      expect(caixa.x).toBeGreaterThanOrEqual(0);
      expect(caixa.x + caixa.width).toBeLessThanOrEqual(largura);
      await page.mouse.move(0, 0);
    }
  });
}
