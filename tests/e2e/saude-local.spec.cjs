const { test, expect } = require("@playwright/test");

// Dados 100% sintéticos; as rotas /api/* são simuladas (mesmo padrão de configuracao-local.spec.cjs).
const GB = 1024 ** 3;

function prontidao() {
  const status = { available: true, state: "ready" };
  const arquivo = { ...status, reason: "OK", file: "arquivo-sintetico.xlsx" };
  return {
    backend: "files",
    functions: Object.fromEntries(["consulta_equipamentos", "geracao_transferencia", "comparacao_atualizacao_inventarios",
      "exportacao_equipamentos", "acompanhamento_chamados"].map(chave => [chave, status])),
    files: Object.fromEntries(["inventario_equipamentos", "inventario_detalhes_atualizacao", "inventario_endpoint",
      "template_transferencia", "modelo_exportacao", "historico_chamados"].map(chave => [chave, arquivo])),
    configuracao_local: { state: "ready", faltando: [], reason: "", assistente_ia: false },
  };
}

const SAUDE = {
  gerado_em: "2026-11-26T23:50:00Z",
  disco: { livre_bytes: 120 * GB, total_bytes: 500 * GB },
  areas: [
    { chave: "backups_planilhas", arquivos: 12, bytes: 3 * GB, existe: true },
    { chave: "logs", arquivos: 4, bytes: 2048 * 1024, existe: true },
    { chave: "lotes_processados", arquivos: 0, bytes: 0, existe: false },
    { chave: "pacotes_locais", arquivos: 2, bytes: 5 * 1024 * 1024, existe: true },
    { chave: "quarentena", arquivos: 1, bytes: 4096, existe: true },
  ],
  estado_json: {
    arquivos: [
      { nome: "historico_exemplo.json", bytes: 2048, situacao: "integro", erro: null },
      { nome: "invalido_exemplo.json", bytes: 100, situacao: "invalido", erro: "JSONDecodeError" },
      { nome: "vazio_exemplo.json", bytes: 0, situacao: "vazio", erro: null },
      { nome: "ilegivel_exemplo.json", bytes: 10, situacao: "ilegivel", erro: "PermissionError" },
      { nome: "grande_exemplo.json", bytes: 20 * 1024 * 1024, situacao: "grande_demais", erro: null },
    ],
    outros: 2,
    copias_corrompidas: 1,
  },
  transacoes: { situacao: "limpo", quantidade: 0 },
};

const PREVIA = {
  aplicada: false,
  itens: [
    { acao: "remover", area: "state", caminho: "sintetico.json.tmp", bytes: 1024 },
    { acao: "quarentena", area: "modelos", caminho: "pasta/modelo.xlsx.tmp", bytes: 2048 },
  ],
  totais: { remover_arquivos: 1, remover_bytes: 1024, quarentena_arquivos: 1, quarentena_bytes: 2048, preservados: 3 },
};
const PREVIA_VAZIA = { aplicada: false, itens: [], totais: { remover_arquivos: 0, remover_bytes: 0, quarentena_arquivos: 0, quarentena_bytes: 0, preservados: 2 } };

async function simular(page, opcoes = {}) {
  const requisicoes = [];
  const registrar = route => {
    const r = route.request();
    requisicoes.push({ metodo: r.method(), url: new URL(r.url()).pathname, corpo: r.postData() ? r.postDataJSON() : null });
  };
  await page.route("**/api/prontidao", route => route.fulfill({ json: prontidao() }));
  await page.route("**/api/saude-local", route => {
    registrar(route);
    return opcoes.erroGet ? route.fulfill({ status: 500, json: { detail: "falha sintética" } }) : route.fulfill({ json: SAUDE });
  });
  await page.route("**/api/saude-local/limpeza/previa", route => { registrar(route); return route.fulfill({ json: opcoes.previa ?? PREVIA }); });
  await page.route("**/api/saude-local/limpeza", route => {
    registrar(route);
    if (opcoes.recusa) return route.fulfill({ status: 409, json: { detail: opcoes.recusa } });
    return route.fulfill({ json: { ...PREVIA, aplicada: true } });
  });
  await page.route("**/api/saude-local/diagnostico", route => {
    registrar(route);
    return route.fulfill({
      status: 200, contentType: "application/json",
      headers: { "Content-Disposition": 'attachment; filename="diagnostico-simpress-20261126-235000.json"' },
      body: JSON.stringify({ formato: 1 }),
    });
  });
  return requisicoes;
}

