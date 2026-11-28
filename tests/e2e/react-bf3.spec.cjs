// Bloco final 3 (BF3): resultado da Comparação (Resumo F3), salvamento automático de anotações, indicadores da Home
// (estatísticas, prontidão, alertas do sino e base desatualizada) e corridas de resposta atrasada
// (frontend/src/aplicacao/{comparison-result,cockpit-tool-panels,dashboard}.ts, frontend/src/comum/history-annotation-autosave.ts).
// Baselines gravados com o código antigo (commit d9b046d2). Todo /api/* relevante é simulado aqui, com dados
// sintéticos; o que não é simulado cai no servidor de fixture (tests/support/serve_ui_motion_preview.py). A versão em
// React tem de passar este arquivo sem mudanças; por isso só vale o que o usuário vê e as chamadas de rede.
//
// Contrato com a página (a versão em React mantém): window.abrirComparacaoDaSerie, window.irParaSecaoComparacao,
// o evento simpress:servidor-offline (a perda de conexão é simulada por ele, direto), os eventos de documento
// simpress:atualizar-notificacoes e simpress:painel-atualizado (os alertas são conduzidos por eles) e o evento
// focus da janela (atualiza a prontidão).
//
// Fotos (claro e escuro, desktop e celular): resultado da Comparação com as sub-abas, seção Sem usuário, painel de
// prontidão aberto, indicadores da Home com alerta (base desatualizada) e central de avisos.
// Comportamento (só no desktop): fontes, cartões, abas, filtros, navegação, histórico vazio, Sem usuário (ok, limite,
// erro), autosave das anotações (salva, 409, falha 5xx, falha de rede, sincronização pendente), números e botão de
// exportar, 409 e 500 nas estatísticas, estados da prontidão, cada alerta (aparece e some) e as três corridas.
const { test, expect } = require("@playwright/test");

test.use({ timezoneId: "America/Sao_Paulo", locale: "pt-BR" });

const HORARIO_ATUAL = "2026-10-18T09:00:00-03:00";
const HORARIO_ANTERIOR = "2026-10-11T08:00:00-03:00";

const ARQUIVOS_A = { endpoint: "Endpoint_teste.xlsx", detalhes: "EquipamentosDetalhes_teste.xlsx" };
const ARQUIVOS_B = { endpoint: "Endpoint_antigo.xlsx", detalhes: "EquipamentosDetalhes_antigo.xlsx" };

const comparacaoVazia = () => ({
  ausentes_no_endpoint: [], ausentes_em_detalhes: [], divergencias_local: [], correspondencias_ambiguas: [], registros_ambiguos: [],
  series_sem_mapeamento: [], sem_acesso_7_dias: [], sem_acesso_60_dias: [], apelidos_sem_atualizacao: [],
  divergencias_apelidos_manuais: [], apelidos_atualizados: [], mudancas_usuarios: [],
});

const eventoA = () => ({
  id: "ev-bf3-a", horario: HORARIO_ATUAL, tipo: "atualizacao",
  comparacao: {
    ...comparacaoVazia(),
    total_detalhes: 120, total_endpoint: 118, equipamentos_sincronizados: 96, arquivos_enviados: ARQUIVOS_A,
    ausentes_no_endpoint: [
      { computador: "PRNOTE101", serie: "BRJ100AAAA", local_previsto: "Curitiba", ausente_em: ["endpoint"], anotacao_id: "ausente-endpoint-1", anotacao: "Conferir com o técnico local.", anotacao_revisoes: ["rev-salva-1"] },
      { computador: "PRNOTE102", serie: "BRJ100BBBB", local_previsto: "Londrina", ausente_em: ["endpoint"], anotacao_id: "ausente-endpoint-2" },
    ],
    ausentes_em_detalhes: [
      { computador: "PRNOTE103", serie: "BRJ100CCCC", local_previsto: "Maringá", ausente_em: ["detalhes"], anotacao_id: "ausente-simpress-1" },
    ],
    divergencias_local: [
      { computador: "PRNOTE104", serie: "BRJ100DDDD", local_previsto: "Curitiba", local_detalhes: "Londrina", anotacao_id: "local-1" },
      { computador: "PRNOTE105", serie: "BRJ100EEEE", local_previsto: "Maringá", local_detalhes: "Curitiba", anotacao_id: "local-2" },
    ],
    series_sem_mapeamento: [
      { serie: "BRJ100FFFF", quantidade: 2, exemplos: ["PRNOTE106", "PRNOTE107"], anotacao_id: "serie-sem-local-1" },
    ],
    correspondencias_ambiguas: [{
      tipo: "Hostname duplicado", chave: "BRJ100GGGG", serie: "BRJ100GGGG", fontes: [{ fonte: "endpoint", quantidade: 2 }],
      mensagem: "Duas linhas no Endpoint para a mesma série.",
      registros_endpoint: [
        { serie: "BRJ100GGGG", computador: "PRNOTE108", ultima_verificacao: "2026-10-17T10:00:00-03:00", mais_antigo: false, aplicado: true },
        { serie: "BRJ100GGGG", computador: "PRNOTE109", ultima_verificacao: "2026-09-02T10:00:00-03:00", mais_antigo: true },
      ],
      anotacao_id: "ambigua-1",
    }],
    sem_acesso_7_dias: [
      { computador: "PRNOTE110", serie: "BRJ100HHHH", ultima_verificacao: "2026-10-09T10:00:00-03:00", dias_sem_verificacao: 9, linha_endpoint: 2, anotacao_id: "sem-acesso-7-1" },
      // Como no back-end (routers/dashboard.py), a lista de 60+ sai desta: PRNOTE111 está nas duas.
      { computador: "PRNOTE111", serie: "BRJ100IIII", ultima_verificacao: "2026-08-06T10:00:00-03:00", dias_sem_verificacao: 72, linha_endpoint: 3, anotacao_id: "sem-acesso-7-2" },
    ],
    sem_acesso_60_dias: [
      { computador: "PRNOTE111", serie: "BRJ100IIII", dias: 72, situacao: "passou", anotacao_id: "sem-acesso-60-1" },
      { computador: "PRNOTE112", serie: "BRJ100JJJJ", dias: 64, situacao: "saiu_endpoint", anotacao_id: "sem-acesso-60-2" },
    ],
    apelidos_sem_atualizacao: [
      { serie: "BRJ100KKKK", computador: "PRNOTE113", motivo: "Série vazia no Endpoint.", anotacao_id: "apelido-1" },
    ],
    mudancas_usuarios: [
      { tipo: "alterado_endpoint", serie: "BRJ100LLLL", computador: "PRNOTE114", usuario_anterior: "usuario.antigo", usuario_novo: "usuario.novo", motivo: "Endpoint informou outro usuário.", anotacao_id: "usuario-1" },
    ],
  },
});

const eventoB = () => ({
  id: "ev-bf3-b", horario: HORARIO_ANTERIOR, tipo: "atualizacao",
  comparacao: {
    ...comparacaoVazia(),
    total_detalhes: 100, total_endpoint: 90, equipamentos_sincronizados: 80, arquivos_enviados: ARQUIVOS_B,
    divergencias_local: [
      { computador: "PRNOTE201", serie: "BRJ200AAAA", local_previsto: "Curitiba", local_detalhes: "Londrina", anotacao_id: "b-local-1" },
    ],
  },
});

const SEM_USUARIO = [
  { serial: "BRJ300AAAA", apelido: "PRSEMUSU001", retirada_cidade: "Curitiba", modelo: "Modelo de teste A" },
  { serial: "BRJ300BBBB", apelido: "PRSEMUSU002", retirada_cidade: "Londrina", modelo: "Modelo de teste B" },
  { serial: "BRJ300CCCC", apelido: "PRSEMUSU003", retirada_cidade: "Maringá", modelo: "Modelo de teste C" },
];

const STATS_BASE = { total_equipamentos: 1250, total_unidades: 5, exportacao_disponivel: true, total_alteracoes_exportaveis: 3 };

const ARQUIVOS_PRONTIDAO = ["inventario_equipamentos", "inventario_detalhes_atualizacao", "inventario_endpoint", "modelo_exportacao", "historico_chamados"];
// `faltando`: chaves de arquivo que não estão disponíveis; `extra`: campos soltos no corpo (gravacao_bloqueada etc.).
const prontidao = ({ faltando = [], extra = {} } = {}) => ({
  functions: { consulta_equipamentos: { available: true } },
  files: Object.fromEntries(ARQUIVOS_PRONTIDAO.map(chave => [chave, faltando.includes(chave)
    ? { available: false, state: "missing", reason: "Arquivo ainda não importado." } : { available: true }])),
  ...extra,
});

const ALERTAS = {
  ocultos: {
    os_paradas: { estado: "em_dia", limite_dias: 7, total: 0, maior_dias_sem_atualizacao: null, importado_em: HORARIO_ATUAL },
    divergencias_novas: { estado: "sem_novas", total: 0, por_secao: [], anterior: null, atual: null },
    sem_acesso_60_dias: {
      estado: "em_dia", limite_aviso_dias: 55, limite_dias: 60, total_limite: 0, total_passou: 0, total_saiu_endpoint: 0,
      maior_dias: null, horario: HORARIO_ATUAL, equipamentos: [],
    },
  },
  visiveis: {
    os_paradas: { estado: "paradas", limite_dias: 7, total: 3, maior_dias_sem_atualizacao: 21, importado_em: HORARIO_ATUAL },
    divergencias_novas: {
      estado: "novas", total: 5, por_secao: [{ secao: "Localidade divergente", total: 3 }, { secao: "Séries sem local definido", total: 2 }],
      anterior: { id: "anterior", horario: HORARIO_ANTERIOR }, atual: { id: "atual", horario: HORARIO_ATUAL },
    },
    sem_acesso_60_dias: {
      estado: "passou_60", limite_aviso_dias: 55, limite_dias: 60, total_limite: 1, total_passou: 2, total_saiu_endpoint: 1,
      maior_dias: 72, horario: HORARIO_ATUAL,
      equipamentos: [
        { serie: "BRJ111AAAA", computador: "PRNOTE001", dias: 72, situacao: "passou" },
        { serie: "BRJ222BBBB", computador: "PRNOTE002", dias: 61, situacao: "saiu_endpoint" },
        { serie: "BRJ333CCCC", computador: "PRNOTE003", dias: 57, situacao: "limite" },
      ],
    },
  },
};
const BASE = {
  atualizada: { estado: "atualizada", limite_dias: 7, dias_sem_atualizacao: 2, ultima_atualizacao: "2026-10-15T20:15:53-03:00", origem_data: "historico" },
  desatualizada: { estado: "desatualizada", limite_dias: 7, dias_sem_atualizacao: 9, ultima_atualizacao: "2026-10-08T20:15:00-03:00", origem_data: "historico" },
  sem_base: { estado: "sem_base", limite_dias: 7, dias_sem_atualizacao: null, ultima_atualizacao: "", origem_data: "" },
};
const BACKUPS_NENHUM = { indisponivel: false, pendencias: { sem_backup: [], conferir: [] } };

