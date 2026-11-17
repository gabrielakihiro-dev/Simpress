// BF2: a ponte frontend/src/aplicacao/pontes.ts só encaminha para window.SimpressReact["sebrae-dashboard"]
// (frontend/src/paineis/sebrae-dashboard/). Dados sintéticos; os fluxos da tela (cartões, filtro, finalizar, envio ao
// SharePoint) são testados em test_sebrae_dashboard_ui.cjs com a mesma fábrica criarDashboardSebrae.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const { createAppHarness } = require("./support/inventory-harness.cjs");
const { assembledHtml } = require("./support/assembled-html.cjs");
const sebraeDashboardModel = require("../../frontend/src/comum/sebrae-dashboard-model.ts");
const { criarDashboardSebrae } = require("../../frontend/src/paineis/sebrae-dashboard/estado.ts");
const criarPonte = require("../../frontend/src/aplicacao/registro.ts").fabricas.sebraeDashboard;

const PAINEL = "sebrae-dashboard";
const MENSAGEM = `O painel React "${PAINEL}" não carregou.`;
const SINCRONAS = ["mostrarChamadoSebrae"];
const ASSINCRONAS = [
  "carregarNovosSebrae", "lerAntigosSebrae", "importarDashboardSebrae", "atualizarDashboardSebrae",
  "descartarRascunhoSebrae", "cartaoChamadoSebraeLeitura",
];

function criarPontes() {
  const chamadas = [];
  const ponteReact = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async (...argumentos) => {
    chamadas.push({ tipo: "async", painel, nome, argumentos });
    return `async:${nome}`;
  }]));
  const ponteReactSincrona = (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => {
    chamadas.push({ tipo: "sync", painel, nome, argumentos });
    return `sync:${nome}`;
  }]));
  return { chamadas, ponteReact, ponteReactSincrona };
}

function capturarErros() {
  const original = console.error;
  const erros = [];
  console.error = erro => erros.push(erro);
  return { erros, restaurar: () => { console.error = original; } };
}

test("a ponte publica as 7 ações: 1 síncrona (mostrarChamadoSebrae) e 6 assíncronas, cada uma no painel certo", async () => {
  const pontes = criarPontes();
  const acoes = criarPonte(pontes);
  assert.deepEqual(Object.keys(acoes).sort(), [...SINCRONAS, ...ASSINCRONAS].sort());

  const argumentos = [{ id: "arg-sintetico" }, 3];
  for (const nome of SINCRONAS) {
    const retorno = acoes[nome](...argumentos);
    assert.ok(!(retorno instanceof Promise), `${nome} devolve o valor na hora, sem Promise`);
    assert.equal(retorno, `sync:${nome}`);
  }
  for (const nome of ASSINCRONAS) {
    const retorno = acoes[nome](...argumentos);
    assert.ok(retorno instanceof Promise, `${nome} devolve Promise`);
    assert.equal(await retorno, `async:${nome}`);
  }
  assert.deepEqual(pontes.chamadas, [
    ...SINCRONAS.map(nome => ({ tipo: "sync", painel: PAINEL, nome, argumentos })),
    ...ASSINCRONAS.map(nome => ({ tipo: "async", painel: PAINEL, nome, argumentos })),
  ]);
});

test("criar a ponte não chama o painel e ela publica os mesmos nomes que criarDashboardSebrae devolve", () => {
  const pontes = criarPontes();
  const acoes = criarPonte(pontes);
  assert.deepEqual(pontes.chamadas, []);
  const doc = createFakeDocument();
  const antigo = { document: global.document, window: global.window };
  global.document = doc;
  global.window = { setTimeout: () => 0, clearTimeout() {}, localStorage: null };
  try {
    const painel = criarDashboardSebrae({
      app: { apiFetch: async () => ({}), showToast() {}, confirmarAcao: async () => true },
      dom: { createTextElement: (tag, classe, texto) => { const no = doc.createElement(tag); no.className = classe || ""; no.textContent = texto; return no; } },
      sebraeDashboardModel,
    });
    assert.deepEqual(Object.keys(painel).sort(), Object.keys(acoes).sort());
  } finally {
    global.document = antigo.document;
    global.window = antigo.window;
  }
});

