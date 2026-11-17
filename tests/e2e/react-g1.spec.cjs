// Migração React, grupo G1 (Sebrae): conflitos de edição do Dashboard (Chamados, F5) e resumo do histórico (Automação).
// O baseline de screenshots e os testes do invariante de envio foram gravados com o código antigo (JS puro),
// antes da troca para React: a seção em React tem de sair igual (390 e 1366 px, claro e escuro) e mandar o
// mesmo POST, só no clique. Comportamento portado de tests/frontend/test_sebrae_conflitos_ui.cjs e
// test_sebrae_historico_ui.cjs (DOM falso e funções puras).
const { test, expect } = require("@playwright/test");

const TOAST = "#toast-container .ck-toast";
const AVISO_SO_SHAREPOINT = "Sem número UTIC único para achar a linha no SharePoint: só dá para manter o valor do SharePoint.";

const celula = (id, extra = {}) => ({ id, tipo: "celula", chamado: "UTIC-2026-1", coluna: "G", sharepoint: "A", site: "B", ...extra });
const apagada = (id, extra = {}) => ({ id, tipo: "linha_apagada", chamado: "UTIC-2026-2", ...extra });

// Troca as respostas de /api/sebrae/dashboard/conflitos e guarda cada chamada (método, corpo e Content-Type).
// `get`/`post` podem ser funções (a resposta muda entre uma chamada e outra); { status, detail } responde erro.
async function rotaConflitos(page, { get, post }) {
  const chamadas = [];
  await page.route("**/api/sebrae/dashboard/conflitos", async route => {
    const pedido = route.request();
    const metodo = pedido.method();
    chamadas.push({ metodo, corpo: metodo === "POST" ? pedido.postDataJSON() : null, tipo: pedido.headers()["content-type"] || "" });
    const resposta = metodo === "POST" ? post : get;
    const valor = typeof resposta === "function" ? resposta() : resposta;
    if (valor?.status) return route.fulfill({ status: valor.status, json: { detail: valor.detail } });
    return route.fulfill({ json: valor });
  });
  return chamadas;
}

// Abre o painel Chamados (F5) da fixture (mesmo caminho do sebrae-dashboard.spec.cjs); `extra` entra em run=.
async function abrirPainel(page, request, { tema = "light", extra = "" } = {}) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  await request.get(`/__fixture_automacao?quantidade=0&sebrae=padrao&run=${extra}&antigos=`);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  await page.locator("#tab-automacao").click();
  const cartao = page.locator("#sebrae-novos-painel");
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("novo(s)");
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  return painel.locator("#sebrae-conflitos");
}

// Conta as chamadas às ações do código antigo que o painel aciona (lidas de window na hora da chamada).
async function contarAcoes(page, nomes) {
  await page.evaluate(lista => {
    window.__contagem = {};
    lista.forEach(nome => {
      const original = window[nome];
      window.__contagem[nome] = 0;
      window[nome] = (...args) => { window.__contagem[nome] += 1; return original?.(...args); };
    });
  }, nomes);
  return () => page.evaluate(() => ({ ...window.__contagem }));
}

