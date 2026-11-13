// Resumo (F3), sub-aba Backups: renderização do campo `backups_regionais` e botões Confirmar/Desfazer, com DOM falso.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createBackupsRegionais = require("../../static/js/features/backups-regionais.js");
const createComparisonResultRenderer = require("../../static/js/ui/comparison-result-renderer.js");
const createLoggedUserMarkers = require("../../static/js/ui/logged-user-markers.js");

const root = path.resolve(__dirname, "../..");
const appSource = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "static/app-entry.js"), "utf8");

const dom = createDomUtils({ createElement: () => ({}) });
const comparisonResultRenderer = contexto => createComparisonResultRenderer({ ...contexto,
  app: { atributosVersaoAnotacao: () => "" }, dom, historyFormat, loggedUserMarkers: createLoggedUserMarkers({ dom }),
});

// Pode ser nome de pessoa: aparece na tela local, nunca no toast.
const APELIDO = "Maria Teste";

const painelBase = () => ({
  backups_regionais: {
    gerado_em: "2026-11-12T09:00:00-03:00", minimo: 2, limitacoes: [],
    prioritarias: [
      {
        cidade: "Londrina", status: "conferir", contados: 1, minimo: 2, excedente: 0,
        backups: [
          { serie: "BRAAA11111", apelido: "Backup 1", origem: "marca", ultima_verificacao: "2026-11-10T10:00:00-03:00" },
          { serie: "BRBBB22222", apelido: "Backup 2", origem: "confirmacao", confirmado_ate: "2026-11-18T10:00:00-03:00" },
        ],
        candidatos: [{ serie: "BRCCC33333", apelido: APELIDO, motivo: "sem_verificacao_7_dias", dias_sem_verificacao: 9 }],
        conferencia: [{ serie: "BRDDD44444", motivo: "cidade_divergente" }],
        excluidos: [{ serie: "BREEE55555", motivo: "usuario_vigente" }],
      },
      { cidade: "Maringá", status: "sem_backup", contados: 0, minimo: 2, excedente: 0, backups: [], candidatos: [], conferencia: [], excluidos: [] },
      {
        cidade: "Cascavel", status: "ok", contados: 2, minimo: 2, excedente: 1,
        backups: [{ serie: "BRGGG77777", origem: "marca" }, { serie: "BRHHH88888", origem: "marca" }],
        candidatos: [], conferencia: [], excluidos: [],
      },
    ],
    sobras: [],
    outras_candidatos: [{ cidade: "Curitiba", candidatos: [{ serie: "BRFFF66666", motivo: "ausente_no_endpoint" }] }],
    pendencias: { sem_backup: ["Maringá"], conferir: ["Londrina"] },
  },
});

function montar(t) {
  const ouvintes = new Map();
  const disparados = [];
  const toasts = [];
  const intervalos = [];
  const painel = {
    innerHTML: "", ouvintes: {},
    addEventListener(tipo, funcao) { this.ouvintes[tipo] = funcao; },
    querySelectorAll: () => [], contains: () => false,
  };
  const selo = { textContent: "" };
  const aba = { atributos: {}, setAttribute(nome, valor) { this.atributos[nome] = valor; } };
  const elementos = { "resumo-painel-backups": painel, "resumo-backups-contagem": selo, "resumo-aba-backups": aba };
  globalThis.document = {
    getElementById: id => elementos[id] || null,
    addEventListener: (tipo, funcao) => ouvintes.set(tipo, funcao),
    dispatchEvent: evento => { disparados.push(evento.type); return true; },
    activeElement: null,
  };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  // setInterval falso: o teste não deixa timer real vivo e dispara o ciclo à mão.
  globalThis.window = { setInterval: (funcao, ms) => intervalos.push({ funcao, ms }) };
  t.after(() => { delete globalThis.document; delete globalThis.CustomEvent; delete globalThis.window; });

  const chamadas = [];
  const estado = { apiFetch: async () => ({}) };
  const app = {
    apiFetch: (url, opcoes) => { chamadas.push({ url, opcoes }); return estado.apiFetch(url, opcoes); },
    showToast: (mensagem, tipo) => toasts.push({ mensagem, tipo }),
  };
  const feature = createBackupsRegionais({ app, dom, historyFormat, comparisonResultRenderer });
  const botao = (acao, serie, cidade) => ({
    dataset: { backupAcao: acao, serie, cidade }, disabled: false, atributos: {},
    setAttribute(nome, valor) { this.atributos[nome] = valor; },
    removeAttribute(nome) { delete this.atributos[nome]; },
  });
  return {
    feature, painel, selo, aba, chamadas, toasts, disparados, estado, botao, intervalos,
    enviar: detalhe => ouvintes.get("simpress:painel-atualizado")({ detail: detalhe }),
    indisponivel: () => ouvintes.get("simpress:painel-indisponivel")({}),
    clicar: alvo => painel.ouvintes.click({ target: { closest: () => alvo } }),
  };
}