async function abrirProntidao(page) {
  await expect(page.locator("#readiness-panel")).toHaveAttribute("aria-busy", "false");
  const alternar = page.locator("#cockpit-bar-status-toggle");
  if ((await alternar.isVisible()) && (await alternar.getAttribute("aria-expanded")) !== "true") await alternar.click();
  const painel = page.locator("#readiness-panel");
  if ((await painel.getAttribute("open")) === null) await painel.locator(":scope > summary").click();
  await expect(page.locator("#btn-saude-local")).toBeVisible();
}

async function abrirSaude(page) {
  await page.goto("/");
  await abrirProntidao(page);
  await page.locator("#btn-saude-local").click();
  const modal = page.locator("#modal-saude-local");
  await expect(modal).toBeVisible();
  return modal;
}

const semRolagemHorizontal = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("Saúde local: abre com foco no título, mostra áreas e JSONs e Esc devolve o foco", async ({ page }) => {
  test.setTimeout(45_000);
  const erros = [];
  page.on("pageerror", erro => erros.push(erro.message));
  await simular(page);
  const modal = await abrirSaude(page);
  await expect(page.locator("#btn-saude-local")).toHaveAttribute("aria-label", "Abrir saúde local");
  await expect(page.locator("#titulo-saude-local")).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Saúde local" })).toBeVisible();

  for (const texto of ["Backups das planilhas", "Logs", "Lotes processados", "Pacotes locais", "Quarentena",
    "temporários em quarentena e cópias de arquivo corrompido", "120,0 GB livres", "de 500,0 GB no disco da pasta data", "Folga",
    "Íntegro", "Inválido", "Vazio", "Ilegível", "Grande demais para validar",
    "Outros arquivos: 2", "Cópias de arquivo corrompido: 1", "Limpo", "Nenhum arquivo"]) {
    await expect(modal.getByText(texto).first(), texto).toBeVisible();
  }

  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page.locator("#btn-saude-local")).toBeFocused();
  expect(erros).toEqual([]);
});

test("Saúde local: prévia, confirmação com foco em Cancelar e limpeza envia confirmado true", async ({ page }) => {
  test.setTimeout(45_000);
  const requisicoes = await simular(page);
  const modal = await abrirSaude(page);

  await modal.locator("#saude-local-previa").click();
  await expect(modal.getByText("Prévia — nada foi alterado")).toBeVisible();
  await expect(modal.locator("#saude-local-previa")).toBeFocused();
  await expect(modal.getByText("Remover", { exact: true }).first()).toBeVisible();
  await expect(modal.getByText("Mover para a quarentena").first()).toBeVisible();
  expect(requisicoes.some(r => r.url === "/api/saude-local/limpeza")).toBe(false);

  await modal.getByRole("button", { name: "Limpar temporários" }).click();
  const confirmacao = page.getByRole("alertdialog", { name: "Limpar temporários?" });
  await expect(confirmacao).toBeVisible();
  await expect(confirmacao.getByRole("button", { name: "Cancelar" })).toBeFocused();

  await confirmacao.getByRole("button", { name: "Cancelar" }).click();
  await expect(confirmacao).toBeHidden();
  expect(requisicoes.some(r => r.url === "/api/saude-local/limpeza")).toBe(false);

  await modal.getByRole("button", { name: "Limpar temporários" }).click();
  await expect(confirmacao).toContainText("1 arquivo (1 KB) será removido e 1 arquivo (2 KB) irá para a quarentena");
  await confirmacao.getByRole("button", { name: "Limpar agora" }).click();
  await expect(modal.getByText("Limpeza concluída.")).toBeVisible();
  await expect(modal.locator("#saude-local-resultado")).toBeFocused();
  const envio = requisicoes.find(r => r.url === "/api/saude-local/limpeza");
  expect(envio.metodo).toBe("POST");
  expect(envio.corpo).toEqual({ confirmado: true });
});

test("Saúde local: prévia vazia mostra aviso e não oferece limpar", async ({ page }) => {
  test.setTimeout(45_000);
  await simular(page, { previa: PREVIA_VAZIA });
  const modal = await abrirSaude(page);
  await modal.locator("#saude-local-previa").click();
  await expect(modal.getByText("Nenhum temporário para limpar.")).toBeVisible();
  await expect(modal.getByRole("button", { name: "Limpar temporários" })).toHaveCount(0);
});

