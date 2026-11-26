const { test, expect } = require("@playwright/test");

// Seção "Pacote local" do modal Configuração local; rotas /api simuladas, só dados sintéticos.
// Datas do mock têm fuso -03:00; fixar o fuso do navegador deixa "dd/mm/aaaa hh:mm" estável.
test.use({ timezoneId: "America/Sao_Paulo" });

const ARQ_EXP = "pacote-local-20261126-101500.zip";
const ARQ_DES = "desfazer-20261125-083000.zip";
const PACOTES = [
  { arquivo: ARQ_EXP, tipo: "exportacao", criado_em: "2026-11-26T10:15:00-03:00", tamanho_bytes: 2048 },
  { arquivo: ARQ_DES, tipo: "desfazer", criado_em: "2026-11-25T08:30:00-03:00", tamanho_bytes: 1048576 },
];
const PREVIA = {
  arquivo: ARQ_EXP, tipo: "exportacao", versao_app: "1.3.0", criado_em: "2026-11-26T10:15:00-03:00",
  itens: [
    { caminho: "config/cliente.json", acao: "substituir" },
    { caminho: "data/state/lembretes.json", acao: "criar" },
    { caminho: "data/state/historico_chamados.json", acao: "igual" },
    { caminho: "data/state/ux_solicitante.json", acao: "manter" },
  ],
  totais: { substituir: 1, criar: 1, igual: 1, manter: 1, apagar: 0 },
  muda_links: true, preview_token: "token-sintetico-1",
};
const MSG_PASTA = "A pasta não existe ou não aceita escrita.";

function prontidao() {
  const status = { available: true, state: "ready" };
  const arquivo = { ...status, reason: "OK", file: "arquivo-sintetico.xlsx" };
  return {
    backend: "files",
    functions: Object.fromEntries(["consulta_equipamentos", "geracao_transferencia", "comparacao_atualizacao_inventarios",
      "exportacao_equipamentos", "acompanhamento_chamados"].map(chave => [chave, status])),
    files: Object.fromEntries(["inventario_equipamentos", "inventario_detalhes_atualizacao", "inventario_endpoint",
      "template_transferencia", "modelo_exportacao", "historico_chamados"].map(chave => [chave, arquivo])),
    configuracao_local: { state: "ready", faltando: [], reason: "", assistente_ia: false },
  };
}

const leituraConfig = () => ({
  status: { state: "ready", faltando: [], reason: "", assistente_ia: false },
  contas: [], links: [], contas_arquivo_invalido: false,
  cliente: { configurado: true, arquivo_invalido: false, valido: true },
  assistente: {},
});

// Servidor falso com estado e registro das chamadas a /api/pacote-local*.
async function simular(page, { pacotes = PACOTES, previa = PREVIA } = {}) {
  const s = { pacotes: [...pacotes], previa, requisicoes: [], restaurar: { status: 200, json: { substituidos: 1, criados: 1, apagados: 0, mantidos: 1, pacote_desfazer: "desfazer-20261126-110000.zip" } },
    putPasta: null, exportar: { arquivo: "pacote-local-20261126-110000.zip" } };
  const lista = () => ({ pasta: "data/pacotes_locais", pasta_padrao: true, pacotes: s.pacotes, erro_pasta: null });
  await page.route("**/api/prontidao", r => r.fulfill({ json: prontidao() }));
  await page.route("**/api/modelos-chamado", r => r.fulfill({ json: { modelos: {} } })); // rota alheia à tela, evita 404 no console
  await page.route("**/api/config/local", r => r.fulfill({ json: leituraConfig() }));
  await page.route("**/api/config/cliente", r => r.fulfill({ json: { contrato: "", cnpj_faturamento: "", series_sebrae_fora: [], cliente_fontes: {}, cliente_configurado: true } }));
  await page.route("**/api/pacote-local**", route => {
    const req = route.request();
    const caminho = new URL(req.url()).pathname.replace("/api/pacote-local", "");
    const metodo = req.method();
    s.requisicoes.push({ metodo, caminho, corpo: req.postData() ? req.postDataJSON() : null });
    if (metodo === "GET" && caminho === "") return route.fulfill({ json: lista() });
    if (metodo === "PUT" && caminho === "/pasta") {
      return s.putPasta ? route.fulfill(s.putPasta) : route.fulfill({ json: lista() });
    }
    if (metodo === "POST" && caminho === "/exportar") {
      s.pacotes = [{ arquivo: s.exportar.arquivo, tipo: "exportacao", criado_em: "2026-11-26T11:00:00-03:00", tamanho_bytes: 4096 }, ...s.pacotes];
      return route.fulfill({ json: { ...s.exportar, tamanho_bytes: 4096, arquivos: 3, ausentes: 0, criado_em: "2026-11-26T11:00:00-03:00" } });
    }
    if (metodo === "GET" && caminho.endsWith("/previa")) {
      return s.previaErro ? route.fulfill(s.previaErro) : route.fulfill({ json: s.previa });
    }
    if (metodo === "POST" && caminho.endsWith("/restaurar")) return route.fulfill({ status: s.restaurar.status, json: s.restaurar.json });
    return route.fulfill({ status: 404, json: { detail: "não simulado" } });
  });
  return s;
}

