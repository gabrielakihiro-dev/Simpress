// Migração React, Dia 3, grupo G10 (Equipamento): pesquisa completa e diálogos de cadastro/apelido. Baselines gravados com o código antigo.
// Todo /api/* é simulado aqui, com dados sintéticos: nenhum teste chega ao backend real. Os baselines e o comportamento
// abaixo vêm do JS antigo (full-equipment-search.js e equipment-editor.js); o diálogo em React tem de passar sem mudanças.
const { test, expect } = require("@playwright/test");

const FILTROS = {
  categories: [
    { value: "notebook", label: "Notebooks", count: 48 },
    { value: "macbook", label: "MacBooks", count: 6 },
    { value: "monitor", label: "Monitores", count: 16 },
  ],
  cities: ["Curitiba", "Londrina", "Maringá"],
  users: { sem: 12, com: 58 },
};
const FILTROS_VAZIOS = { categories: [], cities: [], users: { sem: 0, com: 0 } };
const TIPOS = ["Notebook", "Micro Computador", "Monitor", "Headsets"];
const CIDADES = ["Curitiba", "Londrina", "Maringá"];
const itens = (quantidade, inicio) => Array.from({ length: quantidade }, (_, i) => {
  const n = inicio + i + 1;
  return {
    serial: `BRJ${String(n).padStart(4, "0")}`, tipo: TIPOS[n % 4], modelo: `Modelo de teste ${(n % 5) + 1}`,
    apelido: n % 3 === 0 ? "" : `PRTESTE${String(n).padStart(3, "0")}`, retirada_cidade: CIDADES[n % 3],
    ...(n % 2 === 0 ? { usuarios_logados: `usuario.teste${n}`, usuarios_logados_origem: "endpoint" } : {}),
  };
});

const equipamentosBase = () => ({
  LENTO: { serial: "LENTO", modelo: "Notebook de teste", tipo: "Notebook", apelido: "TESTE-001", idCliente: "Obs de teste", retirada_cidade: "Curitiba" },
  OUTRO: { serial: "OUTRO", modelo: "Monitor de teste", tipo: "Monitor", apelido: "OUTRO-APELIDO", idCliente: "", retirada_cidade: "Londrina" },
});

