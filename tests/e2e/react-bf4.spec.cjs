// Bloco final 4 (BF4): ferramentas do Cockpit (OS F6, Resumo F3, Histórico de apelidos F7, Relatório mensal F8,
// Planilhas e a janela Chamado x OS) migradas para o painel React ferramentas-cockpit
// (frontend/src/paineis/ferramentas-cockpit/). frontend/src/aplicacao/cockpit-tool-panels.ts virou só a ponte.
//
// Só dados sintéticos: o servidor de fixture (tests/support/serve_ui_motion_preview.py) responde a todo /api/*; nada é
// simulado aqui. O que se prova é o que o usuário vê (botão, atalho, título, <kbd>, ARIA, foco, Escape) e o contrato com
// a página: window.abrirPainelCockpit / fecharPainelCockpit e window.SimpressReact["ferramentas-cockpit"].
const { test, expect } = require("@playwright/test");

test.use({ timezoneId: "America/Sao_Paulo", locale: "pt-BR" });

const PAINEL = '[data-react-painel="ferramentas-cockpit"]';
const RAIZ = "#cockpit-tool-panels";
const TITULO = "#cockpit-tool-title";

const ACOES_DA_PONTE = [
  "abrirPainelCockpit", "fecharPainelCockpit", "abrirComparacaoDaSerie", "abrirChamadosDoEquipamento", "abrirChamadoDaOs",
  "abrirJanelaChamadoOs", "abrirReferenciaLembrete", "fecharJanelaChamadoOs", "destacarLinhaCockpit", "filterTicketRecords",
  "mostrarResultadoNaAbaComparacao",
];

// barra: botão da barra principal (some abaixo de 1200px, exceto o Resumo); menu: item do menu Ferramentas.
const FERRAMENTAS = [
  { tool: "chamados", titulo: "OS", tecla: "F6", barra: "#btn-acompanhamento-chamados", menu: "#btn-chamados-menu", estado: "aria-pressed" },
  { tool: "comparacao", titulo: "Resumo", tecla: "F3", barra: "#btn-resumo-aba", menu: null, estado: "aria-selected" },
  { tool: "apelidos", titulo: "Histórico de apelidos", tecla: "F7", barra: null, menu: "#btn-historico-apelidos", estado: null },
  { tool: "relatorio", titulo: "Relatório mensal", tecla: "F8", barra: null, menu: "#btn-relatorio-mensal", estado: null },
];

// Erros de página e mensagens de console de erro; o teste confere que a lista tem só o que ele espera.
function vigiar(page) {
  const vistos = { pagina: [], console: [] };
  page.on("pageerror", erro => vistos.pagina.push(erro.message));
  page.on("console", mensagem => { if (mensagem.type() === "error") vistos.console.push(mensagem.text()); });
  return vistos;
}

async function abrirPagina(page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-react-pronto", "");
}

// Abre pelo botão real: o da barra quando está à vista, senão o item do menu Ferramentas (com o <kbd> do atalho).
// Devolve quem deve receber o foco de volta ao fechar (o próprio botão da barra ou o gatilho do menu).
async function abrirPelaInterface(page, ferramenta) {
  if (ferramenta.barra && await page.locator(ferramenta.barra).isVisible()) {
    await page.locator(ferramenta.barra).click();
    return ferramenta.barra;
  }
  await page.locator("#cockpit-tools-trigger").click();
  await expect(page.locator(ferramenta.menu)).toBeVisible();
  await expect(page.locator(`${ferramenta.menu} kbd`)).toHaveText(ferramenta.tecla);
  await page.locator(ferramenta.menu).click();
  return "#cockpit-tools-trigger";
}

