// Migração React, Dia 2, grupo G2 (Ferramentas): configuracao-local, units-catalog e inventory-upload.
// Os baselines de screenshots foram gravados com o código antigo (JS puro), antes da troca para React:
// cada painel em React tem de sair igual nos dois tamanhos (390 e 1366 px) e nos dois temas.
const { test, expect } = require("@playwright/test");

async function prepararTema(page, tema) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
}

async function abrirApp(page, tema) {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  // As pontes esperam o bundle React: a marca de vida vem depois do primeiro commit.
  await expect(page.locator("html")).toHaveAttribute("data-react-pronto", /.*/);
  await page.mouse.move(0, 0);
}

// ---------------------------------------------------------------- Configuração local
// Mesmo contrato de routers/configuracao_local.py, só com dados fictícios.
function leituraConfiguracao() {
  const conta = (id, rotulo, extra) => ({
    id, rotulo, placeholder: "nome@exemplo.invalid", ajuda: "Usada para: Dashboard", tipo: "email",
    valor: "", fonte: "", somente_leitura: false, usar_no_outlook: null, valido: true, ...extra,
  });
  return {
    status: { state: "ready", faltando: [], reason: "" },
    contas: [
      conta("conta_simpress", "Conta Simpress (e-mail)", { valor: "pessoa@exemplo.invalid", usar_no_outlook: true }),
      conta("conta_sebrae", "Conta Sebrae (e-mail)", { usar_no_outlook: false, valido: false }),
      conta("usuario_endpoint", "Usuário do Endpoint Central", { valor: "usuario.exemplo", somente_leitura: true, fonte: "ambiente" }),
    ],
    links: [{
      chave: "dashboard_pasta_url", rotulo: "Link da pasta do Dashboard (SharePoint)", placeholder: "https://exemplo.invalid/pasta",
      ajuda: "Usado para: Dashboard", valor: "https://exemplo.invalid/pasta", fonte: "arquivo", somente_leitura: false, valido: true,
    }],
    contas_arquivo_invalido: false,
    cliente: { configurado: true, arquivo_invalido: false, valido: true },
    assistente: {
      openrouter: { configurada: true, final: "…abcd", fonte: "arquivo" },
      deepseek: { configurada: true, final: "…wxyz", fonte: "ambiente" },
    },
  };
}
const CLIENTE = { contrato: "10101", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: ["ABC123", "XYZ789"], cliente_fontes: {} };

async function rotasConfiguracao(page, { falhar = false } = {}) {
  const requisicoes = [];
  let leitura = leituraConfiguracao();
  let cliente = { ...CLIENTE };
  const registrar = route => requisicoes.push({
    metodo: route.request().method(), url: new URL(route.request().url()).pathname, corpo: route.request().postDataJSON?.() ?? null,
  });
  await page.route("**/api/config/local", route => (falhar
    ? route.fulfill({ status: 500, json: { detail: "Falha sintética ao ler a configuração." } })
    : route.fulfill({ json: leitura })));
  await page.route("**/api/config/local/contas", route => { registrar(route); return route.fulfill({ json: leitura }); });
  await page.route("**/api/config/local/assistente", route => {
    registrar(route);
    leitura = { ...leitura, assistente: { ...leitura.assistente, openrouter: { configurada: true, final: "…9876", fonte: "arquivo" } } };
    return route.fulfill({ json: leitura.assistente });
  });
  await page.route("**/api/config/local/assistente/*", route => {
    registrar(route);
    leitura = { ...leitura, assistente: { ...leitura.assistente, openrouter: { configurada: false, final: "", fonte: "" } } };
    return route.fulfill({ json: leitura.assistente });
  });
  await page.route("**/api/config/cliente", route => {
    if (route.request().method() === "PUT") {
      registrar(route);
      cliente = { ...cliente, ...route.request().postDataJSON() };
    }
    return route.fulfill({ json: cliente });
  });
  return requisicoes;
}

async function abrirConfiguracao(page, { tema = "light", falhar = false } = {}) {
  await prepararTema(page, tema);
  const requisicoes = await rotasConfiguracao(page, { falhar });
  await abrirApp(page, tema);
  await page.evaluate(() => window.abrirConfiguracaoLocal());
  await expect(page.locator("#modal-configuracao-local")).toBeVisible();
  return requisicoes;
}

const dialogo = page => page.locator("#modal-configuracao-local .ckp-dialogo");

for (const tema of ["light", "dark"]) {
  test(`baseline: configuração local preenchida, tema ${tema}`, async ({ page }) => {
    await abrirConfiguracao(page, { tema });
    await expect(page.locator("#cfg-local-secao-contas")).toBeVisible();
    await expect(page.locator("#cfg-local-conta-conta_simpress")).toBeFocused();
    await expect(dialogo(page)).toHaveScreenshot(`configuracao-local-pronto-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
    // O diálogo rola: as seções de baixo ganham screenshot próprio.
    for (const secao of ["cliente", "assistente"]) {
      const alvo = page.locator(`#cfg-local-secao-${secao}`);
      await alvo.scrollIntoViewIfNeeded();
      await expect(alvo).toHaveScreenshot(`configuracao-local-${secao}-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
    }
  });

  test(`baseline: configuração local com falha ao ler, tema ${tema}`, async ({ page }) => {
    await abrirConfiguracao(page, { tema, falhar: true });
    await expect(page.locator("#cfg-local-carga")).toContainText("Falha sintética");
    await expect(dialogo(page)).toHaveScreenshot(`configuracao-local-erro-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}
