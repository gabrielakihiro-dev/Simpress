const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// Home "Dossiê do equipamento" (F1). Every /api/equipamento/** call is stubbed here: no test reaches the real
// backend or the imports. Series, OS and tickets are fictional.

const EQUIPAMENTO = { serial: "LENTO", modelo: "Notebook de teste", tipo: "Notebook", apelido: "TESTE-001", nome_pessoa: "Pessoa Teste" };
const TITULO_HISTORICO = "Mudanças da série nas importações de OS";
const ERRO = "Não foi possível carregar o dossiê. Tente de novo.";

// Real backend shape: `serie` is the spelling of the report row, which differs from the registry one ("LENTO") on purpose.
const SERIE_LINHA = "LENTO-01";
const ordem = (os, extra = {}) => ({ fonte: "oracle", serie: SERIE_LINHA, os, status: "Em atendimento", fila: "Fila Teste", dias_aberta: 7, utic: null, ...extra });
const ORDENS = [
  ordem("OS-1001", { utic: { chamado: "CH-2001", origem: "Manual" } }),
  ordem("OS-1002", { fonte: "simpress", status: "Aguardando peça", fila: "", dias_aberta: null, utic: { chamado: "CH-2002", origem: "Dashboard" } }),
];
// `anterior` and `atual` are arrays, as the importer writes them; an empty array is "(vazio)".
const EVENTOS = [
  {
    atualizado_em: "2026-11-05T09:30:00", tipo: "Dados alterados",
    mudancas: [
      { campo: "Status Oracle", anterior: ["Aberto", "Em fila"], atual: ["Em atendimento"] },
      { campo: "Fila Oracle", anterior: [], atual: ["Fila Teste"] },
    ],
  },
  { atualizado_em: "2026-11-03T08:00:00", tipo: "Importação inicial", mudancas: [{ campo: "OS Oracle", anterior: [], atual: ["OS-1001", "OS-1002"] }] },
];

function dossie(serie, os = {}) {
  return {
    serie,
    modelo: "Notebook de teste",
    os: {
      estado: "ok", mensagem: "", total_importacoes: 3, ultima_importacao_em: "2026-11-10T08:00:00", presente_na_ultima: true,
      ultima_vez_observada_em: null, ordens: ORDENS, historico: { titulo: TITULO_HISTORICO, eventos: EVENTOS, total: EVENTOS.length }, ...os,
    },
  };
}

// A promise the test releases by hand, to hold a response while the screen does something else.
function segurar() {
  const controle = {};
  controle.espera = new Promise(resolver => { controle.liberar = resolver; });
  controle.respondida = new Promise(resolver => { controle.concluir = resolver; });
  return controle;
}

// Fake GET /api/equipamento/{série}/dossie: records each series asked for; `resolver(route, serie)` answers.
async function prepararDossie(page, resolver) {
  const pedidos = [];
  await page.route("**/api/equipamento/*/dossie", async route => {
    const serie = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]);
    pedidos.push(serie);
    await resolver(route, serie);
  });
  return pedidos;
}

// Records every fetch whose signal was aborted: the proof that "Fechar" and a series change cancel the request.
async function registrarAbortos(page) {
  await page.addInitScript(() => {
    window.__abortados = [];
    const original = window.fetch;
    window.fetch = function (entrada, opcoes) {
      const url = String(entrada && entrada.url ? entrada.url : entrada);
      if (opcoes && opcoes.signal) opcoes.signal.addEventListener("abort", () => window.__abortados.push(url));
      return original.apply(this, arguments);
    };
  });
}

async function abrirHome(page) {
  await page.route("**/api/equipamento/*", route => {
    const serie = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    return route.fulfill({ json: { ...EQUIPAMENTO, serial: serie } });
  });
  await page.goto("/");
}

async function buscar(page, serie) {
  await page.locator("#input-serial").fill(serie);
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText(serie);
}

