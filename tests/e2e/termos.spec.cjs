const { test, expect } = require("@playwright/test");

// Termos de entrega e devolução (Ferramentas): tudo na tela, sem gravação; o PDF é a janela de impressão do navegador.
const AVISO_SEM_DADOS = "Preencha o número de série e o nome do colaborador.";

async function abrirTermos(page, { navegar = true } = {}) {
  if (navegar) await page.goto("/");
  const menu = page.locator("#cockpit-tools-dropdown");
  if (!(await menu.evaluate(node => node.open))) await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-termos").click();
  await expect(page.locator('[data-cockpit-tool-panel="termos"]')).toBeVisible();
}

// Substitui window.print: registra o título e a folha no instante da impressão e não abre a janela do navegador.
async function interceptarImpressao(page) {
  await page.evaluate(() => {
    window.__impressoes = [];
    window.print = () => {
      window.__impressoes.push({
        titulo: document.title,
        folhaFilhos: document.getElementById("termos-impressao").childElementCount,
        classe: document.documentElement.classList.contains("termos-imprimindo"),
      });
    };
  });
}

const impressoes = page => page.evaluate(() => window.__impressoes);

test("abre pelo menu Ferramentas e troca de sub-aba por clique e por ArrowRight", async ({ page }) => {
  await abrirTermos(page);
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Termos");
  await expect(page.locator("#btn-termos kbd")).toHaveCount(0);

  const entrega = page.getByRole("tab", { name: "Termo Entrega" });
  const devolucao = page.getByRole("tab", { name: "Termo Devolução" });
  await expect(entrega).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#termos-painel-entrega")).toBeVisible();
  await expect(page.locator("#termos-painel-devolucao")).toBeHidden();

  await devolucao.click();
  await expect(devolucao).toHaveAttribute("aria-selected", "true");
  await expect(entrega).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#termos-painel-devolucao")).toBeVisible();
  await expect(page.locator("#termos-painel-entrega")).toBeHidden();

  await entrega.click();
  await expect(page.locator("#termos-painel-entrega")).toBeVisible();
  await entrega.focus();
  await page.keyboard.press("ArrowRight");
  await expect(devolucao).toHaveAttribute("aria-selected", "true");
  await expect(devolucao).toBeFocused();
  await expect(page.locator("#termos-painel-devolucao")).toBeVisible();
  await expect(page.locator("#termos-painel-entrega")).toBeHidden();
});

test("Gerar PDF sem série ou sem nome bloqueia a impressão e mostra o aviso", async ({ page }) => {
  await abrirTermos(page);
  await interceptarImpressao(page);
  await page.locator("#termos-painel-entrega").getByRole("button", { name: "Gerar PDF" }).click();
  await expect(page.locator("#termos-status-entrega")).toHaveText(AVISO_SEM_DADOS);
  expect(await impressoes(page)).toEqual([]);

  await page.getByRole("tab", { name: "Termo Devolução" }).click();
  await page.locator("#termos-painel-devolucao").getByRole("button", { name: "Gerar PDF" }).click();
  await expect(page.locator("#termos-status-devolucao")).toHaveText(AVISO_SEM_DADOS);
  expect(await impressoes(page)).toEqual([]);

  // Só a série, ou só o nome (inclusive só com caracteres removidos na limpeza): também bloqueia.
  const gerar = page.locator("#termos-painel-devolucao").getByRole("button", { name: "Gerar PDF" });
  await page.locator("#termos-devolucao-serie").fill("BRJ54925DN");
  await gerar.click();
  await expect(page.locator("#termos-status-devolucao")).toHaveText(AVISO_SEM_DADOS);
  await page.locator("#termos-devolucao-serie").fill("");
  await page.locator("#termos-devolucao-nome").fill("Janaina do Rocio Santos Rocha");
  await gerar.click();
  await expect(page.locator("#termos-status-devolucao")).toHaveText(AVISO_SEM_DADOS);
  await page.locator("#termos-devolucao-serie").fill("///");
  await gerar.click();
  await expect(page.locator("#termos-status-devolucao")).toHaveText(AVISO_SEM_DADOS);
  expect(await impressoes(page)).toEqual([]);
});

test("Gerar PDF usa '<série> - <nome>' como título e restaura tudo no afterprint", async ({ page }) => {
  await abrirTermos(page);
  const tituloOriginal = await page.title();
  await interceptarImpressao(page);

  await page.getByRole("tab", { name: "Termo Devolução" }).click();
  await page.locator("#termos-devolucao-serie").fill("brj54925dn");
  await page.locator("#termos-devolucao-nome").fill("Janaina do Rocio Santos Rocha");
  await page.locator("#termos-painel-devolucao").getByRole("button", { name: "Gerar PDF" }).click();

  const [impressao] = await impressoes(page);
  expect(impressao.titulo).toBe("BRJ54925DN - Janaina do Rocio Santos Rocha");
  expect(impressao.folhaFilhos).toBeGreaterThan(0);
  expect(impressao.classe).toBe(true);
  await expect(page.locator("#termos-status-devolucao")).toHaveText("");

  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  expect(await page.title()).toBe(tituloOriginal);
  expect(await page.evaluate(() => document.documentElement.classList.contains("termos-imprimindo"))).toBe(false);
  expect(await page.evaluate(() => document.getElementById("termos-impressao").childElementCount)).toBe(0);
  expect(await page.evaluate(() => document.getElementById("termos-impressao").textContent)).toBe("");
});