for (const tema of ["light", "dark"]) {
  test(`baseline: conflitos de edição da fixture, tema ${tema}`, async ({ page, request }) => {
    const secao = await abrirPainel(page, request, { tema, extra: "&conflitos=1" });
    await expect(secao.getByRole("group")).toHaveCount(3);
    await secao.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expect(secao).toHaveScreenshot(`conflitos-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}

test.describe("conflitos de edição: comportamento", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento: basta um tamanho");

  test("IDs, ARIA e textos aprovados da seção ficam iguais", async ({ page, request }) => {
    const secao = await abrirPainel(page, request, { extra: "&conflitos=1" });
    await expect(secao).toBeVisible();
    await expect(secao).toHaveAttribute("aria-labelledby", "sebrae-conflitos-titulo");
    await expect(secao.locator("#sebrae-conflitos-titulo")).toHaveText("Conflitos de edição no Dashboard");
    await expect(secao.locator("#sebrae-conflitos-dica")).toHaveAttribute("role", "tooltip");
    await expect(secao.locator(".ck-campo__ajuda")).toHaveText("Nada foi enviado.");
    await expect(secao.locator("#sebrae-conflitos-status")).toHaveAttribute("role", "status");
    await expect(secao.locator("#sebrae-conflitos-status")).toHaveAttribute("aria-live", "polite");
    await expect(secao.locator("#btn-sebrae-conflitos-enviar")).toHaveText("Salvar escolhas e reenviar");
    const grupo = secao.locator("#sebrae-conflitos-lista fieldset.sebrae-conflito").first();
    await expect(grupo).toHaveAttribute("data-conflito-id", "c1");
    await expect(grupo.locator("legend.sebrae-conflito__texto")).toHaveCount(1);
    await expect(grupo.locator("#sebrae-conflito-0-sharepoint")).toHaveAttribute("name", "sebrae-conflito-0");
    await expect(grupo.locator("#sebrae-conflito-0-site")).toHaveAttribute("value", "site");
    const ids = await page.evaluate(() => [...document.querySelectorAll("[id]")].map(no => no.id));
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test("invariante: abrir a lista não envia nada; o POST sai só no clique, com escolhas, enviar e versao_importacao", async ({ page, request }) => {
    const chamadas = await rotaConflitos(page, {
      get: { conflitos: [celula("a"), apagada("b")], escolhas: {}, criado_em: "2026-11-12T10:00:00", versao_importacao: "v-atual" },
      post: { escolhas: { a: "site", b: "sharepoint" }, enviar: { iniciado: true, motivo: "" } },
    });
    await page.route("**/api/automacao/estado*", route => route.fulfill({ json: { estado: "em_andamento", rotina: "enviar", ultima: null } }));
    const secao = await abrirPainel(page, request);
    await expect(secao).toBeVisible();
    const grupos = secao.getByRole("group");
    await expect(grupos).toHaveCount(2);
    await expect(grupos.first().locator("legend")).toHaveText('Chamado UTIC-2026-1, coluna G: SharePoint diz "A", site quer "B".');
    await expect(grupos.nth(1).locator("legend")).toHaveText("Chamado UTIC-2026-2: linha apagada no SharePoint, mas editada no site.");
    await expect(grupos.first().locator("label")).toHaveText(["Manter o do SharePoint", "Usar o do site"]);
    const botao = secao.locator("#btn-sebrae-conflitos-enviar");
    const status = secao.locator("#sebrae-conflitos-status");
    await expect(botao).toBeDisabled();
    await expect(status).toHaveText("Escolha uma opção em cada célula (faltam 2).");
    await grupos.first().getByRole("radio", { name: "Usar o do site" }).check();
    await expect(status).toHaveText("Escolha uma opção em cada célula (faltam 1).");
    await expect(botao).toBeDisabled();
    await grupos.nth(1).getByRole("radio", { name: "Manter o do SharePoint" }).check();
    await expect(botao).toBeEnabled();
    await expect(status).toHaveText("");
    expect(chamadas.filter(item => item.metodo === "POST")).toEqual([]);
    const contagem = await contarAcoes(page, ["atualizarEstadoAutomacao"]);
    await botao.click();
    await expect(status).toHaveText("Escolhas salvas. Reenviando ao SharePoint…");
    expect(await contagem()).toEqual({ atualizarEstadoAutomacao: 1 }); // mostra a rotina enviar na Automação
    await expect(botao).toBeDisabled(); // fica desligado enquanto o envio roda
    const posts = chamadas.filter(item => item.metodo === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].corpo).toEqual({ escolhas: { a: "site", b: "sharepoint" }, enviar: true, versao_importacao: "v-atual" });
    expect(posts[0].tipo).toContain("application/json");
  });

  test("invariante: com aceita_site falso só há Manter o do SharePoint, com aviso, e site nunca vai no POST", async ({ page, request }) => {
    const chamadas = await rotaConflitos(page, {
      get: { conflitos: [celula("u", { chamado: "linha:2", aceita_site: false }), celula("a", { aceita_site: true }), apagada("b")], escolhas: { u: "site" }, criado_em: "", versao_importacao: "v1" },
      post: { escolhas: {}, enviar: { iniciado: false, motivo: "x" } },
    });
    const secao = await abrirPainel(page, request);
    const [restrito, comum, antigo] = [0, 1, 2].map(i => secao.getByRole("group").nth(i));
    await expect(restrito.locator("label")).toHaveText(["Manter o do SharePoint"]);
    await expect(restrito.getByRole("radio")).toHaveCount(1);
    await expect(restrito.getByRole("radio")).not.toBeChecked(); // um site gravado antes não vale aqui
    await expect(restrito.locator(".sebrae-conflito__aviso")).toHaveText(AVISO_SO_SHAREPOINT);
    await expect(comum.getByRole("radio")).toHaveCount(2);
    await expect(comum.locator(".sebrae-conflito__aviso")).toHaveCount(0);
    await expect(antigo.getByRole("radio")).toHaveCount(2); // conflito sem a chave aceita os dois
    const botao = secao.locator("#btn-sebrae-conflitos-enviar");
    await expect(botao).toBeDisabled(); // o site gravado em u não conta como escolha
    await restrito.getByRole("radio", { name: "Manter o do SharePoint" }).check();
    await comum.getByRole("radio", { name: "Usar o do site" }).check();
    await antigo.getByRole("radio", { name: "Usar o do site" }).check();
    await botao.click();
    await expect(secao.locator("#sebrae-conflitos-status")).toHaveText("Escolhas salvas, mas o envio não começou: x");
    await expect(botao).toBeEnabled();
    expect(chamadas.filter(item => item.metodo === "POST").map(item => item.corpo.escolhas)).toEqual([{ u: "sharepoint", a: "site", b: "site" }]);
  });

  test("escolha gravada antes aparece marcada e já libera o reenvio", async ({ page, request }) => {
    await rotaConflitos(page, { get: { conflitos: [celula("a")], escolhas: { a: "sharepoint", velha: "site" }, criado_em: "" } });
    const secao = await abrirPainel(page, request);
    await expect(secao.getByRole("radio", { name: "Manter o do SharePoint" })).toBeChecked();
    await expect(secao.getByRole("radio", { name: "Usar o do site" })).not.toBeChecked();
    await expect(secao.locator("#btn-sebrae-conflitos-enviar")).toBeEnabled();
  });

  test("valor vindo do SharePoint entra só como texto; valor longo é cortado e vazio vira (vazio)", async ({ page, request }) => {
    const perigoso = '<img src=x onerror="alert(1)">';
    await rotaConflitos(page, { get: { conflitos: [celula("a", { sharepoint: perigoso }), celula("b", { site: "" }), celula("c", { site: "x".repeat(400) })], escolhas: {}, criado_em: "" } });
    const secao = await abrirPainel(page, request);
    await expect(secao.getByRole("group").first().locator("legend")).toHaveText(`Chamado UTIC-2026-1, coluna G: SharePoint diz "${perigoso}", site quer "B".`);
    await expect(secao.locator("img")).toHaveCount(0);
    await expect(secao.getByRole("group").nth(1).locator("legend")).toHaveText('Chamado UTIC-2026-1, coluna G: SharePoint diz "A", site quer (vazio).');
    await expect(secao.getByRole("group").nth(2).locator("legend")).toHaveText(`Chamado UTIC-2026-1, coluna G: SharePoint diz "A", site quer "${"x".repeat(300)}…".`);
  });

  test("sem conflito a seção fica escondida e o botão desligado; falha na consulta não mostra erro", async ({ page, request }) => {
    let falhar = false;
    await rotaConflitos(page, { get: () => (falhar ? { status: 500, detail: "fora do ar" } : { conflitos: [], escolhas: {}, criado_em: "" }) });
    const secao = await abrirPainel(page, request);
    await expect(secao).toBeHidden();
    await expect(secao.locator("#btn-sebrae-conflitos-enviar")).toBeDisabled();
    await expect(secao.getByRole("group")).toHaveCount(0);
    falhar = true;
    await page.evaluate(() => window.carregarConflitosSebrae());
    await expect(secao).toBeHidden();
    await expect(page.locator(TOAST)).toHaveCount(0);
  });

  test("envio em andamento continua esperando; se parar com conflitos de novo, mantém a lista e libera o botão", async ({ page, request }) => {
    test.setTimeout(30_000);
    let estado = "em_andamento";
    await rotaConflitos(page, {
      get: { conflitos: [celula("a")], escolhas: { a: "site" }, criado_em: "" },
      post: { escolhas: { a: "site" }, enviar: { iniciado: true, motivo: "" } },
    });
    let consultas = 0;
    await page.route("**/api/automacao/estado*", route => {
      consultas += 1;
      return route.fulfill({ json: { estado, rotina: "enviar", ultima: { status: "erro" } } });
    });
    const secao = await abrirPainel(page, request);
    const botao = secao.locator("#btn-sebrae-conflitos-enviar");
    await expect(botao).toBeEnabled();
    const antes = consultas;
    const contagem = await contarAcoes(page, ["carregarNovosSebrae"]);
    await botao.click();
    await expect(secao.locator("#sebrae-conflitos-status")).toHaveText("Escolhas salvas. Reenviando ao SharePoint…");
    await expect.poll(() => consultas - antes, { timeout: 8000 }).toBeGreaterThanOrEqual(2); // segue consultando a automação
    await expect(botao).toBeDisabled();
    estado = "livre";
    // carregarNovosSebrae recarrega os conflitos, mas isso não apaga o aviso de que o envio parou.
    await expect(botao).toBeEnabled({ timeout: 8000 });
    await expect(secao.locator("#sebrae-conflitos-status")).toHaveText("O envio parou de novo e ainda há conflitos. Confira a lista e escolha outra vez.");
    await expect(secao).toBeVisible();
    await expect(secao.getByRole("group")).toHaveCount(1);
    expect((await contagem()).carregarNovosSebrae).toBeGreaterThanOrEqual(1); // atualiza o aviso e a lista de chamados
    await expect(page.locator(TOAST).filter({ hasText: "Conflitos" })).toHaveCount(0);
  });

  test("fim do envio: o botão só volta depois da lista nova; lista vazia sem concluir avisa e a consulta para", async ({ page, request }) => {
    test.setTimeout(30_000);
    let soltar;
    let segurar = false;
    const lista = { conflitos: [celula("a")], escolhas: { a: "site" }, criado_em: "", versao_importacao: "v1" };
    const posts = [];
    await page.route("**/api/sebrae/dashboard/conflitos", async route => {
      if (route.request().method() === "POST") {
        posts.push(route.request().postDataJSON());
        return route.fulfill({ json: { escolhas: { a: "site" }, enviar: { iniciado: true, motivo: "" } } });
      }
      if (segurar) await new Promise(resolve => { soltar = resolve; });
      return route.fulfill({ json: lista });
    });
    let consultas = 0;
    await page.route("**/api/automacao/estado*", route => {
      // Só a consulta da seção (sem query string); o painel de Automação antigo tem o próprio poll, com ?offset=.
      if (!new URL(route.request().url()).search) consultas += 1;
      return route.fulfill({ json: { estado: "livre", rotina: "enviar", ultima: { status: "erro" } } });
    });
    const secao = await abrirPainel(page, request);
    const botao = secao.locator("#btn-sebrae-conflitos-enviar");
    await expect(botao).toBeEnabled();
    segurar = true;
    await botao.click();
    await expect.poll(() => typeof soltar, { timeout: 8000 }).toBe("function"); // a rotina acabou e o GET da lista está pendente
    await expect(botao).toBeDisabled();
    await botao.click({ force: true });
    expect(posts).toHaveLength(1);
    segurar = false;
    lista.conflitos = [];
    soltar();
    await expect(page.locator(TOAST).filter({ hasText: "O envio terminou sem concluir. Veja o resultado na Automação." })).toHaveCount(1);
    await expect(secao).toBeHidden();
    const depois = consultas;
    await page.waitForTimeout(3500);
    expect(consultas).toBe(depois); // nada mais consulta a automação depois do fim
    expect(posts).toHaveLength(1);
  });

  test("422 mostra o erro, avisa e recarrega a lista", async ({ page, request }) => {
    const detalhe = "Há escolha para um conflito que não existe mais; recarregue a lista.";
    const chamadas = await rotaConflitos(page, {
      get: { conflitos: [celula("a")], escolhas: {}, criado_em: "" },
      post: { status: 422, detail: detalhe },
    });
    const secao = await abrirPainel(page, request);
    await secao.getByRole("radio", { name: "Usar o do site" }).check();
    const getsAntes = chamadas.filter(item => item.metodo === "GET").length;
    await secao.locator("#btn-sebrae-conflitos-enviar").click();
    await expect(secao.locator("#sebrae-conflitos-status")).toHaveText(detalhe);
    await expect(page.locator(TOAST).filter({ hasText: detalhe })).toBeVisible();
    expect(chamadas.filter(item => item.metodo === "GET").length).toBe(getsAntes + 1); // consulta de novo
    await expect(secao.locator("#btn-sebrae-conflitos-enviar")).toBeEnabled();
  });

  test("409 de versão antiga recarrega a lista e o próximo POST leva a versão nova", async ({ page, request }) => {
    let versao = "v1";
    const chamadas = await rotaConflitos(page, {
      get: () => ({ conflitos: [celula("a")], escolhas: {}, criado_em: "", versao_importacao: versao }),
      post: { status: 409, detail: "O Dashboard foi importado de novo." },
    });
    const secao = await abrirPainel(page, request);
    const radio = secao.getByRole("radio", { name: "Manter o do SharePoint" });
    await radio.check();
    versao = "v2";
    await secao.locator("#btn-sebrae-conflitos-enviar").click();
    await expect(secao.locator("#sebrae-conflitos-status")).toHaveText("O Dashboard foi importado de novo.");
    await expect(secao.locator("#btn-sebrae-conflitos-enviar")).toBeEnabled(); // a escolha local sobrevive ao recarregamento
    await secao.locator("#btn-sebrae-conflitos-enviar").click();
    await expect.poll(() => chamadas.filter(item => item.metodo === "POST").length).toBe(2);
    expect(chamadas.filter(item => item.metodo === "POST").map(item => item.corpo.versao_importacao)).toEqual(["v1", "v2"]);
  });

});

// ---- Resumo do histórico do Dashboard Sebrae (Automação, cartão "Chamados novos do SoftExpert") ----
// Baseline e comportamento gravados com o código antigo (frontend/src/aplicacao/pontes.ts), antes do React.

async function abrirResumoHistorico(page, request, { tema = "light" } = {}) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  await request.get("/__fixture_automacao?quantidade=0&sebrae=padrao&run=&antigos=");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  await page.locator("#tab-automacao").click();
  return page.locator("#sebrae-novos-painel #sebrae-historico-resumo");
}

for (const tema of ["light", "dark"]) {
  test(`baseline: resumo do histórico da fixture, tema ${tema}`, async ({ page, request }) => {
    const resumo = await abrirResumoHistorico(page, request, { tema });
    await expect(resumo.locator("li")).toHaveCount(3);
    await resumo.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await expect(resumo).toHaveScreenshot(`historico-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}

test.describe("resumo do histórico: comportamento", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento: basta um tamanho");

  const rotaHistorico = (page, resposta) => {
    const urls = [];
    return page.route("**/api/sebrae/historico?*", route => {
      urls.push(new URL(route.request().url()).search);
      return resposta.status ? route.fulfill({ status: resposta.status, json: { detail: resposta.detail } }) : route.fulfill({ json: resposta });
    }).then(() => urls);
  };

  test("mostra só as três entradas mais recentes, com selo, contagens e repetições, só como texto", async ({ page, request }) => {
    const urls = await rotaHistorico(page, { itens: [
      { tipo: "busca", em: "2026-11-10T09:00:00-03:00", n_lidos: 1, ignorados: 2, n_pendentes: 3, n_erros: 1 },
      { tipo: "importacao", em: "2026-11-09T09:00:00-03:00", n_adicionados: 2, n_removidos: 1, n_alterados: 4, repeticoes: 1 },
      { tipo: "importacao", em: "data ruim", inicial: true, total: 1 },
      { tipo: "importacao", em: "2026-11-01T09:00:00-03:00", n_adicionados: 9 },
    ] });
    const resumo = await abrirResumoHistorico(page, request);
    await expect(resumo.locator("p.ck-campo__rotulo")).toHaveText("Últimos registros do histórico");
    const linhas = resumo.locator("ul.sebrae-historico-mini > li");
    await expect(linhas).toHaveCount(3);
    expect(urls.every(busca => busca === "?limite=3")).toBe(true);
    await expect(linhas.nth(0).locator(".ck-badge")).toHaveText("Busca");
    await expect(linhas.nth(0).locator(".ck-badge")).toHaveAttribute("data-status", "alerta");
    await expect(linhas.nth(0).locator(".sebrae-historico-mini__texto")).toHaveText("1 lido, 2 já no Dashboard, 3 pendentes, 1 com erro");
    await expect(linhas.nth(1).locator(".ck-badge")).toHaveText("Importação");
    await expect(linhas.nth(1).locator(".ck-badge")).not.toHaveAttribute("data-status", /.*/);
    await expect(linhas.nth(1).locator(".sebrae-historico-mini__texto")).toHaveText("2 adicionados, 1 removido, 4 com status alterado · Reimportado 1 vez");
    await expect(linhas.nth(2).locator(".sebrae-historico-mini__quando")).toHaveText("—");
    await expect(linhas.nth(2).locator(".sebrae-historico-mini__texto")).toHaveText("Primeira importação: 1 chamado");
    await expect(linhas.nth(0).locator(".sebrae-historico-mini__quando")).toHaveText(/^\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}$/);
    await expect(linhas.nth(0).locator("> *")).toHaveCount(3);
  });

  test("plural, busca sem contagens, repetição só na importação e tipo desconhecido com inicial maiúscula", async ({ page, request }) => {
    await rotaHistorico(page, { itens: [
      { tipo: "busca", em: "2026-11-10T09:00:00-03:00", repeticoes: 4 },
      { tipo: "importacao", em: "2026-11-09T09:00:00-03:00", inicial: true, total: 120, repeticoes: 3 },
      { tipo: "outro", em: "2026-11-08T09:00:00-03:00", n_alterados: 1 },
    ] });
    const linhas = (await abrirResumoHistorico(page, request)).locator("ul.sebrae-historico-mini > li");
    await expect(linhas.locator(".sebrae-historico-mini__texto")).toHaveText([
      "Nenhum chamado novo",
      "Primeira importação: 120 chamados · Reimportado 3 vezes",
      "1 com status alterado",
    ]);
    await expect(linhas.nth(2).locator(".ck-badge")).toHaveText("Outro");
  });

  test("tipo com < > fica texto, sem virar HTML", async ({ page, request }) => {
    await rotaHistorico(page, { itens: [{ tipo: "<b>x</b>", em: "2026-11-10T09:00:00-03:00" }] });
    const resumo = await abrirResumoHistorico(page, request);
    await expect(resumo.locator(".ck-badge")).toHaveText("<b>x</b>");
    await expect(resumo.locator("b")).toHaveCount(0);
    await expect(resumo.locator(".sebrae-historico-mini__texto")).toHaveText("Sem mudanças");
  });

  test("lista vazia avisa que não há importação registrada", async ({ page, request }) => {
    await rotaHistorico(page, { itens: [] });
    const resumo = await abrirResumoHistorico(page, request);
    await expect(resumo.locator("p.ck-campo__ajuda")).toHaveText("Nenhuma importação registrada ainda.");
    await expect(resumo.locator("li")).toHaveCount(0);
  });

  test("falha na consulta mostra a mensagem do servidor no lugar da lista", async ({ page, request }) => {
    await rotaHistorico(page, { status: 500, detail: "Histórico indisponível." });
    const resumo = await abrirResumoHistorico(page, request);
    await expect(resumo.locator("p.ck-campo__ajuda")).toHaveText("Histórico indisponível.");
    await expect(resumo.locator("li")).toHaveCount(0);
  });
});
