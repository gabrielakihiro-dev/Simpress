// Migração React, Dia 2, grupo G9 (Resumo e comparação): diálogo "Histórico de planilhas" (comparison-history).
// Escrito e com baseline de screenshots gravado com o módulo antigo (JS puro), antes da troca para React:
// a versão em React tem de sair igual nos dois tamanhos (390 e 1366 px) e nos dois temas, com o mesmo comportamento.
// O relatório mensal (monthly-report) já é coberto por react-g5.spec.cjs e monthly-report.spec.cjs.
// Dados só sintéticos: ids "g9-*", arquivos "*-g9.*".
const { test, expect } = require("@playwright/test");

// As datas da tela saem no fuso do navegador: fixo, para "Hoje"/"Ontem" e o baseline não dependerem da máquina.
test.use({ timezoneId: "America/Sao_Paulo" });

const AGORA = new Date("2026-10-25T15:00:00-03:00");
const MODAL = "#modal-historico-comparacoes";
const LISTA = "#lista-historico-comparacoes";
const TOTAL = "#total-historico-comparacoes";
const SELECT_DATA = "#data-exportar-historico-comparacoes";
const BOTAO_EXPORTAR = "#btn-exportar-historico-comparacoes";
// Medido no módulo antigo: quantos GET /api/painel o observador de data-panels.js força por abertura e por exclusão.
// Mais que isso no React deixaria o Resumo mais lento (o brief proíbe piorar).
const PAINEL_POR_ABERTURA = 2;
const PAINEL_POR_EXCLUSAO = 1;

const EVENTOS = [
  {
    id: "g9-hoje-atualizacao",
    horario: "2026-10-25T10:00:00-03:00",
    tipo: "atualizacao",
    arquivos_enviados: { endpoint: "endpoint-g9.csv", detalhes: "simpress-g9.xlsx" },
    resumo: { apelidos_atualizados: 3, divergencias_local: 1, correspondencias_ambiguas: 2, sem_acesso_7_dias: 0 },
    restauravel: true,
  },
  {
    id: "g9-hoje-restauracao",
    horario: "2026-10-25T08:00:00-03:00",
    tipo: "restauracao",
    arquivos_restaurados: { endpoint: "endpoint-anterior-g9.csv", detalhes: "simpress-anterior-g9.xlsx" },
    restauracao_de: { horario: "2026-10-20T09:00:00-03:00" },
    resumo: { total_endpoint_restaurado: 10, total_detalhes_restaurado: 1200 },
    restauravel: true,
  },
  {
    id: "g9-ontem-anotacoes",
    horario: "2026-10-24T09:00:00-03:00",
    tipo: "atualizacao",
    somente_anotacoes_sincronizadas: true,
    arquivos_enviados: {},
    resumo: {},
    restauravel: false,
  },
  {
    id: "g9-antigo",
    horario: "2026-10-20T09:00:00-03:00",
    tipo: "atualizacao",
    arquivos_enviados: { endpoint: "endpoint-antigo-g9.csv", detalhes: "simpress-antigo-g9.xlsx" },
    resumo: {},
    restauravel: false,
  },
];

const PREVIA_RESTAURACAO = {
  tipo_evento: "atualizacao",
  evento_horario: "2026-10-25T10:00:00-03:00",
  preview_token: "b".repeat(64),
  arquivos_backup: {
    endpoint: { nome: "endpoint-anterior-g9.csv", registros: 10 },
    detalhes: { nome: "simpress-anterior-g9.xlsx", registros: 1200 },
  },
  arquivos_atuais: {
    endpoint: { presente: true, nome: "endpoint-g9.csv" },
    detalhes: { presente: false },
  },
};

async function zerarFixture(request) {
  await request.get("/__fixture_cockpit?comparacao=0");
  await request.get("/__fixture_alertas_painel?estado=ocultos");
  await request.get("/__fixture_base_desatualizada?estado=atualizada");
}

test.beforeEach(({ request }) => zerarFixture(request));
test.afterEach(({ request }) => zerarFixture(request));

async function prepararPagina(page, tema = "dark") {
  await page.clock.setFixedTime(AGORA);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
}

