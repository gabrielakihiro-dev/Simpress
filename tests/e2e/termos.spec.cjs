const { test, expect } = require("@playwright/test");

// Termos de entrega e devolução (Ferramentas): tudo na tela, sem gravação; o PDF é a janela de impressão do navegador.
const AVISO_SEM_DADOS = "Preencha o número de série e o nome do colaborador.";

async function abrirTermos(page, { navegar = true } = {}) {
  if (navegar) await page.goto("/");
  const menu = page.locator("#cockpit-tools-dropdown");
  if (!(await menu.evaluate(node => node.open))) await page.locator("#cockpit-tools-trigger").click();
  await page.locator("#btn-lembretes").click();
  await expect(page.locator('[data-cockpit-tool-panel="lembretes"]')).toBeVisible();
  await page.locator("#termos-aba-entrega").click();
}

// Substitui window.print: registra o título e a folha no instante da impressão e não abre a janela do navegador.
// "imagens" lista as <img> da folha (só a assinatura do técnico) com o bloco de assinatura em que cada uma está.
async function interceptarImpressao(page) {
  await page.evaluate(() => {
    window.__impressoes = [];
    window.print = () => {
      const folha = document.getElementById("termos-impressao");
      const blocos = [...folha.querySelectorAll(".tp__assinatura")];
      window.__impressoes.push({
        titulo: document.title,
        folhaFilhos: folha.childElementCount,
        classe: document.documentElement.classList.contains("termos-imprimindo"),
        blocos: blocos.length,
        imagens: [...folha.querySelectorAll("img")].map(img => ({
          bloco: blocos.indexOf(img.closest(".tp__assinatura")),
          rotulo: img.closest(".tp__assinatura").textContent,
          carregada: img.complete && img.naturalWidth > 0,
          alt: img.getAttribute("alt"),
          classe: img.className,
        })),
      });
    };
  });
}

const impressoes = page => page.evaluate(() => window.__impressoes);

// A impressão é assíncrona (espera a assinatura do técnico): aguarda a n-ésima chamada a window.print.
const esperarImpressao = (page, n = 1) => page.waitForFunction(total => window.__impressoes.length >= total, n);

test("abre pelo menu Ferramentas e troca de sub-aba por clique e por ArrowRight", async ({ page }) => {
  await abrirTermos(page);
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Lembretes");
  await expect(page.locator("#btn-lembretes kbd")).toHaveCount(0);

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
  await esperarImpressao(page);

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
  await esperarImpressao(page);
  const [impressao] = await impressoes(page);
  expect(impressao.titulo).toBe("BRJ54925DN - Janaina do Rocio Santos Rocha");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  expect(await page.evaluate(() => document.getElementById("termos-impressao").childElementCount)).toBe(0);
});

// Assinatura do técnico: a folha mostra a imagem só no bloco do técnico; sem ela, sai como antes (linha em branco).
const SVG_FALSO = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><path d="M10 60 L190 20" stroke="#000"/></svg>';

async function gerarPdf(page, termo) {
  await interceptarImpressao(page);
  if (termo === "devolucao") {
    await page.getByRole("tab", { name: "Termo Devolução" }).click();
    await page.locator("#termos-devolucao-serie").fill("brj54925dn");
    await page.locator("#termos-devolucao-nome").fill("Janaina do Rocio Santos Rocha");
  } else {
    await page.locator("#termos-entrega-serie-entregue").fill("brj54925dn");
    await page.locator("#termos-entrega-nome").fill("Janaina do Rocio Santos Rocha");
  }
  await page.locator(`#termos-painel-${termo}`).getByRole("button", { name: "Gerar PDF" }).click();
  await esperarImpressao(page);
  return (await impressoes(page))[0];
}

