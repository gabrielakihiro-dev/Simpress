// Bloco final 2 (BF2): regras de chamado, importação de planilhas e Chamados novos do SoftExpert (F5)
// (frontend/src/aplicacao/{ticket-rules,pontes}.ts, agora pontes finas para os painéis React
// regras-chamados, importacao-planilhas e sebrae-dashboard). Só dados sintéticos: nenhum teste chega ao backend real.
// Todo POST/PUT/DELETE passa por uma rota de guarda que recusa o que o teste não simulou de propósito; a lista do que
// ela recusou tem de ficar vazia.
//
// Cobertura: contêineres e registro window.SimpressReact; nenhum console.error de "não carregou"; paridade das regras
// entre a página, o painel React e o código-fonte (regras.ts); F5 com lista, vazio e erro simulados, teclado das
// sub-abas e do filtro, e os nós #sebrae-historico-resumo e #sebrae-conflitos (de outros painéis) intactos depois de
// recarregar a lista; modais de importação pelo teclado (Esc fecha, o foco volta) e erro de prévia e de modelo.
const { test, expect } = require("@playwright/test");
const { criarRegrasChamados } = require("../../frontend/src/paineis/regras-chamados/regras.ts");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const arquivo = nome => ({ name: nome, mimeType: XLSX, buffer: Buffer.from("planilha sintética") });
const FALHA_DE_PONTE = /não carregou/;

const PAINEIS = {
  "regras-chamados": [
    "formatarListaChamados", "compararOrdensServicoDecrescente", "obterOrdemServicoPrincipalChamado",
    "compararChamadosPorOrdemServicoDecrescente", "formatarOrdensServico", "etapasProcessoPedido", "formatarDataEtapa",
    "renderizarResumoProcessoPedido", "renderizarLinhaProcessoPedido", "resumirDescricaoChamado", "normalizarFiltroChamados",
    "chamadosClienteInformados", "valoresChamado", "dataAtualizacaoChamado", "classificarAtencaoChamado", "cidadesDoChamado",
    "atendimentosDoChamado", "idadeAtualizacaoChamado", "grupoTriagemChamado", "correspondeTriagemChamado",
  ],
  "importacao-planilhas": [
    "abrirImportacaoModelo", "fecharImportacaoModelo", "limparPreviaUploadPlanilhas", "abrirModalAtualizarPlanilhas",
    "fecharModalAtualizarPlanilhas", "inicializarExportacaoAutomaticaHistorico", "inicializarArquivosAtualizacaoPlanilhas",
    "enviarModeloLocal", "previsualizarPlanilhas", "enviarPlanilhas", "exportarEquipamentosAtualizados",
  ],
  "sebrae-dashboard": [
    "mostrarChamadoSebrae", "carregarNovosSebrae", "lerAntigosSebrae", "importarDashboardSebrae", "atualizarDashboardSebrae",
    "descartarRascunhoSebrae", "cartaoChamadoSebraeLeitura",
  ],
};