async function abrirDossie(page, serie = "LENTO") {
  await abrirHome(page);
  await buscar(page, serie);
  await page.locator("#btn-ver-dossie").click();
  await expect(page.locator("#modal-dossie-equipamento")).toBeVisible();
}

const modal = page => page.locator("#modal-dossie-equipamento");
const linhas = page => page.locator("#dossie-os-linhas tr");
const emFoco = page => page.evaluate(() => {
  const ativo = document.activeElement;
  return { dentro: Boolean(ativo && ativo.closest("#modal-dossie-equipamento")), id: ativo ? ativo.id : "", rotulo: ativo ? ativo.getAttribute("aria-label") || ativo.textContent.trim() : "" };
});

test("Ver dossiê stays disabled until an equipment is selected", async ({ page }) => {
  await abrirHome(page);
  await expect(page.locator("#btn-ver-dossie")).toBeDisabled();
  await buscar(page, "LENTO");
  await expect(page.locator("#btn-ver-dossie")).toBeEnabled();
});

test("opens with the serial, the title, the table and the history", async ({ page }) => {
  const resposta = segurar();
  const pedidos = await prepararDossie(page, async route => { await resposta.espera; await route.fulfill({ json: dossie("LENTO") }); });
  await abrirDossie(page);
  await expect(page.getByRole("heading", { name: "Dossiê do equipamento" })).toBeVisible();
  await expect(page.locator("#dossie-serie")).toHaveText("LENTO");
  await expect(page.locator("#dossie-modelo")).toHaveText("Notebook de teste");
  await expect(page.locator("#dossie-status")).toHaveText("Carregando dossiê…");
  await expect(page.locator("#dossie-os")).toBeHidden();
  expect(pedidos).toEqual(["LENTO"]);
  resposta.liberar();

  await expect(page.locator("#dossie-status")).toBeHidden();
  await expect(page.getByRole("heading", { name: "OS e chamados" })).toBeVisible();
  await expect(page.locator("#dossie-os-importacoes")).toHaveText("Importações disponíveis: 3");
  await expect(page.locator("#dossie-os-observada")).toBeHidden();
  await expect(page.locator("#modal-dossie-equipamento thead th")).toHaveText(["OS", "Fonte", "Status", "Fila", "Dias aberta", "UTIC", "Ver OS"]);
  await expect(linhas(page)).toHaveCount(2);
  const primeira = linhas(page).nth(0).locator("td");
  await expect(primeira.nth(0)).toHaveText("OS-1001");
  await expect(primeira.nth(1)).toHaveText("Oracle");
  await expect(primeira.nth(2)).toHaveText("Em atendimento");
  await expect(primeira.nth(3)).toHaveText("Fila Teste");
  await expect(primeira.nth(4)).toHaveText("7");
  await expect(primeira.nth(5)).toHaveText("CH-2001 Manual");
  const segunda = linhas(page).nth(1).locator("td");
  await expect(segunda.nth(1)).toHaveText("Simpress");
  await expect(segunda.nth(3)).toHaveText("—");
  await expect(segunda.nth(4)).toHaveText("—");
  await expect(segunda.nth(5)).toHaveText("CH-2002 Dashboard");
  await expect(modal(page).getByRole("button", { name: /^Ver OS/ })).toHaveCount(2);
  await expect(page.locator("#dossie-historico-titulo")).toHaveText(TITULO_HISTORICO);
  await expect(page.locator("#dossie-historico-lista > li")).toHaveCount(2);
  await expect(page.locator("#dossie-historico-lista > li").first()).toContainText("05/11/2026");
  await expect(page.locator("#dossie-historico-lista > li").first()).toContainText("Dados alterados");
  await expect(page.locator("#dossie-historico-lista > li").first().locator("time")).toHaveAttribute("datetime", "2026-11-05T09:30:00");
  const mudancasPrimeiro = page.locator("#dossie-historico-lista > li").first().locator("ul > li");
  await expect(mudancasPrimeiro).toHaveText(["Status Oracle: Aberto, Em fila → Em atendimento", "Fila Oracle: (vazio) → Fila Teste"]);
  const eventoInicial = page.locator("#dossie-historico-lista > li").nth(1);
  await expect(eventoInicial).toContainText("Importação inicial");
  await expect(eventoInicial.locator("ul > li")).toHaveText(["OS Oracle: (vazio) → OS-1001, OS-1002"]);
  await expect(page.locator("#dossie-historico-lista")).not.toContainText("[object");
  await expect(page.locator("#dossie-historico-lista")).not.toContainText("OS-1001,OS-1002");
  await expect(page.locator("#dossie-historico-vazio")).toBeHidden();
});

