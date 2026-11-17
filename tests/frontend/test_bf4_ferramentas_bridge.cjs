// BF4: a ponte frontend/src/aplicacao/cockpit-tool-panels.ts só encaminha para window.SimpressReact["ferramentas-cockpit"].
// Dados sintéticos; a lógica dos painéis é testada em test_cockpit_tool_panels, test_cockpit_andamento e test_inline_equipment_edit.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const { criarFerramentasCockpit } = require("../../frontend/src/paineis/ferramentas-cockpit/estado.ts");
const criarPonteCockpit = require("../../frontend/src/aplicacao/registro.ts").fabricas.cockpitToolPanels;

const estadoTs = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/paineis/ferramentas-cockpit/estado.ts"), "utf8");
const MENSAGEM = 'O painel React "ferramentas-cockpit" não carregou.';
const ACOES = [
  "abrirPainelCockpit", "fecharPainelCockpit", "abrirComparacaoDaSerie", "abrirChamadosDoEquipamento", "abrirChamadoDaOs",
  "abrirJanelaChamadoOs", "abrirReferenciaLembrete", "fecharJanelaChamadoOs", "destacarLinhaCockpit", "filterTicketRecords",
  "mostrarResultadoNaAbaComparacao",
];
// Mesmos textos de renderError em estado.ts: a ponte não inventa texto novo.
const ERROS = {
  chamados: ["cockpit-tickets-os", "A tabela de ordens de serviço não está disponível."],
  comparacao: ["comparacao-planilhas-conteudo", "Não foi possível abrir a comparação."],
  apelidos: ["cockpit-alias-list", "Falha ao carregar o histórico."],
  relatorio: ["cockpit-monthly-estado", "Falha ao carregar o relatório."],
  planilhas: ["cockpit-sheets-kpis", "Não foi possível carregar as planilhas."],
};
const SEM_TEXTO = ["cobertura", "lembretes", "unidades", "sebrae-chamados"];

function criarPontes() {
  const chamadas = [];
  const ponteReact = () => { throw new Error("a ponte assíncrona não deve ser usada"); };
  const ponteReactSincrona = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
    chamadas.push({ painel, nome, argumentos });
    return `sync:${nome}`;
  }]));
  return { chamadas, ponteReact, ponteReactSincrona };
}

// Ponte real de aplicacao/app.ts: lê window.SimpressReact a cada chamada e registra o erro quando o painel não existe.
function ponteDoApp(erros) {
  return (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
    const acao = globalThis.window?.SimpressReact?.[painel]?.[nome];
    if (typeof acao !== "function") { erros.push(new Error(`O painel React "${painel}" não carregou.`)); return undefined; }
    return acao(...argumentos);
  }]));
}

function comJanela(janela, executar) {
  const antiga = Object.getOwnPropertyDescriptor(globalThis, "window");
  const antigoDocumento = Object.getOwnPropertyDescriptor(globalThis, "document");
  if (janela === undefined) delete globalThis.window; else globalThis.window = janela;
  try { return executar(); } finally {
    if (antiga) Object.defineProperty(globalThis, "window", antiga); else delete globalThis.window;
    if (antigoDocumento) Object.defineProperty(globalThis, "document", antigoDocumento); else delete globalThis.document;
  }
}

// toolInfo e toolKeys de estado.ts, lidos do código-fonte: a cópia da ponte tem de bater com o painel.
const avaliar = texto => new Function(`return (${texto});`)();
const toolKeysTs = avaliar(estadoTs.match(/const toolKeys[^=]*= (\{.*\});/)[1]);
const toolInfoTs = avaliar(estadoTs.match(/const toolInfo[^=]*= (\{[\s\S]*?\n  \});/)[1]);