test("rejeição do painel nas ações assíncronas vai só ao console e a ponte resolve undefined", async () => {
  const falha = new Error(MENSAGEM);
  const acoes = criarPonte({
    ponteReact: (_painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async () => { throw falha; }])),
    ponteReactSincrona: (_painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => undefined])),
  });
  const captura = capturarErros();
  try {
    for (const nome of ASSINCRONAS) assert.equal(await acoes[nome](), undefined, nome);
  } finally { captura.restaurar(); }
  assert.deepEqual(captura.erros, ASSINCRONAS.map(nome => `${nome}: ${MENSAGEM}`));
});

test("a ação síncrona não mascara o erro do painel: o que o painel lança sobe ao chamador", () => {
  const falha = new Error("falha sintética do painel");
  const acoes = criarPonte({
    ponteReact: (_painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, async () => undefined])),
    ponteReactSincrona: (_painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => { throw falha; }])),
  });
  SINCRONAS.forEach(nome => assert.throws(() => acoes[nome](), erro => erro === falha, nome));
});

// Pontes reais de frontend/src/aplicacao/app.ts, com um painel falso no lugar do React.
test("no app real as ações da ponte chegam ao painel React e devolvem o retorno dele", async () => {
  const harness = createAppHarness(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const chamadas = [];
  const painel = {};
  for (const nome of [...SINCRONAS, ...ASSINCRONAS]) painel[nome] = (...argumentos) => { chamadas.push([nome, argumentos]); return `painel:${nome}`; };
  harness.context.window.SimpressReact[PAINEL] = painel;
  harness.run("0");
  const ponte = harness.context;
  const dado = { id: "arg-sintetico" };
  for (const nome of SINCRONAS) assert.equal(ponte[nome](dado), `painel:${nome}`, nome);
  for (const nome of ASSINCRONAS) assert.equal(await ponte[nome](dado), `painel:${nome}`, nome);
  assert.deepEqual(chamadas, [...SINCRONAS, ...ASSINCRONAS].map(nome => [nome, [dado]]));
});

test("no app real, sem o painel, a ação síncrona registra o erro, devolve undefined e não lança", () => {
  const harness = createAppHarness(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  delete harness.context.window.SimpressReact[PAINEL];
  // O vm do harness tem console próprio (stub): captura nele, não no console do Node.
  const erros = [];
  harness.context.console.error = erro => erros.push(erro);
  assert.equal(harness.context.mostrarChamadoSebrae("UTIC-2026-0001"), undefined);
  assert.equal(erros.length, 1);
  assert.equal(Object.prototype.toString.call(erros[0]), "[object Error]"); // o Error nasce no vm: instanceof falha entre realms
  assert.equal(erros[0].message, MENSAGEM);
});

test("no app real, sem o painel, as ações assíncronas resolvem undefined, registram o erro e não agem", async () => {
  const harness = createAppHarness(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  delete harness.context.window.SimpressReact[PAINEL];
  const erros = [];
  harness.context.console.error = erro => erros.push(erro);
  for (const nome of ASSINCRONAS) assert.equal(await harness.context[nome](), undefined, nome);
  assert.deepEqual(erros, ASSINCRONAS.map(nome => `${nome}: ${MENSAGEM}`));
});

// index.html: o contêiner do painel fica depois de #sebrae-novos-avisos e nunca dentro de #sebrae-historico-resumo.
test("index.html: contêiner do painel depois de #sebrae-novos-avisos, fora de #sebrae-historico-resumo, sem IDs duplicados", () => {
  const html = assembledHtml();
  const conteineres = [...html.matchAll(/<div data-react-painel="sebrae-dashboard"[^>]*><\/div>/g)];
  assert.equal(conteineres.length, 1, "um contêiner só");
  assert.match(conteineres[0][0], /\bhidden\b/, "nasce escondido: o painel não desenha nada nele");
  const posicao = conteineres[0].index;
  assert.ok(html.indexOf('id="sebrae-novos-avisos"') < posicao, "depois de #sebrae-novos-avisos");
  const historico = html.match(/<div id="sebrae-historico-resumo"[^>]*><\/div>/);
  assert.ok(historico, "#sebrae-historico-resumo segue vazio no HTML: o painel sebrae-historico desenha os filhos");
  assert.match(historico[0], /data-react-painel="sebrae-historico"/);
  assert.ok(historico.index < posicao && historico.index + historico[0].length <= html.indexOf('id="sebrae-novos-avisos"'), "o contêiner não está dentro de #sebrae-historico-resumo");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

// #sebrae-historico-resumo (painel sebrae-historico) e #sebrae-conflitos (painel sebrae-conflitos) são de outros painéis React:
// o painel sebrae-dashboard não pode recriar, mover, esvaziar nem trocar nenhum deles nem os ancestrais.
const CARGA = {
  importado: {
    arquivo: "Dashboard-sintetico.xlsx", importado_em: "2026-10-28T10:00:00-03:00", total: 3, atualizavel: true, saida_pronta: false,
    listas: { A: ["CLIENTE A", "CLIENTE B"], B: ["REDE"] },
    abertos: [
      { numero: "UTIC-2026-0001", titulo: "Teclado sem resposta", chamado: "UTIC-2026-0001", usuario: "Solicitante A", automaticos: {}, automaticos_sugeridos: {},
        valores: { A: "CLIENTE A", B: "", D: "EM ABERTO", J: "INCIDENTE", R: "", S: "" }, leitura_softexpert: null, softexpert: { descricao_finalizacao: "", pdf: null, finalizacao: null } },
    ],
    finalizados: [{ numero: "UTIC-2026-0002", encerrado_em: "27/10/2026 14:05", em: "2026-10-27T14:06:00-03:00", descricao: "Teclado trocado.", pdf: null, ficha: { titulo: "Teclado", solicitante: "Solicitante B", fatos: [["Solicitante", "Solicitante B"]], detalhes: [], manuais: { A: "CLIENTE A" } } }],
  },
  novos: {
    lidos_em: "2026-10-28T10:05:00-03:00", ignorados: 1, pendentes: [], erros: {},
    formulario: [{ numero: "UTIC-2026-0003", cruzamento: { status: "unico", candidatos: 1 }, linha: { C: "UTIC-2026-0003", G: "Computador travando", H: "Travando.", I: "Solicitante C", F: "", K: "", L: "", N: "" } }],
  },
};

async function montarComVizinhos() {
  const doc = createFakeDocument();
  const criar = doc.createElement;
  doc.createElement = tag => {
    const no = criar(tag);
    no.classList = { toggle(nome, forcar) { const outras = no.className.split(/\s+/).filter(c => c && c !== nome); no.className = (forcar ? [...outras, nome] : outras).join(" "); } };
    return no;
  };
  const antigo = { document: global.document, window: global.window };
  global.document = doc;
  global.window = { setTimeout: () => 0, clearTimeout() {}, localStorage: null };
  const novo = (id, tag, pai = doc.body) => { const no = doc.createElement(tag); if (id) no.setAttribute("id", id); pai.append(no); return no; };
  // ancestrais e vizinhos como no index.html: seção da Automação > bloco do Sebrae > resumo do histórico, avisos e conflitos
  const secao = novo("automacao-chamados-painel", "section");
  const bloco = novo("", "div", secao);
  const historico = novo("sebrae-historico-resumo", "div", bloco);
  historico.setAttribute("data-react-painel", "sebrae-historico");
  const lista = novo("", "ul", historico);
  ["Entrada sintética 1", "Entrada sintética 2"].forEach(texto => { novo("", "li", lista).textContent = texto; });
  novo("sebrae-novos-avisos", "div", bloco);
  const conflitos = novo("sebrae-conflitos", "section", bloco);
  conflitos.setAttribute("data-react-painel", "sebrae-conflitos");
  novo("", "p", conflitos).textContent = "Conflito sintético";
  const entrada = novo("sebrae-dashboard-file", "input", bloco);
  entrada.files = [{ name: "Dashboard-sintetico.xlsx" }];
  entrada.value = "Dashboard-sintetico.xlsx";
  const el = {};
  for (const [id, tag] of [["sebrae-novos-lista", "div"], ["sebrae-novos", "section"], ["sebrae-antigos-lista", "div"], ["sebrae-antigos", "section"],
    ["sebrae-finalizados-lista", "ul"], ["sebrae-finalizados", "section"], ["sebrae-sharepoint-aviso", "div"], ["sebrae-atualizar-status", "p"],
    ["sebrae-novos-resumo", "p"], ["sebrae-dashboard-status", "p"], ["btn-sebrae-atualizar", "button"], ["btn-sebrae-importar", "button"],
    ["sebrae-destaques", "section"], ["sebrae-destaques-contagem", "span"], ["sebrae-destaques-resumo", "p"], ["sebrae-destaques-lista", "div"],
    ["sebrae-destaque-anuncio", "p"], ["sebrae-novos-secao", "h3"]]) el[id] = novo(id, tag, bloco);
  el["sebrae-novos"].append(el["sebrae-novos-lista"]);
  el["sebrae-antigos"].append(el["sebrae-antigos-lista"]);
  el["sebrae-finalizados"].append(el["sebrae-finalizados-lista"]);
  el["sebrae-destaques"].append(el["sebrae-destaques-lista"]);
  ["novos", "antigos", "destaques", "finalizados"].forEach(aba => novo(`sebrae-aba-${aba}`, "button"));
  const ganchos = [];
  const urls = [];
  const app = {
    apiFetch: async (url, opcoes = {}) => { urls.push(`${opcoes.method || "GET"} ${url}`); return structuredClone(CARGA); }, showToast() {}, confirmarAcao: async () => true,
    carregarResumoHistoricoSebrae: () => ganchos.push("historico"), carregarConflitosSebrae: () => ganchos.push("conflitos"),
  };
  const dom = { createTextElement: (tag, classe, texto) => { const no = doc.createElement(tag); no.className = classe || ""; no.textContent = texto; return no; } };
  const feature = criarDashboardSebrae({ app, dom, sebraeDashboardModel });
  return {
    doc, el, feature, ganchos, urls, historico, conflitos, secao, bloco, lista, entrada,
    restaurar() { global.document = antigo.document; global.window = antigo.window; },
  };
}

function fotografar(...nos) {
  return nos.map(no => {
    const ancestrais = [];
    for (let pai = no.parentNode; pai; pai = pai.parentNode) ancestrais.push(pai);
    return { no, ancestrais, filhos: [...no.children], atributos: no.getAttribute("data-react-painel"), texto: no.textContent };
  });
}

function conferirIguais(antes, depois, rotulo) {
  assert.equal(depois.no, antes.no, `${rotulo}: mesmo objeto`);
  assert.equal(depois.ancestrais.length, antes.ancestrais.length, `${rotulo}: mesma altura na árvore`);
  antes.ancestrais.forEach((pai, i) => assert.equal(depois.ancestrais[i], pai, `${rotulo}: ancestral ${i} é o mesmo objeto`));
  assert.equal(depois.filhos.length, antes.filhos.length, `${rotulo}: mesmos filhos`);
  antes.filhos.forEach((filho, i) => assert.equal(depois.filhos[i], filho, `${rotulo}: filho ${i} é o mesmo objeto`));
  assert.equal(depois.atributos, antes.atributos, `${rotulo}: data-react-painel intacto`);
  assert.equal(depois.texto, antes.texto, `${rotulo}: conteúdo intacto`);
}

test("criar o painel, consultar os novos e importar o Dashboard não recriam, movem nem esvaziam #sebrae-historico-resumo e #sebrae-conflitos", async () => {
  const montagem = await montarComVizinhos();
  try {
    const antes = fotografar(montagem.historico, montagem.conflitos);
    assert.equal(montagem.doc.getElementById("sebrae-historico-resumo"), montagem.historico);

    await montagem.feature.carregarNovosSebrae();
    assert.deepEqual(montagem.ganchos, ["historico", "conflitos"], "o painel só chama os ganchos dos vizinhos");
    await montagem.feature.importarDashboardSebrae({ preventDefault() {} });
    await montagem.feature.carregarNovosSebrae();
    await montagem.feature.lerAntigosSebrae();
    assert.ok(montagem.urls.includes("GET /api/sebrae/novos") && montagem.urls.includes("POST /api/sebrae/dashboard"), "os fluxos rodaram de verdade");
    assert.ok(montagem.el["sebrae-novos-lista"].children.length > 0, "os cartões novos foram desenhados");

    const depois = fotografar(montagem.historico, montagem.conflitos);
    conferirIguais(antes[0], depois[0], "#sebrae-historico-resumo");
    conferirIguais(antes[1], depois[1], "#sebrae-conflitos");
    assert.equal(montagem.doc.getElementById("sebrae-historico-resumo"), montagem.historico);
    assert.equal(montagem.doc.getElementById("sebrae-conflitos"), montagem.conflitos);
    assert.ok(montagem.secao.contains(montagem.historico) && montagem.bloco.contains(montagem.historico));
    assert.deepEqual(montagem.lista.children.map(no => no.textContent), ["Entrada sintética 1", "Entrada sintética 2"]);
  } finally { montagem.restaurar(); }
});