for (const [termo, rotulo] of [["entrega", "Assinatura do técnico responsável"], ["devolucao", "Assinatura do Técnico"]]) {
  test(`PDF do termo de ${termo} traz a assinatura do técnico só no bloco do técnico`, async ({ page }) => {
    const pedidos = [];
    page.on("request", req => { if (req.url().includes("/api/assinatura-tecnico")) pedidos.push({ metodo: req.method(), url: req.url(), corpo: req.postData() }); });
    await abrirTermos(page);
    const impressao = await gerarPdf(page, termo);
    expect(impressao.blocos).toBe(2);
    expect(impressao.imagens).toEqual([{ bloco: 1, rotulo, carregada: true, alt: "", classe: "tp__assinatura-img" }]);
    // Única requisição: GET sem query nem corpo, então nada do termo sai da página.
    expect(pedidos).toEqual([{ metodo: "GET", url: new URL("/api/assinatura-tecnico", page.url()).href, corpo: null }]);
  });

  test(`folha impressa do termo de ${termo}: imagem de 14 mm sobre a linha do técnico, sem empurrar o layout`, async ({ page }) => {
    await abrirTermos(page);
    await gerarPdf(page, termo); // afterprint não é disparado: a folha continua montada
    await page.emulateMedia({ media: "print" });
    const medir = () => page.evaluate(() => {
      const folha = document.getElementById("termos-impressao");
      const img = folha.querySelector("img.tp__assinatura-img");
      const linhaAssinaturas = folha.querySelector(".tp__assinaturas");
      const img1 = img.getBoundingClientRect();
      return {
        imagem: { altura: img1.height, largura: img1.width, topo: img1.top, base: img1.bottom, estilo: getComputedStyle(img).position },
        blocoTecnico: linhaAssinaturas.children[1].getBoundingClientRect().top,
        fimDoAnterior: linhaAssinaturas.previousElementSibling.getBoundingClientRect().bottom,
        topoDasAssinaturas: linhaAssinaturas.getBoundingClientRect().top,
        alturaDaFolha: folha.scrollHeight,
      };
    });
    const com = await medir();
    expect(com.imagem.estilo).toBe("absolute");
    expect(Math.abs(com.imagem.altura - 52.9)).toBeLessThanOrEqual(2); // 14 mm a 96 dpi
    expect(com.imagem.largura).toBeGreaterThan(0);
    // Desce 39/122,3 da própria altura abaixo da linha: o corpo apoia nela e só as caudas passam.
    expect(Math.abs(com.imagem.base - com.blocoTecnico - com.imagem.altura * 39 / 122.3)).toBeLessThanOrEqual(1.5);
    expect(com.imagem.topo).toBeGreaterThanOrEqual(com.fimDoAnterior); // não cobre o texto anterior
    // Sem a imagem (display:none), as posições e a altura da folha não mudam: ela não empurra nada.
    await page.evaluate(() => { document.querySelector("#termos-impressao img.tp__assinatura-img").style.display = "none"; });
    const sem = await medir();
    expect(sem.topoDasAssinaturas).toBe(com.topoDasAssinaturas);
    expect(sem.blocoTecnico).toBe(com.blocoTecnico);
    expect(sem.alturaDaFolha).toBe(com.alturaDaFolha);
  });

  // Bug de 12/11/2026: na impressão, o fundo branco da folha pintava a <img>, que cobria a linha e o rótulo do técnico.
  test(`folha impressa do termo de ${termo}: assinatura larga sai inteira, transparente e sem esconder o rótulo`, async ({ page }) => {
    // Sintética, ~4,9:1 como a real (viewBox sem width/height), traço de ponta a ponta.
    const svgLargo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 122.3"><path d="M5 80 L595 40 L590 120" stroke="#000" stroke-width="4" fill="none"/></svg>';
    await page.route("**/api/assinatura-tecnico", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: svgLargo }));
    await page.setViewportSize({ width: 794, height: 1123 }); // largura de A4 a 96 dpi, como na impressão
    await abrirTermos(page);
    await gerarPdf(page, termo);
    await page.emulateMedia({ media: "print" });
    const m = await page.evaluate(() => {
      const img = document.querySelector("#termos-impressao img.tp__assinatura-img");
      const bloco = img.closest(".tp__assinatura");
      const i = img.getBoundingClientRect();
      const b = bloco.getBoundingClientRect();
      return { fundo: getComputedStyle(img).backgroundColor, proporcao: i.width / i.height, esquerda: i.left - b.left, direita: b.right - i.right, rotulo: bloco.textContent };
    });
    expect(m.fundo).toBe("rgba(0, 0, 0, 0)");
    expect(Math.abs(m.proporcao - 600 / 122.3)).toBeLessThanOrEqual(0.1);
    expect(m.esquerda).toBeGreaterThanOrEqual(0);
    expect(m.direita).toBeGreaterThanOrEqual(0);
    expect(m.rotulo).toBe(rotulo);
  });
}

for (const status of [404, 422]) {
  test(`PDF sai sem imagem quando a assinatura responde ${status}`, async ({ page }) => {
    await page.route("**/api/assinatura-tecnico", route => route.fulfill({ status, json: { detail: "sem assinatura", codigo: "teste" } }));
    await abrirTermos(page);
    for (const termo of ["entrega", "devolucao"]) {
      const impressao = await gerarPdf(page, termo);
      expect(impressao.folhaFilhos, termo).toBeGreaterThan(0);
      expect(impressao.blocos, termo).toBe(2);
      expect(impressao.imagens, termo).toEqual([]);
      await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    }
  });
}

test("PDF sai sem imagem quando a assinatura demora mais de 3 s", async ({ page }) => {
  await page.route("**/api/assinatura-tecnico", async route => {
    await new Promise(resolve => setTimeout(resolve, 4500));
    await route.abort().catch(() => {});
  });
  await abrirTermos(page);
  const inicio = Date.now();
  const impressao = await gerarPdf(page, "entrega");
  expect(Date.now() - inicio).toBeGreaterThanOrEqual(2800);
  expect(impressao.imagens).toEqual([]);
});

test("segundo clique em Gerar PDF durante o carregamento da assinatura é ignorado", async ({ page }) => {
  let pedidos = 0;
  await page.route("**/api/assinatura-tecnico", async route => {
    pedidos += 1;
    await new Promise(resolve => setTimeout(resolve, 600));
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG_FALSO });
  });
  await abrirTermos(page);
  await interceptarImpressao(page);
  await page.locator("#termos-entrega-serie-entregue").fill("brj54925dn");
  await page.locator("#termos-entrega-nome").fill("Janaina do Rocio Santos Rocha");
  await page.locator("#termos-painel-entrega").getByRole("button", { name: "Gerar PDF" }).dblclick();
  await esperarImpressao(page);
  await page.waitForTimeout(400);
  expect(await impressoes(page)).toHaveLength(1);
  expect(pedidos).toBe(1);
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