// Casca mínima do index.html: skip-link, menu Ferramentas, botão da barra, tela principal e o painel fechado com título,
// atalho, subtítulo e uma seção por ferramenta (as que têm texto de erro com o alvo dele).
function montarCasca() {
  const doc = createFakeDocument();
  const filho = (pai, id, { hidden = false, tag = "div" } = {}) => {
    const no = doc.createElement(tag);
    if (id) no.setAttribute("id", id);
    no.hidden = hidden;
    pai.append(no);
    return no;
  };
  const skipLink = filho(doc.body, "", { tag: "a" });
  skipLink.className = "skip-link";
  skipLink.setAttribute("href", "#main-content");
  const gatilho = filho(doc.body, "cockpit-tools-trigger", { tag: "button" });
  const menu = filho(doc.body, "cockpit-tools-dropdown", { tag: "details" });
  menu.open = true;
  const botao = filho(doc.body, "", { tag: "button" });
  botao.className = "ck-aba ck-aba--painel";
  botao.setAttribute("data-cockpit-tool", "chamados");
  botao.dataset.cockpitTool = "chamados";
  botao.setAttribute("aria-pressed", "false");
  const principal = filho(doc.body, "main-content");
  const raiz = filho(doc.body, "cockpit-tool-panels", { hidden: true });
  const titulo = filho(raiz, "cockpit-tool-title", { tag: "h1" });
  const tecla = filho(raiz, "cockpit-tool-kbd", { tag: "kbd" });
  const subtitulo = filho(raiz, "cockpit-tool-subtitle");
  const secoes = {};
  const alvos = {};
  for (const ferramenta of [...Object.keys(ERROS), ...SEM_TEXTO]) {
    const secao = filho(raiz, "", { hidden: true });
    secao.setAttribute("data-cockpit-tool-panel", ferramenta);
    secao.dataset.cockpitToolPanel = ferramenta;
    secoes[ferramenta] = secao;
    if (ERROS[ferramenta]) alvos[ferramenta] = filho(secao, ERROS[ferramenta][0]);
  }
  const status = filho(secoes.planilhas, "cockpit-sheets-status");
  status.textContent = "Carregando…";
  const statusComparacao = filho(secoes.comparacao, "cockpit-comparison-status");
  statusComparacao.textContent = "Carregando histórico…";
  return { doc, principal, raiz, secoes, alvos, status, statusComparacao, skipLink, gatilho, menu, botao, titulo, tecla, subtitulo };
}

test("a ponte expõe as 11 ações e encaminha todas ao painel ferramentas-cockpit", () => {
  const pontes = criarPontes();
  const acoes = criarPonteCockpit(pontes);
  assert.deepEqual(Object.keys(acoes).sort(), [...ACOES].sort());
  // Todas existem de verdade no painel (estado.ts), que ainda devolve os helpers puros só para os testes.
  const painel = criarFerramentasCockpit({ app: {}, appState: {}, apiFetch: async () => ({}) });
  ACOES.forEach(nome => assert.equal(typeof painel[nome], "function", nome));

  const registro = { serie: "SN-FICTICIA" };
  const retornos = comJanela({ SimpressReact: { "ferramentas-cockpit": {} } }, () => ACOES.map(nome => acoes[nome](registro, 7, "texto")));
  retornos.forEach(retorno => assert.ok(!(retorno instanceof Promise), "devolve o valor na hora, sem Promise"));
  assert.deepEqual(retornos, ACOES.map(nome => `sync:${nome}`));
  assert.deepEqual(pontes.chamadas, ACOES.map(nome => ({ painel: "ferramentas-cockpit", nome, argumentos: [registro, 7, "texto"] })));
  assert.equal(pontes.chamadas[0].argumentos[0], registro, "repassa o mesmo objeto");
});

test("ponte lê o painel a cada chamada e devolve o retorno real, inclusive undefined", () => {
  const erros = [];
  const janela = {};
  const chamadas = [];
  comJanela(janela, () => {
    const acoes = criarPonteCockpit({ ponteReactSincrona: ponteDoApp(erros) });
    acoes.fecharJanelaChamadoOs();
    assert.equal(erros.length, 1);
    janela.SimpressReact = { "ferramentas-cockpit": {
      fecharJanelaChamadoOs: (...argumentos) => { chamadas.push(argumentos); },
      filterTicketRecords: () => ["a"],
    } };
    assert.equal(acoes.fecharJanelaChamadoOs(true), undefined);
    assert.deepEqual(acoes.filterTicketRecords([], "x"), ["a"]);
  });
  assert.deepEqual(chamadas, [[true]]);
  assert.equal(erros.length, 1);
});