test("Saúde local: recusa 409 aparece em região viva com as duas linhas", async ({ page }) => {
  test.setTimeout(45_000);
  const requisicoes = await simular(page, { recusa: { codigo: "chrome", mensagem: "Limpeza recusada: uma automação está usando o Chrome." } });
  const modal = await abrirSaude(page);
  await modal.locator("#saude-local-previa").click();
  await modal.getByRole("button", { name: "Limpar temporários" }).click();
  await page.getByRole("alertdialog", { name: "Limpar temporários?" }).getByRole("button", { name: "Limpar agora" }).click();
  const regiao = modal.locator('[aria-live]').filter({ hasText: "Limpeza recusada: uma automação está usando o Chrome." });
  await expect(regiao).toBeVisible();
  await expect(regiao).toContainText("Espere a rotina terminar e tente de novo.");
  expect(requisicoes.filter(r => r.url === "/api/saude-local/limpeza")).toHaveLength(1);
  // A prévia continua visível e o foco volta para ela; a saúde local é relida (1 na abertura + 1 depois do erro).
  await expect(modal.getByText("Prévia — nada foi alterado")).toBeVisible();
  await expect(modal.getByRole("button", { name: "Limpar temporários" })).toBeVisible();
  await expect(modal.locator("#saude-local-previa")).toBeFocused();
  await expect.poll(() => requisicoes.filter(r => r.url === "/api/saude-local").length).toBe(2);
});

test("Saúde local: recusa 503 na limpeza mantém a prévia e mostra o erro", async ({ page }) => {
  test.setTimeout(45_000);
  await simular(page);
  await page.route("**/api/saude-local/limpeza", route => route.fulfill({ status: 503, json: { detail: "falha sintética" } }));
  const modal = await abrirSaude(page);
  await modal.locator("#saude-local-previa").click();
  await modal.getByRole("button", { name: "Limpar temporários" }).click();
  await page.getByRole("alertdialog", { name: "Limpar temporários?" }).getByRole("button", { name: "Limpar agora" }).click();
  await expect(modal.getByText("Não foi possível concluir a limpeza.")).toBeVisible();
  await expect(modal.getByText("Prévia — nada foi alterado")).toBeVisible();
});

test("Saúde local: erro ao ler mostra a mensagem exata", async ({ page }) => {
  test.setTimeout(45_000);
  await simular(page, { erroGet: true });
  const modal = await abrirSaude(page);
  await expect(modal.locator("[aria-live]").filter({ hasText: "Não foi possível ler a saúde local." })).toBeVisible();
  await expect(modal.getByRole("button", { name: "Ver prévia" })).toHaveCount(0);
  await expect(modal.locator("#saude-local-atualizar")).toBeVisible();
  await expect(modal.locator("#saude-local-baixar")).toBeVisible();
  await expect(modal.getByRole("button", { name: "Baixar pacote de diagnóstico" })).toBeVisible();
});

test("Saúde local: baixar diagnóstico dispara o download com o nome do servidor", async ({ page }) => {
  test.setTimeout(45_000);
  await simular(page);
  const modal = await abrirSaude(page);
  const download = page.waitForEvent("download");
  await modal.locator("#saude-local-baixar").click();
  expect((await download).suggestedFilename()).toMatch(/^diagnostico-simpress-.*\.json$/);
});

test("Saúde local: sem rolagem horizontal em 360 e 1280 px nos dois temas, com cartões no celular", async ({ page }) => {
  test.setTimeout(60_000);
  await simular(page);
  const modal = await abrirSaude(page);
  await modal.locator("#saude-local-previa").click();
  await expect(modal.getByText("Prévia — nada foi alterado")).toBeVisible();
  for (const tema of ["light", "dark"]) {
    await page.locator("html").evaluate((raiz, valor) => { raiz.dataset.theme = valor; }, tema);
    for (const largura of [360, 1280]) {
      await page.setViewportSize({ width: largura, height: 900 });
      const rotulo = `${tema} ${largura}px`;
      expect(await semRolagemHorizontal(page), `${rotulo}: página`).toBe(true);
      expect(await page.locator("#saude-local-corpo").evaluate(c => c.scrollWidth <= c.clientWidth), `${rotulo}: corpo`).toBe(true);
      // Abaixo de 768 px cada linha vira cartão (grid); acima, continua linha de tabela.
      await expect(modal.getByText("Backups das planilhas").first()).toBeVisible();
      const exibicao = await modal.locator(".nl-tabela__lin").first().evaluate(l => getComputedStyle(l).display);
      expect(exibicao, `${rotulo}: linha`).toBe(largura === 360 ? "grid" : "table-row");
    }
  }
});

test.describe("movimento reduzido", () => {
  test.use({ reducedMotion: "reduce" });
  test("Saúde local: abre, mostra prévia e fecha sem erro", async ({ page }) => {
    test.setTimeout(45_000);
    const erros = [];
    page.on("pageerror", erro => erros.push(erro.message));
    await simular(page);
    const modal = await abrirSaude(page);
    await expect(page.locator("#titulo-saude-local")).toBeFocused();
    await modal.locator("#saude-local-previa").click();
    await expect(modal.getByText("Prévia — nada foi alterado")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(page.locator("#btn-saude-local")).toBeFocused();
    expect(erros).toEqual([]);
  });
});
