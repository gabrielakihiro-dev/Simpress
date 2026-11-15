// Migração React, Dia 2, grupo G3 (Equipamentos): "Dossiê do equipamento" da Home (F1).
// O baseline de screenshots foi gravado com o diálogo antigo (JS puro), antes da troca para React:
// o diálogo em React tem de sair igual nos dois tamanhos (390 e 1366 px) e nos dois temas.
// O comportamento continua coberto por tests/e2e/dossie-equipamento.spec.cjs, que roda sem mudanças.
const { test, expect } = require("@playwright/test");

const EQUIPAMENTO = { serial: "LENTO", modelo: "Notebook de teste", tipo: "Notebook", apelido: "TESTE-001", nome_pessoa: "Pessoa Teste" };
const ordem = (os, extra = {}) => ({ fonte: "oracle", serie: "LENTO-01", os, status: "Em atendimento", fila: "Fila Teste", dias_aberta: 7, utic: null, ...extra });
const DOSSIE = {
  serie: "LENTO",
  modelo: "Notebook de teste",
  os: {
    estado: "ok", mensagem: "", total_importacoes: 3, ultima_importacao_em: "2026-11-10T08:00:00", presente_na_ultima: true,
    ultima_vez_observada_em: "2026-11-05T09:30:00",
    ordens: [
      ordem("OS-1001", { utic: { chamado: "CH-2001", origem: "Manual" } }),
      ordem("OS-1002", { fonte: "simpress", status: "Aguardando peça", fila: "", dias_aberta: null }),
    ],
    historico: {
      titulo: "Mudanças da série nas importações de OS",
      eventos: [{ atualizado_em: "2026-11-05T09:30:00", tipo: "Dados alterados", mudancas: [{ campo: "Status Oracle", anterior: ["Aberto"], atual: ["Em atendimento"] }] }],
      total: 1,
    },
  },
};

