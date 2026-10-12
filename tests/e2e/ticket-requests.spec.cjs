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
