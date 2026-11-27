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

// ---------------------------------------------------------------------------------------------------------------------
// Importação de planilhas: DOM dos dois modais desenhado pelo React (frontend/src/paineis/importacao-planilhas/dialogos.tsx).
// Estas checagens substituem as que test_inventory_upload_flows.cjs fazia no DOM falso (agora lê o estado do painel).
// ---------------------------------------------------------------------------------------------------------------------

const PREVIA = {
  preview_token: "token-ficticio",
  arquivos: { endpoint: { nome: "endpoint-teste.xlsx", linhas: 2 }, detalhes: { nome: "detalhes-teste.xlsx", linhas: 3 } },
  alteracoes: {
    endpoint: { series_novas: 1, series_removidas: 2, series_duplicadas_no_arquivo_novo: 0 },
    detalhes: { series_novas: 2, series_removidas: 1, series_duplicadas_no_arquivo_novo: 1 },
  },
};

// Rota que segura a resposta até liberar(): dá tempo de olhar o estado "ocupado" no DOM.
function rotaSegurada(ambiente, padrao, resposta) {
  let liberar;
  const segura = new Promise(resolver => { liberar = resolver; });
  const instalar = page => page.route(padrao, async route => {
    ambiente.pedidos.push(route.request().method());
    await segura;
    return route.fulfill(resposta);
  });
  return { instalar, liberar };
}

test("importação: o DOM inicial dos modais é o do partial e a seção Entra fica dentro do corpo Arquivos", async ({ page }) => {
  const ambiente = await preparar(page);
  await esperarReact(page);
  const modal = page.locator("#modal-atualizar-planilhas");
  // o dialog é o único filho do overlay (accessible-dialogs.ts usa firstElementChild) e a seção Entra foi adotada pelo corpo
  expect(await modal.evaluate(el => [...el.children].map(filho => filho.tagName + "." + filho.className))).toEqual(["SECTION.ckp-dialogo"]);
  expect(await page.locator("#modal-importar-modelo").evaluate(el => [...el.children].map(filho => filho.className))).toEqual(["ckp-dialogo ckp-dialogo--estreito"]);
  const corpo = modal.locator('[data-so-etapa="arquivos"]');
  await expect(corpo.locator('#esc-inv-entra [data-react-painel="entra-users"]')).toHaveCount(1);
  expect(await page.locator('[data-react-painel="entra-users"]').evaluate(el => el.children.length)).toBeGreaterThan(0);
  expect(await corpo.evaluate(el => [...el.children].map(filho => filho.id || filho.className))).toEqual(["esc-inv-arquivos", "ckp-nota", "esc-inv-entra"]);
  await expect(modal.locator('[data-so-etapa="impacto"]')).toHaveAttribute("hidden", "");
  await expect(corpo).not.toHaveAttribute("hidden", /.*/);
  const status = modal.locator("#upload-planilhas-status");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await expect(status).toHaveClass("ckp-rodape__status");
  await expect(modal.locator("#upload-planilhas-preview")).toHaveAttribute("aria-atomic", "true");
  await expect(modal.locator("#btn-voltar-planilhas")).toHaveClass(/hidden/);
  await expect(modal.locator("#btn-confirmar-planilhas")).toHaveClass(/hidden/);
  await expect(modal.locator("#btn-previsualizar-planilhas")).not.toHaveClass(/hidden/);
  // atalhos para os sistemas de origem (antes checados no HTML montado por test_inventory_history_and_tickets.cjs)
  const sistemas = modal.locator(".ckp-sistemas a.ckp-sistema");
  await expect(sistemas).toHaveCount(2);
  await expect(sistemas.nth(0)).toHaveAttribute("href", "/api/config/local/endpoint/computadores");
  await expect(sistemas.nth(0)).toHaveAttribute("aria-label", "Abrir inventário de computadores do Endpoint Central");
  await expect(sistemas.nth(1)).toHaveAttribute("href", "https://ux.simpress.com.br/MeusEquipamentos/Index");
  await expect(sistemas.nth(1)).toHaveAttribute("aria-label", "Abrir Meus Equipamentos da Simpress");
  for (const indice of [0, 1]) {
    await expect(sistemas.nth(indice)).toHaveAttribute("target", "_blank");
    await expect(sistemas.nth(indice)).toHaveAttribute("rel", "noopener noreferrer");
  }
  await expect(page.locator("#modal-importar-modelo #descricao-importar-modelo")).toHaveText("");
  await expect(page.locator("#modal-importar-modelo #titulo-importar-modelo")).toHaveText("Importar arquivos");
  expect(semFalhaDePonte(ambiente)).toEqual([]);
});