// `dossie` é o JSON da resposta, "erro" responde 500 e "pendente" nunca responde (estado carregando).
async function abrirDossie(page, { tema, dossie }) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  await page.route("**/api/equipamento/*", route => route.fulfill({ json: { ...EQUIPAMENTO } }));
  await page.route("**/api/equipamento/*/dossie", route => {
    if (dossie === "pendente") return undefined;
    if (dossie === "erro") return route.fulfill({ status: 500, json: { detail: "Detalhe interno do servidor" } });
    return route.fulfill({ json: dossie });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await page.locator("#btn-ver-dossie").click();
  await expect(page.locator("#modal-dossie-equipamento")).toBeVisible();
  await page.mouse.move(0, 0);
}

const dialogo = page => page.locator("#modal-dossie-equipamento > .ck-dialogo");
const foto = { animations: "disabled", maxDiffPixelRatio: 0.01 };

for (const tema of ["light", "dark"]) {
  test(`baseline: dossiê com OS, chamados e histórico, tema ${tema}`, async ({ page }) => {
    await abrirDossie(page, { tema, dossie: DOSSIE });
    await expect(page.locator("#dossie-os-linhas tr")).toHaveCount(2);
    await expect(page.locator("#dossie-historico-lista > li")).toHaveCount(1);
    await expect(dialogo(page)).toHaveScreenshot(`dossie-pronto-${tema}.png`, foto);
  });

  test(`baseline: dossiê com erro do servidor, tema ${tema}`, async ({ page }) => {
    await abrirDossie(page, { tema, dossie: "erro" });
    await expect(page.locator("#dossie-status")).toHaveText("Não foi possível carregar o dossiê. Tente de novo.");
    await expect(dialogo(page)).toHaveScreenshot(`dossie-erro-${tema}.png`, foto);
  });

  test(`baseline: dossiê carregando, tema ${tema}`, async ({ page }) => {
    await abrirDossie(page, { tema, dossie: "pendente" });
    await expect(page.locator("#dossie-status")).toHaveText("Carregando dossiê…");
    await expect(dialogo(page)).toHaveScreenshot(`dossie-carregando-${tema}.png`, foto);
  });

  test(`baseline: dossiê de série sem base importada, tema ${tema}`, async ({ page }) => {
    await abrirDossie(page, { tema, dossie: { ...DOSSIE, os: { ...DOSSIE.os, estado: "sem_base", mensagem: "Sem base importada", ordens: [] } } });
    await expect(page.locator("#dossie-os-mensagem")).toHaveText("Sem base importada");
    await expect(dialogo(page)).toHaveScreenshot(`dossie-sem-base-${tema}.png`, foto);
  });
}

test.describe("estrutura (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "estrutura não depende da largura: roda só no desktop");

  test("IDs, ARIA e data-*: os mesmos do diálogo antigo, sem IDs repetidos na página", async ({ page }) => {
    await abrirDossie(page, { tema: "light", dossie: DOSSIE });
    const modal = page.locator("#modal-dossie-equipamento.modal-overlay.ck-veu");
    await expect(modal).toHaveAttribute("aria-labelledby", "titulo-dossie-equipamento");
    await expect(modal.locator("h3#titulo-dossie-equipamento")).toHaveText("Dossiê do equipamento");
    await expect(modal.locator("#dossie-serie")).toHaveText("LENTO");
    await expect(modal.locator("#dossie-modelo")).toHaveText("Notebook de teste");
    await expect(modal.locator("p#dossie-status")).toHaveAttribute("role", "status");
    await expect(modal.locator("p#dossie-status")).toHaveAttribute("aria-live", "polite");
    await expect(modal.locator("section#dossie-os")).toHaveAttribute("aria-labelledby", "dossie-os-titulo");
    await expect(modal.locator("h4#dossie-os-titulo")).toHaveText("OS e chamados");
    await expect(modal.locator("#dossie-os-importacoes")).toHaveText("Importações disponíveis: 3");
    await expect(modal.locator("#dossie-os-observada")).toContainText("Última vez observada em");
    await expect(modal.locator("#dossie-os-ordens table.ck-tabela.ck-tabela--cards tbody#dossie-os-linhas tr")).toHaveCount(2);
    await expect(modal.locator("#dossie-os-linhas tr").first().locator("td")).toHaveText(["OS-1001", "Oracle", "Em atendimento", "Fila Teste", "7", "CH-2001 Manual", "Ver OS"]);
    expect(await modal.locator("#dossie-os-linhas tr").first().locator("td").evaluateAll(tds => tds.map(td => td.dataset.label))).toEqual(["OS", "Fonte", "Status", "Fila", "Dias aberta", "UTIC", ""]);
    await expect(modal.locator("#dossie-os-linhas tr").first().locator("td").last()).toHaveClass("ck-td--sem-rotulo");
    await expect(modal.locator("#dossie-os-linhas button.ck-btn.ck-btn--secundario.ck-btn--sm[type=button]").first()).toHaveAttribute("aria-label", "Ver OS OS-1001");
    await expect(modal.locator("#dossie-os-linhas .ck-tag.ck-tag--neutra")).toHaveText(["Manual"]);
    await expect(modal.locator("#dossie-historico-titulo")).toHaveText("Mudanças da série nas importações de OS");
    await expect(modal.locator("ul#dossie-historico-lista.dossie-equip__eventos > li.dossie-equip__evento")).toHaveCount(1);
    await expect(modal.locator("#dossie-historico-lista p.dossie-equip__evento-cab time")).toHaveAttribute("datetime", "2026-11-05T09:30:00");
    await expect(modal.locator("#dossie-historico-lista ul.dossie-equip__mudancas > li")).toHaveText(["Status Oracle: Aberto → Em atendimento"]);
    await expect(modal.locator("#dossie-historico-vazio")).toBeHidden();
    await expect(modal.locator("button#dossie-fechar[type=button]")).toHaveText("Fechar");
    const repetidos = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map(el => el.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(repetidos).toEqual([]);
  });
});
