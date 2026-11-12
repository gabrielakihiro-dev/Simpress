const { test, expect } = require("@playwright/test");

// Aba OS (F6): sub-abas Abertas e Finalizadas sobre uma só tabela.
// Relatório, vínculos e marcas são simulados no navegador: o fixture nunca grava nada e nada vai ao SoftExpert.
// Dados sintéticos: Abertas = 5002 (SUB-A), 5003 (SUB-B), 5004 (SUB-C); Finalizadas = 5001 (SUB-A) e 5005 (SUB-D, só ela na série).

const EM = "2026-11-08T10:30:00-03:00";

function relatorio() {
  return {
    snapshot_id: "snap-sub",
    historico: [{ id: "snap-sub", atualizado_em: "2026-11-08T12:00:00Z" }],
    chamados: [
      {
        serie: "SUB-A", relacao: "conferida", simpress: { ordens_servico: ["5001", "5002"] },
        oracle: [
          { solicitacao: "R-1", ordem_servico: "5001", descricao: "Troca de bateria." },
          { solicitacao: "R-2", ordem_servico: "5002", descricao: "Tela trincada." },
        ],
      },
      { serie: "SUB-B", relacao: "somente_oracle", simpress: { ordens_servico: [] }, oracle: [{ solicitacao: "R-3", ordem_servico: "5003", descricao: "Teclado." }] },
      { serie: "SUB-C", relacao: "somente_simpress", simpress: { ordens_servico: ["5004"] }, oracle: [] },
      {
        serie: "SUB-D", relacao: "conferida", simpress: { ordens_servico: ["5005"] },
        oracle: [{ solicitacao: "R-5", ordem_servico: "5005", descricao: "Troca de fonte." }],
      },
    ],
  };
}

function marca(extra) {
  return {
    serie: "SUB-A", os: "5001", chamado: "UTIC-2026-2001", origem: "site", motivo: "", finalizado_em: EM, ativa: true, conferido_em: "",
    historico: [{ acao: "marcada", origem: "auto", em: EM }], ...extra,
  };
}

const EVENTO_PUT = { desfazer: "desfeita", refazer: "refeita", conferir: "conferida" };

// O servidor real deriva o vínculo "finalizacao" de cada marca ativa; aqui a rota faz o mesmo.
async function simular(page, { marcas = [marca(), marca({ serie: "SUB-D", os: "5005", chamado: "UTIC-2026-2005", origem: "outro_tecnico", motivo: "saiu_do_dashboard" })] } = {}) {
  const estado = { marcas: marcas.map(item => ({ ...item, historico: [...item.historico] })), puts: [], exportacoes: [], manuais: [] };
  await page.route("**/api/operacoes/chamados", route => route.request().method() === "GET"
    ? route.fulfill({ json: relatorio() }) : route.fallback());
  await page.route("**/api/operacoes/chamados/vinculos-os", route => {
    if (route.request().method() !== "GET") return route.fallback();
    const derivados = estado.marcas.filter(item => item.ativa && !estado.manuais.some(m => m.os === item.os)).map(item => ({
      fonte: "oracle", serie: item.serie, os: item.os, ano: 2026, numero: item.chamado.split("-")[2], origem: "finalizacao",
      chamado: item.chamado, finalizado_em: item.finalizado_em,
    }));
    return route.fulfill({ json: { vinculos: [...estado.manuais, ...derivados] } });
  });
  await page.route("**/api/operacoes/chamados/marcas-finalizacao", route => {
    const pedido = route.request();
    if (pedido.method() === "GET") return route.fulfill({ json: { marcas: estado.marcas } });
    if (pedido.method() !== "PUT") return route.fallback();
    const corpo = pedido.postDataJSON();
    estado.puts.push(corpo);
    const alvo = estado.marcas.find(item => item.chamado === corpo.chamado);
    if (!alvo) return route.fulfill({ status: 422, json: { detail: "Marca inexistente." } });
    if (corpo.acao === "desfazer") alvo.ativa = false;
    if (corpo.acao === "refazer") alvo.ativa = true;
    if (corpo.acao === "conferir") alvo.conferido_em = EM;
    alvo.historico.push({ acao: EVENTO_PUT[corpo.acao], origem: "manual", em: EM });
    return route.fulfill({ json: { marca: alvo } });
  });
  await page.route("**/api/operacoes/chamados/exportar**", async route => {
    estado.exportacoes.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, body: "synthetic xlsx", headers: {
      "content-type": "application/octet-stream", "content-disposition": "attachment; filename=chamados.xlsx",
    } });
  });
  return estado;
}

