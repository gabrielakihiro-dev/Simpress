// Cartão do sino #alerta-backups-regionais (Resumo F3, Backups): só apresentação de `backups_regionais` do /api/painel.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assembledHtml } = require("./support/assembled-html.cjs");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const { criarIndicadoresHome: createDashboard } = require("../../frontend/src/paineis/indicadores-home/estado.ts");
const { createDomUtils } = require("../../frontend/src/comum/dom-utils.ts");
const transferUtils = require("../../frontend/src/comum/transfer-utils.ts");
const panels = require("../../frontend/src/paineis/paineis-dados/paineis.ts");

const html = assembledHtml();
const APELIDO = "Maria Teste";

const painel = (pendencias, extra = {}) => ({
  gerado_em: "2026-11-12T09:00:00-03:00", minimo: 2, limitacoes: [], pendencias,
  prioritarias: [{ cidade: "Londrina", status: "conferir", backups: [{ serie: "BRAAA11111", apelido: APELIDO }], candidatos: [], conferencia: [], excluidos: [] }],
  ...extra,
});

function montarCartao() {
  const texto = { textContent: "" };
  const card = { hidden: true, dataset: { gravidade: "urgente" }, querySelector: () => texto, addEventListener() {} };
  const selo = { dataset: { status: "erro" }, textContent: "Urgente" };
  const titulo = { textContent: "Sem backup disponível" };
  const lista = { hidden: true, children: [], replaceChildren(...itens) { this.children = itens; } };
  const elementos = {
    "alerta-backups-regionais": card, "alerta-backups-regionais-selo": selo,
    "alerta-backups-regionais-titulo": titulo, "alerta-backups-regionais-lista": lista,
  };
  const ouvintes = {};
  const doc = {
    getElementById: id => elementos[id] || null,
    addEventListener: (tipo, funcao) => { ouvintes[tipo] = funcao; },
    createElement: () => ({ textContent: "" }),
  };
  const anterior = global.document;
  global.document = doc;
  const dashboard = createDashboard({ app: {}, transferUtils, motion: {}, dom: createDomUtils(doc) });
  return { card, texto, selo, titulo, lista, ouvintes, dashboard, restaurar: () => { global.document = anterior; } };
}

test("cartão urgente: há regional sem backup; título, selo, texto e lista só com cidade e situação", () => {
  const cena = montarCartao();
  try {
    cena.dashboard.renderizarAlertaBackupsRegionais(painel({ sem_backup: ["Maringá", "Cascavel"], conferir: ["Londrina"] }));
    assert.equal(cena.card.hidden, false);
    assert.equal(cena.card.dataset.gravidade, "urgente");
    assert.equal(cena.card.dataset.enter, "true");
    assert.equal(cena.titulo.textContent, "Sem backup disponível");
    assert.equal(cena.selo.dataset.status, "erro");
    assert.equal(cena.selo.textContent, "Urgente");
    assert.equal(cena.texto.textContent, "2 regionais estão sem backup disponível. 1 regional tem possível backup para conferir.");
    assert.deepEqual(cena.lista.children.map(li => li.textContent), [
      "Maringá — sem backup disponível", "Cascavel — sem backup disponível", "Londrina — conferir possível backup",
    ]);
    assert.equal(cena.lista.hidden, false);
    const visivel = [cena.texto.textContent, cena.titulo.textContent, ...cena.lista.children.map(li => li.textContent)].join(" ");
    assert.ok(!visivel.includes(APELIDO) && !visivel.includes("BRAAA11111"), "apelido e série ficam só na sub-aba");
  } finally { cena.restaurar(); }
});

