// Chamados (aba Chamados, "Importação e versões", e chamados abertos da Home). Desde o G8 o painel vive em
// frontend/src/paineis/cockpit-chamados/ e o comportamento (versões, comparação, importar, excluir antigas, exportar,
// Home com corrida de respostas e consulta parcial) é testado no navegador: tests/e2e/react-g8.spec.cjs. As regras
// puras têm teste próprio: test_cockpit_chamados_puro.cjs. Aqui ficam a triagem (ticket-rules.js), o registro, a ponte
// do código antigo, abrirGestaoChamadosCockpit (DOM puro, síncrona) e o HTML montado.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const { assembledHtml, staticDir } = require("./support/assembled-html.cjs");
const createTicketRules = require("../../static/js/features/ticket-rules.js");
const createCockpitChamados = require("../../static/js/features/cockpit-chamados.js");

const dom = { escapeHtml: value => String(value), pluralize: (count, one, many) => (count === 1 ? one : many), createTextElement: null };

function diasAtras(dias) {
  const data = new Date();
  data.setDate(data.getDate() - dias);
  return data.toISOString();
}

test("grupoTriagemChamado separa ativos em 3+ dias, sem data e atualizados, e ignora encerrados", () => {
  const rules = createTicketRules(dom);
  const aberto = ultima => ({ oracle: [{ status: "Em execução", ultima_atualizacao: ultima }] });
  assert.equal(rules.grupoTriagemChamado(aberto(diasAtras(1))), "em_dia");
  assert.equal(rules.grupoTriagemChamado(aberto(diasAtras(5))), "atrasados");
  assert.equal(rules.grupoTriagemChamado(aberto("")), "sem_data");
  assert.equal(rules.grupoTriagemChamado({ oracle: [{ status: "Concluído", ultima_atualizacao: diasAtras(9) }] }), "");
  assert.equal(rules.grupoTriagemChamado({ oracle: [] }), "", "sem chamado no Oracle não entra na triagem");
  const atrasado = aberto(diasAtras(5));
  assert.equal(rules.correspondeTriagemChamado(atrasado, "ativos"), true);
  assert.equal(rules.correspondeTriagemChamado(atrasado, "atrasados"), true);
  assert.equal(rules.correspondeTriagemChamado(atrasado, "em_dia"), false);
  assert.equal(rules.correspondeTriagemChamado({ oracle: [] }, ""), true);
});

const root = path.resolve(__dirname, "../..");
const painelReact = path.join(root, "frontend/src/paineis/cockpit-chamados");
const lido = arquivo => fs.readFileSync(path.join(staticDir, arquivo), "utf8");

const ACOES_REACT = [
  "sincronizarGestaoChamadosCockpit", "selecionarVersaoChamadosCockpit", "excluirImportacoesAntigasChamadosCockpit",
  "exportarChamadosCockpit", "atualizarChamadosAbertosHome",
];

// Ponte falsa: guarda o que o módulo pediu e devolve, para cada ação, o que o teste mandar.
function ponteFalsa(acao) {
  const chamadas = [];
  const context = {
    app: {},
    ponteReact(painel, nomes) {
      chamadas.push([painel, nomes]);
      return Object.fromEntries(nomes.map(nome => [nome, (...argumentos) => acao(nome, ...argumentos)]));
    },
  };
  return { chamadas, feature: createCockpitChamados(context) };
}

test("registro: módulo importado no app-entry, publicado no FEATURE_ORDER e com o painel React ao lado", () => {
  assert.match(lido("app-entry.js"), /^import "\.\/js\/features\/cockpit-chamados\.js";$/m);
  assert.match(lido("app.js"), /"cockpitChamados",/);
  assert.ok(fs.existsSync(path.join(painelReact, "montar.tsx")));
  assert.ok(fs.existsSync(path.join(painelReact, "cockpit-chamados-puro.ts")));
});

test("ponte: o módulo continua publicando as 7 ações e pede ao React só as 5 que ele passou a ter", () => {
  const { chamadas, feature } = ponteFalsa(async () => {});
  assert.deepEqual(chamadas, [["cockpit-chamados", ACOES_REACT]]);
  assert.deepEqual(Object.keys(feature).sort(), [...ACOES_REACT, "abrirGestaoChamadosCockpit", "abrirChamadoSebraeNoF5"].sort());
});