// Painel aberto: só o painel certo à vista, título (h1 focável), <kbd> do cabeçalho, ARIA e foco no título.
async function conferirAberto(page, ferramenta) {
  const { tool, titulo, tecla } = ferramenta;
  await expect(page.locator(`[data-cockpit-tool-panel="${tool}"]`)).toBeVisible();
  await expect(page.locator("[data-cockpit-tool-panel]:visible")).toHaveCount(1);
  await expect(page.locator(RAIZ)).toBeVisible();
  await expect(page.locator(RAIZ)).toHaveAttribute("aria-labelledby", "cockpit-tool-title");
  await expect(page.locator("#main-content")).toBeHidden();
  await expect(page.locator(TITULO)).toHaveText(titulo);
  await expect(page.locator(TITULO)).toHaveJSProperty("tagName", "H1");
  await expect(page.locator(TITULO)).toHaveAttribute("tabindex", "-1");
  await expect(page.locator(TITULO)).toBeFocused();
  await expect(page.locator("#cockpit-tool-kbd")).toHaveText(tecla);
  await expect(page.locator("#cockpit-tool-kbd")).toBeVisible();
  await expect(page.locator("#cockpit-tool-kbd")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#cockpit-tools-dropdown")).toHaveAttribute("data-active-tool", tool);
  await expect(page.locator("#cockpit-tools-dropdown")).not.toHaveJSProperty("open", true);
  await expect(page.locator(".skip-link")).toHaveAttribute("href", "#cockpit-tool-title");
  if (ferramenta.barra) {
    // Os atributos do botão da barra valem escondido ou à vista: o botão acompanha o painel nos dois tamanhos.
    await expect(page.locator(ferramenta.barra)).toHaveAttribute("title", `${titulo} (${tecla})`);
    await expect(page.locator(ferramenta.barra)).toHaveAttribute("aria-keyshortcuts", tecla);
    await expect(page.locator(ferramenta.barra)).toHaveAttribute(ferramenta.estado, "true");
  }
  if (tool === "comparacao") await expect(page.locator("#tab-home")).toHaveAttribute("aria-selected", "false");
}

// Painel fechado pelo Escape: tela principal de volta e nada fica marcado como aberto.
async function conferirFechado(page, ferramenta) {
  await expect(page.locator(RAIZ)).toBeHidden();
  await expect(page.locator("#main-content")).toBeVisible();
  await expect(page.locator("#cockpit-tools-dropdown")).not.toHaveAttribute("data-active-tool", /.*/);
  await expect(page.locator(".skip-link")).toHaveAttribute("href", "#main-content");
  if (ferramenta.barra) {
    if (ferramenta.estado === "aria-pressed") await expect(page.locator(ferramenta.barra)).toHaveAttribute("aria-pressed", "false");
    else await expect(page.locator(ferramenta.barra)).toHaveAttribute("aria-selected", "false");
  }
  if (ferramenta.tool === "comparacao") await expect(page.locator("#tab-home")).toHaveAttribute("aria-selected", "true");
}

test("com o bundle: o painel ferramentas-cockpit monta e publica as ações da ponte", async ({ page }) => {
  const vistos = vigiar(page);
  await abrirPagina(page);
  await expect(page.locator(PAINEL)).toBeAttached();
  await expect(page.locator(PAINEL)).toBeHidden();
  const publicado = await page.evaluate(nomes => {
    const painel = window.SimpressReact?.["ferramentas-cockpit"];
    return {
      existe: Boolean(painel),
      funcoes: nomes.map(nome => typeof painel?.[nome]),
      // Os botões chamam pelo nome global (data-on-click): a ponte do app antigo tem de estar de pé.
      globais: ["abrirPainelCockpit", "fecharPainelCockpit"].map(nome => typeof window[nome]),
    };
  }, ACOES_DA_PONTE);
  expect(publicado.existe).toBe(true);
  expect(publicado.funcoes).toEqual(ACOES_DA_PONTE.map(() => "function"));
  expect(publicado.globais).toEqual(["function", "function"]);
  expect(vistos.pagina).toEqual([]);
  expect(vistos.console.filter(texto => texto.includes("não carregou"))).toEqual([]);
});

for (const ferramenta of FERRAMENTAS) {
  test(`${ferramenta.titulo} (${ferramenta.tecla}): botão real e atalho abrem o painel certo, e o Escape fecha`, async ({ page }) => {
    test.setTimeout(60_000);
    const vistos = vigiar(page);
    await abrirPagina(page);

    const retorno = await abrirPelaInterface(page, ferramenta);
    await conferirAberto(page, ferramenta);
    if (ferramenta.tool === "comparacao") {
      await expect(page.locator("#comparacao-planilhas-conteudo")).toHaveAttribute("data-estado", /^(pronto|vazio|erro)$/);
    }

    await page.keyboard.press("Escape");
    await conferirFechado(page, ferramenta);
    // Foco de volta onde o usuário estava: o botão da barra ou o gatilho do menu Ferramentas.
    await expect(page.locator(retorno)).toBeFocused();

    // O atalho abre o mesmo painel, com a mesma conferência, e o Escape fecha de novo.
    await page.keyboard.press(ferramenta.tecla);
    await conferirAberto(page, ferramenta);
    await page.keyboard.press("Escape");
    await conferirFechado(page, ferramenta);

    expect(vistos.pagina).toEqual([]);
    expect(vistos.console.filter(texto => texto.includes("não carregou"))).toEqual([]);
  });
}

// Mesmo comportamento do código antigo: o Voltar reabre a ferramenta anterior (previousTool) e só o segundo Voltar fecha.
test("com o bundle: trocar de ferramenta mostra só a nova, o Voltar volta à anterior e o segundo Voltar fecha", async ({ page }) => {
  test.setTimeout(60_000);
  const voltar = page.getByRole("button", { name: "Voltar para a tela principal" });
  await abrirPagina(page);
  await page.evaluate(() => window.abrirPainelCockpit("apelidos"));
  await conferirAberto(page, FERRAMENTAS[2]);
  await page.evaluate(() => window.abrirPainelCockpit("relatorio"));
  await conferirAberto(page, FERRAMENTAS[3]);
  await voltar.click();
  await conferirAberto(page, FERRAMENTAS[2]);
  await voltar.click();
  await conferirFechado(page, FERRAMENTAS[2]);
});

// ---- Planilhas: contrato visível da sub-aba (dados sintéticos simulados em /api/historico-comparacoes) ----
const PLANILHAS = 'section[data-cockpit-tool-panel="planilhas"]';
const EVENTO_PLANILHAS = {
  id: "evt-sintetico-1", tipo: "importacao", horario: "2026-11-20T12:00:00-03:00",
  arquivos_enviados: { endpoint: "endpoint_sintetico.xlsx", detalhes: "detalhes_sintetico.xlsx" },
  comparacao: { total_detalhes: 12, total_endpoint: 10 },
};

// modo: "ok" | "vazio" | "erro"; devolve o contador de requisições da lista.
async function simularHistorico(page, modo) {
  const contagem = { lista: 0 };
  await page.route(/\/api\/historico-comparacoes(\/[^/?]+)?(\?.*)?$/, rota => {
    const detalhe = new URL(rota.request().url()).pathname.split("/")[3];
    if (detalhe) return rota.fulfill({ json: { evento: EVENTO_PLANILHAS } });
    contagem.lista += 1;
    if (modo === "erro") return rota.fulfill({ status: 500, json: { detail: "Falha sintética do servidor." } });
    return rota.fulfill({ json: { eventos: modo === "vazio" ? [] : [EVENTO_PLANILHAS] } });
  });
  return contagem;
}

async function abrirPlanilhas(page) {
  await abrirPagina(page);
  await page.evaluate(() => window.abrirPainelCockpit("planilhas"));
  await expect(page.locator(PLANILHAS)).toBeVisible();
}

const LINHAS = `${PLANILHAS} #cockpit-sheets-list-body tr`;
const DETALHE_TITULO = "#cockpit-sheets-detail-title";

test("Planilhas: carrega KPIs, status, duas linhas com data-label e detalhe da primeira", async ({ page }) => {
  const vistos = vigiar(page);
  await simularHistorico(page, "ok");
  await abrirPlanilhas(page);
  await expect(page.locator("#cockpit-sheets-status")).toHaveText(/^Última atualização em .+/);
  const kpis = page.locator("#cockpit-sheets-kpis .ck-kpi");
  await expect(kpis).toHaveCount(4);
  await expect(kpis.locator(".ck-kpi__rotulo")).toHaveText([
    "Última atualização", "Equipamentos na Simpress", "Equipamentos no Endpoint", "Atualizações no histórico",
  ]);
  await expect(kpis.nth(1).locator(".ck-kpi__valor")).toHaveText("12");
  await expect(kpis.nth(2).locator(".ck-kpi__valor")).toHaveText("10");
  await expect(kpis.nth(3).locator(".ck-kpi__valor")).toHaveText("1");
  const linhas = page.locator(LINHAS);
  await expect(linhas).toHaveCount(2);
  await expect(linhas.nth(0).locator("td").first()).toHaveText("No Endpoint");
  await expect(linhas.nth(1).locator("td").first()).toHaveText("na Simpress");
  for (const i of [0, 1]) {
    await expect(linhas.nth(i).locator("td")).toHaveCount(5);
    expect(await linhas.nth(i).locator("td").evaluateAll(tds => tds.map(td => td.dataset.label)))
      .toEqual(["Planilha", "Arquivo atual", "Linhas", "Atualizado", "Situação"]);
    await expect(linhas.nth(i)).toHaveAttribute("tabindex", "0");
  }
  await expect(linhas.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(linhas.nth(1)).toHaveAttribute("aria-selected", "false");
  await expect(page.locator(DETALHE_TITULO)).toHaveText("No Endpoint");
  await expect(page.locator("#cockpit-sheets-detail-sub")).toHaveText(/endpoint_sintetico/);
  await expect(page.locator("#cockpit-sheets-detail-badge [data-status]")).toHaveText("Atualizada");
  await expect(page.locator("#cockpit-sheets-detail-badge [data-status]")).toHaveAttribute("data-status", /.+/);
  expect(vistos.pagina).toEqual([]);
});

test("Planilhas: selecionar a 2ª linha por clique troca aria-selected e atualiza o detalhe", async ({ page }) => {
  await simularHistorico(page, "ok");
  await abrirPlanilhas(page);
  await expect(page.locator(LINHAS)).toHaveCount(2);
  await page.locator(LINHAS).nth(1).click();
  await expect(page.locator(LINHAS).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(LINHAS).nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(page.locator(DETALHE_TITULO)).toHaveText("na Simpress");
  await expect(page.locator("#cockpit-sheets-detail-sub")).toHaveText(/detalhes_sintetico/);
});

for (const tecla of ["Enter", " "]) {
  test(`Planilhas: selecionar a 2ª linha por teclado (${tecla === " " ? "Espaço" : tecla}) com foco na linha`, async ({ page }) => {
    await simularHistorico(page, "ok");
    await abrirPlanilhas(page);
    await expect(page.locator(LINHAS)).toHaveCount(2);
    await page.locator(LINHAS).nth(1).focus();
    await page.keyboard.press(tecla);
    await expect(page.locator(LINHAS).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(LINHAS).nth(0)).toHaveAttribute("aria-selected", "false");
    await expect(page.locator(DETALHE_TITULO)).toHaveText("na Simpress");
  });
}

test("Planilhas: histórico vazio mostra a mensagem no status e na tabela", async ({ page }) => {
  await simularHistorico(page, "vazio");
  await abrirPlanilhas(page);
  await expect(page.locator("#cockpit-sheets-status")).toHaveText("Nenhuma atualização no histórico local.");
  const vazio = page.locator("#cockpit-sheets-list-body td.ck-lista__vazio");
  await expect(vazio).toHaveText("Nenhuma atualização no histórico local.");
  await expect(vazio).toHaveAttribute("colspan", "5");
  await expect(page.locator(DETALHE_TITULO)).toHaveText("—");
});

test("Planilhas: erro 500 do servidor mostra a mensagem no status e na tabela", async ({ page }) => {
  await simularHistorico(page, "erro");
  await abrirPlanilhas(page);
  await expect(page.locator("#cockpit-sheets-status")).toHaveText("Falha sintética do servidor.");
  const vazio = page.locator("#cockpit-sheets-list-body td.ck-lista__vazio");
  await expect(vazio).toHaveText("Falha sintética do servidor.");
  await expect(vazio).toHaveAttribute("colspan", "5");
});

test("Planilhas: o botão Atualizar recarrega o histórico", async ({ page }) => {
  const contagem = await simularHistorico(page, "ok");
  await abrirPlanilhas(page);
  await expect(page.locator(LINHAS)).toHaveCount(2);
  const antes = contagem.lista;
  expect(antes).toBeGreaterThan(0);
  await page.locator("#cockpit-sheets-refresh").click();
  await expect.poll(() => contagem.lista).toBe(antes + 1);
  await expect(page.locator("#cockpit-sheets-status")).toHaveText(/^Última atualização em .+/);
  await expect(page.locator(LINHAS)).toHaveCount(2);
});