test("sem o painel, cada ação registra o erro, não lança e devolve o valor de reserva", async () => {
  const erros = [];
  const acoes = comJanela({ SimpressReact: {} }, () => criarPonteCockpit({ ponteReactSincrona: ponteDoApp(erros) }));
  const resultados = await comJanela({ SimpressReact: {} }, async () => {
    globalThis.document = createFakeDocument();
    return Promise.all(ACOES.map(nome => acoes[nome]("inexistente")));
  });
  assert.equal(erros.length, ACOES.length);
  erros.forEach(erro => assert.equal(erro.message, MENSAGEM));
  ACOES.forEach((nome, indice) => {
    const esperado = nome === "filterTicketRecords" ? [] : undefined;
    assert.deepEqual(resultados[indice], esperado, nome);
  });
  // abrirPainelCockpit e filterTicketRecords nunca devolvem undefined: o chamador faz await e itera.
  comJanela({ SimpressReact: {} }, () => {
    globalThis.document = createFakeDocument();
    assert.ok(acoes.abrirPainelCockpit("chamados") instanceof Promise);
    assert.deepEqual(acoes.filterTicketRecords([{ serie: "SN-1" }], "SN"), []);
  });
});

// A casca que openPanel (estado.ts) monta: título, atalho, subtítulo, foco, menu fechado, botão da barra e skip-link.
function conferirCasca(casca, ferramenta) {
  const [titulo, subtitulo] = toolInfoTs[ferramenta];
  const tecla = toolKeysTs[ferramenta] || "";
  assert.equal(casca.raiz.hidden, false, `${ferramenta}: o painel abre`);
  assert.equal(casca.principal.hidden, true, `${ferramenta}: a tela principal sai`);
  Object.entries(casca.secoes).forEach(([nome, secao]) => assert.equal(secao.hidden, nome !== ferramenta, `${ferramenta}: só a seção dela aparece (${nome})`));
  assert.equal(casca.titulo.textContent, titulo, `${ferramenta}: título`);
  assert.equal(casca.subtitulo.textContent, subtitulo, `${ferramenta}: subtítulo`);
  assert.equal(casca.tecla.textContent, tecla, `${ferramenta}: atalho`);
  assert.equal(casca.tecla.hidden, !tecla, `${ferramenta}: atalho escondido quando não há`);
  assert.equal(casca.doc.activeElement, casca.titulo, `${ferramenta}: o foco vai para o título`);
  assert.equal(casca.menu.open, false, `${ferramenta}: o menu Ferramentas fecha`);
  assert.equal(casca.menu.dataset.activeTool, ferramenta, `${ferramenta}: data-active-tool`);
  assert.equal(casca.skipLink.getAttribute("href"), "#cockpit-tool-title", `${ferramenta}: o skip-link aponta para o título`);
  assert.equal(casca.botao.getAttribute("aria-pressed"), String(ferramenta === "chamados"), `${ferramenta}: aria-pressed do botão da barra`);
}

// `app` é o objeto do app antigo (context.app): o cartão do Resumo publica carregarResumoAtivos nele.
async function abrirSemBundle(casca, ferramenta, erros = [], app = {}) {
  const acoes = comJanela({ SimpressReact: {} }, () => criarPonteCockpit({ app, ponteReactSincrona: ponteDoApp(erros) }));
  await comJanela({ SimpressReact: {} }, () => {
    globalThis.document = casca.doc;
    return acoes.abrirPainelCockpit(ferramenta);
  });
  return acoes;
}