// `erros` junta console.error e erros de página; `bloqueados` junta toda escrita que nenhuma rota do teste simulou; `pedidos` guarda o que o teste espera.
async function preparar(page) {
  const ambiente = { erros: [], bloqueados: [], pedidos: [] };
  await page.emulateMedia({ reducedMotion: "reduce" });
  page.on("console", mensagem => { if (mensagem.type() === "error") ambiente.erros.push(mensagem.text()); });
  page.on("pageerror", erro => { ambiente.erros.push(String(erro)); });
  // Registrada primeiro, roda por último (o Playwright consulta as rotas da mais nova para a mais antiga): só pega o que
  // nenhuma rota do teste tratou.
  await page.route("**/api/**", route => {
    const metodo = route.request().method();
    if (metodo === "GET" || metodo === "HEAD") return route.fallback();
    ambiente.bloqueados.push(`${metodo} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 500, json: { detail: "Bloqueado pelo teste: nenhuma escrita real." } });
  });
  return ambiente;
}

const semFalhaDePonte = ambiente => ambiente.erros.filter(texto => FALHA_DE_PONTE.test(texto));

async function esperarReact(page) {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-react-pronto", "");
}

// ---------------------------------------------------------------------------------------------------------------------
// Contêineres, registro e pontes
// ---------------------------------------------------------------------------------------------------------------------

test("os três painéis têm contêiner, registro no window.SimpressReact e ações publicadas na página", async ({ page }) => {
  const ambiente = await preparar(page);
  await esperarReact(page);
  for (const painel of Object.keys(PAINEIS)) await expect(page.locator(`[data-react-painel="${painel}"]`)).toHaveCount(1);
  const registro = await page.evaluate(paineis => Object.fromEntries(Object.entries(paineis).map(([painel, nomes]) => [painel, {
    existe: Boolean(window.SimpressReact?.[painel]),
    faltamNoRegistro: nomes.filter(nome => typeof window.SimpressReact?.[painel]?.[nome] !== "function"),
    faltamNaPagina: nomes.filter(nome => typeof window[nome] !== "function"),
  }])), PAINEIS);
  for (const painel of Object.keys(PAINEIS)) expect(registro[painel], painel).toEqual({ existe: true, faltamNoRegistro: [], faltamNaPagina: [] });
  expect(await page.evaluate(() => Object.keys(window.SimpressReact))).toEqual(expect.arrayContaining(Object.keys(PAINEIS)));
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Regras de chamado: a página (ponte), o painel React e o código-fonte têm de dar o mesmo resultado
// ---------------------------------------------------------------------------------------------------------------------

// Roda na página (pela ponte e pelo registro) e no Node (pelo regras.ts): por isso só usa o argumento e `window` no
// valor padrão de `regras`, que o Node nunca avalia. Datas ficam de fora (dependem do relógio): só os casos fixos.
const calcularRegras = ({ origem, casos, regras = origem === "react" ? window.SimpressReact["regras-chamados"] : window }) => ({
  normalizar: casos.textos.map(texto => regras.normalizarFiltroChamados(texto)),
  resumir: casos.descricoes.map(texto => [regras.resumirDescricaoChamado(texto), regras.resumirDescricaoChamado(texto, 12)]),
  ordens: [...casos.ordens].sort(regras.compararOrdensServicoDecrescente),
  informados: regras.chamadosClienteInformados(casos.informados),
  valores: regras.valoresChamado(casos.aninhado),
  principal: casos.registros.map(registro => regras.obterOrdemServicoPrincipalChamado(registro)),
  triagem: casos.registros.map(registro => regras.grupoTriagemChamado(registro)),
  idade: casos.tickets.map(ticket => regras.idadeAtualizacaoChamado(ticket)),
  cidades: casos.registros.map(registro => regras.cidadesDoChamado(registro)),
  atendimentos: casos.registros.map(registro => regras.atendimentosDoChamado(registro)),
  lista: regras.formatarListaChamados([]),
});

const CASOS_REGRAS = {
  textos: ["", null, "  Ação Útil  ", "ÁGUA e Ç", "NÃO INFORMADO", "=SOMA(A1)"],
  descricoes: ["  texto   com\n quebras  ", "x".repeat(200)],
  ordens: ["10", "9", "OS-2", "abc", "", "0100", "2026-0005"],
  informados: ["CH-1", "Não informado", "", null, "nao informado", "CH-2"],
  aninhado: { a: [1, "dois", null], b: { c: "três" } },
  tickets: [{ status: "Concluído" }, { status: "Em atendimento" }, { status: "Aberto", sub_status: "Cancelado pelo solicitante" }],
  registros: [
    { serie: "BRJ0001", oracle: [{ ordem_servico: "55", status: "Concluído", cidade: "Curitiba", nome_filial: "Parceiro Teste" }], simpress: { ordens_servico: ["60", "Não informado"], cidades_entrega: ["Curitiba"] }, ordens_servico_conferidas: ["7"] },
    { serie: "BRJ0002", oracle: [{ ordem_servico: "81", status: "Aberto", ultima_atualizacao: "", cidade: "Londrina", nome_filial: "Simpress Teste" }] },
    { serie: "BRJ0003", oracle: [] },
  ],
};

test("regras de chamado: ponte da página, painel React e regras.ts dão o mesmo resultado", async ({ page }) => {
  const ambiente = await preparar(page);
  await esperarReact(page);
  const fonte = calcularRegras({ origem: "fonte", casos: CASOS_REGRAS, regras: criarRegrasChamados({
    escapeHtml: valor => String(valor), pluralize: (quantidade, singular, plural = `${singular}s`) => (quantidade === 1 ? singular : plural),
  }) });
  const daPagina = await page.evaluate(calcularRegras, { origem: "pagina", casos: CASOS_REGRAS });
  const doReact = await page.evaluate(calcularRegras, { origem: "react", casos: CASOS_REGRAS });
  expect(daPagina).toEqual(fonte);
  expect(doReact).toEqual(fonte);
  // Valores escritos à mão: a paridade sozinha passaria com os dois lados errados.
  expect(fonte.normalizar).toEqual(["", "", "acao util", "agua e c", "nao informado", "=soma(a1)"]);
  expect(fonte.informados).toEqual(["CH-1", "CH-2"]);
  expect(fonte.resumir[0][0]).toBe("texto com quebras");
  expect(fonte.resumir[1][1]).toBe(`${"x".repeat(12)}…`);
  expect(fonte.principal).toEqual(["60", "81", ""]);
  expect(fonte.triagem).toEqual(["", "sem_data", ""]);
  expect(fonte.idade.map(item => item.rotulo)).toEqual(["Chamado encerrado", "Sem data de atualização", "Chamado encerrado"]);
  expect(fonte.lista).toBe("Não informado");
  expect(semFalhaDePonte(ambiente)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Chamados novos do SoftExpert (F5)
// ---------------------------------------------------------------------------------------------------------------------

const SEBRAE_VAZIO = {
  importado: { arquivo: "Dashboard de teste.xlsx", importado_em: "2026-10-28T10:00:00-03:00", total: 5, atualizavel: true, listas: {}, abertos: [], finalizados: [] },
  novos: { lidos_em: "2026-10-28T10:05:00-03:00", ignorados: 5, pendentes: [], erros: {}, formulario: [] },
};

async function abrirCartao(page, request) {
  await request.get("/__fixture_automacao?quantidade=0&sebrae=padrao&run=&antigos=");
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const cartao = page.locator("#sebrae-novos-painel");
  await expect(cartao).toBeVisible();
  return cartao;
}

async function abrirPainel(page, request) {
  const cartao = await abrirCartao(page, request);
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("novo(s)");
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  return { cartao, painel };
}

test("F5: lista normal com os chamados novos e as contagens nas abas", async ({ page, request }) => {
  const ambiente = await preparar(page);
  const { cartao, painel } = await abrirPainel(page, request);
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("2 novo(s), 36 já no Dashboard, 1 pendente(s)");
  await expect(painel.locator("#sebrae-novos-lista > .sebrae-novo")).toHaveCount(2);
  await expect(painel.locator("#sebrae-novos-lista > .sebrae-novo").first()).toContainText("UTIC-2026-1378");
  await expect(painel.locator("#sebrae-aba-novos")).toHaveAttribute("aria-label", "Novos: 2 chamados");
  await expect(painel.locator("#sebrae-aba-finalizados")).toHaveAttribute("aria-label", "Finalizados: 1 chamado");
  await expect(painel.locator("#sebrae-novos-lista")).not.toHaveAttribute("aria-busy", "true");
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

test("F5: sem chamados novos mostra zero nas abas e a lista vazia", async ({ page, request }) => {
  const ambiente = await preparar(page);
  await page.route("**/api/sebrae/novos", route => route.fulfill({ json: SEBRAE_VAZIO }));
  const { cartao, painel } = await abrirPainel(page, request);
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("0 novo(s), 5 já no Dashboard, 0 pendente(s)");
  await expect(painel.locator("#sebrae-novos-lista > .sebrae-novo")).toHaveCount(0);
  for (const aba of ["novos", "antigos", "destaques", "finalizados"]) {
    await expect(painel.locator(`#sebrae-aba-${aba}`)).toHaveAttribute("aria-label", /: 0 chamados$/);
    await expect(painel.locator(`#sebrae-aba-${aba}`)).toHaveAttribute("data-zero", "");
  }
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

test("F5: erro ao consultar os chamados novos mostra o aviso e não deixa a lista ocupada", async ({ page, request }) => {
  const ambiente = await preparar(page);
  await page.route("**/api/sebrae/novos", route => route.fulfill({ status: 500, json: {} }));
  const cartao = await abrirCartao(page, request);
  await expect(cartao.locator("#sebrae-dashboard-status")).toHaveText("Não foi possível consultar os chamados novos.");
  await expect(page.locator("#sebrae-novos-lista > .sebrae-novo")).toHaveCount(0);
  await expect(page.locator("#sebrae-novos-lista")).not.toHaveAttribute("aria-busy", "true");
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

test("F5: teclado nas sub-abas (setas, Home, End) e no filtro (Enter abre, Esc limpa e fecha)", async ({ page, request }) => {
  const ambiente = await preparar(page);
  const { painel } = await abrirPainel(page, request);
  const aba = nome => painel.locator(`#sebrae-aba-${nome}`);
  await aba("novos").focus();
  await page.keyboard.press("ArrowRight");
  await expect(aba("antigos")).toHaveAttribute("aria-selected", "true");
  await expect(aba("antigos")).toBeFocused();
  await expect(painel.locator("#sebrae-antigos")).toBeVisible();
  await expect(painel.locator("#sebrae-novos")).toBeHidden();
  await page.keyboard.press("End");
  await expect(aba("finalizados")).toBeFocused();
  await expect(painel.locator("#sebrae-finalizados")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(aba("novos")).toBeFocused();
  await page.keyboard.press("ArrowLeft"); // volta ao fim da lista
  await expect(aba("finalizados")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(aba("novos")).toHaveAttribute("aria-selected", "true");
  await expect(painel.locator("#sebrae-novos")).toBeVisible();

  const lupa = painel.locator("#btn-sebrae-filtro");
  const termo = painel.locator("#sebrae-filtro-termo");
  await lupa.focus();
  await page.keyboard.press("Enter");
  await expect(lupa).toHaveAttribute("aria-expanded", "true");
  await expect(painel.locator("#sebrae-filtro")).toBeVisible();
  await expect(termo).toBeFocused();
  await page.keyboard.type("1378");
  await expect(painel.locator("#sebrae-filtro-resultado")).toHaveText("1 chamado(s) encontrado(s)");
  await expect(painel.locator("#sebrae-novos-mestre [data-sebrae-mestre]")).toHaveCount(1); // Novo layout: só o chamado aberto aparece no detalhe; a lista compacta tem todas as linhas visíveis
  await termo.fill("zzzz"); // sem resultado: o aviso da aba some com a lista
  await expect(painel.locator("#sebrae-novos [data-sebrae-vazio-filtro] .sebrae-vazio__1")).toHaveText("Nenhum chamado encontrado para “zzzz”.");
  await page.keyboard.press("Escape"); // o primeiro Esc só limpa o termo
  await expect(termo).toHaveValue("");
  await expect(painel.locator("#sebrae-filtro")).toBeVisible();
  await expect(painel.locator("#sebrae-novos-mestre [data-sebrae-mestre]")).toHaveCount(2); // Novo layout: só o chamado aberto aparece no detalhe; a lista compacta tem todas as linhas visíveis
  await page.keyboard.press("Escape"); // o segundo fecha o filtro e devolve o foco à lupa
  await expect(painel.locator("#sebrae-filtro")).toBeHidden();
  await expect(lupa).toHaveAttribute("aria-expanded", "false");
  await expect(lupa).toBeFocused();
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

test("F5: recarregar a lista não troca #sebrae-historico-resumo nem #sebrae-conflitos (são de outros painéis)", async ({ page, request }) => {
  const ambiente = await preparar(page);
  await abrirPainel(page, request);
  const ids = ["sebrae-historico-resumo", "sebrae-conflitos"];
  await page.evaluate(lista => { window.__nosBf2 = lista.map(id => document.getElementById(id)); }, ids);
  await expect(page.locator("#sebrae-historico-resumo")).toHaveAttribute("data-react-painel", "sebrae-historico");
  await expect(page.locator("#sebrae-conflitos")).toHaveAttribute("data-react-painel", "sebrae-conflitos");
  await Promise.all([
    page.waitForResponse(resposta => new URL(resposta.url()).pathname === "/api/sebrae/novos"),
    page.evaluate(() => window.carregarNovosSebrae()),
  ]);
  const mesmos = await page.evaluate(lista => lista.map((id, i) => document.getElementById(id) === window.__nosBf2[i] && window.__nosBf2[i].isConnected), ids);
  expect(mesmos).toEqual([true, true]);
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Importação de planilhas: modais pelo teclado e erros simulados
// ---------------------------------------------------------------------------------------------------------------------

// O alerta de base desatualizada é o gatilho real: o diálogo guarda o elemento focado ao abrir e o devolve ao fechar.
async function comAlertaDeBase(page, request, usar) {
  await request.get("/__fixture_base_desatualizada?estado=desatualizada");
  try {
    await page.goto("/");
    await expect(page.locator("#alerta-base-desatualizada")).toBeVisible();
    await usar(page.locator("#btn-alerta-base-atualizar"));
  } finally {
    await request.get("/__fixture_base_desatualizada?estado=atualizada");
  }
}

test("importação: Atualizar planilhas abre e fecha pelo teclado e o foco volta ao gatilho", async ({ page, request }) => {
  const ambiente = await preparar(page);
  await comAlertaDeBase(page, request, async gatilho => {
    await gatilho.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#modal-atualizar-planilhas")).toBeVisible();
    await expect(page.locator("#upload-endpoint-file")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-atualizar-planilhas")).toBeHidden();
    await expect(gatilho).toBeFocused();
    // as ações do painel valem também chamadas pela ponte, como fazem os outros módulos
    await page.evaluate(() => window.abrirModalAtualizarPlanilhas());
    await expect(page.locator("#modal-atualizar-planilhas")).toBeVisible();
    await page.evaluate(() => window.fecharModalAtualizarPlanilhas());
    await expect(page.locator("#modal-atualizar-planilhas")).toBeHidden();
  });
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

test("importação: o modal do modelo abre e fecha pelo teclado e o erro do envio aparece sem importar nada", async ({ page, request }) => {
  const ambiente = await preparar(page);
  await page.route("**/api/modelos/exportacao/importar", route => {
    ambiente.pedidos.push(route.request().method());
    return route.fulfill({ status: 422, json: { detail: "Modelo incompatível com a base." } });
  });
  await comAlertaDeBase(page, request, async gatilho => {
    const modal = page.locator("#modal-importar-modelo");
    await gatilho.focus();
    await page.evaluate(() => window.abrirImportacaoModelo("exportacao"));
    await expect(modal).toBeVisible();
    await expect(modal.locator("#titulo-importar-modelo")).toHaveText("Arquivos para exportação");
    await expect(page.locator("#arquivo-modelo-local")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(gatilho).toBeFocused();

    await page.evaluate(() => window.abrirImportacaoModelo("exportacao"));
    await expect(modal).toBeVisible();
    await page.locator("#arquivo-modelo-local").setInputFiles(arquivo("modelo-teste.xlsx"));
    await expect(page.locator("#nome-arquivo-modelo-local")).toHaveText("modelo-teste.xlsx");
    await page.locator("#btn-importar-modelo").click();
    await expect(page.locator("#status-modelo-local")).toHaveText("Modelo incompatível com a base.");
    await expect(page.locator("#status-modelo-local")).toHaveAttribute("role", "alert");
    await expect(page.locator("#btn-importar-modelo")).toBeEnabled();
    expect(ambiente.pedidos).toEqual(["POST"]);
    await page.evaluate(() => window.fecharImportacaoModelo());
    await expect(modal).toBeHidden();
  });
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

test("importação: erro na prévia de Atualizar planilhas mostra o aviso e não chega à substituição", async ({ page }) => {
  const ambiente = await preparar(page);
  await page.route("**/api/planilhas/previsualizar", route => {
    ambiente.pedidos.push(route.request().method());
    return route.fulfill({ status: 422, json: { detail: "Planilha de teste inválida." } });
  });
  await esperarReact(page);
  await page.evaluate(() => window.abrirModalAtualizarPlanilhas());
  const modal = page.locator("#modal-atualizar-planilhas");
  await expect(modal).toBeVisible();
  const status = modal.locator("#upload-planilhas-status");
  await modal.locator("#btn-previsualizar-planilhas").click(); // sem arquivos: nem chega à rede
  await expect(status).toHaveText("Selecione Endpoint e EquipamentosDetalhes antes de gerar a prévia.");
  expect(ambiente.pedidos).toEqual([]);
  await modal.locator("#upload-endpoint-file").setInputFiles(arquivo("endpoint-teste.xlsx"));
  await modal.locator("#upload-details-file").setInputFiles(arquivo("detalhes-teste.xlsx"));
  await modal.locator("#btn-previsualizar-planilhas").click();
  await expect(status).toHaveText("Planilha de teste inválida.");
  await expect(status).toHaveAttribute("role", "alert");
  expect(ambiente.pedidos).toEqual(["POST"]);
  await expect(modal.locator("#btn-confirmar-planilhas")).toBeHidden();
  await expect(modal.locator("#btn-previsualizar-planilhas")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});