test("Ver OS closes the dialog and opens the OS in the OS tab with the series of the report row", async ({ page }) => {
  await prepararDossie(page, route => route.fulfill({ json: dossie("LENTO") }));
  await abrirDossie(page);
  await page.evaluate(() => { window.__verOs = []; window.abrirChamadoDaOs = (...args) => { window.__verOs.push(args); }; });
  await expect(linhas(page)).toHaveCount(2);
  await modal(page).getByRole("button", { name: "Ver OS OS-1002" }).click();
  await expect(modal(page)).toBeHidden();
  expect(await page.evaluate(() => window.__verOs)).toEqual([[[], SERIE_LINHA, "OS-1002"]]);
});

test("Ver OS falls back to the open series when the order carries none", async ({ page }) => {
  await prepararDossie(page, route => route.fulfill({ json: dossie("LENTO", { ordens: [ordem("OS-1001", { serie: undefined })] }) }));
  await abrirDossie(page);
  await page.evaluate(() => { window.__verOs = []; window.abrirChamadoDaOs = (...args) => { window.__verOs.push(args); }; });
  await expect(linhas(page)).toHaveCount(1);
  await modal(page).getByRole("button", { name: "Ver OS OS-1001" }).click();
  expect(await page.evaluate(() => window.__verOs)).toEqual([[[], "LENTO", "OS-1001"]]);
});

test("without OS in the latest import there is no table and no Ver OS", async ({ page }) => {
  await prepararDossie(page, route => route.fulfill({ json: dossie("LENTO", {
    ordens: [], presente_na_ultima: false, ultima_vez_observada_em: "2026-11-05T09:30:00", historico: { titulo: TITULO_HISTORICO, eventos: [], total: 0 },
  }) }));
  await abrirDossie(page);
  await expect(page.locator("#dossie-os-importacoes")).toHaveText("Importações disponíveis: 3");
  await expect(page.locator("#dossie-os-observada")).toContainText("Última vez observada em");
  await expect(page.locator("#dossie-os-observada")).toContainText("05/11/2026");
  await expect(modal(page)).not.toContainText(/encerrad/i);
  await expect(page.locator("#dossie-os-ordens")).toBeHidden();
  await expect(modal(page).getByRole("button", { name: /Ver OS/ })).toHaveCount(0);
  await expect(page.locator("#dossie-historico-titulo")).toHaveText(TITULO_HISTORICO);
  await expect(page.locator("#dossie-historico-vazio")).toHaveText("Sem mudanças registradas.");
  await expect(page.locator("#dossie-historico-lista > li")).toHaveCount(0);
});

for (const [estado, mensagem] of [["sem_base", "Sem base importada"], ["sem_registros", "Sem registros para esta série"], ["indisponivel", "Fonte indisponível"]]) {
  test(`state ${estado} shows only its message`, async ({ page }) => {
    await prepararDossie(page, route => route.fulfill({ json: dossie("LENTO", { estado, mensagem, ordens: [], historico: { titulo: "", eventos: [], total: 0 } }) }));
    await abrirDossie(page);
    await expect(page.locator("#dossie-os-mensagem")).toHaveText(mensagem);
    await expect(page.locator("#dossie-serie")).toHaveText("LENTO"); // the header stays
    await expect(page.locator("#dossie-os-importacoes")).toBeHidden();
    await expect(page.locator("#dossie-os-ordens")).toBeHidden();
    await expect(page.locator("#dossie-historico")).toBeHidden();
    await expect(modal(page).getByRole("button", { name: /Ver OS/ })).toHaveCount(0);
  });
}