test("cartão atenção: só conferir; vira urgente de novo quando aparece sem_backup", () => {
  const cena = montarCartao();
  try {
    cena.dashboard.renderizarAlertaBackupsRegionais(painel({ sem_backup: [], conferir: ["Londrina"] }));
    assert.equal(cena.card.hidden, false);
    assert.equal(cena.card.dataset.gravidade, "atencao");
    assert.equal(cena.titulo.textContent, "Conferir possível backup");
    assert.equal(cena.selo.dataset.status, "alerta");
    assert.equal(cena.selo.textContent, "Atenção");
    assert.equal(cena.texto.textContent, "1 regional tem possível backup para conferir.");
    assert.deepEqual(cena.lista.children.map(li => li.textContent), ["Londrina — conferir possível backup"]);

    cena.dashboard.renderizarAlertaBackupsRegionais(painel({ sem_backup: ["Maringá"], conferir: [] }));
    assert.equal(cena.card.dataset.gravidade, "urgente");
    assert.equal(cena.titulo.textContent, "Sem backup disponível");
    assert.equal(cena.selo.dataset.status, "erro");
    assert.equal(cena.texto.textContent, "1 regional está sem backup disponível.");
  } finally { cena.restaurar(); }
});

test("sem dados, serviço desligado, indisponível ou sem pendências escondem o cartão", () => {
  const cena = montarCartao();
  try {
    const casos = [null, undefined, "x", { indisponivel: true, limitacoes: ["Endpoint fora do ar"] },
      { indisponivel: true, pendencias: { sem_backup: ["Maringá"], conferir: [] } },
      painel({ sem_backup: [], conferir: [] }), painel({}), painel(null), painel({ sem_backup: ["", "  "], conferir: [null] })];
    for (const dados of casos) {
      cena.card.hidden = false;
      cena.dashboard.renderizarAlertaBackupsRegionais(dados);
      assert.equal(cena.card.hidden, true, JSON.stringify(dados));
    }
  } finally { cena.restaurar(); }
});

test("o evento do painel liga o cartão; sem o campo ele some", () => {
  const cena = montarCartao();
  try {
    cena.dashboard.inicializarAlertasOsDivergencias();
    cena.ouvintes["simpress:painel-atualizado"]({ detail: { backups_regionais: painel({ sem_backup: ["Maringá"], conferir: [] }) } });
    assert.equal(cena.card.hidden, false);
    cena.ouvintes["simpress:painel-atualizado"]({ detail: {} });
    assert.equal(cena.card.hidden, true);
  } finally { cena.restaurar(); }
});

test("index: cartão no sino com ids, aria e botão que abre o Resumo na sub-aba Backups", () => {
  const sino = html.match(/<div class="ck-sino__lista">[\s\S]*?<\/section>\s*<\/div>\s*<\/section>/)?.[0] || "";
  const cartao = sino.match(/<section id="alerta-backups-regionais"[\s\S]*?<\/section>/)?.[0];
  assert.ok(cartao, "cartão dentro de .ck-sino__lista");
  assert.match(cartao, /class="ck-aviso"[^>]*role="status"[^>]*aria-labelledby="alerta-backups-regionais-titulo"[^>]*data-state="loading" hidden>/);
  for (const id of ["alerta-backups-regionais-selo", "alerta-backups-regionais-titulo", "alerta-backups-regionais-texto", "alerta-backups-regionais-lista"]) {
    assert.match(cartao, new RegExp(`id="${id}"`), id);
  }
  assert.match(cartao, /<button type="button" id="btn-alerta-backups-regionais" data-on-click="abrirPainelCockpit" data-args='\["comparacao","backups"\]'[^>]*>Ver backups no Resumo<\/button>/);
});

// Desde o Dia 3 (G7) o botão da aba Automação é desenhado pelo React: o HTML montado não o traz mais e o TSX o escreve.
test("Automação: botão escondido por padrão que abre o Resumo na sub-aba Backups", () => {
  const pastaAutomacao = path.join(__dirname, "../../frontend/src/paineis/chrome-automation");
  const tsx = fs.readFileSync(path.join(pastaAutomacao, "componentes.tsx"), "utf8");
  const estado = fs.readFileSync(path.join(pastaAutomacao, "estado.ts"), "utf8");
  assert.doesNotMatch(html, /id="automacao-ver-backups"/);
  const botao = tsx.match(/<button[^>]*id="automacao-ver-backups"[^>]*>[^<]*<\/button>/)?.[0];
  assert.ok(botao);
  assert.match(botao, /data-on-click="abrirPainelCockpit" data-args=\{args\("comparacao", "backups"\)\}/);
  assert.match(botao, / hidden=\{!e\.verBackups\}>Ver backups no Resumo<\/button>$/);
  assert.match(estado, /verBackups: false,/, "nasce escondido");
});