test("registro: módulo importado no app-entry e publicado no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\/js\/features\/backups-regionais\.js";/);
  assert.match(appSource, /"backupsRegionais",/);
});

test("estados sem tabela: aguardando, serviço desligado e cálculo indisponível", t => {
  const { feature } = montar(t);
  assert.match(feature.renderizarBackupsRegionais(undefined), /Aguardando os dados do painel local/);
  assert.match(feature.renderizarBackupsRegionais(null), /desligado neste servidor/);
  const indisponivel = feature.renderizarBackupsRegionais({ indisponivel: true, limitacoes: ["Endpoint fora do ar"] });
  assert.match(indisponivel, /Não foi possível calcular os backups regionais agora/);
  assert.match(indisponivel, /Endpoint fora do ar/);
  assert.ok(!indisponivel.includes("<table"), "indisponível não desenha tabela");
});

test("tabela: uma linha por regional, situação em texto e botões com os textos aprovados", t => {
  const { feature } = montar(t);
  const html = feature.renderizarBackupsRegionais(painelBase().backups_regionais);
  assert.equal(html.match(/<tr data-status=/g).length, 3);
  for (const texto of ["Conferir possível backup", "Sem backup disponível", "Backup disponível", "1/2", "0/2", "2/2", "+1 além do mínimo"]) {
    assert.ok(html.includes(texto), `texto ausente: ${texto}`);
  }
  assert.ok(html.includes("9 dias sem verificação") && html.includes("Sem verificação nos últimos 7 dias"));
  assert.ok(html.includes("A cidade do apelido difere da cidade do cadastro"));
  assert.ok(html.includes("Candidatos nas demais regionais") && html.includes("Curitiba"));
  assert.match(html, /Mínimo: 2 backups por regional prioritária/);
});

test("botões: Confirmar em todo candidato, Desfazer só em backup confirmado manualmente, com série e cidade", t => {
  const { feature } = montar(t);
  const html = feature.renderizarBackupsRegionais(painelBase().backups_regionais);
  assert.equal(html.match(/data-backup-acao="desfazer"/g).length, 1);
  assert.equal(html.match(/data-backup-acao="confirmar"/g).length, 2, "candidato de Londrina e o de outra regional");
  assert.ok(html.includes('data-backup-acao="desfazer" data-serie="BRBBB22222" data-cidade="Londrina"'));
  assert.ok(html.includes('data-backup-acao="confirmar" data-serie="BRCCC33333" data-cidade="Londrina"'));
  assert.ok(html.includes('data-backup-acao="confirmar" data-serie="BRFFF66666" data-cidade="Curitiba"'));
  assert.ok(html.includes(">Confirmar disponível por 7 dias</button>"));
  assert.ok(html.includes(">Desfazer confirmação</button>"));
  assert.ok(html.includes('aria-label="Confirmar disponível por 7 dias: série BRCCC33333, Londrina"'));
  assert.ok(html.includes('aria-label="Desfazer confirmação: série BRBBB22222, Londrina"'));
  assert.ok(html.includes("Confirmado manualmente") && html.includes("Marca no apelido"));
});

// Texto da seção "Sobras" (até o fim do próprio cartão), para não confundir com os botões da tabela.
const secaoSobras = html => html.split('<h3 class="ck-cartao__titulo">Sobras</h3>')[1]?.split("</section>")[0] ?? "";
const botoesDesfazer = html => html.match(/data-backup-acao="desfazer"/g)?.length ?? 0;