// Servidor falso do histórico: lista, detalhe, prévia, restauração, exclusão e exportação. O resto vai para a fixture.
// restaurar(route, n): resposta do POST n (1, 2, ...); o padrão restaura 1.234 equipamentos. Cada prévia traz um token novo.
async function rotaHistorico(page, { eventos = EVENTOS, falharLista = false, restaurar = null } = {}) {
  const estado = { eventos: [...eventos], falharLista, chamadas: [], previas: 0, restauracoes: 0 };
  await page.route("**/api/historico-comparacoes**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const caminho = decodeURIComponent(url.pathname);
    const metodo = request.method();
    estado.chamadas.push({ metodo, caminho, busca: url.search, headers: request.headers(), corpo: request.postData() });
    if (caminho === "/api/historico-comparacoes" && metodo === "GET") {
      if (estado.falharLista) return route.fulfill({ status: 500, json: { detail: "Falha simulada do histórico." } });
      return route.fulfill({ json: { eventos: estado.eventos, total: estado.eventos.length } });
    }
    if (caminho === "/api/historico-comparacoes/exportar/excel") {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="Historico_G9_${url.searchParams.get("data")}.xlsx"`,
        },
        body: "PK g9",
      });
    }
    const [, id, acao] = /^\/api\/historico-comparacoes\/([^/]+)(?:\/(.+))?$/.exec(caminho) || [];
    const evento = estado.eventos.find(item => item.id === id);
    if (!evento) return route.fallback();
    if (acao === "restauracao") {
      estado.previas += 1;
      const preview_token = estado.previas === 1 ? PREVIA_RESTAURACAO.preview_token : String(estado.previas).repeat(64);
      return route.fulfill({ json: { ...PREVIA_RESTAURACAO, preview_token } });
    }
    if (acao === "restaurar" && metodo === "POST") {
      estado.restauracoes += 1;
      if (restaurar) return restaurar(route, estado.restauracoes);
      return route.fulfill({ json: { evento: { total_equipamentos_carregados: 1234, desfazer_disponivel: true } } });
    }
    if (!acao && metodo === "DELETE") {
      estado.eventos = estado.eventos.filter(item => item.id !== id);
      return route.fulfill({ json: { ok: true } });
    }
    if (!acao && metodo === "GET") return route.fulfill({ json: { evento: { ...evento, comparacao: {} } } });
    return route.fallback();
  });
  return estado;
}

async function abrirHistorico(page) {
  await page.goto("/");
  await expect(page.locator(TOTAL)).not.toHaveText("0 registros");
  await page.locator("#btn-resumo-aba").click();
  await page.locator("#cockpit-comparison-legacy").click();
  await expect(page.getByRole("dialog", { name: "Histórico de atualizações de planilhas" })).toBeVisible();
  await expect(page.locator(LISTA)).not.toHaveAttribute("aria-busy", "true");
  await page.mouse.move(0, 0);
}

// Escolhe um equipamento na Home (a fixture responde por qualquer série) para provar o que a restauração limpa ou mantém.
async function selecionarEquipamento(page) {
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
}

const equipamentoAtual = page => page.evaluate(() => window.SimpressApp.state.currentEquipamento?.serial ?? null);
const caminhos = (page, filtro) => {
  const lista = [];
  page.on("request", request => { const caminho = new URL(request.url()).pathname; if (filtro(caminho)) lista.push(caminho); });
  return lista;
};
const BOTAO_RESTAURAR = "Restaurar versões anteriores à atualização de 25/10/2026, 10:00:00";

async function restaurarPrimeiro(page) {
  await page.getByRole("button", { name: BOTAO_RESTAURAR }).click();
  const confirmacao = page.getByRole("dialog", { name: "Restaurar inventários?" });
  await confirmacao.getByRole("button", { name: "Restaurar" }).click();
  await expect(confirmacao).toBeHidden();
}

async function abrirHistoricoSemNavegar(page) {
  await page.locator("#btn-resumo-aba").click();
  await page.locator("#cockpit-comparison-legacy").click();
  await expect(page.locator(`${LISTA} article`)).toHaveCount(4);
}

const grupo = (page, rotulo) => page.locator(`${LISTA} section[aria-label="Atualizações de ${rotulo}"]`);
const cartao = (page, horario) => page.locator(`${LISTA} article`).filter({ has: page.locator("header", { hasText: horario }) });

test.describe("Histórico de planilhas", () => {
  test("o contador fora da lista mantém o mesmo nó e avisa o painel a cada carga", async ({ page }) => {
    await prepararPagina(page);
    await rotaHistorico(page);
    await page.goto("/");
    const total = page.locator(TOTAL);
    // A contagem da partida já preencheu o contador; o nó ganha uma marca para provar que não é recriado.
    await expect(total).toHaveText("4 registros");
    await total.evaluate(no => { no.dataset.g9Marca = "1"; window.__g9No = no; });
    // O MutationObserver de data-panels.js força um GET /api/painel quando o contador muda.
    const painelAtualizado = page.waitForRequest(request => new URL(request.url()).pathname === "/api/painel");
    await page.locator("#btn-resumo-aba").click();
    await page.locator("#cockpit-comparison-legacy").click();
    await expect(page.locator(`${LISTA} article`)).toHaveCount(4);
    await painelAtualizado;
    expect(await total.evaluate(no => no === window.__g9No && no.dataset.g9Marca === "1" && no.isConnected)).toBe(true);
    await expect(total).toHaveText("4 registros");
  });

  test("agrupa por dia, mostra só métricas diferentes de zero e as ações de cada tipo", async ({ page }) => {
    await prepararPagina(page);
    await rotaHistorico(page);
    await abrirHistorico(page);

    await expect(page.locator(`${LISTA} > section > h4`)).toHaveText(["Hoje· 2 registros", "Ontem· 1 registro", "20/10/2026· 1 registro"]);
    await expect(grupo(page, "Hoje").locator("article")).toHaveCount(2);

    const atualizacao = cartao(page, "25/10/2026, 10:00:00");
    await expect(atualizacao.locator("header")).toContainText("Atualização");
    await expect(atualizacao.getByRole("definition").first()).toHaveText("endpoint-g9.csv");
    await expect(atualizacao.locator("dl").nth(1).locator("dt")).toHaveText(["Apelidos atualizados", "Divergências de local", "Ambiguidades"]);
    await expect(atualizacao.locator("dl").nth(1).locator("dd")).toHaveText(["3", "1", "2"]);
    await expect(atualizacao.getByRole("button")).toHaveText(["Consultar resultado", "Restaurar versão anterior", "Excluir"]);
    await expect(atualizacao.getByRole("button", { name: "Restaurar versões anteriores à atualização de 25/10/2026, 10:00:00" })).toBeVisible();
    await expect(atualizacao.getByRole("button", { name: "Excluir atualização de 25/10/2026, 10:00:00" })).toBeVisible();

    const restauracao = cartao(page, "25/10/2026, 08:00:00");
    await expect(restauracao.locator("header")).toContainText("Restauração");
    await expect(restauracao.getByLabel("Inventários restaurados")).toContainText("simpress-anterior-g9.xlsx");
    await expect(restauracao).toContainText("Restauração do conjunto anterior a 20/10/2026, 09:00:00");
    await expect(restauracao.locator("dl").nth(1).locator("dd")).toHaveText(["10", "1.200"]);
    await expect(restauracao.getByRole("button")).toHaveText(["Desfazer restauração", "Excluir"]);
    await expect(restauracao.getByRole("button", { name: "Desfazer restauração de 25/10/2026, 08:00:00" })).toBeVisible();

    const anotacoes = cartao(page, "24/10/2026, 09:00:00");
    await expect(anotacoes.locator("header")).toContainText("Anotações sincronizadas");
    await expect(anotacoes).toContainText("As anotações podem ser consultadas e editadas neste notebook.");
    await expect(anotacoes.getByRole("definition")).toHaveText(["—", "—"]);
    await expect(anotacoes.getByRole("button")).toHaveText(["Consultar anotações"]);

    const antigo = cartao(page, "20/10/2026, 09:00:00");
    await expect(antigo).toContainText("Nenhuma alteração ou pendência.");
    await expect(antigo.getByRole("button")).toHaveText(["Consultar resultado", "Excluir"]);

    await expect(page.locator(TOTAL)).toHaveText("4 registros");
    // Datas de exportação: só atualizações (anotações sincronizadas ficam fora), a primeira selecionada.
    await expect(page.locator(`${SELECT_DATA} option`)).toHaveText(["25/10/2026", "20/10/2026"]);
    await expect(page.locator(SELECT_DATA)).toHaveValue("2026-10-25");
    await expect(page.locator(SELECT_DATA)).toBeEnabled();
    await expect(page.locator(BOTAO_EXPORTAR)).toBeEnabled();
  });

  test("exporta a data escolhida e mostra o texto aprovado", async ({ page }) => {
    await prepararPagina(page);
    const servidor = await rotaHistorico(page);
    await abrirHistorico(page);

    await page.locator(SELECT_DATA).selectOption("2026-10-20");
    const download = page.waitForEvent("download");
    await page.locator(BOTAO_EXPORTAR).click();
    expect((await download).suggestedFilename()).toBe("Historico_G9_2026-10-20.xlsx");
    await expect(page.getByRole("status").filter({ hasText: "Planilha Exportada com Sucesso!" })).toBeVisible();
    expect(servidor.chamadas.filter(chamada => chamada.caminho.endsWith("/exportar/excel")).map(chamada => chamada.busca)).toEqual(["?data=2026-10-20"]);
    await expect(page.locator(BOTAO_EXPORTAR)).toBeEnabled();
    await expect(page.locator(BOTAO_EXPORTAR)).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator(SELECT_DATA)).toHaveValue("2026-10-20");
  });

  test("restaura pela prévia com confirmação, Idempotency-Key e token da prévia", async ({ page }) => {
    await prepararPagina(page);
    const servidor = await rotaHistorico(page);
    await abrirHistorico(page);

    await page.getByRole("button", { name: "Restaurar versões anteriores à atualização de 25/10/2026, 10:00:00" }).click();
    const confirmacao = page.getByRole("dialog", { name: "Restaurar inventários?" });
    await expect(confirmacao).toBeVisible();
    await expect(confirmacao).toContainText("Reverter a atualização registrada em 25/10/2026, 10:00:00?");
    await expect(confirmacao).toContainText("no endpoint: endpoint-anterior-g9.csv (10 registros)");
    await expect(confirmacao).toContainText("na Simpress: simpress-anterior-g9.xlsx (1.200 registros)");
    await expect(confirmacao).toContainText("na Simpress: arquivo ausente");
    await confirmacao.getByRole("button", { name: "Restaurar" }).click();

    await expect(page.getByRole("status").filter({ hasText: "Inventários restaurados. 1.234 equipamentos carregados. A restauração pode ser desfeita pelo histórico." })).toBeVisible();
    const post = servidor.chamadas.find(chamada => chamada.metodo === "POST");
    expect(post.caminho).toBe("/api/historico-comparacoes/g9-hoje-atualizacao/restaurar");
    expect(post.headers["idempotency-key"]).toBeTruthy();
    expect(JSON.parse(post.corpo)).toEqual({ preview_token: PREVIA_RESTAURACAO.preview_token });
    // Depois de restaurar, a lista recarrega e o foco vai para o fechar do diálogo.
    await expect(page.locator(`${MODAL} [aria-label="Fechar histórico de planilhas"]`)).toBeFocused();
    const botao = page.getByRole("button", { name: "Restaurar versões anteriores à atualização de 25/10/2026, 10:00:00" });
    await expect(botao).toHaveText("Restaurar versão anterior");
    await expect(botao).toBeEnabled();
  });

  test("cancelar a restauração não envia nada", async ({ page }) => {
    await prepararPagina(page);
    const servidor = await rotaHistorico(page);
    await abrirHistorico(page);

    const botao = page.getByRole("button", { name: "Desfazer restauração de 25/10/2026, 08:00:00" });
    await botao.click();
    const confirmacao = page.getByRole("dialog", { name: "Restaurar inventários?" });
    await expect(confirmacao).toBeVisible();
    await confirmacao.getByRole("button", { name: "Cancelar" }).click();
    await expect(confirmacao).toBeHidden();
    expect(servidor.chamadas.some(chamada => chamada.metodo === "POST")).toBe(false);
    await expect(botao).toHaveText("Desfazer restauração");
    await expect(botao).toBeEnabled();
  });

  test("restauração com sucesso limpa o equipamento escolhido e recarrega estatísticas, unidades e lista", async ({ page }) => {
    await prepararPagina(page);
    const servidor = await rotaHistorico(page);
    await page.goto("/");
    await selecionarEquipamento(page);
    expect(await equipamentoAtual(page)).toBe("LENTO");
    await abrirHistoricoSemNavegar(page);
    const recargas = caminhos(page, caminho => ["/api/stats", "/api/unidades", "/api/historico-comparacoes"].includes(caminho));

    await restaurarPrimeiro(page);
    await expect(page.getByRole("status").filter({ hasText: "Inventários restaurados." })).toBeVisible();
    expect(await equipamentoAtual(page)).toBeNull();
    await expect(page.locator("#input-serial")).toHaveValue("");
    expect([...recargas].sort()).toEqual(["/api/historico-comparacoes", "/api/stats", "/api/unidades"]);
    expect(servidor.restauracoes).toBe(1);
  });

  test("restauração recusada mantém o equipamento escolhido e mostra o erro", async ({ page }) => {
    await prepararPagina(page);
    await rotaHistorico(page, { restaurar: route => route.fulfill({ status: 409, json: { detail: "Backup fictício indisponível" } }) });
    await page.goto("/");
    await selecionarEquipamento(page);
    await abrirHistoricoSemNavegar(page);

    await restaurarPrimeiro(page);
    await expect(page.locator("#toast-container")).toContainText("Backup fictício indisponível");
    expect(await equipamentoAtual(page)).toBe("LENTO");
    await expect(page.locator("#input-serial")).toHaveValue("LENTO");
    const botao = page.getByRole("button", { name: BOTAO_RESTAURAR });
    await expect(botao).toHaveText("Restaurar versão anterior");
    await expect(botao).toBeEnabled();
  });

  test("retentativa após resposta perdida reusa a mesma chave e a mesma prévia; depois do sucesso, chave nova", async ({ page }) => {
    await prepararPagina(page);
    const servidor = await rotaHistorico(page, {
      restaurar: (route, n) => n === 1
        ? route.abort("connectionreset")
        : route.fulfill({ json: { evento: { total_equipamentos_carregados: 1, desfazer_disponivel: true } } }),
    });
    await abrirHistorico(page);
    const posts = () => servidor.chamadas.filter(chamada => chamada.metodo === "POST");
    const botao = page.getByRole("button", { name: BOTAO_RESTAURAR });

    await restaurarPrimeiro(page);
    await expect.poll(() => posts().length).toBe(1);
    await expect(botao).toBeEnabled();
    await restaurarPrimeiro(page);
    await expect(page.getByRole("status").filter({ hasText: "Inventários restaurados. 1 equipamento carregado." })).toBeVisible();
    await expect(botao).toBeEnabled();
    await restaurarPrimeiro(page);
    await expect.poll(() => posts().length).toBe(3);

    const [primeiro, segundo, terceiro] = posts();
    expect(segundo.headers["idempotency-key"]).toBe(primeiro.headers["idempotency-key"]);
    expect(segundo.corpo).toBe(primeiro.corpo);
    expect(JSON.parse(primeiro.corpo)).toEqual({ preview_token: PREVIA_RESTAURACAO.preview_token });
    expect(terceiro.headers["idempotency-key"]).not.toBe(segundo.headers["idempotency-key"]);
    expect(terceiro.corpo).not.toBe(segundo.corpo);
  });

  test("abrir e excluir não forçam mais GET /api/painel que o módulo antigo", async ({ page }) => {
    await prepararPagina(page);
    await rotaHistorico(page);
    await page.goto("/");
    await expect(page.locator(TOTAL)).toHaveText("4 registros");
    await page.waitForLoadState("networkidle");
    const painel = caminhos(page, caminho => caminho === "/api/painel");

    await abrirHistoricoSemNavegar(page);
    await page.waitForLoadState("networkidle");
    expect(painel.length).toBe(PAINEL_POR_ABERTURA);

    painel.length = 0;
    await page.getByRole("button", { name: "Excluir atualização de 20/10/2026, 09:00:00" }).click();
    await page.getByRole("dialog", { name: "Excluir atualização?" }).getByRole("button", { name: "Excluir" }).click();
    await expect(page.locator(TOTAL)).toHaveText("3 registros");
    await page.waitForLoadState("networkidle");
    expect(painel.length).toBe(PAINEL_POR_EXCLUSAO);
  });

  test("excluir confirma, apaga, recarrega a lista e atualiza o contador", async ({ page }) => {
    await prepararPagina(page);
    const servidor = await rotaHistorico(page);
    await abrirHistorico(page);

    await page.getByRole("button", { name: "Excluir atualização de 20/10/2026, 09:00:00" }).click();
    const confirmacao = page.getByRole("dialog", { name: "Excluir atualização?" });
    await expect(confirmacao).toContainText("Tem certeza de que deseja excluir esta atualização de 20/10/2026, 09:00:00? Essa ação não poderá ser desfeita.");
    await confirmacao.getByRole("button", { name: "Excluir" }).click();

    await expect(page.getByRole("status").filter({ hasText: "Atualização excluída do histórico." })).toBeVisible();
    expect(servidor.chamadas.filter(chamada => chamada.metodo === "DELETE").map(chamada => chamada.caminho)).toEqual(["/api/historico-comparacoes/g9-antigo"]);
    await expect(page.locator(`${LISTA} article`)).toHaveCount(3);
    await expect(page.locator(TOTAL)).toHaveText("3 registros");
    await expect(page.locator(`${SELECT_DATA} option`)).toHaveText(["25/10/2026"]);
  });

  test("consultar abre o resultado salvo no painel de comparação e fecha o diálogo", async ({ page }) => {
    await prepararPagina(page);
    const servidor = await rotaHistorico(page);
    await abrirHistorico(page);

    await cartao(page, "25/10/2026, 10:00:00").getByRole("button", { name: "Consultar resultado" }).click();
    await expect(page.locator('[data-cockpit-tool-panel="comparacao"]')).toBeVisible();
    await expect(page.locator(MODAL)).toBeHidden();
    await expect(page.locator("#btn-exportar-resultado-comparacao")).toHaveAttribute("data-history-date", "2026-10-25");
    expect(servidor.chamadas.some(chamada => chamada.metodo === "GET" && chamada.caminho === "/api/historico-comparacoes/g9-hoje-atualizacao")).toBe(true);
  });

  test("lista vazia avisa e desliga a exportação", async ({ page }) => {
    await prepararPagina(page);
    await rotaHistorico(page, { eventos: [] });
    await page.goto("/");
    await expect(page.locator(TOTAL)).toHaveText("0 registros");
    await page.locator("#btn-resumo-aba").click();
    await page.locator("#cockpit-comparison-legacy").click();
    await expect(page.locator(LISTA).getByRole("status")).toHaveText("Nenhum histórico ainda.");
    await expect(page.locator(`${SELECT_DATA} option`)).toHaveText(["Sem datas disponíveis"]);
    await expect(page.locator(SELECT_DATA)).toBeDisabled();
    await expect(page.locator(BOTAO_EXPORTAR)).toBeDisabled();
  });

  test("falha da lista mostra o erro e marca as datas como indisponíveis", async ({ page }) => {
    await prepararPagina(page);
    await rotaHistorico(page, { falharLista: true });
    const erros = [];
    page.on("console", mensagem => { if (mensagem.type() === "error") erros.push(mensagem.text()); });
    await page.goto("/");
    await expect(page.locator(`${SELECT_DATA} option`)).toHaveText(["Datas indisponíveis"]);
    await page.locator("#btn-resumo-aba").click();
    await page.locator("#cockpit-comparison-legacy").click();
    await expect(page.locator(LISTA).getByRole("alert")).toHaveText("Falha simulada do histórico.");
    await expect(page.locator(LISTA)).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator(SELECT_DATA)).toBeDisabled();
    await expect(page.locator(BOTAO_EXPORTAR)).toBeDisabled();
    expect(erros.some(texto => texto.startsWith("Erro ao carregar histórico de planilhas:"))).toBe(true);
  });

  test("fecha pelo botão do rodapé e pelo Escape devolvendo o foco", async ({ page }) => {
    await prepararPagina(page);
    await rotaHistorico(page);
    await abrirHistorico(page);
    await expect(page.locator(`${MODAL} [aria-label="Fechar histórico de planilhas"]`)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(MODAL)).toBeHidden();
    await expect(page.locator("#cockpit-comparison-legacy")).toBeFocused();
    await page.locator("#cockpit-comparison-legacy").click();
    await expect(page.locator(MODAL)).toBeVisible();
    await page.locator(MODAL).getByRole("button", { name: "Fechar", exact: true }).click();
    await expect(page.locator(MODAL)).toBeHidden();
  });
});

// Baseline visual: o diálogo com a lista carregada, nos dois temas e nos dois tamanhos (projetos desktop e mobile).
for (const tema of ["light", "dark"]) {
  test(`histórico de planilhas (${tema})`, async ({ page }, testInfo) => {
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1366, height: 2000 });
    await prepararPagina(page, tema);
    await rotaHistorico(page);
    await abrirHistorico(page);
    await expect(page.locator(`${LISTA} article`)).toHaveCount(4);
    await expect(page.locator(`${MODAL} > div`)).toHaveScreenshot(`historico-planilhas-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}