async function abrirF6(page) {
  await page.goto("/");
  const naBarra = await page.locator("#btn-acompanhamento-chamados").isVisible();
  if (!naBarra) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra ? "#btn-acompanhamento-chamados" : "#btn-chamados-menu").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("OS");
  // CI mobile runners can take over 5 s to render the first rows; keep it under the 20 s test timeout.
  await expect(page.locator("#ck-os-tabela tbody tr[data-serial]:visible").first()).toBeVisible({ timeout: 15_000 });
}

const ABA_ABERTAS = "#os-aba-abertas";
const ABA_FINALIZADAS = "#os-aba-finalizadas";
const VISIVEIS = "#ck-os-tabela tbody tr[data-serial]:visible";
const CONTAGEM = "#cockpit-tickets-contagem .ticket-summary-status";

async function seriesVisiveis(page) {
  return page.locator(VISIVEIS).evaluateAll(linhas => linhas.map(linha => `${linha.dataset.serial}/${linha.dataset.finalizada}`).sort());
}

async function kpis(page) {
  return page.locator("#cockpit-tickets-kpis .ck-kpi").evaluateAll(cards => Object.fromEntries(cards.map(card => [
    card.querySelector(".ck-kpi__rotulo").textContent, card.querySelector(".ck-kpi__valor").textContent,
  ])));
}

const triagem = page => page.locator("#cockpit-tickets-triage .ck-chamados-triagem__valor").allTextContents();