// `pesquisa`: "ok" (50 de 70, com "Carregar mais"), "vazia" (nenhum resultado) ou "erro" (500). Só a pesquisa completa
// (include_filters=true) muda; o autocomplete e a lista da Home sempre respondem. Nenhuma resposta passa de `portao`:
// o teste cria uma promessa em `portao.apelido` ou `portao.salvar` e a libera quando quiser (resposta atrasada).
async function preparar(page, { tema = "light", pesquisa = "ok" } = {}) {
  const ambiente = { chamadas: [], portao: { apelido: null, salvar: null }, equipamentos: equipamentosBase() };
  ambiente.equipamento = serial => {
    const chave = String(serial).toUpperCase();
    ambiente.equipamentos[chave] ||= { serial: chave, modelo: "Modelo de teste", tipo: "Notebook", apelido: "", idCliente: "", retirada_cidade: "Curitiba" };
    return ambiente.equipamentos[chave];
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  page.on("request", requisicao => {
    const url = new URL(requisicao.url());
    if (url.pathname.startsWith("/api/")) ambiente.chamadas.push({ metodo: requisicao.method(), caminho: url.pathname, busca: url.searchParams, corpo: requisicao.postData() });
  });
  await page.route("**/api/buscar-expandida*", route => {
    const busca = new URL(route.request().url()).searchParams;
    const termo = busca.get("q") || "";
    if (busca.get("include_filters") === "true") {
      if (pesquisa === "erro") return route.fulfill({ status: 500, json: { detail: "Detalhe interno do servidor" } });
      if (pesquisa === "vazia") return route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 50, has_more: false, filters: FILTROS_VAZIOS } });
      const offset = Number(busca.get("offset"));
      const pagina = offset === 0 ? itens(50, 0) : itens(20, 50);
      return route.fulfill({ json: { items: pagina, total: 70, offset, limit: 50, has_more: offset + pagina.length < 70, filters: FILTROS } });
    }
    // Autocomplete e lista da Home. Termo "NOVO..." não existe: o autocomplete oferece o cadastro.
    if (termo.toUpperCase().startsWith("NOVO")) return route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 15, has_more: false, filters: FILTROS_VAZIOS } });
    return route.fulfill({ json: { items: itens(15, 0), total: 70, offset: 0, limit: 15, has_more: true, filters: FILTROS } });
  });
  await page.route("**/api/equipamento/*", async route => {
    const requisicao = route.request();
    const ultimo = decodeURIComponent(new URL(requisicao.url()).pathname.split("/").pop());
    if (requisicao.method() === "POST" && ultimo === "atualizar-apelido") {
      const { serial, apelido } = requisicao.postDataJSON();
      if (ambiente.portao.apelido) await ambiente.portao.apelido;
      ambiente.equipamento(serial).apelido = apelido;
      return route.fulfill({ json: { equipamento: { ...ambiente.equipamento(serial) } } });
    }
    if (requisicao.method() === "POST" && ultimo === "salvar") {
      const { serial, modelo, tipo, apelido, idCliente } = requisicao.postDataJSON();
      if (ambiente.portao.salvar) await ambiente.portao.salvar;
      Object.assign(ambiente.equipamento(serial), { modelo, tipo, apelido, idCliente });
      return route.fulfill({ json: { equipamento: { ...ambiente.equipamento(serial) } } });
    }
    if (requisicao.method() === "GET") return route.fulfill({ json: { ...ambiente.equipamento(ultimo) } });
    return route.fulfill({ status: 404, json: { detail: "Rota fora do previsto no teste" } });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  return ambiente;
}

async function buscar(page, serial) {
  await page.locator("#input-serial").fill(serial);
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText(serial);
}

// Digita o termo, espera o autocomplete (que o diálogo fecha ao abrir) e abre a pesquisa completa pela função da página.
async function abrirPesquisa(page, opcoes = {}) {
  const ambiente = await preparar(page, opcoes);
  await page.locator("#input-serial").fill("BRJ");
  await expect(page.locator("#autocomplete-box")).toBeVisible();
  await page.evaluate(() => window.abrirPesquisaCompleta());
  await expect(page.locator("#modal-pesquisa-completa")).toBeVisible();
  await expect(page.locator("#pesquisa-completa-status")).not.toHaveText(/^Carregando/);
  await page.mouse.move(0, 0);
  return ambiente;
}

async function abrirEdicao(page, opcoes = {}) {
  const ambiente = await preparar(page, opcoes);
  await buscar(page, "LENTO");
  await page.locator('[data-on-click="abrirModalEditarEquipamento"]').click();
  await expect(page.locator("#modal-editar-equipamento")).toBeVisible();
  await page.mouse.move(0, 0);
  return ambiente;
}

// Termo que não existe: o autocomplete mostra "Cadastrar ... como Novo Equipamento".
async function abrirCadastro(page, opcoes = {}) {
  const ambiente = await preparar(page, opcoes);
  await page.locator("#input-serial").fill(opcoes.serial || "NOVO123");
  await page.locator('#autocomplete-empty-state [data-on-click="cadastrarNovoSerialPesquisado"]').click();
  await expect(page.locator("#modal-editar-equipamento")).toBeVisible();
  await page.mouse.move(0, 0);
  return ambiente;
}

async function abrirApelido(page, opcoes = {}) {
  const ambiente = await preparar(page, opcoes);
  await buscar(page, "LENTO");
  await page.locator('[data-on-click="abrirModalEditarApelido"]').click();
  await expect(page.locator("#modal-editar-apelido")).toBeVisible();
  await page.mouse.move(0, 0);
  return ambiente;
}

// Troca a seleção com o diálogo aberto, como outro fluxo da página faria enquanto o salvamento ainda não respondeu.
async function trocarSelecao(page, serial) {
  await page.evaluate(valor => { document.getElementById("input-serial").value = valor; return window.buscarSerial(); }, serial);
  await expect(page.locator("#card-serial")).toHaveText(serial);
}

const esperarToast = (page, texto) => expect(page.locator("#toast-container .ck-toast", { hasText: texto })).toBeVisible();
const escritas = ambiente => ambiente.chamadas.filter(chamada => chamada.metodo !== "GET");
const pesquisasCompletas = ambiente => ambiente.chamadas.filter(chamada => chamada.caminho === "/api/buscar-expandida" && chamada.busca.get("include_filters") === "true");
const idsRepetidos = page => page.evaluate(() => {
  const ids = [...document.querySelectorAll("[id]")].map(el => el.id);
  return ids.filter((id, i) => ids.indexOf(id) !== i);
});

const foto = { animations: "disabled", maxDiffPixelRatio: 0.01 };
// O aviso de sucesso ou erro (canto da tela) não faz parte do diálogo: some antes da foto.
// A CSP da página (style-src 'self') bloqueia <style> injetado; mudar `style` pelo CSSOM é permitido.
async function fotografar(page, seletor, nome) {
  await page.evaluate(() => { document.getElementById("toast-container").style.display = "none"; });
  await expect(page.locator(seletor)).toHaveScreenshot(nome, foto);
}

for (const tema of ["light", "dark"]) {
  test(`baseline: pesquisa completa com resultados e Carregar mais, tema ${tema}`, async ({ page }) => {
    await abrirPesquisa(page, { tema });
    await expect(page.locator("#pesquisa-completa-lista > button")).toHaveCount(50);
    await expect(page.locator("#pesquisa-completa-status")).toHaveText("Exibindo 50 de 70 resultados.");
    await expect(page.locator("#btn-carregar-mais-pesquisa")).toBeVisible();
    await fotografar(page, "#modal-pesquisa-completa > .ck-dialogo", `pesquisa-resultados-${tema}.png`);
  });

  test(`baseline: pesquisa completa sem resultados, tema ${tema}`, async ({ page }) => {
    await abrirPesquisa(page, { tema, pesquisa: "vazia" });
    await expect(page.locator("#pesquisa-completa-status")).toHaveText("Nenhum equipamento encontrado para esse termo.");
    await expect(page.locator("#pesquisa-completa-contagem")).toHaveText("0 resultados");
    await fotografar(page, "#modal-pesquisa-completa > .ck-dialogo", `pesquisa-vazia-${tema}.png`);
  });

  test(`baseline: pesquisa completa com erro do servidor, tema ${tema}`, async ({ page }) => {
    await abrirPesquisa(page, { tema, pesquisa: "erro" });
    await expect(page.locator("#pesquisa-completa-status")).toHaveText("Não foi possível carregar a pesquisa. Feche a janela e tente novamente.");
    await expect(page.locator("#pesquisa-completa-contagem")).toHaveText("Buscando...");
    await fotografar(page, "#modal-pesquisa-completa > .ck-dialogo", `pesquisa-erro-${tema}.png`);
  });

  test(`baseline: edição do cadastro do equipamento, tema ${tema}`, async ({ page }) => {
    await abrirEdicao(page, { tema });
    await expect(page.locator("#modal-edit-titulo")).toHaveText("Atualizar Cadastro do Equipamento");
    await fotografar(page, "#modal-editar-equipamento > .ck-dialogo", `edicao-equipamento-${tema}.png`);
  });

  test(`baseline: cadastro de equipamento novo, tema ${tema}`, async ({ page }) => {
    await abrirCadastro(page, { tema });
    await expect(page.locator("#modal-edit-titulo")).toHaveText("Cadastrar Novo Equipamento");
    await fotografar(page, "#modal-editar-equipamento > .ck-dialogo", `cadastro-equipamento-${tema}.png`);
  });

  test(`baseline: editar apelido, tema ${tema}`, async ({ page }) => {
    await abrirApelido(page, { tema });
    await expect(page.locator("#apelido-serial-contexto")).toHaveText("Série: LENTO");
    await fotografar(page, "#modal-editar-apelido > .ck-dialogo", `editar-apelido-${tema}.png`);
  });
}

test.describe("estrutura e comportamento (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "estrutura não depende da largura: roda só no desktop");

  test("pesquisa completa aberta pelo Mostrar mais: IDs, ARIA, filtros e foco, sem IDs repetidos; Esc fecha", async ({ page }) => {
    await preparar(page, {});
    await page.locator("#input-serial").fill("BRJ");
    await expect(page.locator("#autocomplete-more-results")).toBeVisible();
    await expect(page.locator("#autocomplete-more-results [data-autocomplete-more-label]")).toHaveText("Mostrar mais (55)");
    await page.locator("#autocomplete-more-results button").click();
    const modal = page.locator("#modal-pesquisa-completa.modal-overlay.ck-veu");
    await expect(modal).toBeVisible();
    await expect(page.locator("#pesquisa-completa-lista > button")).toHaveCount(50);
    await expect(modal).toHaveAttribute("data-on-click", "fecharModalPesquisaCompleta");
    await expect(modal).toHaveAttribute("data-on-self-only", "");
    await expect(modal).toHaveAttribute("data-accessible-modal", "true");
    await expect(modal).toHaveAttribute("data-close-function", "fecharModalPesquisaCompleta");
    const dialogo = modal.locator(":scope > .ck-dialogo.modal-panel");
    await expect(dialogo).toHaveAttribute("role", "dialog");
    await expect(dialogo).toHaveAttribute("aria-modal", "true");
    await expect(dialogo).toHaveAttribute("aria-labelledby", "modal-pesquisa-completa-titulo");
    await expect(dialogo.locator("h3#modal-pesquisa-completa-titulo")).toContainText("Resultados da pesquisa");
    await expect(modal.locator("#pesquisa-completa-termo")).toHaveText("BRJ");
    await expect(modal.locator("#pesquisa-completa-contagem")).toHaveText("70 resultados");
    await expect(modal.locator("#pesquisa-completa-contagem")).toHaveAttribute("role", "status");
    await expect(modal.locator("#pesquisa-completa-contagem")).toHaveAttribute("aria-live", "polite");
    await expect(modal.locator("#pesquisa-completa-contagem")).toHaveClass(/(^|\s)text-cyan-200(\s|$)/);
    await expect(modal.locator("#pesquisa-completa-status")).toHaveText("Exibindo 50 de 70 resultados.");
    await expect(modal.locator("#pesquisa-completa-status")).toHaveAttribute("role", "status");
    await expect(modal.locator("#pesquisa-completa-status")).toHaveAttribute("aria-live", "polite");
    await expect(modal.locator("#pesquisa-completa-lista")).toHaveAttribute("aria-label", "Resultados completos da pesquisa");
    const primeira = modal.locator("#pesquisa-completa-lista > button").first();
    await expect(primeira).toHaveAttribute("type", "button");
    await expect(primeira).toHaveAttribute("data-result-index", "0");
    await expect(primeira).toHaveAttribute("aria-label", "Selecionar equipamento, BRJ0001, Micro Computador, Modelo de teste 2, PRTESTE001, Londrina");
    await expect(modal.locator("#pesquisa-completa-lista > button").last()).toHaveAttribute("data-result-index", "49");
    await expect(modal.locator('label[for="filtro-pesquisa-categoria"]')).toContainText("Categoria");
    await expect(modal.locator('label[for="filtro-pesquisa-cidade"]')).toContainText("Cidade");
    await expect(modal.locator('label[for="filtro-pesquisa-usuario"]')).toContainText("Usuário");
    const opcoes = async seletor => modal.locator(`${seletor} option`).evaluateAll(lista => lista.map(o => [o.value, o.textContent]));
    expect(await opcoes("#filtro-pesquisa-categoria")).toEqual([["", "Todas as categorias"], ["notebook", "Notebooks (48)"], ["macbook", "MacBooks (6)"], ["monitor", "Monitores (16)"]]);
    expect(await opcoes("#filtro-pesquisa-cidade")).toEqual([["", "Todas as cidades"], ["Curitiba", "Curitiba"], ["Londrina", "Londrina"], ["Maringá", "Maringá"]]);
    expect(await opcoes("#filtro-pesquisa-usuario")).toEqual([["", "Todos os usuários"], ["sem", "Sem usuário (12)"], ["com", "Com usuário (58)"]]);
    for (const id of ["categoria", "cidade", "usuario"]) {
      await expect(modal.locator(`#filtro-pesquisa-${id}`)).toHaveAttribute("data-on-change", "alterarFiltrosPesquisaCompleta");
      await expect(modal.locator(`#filtro-pesquisa-${id}`)).toHaveValue("");
      await expect(modal.locator(`#filtro-pesquisa-${id}`)).toBeEnabled();
    }
    await expect(modal.locator("#btn-limpar-filtros-pesquisa")).toHaveClass(/hidden/);
    await expect(modal.locator("#btn-limpar-filtros-pesquisa")).toHaveText("Limpar filtros");
    await expect(modal.locator("#btn-carregar-mais-pesquisa")).toHaveText("Carregar mais");
    await expect(modal.locator("#btn-carregar-mais-pesquisa")).toHaveAttribute("data-on-click", "carregarMaisResultadosPesquisa");
    await expect(modal.locator("#btn-carregar-mais-pesquisa")).toBeVisible();
    await expect(modal.getByRole("button", { name: "Fechar", exact: true })).toHaveText("Fechar");
    await expect(modal.locator("#btn-fechar-pesquisa-completa")).toHaveAttribute("aria-label", "Fechar resultados da pesquisa");
    await expect(modal.locator("#btn-fechar-pesquisa-completa")).toBeFocused();
    expect(await idsRepetidos(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });

  test("pesquisa completa: o clique no fundo fecha; o clique dentro do diálogo não", async ({ page }) => {
    await abrirPesquisa(page);
    await page.locator("#pesquisa-completa-termo").click();
    await expect(page.locator("#modal-pesquisa-completa")).toBeVisible();
    await page.locator("#modal-pesquisa-completa").click({ position: { x: 4, y: 4 } });
    await expect(page.locator("#modal-pesquisa-completa")).toBeHidden();
  });

  test("pesquisa completa: filtro de usuário manda usuario=sem e mostra Limpar filtros; limpar volta ao todo", async ({ page }) => {
    const ambiente = await abrirPesquisa(page);
    const inicial = pesquisasCompletas(ambiente).at(-1).busca;
    expect([inicial.get("q"), inicial.get("offset"), inicial.get("limit"), inicial.get("include_filters")]).toEqual(["BRJ", "0", "50", "true"]);
    expect([inicial.has("usuario"), inicial.has("categoria"), inicial.has("cidade")]).toEqual([false, false, false]);
    await page.locator("#filtro-pesquisa-usuario").selectOption("sem");
    await expect.poll(() => pesquisasCompletas(ambiente).at(-1).busca.get("usuario")).toBe("sem");
    await expect(page.locator("#btn-limpar-filtros-pesquisa")).toBeVisible();
    await expect(page.locator("#filtro-pesquisa-usuario")).toHaveValue("sem");
    await expect(page.locator("#pesquisa-completa-status")).toHaveText("Exibindo 50 de 70 resultados.");
    await page.locator("#filtro-pesquisa-categoria").selectOption("notebook");
    await expect.poll(() => pesquisasCompletas(ambiente).at(-1).busca.get("categoria")).toBe("notebook");
    await page.locator("#filtro-pesquisa-cidade").selectOption("Londrina");
    await expect.poll(() => pesquisasCompletas(ambiente).at(-1).busca.get("cidade")).toBe("Londrina");
    expect(pesquisasCompletas(ambiente).at(-1).busca.get("usuario")).toBe("sem");
    await page.locator("#btn-limpar-filtros-pesquisa").click();
    await expect.poll(() => pesquisasCompletas(ambiente).at(-1).busca.has("usuario") || pesquisasCompletas(ambiente).at(-1).busca.has("categoria")
      || pesquisasCompletas(ambiente).at(-1).busca.has("cidade")).toBe(false);
    await expect(page.locator("#btn-limpar-filtros-pesquisa")).toHaveClass(/hidden/);
    await expect(page.locator("#filtro-pesquisa-usuario")).toHaveValue("");
    await expect(page.locator("#filtro-pesquisa-categoria")).toHaveValue("");
    await expect(page.locator("#filtro-pesquisa-cidade")).toHaveValue("");
  });

  test("pesquisa completa: Carregar mais pede offset=50, soma as linhas e some quando acaba", async ({ page }) => {
    const ambiente = await abrirPesquisa(page);
    await page.locator("#btn-carregar-mais-pesquisa").click();
    await expect.poll(() => pesquisasCompletas(ambiente).at(-1).busca.get("offset")).toBe("50");
    expect(pesquisasCompletas(ambiente).at(-1).busca.get("limit")).toBe("50");
    await expect(page.locator("#pesquisa-completa-lista > button")).toHaveCount(70);
    await expect(page.locator("#pesquisa-completa-lista > button").last()).toHaveAttribute("data-result-index", "69");
    await expect(page.locator("#pesquisa-completa-status")).toHaveText("Todos os 70 resultados foram exibidos.");
    await expect(page.locator("#btn-carregar-mais-pesquisa")).toBeHidden();
    await expect(page.locator("#pesquisa-completa-contagem")).toHaveText("70 resultados");
  });

  test("pesquisa completa: clicar numa linha fecha o diálogo e seleciona o equipamento", async ({ page }) => {
    const ambiente = await abrirPesquisa(page);
    await page.locator("#pesquisa-completa-lista > button").nth(2).click();
    await expect(page.locator("#modal-pesquisa-completa")).toBeHidden();
    await expect(page.locator("#card-serial")).toHaveText("BRJ0003");
    await expect(page.locator("#input-serial")).toHaveValue("BRJ0003");
    expect(ambiente.chamadas.filter(chamada => chamada.caminho === "/api/equipamento/BRJ0003").map(chamada => chamada.metodo)).toEqual(["GET"]);
  });

  test("edição do cadastro: IDs, ARIA, campos e foco do diálogo antigo, sem IDs repetidos; Esc fecha", async ({ page }) => {
    await abrirEdicao(page);
    const modal = page.locator("#modal-editar-equipamento.modal-overlay.ck-veu");
    await expect(modal).toHaveAttribute("data-accessible-modal", "true");
    await expect(modal).toHaveAttribute("data-close-function", "fecharModalEditarEquipamento");
    const dialogo = modal.locator(":scope > .ck-dialogo.modal-panel");
    await expect(dialogo).toHaveAttribute("role", "dialog");
    await expect(dialogo).toHaveAttribute("aria-modal", "true");
    await expect(dialogo).toHaveAttribute("aria-labelledby", "modal-editar-equipamento-titulo");
    await expect(dialogo.locator("h3#modal-editar-equipamento-titulo #modal-edit-titulo")).toHaveText("Atualizar Cadastro do Equipamento");
    await expect(modal.locator("#modal-edit-serial-badge")).toHaveText("LENTO");
    await expect(modal.locator("#edit-serial")).toHaveValue("LENTO");
    await expect(modal.locator("#edit-serial")).toHaveJSProperty("readOnly", true);
    await expect(modal.locator("#edit-modelo")).toHaveValue("Notebook de teste");
    await expect(modal.locator("#edit-modelo")).toHaveAttribute("placeholder", "Ex: HP EB 6 G1I");
    await expect(modal.locator("#edit-modelo")).toBeFocused();
    expect(await modal.locator("#edit-tipo option").evaluateAll(lista => lista.map(o => [o.value, o.textContent]))).toEqual([
      ["Notebook", "Notebook"], ["Micro Computador", "Micro Computador"], ["Headsets", "Headsets"],
      ["Monitor", "Monitor"], ["Impressora", "Impressora"], ["Outro", "Outro"],
    ]);
    await expect(modal.locator("#edit-tipo")).toHaveValue("Notebook");
    await expect(modal.locator("#edit-apelido-field")).toHaveClass(/hidden/);
    await expect(modal.locator("#edit-apelido")).toBeHidden();
    await expect(modal.locator("#edit-apelido")).toHaveValue("TESTE-001");
    await expect(modal.locator("#edit-apelido")).toHaveAttribute("placeholder", "Ex: PRNOTEDIREX007");
    await expect(modal.locator("#edit-id-cliente")).toHaveValue("Obs de teste");
    await expect(modal.locator("#edit-id-cliente")).toHaveAttribute("placeholder", "Ex: Note diretoria Tipo 2");
    await expect(modal.locator("#btn-salvar-equipamento")).toHaveText("Salvar no Site e na Planilha");
    await expect(modal.locator("#btn-salvar-equipamento")).toHaveAttribute("data-on-click", "salvarDadosEquipamento");
    await expect(modal.locator("#btn-salvar-equipamento")).toHaveAttribute("type", "button");
    await expect(modal.getByRole("button", { name: "Cancelar" })).toHaveAttribute("data-on-click", "fecharModalEditarEquipamento");
    await expect(modal.getByRole("button", { name: "Fechar edição do equipamento" })).toHaveAttribute("data-on-click", "fecharModalEditarEquipamento");
    await expect(modal.locator("#tip-editar-equipamento")).toHaveAttribute("role", "tooltip");
    for (const [id, rotulo] of [
      ["edit-serial", "Número de Série:"], ["edit-tipo", "Tipo de Equipamento:"], ["edit-modelo", "Modelo do Hardware:"],
      ["edit-apelido", "Apelido / Hostname:"], ["edit-id-cliente", "Id Cliente / Observação de Uso:"],
    ]) await expect(modal.locator(`label[for="${id}"]`)).toHaveText(rotulo);
    await expect(modal.getByLabel("Número de Série:")).toHaveAttribute("id", "edit-serial");
    await expect(modal.getByLabel("Tipo de Equipamento:")).toHaveAttribute("id", "edit-tipo");
    await expect(modal.getByLabel("Modelo do Hardware:")).toHaveAttribute("id", "edit-modelo");
    await expect(modal.getByLabel("Id Cliente / Observação de Uso:")).toHaveAttribute("id", "edit-id-cliente");
    for (const [id, rotulo, trecho] of [
      ["tip-editar-equipamento", "Sobre Atualizar Dados do Equipamento", "gravadas diretamente na planilha oficial Excel"],
      ["tip-editar-apelido-campo", "Sobre Apelido / Hostname", "altere o apelido pelo botão próprio no cartão"],
    ]) {
      await expect(modal.locator(`#${id}`)).toHaveAttribute("role", "tooltip");
      await expect(modal.locator(`#${id}`)).toContainText(trecho);
      await expect(modal.locator(`button.info-tip-trigger[aria-describedby="${id}"]`)).toHaveAttribute("aria-label", rotulo);
    }
    expect(await idsRepetidos(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });

  test("cadastro novo: título, selo, série editável em maiúsculas e campo de apelido visível; Esc fecha", async ({ page }) => {
    await abrirCadastro(page, { serial: "novo123" });
    const modal = page.locator("#modal-editar-equipamento");
    await expect(modal.locator("#modal-edit-titulo")).toHaveText("Cadastrar Novo Equipamento");
    await expect(modal.locator("#modal-edit-serial-badge")).toHaveText("NOVO123");
    await expect(modal.locator("#edit-serial")).toHaveValue("NOVO123");
    await expect(modal.locator("#edit-serial")).toHaveJSProperty("readOnly", false);
    await expect(modal.locator("#edit-modelo")).toHaveValue("");
    await expect(modal.locator("#edit-modelo")).toBeFocused();
    await expect(modal.locator("#edit-tipo")).toHaveValue("Notebook");
    await expect(modal.locator("#edit-apelido-field")).not.toHaveClass(/hidden/);
    await expect(modal.locator("#edit-apelido")).toBeVisible();
    await expect(modal.locator("#edit-apelido")).toHaveValue("");
    await expect(modal.locator("#edit-id-cliente")).toHaveValue("");
    await expect(page.locator("#autocomplete-box")).toBeHidden();
    expect(await idsRepetidos(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });

  test("cadastro sem termo: selo NOVO e série vazia; salvar avisa que a série é obrigatória e não envia nada", async ({ page }) => {
    const ambiente = await preparar(page);
    await page.evaluate(() => window.cadastrarNovoSerialPesquisado());
    await expect(page.locator("#modal-editar-equipamento")).toBeVisible();
    await expect(page.locator("#modal-edit-serial-badge")).toHaveText("NOVO");
    await expect(page.locator("#edit-serial")).toHaveValue("");
    await page.locator("#btn-salvar-equipamento").click();
    await esperarToast(page, "O número de série é obrigatório.");
    await expect(page.locator("#edit-serial")).toBeFocused();
    await expect(page.locator("#modal-editar-equipamento")).toBeVisible();
    expect(escritas(ambiente)).toEqual([]);
  });

  test("editar apelido: IDs, ARIA, texto selecionado e foco do diálogo antigo, sem IDs repetidos; Esc fecha", async ({ page }) => {
    await abrirApelido(page);
    const modal = page.locator("#modal-editar-apelido.modal-overlay.ck-veu");
    await expect(modal).toHaveAttribute("data-accessible-modal", "true");
    await expect(modal).toHaveAttribute("data-close-function", "fecharModalEditarApelido");
    const dialogo = modal.locator(":scope > .ck-dialogo.modal-panel");
    await expect(dialogo).toHaveAttribute("role", "dialog");
    await expect(dialogo).toHaveAttribute("aria-modal", "true");
    await expect(dialogo).toHaveAttribute("aria-labelledby", "modal-editar-apelido-titulo");
    await expect(dialogo.locator("h3#modal-editar-apelido-titulo")).toContainText("Editar apelido");
    await expect(modal.locator('label[for="edit-apelido-isolado"]')).toHaveText("Novo apelido / hostname");
    await expect(modal.locator("#edit-apelido-isolado")).toHaveValue("TESTE-001");
    await expect(modal.locator("#edit-apelido-isolado")).toHaveAttribute("autocomplete", "off");
    await expect(modal.locator("#edit-apelido-isolado")).toBeFocused();
    expect(await modal.locator("#edit-apelido-isolado").evaluate(campo => [campo.selectionStart, campo.selectionEnd])).toEqual([0, "TESTE-001".length]);
    await expect(modal.locator("#apelido-serial-contexto")).toHaveText("Série: LENTO");
    await expect(modal.locator("#btn-salvar-apelido")).toHaveText("Salvar apelido");
    await expect(modal.locator("#btn-salvar-apelido")).toHaveAttribute("data-on-click", "salvarApelido");
    await expect(modal.getByRole("button", { name: "Cancelar" })).toHaveAttribute("data-on-click", "fecharModalEditarApelido");
    await expect(modal.getByRole("button", { name: "Fechar", exact: true })).toHaveAttribute("data-on-click", "fecharModalEditarApelido");
    await expect(modal.locator("#tip-editar-apelido")).toHaveAttribute("role", "tooltip");
    await expect(modal.locator("#tip-editar-apelido")).toContainText("O apelido manual prevalece nas próximas exportações do Excel.");
    await expect(modal.locator('button.info-tip-trigger[aria-describedby="tip-editar-apelido"]')).toHaveAttribute("aria-label", "Sobre Editar apelido");
    expect(await idsRepetidos(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });

  test("sem equipamento selecionado: editar e editar apelido só avisam, sem abrir o diálogo", async ({ page }) => {
    await preparar(page);
    await page.evaluate(() => window.abrirModalEditarEquipamento());
    await esperarToast(page, "Pesquise um equipamento antes de editar.");
    await page.evaluate(() => window.abrirModalEditarApelido());
    await esperarToast(page, "Pesquise um equipamento antes de editar o apelido.");
    await expect(page.locator("#modal-editar-equipamento")).toBeHidden();
    await expect(page.locator("#modal-editar-apelido")).toBeHidden();
  });

  test("salvar apelido: o apelido novo aparece no cartão, o diálogo fecha e o botão volta ao normal", async ({ page }) => {
    const ambiente = await abrirApelido(page);
    await page.locator("#edit-apelido-isolado").fill("  LENTO-NOVO  ");
    await page.locator("#btn-salvar-apelido").click();
    await expect(page.locator("#badge-apelido")).toHaveText("LENTO-NOVO");
    await expect(page.locator("#modal-editar-apelido")).toBeHidden();
    await esperarToast(page, "Apelido salvo para pesquisas e exportações do Excel.");
    await expect(page.locator("#btn-salvar-apelido")).toHaveText("Salvar apelido");
    await expect(page.locator("#btn-salvar-apelido")).toBeEnabled();
    await expect(page.locator("#btn-salvar-apelido")).not.toHaveAttribute("aria-busy", /.*/);
    expect(escritas(ambiente).map(chamada => [chamada.metodo, chamada.caminho, chamada.corpo])).toEqual([
      ["POST", "/api/equipamento/atualizar-apelido", JSON.stringify({ serial: "LENTO", apelido: "LENTO-NOVO" })],
    ]);
  });

  test("invariante: apelido salvo com resposta atrasada, depois de trocar a seleção, não toma a seleção nova", async ({ page }) => {
    const ambiente = await abrirApelido(page);
    let liberar;
    ambiente.portao.apelido = new Promise(resolver => { liberar = resolver; });
    await page.locator("#edit-apelido-isolado").fill("LENTO-NOVO");
    await page.locator("#btn-salvar-apelido").click();
    await expect(page.locator("#btn-salvar-apelido")).toHaveText("Salvando...");
    await expect(page.locator("#btn-salvar-apelido")).toBeDisabled();
    await expect(page.locator("#btn-salvar-apelido")).toHaveAttribute("aria-busy", "true");
    await trocarSelecao(page, "OUTRO");
    await expect(page.locator("#badge-apelido")).toHaveText("OUTRO-APELIDO");
    liberar();
    await esperarToast(page, "Apelido salvo para pesquisas e exportações do Excel.");
    await expect(page.locator("#btn-salvar-apelido")).toHaveText("Salvar apelido");
    await expect(page.locator("#btn-salvar-apelido")).toBeEnabled();
    await expect(page.locator("#card-serial")).toHaveText("OUTRO");
    await expect(page.locator("#badge-apelido")).toHaveText("OUTRO-APELIDO");
    await expect(page.locator("#input-serial")).toHaveValue("OUTRO");
    // A resposta atrasada foi aceita pelo servidor (a série antiga ficou com o apelido novo), sem tocar na seleção.
    expect(ambiente.equipamento("LENTO").apelido).toBe("LENTO-NOVO");
    // Comportamento antigo: com a seleção trocada o diálogo não fecha sozinho.
    await expect(page.locator("#modal-editar-apelido")).toBeVisible();
  });

  test("invariante: cadastro completo salvo com resposta atrasada, depois de trocar a seleção, não toma a seleção nova", async ({ page }) => {
    const ambiente = await abrirEdicao(page);
    let liberar;
    ambiente.portao.salvar = new Promise(resolver => { liberar = resolver; });
    await page.locator("#edit-modelo").fill("Modelo salvo atrasado");
    await page.locator("#btn-salvar-equipamento").click();
    await expect(page.locator("#btn-salvar-equipamento")).toBeDisabled();
    await expect(page.locator("#btn-salvar-equipamento")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#btn-salvar-equipamento")).toContainText("Salvando no Excel...");
    await trocarSelecao(page, "OUTRO");
    liberar();
    await esperarToast(page, "Equipamento LENTO salvo com sucesso!");
    await expect(page.locator("#btn-salvar-equipamento")).toBeEnabled();
    await expect(page.locator("#btn-salvar-equipamento")).toContainText("Salvar no Site e na Planilha");
    await expect(page.locator("#btn-salvar-equipamento")).not.toHaveAttribute("aria-busy", /.*/);
    await expect(page.locator("#card-serial")).toHaveText("OUTRO");
    await expect(page.locator("#badge-apelido")).toHaveText("OUTRO-APELIDO");
    await expect(page.locator("#input-serial")).toHaveValue("OUTRO");
    expect(ambiente.equipamento("LENTO").modelo).toBe("Modelo salvo atrasado");
    // Comportamento antigo: com a seleção trocada o diálogo não fecha sozinho.
    await expect(page.locator("#modal-editar-equipamento")).toBeVisible();
  });

  test("invariante: os diálogos só escrevem em /api/equipamento/atualizar-apelido e /api/equipamento/salvar, e só leem /api/equipamento/<série> e /api/buscar-expandida", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "LENTO");
    const inicio = ambiente.chamadas.length;
    // Pesquisa completa: abre, filtra, carrega mais, escolhe uma linha.
    await page.locator("#input-serial").fill("BRJ");
    await expect(page.locator("#autocomplete-box")).toBeVisible();
    await page.evaluate(() => window.abrirPesquisaCompleta());
    await expect(page.locator("#pesquisa-completa-lista > button")).toHaveCount(50);
    await page.locator("#filtro-pesquisa-usuario").selectOption("com");
    await expect.poll(() => pesquisasCompletas(ambiente).at(-1).busca.get("usuario")).toBe("com");
    await expect(page.locator("#btn-carregar-mais-pesquisa")).toBeEnabled();
    await page.locator("#btn-carregar-mais-pesquisa").click();
    await expect(page.locator("#pesquisa-completa-lista > button")).toHaveCount(70);
    await page.locator("#pesquisa-completa-lista > button").first().click();
    await expect(page.locator("#card-serial")).toHaveText("BRJ0001");
    // Apelido, cadastro completo e cadastro novo.
    await page.evaluate(() => window.abrirModalEditarApelido());
    await page.locator("#edit-apelido-isolado").fill("BRJ-APELIDO");
    await page.locator("#btn-salvar-apelido").click();
    await expect(page.locator("#modal-editar-apelido")).toBeHidden();
    await page.evaluate(() => window.abrirModalEditarEquipamento());
    await page.locator("#edit-modelo").fill("Modelo editado");
    await page.locator("#btn-salvar-equipamento").click();
    await expect(page.locator("#modal-editar-equipamento")).toBeHidden();
    await page.locator("#input-serial").fill("NOVO123");
    await page.evaluate(() => window.cadastrarNovoSerialPesquisado());
    await page.locator("#btn-salvar-equipamento").click();
    await expect(page.locator("#modal-editar-equipamento")).toBeHidden();
    await expect(page.locator("#card-serial")).toHaveText("NOVO123");
    const feitas = ambiente.chamadas.slice(inicio);
    expect(feitas.filter(chamada => chamada.metodo !== "GET").map(chamada => `${chamada.metodo} ${chamada.caminho}`)).toEqual([
      "POST /api/equipamento/atualizar-apelido", "POST /api/equipamento/salvar", "POST /api/equipamento/salvar",
    ]);
    // Leituras medidas no código antigo: as do diálogo (/api/buscar-expandida e /api/equipamento/<série>) e as duas que
    // a própria página refaz depois de salvar (/api/stats e /api/sebrae/novos). Nenhuma outra rota de leitura entra.
    const leituras = [...new Set(feitas.filter(chamada => chamada.metodo === "GET").map(chamada => chamada.caminho))].sort();
    expect(leituras).toEqual(["/api/buscar-expandida", "/api/equipamento/BRJ0001", "/api/sebrae/novos", "/api/stats"]);
  });

  test("invariante: o payload do salvar da edição é {serial, novo, modelo, tipo, apelido, idCliente}, com o apelido atual do equipamento", async ({ page }) => {
    const ambiente = await abrirEdicao(page);
    // O campo de apelido fica escondido na edição: o que estiver nele não vai no payload.
    await page.evaluate(() => { document.getElementById("edit-apelido").value = "IGNORADO"; });
    await page.locator("#edit-modelo").fill("  Modelo ajustado  ");
    await page.locator("#edit-tipo").selectOption("Monitor");
    await page.locator("#edit-id-cliente").fill("  Obs ajustada  ");
    await page.locator("#btn-salvar-equipamento").click();
    await expect(page.locator("#modal-editar-equipamento")).toBeHidden();
    await esperarToast(page, "Equipamento LENTO salvo com sucesso!");
    expect(escritas(ambiente).map(chamada => [chamada.metodo, chamada.caminho, chamada.corpo])).toEqual([
      ["POST", "/api/equipamento/salvar", JSON.stringify({ serial: "LENTO", novo: false, modelo: "Modelo ajustado", tipo: "Monitor", apelido: "TESTE-001", idCliente: "Obs ajustada" })],
    ]);
    await expect(page.locator("#card-serial")).toHaveText("LENTO");
    await expect(page.locator("#input-serial")).toHaveValue("LENTO");
  });

  test("invariante: o payload do salvar do cadastro novo é {serial, novo: true, ...} com o apelido digitado", async ({ page }) => {
    const ambiente = await abrirCadastro(page);
    await page.locator("#edit-modelo").fill("Modelo novo");
    await page.locator("#edit-tipo").selectOption("Headsets");
    await page.locator("#edit-apelido").fill("  APELIDO-NOVO  ");
    await page.locator("#edit-id-cliente").fill("Obs nova");
    await page.locator("#btn-salvar-equipamento").click();
    await expect(page.locator("#modal-editar-equipamento")).toBeHidden();
    await esperarToast(page, "Equipamento NOVO123 salvo com sucesso!");
    expect(escritas(ambiente).map(chamada => [chamada.metodo, chamada.caminho, chamada.corpo])).toEqual([
      ["POST", "/api/equipamento/salvar", JSON.stringify({ serial: "NOVO123", novo: true, modelo: "Modelo novo", tipo: "Headsets", apelido: "APELIDO-NOVO", idCliente: "Obs nova" })],
    ]);
    await expect(page.locator("#card-serial")).toHaveText("NOVO123");
    await expect(page.locator("#badge-apelido")).toHaveText("APELIDO-NOVO");
    await expect(page.locator("#input-serial")).toHaveValue("NOVO123");
  });

  test("invariante: cadastro novo com a série do equipamento já selecionado manda o apelido atual, não o do campo", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "LENTO");
    await page.evaluate(() => window.cadastrarNovoSerialPesquisado());
    await expect(page.locator("#modal-editar-equipamento")).toBeVisible();
    await expect(page.locator("#edit-serial")).toHaveJSProperty("readOnly", false);
    await page.locator("#edit-apelido").fill("IGNORADO");
    await page.locator("#edit-modelo").fill("Modelo repetido");
    await page.locator("#btn-salvar-equipamento").click();
    await expect(page.locator("#modal-editar-equipamento")).toBeHidden();
    expect(escritas(ambiente).map(chamada => chamada.corpo)).toEqual([
      JSON.stringify({ serial: "LENTO", novo: true, modelo: "Modelo repetido", tipo: "Notebook", apelido: "TESTE-001", idCliente: "" }),
    ]);
  });
});
