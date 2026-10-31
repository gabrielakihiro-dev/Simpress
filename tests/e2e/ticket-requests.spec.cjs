const { test, expect } = require("@playwright/test");

const HISTORICO = [
  { id: "new", atualizado_em: "2026-10-12T12:00:00Z" },
  { id: "old", atualizado_em: "2026-10-11T12:00:00Z" },
];

test("Chamados: a comparação não é sobrescrita por uma resposta atrasada de outra versão", async ({ page }) => {
  let releaseOld;
  let notifyOldRequested;
  const oldRequested = new Promise(resolve => { notifyOldRequested = resolve; });
  await page.route("**/api/operacoes/chamados", route => route.fulfill({ json: {
    snapshot_id: "new", historico: [...HISTORICO, { id: "oldest", atualizado_em: "2026-10-10T12:00:00Z" }],
    chamados: [{ serie: "SN-NEW", simpress: {}, oracle: [] }],
  } }));
  await page.route("**/api/operacoes/chamados/evolucao**", async route => {
    const atual = new URL(route.request().url()).searchParams.get("atual");
    if (atual === "old") {
      notifyOldRequested();
      await new Promise(release => { releaseOld = release; });
      await route.fulfill({ json: { contagens: { novos: 9 }, mudancas: {} } }).catch(() => {});
      return;
    }
    await route.fulfill({ json: { contagens: { novos: 1 }, mudancas: {} } });
  });
  await page.goto("/");
  await page.evaluate(() => { abrirPainelCockpit("chamados"); abrirGestaoChamadosCockpit(); });
  const selector = page.locator("#cockpit-tickets-version");
  await expect(selector).toHaveValue("new");
  await expect(page.locator("#cockpit-tickets-evolution")).toContainText("1 novas");
  try {
    await selector.selectOption("old");
    await oldRequested;
    await selector.selectOption("new");
    await expect(page.locator("#cockpit-tickets-evolution")).toContainText("1 novas");
    releaseOld();
    await page.waitForTimeout(150);
    await expect(page.locator("#cockpit-tickets-evolution")).toContainText("1 novas");
    await expect(page.locator("#cockpit-tickets-evolution")).not.toContainText("9 novas");
  } finally {
    releaseOld?.();
  }
});

test("Chamados: Exportar Excel usa a versão selecionada e os filtros do painel", async ({ page }) => {
  const exported = [];
  await page.route("**/api/operacoes/chamados", route => route.fulfill({ json: {
    snapshot_id: "new", historico: HISTORICO,
    chamados: [{ serie: "SN-NEW", simpress: {}, oracle: [] }],
  } }));
  await page.route("**/api/operacoes/chamados/evolucao**", route => route.fulfill({ json: {
    contagens: { novos: 1, alterados: 0, iguais: 0, ausentes_arquivo: 0 }, mudancas: { novos: ["SN-NEW"] },
  } }));
  await page.route("**/api/operacoes/chamados/exportar**", async route => {
    exported.push(new URL(route.request().url()).searchParams);
    await route.fulfill({ status: 200, body: "synthetic xlsx", headers: {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename=chamados.xlsx",
    } });
  });
  await page.goto("/");
  await page.evaluate(() => { abrirPainelCockpit("chamados"); abrirGestaoChamadosCockpit(); });
  const exportButton = page.locator("#cockpit-tickets-export");
  await expect(page.locator("#cockpit-tickets-version")).toHaveValue("new");
  await expect(exportButton).toBeEnabled();

  await page.locator("#cockpit-tickets-version").selectOption("old");
  await page.locator("#cockpit-tickets-attention").check();
  await exportButton.click();
  await expect(page.getByText("Planilha Exportada com Sucesso!")).toBeVisible();
  expect(exported).toHaveLength(1);
  expect(exported[0].get("snapshot_id")).toBe("old");
  expect(exported[0].get("attention_only")).toBe("true");
  await expect(exportButton).toBeEnabled();
});

test("Chamados: limpar a versão também limpa a comparação e bloqueia a exportação", async ({ page }) => {
  await page.route("**/api/operacoes/chamados", route => route.fulfill({ json: {
    snapshot_id: "new", historico: HISTORICO,
    chamados: [{ serie: "SN-NEW", simpress: {}, oracle: [] }],
  } }));
  await page.route("**/api/operacoes/chamados/evolucao**", route => route.fulfill({ json: {
    contagens: { novos: 7, alterados: 2, iguais: 1, ausentes_arquivo: 0 }, mudancas: { novos: ["SN-NEW"] },
  } }));
  await page.goto("/");
  await page.evaluate(() => { abrirPainelCockpit("chamados"); abrirGestaoChamadosCockpit(); });
  const evolution = page.locator("#cockpit-tickets-evolution");
  await expect(evolution).toContainText("7 novas");

  await page.locator("#cockpit-tickets-version").selectOption("");
  await expect(evolution).toHaveText("Nenhuma importação selecionada.");
  await expect(evolution).not.toContainText("7 novas");
  await expect(page.locator("#cockpit-tickets-export")).toBeDisabled();
});

test("extracted DOM helpers preserve safe rendering of external content", async ({ page }) => {
  await page.goto("/");
  const rendered = await page.evaluate(() => {
    const container = document.createElement("div");
    container.innerHTML = highlightMatch('<img src=x onerror="window.injected=true"> SYNTHETIC', "SYNTHETIC");
    document.body.appendChild(container);
    const result = {
      text: container.textContent,
      images: container.querySelectorAll("img").length,
      highlights: container.querySelectorAll(".serial-match").length,
      injected: Boolean(window.injected),
    };
    result.highlightSamples = [
      ["A'039x &amp", "039"],
      ["<img src=x onerror=alert(1)> SERIAL", "serial"],
      ["serial [A].* &", "[A].*"],
      ["filial São José", "são"],
    ].map(([value, query]) => {
      const sample = document.createElement("div");
      sample.innerHTML = highlightMatch(value, query);
      const output = {
        original: value,
        text: sample.textContent,
        highlights: sample.querySelectorAll(".serial-match").length,
        images: sample.querySelectorAll("img").length,
      };
      sample.remove();
      return output;
    });
    container.remove();
    return result;
  });
  expect(rendered.images).toBe(0);
  expect(rendered.highlights).toBe(1);
  expect(rendered.injected).toBe(false);
  expect(rendered.text).toContain('<img src=x onerror="window.injected=true"> SYNTHETIC');
  expect(rendered.highlightSamples.map(sample => sample.text)).toEqual(
    rendered.highlightSamples.map(sample => sample.original),
  );
  expect(rendered.highlightSamples.map(sample => sample.highlights)).toEqual([1, 1, 1, 1]);
  expect(rendered.highlightSamples.map(sample => sample.images)).toEqual([0, 0, 0, 0]);
});