async function abrirSecao(page) {
  await page.goto("/");
  await expect(page.locator("#readiness-panel")).toHaveAttribute("aria-busy", "false");
  const alternar = page.locator("#cockpit-bar-status-toggle");
  if ((await alternar.isVisible()) && (await alternar.getAttribute("aria-expanded")) !== "true") await alternar.click();
  const painel = page.locator("#readiness-panel");
  if ((await painel.getAttribute("open")) === null) await painel.locator(":scope > summary").click();
  await page.locator("#btn-configuracao-local").click();
  await expect(page.getByRole("dialog", { name: "Configuração local" })).toBeVisible();
  const secao = page.locator("#cfg-local-secao-pacote");
  await secao.scrollIntoViewIfNeeded();
  return secao;
}

const semRolagemHorizontal = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const posts = (s, sufixo) => s.requisicoes.filter(r => r.metodo === "POST" && r.caminho.endsWith(sufixo));

test("Pacote local: sem pacotes mostra o texto de vazio, aviso e quadro", async ({ page }) => {
  await simular(page, { pacotes: [] });
  const secao = await abrirSecao(page);
  await expect(page.locator("#cfg-local-titulo-pacote")).toHaveText("Pacote local");
  await expect(page.locator("#cfg-local-pacote-aviso")).toHaveText("Contém dados pessoais; não compartilhe.");
  await expect(page.locator("#cfg-local-pacote-vazio")).toHaveText("Nenhum pacote na pasta. Exporte um pacote ou copie um .zip para a pasta.");
  await expect(page.locator("#cfg-local-pacote-lista")).toHaveCount(0);
  await expect(page.locator("#cfg-local-pacote-pasta-atual")).toHaveText("Pasta: data/pacotes_locais");
  await expect(page.locator("#cfg-local-pacote-detalhes summary")).toHaveText("O que entra e o que fica de fora");
  await expect(secao.locator("#cfg-local-pacote-detalhes")).toContainText("Fica de fora: .env e chaves de IA");
});

