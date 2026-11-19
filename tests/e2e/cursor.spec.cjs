const { test, expect } = require("@playwright/test");

// Cursor do Novo layout (frontend/src/ui/cursor.ts, static/styles/ck-cursor.css; contrato em docs/ui-motion/contrato-bento.md).
// Os alvos são montados num palco fixo por cima da página, para o teste não depender do conteúdo das abas.
async function palco(page) {
  await page.evaluate(() => {
    const area = document.createElement("div");
    area.id = "palco-cursor";
    for (const [prop, valor] of [["position", "fixed"], ["left", "0"], ["top", "0"], ["width", "900px"], ["height", "500px"], ["z-index", "2147482000"], ["background", "#07080d"]]) area.style.setProperty(prop, valor);
    area.innerHTML = `
      <button type="button" id="palco-botao">Atualizar base</button>
      <input id="palco-campo" placeholder="Série ou hostname">
      <section class="ck-bento-cartao" data-tom="ciano" id="palco-cartao"><div class="ck-bento-face">Cartão ciano</div></section>`;
    const posicoes = { "palco-botao": ["40px", "40px"], "palco-campo": ["40px", "140px"], "palco-cartao": ["400px", "40px"] };
    for (const [id, [left, top]] of Object.entries(posicoes)) {
      const el = area.querySelector(`#${id}`);
      el.style.setProperty("position", "absolute");
      el.style.setProperty("left", left);
      el.style.setProperty("top", top);
    }
    area.querySelector("#palco-cartao").style.setProperty("width", "300px");
    area.querySelector("#palco-cartao").style.setProperty("height", "200px");
    document.body.append(area);
  });
}

const centro = async locator => {
  const r = await locator.boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
};
const ligado = page => page.locator("html").evaluate(el => el.classList.contains("ck-cursor-on"));

test.describe("cursor com mouse", () => {
  test.skip(({ isMobile }) => isMobile, "toque usa o cursor nativo");

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await palco(page);
  });

  test("ponto segue o mouse e a onda do clique dura 250 ms", async ({ page }) => {
    await page.mouse.move(700, 450);
    await expect(page.locator(".ck-cursor")).toHaveClass(/ck-cursor--visivel/);
    expect(await ligado(page)).toBe(true);
    await expect.poll(() => page.locator(".ck-cursor__ponto").evaluate(el => el.style.transform)).toContain("translate3d(700px, 450px, 0px)");
    // Lê a duração no mesmo tique do clique, sem depender de ver a onda numa janela de 250 ms.
    await page.evaluate(() => {
      new MutationObserver((mudancas, obs) => {
        const onda = mudancas.flatMap(m => [...m.addedNodes]).find(n => n.classList?.contains("ck-cursor__onda"));
        if (!onda) return;
        obs.disconnect();
        window.__duracaoOnda = onda.getAnimations()[0]?.effect.getTiming().duration;
      }).observe(document.querySelector(".ck-cursor"), { childList: true });
    });
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__duracaoOnda)).toBe(250);
    await expect(page.locator(".ck-cursor__onda")).toHaveCount(0, { timeout: 1000 });
  });

  test("anel abraça o botão e pega a cor do cartão", async ({ page }) => {
    const botao = await centro(page.locator("#palco-botao"));
    await page.mouse.move(botao.x, botao.y, { steps: 4 });
    await expect(page.locator(".ck-cursor")).toHaveClass(/ck-cursor--abraco/);
    await expect.poll(() => page.locator(".ck-cursor__anel").evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(Math.round(botao.w + 10));

    const cartao = await centro(page.locator("#palco-cartao"));
    await page.mouse.move(cartao.x, cartao.y, { steps: 4 });
    await expect(page.locator(".ck-cursor")).not.toHaveClass(/ck-cursor--abraco/);
    const tom = await page.locator("#palco-cartao").evaluate(el => getComputedStyle(el).getPropertyValue("--tom").trim());
    expect(tom).toBe("#67e8f9"); // ciano do tema escuro (ck-bento.css)
    await expect.poll(() => page.locator(".ck-cursor").evaluate(el => el.style.getPropertyValue("--ck-cursor-cor"))).toBe(tom);

    await page.mouse.move(700, 450, { steps: 4 });
    await expect.poll(() => page.locator(".ck-cursor").evaluate(el => el.style.getPropertyValue("--ck-cursor-cor"))).toBe("");
  });

  test("some no campo de texto, no Assistente e com modal aberto; o cursor nativo volta", async ({ page }) => {
    await page.mouse.move(700, 450);
    expect(await ligado(page)).toBe(true);

    const campo = await centro(page.locator("#palco-campo"));
    await page.mouse.move(campo.x, campo.y, { steps: 4 });
    await expect(page.locator(".ck-cursor")).not.toHaveClass(/ck-cursor--visivel/);
    expect(await ligado(page)).toBe(false);
    expect(await page.locator("#palco-campo").evaluate(el => getComputedStyle(el).cursor)).not.toBe("none");

    await page.mouse.move(700, 450);
    expect(await ligado(page)).toBe(true);
    await page.evaluate(() => document.querySelector("#palco-cursor").remove());
    await page.locator("#btn-assistente").click();
    const assistente = page.locator("#assistente-widget");
    await expect(assistente).toBeVisible();
    const meio = await centro(assistente);
    await page.mouse.move(meio.x, meio.y, { steps: 4 });
    expect(await ligado(page)).toBe(false);
    await page.locator("#btn-assistente").click();
    await expect(assistente).toBeHidden();

    await page.mouse.move(700, 450);
    expect(await ligado(page)).toBe(true);
    await page.evaluate(() => {
      const dialogo = document.createElement("dialog");
      dialogo.innerHTML = `Modal <button type="button">Fechar</button>`;
      document.body.append(dialogo);
      dialogo.showModal();
    });
    // Mouse parado: o foco que entra no modal já devolve o cursor nativo.
    await expect.poll(() => ligado(page)).toBe(false);
    await expect(page.locator(".ck-cursor")).not.toHaveClass(/ck-cursor--visivel/);
  });
});

test("movimento reduzido mantém só o cursor nativo", async ({ page, isMobile }) => {
  test.skip(isMobile, "coberto pelo teste de toque");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.mouse.move(700, 450, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  expect(await ligado(page)).toBe(false);
  await expect(page.locator(".ck-cursor")).toHaveCount(0);

  // Trocar a preferência com a página aberta liga e desliga sem recarregar.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.mouse.move(710, 460, { steps: 4 });
  expect(await ligado(page)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => ligado(page)).toBe(false);
});

test("toque (pointer: coarse) não cria o cursor próprio", async ({ page, isMobile }) => {
  test.skip(!isMobile, "só no projeto mobile");
  await page.goto("/");
  await page.mouse.move(200, 300, { steps: 4 });
  await page.locator("body").tap({ position: { x: 200, y: 300 } });
  await expect(page.locator(".ck-cursor")).toHaveCount(0);
  expect(await ligado(page)).toBe(false);
});