test("sobras fora das prioritárias: item confirmado manualmente leva Desfazer; item com marca no apelido não", t => {
  const { feature } = montar(t);
  const dados = painelBase().backups_regionais;
  dados.sobras = [{
    cidade: "Curitiba", quantidade: 2, prioritaria: false, series: ["BRXXX00001", "BRYYY00002"],
    itens: [
      { serie: "BRXXX00001", origem: "confirmacao", confirmado_ate: "2026-11-18T10:00:00-03:00" },
      { serie: "BRYYY00002", origem: "marca", confirmado_ate: null },
    ],
  }];
  const sobras = secaoSobras(feature.renderizarBackupsRegionais(dados));
  assert.equal(botoesDesfazer(sobras), 1, "só o item confirmado manualmente tem Desfazer");
  assert.ok(sobras.includes('data-backup-acao="desfazer" data-serie="BRXXX00001" data-cidade="Curitiba"'));
  assert.ok(sobras.includes('aria-label="Desfazer confirmação: série BRXXX00001, Curitiba"'));
  assert.ok(!sobras.includes('data-serie="BRYYY00002"'), "item com marca não tem botão");
  assert.ok(sobras.includes('<code class="ck-backups__serie">BRYYY00002</code>'));
  assert.ok(sobras.includes("Confirmado manualmente") && sobras.includes("Marca no apelido") && sobras.includes("confirmado até"));
  assert.ok(!sobras.includes('data-backup-acao="confirmar"'));
  assert.match(sobras, /2 backups em regional fora das prioritárias/);
});

test("sobras prioritárias: só as séries, sem botão; o Desfazer fica só na tabela (um por série)", t => {
  const { feature } = montar(t);
  const dados = painelBase().backups_regionais;
  dados.sobras = [{
    cidade: "Londrina", quantidade: 1, prioritaria: true, series: ["BRBBB22222"],
    itens: [{ serie: "BRBBB22222", origem: "confirmacao", confirmado_ate: "2026-11-18T10:00:00-03:00" }],
  }];
  const html = feature.renderizarBackupsRegionais(dados);
  const sobras = secaoSobras(html);
  assert.ok(sobras.includes('<code class="ck-backups__serie">BRBBB22222</code>'));
  assert.equal(botoesDesfazer(sobras), 0, "sobra prioritária não repete o botão");
  assert.ok(!sobras.includes("Confirmado manualmente"));
  assert.match(sobras, /1 backup além do mínimo/);
  assert.equal(html.match(/data-backup-acao="desfazer" data-serie="BRBBB22222"/g).length, 1, "só o botão da tabela");
});

test("sobras no formato antigo (sem itens): continuam mostrando as séries, sem botão", t => {
  const { feature } = montar(t);
  const dados = painelBase().backups_regionais;
  dados.sobras = [{ cidade: "Curitiba", quantidade: 2, prioritaria: false, series: ["BRXXX00001", "BRYYY00002"] }];
  const sobras = secaoSobras(feature.renderizarBackupsRegionais(dados));
  assert.ok(sobras.includes('<code class="ck-backups__serie">BRXXX00001</code> <code class="ck-backups__serie">BRYYY00002</code>'));
  assert.ok(!sobras.includes("data-backup-acao"), "sem itens não há botão");
  assert.match(sobras, /2 backups em regional fora das prioritárias/);
});

test("motivo desconhecido aparece cru e escapado, nunca some", t => {
  const { feature } = montar(t);
  const dados = painelBase().backups_regionais;
  dados.prioritarias[0].conferencia[0].motivo = "<b>motivo_novo</b>";
  dados.prioritarias[0].candidatos[0].motivo = "motivo_candidato_novo";
  const html = feature.renderizarBackupsRegionais(dados);
  assert.ok(html.includes("&lt;b&gt;motivo_novo&lt;/b&gt;"));
  assert.ok(!html.includes("<b>motivo_novo"));
  assert.ok(html.includes("motivo_candidato_novo"));
});

test("evento do painel: selo e rótulo da aba contam sem_backup + conferir; sem o campo ou indisponível mostra traço", t => {
  const { painel, selo, aba, enviar } = montar(t);
  assert.equal(selo.textContent, "—", "antes do primeiro painel");
  assert.match(painel.innerHTML, /Aguardando os dados do painel local/);

  enviar(painelBase());
  assert.equal(selo.textContent, "2");
  assert.equal(aba.atributos["aria-label"], "Backups: 2 regionais pendentes");
  assert.ok(painel.innerHTML.includes("Londrina") && painel.innerHTML.includes("<table"));

  const umaPendencia = painelBase();
  umaPendencia.backups_regionais.pendencias = { sem_backup: [], conferir: ["Londrina"] };
  enviar(umaPendencia);
  assert.equal(selo.textContent, "1");
  assert.equal(aba.atributos["aria-label"], "Backups: 1 regional pendente");

  const semPendencia = painelBase();
  semPendencia.backups_regionais.pendencias = { sem_backup: [], conferir: [] };
  enviar(semPendencia);
  assert.equal(selo.textContent, "0");

  enviar({ total_equipamentos: 3 });
  assert.equal(selo.textContent, "—");
  assert.equal(aba.atributos["aria-label"], "Backups: dados indisponíveis");
  assert.match(painel.innerHTML, /desligado neste servidor/);

  enviar({ backups_regionais: { indisponivel: true, limitacoes: ["Sem cadastro"] } });
  assert.equal(selo.textContent, "—");
  assert.match(painel.innerHTML, /Não foi possível calcular/);
});