test("Termo Entrega nomeia o arquivo com a série do equipamento entregue", async ({ page }) => {
  await abrirTermos(page);
  await interceptarImpressao(page);
  await page.locator("#termos-entrega-serie-anterior").fill("ANTIGA123");
  await page.locator("#termos-entrega-serie-entregue").fill("brj54925dn");
  await page.locator("#termos-entrega-nome").fill("Janaina do Rocio Santos Rocha");
  await page.locator("#termos-painel-entrega").getByRole("button", { name: "Gerar PDF" }).click();
  const [impressao] = await impressoes(page);
  expect(impressao.titulo).toBe("BRJ54925DN - Janaina do Rocio Santos Rocha");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  expect(await page.evaluate(() => document.getElementById("termos-impressao").childElementCount)).toBe(0);
});

test("Limpar pede confirmação e só apaga o termo ao confirmar", async ({ page }) => {
  await abrirTermos(page);
  const nome = page.locator("#termos-entrega-nome");
  const serie = page.locator("#termos-entrega-serie-entregue");
  const obs = page.locator("#termos-entrega-obs");
  await nome.fill("Maria Silva");
  await serie.fill("ABC123");
  await obs.fill("Sem avarias.");
  await page.locator("#termos-entrega-item-01-sim").check();

  const limpar = page.locator("#termos-painel-entrega").getByRole("button", { name: "Limpar" });
  await limpar.click();
  await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Limpar o termo?");
  await page.locator("#btn-confirmar-acao-cancelar").click();
  await expect(nome).toHaveValue("Maria Silva");
  await expect(page.locator("#termos-entrega-item-01-sim")).toBeChecked();

  await limpar.click();
  await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Limpar o termo?");
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(nome).toHaveValue("");
  await expect(serie).toHaveValue("");
  await expect(obs).toHaveValue("");
  await expect(page.locator("#termos-entrega-item-01-sim")).not.toBeChecked();
});

test("os dois termos cabem em 320px sem rolagem horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await abrirTermos(page);
  for (const aba of ["Termo Entrega", "Termo Devolução"]) {
    await page.getByRole("tab", { name: aba }).click();
    const medidas = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      documento: document.documentElement.scrollWidth,
      corpo: document.body.scrollWidth,
      painel: document.getElementById("cockpit-tool-panels").scrollWidth,
      painelVisivel: document.getElementById("cockpit-tool-panels").clientWidth,
    }));
    expect(medidas.documento, aba).toBeLessThanOrEqual(medidas.viewport);
    expect(medidas.corpo, aba).toBeLessThanOrEqual(medidas.viewport);
    expect(medidas.painel, aba).toBeLessThanOrEqual(medidas.painelVisivel);
  }
});

test("buscar a série na Home preenche nome, modelo, série e Notebook = Sim nos dois termos", async ({ page }) => {
  // Equipamento fictício: a resposta da API é simulada, nenhum dado real entra no teste.
  await page.route("**/api/equipamento/TERMO123", route => route.fulfill({
    json: { serial: "TERMO123", modelo: "HP 640 G11", nome_pessoa: "Maria Teste", tipo: "Notebook" },
  }));
  await page.goto("/");
  await page.locator("#input-serial").fill("TERMO123");
  await page.locator("#input-serial").press("Enter");
  await expect(page.locator("#card-serial")).toHaveText("TERMO123");

  await abrirTermos(page, { navegar: false });
  const entrega = page.locator("#termos-form-entrega");
  await expect(entrega.locator('[name="nome"]')).toHaveValue("Maria Teste");
  await expect(entrega.locator('[name="modelo_entregue"]')).toHaveValue("HP 640 G11");
  await expect(entrega.locator('[name="serie_entregue"]')).toHaveValue("TERMO123");
  await expect(entrega.locator('[name="modelo_anterior"]')).toHaveValue("");
  await expect(entrega.locator('input[name="item-02"][value="sim"]')).toBeChecked();
  await expect(entrega.locator('input[name="item-01"]:checked')).toHaveCount(0);

  const devolucao = page.locator("#termos-form-devolucao");
  await expect(devolucao.locator('[name="nome"]')).toHaveValue("Maria Teste");
  await expect(devolucao.locator('[name="modelo"]')).toHaveValue("HP 640 G11");
  await expect(devolucao.locator('[name="serie"]')).toHaveValue("TERMO123");
  await expect(devolucao.locator('input[name="item-02"][value="sim"]')).toBeChecked();
  // Os campos preenchidos pela Home continuam editáveis (pedido do usuário de 10/11/2026).
  await page.getByRole("tab", { name: "Termo Devolução" }).click();
  await devolucao.locator('[name="modelo"]').fill("Modelo Editado");
  await expect(devolucao.locator('[name="modelo"]')).toHaveValue("Modelo Editado");
  await devolucao.locator('input[name="item-02"][value="nao"]').check();
  await expect(devolucao.locator('input[name="item-02"][value="nao"]')).toBeChecked();
});