test("a failed request shows the approved error and never the server detail", async ({ page }) => {
  await prepararDossie(page, route => route.fulfill({ status: 500, json: { detail: "Detalhe interno do servidor" } }));
  await abrirDossie(page);
  await expect(page.locator("#dossie-status")).toHaveText(ERRO);
  await expect(modal(page)).not.toContainText("Detalhe interno do servidor");
  await expect(page.locator("#dossie-os")).toBeHidden();
  await page.locator("#dossie-fechar").click();
  await expect(modal(page)).toBeHidden();
});

test("a failed answer after the selection moved without notice closes the dialog instead of leaving it loading", async ({ page }) => {
  const lenta = segurar();
  await prepararDossie(page, async route => {
    await lenta.espera;
    await route.fulfill({ status: 500, json: { detail: "Detalhe interno do servidor" } });
    lenta.concluir();
  });
  await abrirHome(page);
  await buscar(page, "SERIE-A");
  await page.locator("#btn-ver-dossie").click();
  await expect(page.locator("#dossie-status")).toHaveText("Carregando dossiê…");
  // Moves the selection without telling the dossier (the hook of definirEquipamentoAtual is silenced), so only the late error can notice.
  await page.evaluate(equipamento => { window.atualizarDossieEquipamento = () => undefined; window.definirEquipamentoAtual(equipamento); }, { ...EQUIPAMENTO, serial: "SERIE-B" });
  await expect(modal(page)).toBeVisible();
  lenta.liberar();
  await lenta.respondida;
  await expect(modal(page)).toBeHidden();
  await expect(page.locator("#dossie-status")).not.toHaveText(ERRO);
  await expect(page.locator("#btn-ver-dossie")).toBeFocused();
});

test("closing while loading aborts the request and a quick series switch keeps the second answer", async ({ page }) => {
  await registrarAbortos(page);
  const lenta = segurar();
  const pedidos = await prepararDossie(page, async (route, serie) => {
    if (serie !== "SERIE-A") return route.fulfill({ json: dossie(serie, { ordens: [ordem("OS-B")] }) });
    await lenta.espera;
    await route.fulfill({ json: dossie(serie, { ordens: [ordem("OS-A")] }) }).catch(() => undefined); // already cancelled by the page
    lenta.concluir();
  });
  await abrirHome(page);
  await buscar(page, "SERIE-A");
  await page.locator("#btn-ver-dossie").click();
  await expect(page.locator("#dossie-status")).toHaveText("Carregando dossiê…");
  await expect.poll(() => pedidos).toEqual(["SERIE-A"]);
  await page.locator("#dossie-fechar").click();
  await expect(modal(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__abortados.filter(url => url.includes("/dossie")))).toEqual([expect.stringContaining("/api/equipamento/SERIE-A/dossie")]);

  await buscar(page, "SERIE-B");
  await page.locator("#btn-ver-dossie").click();
  await expect(page.locator("#dossie-serie")).toHaveText("SERIE-B");
  await expect(linhas(page)).toHaveCount(1);
  await expect(linhas(page).first().locator("td").first()).toHaveText("OS-B");

  lenta.liberar(); // the slow answer of the first series arrives late
  await lenta.respondida;
  await page.evaluate(() => new Promise(resolver => requestAnimationFrame(() => requestAnimationFrame(resolver))));
  await expect(page.locator("#dossie-serie")).toHaveText("SERIE-B");
  await expect(linhas(page)).toHaveCount(1);
  await expect(modal(page)).not.toContainText("OS-A");
});