test("confirmar: POST com série e cidade, toast sem apelido e pedido de atualização", async t => {
  const { enviar, clicar, botao, chamadas, toasts, disparados } = montar(t);
  enviar(painelBase());
  const alvo = botao("confirmar", "BRCCC33333", "Londrina");
  await clicar(alvo);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, "/api/backups-regionais/confirmar");
  assert.equal(chamadas[0].opcoes.method, "POST");
  assert.equal(chamadas[0].opcoes.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(chamadas[0].opcoes.body), { serie: "BRCCC33333", cidade: "Londrina" });
  assert.deepEqual(toasts, [{ mensagem: "Backup confirmado por 7 dias: série BRCCC33333, Londrina.", tipo: "success" }]);
  assert.deepEqual(disparados, ["simpress:atualizar-notificacoes"]);
  assert.ok(!JSON.stringify(toasts).includes(APELIDO), "o apelido não vai para o toast");
});

test("redesenho: foco vai ao botão da mesma série, à lista de excluídos aberta ou, sem par, à aba", t => {
  const { enviar, painel, aba, botao } = montar(t);
  const focados = [];
  const focavel = extra => ({ ...extra, focus() { focados.push(this); } });
  const desfazer = focavel(botao("desfazer", "BRCCC33333", "Londrina"));
  const resumo = focavel({ parentElement: { dataset: { cidade: "Londrina" } } });
  aba.focus = () => focados.push(aba);
  painel.contains = () => true;
  painel.querySelectorAll = seletor => (seletor === "[data-backup-acao]" ? [desfazer] : String(seletor).includes("summary") ? [resumo] : []);
  let n = 0;
  const novo = () => { const p = painelBase(); p.backups_regionais.gerado_em = `2026-11-12T09:0${++n}:00-03:00`; return p; };

  globalThis.document.activeElement = { dataset: { backupAcao: "confirmar", serie: "BRCCC33333", cidade: "Londrina" }, closest: () => null };
  enviar(novo());
  assert.equal(focados.at(-1), desfazer, "Confirmar virou Desfazer: foco no botão da mesma série e cidade");

  globalThis.document.activeElement = { dataset: {}, closest: () => ({ dataset: { cidade: "Londrina" } }) };
  enviar(novo());
  assert.equal(focados.at(-1), resumo, "foco no resumo 'N excluídos' fica nele");

  globalThis.document.activeElement = { dataset: { backupAcao: "confirmar", serie: "OUTRA", cidade: "Londrina" }, closest: () => null };
  enviar(novo());
  assert.equal(focados.at(-1), aba);
});

test("desfazer: POST e toast; removido:false vira aviso", async t => {
  const ctx = montar(t);
  ctx.enviar(painelBase());
  await ctx.clicar(ctx.botao("desfazer", "BRBBB22222", "Londrina"));
  assert.equal(ctx.chamadas[0].url, "/api/backups-regionais/desfazer");
  assert.deepEqual(JSON.parse(ctx.chamadas[0].opcoes.body), { serie: "BRBBB22222", cidade: "Londrina" });
  assert.deepEqual(ctx.toasts[0], { mensagem: "Confirmação desfeita: série BRBBB22222, Londrina.", tipo: "success" });

  ctx.estado.apiFetch = async () => ({ removido: false });
  await ctx.clicar(ctx.botao("desfazer", "BRBBB22222", "Londrina"));
  assert.deepEqual(ctx.toasts[1], { mensagem: "Não havia confirmação para desfazer: série BRBBB22222, Londrina.", tipo: "warning" });
});