test("sem o painel, abrir uma ferramenta mostra a casca e o erro no lugar do resultado, com a mesma marcação de renderError", async () => {
  for (const [ferramenta, [alvoId, mensagem]] of Object.entries(ERROS)) {
    const casca = montarCasca();
    const erros = [];
    const resumo = [];
    await abrirSemBundle(casca, ferramenta, erros, { carregarResumoAtivos: () => { resumo.push(ferramenta); } });
    conferirCasca(casca, ferramenta);
    // O cartão do Resumo tem ponte própria e é ela que registra a falha dele (react-piloto.spec.cjs confere no console).
    assert.deepEqual(resumo, ferramenta === "comparacao" ? ["comparacao"] : [], `${ferramenta}: só o Resumo aciona o cartão de ativos`);
    const alvo = casca.doc.getElementById(alvoId);
    assert.equal(alvo.children.length, 1, ferramenta);
    const nota = alvo.children[0];
    assert.equal(nota.tagName, "P");
    assert.equal(nota.className, "ck-nota ck-nota--erro");
    assert.equal(nota.textContent, mensagem);
    assert.ok(estadoTs.includes(`"${mensagem}"`), `o texto "${mensagem}" já existe em estado.ts`);
    // O cartão do Resumo espera data-estado (comparison-result.js grava o mesmo valor).
    assert.equal(alvo.dataset.estado, ferramenta === "comparacao" ? "erro" : undefined, ferramenta);
    if (ferramenta === "planilhas") assert.equal(casca.status.textContent, "", "o 'Carregando…' da faixa de status sai");
    if (ferramenta === "comparacao") assert.equal(casca.statusComparacao.textContent, "", "o 'Carregando histórico…' do Resumo sai");
    assert.equal(erros.length, 1, `${ferramenta}: o erro também vai para o console`);
    assert.equal(erros[0].message, MENSAGEM);
  }
});

test("sem o painel, ferramenta sem texto de erro próprio abre a casca vazia e registra no console; ferramenta desconhecida não abre nada", async () => {
  assert.deepEqual([...Object.keys(ERROS), ...SEM_TEXTO].sort(), Object.keys(toolInfoTs).sort(), "as 9 ferramentas de toolInfo");
  for (const ferramenta of SEM_TEXTO) {
    const casca = montarCasca();
    const erros = [];
    await abrirSemBundle(casca, ferramenta, erros);
    conferirCasca(casca, ferramenta);
    assert.equal(casca.raiz.querySelectorAll(".ck-nota--erro").length, 0, `${ferramenta}: sem texto de erro inventado`);
    assert.equal(erros.length, 1, ferramenta);
  }
  const casca = montarCasca();
  const erros = [];
  await abrirSemBundle(casca, "inexistente", erros);
  assert.equal(casca.raiz.hidden, true);
  assert.equal(casca.principal.hidden, false);
  assert.equal(casca.menu.open, true, "o menu fica como estava");
  assert.equal(erros.length, 1);
});

test("fecharPainelCockpit sem o painel desfaz a casca e devolve o foco ao botão que abriu; com false não mexe no foco", async () => {
  for (const restaurar of [true, false]) {
    const casca = montarCasca();
    casca.botao.focus();
    const acoes = await abrirSemBundle(casca, "chamados");
    conferirCasca(casca, "chamados");
    comJanela({ SimpressReact: {} }, () => {
      globalThis.document = casca.doc;
      acoes.fecharPainelCockpit(...(restaurar ? [] : [false]));
    });
    assert.equal(casca.raiz.hidden, true);
    assert.equal(casca.principal.hidden, false);
    assert.equal(casca.menu.open, false);
    assert.equal(casca.menu.dataset.activeTool, undefined, "data-active-tool sai");
    assert.equal(casca.skipLink.getAttribute("href"), "#main-content", "o skip-link volta ao href de antes");
    assert.equal(casca.botao.getAttribute("aria-pressed"), "false");
    assert.equal(casca.doc.activeElement === casca.botao, restaurar, restaurar ? "o foco volta ao botão" : "com false o foco fica onde estava");
  }
});