test("Pacote local: lista com tabela no desktop e cartões a 375 px sem rolagem horizontal", async ({ page }) => {
  await simular(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await abrirSecao(page);
  const linhas = page.locator("#cfg-local-pacote-lista tr[data-arquivo]");
  await expect(linhas).toHaveCount(2);
  await expect(linhas.first()).toHaveAttribute("data-arquivo", ARQ_EXP);
  await expect(linhas.first()).toContainText("Exportação");
  await expect(linhas.first()).toContainText("26/11/2026 10:15");
  await expect(linhas.first()).toContainText("2.0 KB");
  await expect(linhas.nth(1)).toContainText("Desfazer");
  await expect(linhas.nth(1)).toContainText("1.0 MB");
  await expect(page.locator("#cfg-local-pacote-lista thead")).toBeVisible();
  expect(await semRolagemHorizontal(page)).toBe(true);

  await page.setViewportSize({ width: 375, height: 800 });
  // Cartões: o cabeçalho fica só para leitor de tela (1 px) e a linha vira bloco.
  expect((await page.locator("#cfg-local-pacote-lista thead").boundingBox()).width).toBeLessThanOrEqual(1);
  await expect(linhas.first()).toHaveCSS("display", "block");
  const botao = page.locator(`button[data-pacote-restaurar="${ARQ_EXP}"]`);
  await expect(botao).toBeVisible();
  expect((await botao.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(await semRolagemHorizontal(page)).toBe(true);
});

test("Pacote local: exportar mostra o arquivo criado e atualiza a lista", async ({ page }) => {
  const s = await simular(page);
  await abrirSecao(page);
  await page.locator("#cfg-local-pacote-exportar").click();
  const msg = page.locator("#cfg-local-pacote-mensagem");
  await expect(msg).toHaveText("Pacote exportado: pacote-local-20261126-110000.zip");
  await expect(msg).toHaveAttribute("role", "status");
  expect(posts(s, "/exportar")).toHaveLength(1);
  await expect(page.locator("#cfg-local-pacote-lista tr[data-arquivo]")).toHaveCount(3);
});

test("Pacote local: prévia, confirmação com corpo exato e conclusão", async ({ page }) => {
  const s = await simular(page);
  await abrirSecao(page);
  await page.locator(`button[data-pacote-restaurar="${ARQ_EXP}"]`).click();

  await expect(page.locator("#cfg-local-pacote-previa-titulo")).toHaveText("Prévia da restauração");
  await expect(page.locator("#cfg-local-pacote-previa-titulo")).toBeFocused();
  await expect(page.locator("#cfg-local-pacote-previa-resumo")).toHaveText(`${ARQ_EXP} · criado em 26/11/2026 10:15 · versão 1.3.0`);
  const totais = page.locator("#cfg-local-pacote-previa-totais li[data-acao]");
  await expect(totais).toHaveText(["Substituir: 1", "Criar: 1", "Igual: 1", "Manter: 1"]);
  const itens = page.locator("#cfg-local-pacote-previa-itens li[data-acao]");
  await expect(itens).toHaveCount(2);
  await page.locator("#cfg-local-pacote-mostrar-todos").click();
  await expect(itens).toHaveCount(4);
  await expect(page.locator("#cfg-local-pacote-mostrar-todos")).toHaveCount(0);
  await expect(page.locator("#cfg-local-pacote-previa-links")).toHaveText("Atenção: este pacote muda links e contas das automações. Confira antes de confirmar.");
  expect(posts(s, "/restaurar")).toHaveLength(0);

  await page.locator("#cfg-local-pacote-confirmar").click();
  await expect(page.locator("#cfg-local-pacote-mensagem")).toHaveText("Restauração concluída. Pacote de desfazer: desfazer-20261126-110000.zip");
  await expect(page.locator("#cfg-local-pacote-mensagem")).toHaveAttribute("role", "status");
  await expect(page.locator("#cfg-local-pacote-recarregar")).toHaveText("Recarregar página");
  await expect(page.locator("#cfg-local-pacote-previa")).toHaveCount(0);
  const envios = posts(s, "/restaurar");
  expect(envios).toHaveLength(1);
  expect(envios[0].caminho).toBe(`/${ARQ_EXP}/restaurar`);
  expect(envios[0].corpo).toEqual({ preview_token: "token-sintetico-1", confirmado: true });
});

test("Pacote local: prévia sem mudança de links não mostra o aviso e Apagar só aparece se > 0", async ({ page }) => {
  await simular(page, { previa: { ...PREVIA, muda_links: false, totais: { ...PREVIA.totais, apagar: 2 } } });
  await abrirSecao(page);
  await page.locator(`button[data-pacote-restaurar="${ARQ_EXP}"]`).click();
  await expect(page.locator("#cfg-local-pacote-previa-links")).toHaveCount(0);
  await expect(page.locator("#cfg-local-pacote-previa-totais li[data-acao]")).toHaveText(["Substituir: 1", "Criar: 1", "Igual: 1", "Manter: 1", "Apagar: 2"]);
});

test("Pacote local: 409 recusa a restauração com alerta e a prévia continua", async ({ page }) => {
  const s = await simular(page);
  s.restaurar = { status: 409, json: { detail: "Restauração recusada: uma automação está em execução" } };
  await abrirSecao(page);
  await page.locator(`button[data-pacote-restaurar="${ARQ_EXP}"]`).click();
  await page.locator("#cfg-local-pacote-confirmar").click();
  const msg = page.locator("#cfg-local-pacote-mensagem");
  await expect(msg).toHaveText("Restauração recusada: uma automação está em execução");
  await expect(msg).toHaveAttribute("role", "alert");
  await expect(page.locator("#cfg-local-pacote-previa")).toBeVisible();
  await expect(page.locator("#cfg-local-pacote-confirmar")).toBeEnabled();
  await expect(page.locator("#cfg-local-pacote-recarregar")).toHaveCount(0);
});

test("Pacote local: pacote já igual ao estado atual esconde Confirmar", async ({ page }) => {
  const s = await simular(page);
  s.restaurar = { status: 409, json: { detail: "Este pacote já corresponde ao estado atual." } };
  await abrirSecao(page);
  await page.locator(`button[data-pacote-restaurar="${ARQ_EXP}"]`).click();
  await page.locator("#cfg-local-pacote-confirmar").click();
  await expect(page.locator("#cfg-local-pacote-mensagem")).toHaveText("Este pacote já corresponde ao estado atual.");
  await expect(page.locator("#cfg-local-pacote-confirmar")).toHaveCount(0);
  await expect(page.locator("#cfg-local-pacote-cancelar")).toBeVisible();
});

test("Pacote local: 500 mostra a falha com recuperação dos arquivos", async ({ page }) => {
  const s = await simular(page);
  s.restaurar = { status: 500, json: { detail: "Falha ao restaurar. Os arquivos anteriores foram recuperados." } };
  await abrirSecao(page);
  await page.locator(`button[data-pacote-restaurar="${ARQ_EXP}"]`).click();
  await page.locator("#cfg-local-pacote-confirmar").click();
  await expect(page.locator("#cfg-local-pacote-mensagem")).toHaveText("Falha ao restaurar. Os arquivos anteriores foram recuperados.");
  await expect(page.locator("#cfg-local-pacote-mensagem")).toHaveAttribute("role", "alert");
});

test("Pacote local: erro 422 na prévia mostra Pacote recusado", async ({ page }) => {
  const s = await simular(page);
  s.previaErro = { status: 422, json: { detail: "Pacote recusado: arquivo não confere com o manifesto" } };
  await abrirSecao(page);
  await page.locator(`button[data-pacote-restaurar="${ARQ_DES}"]`).click();
  const msg = page.locator("#cfg-local-pacote-mensagem");
  await expect(msg).toHaveText("Pacote recusado: arquivo não confere com o manifesto");
  await expect(msg).toHaveAttribute("role", "alert");
  await expect(page.locator("#cfg-local-pacote-previa")).toHaveCount(0);
});

test("Pacote local: pasta inválida mostra o erro do servidor e pasta válida envia o valor", async ({ page }) => {
  const s = await simular(page);
  s.putPasta = { status: 422, json: { detail: MSG_PASTA } };
  await abrirSecao(page);
  await page.locator("#cfg-local-pacote-pasta").fill("  C:\\pasta-inexistente  ");
  await page.locator("#cfg-local-pacote-salvar-pasta").click();
  const erro = page.locator("#cfg-local-pacote-pasta-erro");
  await expect(erro).toHaveText(MSG_PASTA);
  await expect(erro).toHaveAttribute("role", "alert");
  await expect(page.locator("#cfg-local-pacote-pasta")).toHaveAttribute("aria-invalid", "true");
  const puts = s.requisicoes.filter(r => r.metodo === "PUT");
  expect(puts[0].corpo).toEqual({ pasta: "C:\\pasta-inexistente" });

  s.putPasta = { json: { pasta: "C:\\pacotes", pasta_padrao: false, pacotes: [], erro_pasta: null } };
  await page.locator("#cfg-local-pacote-salvar-pasta").click();
  await expect(erro).toBeHidden();
  await expect(page.locator("#cfg-local-pacote-pasta-atual")).toHaveText("Pasta: C:\\pacotes");
});

test("Pacote local: Cancelar fecha a prévia sem enviar restauração", async ({ page }) => {
  const s = await simular(page);
  await abrirSecao(page);
  await page.locator(`button[data-pacote-restaurar="${ARQ_EXP}"]`).click();
  await expect(page.locator("#cfg-local-pacote-previa")).toBeVisible();
  await page.locator("#cfg-local-pacote-cancelar").click();
  await expect(page.locator("#cfg-local-pacote-previa")).toHaveCount(0);
  expect(posts(s, "/restaurar")).toHaveLength(0);
  await expect(page.locator(`button[data-pacote-restaurar="${ARQ_EXP}"]`)).toBeFocused();
});

test("Pacote local: 403 fora do computador mostra a mensagem e não quebra", async ({ page }) => {
  await simular(page);
  await page.route("**/api/pacote-local", r => r.request().method() === "GET"
    ? r.fulfill({ status: 403, json: { detail: "Disponível só neste computador." } }) : r.fallback());
  await abrirSecao(page);
  const msg = page.locator("#cfg-local-pacote-mensagem");
  await expect(msg).toHaveText("Disponível só neste computador.");
  await expect(msg).toHaveAttribute("role", "alert");
  await expect(page.locator("#cfg-local-pacote-exportar")).toBeVisible();
});

test("Pacote local: temas claro e escuro sem erro de console nem rolagem horizontal", async ({ page }) => {
  test.setTimeout(40_000);
  const erros = [];
  page.on("pageerror", e => erros.push(e.message));
  page.on("response", r => { if (r.status() === 404) erros.push(`404 ${r.url()}`); });
  page.on("console", m => { if (m.type() === "error") erros.push(m.text()); });
  await simular(page);
  await abrirSecao(page);
  for (const tema of ["light", "dark"]) {
    await page.locator("html").evaluate((raiz, valor) => { raiz.dataset.theme = valor; }, tema);
    await page.locator(`button[data-pacote-restaurar="${ARQ_EXP}"]`).click();
    await expect(page.locator("#cfg-local-pacote-previa")).toBeVisible();
    expect(await semRolagemHorizontal(page), tema).toBe(true);
    await page.locator("#cfg-local-pacote-cancelar").click();
    await expect(page.locator("#cfg-local-pacote-previa")).toHaveCount(0);
  }
  expect(erros).toEqual([]);
});