test("Sub-abas: Abertas é a padrão, mostra só as OS abertas e as abas expõem tablist, contagens e painel único", async ({ page }) => {
  await simular(page);
  await abrirF6(page);

  const lista = page.getByRole("tablist", { name: "OS por situação" });
  await expect(lista).toBeVisible();
  const abas = lista.getByRole("tab");
  await expect(abas).toHaveCount(2);
  await expect(abas.nth(0)).toContainText("Abertas");
  await expect(abas.nth(1)).toContainText("Finalizadas");
  await expect(abas.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(abas.nth(1)).toHaveAttribute("aria-selected", "false");
  await expect(abas.nth(0)).toHaveAttribute("aria-label", "Abertas: 3 OS");
  await expect(abas.nth(1)).toHaveAttribute("aria-label", "Finalizadas: 2 OS");
  await expect(abas.nth(0)).toHaveAttribute("tabindex", "0");
  await expect(abas.nth(1)).toHaveAttribute("tabindex", "-1");
  await expect(page.locator("#os-abertas-contagem")).toHaveText("3");
  await expect(page.locator("#os-finalizadas-contagem")).toHaveText("2");

  // Um só tabpanel, a própria tabela, rotulado pela aba ativa.
  const painel = page.locator("#cockpit-tickets-os");
  await expect(painel).toHaveAttribute("role", "tabpanel");
  await expect(painel).toHaveAttribute("aria-labelledby", "os-aba-abertas");
  await expect(abas.nth(0)).toHaveAttribute("aria-controls", "cockpit-tickets-os");
  await expect(abas.nth(1)).toHaveAttribute("aria-controls", "cockpit-tickets-os");
  await expect(page.locator('[data-cockpit-tool-panel="chamados"] [role=tabpanel]')).toHaveCount(1);

  expect(await seriesVisiveis(page)).toEqual(["SUB-A/false", "SUB-B/false", "SUB-C/false"]);
  await expect(page.locator(CONTAGEM)).toHaveText("3 OS · 3 séries");
  // O contador fica na barra das abas, não dentro da tabela.
  await expect(page.locator("#cockpit-tickets-os .ticket-summary-status")).toHaveCount(0);

  await abas.nth(1).click();
  await expect(abas.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(abas.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(painel).toHaveAttribute("aria-labelledby", "os-aba-finalizadas");
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/true", "SUB-D/true"]);
  await expect(page.locator(CONTAGEM)).toHaveText("2 OS · 2 séries");
  // O contador acompanha a sub-aba, mas os números das abas continuam os mesmos.
  await expect(abas.nth(0)).toHaveAttribute("aria-label", "Abertas: 3 OS");
  await expect(abas.nth(1)).toHaveAttribute("aria-label", "Finalizadas: 2 OS");
});

test("Sub-abas: setas, Home e End movem a seleção e o foco com tabindex rolante", async ({ page }) => {
  await simular(page);
  await abrirF6(page);
  const abertas = page.locator(ABA_ABERTAS);
  const finalizadas = page.locator(ABA_FINALIZADAS);

  await abertas.focus();
  await page.keyboard.press("ArrowRight");
  await expect(finalizadas).toBeFocused();
  await expect(finalizadas).toHaveAttribute("aria-selected", "true");
  await expect(finalizadas).toHaveAttribute("tabindex", "0");
  await expect(abertas).toHaveAttribute("tabindex", "-1");
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/true", "SUB-D/true"]);

  await page.keyboard.press("ArrowRight");
  await expect(abertas).toBeFocused();
  await expect(abertas).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(finalizadas).toBeFocused();
  await page.keyboard.press("Home");
  await expect(abertas).toBeFocused();
  await expect(page.locator("#cockpit-tickets-os")).toHaveAttribute("aria-labelledby", "os-aba-abertas");
  await page.keyboard.press("End");
  await expect(finalizadas).toBeFocused();
  await expect(page.locator("#cockpit-tickets-os")).toHaveAttribute("aria-labelledby", "os-aba-finalizadas");
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/true", "SUB-D/true"]);
});

test("Sub-abas: KPIs e triagem contam só as OS abertas e não mudam ao trocar de sub-aba", async ({ page }) => {
  await simular(page);
  await abrirF6(page);
  await expect(page.locator("#cockpit-tickets-kpis-nota")).toHaveText("KPIs e triagem contam só as OS da sub-aba Abertas.");

  const rotulos = await page.locator("#cockpit-tickets-kpis .ck-kpi__rotulo").allTextContents();
  expect(rotulos).toEqual(["OS abertas", "Séries", "Conferidas", "Divergentes", "Só Simpress", "Só Oracle"]);
  // SUB-D só tem OS finalizada: fica fora da contagem de séries e de conferidas.
  const esperado = { "OS abertas": "3", Séries: "3", Conferidas: "1", Divergentes: "0", "Só Simpress": "1", "Só Oracle": "1" };
  expect(await kpis(page)).toEqual(esperado);
  const triagemAbertas = await triagem(page);
  await expect(page.locator("#cockpit-tickets-triage")).toContainText("de 3 séries com chamado aberto");

  await page.locator(ABA_FINALIZADAS).click();
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/true", "SUB-D/true"]);
  expect(await kpis(page)).toEqual(esperado);
  expect(await triagem(page)).toEqual(triagemAbertas);
  await expect(page.locator("#cockpit-tickets-triage")).toContainText("de 3 séries com chamado aberto");

  // Filtrar também não mexe nos KPIs.
  await page.locator("#cockpit-tickets-search").fill("SUB-D");
  await expect(page.locator(VISIVEIS)).toHaveCount(1);
  expect(await kpis(page)).toEqual(esperado);
});

test("Sub-abas: busca e Relação valem nas duas sub-abas e os números das abas contam as linhas que passam nos filtros", async ({ page }) => {
  await simular(page);
  await abrirF6(page);
  const abertas = page.locator(ABA_ABERTAS);
  const finalizadas = page.locator(ABA_FINALIZADAS);

  await page.locator("#cockpit-tickets-search").fill("SUB-A");
  await expect(abertas).toHaveAttribute("aria-label", "Abertas: 1 OS");
  await expect(finalizadas).toHaveAttribute("aria-label", "Finalizadas: 1 OS");
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/false"]);
  await finalizadas.click();
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/true"]);

  await page.locator("#cockpit-tickets-search").fill("SUB-B");
  await expect(abertas).toHaveAttribute("aria-label", "Abertas: 1 OS");
  await expect(finalizadas).toHaveAttribute("aria-label", "Finalizadas: 0 OS");
  await expect(finalizadas).toHaveAttribute("data-zero", "");
  await expect(page.locator(VISIVEIS)).toHaveCount(0);
  await abertas.click();
  expect(await seriesVisiveis(page)).toEqual(["SUB-B/false"]);

  await page.locator("#cockpit-tickets-search").fill("");
  await page.locator("#cockpit-tickets-relation").selectOption("conferida");
  await expect(abertas).toHaveAttribute("aria-label", "Abertas: 1 OS");
  await expect(finalizadas).toHaveAttribute("aria-label", "Finalizadas: 2 OS");
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/false"]);

  // Limpar filtros não troca a sub-aba.
  await finalizadas.click();
  await page.locator("#cockpit-tickets-clear").click();
  await expect(abertas).toHaveAttribute("aria-label", "Abertas: 3 OS");
  await expect(finalizadas).toHaveAttribute("aria-selected", "true");
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/true", "SUB-D/true"]);
});

test("Sub-abas: Exportar Excel leva só as séries da sub-aba visível, sem mudar o texto de sucesso", async ({ page }) => {
  const estado = await simular(page);
  await abrirF6(page);
  await page.evaluate(() => abrirGestaoChamadosCockpit());
  const exportar = page.locator("#cockpit-tickets-export");
  await expect(exportar).toBeEnabled();

  const exportarEPegar = async () => {
    const antes = estado.exportacoes.length;
    await exportar.click();
    await expect(page.locator("#toast-container")).toContainText("Planilha Exportada com Sucesso!");
    await expect.poll(() => estado.exportacoes.length).toBe(antes + 1);
    await expect(exportar).toBeEnabled();
    return estado.exportacoes.at(-1);
  };

  expect([...(await exportarEPegar()).series].sort()).toEqual(["SUB-A", "SUB-B", "SUB-C"]);
  await page.locator(ABA_FINALIZADAS).click();
  expect([...(await exportarEPegar()).series].sort()).toEqual(["SUB-A", "SUB-D"]);
  await page.locator("#cockpit-tickets-search").fill("SUB-D");
  expect([...(await exportarEPegar()).series].sort()).toEqual(["SUB-D"]);
});

test("Sub-abas: Abertas mostra o campo manual; Finalizadas mostra o link automático com o selo, a data e os botões", async ({ page }) => {
  await simular(page);
  await abrirF6(page);

  // Abertas: o editor manual de sempre, sem selo automático.
  const abertaA = page.locator('#ck-os-tabela tbody tr[data-serial="SUB-A"][data-finalizada="false"]');
  await expect(abertaA.locator("input.ticket-os-link-input")).toHaveCount(1);
  await expect(abertaA.locator(".os-selo")).toHaveCount(0);

  await page.locator(ABA_FINALIZADAS).click();
  const finalizadaA = page.locator('#ck-os-tabela tbody tr[data-serial="SUB-A"][data-finalizada="true"]');
  const bloco = finalizadaA.locator(".os-chamado");
  await expect(bloco).toHaveAttribute("data-origem", "finalizacao");
  await expect(bloco.locator(".os-chamado__link")).toHaveText("UTIC-2026-2001");
  await expect(bloco.locator(".os-selo--auto")).toHaveText("Vinculado automaticamente");
  await expect(bloco.locator(".os-selo--auto svg")).toHaveCount(1);
  await expect(finalizadaA.locator("input.ticket-os-link-input")).toHaveCount(0);
  await expect(finalizadaA.locator(".ck-os-marca__selo")).toHaveText("Chamado finalizado");
  await expect(finalizadaA.locator(".os-finalizado-em")).toHaveText("Finalizado em 08/11/2026");
  await expect(finalizadaA.getByRole("button", { name: "Desfazer, chamado UTIC-2026-2001" })).toBeVisible();
  // Conferido só aparece quando o SoftExpert precisa ser conferido (finalizado por outro técnico).
  const finalizadaD = page.locator('#ck-os-tabela tbody tr[data-serial="SUB-D"][data-finalizada="true"]');
  await expect(finalizadaD.getByRole("button", { name: "Conferido, chamado UTIC-2026-2005" })).toBeVisible();
  await expect(finalizadaD.getByRole("button", { name: "Desfazer, chamado UTIC-2026-2005" })).toBeVisible();
});

test("Sub-abas: Desfazer na Finalizadas devolve a OS para Abertas com o campo manual vazio e recalcula números e KPIs", async ({ page }) => {
  const estado = await simular(page);
  await abrirF6(page);
  const abertas = page.locator(ABA_ABERTAS);
  const finalizadas = page.locator(ABA_FINALIZADAS);
  await finalizadas.click();

  await page.locator('#ck-os-tabela tbody tr[data-serial="SUB-D"]').getByRole("button", { name: "Desfazer, chamado UTIC-2026-2005" }).click();
  await expect(page.locator("#mensagem-confirmar-acao")).toContainText("não é reaberto no SoftExpert");
  await page.locator("#btn-confirmar-acao-cancelar").click();
  expect(estado.puts).toHaveLength(0);

  await page.locator('#ck-os-tabela tbody tr[data-serial="SUB-D"]').getByRole("button", { name: "Desfazer, chamado UTIC-2026-2005" }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect.poll(() => estado.puts.length).toBe(1);
  expect(estado.puts[0]).toEqual({ serie: "SUB-D", os: "5005", chamado: "UTIC-2026-2005", acao: "desfazer" });

  // A OS some das Finalizadas, os números das abas e os KPIs se recalculam e o foco volta para a aba ativa.
  await expect(finalizadas).toHaveAttribute("aria-label", "Finalizadas: 1 OS");
  await expect(abertas).toHaveAttribute("aria-label", "Abertas: 4 OS");
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/true"]);
  await expect(finalizadas).toBeFocused();
  expect(await kpis(page)).toEqual({ "OS abertas": "4", Séries: "4", Conferidas: "2", Divergentes: "0", "Só Simpress": "1", "Só Oracle": "1" });

  await abertas.click();
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/false", "SUB-B/false", "SUB-C/false", "SUB-D/false"]);
  const aberta = page.locator('#ck-os-tabela tbody tr[data-serial="SUB-D"][data-finalizada="false"]');
  const campo = aberta.locator("input.ticket-os-link-input");
  await expect(campo).toHaveCount(1);
  await expect(campo).toHaveValue("");
  await expect(aberta.locator(".os-selo")).toHaveCount(0);
  // O bloco da marca desfeita fica na linha, com o Refazer.
  await expect(aberta.locator('.ck-os-marca[data-ativa="false"]')).toHaveCount(1);
  await expect(aberta.getByRole("button", { name: "Refazer, chamado UTIC-2026-2005" })).toBeVisible();
});

test("Sub-abas: Conferido mantém a OS em Finalizadas e grava só a conferência", async ({ page }) => {
  const estado = await simular(page);
  await abrirF6(page);
  await page.locator(ABA_FINALIZADAS).click();
  const linha = page.locator('#ck-os-tabela tbody tr[data-serial="SUB-D"]');
  await linha.getByRole("button", { name: "Conferido, chamado UTIC-2026-2005" }).click();
  await expect.poll(() => estado.puts.length).toBe(1);
  expect(estado.puts[0]).toEqual({ serie: "SUB-D", os: "5005", chamado: "UTIC-2026-2005", acao: "conferir" });
  await expect(linha.getByRole("button", { name: /^Conferido/ })).toHaveCount(0);
  await expect(page.locator(ABA_FINALIZADAS)).toHaveAttribute("aria-label", "Finalizadas: 2 OS");
  expect(await seriesVisiveis(page)).toEqual(["SUB-A/true", "SUB-D/true"]);
});

test("Sub-abas: vínculo manual tem prioridade sobre o automático e o vínculo do Dashboard vira link com selo cinza em Abertas", async ({ page }) => {
  const estado = await simular(page);
  estado.manuais.push({ fonte: "oracle", serie: "SUB-A", os: "5001", ano: 2026, numero: "777", origem: undefined, chamado: "UTIC-2026-777" });
  estado.manuais.push({ fonte: "oracle", serie: "SUB-B", os: "5003", ano: 2026, numero: "3290", origem: "dashboard", chamado: "UTIC-2026-3290" });
  await abrirF6(page);

  const dashboard = page.locator('#ck-os-tabela tbody tr[data-serial="SUB-B"] .os-chamado');
  await expect(dashboard).toHaveAttribute("data-origem", "dashboard");
  await expect(dashboard.locator(".os-chamado__link")).toHaveText("UTIC-2026-3290");
  await expect(dashboard.locator(".os-selo--dashboard")).toHaveText("Do Dashboard");

  await page.locator(ABA_FINALIZADAS).click();
  const manual = page.locator('#ck-os-tabela tbody tr[data-serial="SUB-A"][data-finalizada="true"]');
  await expect(manual.locator("input.ticket-os-link-input")).toHaveValue("777");
  await expect(manual.locator(".os-selo")).toHaveCount(0);
});

test("Sub-abas: sem rolagem horizontal de 320 a 2560 px nas duas sub-abas", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "o teste troca a largura sozinho; roda uma vez");
  await simular(page);
  await abrirF6(page);
  for (const largura of [320, 390, 768, 1024, 1280, 1920, 2560]) {
    await page.setViewportSize({ width: largura, height: 900 });
    for (const aba of [ABA_ABERTAS, ABA_FINALIZADAS]) {
      await page.locator(aba).click();
      const medidas = await page.evaluate(() => ({ pagina: document.documentElement.scrollWidth, janela: window.innerWidth }));
      expect(medidas.pagina, `${aba} a ${largura}px`).toBeLessThanOrEqual(medidas.janela);
      const barra = await page.locator(".os-abas-barra").boundingBox();
      expect(barra.x + barra.width, `barra a ${largura}px`).toBeLessThanOrEqual(largura + 1);
    }
  }
});

test("Sub-abas: abas com 44 px de altura, borda de 2 px na ativa e duas colunas abaixo de 768 px", async ({ page }, testInfo) => {
  await simular(page);
  await abrirF6(page);
  const ativa = page.locator(ABA_ABERTAS);
  const inativa = page.locator(ABA_FINALIZADAS);
  // offsetHeight ignora transformações em andamento; boundingBox pode dar 43,99997 no meio de uma animação.
  expect(await ativa.evaluate(no => no.offsetHeight)).toBeGreaterThanOrEqual(44);
  expect(await inativa.evaluate(no => no.offsetHeight)).toBeGreaterThanOrEqual(44);
  const estilo = await ativa.evaluate(no => { const css = getComputedStyle(no); return { borda: css.borderBottomWidth, peso: css.fontWeight }; });
  expect(estilo.borda).toBe("2px");
  expect(Number(estilo.peso)).toBeGreaterThanOrEqual(600);
  expect(await inativa.evaluate(no => getComputedStyle(no).borderBottomColor)).not.toBe(await ativa.evaluate(no => getComputedStyle(no).borderBottomColor));
  const a = await ativa.boundingBox();
  const b = await inativa.boundingBox();
  if (testInfo.project.name === "mobile") {
    // Grade de duas colunas: lado a lado, mesma altura da linha.
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(Math.abs(a.width - b.width)).toBeLessThan(2);
  }
});

test("Sub-abas: no celular, os controles dos cartões das duas sub-abas têm alvo de toque de pelo menos 44 px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "cartões só existem abaixo de 768 px");
  await simular(page);
  await abrirF6(page);
  for (const aba of [ABA_ABERTAS, ABA_FINALIZADAS]) {
    await page.locator(aba).click();
    const alvos = await page.evaluate(() => {
      const controles = "a[href], button, input:not([type=hidden]):not([type=checkbox]), select, summary";
      return [...document.querySelectorAll("#ck-os-tabela tbody tr[data-serial]")].filter(linha => linha.getClientRects().length)
        .flatMap(linha => [...linha.querySelectorAll(controles)].filter(no => no.getClientRects().length)
          .map(no => ({ serie: linha.dataset.serial, controle: (no.textContent || no.className).trim().slice(0, 24), altura: Math.round(no.getBoundingClientRect().height) })));
    });
    expect(alvos.length, `controles em ${aba}`).toBeGreaterThan(3);
    expect(alvos.filter(alvo => alvo.altura < 44), `controles abaixo de 44 px em ${aba}`).toEqual([]);
  }
  // Os controles novos desta tarefa estão entre os medidos: link do chamado vinculado e botões da marca.
  await expect(page.locator('#ck-os-tabela tbody tr[data-serial="SUB-D"][data-finalizada="true"] .os-chamado__link')).toBeVisible();
});

test("Sub-abas: movimento reduzido desliga a transição das abas e a animação dura entre 150 e 300 ms no normal", async ({ page }) => {
  await simular(page);
  await abrirF6(page);
  const normal = await page.locator(ABA_ABERTAS).evaluate(no => parseFloat(getComputedStyle(no).transitionDuration));
  expect(normal).toBeGreaterThanOrEqual(0.15);
  expect(normal).toBeLessThanOrEqual(0.3);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduzido = await page.locator(ABA_ABERTAS).evaluate(no => parseFloat(getComputedStyle(no).transitionDuration));
  expect(reduzido).toBeLessThan(0.01);
});