test("sem o painel, o Esc fecha a ferramenta aberta pela casca (mesma regra de estado.ts); com o painel a ponte não escuta nada", async () => {
  const casca = montarCasca();
  const ouvintes = [];
  casca.doc.addEventListener = (tipo, fn) => ouvintes.push([tipo, fn]);
  const acoes = await abrirSemBundle(casca, "chamados");
  await comJanela({ SimpressReact: {} }, () => { globalThis.document = casca.doc; return acoes.abrirPainelCockpit("planilhas"); });
  assert.equal(ouvintes.length, 1, "um keydown só, mesmo com duas aberturas");
  const esc = (extra = {}) => {
    const evento = { key: "Escape", defaultPrevented: false, preventDefault() { evento.defaultPrevented = true; }, ...extra };
    comJanela({ SimpressReact: {} }, () => { globalThis.document = casca.doc; ouvintes.forEach(([, fn]) => fn(evento)); });
    return evento;
  };
  esc({ key: "Enter" });
  esc({ defaultPrevented: true });
  assert.equal(casca.raiz.hidden, false, "outra tecla e Esc já tratado não fecham");
  const modal = casca.doc.createElement("div");
  modal.setAttribute("data-accessible-modal", "true");
  casca.doc.body.append(modal);
  esc();
  assert.equal(casca.raiz.hidden, false, "com modal acessível aberto o Esc é do modal");
  modal.className = "hidden";
  assert.equal(esc().defaultPrevented, true);
  assert.equal(casca.raiz.hidden, true);
  assert.equal(casca.principal.hidden, false);
  assert.equal(esc().defaultPrevented, false, "fechado, o Esc passa adiante");

  const comPainel = montarCasca();
  const ouvintesComPainel = [];
  comPainel.doc.addEventListener = (tipo, fn) => ouvintesComPainel.push([tipo, fn]);
  comJanela({ SimpressReact: { "ferramentas-cockpit": { abrirPainelCockpit: () => Promise.resolve() } } }, () => {
    globalThis.document = comPainel.doc;
    criarPonteCockpit({ ponteReactSincrona: ponteDoApp([]) }).abrirPainelCockpit("chamados");
  });
  assert.equal(ouvintesComPainel.length, 0, "o Esc do painel React é o de estado.ts");
});

test("fecharPainelCockpit sem o painel esconde o painel e devolve a tela principal; com o painel não confunde undefined com painel ausente", () => {
  const semPainel = montarCasca();
  semPainel.raiz.hidden = false;
  semPainel.principal.hidden = true;
  const erros = [];
  comJanela({ SimpressReact: {} }, () => {
    globalThis.document = semPainel.doc;
    criarPonteCockpit({ ponteReactSincrona: ponteDoApp(erros) }).fecharPainelCockpit();
  });
  assert.equal(semPainel.raiz.hidden, true);
  assert.equal(semPainel.principal.hidden, false);
  assert.equal(erros.length, 1);

  const comPainel = montarCasca();
  comPainel.raiz.hidden = false;
  comPainel.principal.hidden = true;
  const chamadas = [];
  const retorno = comJanela({ SimpressReact: { "ferramentas-cockpit": { fecharPainelCockpit: (...argumentos) => { chamadas.push(argumentos); } } } }, () => {
    globalThis.document = comPainel.doc;
    return criarPonteCockpit({ ponteReactSincrona: ponteDoApp([]) }).fecharPainelCockpit(false);
  });
  assert.equal(retorno, undefined);
  assert.deepEqual(chamadas, [[false]]);
  assert.equal(comPainel.raiz.hidden, false, "o painel React decide: a ponte não esconde nada");
  assert.equal(comPainel.principal.hidden, true);
});

test("os textos de erro da ponte são os mesmos de estado.ts e a ponte não sobrescreve o retorno do painel quando ele existe", () => {
  Object.values(ERROS).forEach(([, mensagem]) => assert.ok(estadoTs.includes(mensagem), mensagem));
  const painel = { abrirPainelCockpit: () => "painel", filterTicketRecords: () => ["x"] };
  const acoes = criarPonteCockpit({ ponteReactSincrona: ponteDoApp([]) });
  comJanela({ SimpressReact: { "ferramentas-cockpit": painel } }, () => {
    assert.equal(acoes.abrirPainelCockpit("chamados"), "painel");
    assert.deepEqual(acoes.filterTicketRecords([], ""), ["x"]);
  });
});