test("erro da API: mostra detail.mensagem, reabilita o botão e não pede atualização", async t => {
  const ctx = montar(t);
  ctx.estado.apiFetch = async () => {
    throw Object.assign(new Error("Falha genérica"), { status: 409, detail: { codigo: "BLOQUEADO", mensagem: "Máquina com usuário vigente." } });
  };
  const alvo = ctx.botao("confirmar", "BRCCC33333", "Londrina");
  await ctx.clicar(alvo);
  assert.deepEqual(ctx.toasts, [{ mensagem: "Máquina com usuário vigente.", tipo: "error" }]);
  assert.equal(alvo.disabled, false);
  assert.equal(alvo.atributos["aria-busy"], undefined);
  assert.deepEqual(ctx.disparados, []);

  // Erro de rede (sem status): o texto cru do navegador não vai ao toast; vale a mensagem da ação.
  ctx.estado.apiFetch = async () => { throw new TypeError("Failed to fetch"); };
  await ctx.clicar(alvo);
  assert.deepEqual(ctx.toasts[1], { mensagem: "Não foi possível confirmar o backup.", tipo: "error" });
  await ctx.clicar(ctx.botao("desfazer", "BRBBB22222", "Londrina"));
  assert.deepEqual(ctx.toasts[2], { mensagem: "Não foi possível desfazer a confirmação.", tipo: "error" });
  assert.deepEqual(ctx.disparados, []);
});

test("erro 422 (série saiu do cálculo): toast com a mensagem e pedido de atualização do painel", async t => {
  const ctx = montar(t);
  ctx.estado.apiFetch = async () => {
    throw Object.assign(new Error("x"), { status: 422, detail: { codigo: "serie_nao_elegivel", mensagem: "Esta série não aparece como candidata a backup nesta cidade." } });
  };
  const alvo = ctx.botao("confirmar", "BRCCC33333", "Londrina");
  await ctx.clicar(alvo);
  assert.deepEqual(ctx.toasts, [{ mensagem: "Esta série não aparece como candidata a backup nesta cidade.", tipo: "error" }]);
  assert.equal(alvo.disabled, false);
  assert.deepEqual(ctx.disparados, ["simpress:atualizar-notificacoes"]);
});

test("Desfazer: backup contado pela marca com confirmação vigente e série na conferência com confirmação vigente", t => {
  const { renderizarBackupsRegionais } = montar(t).feature;
  const dados = painelBase().backups_regionais;
  dados.prioritarias[0].backups[0].confirmado_ate = "2026-11-18T10:00:00-03:00";
  dados.prioritarias[0].conferencia = [
    { serie: "BRDDD44444", motivo: "leitura_ambigua", confirmacao: { estado: "vigente", expira_em: "2026-11-18T10:00:00-03:00" } },
    { serie: "BRIII99999", motivo: "cidade_divergente", confirmacao: { estado: "invalidada", motivo: "expirada" } },
    { serie: "BRJJJ00000", motivo: "cidade_divergente" },
  ];
  const html = renderizarBackupsRegionais(dados);
  assert.ok(html.includes('data-backup-acao="desfazer" data-serie="BRAAA11111" data-cidade="Londrina"'), "marca + confirmação vigente");
  assert.ok(html.includes('data-backup-acao="desfazer" data-serie="BRDDD44444" data-cidade="Londrina"'), "conferência com confirmação vigente");
  assert.ok(!html.includes('data-serie="BRIII99999"'), "confirmação invalidada não leva Desfazer");
  assert.ok(html.includes("Antes: a confirmação anterior expirou"));
  assert.ok(!html.includes('data-serie="BRJJJ00000"'));
});

test("aguardando: rótulo 'aguardando dados' até o painel; falha antes da primeira resposta vira indisponível", t => {
  const ctx = montar(t);
  assert.equal(ctx.aba.atributos["aria-label"], "Backups: aguardando dados");
  ctx.indisponivel();
  assert.equal(ctx.aba.atributos["aria-label"], "Backups: dados indisponíveis");
  assert.equal(ctx.selo.textContent, "—");
  assert.match(ctx.painel.innerHTML, /Não foi possível calcular/);

  ctx.enviar(painelBase());
  assert.equal(ctx.aba.atributos["aria-label"], "Backups: 2 regionais pendentes");
  ctx.indisponivel();
  assert.ok(ctx.painel.innerHTML.includes("<table"), "falha depois de dados bons não apaga a tabela");
});