const painel = (extra = {}) => ({
  base_importada: true, total_equipamentos: 1250, total_unidades: 5,
  por_categoria: [{ value: "notebook", label: "Notebooks", total: 1250 }], sem_categoria: 0,
  cidades_principais: [{ cidade: "Curitiba", total: 1250 }], cidades_por_categoria: { notebook: [{ cidade: "Curitiba", total: 1250 }] },
  total_cidades: 1, sem_cidade: 0, ultima_atualizacao: "15/10/2026 20:15", arquivo_origem: "simpress-teste.xlsx",
  ultima_comparacao: { id: "ev-bf3-a", horario: HORARIO_ATUAL },
  base_desatualizada: BASE.atualizada, chamados_outro_tecnico: { total: 0, itens: [] }, backups_regionais: BACKUPS_NENHUM,
  ...ALERTAS.ocultos, ...extra,
});
const painelComAlertas = (extra = {}) => painel({
  ...ALERTAS.visiveis, base_desatualizada: BASE.desatualizada,
  chamados_outro_tecnico: { total: 2, itens: [
    { chamado: "UTIC-2026-1378", serie: "BRJ444DDDD", os: "7285070", motivo: "saiu_do_dashboard" },
    { chamado: "UTIC-2026-1379", serie: "BRJ555EEEE", os: "7285071", motivo: "nao_encontrado_softexpert" },
  ] },
  backups_regionais: { indisponivel: false, pendencias: { sem_backup: ["Londrina"], conferir: ["Maringá"] } },
  ...extra,
});

const criarPortao = () => { let liberar; const promessa = new Promise(resolve => { liberar = resolve; }); return { promessa, liberar }; };
// A resposta pode chegar a uma requisição que a página já abortou (resposta antiga substituída): isso não é falha do teste.
const responder = async (route, opcoes) => { try { await route.fulfill(opcoes); } catch (erro) { /* requisição abortada pela página */ } };

// Cada `portao` é uma promessa que o teste cria com `ambiente.segurar(nome)` e libera quando quiser: só a primeira
// requisição seguinte daquele nome espera (resposta atrasada). Nomes: stats, prontidao, detalhe-<id>, anotacao.
// O corpo da resposta é escolhido ANTES de esperar o portão: a resposta atrasada traz o que valia quando foi pedida.
async function preparar(page, { tema = "light", ...inicial } = {}) {
  const ambiente = {
    chamadas: [], portoes: {}, painel: painel(), stats: { status: 200, json: STATS_BASE },
    prontidao: { status: 200, json: prontidao() }, eventos: [eventoA(), eventoB()],
    semUsuario: { modo: "ok", itens: SEM_USUARIO }, anotacao: { modo: "ok" }, removidos: [], semUsuarioChamadas: 0,
    ...inicial,
  };
  ambiente.segurar = nome => { ambiente.portoes[nome] = criarPortao(); return ambiente.portoes[nome]; };
  const passar = async nome => {
    const portao = ambiente.portoes[nome];
    if (!portao) return;
    ambiente.portoes[nome] = null;
    await portao.promessa;
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  page.on("request", requisicao => {
    const url = new URL(requisicao.url());
    if (url.pathname.startsWith("/api/")) ambiente.chamadas.push({ metodo: requisicao.method(), caminho: url.pathname, busca: url.searchParams, corpo: requisicao.postData() });
  });

  await page.route("**/api/config/cliente", route => responder(route, { json: {
    contrato: "000000/2026", cnpj_faturamento: "00.000.000/0001-00", series_sebrae_fora: [], cliente_configurado: true,
    cliente_fontes: { contrato: "arquivo", cnpj_faturamento: "arquivo", series_sebrae_fora: "arquivo" }, cliente_arquivo_invalido: false,
  } }));
  await page.route(/\/api\/painel(\?|$)/, route => responder(route, { json: ambiente.painel }));
  await page.route(/\/api\/stats(\?|$)/, async route => {
    const resposta = ambiente.stats;
    await passar("stats");
    return responder(route, { status: resposta.status, json: resposta.json });
  });
  await page.route(/\/api\/prontidao(\?|$)/, async route => {
    const resposta = ambiente.prontidao;
    await passar("prontidao");
    return responder(route, { status: resposta.status, json: resposta.json });
  });

  await page.route(/\/api\/historico-comparacoes(\?.*)?$/, route => responder(route, { json: { eventos: ambiente.eventos } }));
  await page.route(/\/api\/historico-comparacoes\/[^/?]+(\?.*)?$/, async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    const evento = ambiente.eventos.find(item => item.id === id);
    await passar(`detalhe-${id}`);
    return responder(route, evento ? { json: { evento } } : { status: 404, json: { detail: "Comparação não encontrada." } });
  });
  // Resposta de salvamento: tem de repetir o `revisao_id` enviado, senão a página trata como confirmação inválida.
  await page.route(/\/api\/historico-comparacoes\/[^/]+\/anotacoes\/[^/?]+(\?.*)?$/, async route => {
    const corpo = route.request().postDataJSON();
    const modo = ambiente.anotacao.modo;
    await passar("anotacao");
    if (modo === "abortar") {
      try { await route.abort("failed"); } catch (erro) { /* já abortada */ }
      return;
    }
    if (modo === "409") return responder(route, { status: 409, json: { detail: "A anotação mudou em outro lugar. Atualize o resultado antes de salvar." } });
    if (modo === "503") return responder(route, { status: 503, json: { detail: "Serviço temporariamente indisponível." } });
    const confirmacao = { sucesso: true, anotacao_revisoes: [corpo.revisao_id], anotacao_conflito: false };
    if (modo === "pendente" || modo === "local") confirmacao.sincronizacao = modo;
    return responder(route, { json: confirmacao });
  });

  // Notebooks sem usuário (seção Sem usuário do Resumo). Sem `usuario=sem` a chamada segue para o servidor de fixture.
  await page.route("**/api/buscar-expandida*", async route => {
    const busca = new URL(route.request().url()).searchParams;
    if (busca.get("usuario") !== "sem") return route.fallback();
    const { modo, itens } = ambiente.semUsuario;
    if (modo === "erro") return responder(route, { status: 500, json: { detail: "Falha simulada." } });
    if (modo === "limite") {
      // Uma linha por página, sempre com mais páginas: a página para na 20ª e mostra o aviso de limite.
      ambiente.semUsuarioChamadas += 1;
      const serial = `BRJ4${String(ambiente.semUsuarioChamadas).padStart(5, "0")}`;
      return responder(route, { json: {
        items: [{ serial, apelido: `PRLIMITE${String(ambiente.semUsuarioChamadas).padStart(3, "0")}`, retirada_cidade: "Curitiba", modelo: "Modelo de teste L" }],
        total: 2500, offset: 0, limit: 100, has_more: true,
      } });
    }
    return responder(route, { json: { items: modo === "vazio" ? [] : itens, total: modo === "vazio" ? 0 : itens.length, offset: 0, limit: 100, has_more: false } });
  });

  await page.route("**/api/endpoint/hostnames-removidos", route => {
    const requisicao = route.request();
    if (requisicao.method() === "POST") {
      const { serie, hostname } = requisicao.postDataJSON();
      ambiente.removidos.push({ serie, hostname });
      return responder(route, { json: { sucesso: true } });
    }
    return responder(route, { json: { removidos: ambiente.removidos, pendentes: ambiente.pendentes || [] } });
  });
  // Remoção no Endpoint Central (sintética): grava o par só quando o resultado é "removido" com gravação local.
  await page.route("**/api/endpoint/hostnames-removidos/remover-no-endpoint", route => {
    const { serie, hostname } = route.request().postDataJSON();
    const resposta = ambiente.remocaoEndpoint || { resultado: "removido", gravado_local: true, mensagem: "Computador removido no Endpoint Central." };
    if (resposta.resultado === "removido" && resposta.gravado_local) ambiente.removidos.push({ serie, hostname });
    return responder(route, { json: resposta });
  });
  await page.route("**/api/endpoint/hostnames-removidos/restaurar", route => {
    const { serie, hostname } = route.request().postDataJSON();
    ambiente.removidos = ambiente.removidos.filter(item => !(item.serie === serie && item.hostname === hostname));
    return responder(route, { json: { sucesso: true } });
  });

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  return ambiente;
}

async function abrirMenu(page) {
  const botaoMenu = page.locator("#btn-sidebar-open");
  const casca = page.locator("#simpress-app-shell");
  if (await botaoMenu.isVisible() && await casca.getAttribute("data-sidebar-open") !== "true") {
    await botaoMenu.click();
    await expect(casca).toHaveAttribute("data-sidebar-open", "true");
  }
}

// O Resumo volta para a Visão Geral (padrão desde 23/11/2026) quando termina de montar: espera o estado assentado antes de mexer nas abas.
// Os testes de lista seguem em Divergências (aba: "divergencias"); aba: null deixa na Visão Geral.
async function abrirResumo(page, { aba = "divergencias" } = {}) {
  await abrirMenu(page);
  await page.locator("#btn-resumo-aba").click();
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
  await expect(page.locator("#comparacao-planilhas-conteudo")).toHaveAttribute("data-estado", /^(pronto|vazio|erro)$/);
  await expect(page.locator("#resumo-regionais")).toHaveAttribute("data-estado", /^(pronto|erro)$/);
  await expect(page.locator("#resumo-aba-visao-geral")).toHaveAttribute("aria-selected", "true");
  if (aba) {
    await page.locator(`#resumo-aba-${aba}`).click();
    await expect(page.locator(`#resumo-aba-${aba}`)).toHaveAttribute("aria-selected", "true");
  }
}

async function irParaAba(page, chave) {
  await page.locator(`#resumo-aba-${chave}`).click();
  await expect(page.locator(`#resumo-aba-${chave}`)).toHaveAttribute("aria-selected", "true");
}

const linha = (page, categoria, serie) => page.locator(`[data-comparison-category="${categoria}"][data-comparison-serial="${serie}"]:visible`);
const anotacaoDe = (page, id) => page.locator(`[data-comparison-annotation][data-annotation-id="${id}"]:visible`);
const estadoDaAnotacao = ta => ta.locator("xpath=..").locator("[data-annotation-status]");
const tentarDeNovo = ta => ta.locator("xpath=..").locator("[data-annotation-retry]");

const esperarToast = (page, texto) => expect(page.locator("#toast-container .ck-toast", { hasText: texto })).toBeVisible();
// POST /api/equipamentos/usuarios-logados só consulta (a tela o chama ao abrir o Resumo); não conta como escrita.
const CONSULTAS_POST = new Set(["/api/equipamentos/usuarios-logados"]);
const escritas = ambiente => ambiente.chamadas
  .filter(chamada => chamada.metodo !== "GET" && !CONSULTAS_POST.has(chamada.caminho))
  .map(({ metodo, caminho, corpo }) => ({ metodo, caminho, corpo }));
const chamadasDe = (ambiente, metodo, caminho) => ambiente.chamadas.filter(chamada => chamada.metodo === metodo && chamada.caminho === caminho);
const corpoDe = chamada => JSON.parse(chamada.corpo);
const confirmar = page => page.locator("#btn-confirmar-acao-ok").click();
const assentar = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));