// O PUT do autosave da anotação passa pelo apiFetch; o autosave continua recebendo algo com ok/status/json (409 não repete) e a falha de rede passa intacta.
async function capturarEnvioAnotacao(apiFetch) {
  const doc = createFakeDocument();
  const antigoDocumento = global.document;
  doc.getElementById = id => {
    let no = doc.root.querySelectorAll(`[id="${id}"]`)[0];
    if (!no) { no = doc.createElement("div"); no.setAttribute("id", id); doc.body.append(no); }
    return no;
  };
  doc.activeElement = null;
  global.document = doc;
  let send;
  global.HistoryAnnotationAutosave = { attachAnnotationAutosave: opcoes => { send = opcoes.send; } };
  const dataPanels = { montarTabelaOs: (_host, opts) => { global.__opcoes = opts; return {}; }, filtrarTabelaOs() {}, atualizarTabelaOs: async () => {} };
  try {
    const api = criarFerramentasCockpit({ app: { showToast() {} }, appState: {}, apiFetch, historyFormat: {}, dataPanels });
    await api.abrirPainelCockpit("chamados");
    global.__opcoes.aoCarregar({ snapshot_id: "s1", resumo: { series_total: 1 }, chamados: [{ serie: "SN-1", oracle: [], simpress: {} }] });
    const celula = doc.createElement("td");
    doc.body.append(celula);
    global.__opcoes.aoExpandirSerie("SN-1", celula);
    await new Promise(resolve => setImmediate(resolve));
    return send;
  } finally {
    global.document = antigoDocumento;
    delete global.HistoryAnnotationAutosave; delete global.__opcoes;
  }
}

test("envio da anotação usa apiFetch com o mesmo PUT e devolve ok/status/json para o autosave", async () => {
  const chamadas = [];
  const resposta = { ok: true, status: 200, json: async () => ({ sucesso: true }) };
  const evento = { snapshot_id: "import-1", item_id: "ticket-row-1", atualizado_em: "2026-10-10T10:00:00", tipo: "Dados alterados", mudancas: [], anotacao: "" };
  const apiFetch = async (url, opcoes) => {
    chamadas.push([url, opcoes]);
    if (url.includes("/linha-do-tempo/SN-1?")) return { eventos: [evento] };
    if (opcoes?.method === "PUT") {
      if (chamadas.filter(([, o]) => o?.method === "PUT").length === 2) throw Object.assign(new Error("conflito"), { status: 409, data: { conflito: true } });
      if (chamadas.filter(([, o]) => o?.method === "PUT").length === 3) throw new TypeError("Failed to fetch");
      return resposta;
    }
    return {};
  };
  const send = await capturarEnvioAnotacao(apiFetch);
  assert.equal(typeof send, "function");
  const pedido = { eventId: "a/b", itemId: "c d", annotation: "texto", revisionId: "r1", baseRevisions: ["r0"], resolveConflict: false };
  assert.equal(await send(pedido), resposta, "sucesso devolve a Response do apiFetch");
  const [url, opcoes] = chamadas.filter(([, o]) => o?.method === "PUT")[0];
  assert.equal(url, "/api/operacoes/chamados/linha-do-tempo/a%2Fb/c%20d");
  assert.equal(opcoes.responseType, "response");
  assert.deepEqual(opcoes.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(opcoes.body), { anotacao: "texto", revisao_id: "r1", base_revisoes: ["r0"], resolver_conflito: false });
  const conflito = await send(pedido);
  assert.equal(conflito.ok, false);
  assert.equal(conflito.status, 409);
  assert.deepEqual(await conflito.json(), { conflito: true });
  await assert.rejects(() => send(pedido), error => error instanceof TypeError && error.status === undefined, "falha de rede passa intacta");
});