test("importação: prévia mostra o texto, alterna os botões e a etapa; escolher outro arquivo limpa a prévia", async ({ page }) => {
  const ambiente = await preparar(page);
  await page.addInitScript(() => {
    window.__rolagens = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function rolar(opcoes) { window.__rolagens.push([this.id, opcoes && opcoes.block]); return original.call(this, opcoes); };
  });
  await page.route("**/api/planilhas/previsualizar", route => route.fulfill({ status: 200, json: PREVIA }));
  await esperarReact(page);
  await page.evaluate(() => window.abrirModalAtualizarPlanilhas());
  const modal = page.locator("#modal-atualizar-planilhas");
  const status = modal.locator("#upload-planilhas-status");
  const previa = modal.locator("#upload-planilhas-preview");
  // abrir limpa o status: sem role nem aria-live, com aria-atomic, e a prévia some
  await expect(status).not.toHaveAttribute("role", /.*/);
  await expect(status).not.toHaveAttribute("aria-live", /.*/);
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await expect(previa).toHaveClass("hidden");
  await expect(previa).toHaveText("");

  await modal.locator("#btn-previsualizar-planilhas").click();
  await expect(status).toHaveText("Selecione Endpoint e EquipamentosDetalhes antes de gerar a prévia.");
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toHaveAttribute("aria-live", "assertive");
  expect(await page.evaluate(() => window.__rolagens.filter(([id]) => id === "upload-planilhas-status"))).toEqual([["upload-planilhas-status", "nearest"]]);

  await modal.locator("#upload-endpoint-file").setInputFiles(arquivo("endpoint-teste.xlsx"));
  await modal.locator("#upload-details-file").setInputFiles(arquivo("detalhes-teste.xlsx"));
  await modal.locator("#btn-previsualizar-planilhas").click();
  // o \n da prévia vira espaço no toHaveText (que normaliza espaços); whitespace-pre-line (abaixo) é quem o mostra como quebra
  await expect(previa).toHaveText([
    "Resumo da substituição (contagens por número de série):",
    "Endpoint — endpoint-teste.xlsx (2 linhas)",
    "Séries novas: 1; removidas: 2; duplicadas no arquivo novo: 0.",
    "Simpress — detalhes-teste.xlsx (3 linhas)",
    "Séries novas: 2; removidas: 1; duplicadas no arquivo novo: 1.",
  ].join(" "));
  expect(await previa.evaluate(el => el.textContent.split("\n").length)).toBe(5);
  await expect(previa).toHaveClass("whitespace-pre-line");
  await expect(previa).toHaveAttribute("role", "status");
  await expect(previa).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveText("Confira as contagens e confirme somente se este impacto estiver correto.");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(modal.locator('[data-so-etapa="impacto"]')).toBeVisible();
  await expect(modal.locator('[data-so-etapa="arquivos"]')).toBeHidden();
  await expect(modal.locator("#btn-previsualizar-planilhas")).toBeHidden();
  await expect(modal.locator("#btn-confirmar-planilhas")).toBeVisible();
  await expect(modal.locator("#btn-voltar-planilhas")).toBeVisible();
  expect(await page.evaluate(() => window.__rolagens.some(([id, bloco]) => id === "upload-planilhas-preview" && bloco === "nearest"))).toBe(true);

  // Voltar: etapa Arquivos, prévia limpa, os arquivos escolhidos continuam nos inputs (o React não desmonta nada)
  await modal.locator("#btn-voltar-planilhas").click();
  await expect(modal.locator('[data-so-etapa="arquivos"]')).toBeVisible();
  await expect(previa).toHaveClass("hidden");
  await expect(modal.locator("#btn-voltar-planilhas")).toBeHidden();
  await expect(modal.locator("#btn-previsualizar-planilhas")).toBeVisible();
  await expect(modal.locator("#upload-endpoint-name")).toHaveText("endpoint-teste.xlsx");
  expect(await modal.locator("#upload-endpoint-file").evaluate(el => el.files.length)).toBe(1);

  // Escolher outro arquivo depois da prévia (onChange React) limpa a prévia
  await modal.locator("#btn-previsualizar-planilhas").click();
  await expect(modal.locator("#btn-confirmar-planilhas")).toBeVisible();
  await modal.locator("#upload-endpoint-file").setInputFiles(arquivo("outro-endpoint.xlsx"));
  await expect(modal.locator("#btn-confirmar-planilhas")).toBeHidden();
  await expect(modal.locator("#btn-previsualizar-planilhas")).toBeVisible();
  await expect(previa).toHaveClass("hidden");
  await expect(status).toHaveText("");
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

test("importação: durante o envio o botão mostra só o spinner e a mensagem, trava os controles e um duplo clique manda um POST", async ({ page }) => {
  const ambiente = await preparar(page);
  await page.addInitScript(() => {
    window.__rolagens = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function rolar(opcoes) { window.__rolagens.push([this.id, opcoes && opcoes.block]); return original.call(this, opcoes); };
  });
  const previa = rotaSegurada(ambiente, "**/api/planilhas/previsualizar", { status: 200, json: PREVIA });
  await previa.instalar(page);
  await esperarReact(page);
  await page.evaluate(() => window.abrirModalAtualizarPlanilhas());
  const modal = page.locator("#modal-atualizar-planilhas");
  await modal.locator("#upload-endpoint-file").setInputFiles(arquivo("endpoint-teste.xlsx"));
  await modal.locator("#upload-details-file").setInputFiles(arquivo("detalhes-teste.xlsx"));
  const botao = modal.locator("#btn-previsualizar-planilhas");
  const original = await botao.innerHTML();
  await page.evaluate(() => { window.previsualizarPlanilhas(); window.previsualizarPlanilhas(); }); // dois cliques no mesmo turno
  await expect(botao).toHaveAttribute("aria-busy", "true");
  await expect(botao).toBeDisabled();
  await expect(botao.locator("svg.lucide.lucide-loader-2.w-3\\.5.h-3\\.5.animate-spin")).toHaveCount(1);
  await expect(botao.locator("span")).toHaveText("Validando arquivos...");
  expect(await botao.evaluate(el => [...el.childNodes].map(no => no.nodeName))).toEqual(["svg", "SPAN"]);
  await expect(modal).toHaveAttribute("aria-busy", "true");
  await expect(modal.locator("#upload-endpoint-file")).toBeDisabled();
  await expect(modal.locator("#upload-details-file")).toBeDisabled();
  await expect(modal.locator("#auto-export-history-after-update")).toBeEnabled(); // só a confirmação trava o checkbox
  previa.liberar();
  await expect(modal.locator("#btn-confirmar-planilhas")).toBeVisible();
  expect(ambiente.pedidos).toEqual(["POST"]);
  await expect(botao).not.toHaveAttribute("aria-busy", /.*/);
  await expect(modal).not.toHaveAttribute("aria-busy", /.*/);
  await expect(modal.locator("#upload-endpoint-file")).toBeEnabled();
  expect(await botao.innerHTML()).toBe(original); // o conteúdo original volta (ícone e texto)

  // confirmação: spinner "Confirmando substituição..." e o checkbox também trava; erro 422 destrava e mostra o alerta
  const confirmar = rotaSegurada(ambiente, "**/api/planilhas/atualizar", { status: 422, json: { detail: "Arquivo fictício inválido" } });
  await confirmar.instalar(page);
  const botaoConfirmar = modal.locator("#btn-confirmar-planilhas");
  const originalConfirmar = await botaoConfirmar.innerHTML();
  await page.evaluate(() => { window.enviarPlanilhas(); window.enviarPlanilhas(); });
  await expect(botaoConfirmar.locator("span")).toHaveText("Confirmando substituição...");
  await expect(botaoConfirmar).toHaveAttribute("aria-busy", "true");
  await expect(modal.locator("#auto-export-history-after-update")).toBeDisabled();
  await expect(modal).toHaveAttribute("aria-busy", "true");
  confirmar.liberar();
  await expect(modal.locator("#upload-planilhas-status")).toHaveText("Arquivo fictício inválido");
  await expect(modal.locator("#upload-planilhas-status")).toHaveAttribute("role", "alert");
  await expect(modal.locator("#upload-planilhas-status")).toHaveAttribute("aria-live", "assertive");
  await expect.poll(() => page.evaluate(() => window.__rolagens.some(([id, bloco]) => id === "upload-planilhas-status" && bloco === "nearest"))).toBe(true);
  await expect(modal.locator("#btn-previsualizar-planilhas")).toBeVisible(); // 422 invalida a prévia
  await expect(modal.locator("#auto-export-history-after-update")).toBeEnabled();
  expect(await botaoConfirmar.innerHTML()).toBe(originalConfirmar);
  expect(ambiente.pedidos).toEqual(["POST", "POST"]);
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});

test("importação: a preferência do histórico automático sobrevive ao recarregar a página", async ({ page }) => {
  const ambiente = await preparar(page);
  await esperarReact(page);
  await page.evaluate(() => { localStorage.removeItem("simpress:auto-export-history-after-update"); });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-react-pronto", "");
  const caixa = page.locator("#auto-export-history-after-update");
  await page.evaluate(() => window.abrirModalAtualizarPlanilhas());
  await expect(caixa).not.toBeChecked();
  await caixa.check();
  expect(await page.evaluate(() => localStorage.getItem("simpress:auto-export-history-after-update"))).toBe("true");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-react-pronto", "");
  await expect(caixa).toBeChecked();
  await page.evaluate(() => window.abrirModalAtualizarPlanilhas());
  await caixa.uncheck();
  expect(await page.evaluate(() => localStorage.getItem("simpress:auto-export-history-after-update"))).toBe("false");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-react-pronto", "");
  await expect(caixa).not.toBeChecked();
  expect(semFalhaDePonte(ambiente)).toEqual([]);
});

test("importação: o modal do modelo põe data-tipo e aria-busy no overlay e troca título e descrição por tipo", async ({ page }) => {
  const ambiente = await preparar(page);
  const segurada = rotaSegurada(ambiente, "**/api/modelos/transferencia/importar", { status: 200, json: {} });
  await segurada.instalar(page);
  await esperarReact(page);
  const modal = page.locator("#modal-importar-modelo");
  await page.evaluate(() => window.abrirImportacaoModelo("exportacao"));
  await expect(modal).toHaveAttribute("data-tipo", "exportacao");
  await expect(modal.locator("#titulo-importar-modelo")).toHaveText("Arquivos para exportação");
  await expect(modal.locator("#descricao-importar-modelo")).toHaveText(/^Importe a planilha do modelo de exportação que atualiza os apelidos\/hostnames\. Ao substituir um modelo importado/);
  await page.evaluate(() => window.fecharImportacaoModelo());
  await page.evaluate(() => window.abrirImportacaoModelo("transferencia"));
  await expect(modal).toHaveAttribute("data-tipo", "transferencia");
  await expect(modal.locator("#titulo-importar-modelo")).toHaveText("Arquivos para transferência");
  await expect(modal.locator("#descricao-importar-modelo")).toHaveText(/^A base Simpress \+ Endpoint é compartilhada\./);
  const status = modal.locator("#status-modelo-local");
  await modal.locator("#btn-importar-modelo").click();
  await expect(status).toHaveText("Selecione um modelo .xlsx.");
  await expect(status).toHaveAttribute("role", "status");
  await modal.locator("#arquivo-modelo-local").setInputFiles(arquivo("modelo-teste.xlsx"));
  await page.evaluate(() => { window.enviarModeloLocal(); window.enviarModeloLocal(); });
  await expect(status).toHaveText("Validando e importando o modelo…");
  await expect(modal.locator("#btn-importar-modelo")).toBeDisabled();
  await expect(modal).toHaveAttribute("aria-busy", "true");
  segurada.liberar();
  await expect(status).toContainText("Modelo importado");
  await expect(modal).not.toHaveAttribute("aria-busy", /.*/);
  await expect(modal.locator("#btn-importar-modelo")).toBeEnabled();
  expect(ambiente.pedidos).toEqual(["POST"]);
  expect(semFalhaDePonte(ambiente)).toEqual([]);
  expect(ambiente.bloqueados).toEqual([]);
});