test("changing the series under the open dialog closes it, aborts the request and drops the late answer", async ({ page }) => {
  await registrarAbortos(page);
  const lenta = segurar();
  await prepararDossie(page, async (route, serie) => {
    await lenta.espera;
    await route.fulfill({ json: dossie(serie, { ordens: [ordem("OS-A")] }) }).catch(() => undefined);
    lenta.concluir();
  });
  await abrirHome(page);
  await buscar(page, "SERIE-A");
  await page.locator("#btn-ver-dossie").click();
  await expect(page.locator("#dossie-status")).toHaveText("Carregando dossiê…");
  await page.evaluate(equipamento => window.definirEquipamentoAtual(equipamento), { ...EQUIPAMENTO, serial: "SERIE-B" });
  await expect(modal(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__abortados.filter(url => url.includes("/dossie")))).toEqual([expect.stringContaining("/api/equipamento/SERIE-A/dossie")]);
  lenta.liberar();
  await lenta.respondida;
  await page.evaluate(() => new Promise(resolver => requestAnimationFrame(() => requestAnimationFrame(resolver))));
  await expect(modal(page)).toBeHidden();
  await expect(page.locator("#dossie-os")).toBeHidden();
  await expect(linhas(page)).toHaveCount(0);
});

test("Fechar and Esc return the focus to Ver dossiê", async ({ page }) => {
  await prepararDossie(page, route => route.fulfill({ json: dossie("LENTO") }));
  await abrirDossie(page);
  await expect(page.locator("#dossie-fechar")).toBeFocused();
  await page.locator("#dossie-fechar").click();
  await expect(modal(page)).toBeHidden();
  await expect(page.locator("#btn-ver-dossie")).toBeFocused();

  await page.locator("#btn-ver-dossie").click();
  await expect(modal(page)).toBeVisible();
  await expect(linhas(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(modal(page)).toBeHidden();
  await expect(page.locator("#btn-ver-dossie")).toBeFocused();
});

test("the keyboard stays inside the dialog and Enter on Ver OS follows the OS", async ({ page }) => {
  await prepararDossie(page, route => route.fulfill({ json: dossie("LENTO") }));
  await abrirDossie(page);
  await page.evaluate(() => { window.__verOs = []; window.abrirChamadoDaOs = (...args) => { window.__verOs.push(args); }; });
  await expect(linhas(page)).toHaveCount(2);
  await expect(page.locator("#dossie-fechar")).toBeFocused();
  const percurso = [];
  for (let passo = 0; passo < 4; passo += 1) {
    await page.keyboard.press("Tab");
    const foco = await emFoco(page);
    expect(foco.dentro).toBe(true);
    percurso.push(foco.rotulo);
  }
  expect(percurso).toEqual(["Ver OS OS-1001", "Ver OS OS-1002", "Fechar", "Ver OS OS-1001"]);
  await page.keyboard.press("Shift+Tab");
  expect((await emFoco(page)).rotulo).toBe("Fechar");
  await page.keyboard.press("Shift+Tab");
  expect((await emFoco(page)).rotulo).toBe("Ver OS OS-1002");
  await page.keyboard.press("Enter");
  await expect(modal(page)).toBeHidden();
  expect(await page.evaluate(() => window.__verOs)).toEqual([[[], SERIE_LINHA, "OS-1002"]]);
});

test("the dialog fits 320 px without horizontal scroll and stays readable in both themes", async ({ page }) => {
  await prepararDossie(page, route => route.fulfill({ json: dossie("LENTO") }));
  await abrirHome(page);
  await buscar(page, "LENTO");
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator("#btn-ver-dossie").click();
  await expect(linhas(page)).toHaveCount(2);
  // 320 px (cards) and 1366 px (table with visible thead) both go through the theme and contrast checks.
  for (const [largura, tema] of [[320, "dark"], [320, "light"], [1366, "dark"], [1366, "light"]]) {
    await page.setViewportSize({ width: largura, height: 800 });
    await page.emulateMedia({ colorScheme: tema });
    await page.locator("html").evaluate((raiz, valor) => { raiz.dataset.theme = valor; }, tema);
    await modal(page).evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined))); });
    await expect(modal(page)).toBeVisible();
    const medidas = await page.evaluate(() => ({
      pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialogo: document.querySelector("#modal-dossie-equipamento > .ck-dialogo").getBoundingClientRect().right - document.documentElement.clientWidth,
      corpo: (() => { const d = document.querySelector("#modal-dossie-equipamento > .ck-dialogo"); return d.scrollWidth - d.clientWidth; })(),
    }));
    expect(medidas.pagina).toBeLessThanOrEqual(0);
    expect(medidas.dialogo).toBeLessThanOrEqual(0);
    expect(medidas.corpo).toBeLessThanOrEqual(0);
    const cores = await page.evaluate(() => ({
      titulo: getComputedStyle(document.querySelector("#titulo-dossie-equipamento")).color,
      fundo: getComputedStyle(document.querySelector("#modal-dossie-equipamento > .ck-dialogo")).backgroundColor,
    }));
    expect(cores.titulo).not.toBe(cores.fundo);
    const resultado = await new AxeBuilder({ page }).include("#modal-dossie-equipamento").withRules(["color-contrast", "button-name", "label-content-name-mismatch"]).analyze();
    expect(resultado.violations.flatMap(({ nodes }) => nodes.map(({ target, failureSummary }) => ({ target, failureSummary })))).toEqual([]);
  }
});