// install() é de módulo único: este processo instala uma vez e muda só a resposta do /api/painel.
const doc = createFakeDocument();
const ouvintes = {};
doc.addEventListener = (tipo, funcao) => { ouvintes[tipo] = funcao; };
const no = (tag, id) => { const item = doc.createElement(tag); item.id = id; doc.body.append(item); return item; };
const botaoSino = no("button", "btn-notificacoes");
const seloSino = no("span", "badge-notificacoes");
seloSino.hidden = true;
const painelSino = no("section", "notification-center-panel");
const resumoSino = no("p", "notification-center-summary");
const tituloSino = no("h2", "notification-center-title");
let resposta = {};
panels.install({
  document: doc,
  MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  console: { warn() {} },
  fetch: async () => ({ ok: true, json: async () => resposta }),
});

async function atualizar(dados) {
  resposta = dados;
  await ouvintes["simpress:atualizar-notificacoes"]();
  for (let tentativa = 0; tentativa < 20; tentativa += 1) await new Promise(resolve => setImmediate(resolve));
}

test("badge do sino: o cartão de backups entra no total e sai quando não há pendência", async () => {
  await atualizar({});
  assert.equal(seloSino.textContent, "0");
  assert.equal(seloSino.hidden, true);

  await atualizar({ backups_regionais: painel({ sem_backup: ["Maringá"], conferir: ["Londrina"] }) });
  assert.equal(seloSino.textContent, "1", "um cartão, mesmo com duas regionais");
  assert.equal(seloSino.hidden, false);
  assert.equal(tituloSino.textContent, "Pendências · 1");
  assert.equal(botaoSino.getAttribute("aria-label"), "Notificações, 1 aviso ativo");
  assert.equal(resumoSino.textContent, "1 aviso ativo.");

  await atualizar({
    backups_regionais: painel({ sem_backup: [], conferir: ["Londrina"] }),
    chamados_outro_tecnico: { total: 2 },
    os_paradas: { estado: "paradas", total: 3 },
  });
  assert.equal(seloSino.textContent, "3", "soma com os outros cartões");
  assert.equal(botaoSino.getAttribute("aria-label"), "Notificações, 3 avisos ativos");

  // Falha ao finalizar no SoftExpert: um cartão a mais; indisponível ou sem itens não conta.
  const falha = { total: 2, itens: [{ numero: "UTIC-2026-1", motivo: "erro" }, { numero: "", motivo: "sharepoint" }] };
  await atualizar({ backups_regionais: painel({ sem_backup: ["Maringá"], conferir: [] }), falhas_finalizacao_softexpert: falha });
  assert.equal(seloSino.textContent, "2", "falha ao finalizar soma um cartão");
  for (const falhas of [{ total: 0, itens: [] }, { ...falha, indisponivel: true }, { total: 1, itens: [] }, null]) {
    await atualizar({ falhas_finalizacao_softexpert: falhas });
    assert.equal(seloSino.textContent, "0", JSON.stringify(falhas));
  }

  for (const backups of [null, { indisponivel: true, pendencias: { sem_backup: ["Maringá"], conferir: [] } }, painel({ sem_backup: [], conferir: [] }), painel(null)]) {
    await atualizar({ backups_regionais: backups });
    assert.equal(seloSino.textContent, "0", JSON.stringify(backups));
    assert.equal(seloSino.hidden, true);
  }
  assert.equal(painelSino.dataset.state, "ready");
});