// A página pede /api/stats de novo depois de remover ou restaurar um hostname duplicado (único gatilho de usuário
// fora do carregamento); o botão visível alterna entre "Remover mais antigo" e "Desfazer".
async function alternarHostname(page, ambiente) {
  const antes = chamadasDe(ambiente, "GET", "/api/stats").length;
  const remover = page.locator("#comparacao-planilhas-conteudo [data-hostname-remove]:visible");
  if (await remover.count()) {
    await remover.click();
    await confirmar(page);
  } else {
    await page.locator("#comparacao-planilhas-conteudo [data-hostname-restore]:visible").click();
  }
  await expect.poll(() => chamadasDe(ambiente, "GET", "/api/stats").length).toBeGreaterThan(antes);
}

// Pede a prontidão de novo como o navegador faz ao voltar para a janela.
async function atualizarProntidao(page, ambiente, resposta) {
  ambiente.prontidao = resposta;
  const antes = chamadasDe(ambiente, "GET", "/api/prontidao").length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => chamadasDe(ambiente, "GET", "/api/prontidao").length).toBeGreaterThan(antes);
}

// Pede o painel de novo como o sino faz; a resposta vira o evento simpress:painel-atualizado que desenha os alertas.
async function atualizarPainel(page, ambiente, novo) {
  ambiente.painel = novo;
  const antes = chamadasDe(ambiente, "GET", "/api/painel").length;
  await page.evaluate(() => document.dispatchEvent(new Event("simpress:atualizar-notificacoes")));
  await expect.poll(() => chamadasDe(ambiente, "GET", "/api/painel").length).toBeGreaterThan(antes);
}

async function abrirSino(page) {
  await abrirMenu(page);
  await page.locator("#btn-notificacoes").click();
  await expect(page.locator("#notification-center-panel")).toBeVisible();
}

const foto = { animations: "disabled", maxDiffPixelRatio: 0.01 };
// O aviso de sucesso ou erro (canto da tela) não faz parte da foto. A CSP da página (style-src 'self') bloqueia
// <style> injetado; mudar `style` pelo CSSOM é permitido.
async function fotografar(page, seletor, nome) {
  await page.evaluate(() => { document.getElementById("toast-container").style.display = "none"; });
  await page.mouse.move(0, 0);
  await expect(page.locator(seletor)).toHaveScreenshot(nome, foto);
}

for (const tema of ["light", "dark"]) {
  test(`baseline: resultado da Comparação com sub-abas e seção Sem usuário, tema ${tema}`, async ({ page }) => {
    test.setTimeout(60_000);
    await preparar(page, { tema });
    await abrirResumo(page);
    await expect(page.locator("#comparacao-planilhas-fontes")).toBeHidden();
    await fotografar(page, '[data-cockpit-tool-panel="comparacao"]', `comparacao-divergencias-${tema}.png`);

    await irParaAba(page, "usuarios");
    await expect(page.locator('[data-sem-usuario-section="ok"]')).toBeVisible();
    await fotografar(page, "[data-sem-usuario-section=\"ok\"]", `comparacao-sem-usuario-${tema}.png`);
  });

  test(`baseline: indicadores da Home com prontidão aberta, base desatualizada e central de avisos, tema ${tema}`, async ({ page }) => {
    test.setTimeout(60_000);
    const ambiente = await preparar(page, {
      tema, painel: painelComAlertas(),
      prontidao: { status: 200, json: prontidao({ faltando: ["inventario_endpoint"] }) },
    });
    await expect(page.locator("#stat-equipamentos")).toHaveText("1.250");
    await expect(page.locator("#readiness-panel")).toHaveAttribute("data-state", "warning");
    await expect(page.locator("#alerta-base-desatualizada")).toBeVisible();
    await page.locator("#readiness-panel summary").click();
    await expect(page.locator("#readiness-content")).toBeVisible();
    await fotografar(page, "#readiness-content", `prontidao-aberta-${tema}.png`);
    await page.locator("#readiness-fechar").click();
    await fotografar(page, "#alerta-base-desatualizada", `alerta-base-desatualizada-${tema}.png`);

    await abrirSino(page);
    await expect(page.locator("#notification-center-summary")).toHaveText("5 avisos ativos.");
    await fotografar(page, "#notification-center-panel", `central-avisos-${tema}.png`);
    expect(escritas(ambiente)).toEqual([]);
  });
}