test("narrow screens show one column of cards, wide screens show the table, never a horizontal scroll", async ({ page }) => {
  await prepararDossie(page, route => route.fulfill({ json: dossie("LENTO") }));
  await abrirDossie(page);
  await expect(linhas(page)).toHaveCount(2);
  const estreita = (page.viewportSize()?.width ?? 0) < 768;
  const medidas = await page.evaluate(() => {
    const caixa = seletor => document.querySelector(seletor).getBoundingClientRect();
    const celulas = [...document.querySelectorAll("#dossie-os-linhas tr:first-child td")].map(td => td.getBoundingClientRect());
    return {
      pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialogo: caixa("#modal-dossie-equipamento > .ck-dialogo").right - document.documentElement.clientWidth,
      cabecalho: getComputedStyle(document.querySelector("#modal-dossie-equipamento thead")).position,
      linha: caixa("#dossie-os-linhas tr:first-child"),
      lefts: celulas.map(c => Math.round(c.left)),
      tops: celulas.map(c => Math.round(c.top)),
      larguras: celulas.map(c => Math.round(c.width)),
    };
  });
  expect(medidas.pagina).toBeLessThanOrEqual(0);
  expect(medidas.dialogo).toBeLessThanOrEqual(0);
  if (estreita) {
    expect(medidas.cabecalho).toBe("absolute"); // header hidden: each row is a card
    expect(new Set(medidas.lefts).size).toBe(1); // one column: every field on the same left edge
    expect([...medidas.tops].sort((a, b) => a - b)).toEqual(medidas.tops); // stacked top to bottom
    expect(new Set(medidas.tops).size).toBe(medidas.tops.length);
    expect(Math.max(...medidas.larguras)).toBeLessThanOrEqual(Math.round(medidas.linha.width));
    await expect(linhas(page).first().locator("td").first()).toHaveAttribute("data-label", "OS");
    await expect(modal(page).getByRole("button", { name: "Ver OS OS-1001" })).toBeVisible();
    await expect(modal(page).getByRole("button", { name: "Ver OS OS-1002" })).toBeVisible();
  } else {
    expect(medidas.cabecalho).not.toBe("absolute"); // header visible: real table
    expect(new Set(medidas.tops).size).toBe(1); // one line
  }
});
