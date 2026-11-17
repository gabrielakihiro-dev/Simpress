// Bloco final 4 (BF4): ferramentas do Cockpit (OS F6, Resumo F3, Histórico de apelidos F7, Relatório mensal F8,
// Planilhas e a janela Chamado x OS) migradas para o painel React ferramentas-cockpit
// (frontend/src/paineis/ferramentas-cockpit/). static/js/features/cockpit-tool-panels.js virou só a ponte.
//
// Só dados sintéticos: o servidor de fixture (tests/support/serve_ui_motion_preview.py) responde a todo /api/*; nada é
// simulado aqui. O que se prova é o que o usuário vê (botão, atalho, título, <kbd>, ARIA, foco, Escape) e o contrato com
// a página: window.abrirPainelCockpit / fecharPainelCockpit e window.SimpressReact["ferramentas-cockpit"].
//
// Sem o bundle (react-entry.js bloqueado, mesmo mecanismo do react-g5 e do react-piloto): a ponte mostra o erro onde o
// resultado apareceria (.ck-nota--erro) e o botão Voltar fecha o painel; nada fica em "Carregando" para sempre.
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

// Erros sem o painel: [id do lugar do resultado, texto de erro]; o texto vem do código antigo e é o aprovado.
const ERROS_SEM_PAINEL = [
  ["chamados", "#cockpit-tickets-os", "A tabela de ordens de serviço não está disponível."],
  ["comparacao", "#comparacao-planilhas-conteudo", "Não foi possível abrir a comparação."],
  ["apelidos", "#cockpit-alias-list", "Falha ao carregar o histórico."],
  ["relatorio", "#cockpit-monthly-estado", "Falha ao carregar o relatório."],
  ["planilhas", "#cockpit-sheets-kpis", "Não foi possível carregar as planilhas."],
];

// Erros de página e mensagens de console de erro; o teste confere que a lista tem só o que ele espera.
function vigiar(page) {
  const vistos = { pagina: [], console: [] };
  page.on("pageerror", erro => vistos.pagina.push(erro.message));
  page.on("console", mensagem => { if (mensagem.type() === "error") vistos.console.push(mensagem.text()); });
  return vistos;
}

async function abrirPagina(page, { semBundle = false } = {}) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (semBundle) await page.route("**/static/dist/react-entry.js*", route => route.abort());
  await page.goto("/");
  if (semBundle) {
    await expect(page.locator("html")).not.toHaveAttribute("data-react-pronto", /.*/);
    await expect(page.locator("#tab-home")).toBeVisible();
  } else {
    await expect(page.locator("html")).toHaveAttribute("data-react-pronto", "");
  }
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

test.describe("sem o bundle React", () => {
  test('abrirPainelCockpit("chamados") mostra o erro no lugar da tabela e nada fica em "Carregando"', async ({ page }) => {
    const vistos = vigiar(page);
    await abrirPagina(page, { semBundle: true });
    await page.evaluate(() => window.abrirPainelCockpit("chamados"));

    await expect(page.locator(RAIZ)).toBeVisible();
    await expect(page.locator('[data-cockpit-tool-panel="chamados"]')).toBeVisible();
    await expect(page.locator("[data-cockpit-tool-panel]:visible")).toHaveCount(1);
    await expect(page.locator("#main-content")).toBeHidden();
    const erro = page.locator("#cockpit-tickets-os .ck-nota--erro");
    await expect(erro).toHaveCount(1);
    await expect(erro).toBeVisible();
    await expect(erro).toHaveText("A tabela de ordens de serviço não está disponível.");
    await expect(page.locator('[data-cockpit-tool-panel="chamados"]')).not.toContainText("Carregando");
    await expect(page.locator('[data-cockpit-tool-panel="chamados"] [aria-busy="true"]')).toHaveCount(0);
    // A ponte avisa no console que o painel não carregou (era o único jeito de saber sem o bundle).
    expect(vistos.console.some(texto => texto.includes('O painel React "ferramentas-cockpit" não carregou.'))).toBe(true);
    expect(vistos.pagina).toEqual([]);

    // Sem o painel o Escape não está ligado, mas o Voltar (botão) continua saindo da ferramenta.
    await page.getByRole("button", { name: "Voltar para a tela principal" }).click();
    await expect(page.locator(RAIZ)).toBeHidden();
    await expect(page.locator("#main-content")).toBeVisible();
  });

  for (const [tool, alvo, mensagem] of ERROS_SEM_PAINEL) {
    test(`ferramenta ${tool}: mostra o erro aprovado e o status não fica em "Carregando"`, async ({ page }) => {
      const vistos = vigiar(page);
      await abrirPagina(page, { semBundle: true });
      await page.evaluate(nome => window.abrirPainelCockpit(nome), tool);

      await expect(page.locator(`[data-cockpit-tool-panel="${tool}"]`)).toBeVisible();
      await expect(page.locator(`${alvo} .ck-nota--erro`)).toHaveText(mensagem);
      await expect(page.locator(`[data-cockpit-tool-panel="${tool}"] [role="status"]`).filter({ hasText: "Carregando" })).toHaveCount(0);
      await expect(page.locator(`[data-cockpit-tool-panel="${tool}"] [aria-busy="true"]`)).toHaveCount(0);
      expect(vistos.pagina).toEqual([]);
    });
  }
});