test.describe("comportamento (só no desktop)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "o comportamento é igual no celular; as fotos cobrem o layout");
  test.describe.configure({ timeout: 40_000 });

  // Novo layout (18/11/2026): o seletor mostra "dd/mm/aaaa hh:mm · Tipo" e o status "Tipo · dd/mm/aaaa hh:mm" (hora local do navegador);
  // o texto das fontes saiu do Resumo e #comparacao-planilhas-fontes fica oculto e vazio.
  // Navegador no fuso de Brasília: a CI roda em UTC e a hora esperada não pode depender do fuso da máquina.
  test.use({ timezoneId: "America/Sao_Paulo" });
  const CURTO_ATUAL = "18/10/2026 09:00"; // HORARIO_ATUAL
  const CURTO_ANTERIOR = "11/10/2026 08:00"; // HORARIO_ANTERIOR
  const semFontes = page => expect(page.locator("#comparacao-planilhas-fontes")).toBeHidden();
  const interno = { useInnerText: true };
  const linhaDe = (page, serie) => page.locator(`#comparacao-planilhas-conteudo [data-comparison-serial="${serie}"]:visible`);
  const barra = page => page.locator("#comparacao-planilhas-conteudo [data-history-filter-bar]:visible");
  const contagem = page => barra(page).locator("[data-history-filter-count]");
  const titulo = (page, id) => page.locator(`#${id}`);

  // ---------- Comparação ----------

  test("Comparação: status e seletor de comparações (sem linha de fontes)", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirResumo(page);
    await semFontes(page);
    await expect(page.locator("#comparacao-planilhas-fontes")).toHaveText("", interno);
    await expect(page.locator("#cockpit-comparison-status")).toHaveText(`Atualização · ${CURTO_ATUAL}`, interno);
    await expect(page.locator("#cockpit-comparison-event option")).toHaveText([`${CURTO_ATUAL} · Atualização`, `${CURTO_ANTERIOR} · Atualização`]);
    await expect(page.locator("#cockpit-comparison-event")).toHaveValue("ev-bf3-a");
    expect(escritas(ambiente)).toEqual([]);
  });

  test("Comparação: Visão Geral com o bento, abas com contadores e cartões que levam à seção", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirResumo(page, { aba: null });
    // Visão Geral (23/11/2026): a barra de sub-abas sobe para o topo e a primeira aba guarda o bento (aba padrão, sem selo de contagem); seis abas.
    const abas = [["visao-geral", "Visão Geral"], ["divergencias", "Divergências 6"], ["apelidos", "Apelidos 2"], ["usuarios", "Usuários 4"], ["sem-acesso", "Sem acesso 3"], ["backups", "Backups 0"]];
    await expect(page.locator(".resumo-abas button")).toHaveText(abas.map(([, rotulo]) => rotulo), interno);
    await expect(page.locator("#resumo-aba-visao")).toHaveCount(0);
    await expect(page.locator("#resumo-aba-visao-geral")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#resumo-painel-visao-geral")).toBeVisible();
    await expect(page.locator("#comparacao-planilhas-conteudo")).toBeHidden();
    // A barra de abas fica acima do bento.
    const yBarra = (await page.locator(".resumo-abas").boundingBox()).y;
    const yBento = (await page.locator("#resumo-painel-visao-geral").boundingBox()).y;
    expect(yBarra).toBeLessThan(yBento);
    await expect(page.locator("#resumo-aba-divergencias")).toHaveAttribute("aria-selected", "false");
    await expect(page.locator("#resumo-aba-divergencias")).toHaveAttribute("aria-label", "Divergências: 6 linhas");
    await expect(page.locator("#resumo-aba-usuarios")).toHaveAttribute("aria-label", "Usuários: 4 linhas");

    for (const [chave] of abas) {
      await irParaAba(page, chave);
      for (const [outra] of abas) {
        const painel = page.locator(`#resumo-painel-${outra}`);
        if (outra === chave) await expect(painel).toBeVisible(); else await expect(painel).toBeHidden();
      }
      // O bento (com "Ativos por regional") só aparece na Visão Geral.
      if (chave === "visao-geral") await expect(page.locator("#resumo-ativos-secao")).toBeVisible();
      else await expect(page.locator("#resumo-ativos-secao")).toBeHidden();
    }

    // Números do bento (a contagem anima até o valor) e "Ver lista →": seleciona a sub-aba, rola até ela e foca a aba.
    await expect(page.locator("#nf3-num-divergencias")).toHaveText("6");
    await expect(page.locator("#nf3-num-apelidos")).toHaveText("2");
    await expect(page.locator("#nf3-num-usuarios")).toHaveText("4");
    await expect(page.locator("#nf3-num-sem-acesso")).toHaveText("3");
    // 7 a 59 dias (26/11/2026): PRNOTE111 (72 dias) aparece só na lista de 60+; cartão e selo contam cada máquina uma vez (1 + 2).
    await irParaAba(page, "sem-acesso");
    const painelSemAcesso = page.locator("#resumo-painel-sem-acesso");
    await expect(painelSemAcesso.locator('tr[data-comparison-category="sem_acesso_7_dias"] td:nth-child(2)')).toHaveText(["BRJ100HHHH"]);
    await expect(painelSemAcesso.locator('tr[data-comparison-category="sem_acesso_60_dias"] td:nth-child(2)')).toHaveText(["BRJ100IIII", "BRJ100JJJJ"]);
    await expect(painelSemAcesso).toContainText("Sem acesso de 7 a 59 dias");
    await expect(painelSemAcesso.locator('tr[data-comparison-category="sem_acesso_60_dias"] td:nth-child(4)')).toHaveText(["Ainda no Endpoint, sem acesso", "Saiu para Ausentes no Endpoint"]);
    await irParaAba(page, "visao-geral");
    await expect(page.locator("#nf3-num-divergencias")).toHaveText("6");
    await page.locator('[data-nf3-cartao="usuarios"] [data-nf3-ver]').click();
    await expect(page.locator("#resumo-aba-usuarios")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#resumo-aba-usuarios")).toBeFocused();
    await expect(page.locator("#resumo-painel-visao-geral")).toBeHidden();
    await expect(page.locator("#resumo-painel-usuarios")).toBeVisible();

    // Os cartões de Divergências continuam levando à seção.
    await irParaAba(page, "divergencias");
    await page.locator('#resumo-painel-divergencias [data-comparison-section-target="comparacao-secao-localidade-divergente"]').first().click();
    await expect(page.locator("#resumo-aba-divergencias")).toHaveAttribute("aria-selected", "true");
    await expect(titulo(page, "comparacao-secao-localidade-divergente")).toBeInViewport();
    expect(escritas(ambiente)).toEqual([]);
  });

  // Novo layout (18/11/2026): cartão "Histórico" do bento (4 registros, selo "atual", "Ver tudo →" abre o diálogo como gaveta).
  // /api/* exige o X-Simpress-Sessao: os links do Endpoint não apontam para a API; o clique (ou o do meio) pede a URL da tela
  // certa por apiFetch e abre a aba externa (frontend/src/comum/links-endpoint.ts). Só dados sintéticos (exemplo.invalid).
  test("Comparação: links do Endpoint em Sem acesso pedem a tela certa e abrem a aba externa", async ({ page }) => {
    const telas = [];
    await page.route("**/api/config/local/endpoint/*", route => {
      const tela = new URL(route.request().url()).pathname.split("/").pop();
      telas.push(tela);
      return route.fulfill({ json: { url: `https://exemplo.invalid/webclient#/${tela}` } });
    });
    await page.context().route("https://exemplo.invalid/**", route => route.fulfill({ contentType: "text/html", body: "<title>externo</title>" }));
    await preparar(page);
    await abrirResumo(page, { aba: "sem-acesso" });
    const painelSemAcesso = page.locator("#resumo-painel-sem-acesso");
    const urlAntes = page.url();
    for (const [seletor, tela, botao] of [["[data-endpoint-computers-link]", "som-computadores", "left"], ["[data-endpoint-staged-link]", "staged-computers", "middle"]]) {
      const link = painelSemAcesso.locator(seletor);
      await expect(link).toHaveAttribute("data-endpoint-tela", tela);
      await expect(link).toHaveAttribute("href", "#");
      const aba = page.context().waitForEvent("page");
      await link.click({ button: botao });
      await (await aba).waitForURL(`https://exemplo.invalid/webclient#/${tela}`);
    }
    expect(telas).toEqual(["som-computadores", "staged-computers"]);
    expect(page.url()).toBe(urlAntes);
    // Só as duas abas externas: o clique do meio não abriu o /# do Simpress.
    expect(page.context().pages().map(aberta => new URL(aberta.url()).host)).toEqual([new URL(urlAntes).host, "exemplo.invalid", "exemplo.invalid"]);
  });

  test("Resumo: cartão Histórico mostra os 4 primeiros registros, troca a comparação e abre o histórico completo", async ({ page }, info) => {
    const extra = (id, horario) => ({ ...eventoB(), id, horario });
    const ambiente = await preparar(page, {
      eventos: [eventoA(), eventoB(), extra("ev-bf3-c", "2026-10-04T08:00:00-03:00"), extra("ev-bf3-d", "2026-09-27T08:00:00-03:00"), extra("ev-bf3-e", "2026-09-20T08:00:00-03:00")],
    });
    await abrirResumo(page, { aba: null }); // o cartão Histórico vive no bento da Visão Geral
    const itens = page.locator("#nf3-historico-lista .nf3-historico__item");
    await expect(itens).toHaveCount(4);
    await expect(page.locator("#nf3-historico-vazio")).toBeHidden();
    await expect(itens.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(itens.nth(0).locator(".nf3-historico__atual")).toHaveText("atual");
    await expect(page.locator(".nf3-historico__atual")).toHaveCount(1);
    await expect(itens.nth(0)).toContainText("Atualização");

    // Escolher um registro faz o mesmo que o seletor: carrega o resultado e atualiza o status.
    await itens.nth(1).click();
    await expect(page.locator("#cockpit-comparison-event")).toHaveValue("ev-bf3-b");
    await expect(page.locator("#cockpit-comparison-status")).toHaveText(`Atualização · ${CURTO_ANTERIOR}`, interno);
    await expect(itens.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(itens.nth(1).locator(".nf3-historico__atual")).toHaveText("atual");
    await expect(page.locator(".nf3-historico__atual")).toHaveCount(1);

    // "Ver tudo →" abre o diálogo completo (a exclusão de registros continua dentro dele); no desktop ele é uma gaveta à direita.
    await page.locator("#nf3-historico-ver-tudo").click();
    const dialogo = page.locator("#modal-historico-comparacoes");
    await expect(dialogo).toBeVisible();
    if (info.project.name === "desktop") {
      const caixa = await dialogo.locator(".ck-dialogo").boundingBox();
      const largura = await page.evaluate(() => document.documentElement.clientWidth);
      expect(Math.abs(caixa.x + caixa.width - largura)).toBeLessThanOrEqual(1);
      expect(caixa.width).toBeLessThanOrEqual(520);
    }
    expect(escritas(ambiente)).toEqual([]);
  });

  test("Resumo sem histórico: cartão Histórico mostra o vazio e a lista fica sem itens", async ({ page }) => {
    await preparar(page, { eventos: [] });
    await abrirResumo(page, { aba: null });
    await expect(page.locator("#nf3-historico-vazio")).toBeVisible();
    await expect(page.locator("#nf3-historico-lista .nf3-historico__item")).toHaveCount(0);
    for (const chave of ["divergencias", "apelidos", "usuarios", "sem-acesso"]) await expect(page.locator(`#nf3-num-${chave}`)).toHaveText("—");
    for (const chave of ["apelidos", "usuarios", "sem-acesso"]) await expect(page.locator(`#resumo-aba-${chave}`)).toHaveAttribute("aria-disabled", "true");
  });

  // Novo layout (18/11/2026): "Copiar tabela" e "Modo compacto" saíram do Resumo; a densidade compacta não mexe na tabela da Comparação.
  test("Resumo: sem Copiar tabela nem Modo compacto, e a densidade compacta não muda a tabela", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "tabela só no desktop; no celular a Comparação vira cards");
    await preparar(page);
    await abrirResumo(page);
    const painel = page.locator('[data-cockpit-tool-panel="comparacao"]');
    await expect(painel.locator(".comparison-desktop-table:visible").first()).toBeVisible();
    await expect(painel.locator(".ux-table-tools")).toHaveCount(0);
    await expect(painel.getByRole("button", { name: /Copiar tabela/i })).toHaveCount(0);
    await expect(painel.getByRole("button", { name: /Modo compacto/i })).toHaveCount(0);
    const medir = () => page.evaluate(() => {
      const celula = document.querySelector("#comparacao-planilhas-conteudo .comparison-desktop-table td");
      const cabeca = document.querySelector("#comparacao-planilhas-conteudo .comparison-desktop-table th");
      const lido = elemento => { const css = getComputedStyle(elemento); return [css.paddingTop, css.paddingBottom, css.fontSize]; };
      return { td: lido(celula), th: lido(cabeca) };
    });
    const normal = await medir();
    await page.evaluate(() => { document.documentElement.dataset.uxDensity = "compact"; });
    expect(await medir()).toEqual(normal);
    await page.evaluate(() => { delete document.documentElement.dataset.uxDensity; });
  });

  // Novo layout (18/11/2026): de 320 a 2560 px o Resumo não rola na horizontal, o bento cabe na janela e abaixo de 1024 px a tabela vira cards.
  test("Resumo: sem rolagem horizontal de 320 a 2560 px e tabela vira cards no celular", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a janela é redimensionada dentro do teste");
    await preparar(page);
    await abrirResumo(page);
    for (const largura of [320, 390, 768, 1024, 2560]) {
      await page.setViewportSize({ width: largura, height: 844 });
      await assentar(page);
      const medida = await page.evaluate(() => {
        const janela = document.documentElement.clientWidth;
        const fora = [...document.querySelectorAll("#cockpit-tool-panels .nf3-cartao, #cockpit-tool-panels .nf3-regional, #cockpit-tool-panels .nf3-historico, #cockpit-tool-panels .nf3-sub")]
          .filter(elemento => elemento.getBoundingClientRect().right > janela + 1 || elemento.getBoundingClientRect().left < -1)
          .map(elemento => elemento.className);
        return { janela, documento: document.documentElement.scrollWidth, corpo: document.body.scrollWidth, fora };
      });
      expect(medida.documento, `documento a ${largura}px`).toBeLessThanOrEqual(medida.janela);
      expect(medida.corpo, `corpo a ${largura}px`).toBeLessThanOrEqual(medida.janela);
      expect(medida.fora, `blocos fora da janela a ${largura}px`).toEqual([]);
      const celular = largura < 1024;
      const tabela = page.locator("#comparacao-planilhas-conteudo .comparison-desktop-table").first();
      const cartoes = page.locator("#comparacao-planilhas-conteudo .comparison-mobile-list").first();
      if (celular) {
        await expect(tabela, `tabela a ${largura}px`).toBeHidden();
        await expect(cartoes, `cards a ${largura}px`).toBeVisible();
      } else {
        await expect(tabela, `tabela a ${largura}px`).toBeVisible();
        await expect(cartoes, `cards a ${largura}px`).toBeHidden();
      }
    }
    await irParaAba(page, "backups");
    await expect(page.locator("#resumo-painel-backups")).toBeVisible();
    await page.setViewportSize({ width: 320, height: 844 });
    await assentar(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), "Backups a 320px").toBeLessThanOrEqual(320);
  });

  test("Comparação: filtros de busca, tipo e só com anotação", async ({ page }) => {
    await preparar(page);
    await abrirResumo(page);
    await expect(contagem(page)).toHaveText("6 linhas para conferência neste resultado.");
    await expect(barra(page).locator("[data-history-filter-category] option")).toHaveText([
      "Todos os tipos", "Sem correspondência", "Localidade divergente", "Série sem local definido",
    ]);

    const busca = barra(page).locator("[data-history-filter-search]");
    await busca.fill("BRJ100DDDD");
    await expect(contagem(page)).toHaveText("1 linha encontrada neste resultado.");
    await expect(linhaDe(page, "BRJ100DDDD")).toBeVisible();
    await expect(linhaDe(page, "BRJ100EEEE")).toHaveCount(0);
    await expect(titulo(page, "comparacao-secao-ausentes-endpoint")).toBeHidden();

    await busca.fill("zzzz");
    await expect(contagem(page)).toHaveText("Nenhuma linha encontrada para “zzzz”.");
    await expect(titulo(page, "comparacao-secao-localidade-divergente")).toBeHidden();

    // A busca ignora acento e olha também o texto da anotação.
    await busca.fill("tecnico local");
    await expect(contagem(page)).toHaveText("1 linha encontrada neste resultado.");
    await expect(linhaDe(page, "BRJ100AAAA")).toBeVisible();
    await busca.fill("");
    await expect(contagem(page)).toHaveText("6 linhas para conferência neste resultado.");

    const tipo = barra(page).locator("[data-history-filter-category]");
    await tipo.selectOption("divergencias_local");
    await expect(contagem(page)).toHaveText("2 linhas encontradas neste resultado.");
    await expect(linhaDe(page, "BRJ100DDDD")).toBeVisible();
    await expect(linhaDe(page, "BRJ100EEEE")).toBeVisible();
    await expect(linhaDe(page, "BRJ100AAAA")).toHaveCount(0);
    await tipo.selectOption("sem_correspondencia");
    await expect(contagem(page)).toHaveText("3 linhas encontradas neste resultado.");
    await tipo.selectOption("");
    await expect(contagem(page)).toHaveText("6 linhas para conferência neste resultado.");

    await barra(page).locator("[data-history-filter-annotated]").check();
    await expect(contagem(page)).toHaveText("1 linha encontrada neste resultado.");
    await expect(linhaDe(page, "BRJ100AAAA")).toBeVisible();
    await expect(linhaDe(page, "BRJ100BBBB")).toHaveCount(0);
    await barra(page).locator("[data-history-filter-annotated]").uncheck();
    await expect(contagem(page)).toHaveText("6 linhas para conferência neste resultado.");
  });

  test("Comparação: ir para uma seção escondida pelo filtro limpa os filtros", async ({ page }) => {
    await preparar(page);
    await abrirResumo(page);
    const irPara = id => page.evaluate(sec => window.irParaSecaoComparacao(sec), id);

    await barra(page).locator("[data-history-filter-search]").fill("zzzz");
    await expect(titulo(page, "comparacao-secao-localidade-divergente")).toBeHidden();
    expect(await irPara("comparacao-secao-localidade-divergente")).toBe(true);
    await expect(barra(page).locator("[data-history-filter-search]")).toHaveValue("");
    await expect(contagem(page)).toHaveText("6 linhas para conferência neste resultado.");
    await expect(titulo(page, "comparacao-secao-localidade-divergente")).toBeInViewport();

    await barra(page).locator("[data-history-filter-annotated]").check();
    await barra(page).locator("[data-history-filter-category]").selectOption("sem_correspondencia");
    await expect(titulo(page, "comparacao-secao-series-sem-local")).toBeHidden();
    expect(await irPara("comparacao-secao-series-sem-local")).toBe(true);
    await expect(barra(page).locator("[data-history-filter-annotated]")).not.toBeChecked();
    await expect(barra(page).locator("[data-history-filter-category]")).toHaveValue("");
    await expect(titulo(page, "comparacao-secao-series-sem-local")).toBeInViewport();

    // De outra sub-aba, a seção abre a sub-aba dela.
    await irParaAba(page, "usuarios");
    expect(await irPara("comparacao-secao-ausentes-endpoint")).toBe(true);
    await expect(page.locator("#resumo-aba-divergencias")).toHaveAttribute("aria-selected", "true");
    await expect(titulo(page, "comparacao-secao-ausentes-endpoint")).toBeInViewport();

    expect(await irPara("secao-que-nao-existe")).toBe(false);
  });

  test("Comparação: abrir pela série leva à sub-aba e à linha", async ({ page }) => {
    await preparar(page);
    await page.evaluate(() => window.abrirComparacaoDaSerie("BRJ100HHHH", "sem_acesso_7_dias"));
    await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
    await expect(page.locator("#resumo-aba-sem-acesso")).toHaveAttribute("aria-selected", "true");
    await expect(linhaDe(page, "BRJ100HHHH")).toBeInViewport();

    await page.evaluate(() => window.abrirComparacaoDaSerie("BRJ100DDDD"));
    await expect(page.locator("#resumo-aba-divergencias")).toHaveAttribute("aria-selected", "true");
    await expect(linhaDe(page, "BRJ100DDDD")).toBeInViewport();

    await page.evaluate(() => window.abrirComparacaoDaSerie("BRJ100LLLL", "mudancas_usuarios"));
    await expect(page.locator("#resumo-aba-usuarios")).toHaveAttribute("aria-selected", "true");
    await expect(linhaDe(page, "BRJ100LLLL")).toBeInViewport();
  });

  test("Comparação: trocar a comparação no seletor", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirResumo(page);
    const seletor = page.locator("#cockpit-comparison-event");
    await seletor.selectOption("ev-bf3-b");
    await expect(page.locator("#cockpit-comparison-status")).toHaveText(`Atualização · ${CURTO_ANTERIOR}`, interno);
    await expect(page.locator("#resumo-aba-divergencias")).toHaveText("Divergências 1", interno);
    // Trocar de comparação volta o Resumo à Visão Geral (limparAbasResumo); a lista é reaberta pela aba.
    await irParaAba(page, "divergencias");
    await expect(linhaDe(page, "BRJ200AAAA")).toBeVisible();
    await expect(linhaDe(page, "BRJ100DDDD")).toHaveCount(0);
    expect(chamadasDe(ambiente, "GET", "/api/historico-comparacoes/ev-bf3-b")).toHaveLength(1);

    await seletor.selectOption("ev-bf3-a");
    await expect(page.locator("#cockpit-comparison-status")).toHaveText(`Atualização · ${CURTO_ATUAL}`, interno);
    await expect(page.locator("#resumo-aba-divergencias")).toHaveText("Divergências 6", interno);
    await irParaAba(page, "divergencias");
    await expect(linhaDe(page, "BRJ100DDDD")).toBeVisible();
    expect(escritas(ambiente)).toEqual([]);
  });

  test("Comparação: histórico vazio mostra o aviso e a seção Sem usuário", async ({ page }) => {
    await preparar(page, { eventos: [] });
    await abrirResumo(page);
    await expect(page.locator("#comparacao-planilhas-conteudo")).toContainText("Não há comparação de inventários disponível neste histórico.");
    await expect(page.locator("#cockpit-comparison-event")).toBeDisabled();
    await expect(page.locator('[data-sem-usuario-section="ok"]')).toBeVisible();
    await expect(page.locator('[data-sem-usuario-section="ok"]')).toContainText("PRSEMUSU001");
    await expect(page.locator('[data-sem-usuario-section="ok"]')).toContainText("PRSEMUSU003");
  });

  test("Comparação: seção Sem usuário com notebooks", async ({ page }) => {
    await preparar(page);
    await abrirResumo(page);
    await irParaAba(page, "usuarios");
    const secao = page.locator('[data-sem-usuario-section="ok"]');
    await expect(secao).toBeVisible();
    await expect(secao.locator("tbody tr")).toHaveCount(3);
    await expect(secao.locator("thead th")).toHaveText(["Hostname/Apelido", "Série", "Local", "Modelo"]);
    await expect(secao.locator("tbody tr").first()).toContainText("PRSEMUSU001");
    await expect(secao.locator("tbody tr").first()).toContainText("BRJ300AAAA");
    await expect(secao.locator("tbody tr").first()).toContainText("Curitiba");
    await expect(secao.locator("tbody tr").first()).toContainText("Modelo de teste A");
  });

  test("Comparação: seção Sem usuário sem nenhum notebook", async ({ page }) => {
    await preparar(page, { semUsuario: { modo: "vazio", itens: [] } });
    await abrirResumo(page);
    await irParaAba(page, "usuarios");
    await expect(page.locator('[data-sem-usuario-section="ok"]')).toContainText("Todos os notebooks do cadastro têm usuário.");
    await expect(page.locator('[data-sem-usuario-section="ok"] tbody tr[data-comparison-serial]')).toHaveCount(0);
  });

  test("Comparação: seção Sem usuário com limite de linhas", async ({ page }) => {
    await preparar(page, { semUsuario: { modo: "limite", itens: [] } });
    await abrirResumo(page);
    await irParaAba(page, "usuarios");
    const secao = page.locator('[data-sem-usuario-section="limite"]');
    await expect(secao).toBeVisible();
    await expect(secao).toContainText("Mostrando os primeiros 20 de 2.500 notebooks sem usuário; há mais no cadastro. Use o filtro \"Sem usuário\" da Home para ver todos.");
  });

  test("Comparação: seção Sem usuário com erro na consulta", async ({ page }) => {
    await preparar(page, { semUsuario: { modo: "erro", itens: [] } });
    await abrirResumo(page);
    await irParaAba(page, "usuarios");
    const secao = page.locator('[data-sem-usuario-section="erro"]');
    await expect(secao).toBeVisible();
    await expect(secao).toContainText("Não foi possível consultar os notebooks sem usuário agora. Abra o Resumo de novo para tentar outra vez.");
    // O resto do resultado continua inteiro.
    await irParaAba(page, "divergencias");
    await expect(titulo(page, "comparacao-secao-localidade-divergente")).toBeVisible();
  });

  // ---------- Salvamento automático das anotações ----------

  const URL_ANOTACAO = "/api/historico-comparacoes/ev-bf3-a/anotacoes/ausente-endpoint-2";
  const abrirAnotacao = async page => {
    await abrirResumo(page);
    const campo = anotacaoDe(page, "ausente-endpoint-2");
    await expect(campo).toBeVisible();
    return campo;
  };

  test("Anotação: digitar salva e mostra o estado de cada etapa", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirResumo(page);
    await expect(estadoDaAnotacao(anotacaoDe(page, "ausente-endpoint-1"))).toHaveText("Salvo automaticamente");
    const campo = anotacaoDe(page, "ausente-endpoint-2");
    await expect(campo).toBeVisible();

    const portao = ambiente.segurar("anotacao");
    await campo.fill("Nota sintética um.");
    await expect(estadoDaAnotacao(campo)).toHaveText("Salvando...");
    portao.liberar();
    await expect(estadoDaAnotacao(campo)).toHaveText("Salvo automaticamente");
    await expect(tentarDeNovo(campo)).toBeHidden();
    const primeiro = chamadasDe(ambiente, "PUT", URL_ANOTACAO);
    expect(primeiro).toHaveLength(1);
    expect(corpoDe(primeiro[0])).toMatchObject({ anotacao: "Nota sintética um." });
    expect(typeof corpoDe(primeiro[0]).revisao_id).toBe("string");

    await campo.fill("Nota sintética dois.");
    await expect(estadoDaAnotacao(campo)).toHaveText("Salvo automaticamente");
    const todos = chamadasDe(ambiente, "PUT", URL_ANOTACAO);
    expect(todos).toHaveLength(2);
    expect(corpoDe(todos[1])).toMatchObject({ anotacao: "Nota sintética dois.", base_revisoes: [corpoDe(todos[0]).revisao_id] });
    expect(escritas(ambiente).every(chamada => chamada.metodo === "PUT")).toBe(true);
  });

  test("Anotação: conflito 409 mostra a mensagem, não tenta de novo e oferece tentar de novo", async ({ page }) => {
    const ambiente = await preparar(page, { anotacao: { modo: "409" } });
    const campo = await abrirAnotacao(page);
    await campo.fill("Nota que conflita.");
    await expect(estadoDaAnotacao(campo)).toHaveText("A anotação mudou em outro lugar. Atualize o resultado antes de salvar.");
    await expect(tentarDeNovo(campo)).toBeVisible();
    await assentar(page);
    expect(chamadasDe(ambiente, "PUT", URL_ANOTACAO)).toHaveLength(1);

    ambiente.anotacao.modo = "ok";
    await tentarDeNovo(campo).click();
    await expect(estadoDaAnotacao(campo)).toHaveText("Salvo automaticamente");
    await expect(tentarDeNovo(campo)).toBeHidden();
    expect(chamadasDe(ambiente, "PUT", URL_ANOTACAO)).toHaveLength(2);
  });

  test("Anotação: falha 5xx tenta três vezes, mostra o erro e deixa tentar de novo", async ({ page }) => {
    const ambiente = await preparar(page, { anotacao: { modo: "503" } });
    const campo = await abrirAnotacao(page);
    await campo.fill("Nota com servidor fora.");
    await expect(estadoDaAnotacao(campo)).toHaveText(/^Falha temporária\. Tentando salvar novamente \(3\/3\)\.\.\.$/, { timeout: 10_000 });
    await expect(estadoDaAnotacao(campo)).toHaveText("Serviço temporariamente indisponível.", { timeout: 10_000 });
    await expect(tentarDeNovo(campo)).toBeVisible();
    expect(chamadasDe(ambiente, "PUT", URL_ANOTACAO)).toHaveLength(4);

    ambiente.anotacao.modo = "ok";
    await tentarDeNovo(campo).click();
    await expect(estadoDaAnotacao(campo)).toHaveText("Salvo automaticamente");
    await expect(tentarDeNovo(campo)).toBeHidden();
    expect(chamadasDe(ambiente, "PUT", URL_ANOTACAO)).toHaveLength(5);
  });

  test("Anotação: falha de rede mostra a mensagem de conexão e deixa tentar de novo", async ({ page }) => {
    const ambiente = await preparar(page, { anotacao: { modo: "abortar" } });
    const campo = await abrirAnotacao(page);
    await campo.fill("Nota sem rede.");
    await expect(estadoDaAnotacao(campo)).toHaveText("Falha de conexão após três tentativas. Tente novamente.", { timeout: 12_000 });
    await expect(tentarDeNovo(campo)).toBeVisible();
    expect(chamadasDe(ambiente, "PUT", URL_ANOTACAO)).toHaveLength(4);

    ambiente.anotacao.modo = "ok";
    await tentarDeNovo(campo).click();
    await expect(estadoDaAnotacao(campo)).toHaveText("Salvo automaticamente");
    expect(chamadasDe(ambiente, "PUT", URL_ANOTACAO)).toHaveLength(5);
  });

  test("Anotação: salvo só neste dispositivo, com sincronização pendente ou não", async ({ page }) => {
    const ambiente = await preparar(page, { anotacao: { modo: "pendente" } });
    const campo = await abrirAnotacao(page);
    await campo.fill("Nota com sincronização pendente.");
    await expect(estadoDaAnotacao(campo)).toHaveText("Salvo neste dispositivo; sincronização pendente");
    await expect(tentarDeNovo(campo)).toBeVisible();

    ambiente.anotacao.modo = "local";
    await campo.fill("Nota só neste dispositivo.");
    await expect(estadoDaAnotacao(campo)).toHaveText("Salvo neste dispositivo");
    await expect(tentarDeNovo(campo)).toBeHidden();
  });

  // ---------- Indicadores da Home: estatísticas e botão de exportar ----------

  test("Indicadores: números, rótulo e botão de exportar", async ({ page }) => {
    const ambiente = await preparar(page);
    await expect(page.locator("#stat-equipamentos")).toHaveText("1.250");
    await expect(page.locator("#stat-equipamentos-rotulo")).toHaveText("equipamentos");
    await expect(page.locator("#stat-unidades")).toHaveText("5");
    await abrirResumo(page, { aba: "apelidos" });
    const exportar = page.locator("#btn-exportar-equipamentos");
    await expect(exportar).toBeVisible();
    await expect(exportar).toHaveAttribute("title", "Baixar a planilha com apelidos e IdCliente atualizados");

    // Sem alteração para exportar: o botão some.
    ambiente.stats = { status: 200, json: { ...STATS_BASE, total_alteracoes_exportaveis: 0 } };
    await alternarHostname(page, ambiente);
    await expect(exportar).toBeHidden();

    // Contagem indisponível: o botão fica e explica o motivo.
    ambiente.stats = { status: 200, json: { ...STATS_BASE, exportacao_disponivel: false, exportacao_motivo: "Modelo de exportação ausente." } };
    await alternarHostname(page, ambiente);
    await expect(exportar).toBeVisible();
    await expect(exportar).toHaveAttribute("title", "Contagem indisponível: Modelo de exportação ausente.");

    ambiente.stats = { status: 200, json: { ...STATS_BASE, exportacao_disponivel: false } };
    await alternarHostname(page, ambiente);
    await expect(exportar).toHaveAttribute("title", "Contagem indisponível: clique para verificar a exportação");

    ambiente.stats = { status: 200, json: { ...STATS_BASE, total_equipamentos: 1, total_unidades: 1 } };
    await alternarHostname(page, ambiente);
    await expect(page.locator("#stat-equipamentos")).toHaveText("1");
    await expect(page.locator("#stat-equipamentos-rotulo")).toHaveText("equipamento");
    await expect(page.locator("#stat-unidades")).toHaveText("1");
  });

  // Comportamento do legado a preservar: com 500 os dois números viram "0" (Number(null) === 0) e a
  // bolinha da base vira "empty"; "Indisponível" só aparece quando a resposta 200 não traz o número.
  test("Indicadores: 409 mantém os números, 500 zera e resposta sem número mostra Indisponível", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirResumo(page, { aba: "apelidos" });
    await expect(page.locator("#stat-equipamentos")).toHaveText("1.250");

    ambiente.stats = { status: 409, json: { detail: "Importação em andamento." } };
    await alternarHostname(page, ambiente);
    await assentar(page);
    await expect(page.locator("#stat-equipamentos")).toHaveText("1.250");
    await expect(page.locator("#stat-unidades")).toHaveText("5");
    await expect(page.locator("#stat-equipamentos-rotulo")).toHaveText("equipamentos");

    ambiente.stats = { status: 500, json: { detail: "Falha simulada." } };
    await alternarHostname(page, ambiente);
    await expect(page.locator("#stat-equipamentos")).toHaveText("0");
    await expect(page.locator("#stat-unidades")).toHaveText("0");
    await expect(page.locator("#stat-base-dot")).toHaveAttribute("data-state", "empty");

    ambiente.stats = { status: 200, json: {} };
    await alternarHostname(page, ambiente);
    await expect(page.locator("#stat-equipamentos")).toHaveText("Indisponível");
    await expect(page.locator("#stat-unidades")).toHaveText("Indisponível");

    ambiente.stats = { status: 200, json: { ...STATS_BASE, total_equipamentos: 1300 } };
    await alternarHostname(page, ambiente);
    await expect(page.locator("#stat-equipamentos")).toHaveText("1.300");
    await expect(page.locator("#stat-unidades")).toHaveText("5");
    await expect(page.locator("#stat-base-dot")).toHaveAttribute("data-state", "ready");
  });

  // ---------- Prontidão ----------

  const PAINEL_PRONTIDAO = "#readiness-panel";
  const resumoCurto = page => page.locator("#readiness-summary-short");
  const resumoLongo = page => page.locator("#readiness-summary");
  const abrirProntidao = async page => {
    if (!(await page.locator("#readiness-content").isVisible())) await page.locator(`${PAINEL_PRONTIDAO} summary`).click();
    await expect(page.locator("#readiness-content")).toBeVisible();
  };
  const arquivosFaltando = chaves => ({ status: 200, json: prontidao({ faltando: chaves }) });

  test("Prontidão: tudo disponível", async ({ page }) => {
    await preparar(page);
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "ready");
    await expect(resumoCurto(page)).toHaveText("Tudo disponível");
    await expect(resumoLongo(page)).toHaveText("Todos os 5 arquivos estão disponíveis.");
    await expect(page.locator("#readiness-content")).toBeHidden();
    await abrirProntidao(page);
    await expect(page.locator("li.ck-pront__item")).toHaveText([
      "Inventários Em dia · Planilha de equipamentos da Simpress Atualizar",
      "OS Em dia · Exportação de OS Oracle Abrir",
      "Modelo de exportação Em dia · Planilha-modelo usada nas exportações Atualizar",
      "Regionais Em dia · 5 regionais cadastradas Editar",
      "Saúde local Disco, arquivos de estado e temporários Abrir",
    ], interno);
    await expect(page.locator("li.ck-pront__item[data-status='ok']")).toHaveCount(4);
    await expect(page.locator("#ckp-progresso-texto")).toHaveText("4 de 4");
    await page.locator("#readiness-fechar").click();
    await expect(page.locator("#readiness-content")).toBeHidden();
  });

  test("Prontidão: pendências aparecem, mudam e somem a cada atualização", async ({ page }) => {
    const ambiente = await preparar(page);
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "ready");

    await atualizarProntidao(page, ambiente, arquivosFaltando(["inventario_endpoint"]));
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "warning");
    await expect(resumoCurto(page)).toHaveText("1 pendente");
    await expect(resumoLongo(page)).toHaveText("4 de 5 arquivos disponíveis. Confira os detalhes abaixo.");

    await atualizarProntidao(page, ambiente, arquivosFaltando(["inventario_endpoint", "modelo_exportacao"]));
    await expect(resumoCurto(page)).toHaveText("2 pendentes");
    await expect(resumoLongo(page)).toHaveText("3 de 5 arquivos disponíveis. Confira os detalhes abaixo.");
    await abrirProntidao(page);
    await expect(page.locator("#readiness-inventario")).toHaveAttribute("data-status", "pendente");
    await expect(page.locator("#readiness-inventario")).toHaveText("Inventários Pendente · Planilha de equipamentos da Simpress Importar", interno);
    await expect(page.locator("#readiness-modelo-exportacao")).toHaveText("Modelo de exportação Pendente · Planilha-modelo usada nas exportações Importar", interno);
    await expect(page.locator("#readiness-chamados")).toHaveAttribute("data-status", "ok");
    await expect(page.locator("#ckp-progresso-texto")).toHaveText("2 de 4");

    await atualizarProntidao(page, ambiente, arquivosFaltando(ARQUIVOS_PRONTIDAO));
    await expect(resumoCurto(page)).toHaveText("5 pendentes");
    await expect(resumoLongo(page)).toHaveText("Nenhum dos 5 arquivos está disponível. Confira os detalhes abaixo.");
    await expect(page.locator("#readiness-chamados")).toHaveAttribute("data-status", "pendente");

    await atualizarProntidao(page, ambiente, { status: 200, json: prontidao() });
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "ready");
    await expect(resumoCurto(page)).toHaveText("Tudo disponível");
    await expect(page.locator("li.ck-pront__item[data-status='ok']")).toHaveCount(4);
  });

  test("Prontidão: arquivo inválido e configuração local", async ({ page }) => {
    const json = prontidao({ extra: { configuracao_local: { state: "ready", assistente_ia: false } } });
    json.files.modelo_exportacao = { available: false, state: "invalid", reason: "Planilha-modelo com colunas ausentes." };
    const ambiente = await preparar(page, { prontidao: { status: 200, json } });
    await abrirProntidao(page);
    await expect(page.locator("#readiness-modelo-exportacao")).toHaveAttribute("data-status", "invalido");
    await expect(page.locator("#readiness-modelo-exportacao")).toHaveText("Modelo de exportação Inválido · Planilha-modelo com colunas ausentes. Importar", interno);
    await expect(page.locator("#readiness-configuracao-local")).toHaveAttribute("data-status", "ok");
    await expect(page.locator("#readiness-configuracao-local")).toHaveText("Configuração local Em dia · Contas, links e dados do cliente configurados Assistente sem IA Configurar", interno);

    await atualizarProntidao(page, ambiente, { status: 200, json: prontidao({ extra: { configuracao_local: { state: "missing", reason: "Preencha as contas e os links." } } }) });
    await expect(page.locator("#readiness-configuracao-local")).toHaveAttribute("data-status", "pendente");
    await expect(page.locator("#readiness-configuracao-local")).toHaveText("Configuração local Pendente · Preencha as contas e os links. Configurar", interno);
    await expect(page.locator("#ckp-progresso-texto")).toHaveText("4 de 5");
  });

  test("Prontidão: modo leitura com gravação bloqueada", async ({ page }) => {
    await preparar(page, { prontidao: { status: 200, json: prontidao({ extra: { gravacao_bloqueada: { available: false } } }) } });
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "warning");
    await expect(resumoCurto(page)).toHaveText("Modo leitura");
    await expect(resumoLongo(page)).toHaveText("Modo leitura: uma gravação interrompida precisa de conferência. Confira os detalhes abaixo.");
    await abrirProntidao(page);
    await expect(page.locator("#readiness-gravacao-bloqueada")).toHaveAttribute("data-status", "invalido");
    await expect(page.locator("#readiness-gravacao-bloqueada")).toHaveText("Gravações bloqueadas Inválido · Importações e edições aguardam a conferência; a consulta continua disponível.", interno);
  });

  test("Prontidão: erro ao consultar e recuperação", async ({ page }) => {
    const ambiente = await preparar(page, { prontidao: { status: 500, json: { detail: "Falha simulada." } } });
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "error");
    await expect(resumoCurto(page)).toHaveText("Indisponível");
    await expect(resumoLongo(page)).toHaveText("Não foi possível consultar a disponibilidade das funções.");
    await abrirProntidao(page);
    await expect(page.locator("li.ck-pront__vazio")).toHaveText("Confira se o servidor está em execução e recarregue a página para tentar novamente.");

    // Resposta sem as listas esperadas também é erro.
    await atualizarProntidao(page, ambiente, { status: 200, json: {} });
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "error");
    await expect(resumoLongo(page)).toHaveText("Não foi possível consultar a disponibilidade das funções.");

    await atualizarProntidao(page, ambiente, { status: 200, json: prontidao() });
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "ready");
    await expect(resumoCurto(page)).toHaveText("Tudo disponível");
    await expect(page.locator("li.ck-pront__vazio")).toHaveCount(0);
    await expect(page.locator("li.ck-pront__item")).toHaveCount(5);
  });

  test("Prontidão: servidor desconectado e volta ao normal", async ({ page }) => {
    const ambiente = await preparar(page);
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "ready");
    await expect(page.locator("#stat-base-dot")).toHaveAttribute("data-state", "ready");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("simpress:servidor-offline")));
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "error");
    await expect(resumoLongo(page)).toHaveText("Servidor desconectado. Abra iniciar_servidor.bat para continuar.");
    await expect(resumoCurto(page)).toHaveText("Offline");
    await expect(page.locator(`${PAINEL_PRONTIDAO} summary`)).toHaveAttribute("title", "Servidor desconectado. Verifique se iniciar_servidor.bat está em execução.");
    await expect(page.locator("#stat-base-dot")).toHaveAttribute("data-state", "empty");

    await atualizarProntidao(page, ambiente, { status: 200, json: prontidao() });
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "ready");
    await expect(resumoCurto(page)).toHaveText("Tudo disponível");
    await expect(resumoLongo(page)).toHaveText("Todos os 5 arquivos estão disponíveis.");
  });

  // ---------- Alertas: sino (5 cartões) e base desatualizada ----------

  const ALERTAS_UNICOS = [
    {
      id: "alerta-sem-acesso-60", extra: { sem_acesso_60_dias: ALERTAS.visiveis.sem_acesso_60_dias },
      selo: "Urgente", titulo: "Passou de 60 dias sem acesso", acao: "Ver Resumo",
      texto: "2 notebooks/MacBooks passaram de 60 dias sem acesso. 1 já saiu da lista e foi para Ausentes no Endpoint. 1 notebook/MacBook está no limite, com mais de 55 dias sem acesso.",
      lista: ["BRJ111AAAA · PRNOTE001 — 72 dias", "BRJ222BBBB · PRNOTE002 — ~61 dias (saiu para Ausentes no Endpoint)", "BRJ333CCCC · PRNOTE003 — 57 dias"],
    },
    {
      id: "alerta-os-paradas", extra: { os_paradas: ALERTAS.visiveis.os_paradas },
      selo: "Urgente", titulo: "OS paradas", acao: "Ver OS",
      texto: "3 chamados abertos estão sem atualização há 7 dias ou mais. O mais antigo está parado há 21 dias.", lista: [],
    },
    {
      id: "alerta-divergencias-novas", extra: { divergencias_novas: ALERTAS.visiveis.divergencias_novas },
      selo: "Atenção", titulo: "Divergências novas", acao: "Ver evolução",
      texto: "A comparação de 18/10/2026 às 09:00 trouxe 5 linhas de divergência que não estavam na de 11/10/2026 às 08:00: 3 em Localidade divergente e 2 em Séries sem local definido.", lista: [],
    },
    {
      id: "alerta-hostnames-atualizados",
      extra: { hostnames_atualizados: { total: 1, itens: [{ serie: "BRJ100GGGG", hostname_anterior: "PRNOTE109", hostname_novo: "PRNOTE108" }] } },
      selo: "Atenção", titulo: "Hostname atualizado pelo Endpoint", acao: "BRJ100GGGG: PRNOTE109 → PRNOTE108",
      texto: "1 série mudou de hostname. Clique na série para ver na Comparação, aba Apelidos.", lista: ["BRJ100GGGG: PRNOTE109 → PRNOTE108"],
    },
    {
      id: "alerta-chamados-outro-tecnico",
      extra: { chamados_outro_tecnico: { total: 2, itens: [{ chamado: "UTIC-2026-1378", serie: "BRJ444DDDD", os: "7285070", motivo: "saiu_do_dashboard" }, { chamado: "UTIC-2026-1379", serie: "BRJ555EEEE", os: "7285071", motivo: "nao_encontrado_softexpert" }] } },
      selo: "Atenção", titulo: "Chamados finalizados por outro técnico", acao: "Ver na aba OS",
      texto: "Confira no SoftExpert e marque Conferido na aba OS (F6).", lista: [],
    },
    {
      id: "alerta-finalizacao-softexpert",
      extra: { falhas_finalizacao_softexpert: { total: 2, itens: [{ numero: "UTIC-2026-1380", motivo: "tempo_esgotado" }, { numero: "", motivo: "interrompida" }] } },
      selo: "Urgente", titulo: "Falha ao finalizar no SoftExpert", acao: "Ver na aba Chamados",
      texto: "1 chamado não foi finalizado no SoftExpert: UTIC-2026-1380 (tempo esgotado). A finalização parou no meio (tempo esgotado ou rotina encerrada). Confira no SoftExpert se o chamado já foi finalizado antes de tentar de novo.",
      lista: [],
    },
    {
      id: "alerta-backups-regionais", extra: { backups_regionais: { indisponivel: false, pendencias: { sem_backup: ["Londrina"], conferir: ["Maringá"] } } },
      selo: "Urgente", titulo: "Sem backup disponível", acao: "Ver backups no Resumo",
      texto: "1 regional está sem backup disponível. 1 regional tem possível backup para conferir.", lista: ["Londrina — sem backup disponível", "Maringá — conferir possível backup"],
    },
  ];

  test("Alertas: cada cartão do sino aparece com os dados dele e some", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirSino(page);
    await expect(page.locator("#notification-center-summary")).toHaveText("Nenhum aviso ativo.");
    for (const { id } of ALERTAS_UNICOS) await expect(page.locator(`#${id}`)).toBeHidden();
    await expect(page.locator("#badge-notificacoes")).toBeHidden();

    for (const alerta of ALERTAS_UNICOS) {
      await atualizarPainel(page, ambiente, painel(alerta.extra));
      const cartao = page.locator(`#${alerta.id}`);
      await expect(cartao).toBeVisible();
      await expect(cartao).toContainText(alerta.selo, interno);
      await expect(cartao).toContainText(alerta.titulo, interno);
      await expect(cartao).toContainText(alerta.texto, interno);
      await expect(cartao).toContainText(alerta.acao, interno);
      if (alerta.lista.length) await expect(page.locator(`#${alerta.id}-lista li`)).toHaveText(alerta.lista);
      for (const outro of ALERTAS_UNICOS.filter(item => item.id !== alerta.id)) await expect(page.locator(`#${outro.id}`)).toBeHidden();
      await expect(page.locator("#notification-center-summary")).toHaveText("1 aviso ativo.");
      await expect(page.locator("#notification-center-title")).toHaveText("Pendências · 1");
      await expect(page.locator("#badge-notificacoes")).toHaveText("1");

      await atualizarPainel(page, ambiente, painel());
      await expect(cartao).toBeHidden();
      await expect(page.locator("#notification-center-summary")).toHaveText("Nenhum aviso ativo.");
      await expect(page.locator("#badge-notificacoes")).toBeHidden();
    }
    expect(escritas(ambiente)).toEqual([]);
  });

  test("Alertas: clicar na série do aviso de hostname abre a Comparação em Apelidos e realça a linha", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirSino(page);
    await atualizarPainel(page, ambiente, painel({ hostnames_atualizados: { total: 1, itens: [{ serie: "BRJ100GGGG", hostname_anterior: "PRNOTE109", hostname_novo: "PRNOTE108" }] } }));
    await page.locator('#alerta-hostnames-atualizados-lista button[data-serie="BRJ100GGGG"]').click();
    await expect(page.locator("#notification-center-panel")).toBeHidden();
    await expect(page.locator("#resumo-aba-apelidos")).toHaveAttribute("aria-selected", "true");
    const linha = linhaDe(page, "BRJ100GGGG");
    await expect(linha).toBeInViewport();
    await expect(linha).toHaveClass(/ck-linha-destaque/);
    // A linha da duplicidade marca o hostname da verificação mais recente, e só ele.
    await expect(linha.locator('li[data-hostname-nome="PRNOTE108"] [data-hostname-aplicado]')).toHaveText("Aplicado (verificação mais recente)");
    await expect(linha.locator("[data-hostname-aplicado]")).toHaveCount(1);
    expect(escritas(ambiente)).toEqual([]);
  });

  test("Alertas: todos juntos, contagem do sino e variantes de gravidade", async ({ page }) => {
    const ambiente = await preparar(page, { painel: painelComAlertas() });
    await abrirSino(page);
    await expect(page.locator("#notification-center-summary")).toHaveText("5 avisos ativos.");
    await expect(page.locator("#notification-center-title")).toHaveText("Pendências · 5");
    await expect(page.locator("#badge-notificacoes")).toHaveText("5");
    // painelComAlertas fica sem falha de finalização (a foto central-avisos segue a mesma); ela entra só aqui e soma um aviso.
    // O aviso de hostname atualizado também entra só aqui (mesma razão).
    const FALHA = ALERTAS_UNICOS.find(alerta => alerta.id === "alerta-finalizacao-softexpert");
    const HOST = ALERTAS_UNICOS.find(alerta => alerta.id === "alerta-hostnames-atualizados");
    for (const { id } of ALERTAS_UNICOS.filter(alerta => alerta !== FALHA && alerta !== HOST)) await expect(page.locator(`#${id}`)).toBeVisible();
    await expect(page.locator(`#${FALHA.id}`)).toBeHidden();
    await expect(page.locator(`#${HOST.id}`)).toBeHidden();
    await atualizarPainel(page, ambiente, painelComAlertas({ ...FALHA.extra, ...HOST.extra }));
    await expect(page.locator(`#${FALHA.id}`)).toBeVisible();
    await expect(page.locator(`#${HOST.id}`)).toBeVisible();
    await expect(page.locator("#notification-center-summary")).toHaveText("7 avisos ativos.");
    await expect(page.locator("#badge-notificacoes")).toHaveText("7");

    // Sem acesso: no limite (sem ninguém acima de 60 dias) vira Atenção.
    await atualizarPainel(page, ambiente, painelComAlertas({
      sem_acesso_60_dias: { ...ALERTAS.visiveis.sem_acesso_60_dias, estado: "limite_55", total_passou: 0, total_saiu_endpoint: 0, maior_dias: 57, equipamentos: [ALERTAS.visiveis.sem_acesso_60_dias.equipamentos[2]] },
    }));
    const semAcesso = page.locator("#alerta-sem-acesso-60");
    await expect(semAcesso).toContainText("Atenção", interno);
    await expect(semAcesso).toContainText("Perto de 60 dias sem acesso", interno);
    await expect(semAcesso).toContainText("1 notebook/MacBook está no limite, com mais de 55 dias sem acesso.", interno);
    await expect(page.locator("#alerta-sem-acesso-60-lista li")).toHaveText(["BRJ333CCCC · PRNOTE003 — 57 dias"]);

    // Backups: só "conferir" vira Atenção.
    await atualizarPainel(page, ambiente, painelComAlertas({ backups_regionais: { indisponivel: false, pendencias: { sem_backup: [], conferir: ["Maringá", "Cascavel"] } } }));
    const backups = page.locator("#alerta-backups-regionais");
    await expect(backups).toContainText("Atenção", interno);
    await expect(backups).toContainText("Conferir possível backup", interno);
    await expect(backups).toContainText("2 regionais têm possível backup para conferir.", interno);
    await expect(page.locator("#alerta-backups-regionais-lista li")).toHaveText(["Maringá — conferir possível backup", "Cascavel — conferir possível backup"]);

    // Leitura indisponível esconde o cartão em vez de mostrar alerta falso.
    await atualizarPainel(page, ambiente, painelComAlertas({ chamados_outro_tecnico: { indisponivel: true, total: 0, itens: [] }, backups_regionais: { indisponivel: true } }));
    await expect(page.locator("#alerta-chamados-outro-tecnico")).toBeHidden();
    await expect(backups).toBeHidden();
    await expect(page.locator("#notification-center-summary")).toHaveText("3 avisos ativos.");

    // Fechar e abrir o sino.
    await page.locator("#btn-notificacoes").click();
    await expect(page.locator("#notification-center-panel")).toBeHidden();
  });

  test("Alertas: base desatualizada, sem base e em dia", async ({ page }) => {
    const ambiente = await preparar(page);
    const alerta = page.locator("#alerta-base-desatualizada");
    await expect(alerta).toBeHidden();

    await atualizarPainel(page, ambiente, painel({ base_desatualizada: BASE.desatualizada }));
    await expect(alerta).toBeVisible();
    await expect(page.locator("#alerta-base-desatualizada-titulo")).toHaveText("Base desatualizada");
    await expect(page.locator("#alerta-base-desatualizada-texto")).toHaveText("A base na Simpress foi atualizada pela última vez em 08/10/2026 às 20:15, há 9 dias. O limite é de 7 dias.");
    await expect(page.locator("#btn-alerta-base-atualizar")).toHaveText("Atualizar base");

    await atualizarPainel(page, ambiente, painel({ base_desatualizada: BASE.sem_base }));
    await expect(page.locator("#alerta-base-desatualizada-titulo")).toHaveText("Base não encontrada");
    await expect(page.locator("#alerta-base-desatualizada-texto")).toHaveText("Nenhuma base na Simpress foi importada. Importe as planilhas para consultar e comparar equipamentos.");
    await expect(page.locator("#btn-alerta-base-atualizar")).toHaveText("Importar base");

    await atualizarPainel(page, ambiente, painel({ base_desatualizada: BASE.atualizada }));
    await expect(alerta).toBeHidden();
    expect(escritas(ambiente)).toEqual([]);
  });

  // ---------- Corridas: resposta atrasada não pode sobrescrever a mais nova ----------

  test("Corrida: resposta antiga de /api/prontidao não sobrescreve a nova", async ({ page }) => {
    const ambiente = await preparar(page, { prontidao: arquivosFaltando(["inventario_endpoint"]) });
    await expect(resumoCurto(page)).toHaveText("1 pendente");

    // A primeira consulta fica presa com a resposta ANTIGA (tudo disponível); a segunda traz a nova (2 pendentes).
    const portao = ambiente.segurar("prontidao");
    await atualizarProntidao(page, ambiente, { status: 200, json: prontidao() });
    await atualizarProntidao(page, ambiente, arquivosFaltando(["inventario_endpoint", "modelo_exportacao"]));
    await expect(resumoCurto(page)).toHaveText("2 pendentes");
    portao.liberar();
    await assentar(page);
    await expect(page.locator(PAINEL_PRONTIDAO)).toHaveAttribute("data-state", "warning");
    await expect(resumoCurto(page)).toHaveText("2 pendentes");
    await expect(resumoLongo(page)).toHaveText("3 de 5 arquivos disponíveis. Confira os detalhes abaixo.");
  });

  test("Remover mais antigo: confirma nomeando o hostname, envia confirmado e incerto não marca a linha", async ({ page }) => {
    const ambiente = await preparar(page, { remocaoEndpoint: { resultado: "incerto", gravado_local: false, mensagem: "Confira no Endpoint." } });
    await abrirResumo(page, { aba: "apelidos" });
    const remover = page.locator("#comparacao-planilhas-conteudo [data-hostname-remove]:visible");
    await remover.click();
    const mensagem = page.locator("#mensagem-confirmar-acao");
    await expect(mensagem).toContainText("no Endpoint Central");
    await expect(mensagem).toContainText("não se desfaz pelo cockpit");
    const hostname = await page.locator("#comparacao-planilhas-conteudo [data-hostname-remove]:visible").evaluate(botao => botao.closest("[data-hostname-item]").dataset.hostnameNome);
    await expect(mensagem).toContainText(hostname);
    // Cancelar no diálogo não chama a API.
    await page.locator("#btn-confirmar-acao-cancelar").click();
    const rota = "/api/endpoint/hostnames-removidos/remover-no-endpoint";
    await assentar(page);
    expect(chamadasDe(ambiente, "POST", rota)).toHaveLength(0);
    await remover.click();
    await confirmar(page);
    await expect.poll(() => chamadasDe(ambiente, "POST", rota).length).toBe(1);
    expect(corpoDe(chamadasDe(ambiente, "POST", rota)[0])).toMatchObject({ hostname, confirmado: true });
    await expect(remover).toBeVisible();
    await expect(page.locator("#comparacao-planilhas-conteudo [data-hostname-restore]:visible")).toHaveCount(0);
  });

  test("Remover mais antigo pendente vira Gravar só no cockpit e chama só a rota local", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirResumo(page, { aba: "apelidos" });
    const remover = page.locator("#comparacao-planilhas-conteudo [data-hostname-remove]:visible");
    const item = remover.locator("xpath=ancestor::*[@data-hostname-item][1]");
    const serie = await item.getAttribute("data-hostname-serie");
    const hostname = await item.getAttribute("data-hostname-nome");
    // O servidor passa a informar o par como pendente (remoção incerta no Endpoint); a tela relê a lista.
    ambiente.pendentes = [{ serie, hostname, resultado: "incerto", em: "2026-11-27T10:00:00-03:00" }];
    ambiente.remocaoEndpoint = { resultado: "incerto", gravado_local: false, pendente: true, mensagem: "Confira no Endpoint." };
    await remover.click();
    await confirmar(page);
    await expect(remover).toHaveText("Gravar só no cockpit");
    await remover.click();
    await expect(page.locator("#mensagem-confirmar-acao")).toContainText("ficou pendente");
    await confirmar(page);
    await expect.poll(() => chamadasDe(ambiente, "POST", "/api/endpoint/hostnames-removidos").length).toBe(1);
    expect(chamadasDe(ambiente, "POST", "/api/endpoint/hostnames-removidos/remover-no-endpoint")).toHaveLength(1);
    await expect(page.locator("#comparacao-planilhas-conteudo [data-hostname-restore]:visible")).toHaveCount(1);
  });

  test("Corrida: resposta antiga de /api/stats não sobrescreve a nova", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirResumo(page);
    await expect(page.locator("#stat-equipamentos")).toHaveText("1.250");

    ambiente.stats = { status: 200, json: { ...STATS_BASE, total_equipamentos: 1111 } };
    const portao = ambiente.segurar("stats");
    await alternarHostname(page, ambiente);
    ambiente.stats = { status: 200, json: { ...STATS_BASE, total_equipamentos: 2222 } };
    await alternarHostname(page, ambiente);
    await expect(page.locator("#stat-equipamentos")).toHaveText("2.222");
    portao.liberar();
    await assentar(page);
    await expect(page.locator("#stat-equipamentos")).toHaveText("2.222");
    await expect(page.locator("#stat-equipamentos-rotulo")).toHaveText("equipamentos");
  });

  test("Corrida: detalhe antigo da Comparação não sobrescreve o mais novo", async ({ page }) => {
    const ambiente = await preparar(page);
    await abrirResumo(page);
    const seletor = page.locator("#cockpit-comparison-event");
    await expect(page.locator("#cockpit-comparison-status")).toHaveText(`Atualização · ${CURTO_ATUAL}`, interno);

    const portao = ambiente.segurar("detalhe-ev-bf3-b");
    await seletor.selectOption("ev-bf3-b");
    await expect.poll(() => chamadasDe(ambiente, "GET", "/api/historico-comparacoes/ev-bf3-b").length).toBe(1);
    await seletor.selectOption("ev-bf3-a");
    await expect(seletor).toHaveValue("ev-bf3-a");
    await expect(page.locator("#cockpit-comparison-status")).toHaveText(`Atualização · ${CURTO_ATUAL}`, interno);
    portao.liberar();
    await assentar(page);
    await assentar(page);
    await expect(page.locator("#cockpit-comparison-status")).toHaveText(`Atualização · ${CURTO_ATUAL}`, interno);
    await expect(page.locator("#resumo-aba-divergencias")).toHaveText("Divergências 6", interno);
    await expect(linhaDe(page, "BRJ200AAAA")).toHaveCount(0);
  });
});