test("só o gerado_em mudou: troca o texto da linha e não recria o painel", t => {
  const ctx = montar(t);
  const linha = { textContent: "" };
  ctx.painel.querySelector = seletor => (seletor === ".ck-backups__meta" ? linha : null);
  ctx.enviar(painelBase());
  const primeiro = ctx.painel.innerHTML;
  let atribuicoes = 0;
  let valor = primeiro;
  Object.defineProperty(ctx.painel, "innerHTML", { get: () => valor, set: novo => { atribuicoes += 1; valor = novo; } });

  const depois = painelBase();
  depois.backups_regionais.gerado_em = "2026-11-12T09:05:00-03:00";
  ctx.enviar(depois);
  assert.equal(atribuicoes, 0, "innerHTML não é reatribuído");
  assert.match(linha.textContent, /^Atualizado em .+Mínimo: 2 backups por regional prioritária\.$/);

  const mudou = painelBase();
  mudou.backups_regionais.pendencias = { sem_backup: [], conferir: [] };
  mudou.backups_regionais.prioritarias[1].status = "ok";
  ctx.enviar(mudou);
  assert.equal(atribuicoes, 1, "mudança no corpo recria o painel");
});

test("ação sem efeito no corpo (repetido) ainda redesenha: solta o botão e devolve o foco", async t => {
  const ctx = montar(t);
  ctx.painel.querySelector = seletor => (seletor === ".ck-backups__meta" ? { textContent: "" } : null);
  ctx.enviar(painelBase());
  const focados = [];
  const novoBotao = { ...ctx.botao("confirmar", "BRCCC33333", "Londrina"), focus() { focados.push(this); } };
  ctx.painel.contains = () => true;
  ctx.painel.querySelectorAll = seletor => (seletor === "[data-backup-acao]" ? [novoBotao] : []);
  ctx.estado.apiFetch = async () => ({ repetido: true, confirmacao: { serie: "BRCCC33333", cidade: "Londrina", expira_em: "2026-11-18T10:00:00-03:00" } });
  await ctx.clicar(ctx.botao("confirmar", "BRCCC33333", "Londrina"));
  let atribuicoes = 0;
  let valor = ctx.painel.innerHTML;
  Object.defineProperty(ctx.painel, "innerHTML", { get: () => valor, set: novo => { atribuicoes += 1; valor = novo; } });
  globalThis.document.activeElement = null;

  const depois = painelBase();
  depois.backups_regionais.gerado_em = "2026-11-12T09:05:00-03:00";
  ctx.enviar(depois);
  assert.equal(atribuicoes, 1, "com ação pendente de foco o painel é recriado");
  assert.deepEqual(focados, [novoBotao], "foco volta ao botão da mesma série e cidade");
});

test("clique repetido durante o pedido e cliques fora de botão válido são ignorados", async t => {
  const ctx = montar(t);
  let liberar;
  ctx.estado.apiFetch = () => new Promise(resolve => { liberar = resolve; });
  const primeiro = ctx.botao("confirmar", "BRCCC33333", "Londrina");
  const andamento = ctx.clicar(primeiro);
  assert.equal(primeiro.disabled, true);
  assert.equal(primeiro.atributos["aria-busy"], "true");
  await ctx.clicar(ctx.botao("confirmar", "BRFFF66666", "Curitiba"));
  assert.equal(ctx.chamadas.length, 1, "segundo clique ignorado enquanto o primeiro não termina");
  liberar({});
  await andamento;

  await ctx.clicar(null);
  await ctx.clicar(ctx.botao("apagar", "BRCCC33333", "Londrina"));
  await ctx.clicar(ctx.botao("confirmar", "", "Londrina"));
  await ctx.clicar(ctx.botao("confirmar", "BRCCC33333", ""));
  assert.equal(ctx.chamadas.length, 1, "ação desconhecida ou sem série ou cidade não chama a API");
});

test("atualização periódica: um único intervalo de 5 min que só pede o painel com a aba visível", t => {
  const ctx = montar(t);
  assert.equal(ctx.intervalos.length, 1, "um intervalo por inicialização do módulo");
  assert.equal(ctx.intervalos[0].ms, 5 * 60 * 1000);
  ctx.intervalos[0].funcao();
  assert.deepEqual(ctx.disparados, ["simpress:atualizar-notificacoes"]);
  globalThis.document.hidden = true;
  ctx.intervalos[0].funcao();
  assert.deepEqual(ctx.disparados, ["simpress:atualizar-notificacoes"], "aba escondida não pede atualização");
  globalThis.document.hidden = false;
  ctx.intervalos[0].funcao();
  assert.equal(ctx.disparados.length, 2);
});
