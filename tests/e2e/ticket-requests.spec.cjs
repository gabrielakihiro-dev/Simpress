const { test, expect } = require("@playwright/test");

test("ticket selection keeps the latest snapshot after overlapping responses", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#stat-equipamentos")).toHaveText("1");
  let releaseOld;
  let notifyOldRequested;
  const oldRequested = new Promise(resolve => { notifyOldRequested = resolve; });
  await page.route("**/api/operacoes/chamados/snapshot/old", async route => {
    notifyOldRequested();
    await new Promise(release => { releaseOld = release; });
    await route.fulfill({ json: { snapshot_id: "old", chamados: [{ serie: "SN-OLD", simpress: {}, oracle: [] }] } }).catch(() => {});
  });
  await page.route("**/api/operacoes/chamados/snapshot/latest", route => route.fulfill({
    json: { snapshot_id: "latest", chamados: [{ serie: "SN-LATEST", simpress: {}, oracle: [] }] },
  }));
  await page.evaluate(() => {
    const select = document.getElementById("versao-acompanhamento-chamados");
    select.replaceChildren(new Option("Old", "old"), new Option("Latest", "latest"));
    select.value = "old";
    window.testOldSelection = selecionarVersaoChamados();
  });
  await oldRequested;
  await page.evaluate(async () => {
    document.getElementById("versao-acompanhamento-chamados").value = "latest";
    await selecionarVersaoChamados();
  });
  releaseOld();
  await page.evaluate(() => window.testOldSelection);
  expect(await page.evaluate(() => acompanhamentoChamadosAtual.snapshot_id)).toBe("latest");
  expect(await page.locator("#lista-acompanhamento-chamados").textContent()).toContain("SN-LATEST");
  expect(await page.locator("#lista-acompanhamento-chamados").textContent()).not.toContain("SN-OLD");
});

test("ticket export stays bound to the selected snapshot while it loads", async ({ page }) => {
  let releaseLoading;
  let notifyLoading;
  const loadingStarted = new Promise(resolve => { notifyLoading = resolve; });
  const exportedSnapshots = [];
  await page.route("**/api/operacoes/chamados", route => route.fulfill({ json: {
    snapshot_id: "old",
    historico: [
      { id: "new", atualizado_em: "2026-10-12T12:00:00Z" },
      { id: "old", atualizado_em: "2026-10-11T12:00:00Z" },
    ],
    chamados: [{ serie: "SN-OLD", simpress: {}, oracle: [] }],
  } }));
  await page.route("**/api/operacoes/chamados/snapshot/new", async route => {
    notifyLoading();
    await new Promise(resolve => { releaseLoading = resolve; });
    await route.fulfill({ json: {
      snapshot_id: "new",
      chamados: [{ serie: "SN-NEW", simpress: {}, oracle: [] }],
    } }).catch(() => {});
  });
  await page.route("**/api/operacoes/chamados/evolucao**", route => route.fulfill({ json: {
    contagens: { novos: 1, alterados: 0, iguais: 0, ausentes_arquivo: 0 },
    mudancas: { novos: ["SN-NEW"] },
  } }));
  await page.route("**/api/operacoes/chamados/exportar**", async route => {
    exportedSnapshots.push(new URL(route.request().url()).searchParams.get("snapshot_id"));
    await route.fulfill({ status: 200, body: "synthetic xlsx", headers: {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename=chamados.xlsx",
    } });
  });

  await page.goto("/");
  await expect(page.locator("#stat-equipamentos")).toHaveText("1", { timeout: 15_000 });
  await page.evaluate(() => abrirAcompanhamentoChamados());
  const selector = page.locator("#versao-acompanhamento-chamados");
  const exportButton = page.locator("#btn-exportar-acompanhamento-chamados");
  await expect(selector).toHaveValue("old");
  await expect(page.locator("#lista-acompanhamento-chamados")).toContainText("SN-OLD");

  try {
    await page.evaluate(() => {
      document.getElementById("versao-acompanhamento-chamados").value = "new";
      window.pendingSnapshotLoad = selecionarVersaoChamados();
    });
    await loadingStarted;
    await expect(exportButton).toBeDisabled();
    await page.evaluate(() => exportarAcompanhamentoChamados());
    expect(exportedSnapshots).toEqual([]);

    releaseLoading();
    await page.evaluate(() => window.pendingSnapshotLoad);
    await expect(page.locator("#lista-acompanhamento-chamados")).toContainText("SN-NEW");
    await expect(exportButton).toBeEnabled();
    await page.evaluate(() => exportarAcompanhamentoChamados());
    expect(exportedSnapshots).toEqual(["new"]);
  } finally {
    releaseLoading?.();
  }
});

test("clearing the ticket snapshot also clears its comparison", async ({ page }) => {
  await page.route("**/api/operacoes/chamados", route => route.fulfill({ json: {
    snapshot_id: "new",
    historico: [
      { id: "new", atualizado_em: "2026-10-12T12:00:00Z" },
      { id: "old", atualizado_em: "2026-10-11T12:00:00Z" },
    ],
    chamados: [{ serie: "SN-NEW", simpress: {}, oracle: [] }],
  } }));
  await page.route("**/api/operacoes/chamados/evolucao**", route => route.fulfill({ json: {
    contagens: { novos: 7, alterados: 2, iguais: 1, ausentes_arquivo: 0 },
    mudancas: { novos: ["SN-NEW"] },
  } }));

  await page.goto("/");
  await expect(page.locator("#stat-equipamentos")).toHaveText("1");
  await page.evaluate(() => abrirAcompanhamentoChamados());
  const evolution = page.locator("#evolucao-acompanhamento-chamados");
  await expect(evolution).toContainText("7 novas");

  await page.evaluate(async () => {
    document.getElementById("versao-acompanhamento-chamados").value = "";
    await selecionarVersaoChamados();
  });
  expect(await page.evaluate(() => acompanhamentoChamadosAtual)).toBeNull();
  await expect(evolution).toHaveText("Nenhuma importação selecionada.");
  await expect(evolution).not.toContainText("7 novas");
});

test("extracted DOM helpers preserve safe rendering of external content", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#stat-equipamentos")).toHaveText("1");
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
