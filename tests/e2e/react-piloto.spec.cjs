// Piloto da migração React (Bloco 3): cartão "Ativos por regional" do Resumo (F3, Visão geral).
// O baseline de screenshots foi gravado com o cartão antigo (JS puro), antes da troca para React:
// o cartão em React tem de sair igual nos dois tamanhos (390 e 1366 px) e nos dois temas.
const { test, expect } = require("@playwright/test");

// 12 regionais (mostra "Ver menos", o --linhas e as duas colunas a partir de 1000 px) e uma categoria zerada (pílula desabilitada).
const cidades = Array.from({ length: 12 }, (_, i) => ({ cidade: `Cidade ${String(i + 1).padStart(2, "0")}`, total: 100 - i * 7 }));
const PAINEL = {
  total_equipamentos: 738,
  por_categoria: [
    { value: "notebook", label: "Notebooks", total: 500 },
    { value: "macbook", label: "MacBooks", total: 200 },
    { value: "monitor", label: "Monitores", total: 38 },
    { value: "fone", label: "Fones", total: 0 },
  ],
  cidades_principais: cidades,
  cidades_por_categoria: {
    notebook: [{ cidade: "Curitiba", total: 300 }, { cidade: "Londrina", total: 200 }],
    macbook: [{ cidade: "Londrina", total: 200 }],
    monitor: [{ cidade: "Curitiba", total: 38 }],
    fone: [],
  },
};

// Mantém o resto da resposta da fixture (outros cartões leem /api/painel) e troca só os campos do cartão.
async function rotaPainel(page, painel) {
  await page.route("**/api/painel", async route => {
    if (painel === "erro") return route.abort();
    const resposta = await route.fetch();
    await route.fulfill({ response: resposta, json: { ...(await resposta.json()), ...painel } });
  });
}

async function abrirCartao(page, { tema, painel }) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  await rotaPainel(page, painel);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  await page.locator("#btn-resumo-aba").click();
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
  await expect(page.locator("#comparacao-planilhas-conteudo")).toHaveAttribute("data-estado", /^(pronto|vazio|erro)$/);
  await expect(page.locator("#resumo-regionais")).toHaveAttribute("data-estado", painel === "erro" ? "erro" : "pronto");
  await page.locator("#resumo-aba-visao").click();
  await expect(page.locator("#resumo-aba-visao")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#resumo-ativos-secao")).toBeVisible();
  // O brilho do bento segue o ponteiro (--mx/--my): o mouse fica fora do cartão.
  await page.mouse.move(0, 0);
}

for (const tema of ["light", "dark"]) {
  test(`baseline: cartão com 12 regionais, tema ${tema}`, async ({ page }) => {
    await abrirCartao(page, { tema, painel: PAINEL });
    await expect(page.locator("#resumo-regionais .ck-barra")).toHaveCount(12);
    await expect(page.locator("#resumo-regionais .ck-barra__valor").first()).toHaveText("100");
    await expect(page.locator(".ck-regionais")).toHaveScreenshot(`regionais-pronto-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });

  test(`baseline: cartão com o servidor fora do ar, tema ${tema}`, async ({ page }) => {
    await abrirCartao(page, { tema, painel: "erro" });
    await expect(page.locator("#resumo-regionais")).toContainText("indisponível");
    await expect(page.locator(".ck-regionais")).toHaveScreenshot(`regionais-erro-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}