test("ponte: cada ação repassa os argumentos ao painel React; criar o módulo não chama o React", async () => {
  const recebido = [];
  const { feature } = ponteFalsa(async (nome, ...argumentos) => { recebido.push([nome, ...argumentos]); });
  assert.deepEqual(recebido, []);
  const relatorio = { snapshot_id: "s1" };
  await feature.sincronizarGestaoChamadosCockpit(relatorio);
  await feature.selecionarVersaoChamadosCockpit("s2");
  await feature.excluirImportacoesAntigasChamadosCockpit();
  await feature.exportarChamadosCockpit();
  await feature.atualizarChamadosAbertosHome("5CG6051BVN");
  assert.deepEqual(recebido, [
    ["sincronizarGestaoChamadosCockpit", relatorio],
    ["selecionarVersaoChamadosCockpit", "s2"],
    ["excluirImportacoesAntigasChamadosCockpit"],
    ["exportarChamadosCockpit"],
    ["atualizarChamadosAbertosHome", "5CG6051BVN"],
  ]);
});

test("ponte: selecionarVersaoChamadosCockpit só leva texto; evento do clique ou nada vira undefined (o painel lê o seletor)", async () => {
  const recebido = [];
  const { feature } = ponteFalsa(async (nome, ...argumentos) => { recebido.push(argumentos); });
  await feature.selecionarVersaoChamadosCockpit();
  await feature.selecionarVersaoChamadosCockpit({ type: "change" });
  await feature.selecionarVersaoChamadosCockpit("s1");
  assert.deepEqual(recebido, [[undefined], [undefined], ["s1"]]);
});

test("ponte: se o React não carregou, as 5 ações registram o erro e não rejeitam (quem chama não trata erro)", async () => {
  const erros = [];
  const original = console.error;
  console.error = erro => erros.push(erro.message);
  try {
    const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "cockpit-chamados" não carregou.')));
    for (const nome of ACOES_REACT) assert.equal(await feature[nome](), undefined, nome);
  } finally {
    console.error = original;
  }
  assert.equal(erros.length, ACOES_REACT.length);
  assert.ok(erros.every(mensagem => mensagem === 'O painel React "cockpit-chamados" não carregou.'));
});

test("Importar e gerenciar abre o bloco e leva o foco ao primeiro arquivo (DOM puro, síncrona)", () => {
  const doc = createFakeDocument();
  global.document = doc;
  global.window = { matchMedia: () => ({ matches: true }) };
  try {
    const painel = doc.createElement("details");
    painel.setAttribute("id", "cockpit-tickets-manage-panel");
    const arquivo = doc.createElement("input");
    arquivo.setAttribute("id", "cockpit-tickets-file-simpress");
    doc.body.append(painel, arquivo);
    let rolagem = null;
    let foco = null;
    painel.scrollIntoView = opcoes => { rolagem = opcoes; };
    arquivo.focus = opcoes => { foco = opcoes; };
    const { feature } = ponteFalsa(async () => {});
    assert.equal(feature.abrirGestaoChamadosCockpit(), undefined, "síncrona: não devolve promessa");
    assert.equal(painel.open, true);
    assert.deepEqual(rolagem, { block: "start", behavior: "auto" }, "movimento reduzido: sem rolagem suave");
    assert.deepEqual(foco, { preventScroll: true });
  } finally { delete global.document; delete global.window; }
});

test("index.html: o React é dono do corpo da seção, sem IDs duplicados e com os alvos dos portais uma vez cada", () => {
  const html = assembledHtml();
  const corpo = html.match(/<div class="ckp-recolher__corpo" data-react-painel="cockpit-chamados"><\/div>/);
  assert.ok(corpo, "o corpo da seção fica vazio no HTML: o React desenha tudo dentro dele");
  assert.equal(html.split('data-react-painel="cockpit-chamados"').length - 1, 1);
  // O que o React não desenha dentro do corpo: botões da barra (com data-on-click) e os três alvos dos portais.
  assert.match(html.match(/<button[^>]*id="cockpit-tickets-manage"[^>]*>/)[0], /data-on-click="abrirGestaoChamadosCockpit"/);
  assert.match(html.match(/<button[^>]*id="cockpit-tickets-export"[^>]*>/)[0], /data-on-click="exportarChamadosCockpit"/);
  for (const id of ["cockpit-tickets-manage-version", "home-open-tickets-body", "home-open-tickets-count"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
  assert.match(html.match(/<[^>]*id="home-open-tickets-count"[^>]*>/)[0], /role="status"/, "o React só troca o texto: o papel vem do HTML");
  // Os campos e botões passaram para o React: não podem sobrar no HTML estático.
  for (const id of ["cockpit-tickets-form", "cockpit-tickets-version", "cockpit-tickets-delete-old", "cockpit-tickets-evolution", "cockpit-tickets-import"]) {
    assert.ok(!html.includes(`id="${id}"`), `${id} agora é desenhado pelo painel React`);
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test("painel React: texto vindo das planilhas entra só como texto (sem dangerouslySetInnerHTML nem innerHTML)", () => {
  for (const arquivo of fs.readdirSync(painelReact)) {
    assert.doesNotMatch(fs.readFileSync(path.join(painelReact, arquivo), "utf8"), /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|outerHTML/, arquivo);
  }
});
