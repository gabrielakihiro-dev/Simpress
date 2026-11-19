const { test, expect } = require("@playwright/test");

const HISTORICO = [
  { id: "new", atualizado_em: "2026-10-12T12:00:00Z" },
  { id: "old", atualizado_em: "2026-10-11T12:00:00Z" },
];

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

test("Chamados: na versão da tabela, Exportar Excel manda por POST as séries que a tela filtra", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => { abrirPainelCockpit("chamados"); abrirGestaoChamadosCockpit(); });
  const row = page.locator('tbody tr[data-serial="DEMO-SN-001"]').first();
  await expect(row).toBeAttached();
  const exportar = async () => {
    const request = page.waitForRequest(req => req.url().includes("/api/operacoes/chamados/exportar"));
    await page.locator("#cockpit-tickets-export").click();
    return request;
  };
  let request = await exportar();
  expect(request.method()).toBe("POST");
  expect(request.postDataJSON()).toMatchObject({ snapshot_id: "20261009_120000", series: ["DEMO-SN-001"], search: "" });
  await expect(page.locator("#cockpit-tickets-export")).toBeEnabled();

  await page.locator("#cockpit-tickets-search").fill("nada-casa-com-isto");
  await expect(row).toBeHidden();
  request = await exportar();
  expect(request.postDataJSON()).toMatchObject({ series: [], search: "nada-casa-com-isto" });
});

test("Chamados: limpar a versão bloqueia a exportação", async ({ page }) => {
  await page.route("**/api/operacoes/chamados", route => route.fulfill({ json: {
    snapshot_id: "new", historico: HISTORICO,
    chamados: [{ serie: "SN-NEW", simpress: {}, oracle: [] }],
  } }));
  await page.route("**/api/operacoes/chamados/evolucao**", route => route.fulfill({ json: {
    contagens: { novos: 7, alterados: 2, iguais: 1, ausentes_arquivo: 0 }, mudancas: { novos: ["SN-NEW"] },
  } }));
  await page.goto("/");
  await page.evaluate(() => { abrirPainelCockpit("chamados"); abrirGestaoChamadosCockpit(); });
  await page.locator("#cockpit-tickets-version").selectOption("");
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
