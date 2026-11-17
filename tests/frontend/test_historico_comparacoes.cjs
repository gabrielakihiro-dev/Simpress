// Histórico de Planilhas (modal): regras puras do painel React (frontend/src/paineis/historico-comparacoes/historico-puro.ts)
// e a ponte do código antigo. O comportamento no navegador (lista, exportar, restaurar, excluir, foco) é testado em
// tests/e2e/react-g9.spec.cjs. Dados sintéticos; nenhum dado real.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
// O Node carrega .ts direto (só sintaxe apagável), por isso historico-puro.ts não importa nada.
const puro = require(path.join(root, "frontend/src/paineis/historico-comparacoes/historico-puro.ts"));
const f = require(path.join(root, "frontend/src/comum/history-format.ts"));
const createComparisonHistory = require(path.join(root, "frontend/src/legado/features/comparison-history.js"));

const HOJE = new Date(2026, 9, 15, 10, 0, 0); // 15/10/2026, hora local

test("rotuloTotal: singular só para 1, plural para o resto", () => {
  assert.equal(puro.rotuloTotal(1), "1 registro");
  assert.equal(puro.rotuloTotal(0), "0 registros");
  assert.equal(puro.rotuloTotal(undefined), "0 registros");
  assert.equal(puro.rotuloTotal(12), "12 registros");
});

test("rotuloDiaHistorico: Hoje, Ontem, data completa e sem data", () => {
  assert.equal(puro.rotuloDiaHistorico("2026-10-15", HOJE), "Hoje");
  assert.equal(puro.rotuloDiaHistorico("2026-10-14", HOJE), "Ontem");
  assert.equal(puro.rotuloDiaHistorico("2026-10-09", HOJE), "09/10/2026");
  assert.equal(puro.rotuloDiaHistorico("", HOJE), "Sem data");
  // virada de mês: ontem de 01/11 é 31/10
  assert.equal(puro.rotuloDiaHistorico("2026-10-31", new Date(2026, 10, 1)), "Ontem");
});

test("chaveDiaHistorico: só aceita data ISO no começo do horário", () => {
  assert.equal(puro.chaveDiaHistorico("2026-10-09T14:30:00-03:00"), "2026-10-09");
  assert.equal(puro.chaveDiaHistorico("09/10/2026 14:30"), "");
  assert.equal(puro.chaveDiaHistorico(null), "");
});

test("agruparPorDia: um grupo por dia, na ordem da lista, com contagem no singular e no plural", () => {
  const eventos = [
    { id: "a", horario: "2026-10-15T09:00:00-03:00" },
    { id: "b", horario: "2026-10-15T08:00:00-03:00" },
    { id: "c", horario: "2026-10-14T18:00:00-03:00" },
    { id: "d", horario: "horario-ruim" },
  ];
  const grupos = puro.agruparPorDia(eventos, HOJE);
  assert.deepEqual(grupos.map(g => [g.chave, g.rotulo, g.quantidade, g.eventos.map(e => e.id)]), [
    ["2026-10-15", "Hoje", "· 2 registros", ["a", "b"]],
    ["2026-10-14", "Ontem", "· 1 registro", ["c"]],
    ["", "Sem data", "· 1 registro", ["d"]],
  ]);
  assert.deepEqual(puro.agruparPorDia([], HOJE), []);
});

test("datasExportacao: ignora anotações sincronizadas, datas inválidas e repetidas", () => {
  const eventos = [
    { id: "a", horario: "2026-10-15T09:00:00-03:00" },
    { id: "b", horario: "2026-10-15T08:00:00-03:00" },
    { id: "c", horario: "2026-10-14T18:00:00-03:00", somente_anotacoes_sincronizadas: true },
    { id: "d", horario: "2026-10-13T12:00:00-03:00" },
    { id: "e", horario: "sem-data" },
    null,
  ];
  assert.deepEqual(puro.datasExportacao(eventos), ["2026-10-15", "2026-10-13"]);
  assert.deepEqual(puro.datasExportacao(undefined), []);
  assert.equal(puro.rotuloDataExportacao("2026-10-13"), "13/10/2026");
  assert.equal(puro.dataValida("2026-10-13"), true);
  assert.equal(puro.dataValida("13/10/2026"), false);
});

test("metricasDoEvento: atualização traz 7 contadores, restauração traz 2; só os diferentes de zero aparecem", () => {
  const atualizacao = {
    id: "a",
    resumo: { apelidos_atualizados: 3, sem_acesso_7_dias: 0, divergencias_local: "2", ambiguidades: 9 },
  };
  const metricas = puro.metricasDoEvento(atualizacao);
  assert.equal(metricas.length, 7);
  assert.deepEqual(puro.metricasVisiveis(metricas).map(m => m.rotulo), ["Apelidos atualizados", "Divergências de local"]);

  const restauracao = puro.metricasDoEvento({
    id: "r", tipo: "restauracao", resumo: { total_endpoint_restaurado: 10, total_detalhes_restaurado: 0 },
  });
  assert.deepEqual(restauracao.map(m => m.rotulo), ["Restaurados – Endpoint", "Restaurados – Simpress"]);
  assert.deepEqual(puro.metricasVisiveis(restauracao).map(m => m.valor), [10]);
  assert.deepEqual(puro.metricasVisiveis(puro.metricasDoEvento({ id: "vazio" })), []);
});

test("seloDoEvento e arquivosDoEvento: seguem o tipo do evento", () => {
  assert.equal(puro.seloDoEvento({ id: "a" }).tipo, "Atualização");
  assert.equal(puro.seloDoEvento({ id: "a", tipo: "restauracao" }).tipo, "Restauração");
  assert.equal(puro.seloDoEvento({ id: "a", somente_anotacoes_sincronizadas: true }).tipo, "Anotações sincronizadas");

  const enviados = { endpoint: "Endpoint.xlsx" };
  const restaurados = { endpoint: "Backup.xlsx" };
  assert.deepEqual(
    puro.arquivosDoEvento({ id: "a", arquivos_enviados: enviados, arquivos_restaurados: restaurados }),
    { rotulo: "Arquivos enviados", arquivos: enviados },
  );
  assert.deepEqual(
    puro.arquivosDoEvento({ id: "a", tipo: "restauracao", arquivos_enviados: enviados, arquivos_restaurados: restaurados }),
    { rotulo: "Inventários restaurados", arquivos: restaurados },
  );
  assert.deepEqual(puro.arquivosDoEvento({ id: "a" }).arquivos, {});
});

test("rotuloAcaoRestaurar: restaurar versão anterior ou desfazer restauração, com o horário formatado", () => {
  const horario = "2026-10-09T14:30:00-03:00";
  const formatado = f.formatarHorarioHistorico(horario);
  assert.equal(
    puro.rotuloAcaoRestaurar({ id: "a", horario }, f),
    `Restaurar versões anteriores à atualização de ${formatado}`,
  );
  assert.equal(
    puro.rotuloAcaoRestaurar({ id: "a", horario, tipo: "restauracao" }, f),
    `Desfazer restauração de ${formatado}`,
  );
});

test("mensagemConfirmacaoRestauracao: descreve backup, conjunto ativo e a substituição conjunta", () => {
  const previa = {
    preview_token: "token-sintetico",
    evento_horario: "2026-10-09T14:30:00-03:00",
    arquivos_backup: {
      endpoint: { nome: "Endpoint_antigo.xlsx", registros: 1200 },
      detalhes: { nome: "EquipamentosDetalhes_antigo.xlsx", registros: 3 },
    },
    arquivos_atuais: {
      endpoint: { nome: "Endpoint_atual.xlsx", presente: true },
      detalhes: { presente: false },
    },
  };
  const texto = puro.mensagemConfirmacaoRestauracao(previa, { id: "a", horario: "2026-01-01T00:00:00-03:00" }, f);
  const linhas = texto.split("\n");
  assert.equal(linhas[0], `Reverter a atualização registrada em ${f.formatarHorarioHistorico(previa.evento_horario)}?`);
  assert.ok(texto.includes("no endpoint: Endpoint_antigo.xlsx (1.200 registros)"), texto);
  assert.ok(texto.includes("na Simpress: Simpress_antigo.xlsx (3 registros)"), texto); // formatarNomeFonteHistorico troca o nome da fonte
  assert.ok(texto.includes("no endpoint: Endpoint_atual.xlsx"), texto);
  assert.ok(texto.includes("na Simpress: arquivo ausente"), texto);
  assert.equal(linhas.at(-1), "Os dois inventários serão substituídos juntos e a ação ficará registrada no histórico. Continuar?");

  const desfazer = puro.mensagemConfirmacaoRestauracao({ ...previa, tipo_evento: "restauracao" }, { id: "a" }, f);
  assert.ok(desfazer.startsWith("Desfazer a restauração registrada em "), desfazer);

  // sem horário na prévia, vale o do evento
  const semHorario = puro.mensagemConfirmacaoRestauracao(
    { preview_token: "t", arquivos_backup: {}, arquivos_atuais: {} },
    { id: "a", horario: "2026-10-09T14:30:00-03:00" },
    f,
  );
  assert.ok(semHorario.startsWith(`Reverter a atualização registrada em ${f.formatarHorarioHistorico("2026-10-09T14:30:00-03:00")}?`));
  assert.ok(semHorario.includes("no endpoint: — (0 registros)"), semHorario);
});

test("mensagemRestauracaoConcluida: singular só para 1 equipamento; avisa se não dá para desfazer", () => {
  assert.equal(
    puro.mensagemRestauracaoConcluida({ evento: { total_equipamentos_carregados: 1, desfazer_disponivel: true } }),
    "Inventários restaurados. 1 equipamento carregado. A restauração pode ser desfeita pelo histórico.",
  );
  assert.equal(
    puro.mensagemRestauracaoConcluida({ evento: { total_equipamentos_carregados: 1000, desfazer_disponivel: true } }),
    "Inventários restaurados. 1.000 equipamentos carregados. A restauração pode ser desfeita pelo histórico.",
  );
  assert.equal(
    puro.mensagemRestauracaoConcluida({ evento: { total_equipamentos_carregados: 2 } }),
    "Inventários restaurados. 2 equipamentos carregados. O backup do conjunto substituído está incompleto ou inválido; não é possível desfazer pelo histórico.",
  );
  assert.ok(puro.mensagemRestauracaoConcluida({}).includes("0 equipamentos carregados"));
});

test("previaInvalidada: só 409 que fala da prévia ou da mudança de estado", () => {
  assert.equal(puro.previaInvalidada(409, "A prévia expirou."), true);
  assert.equal(puro.previaInvalidada(409, "O estado mudou desde a prévia."), true);
  assert.equal(puro.previaInvalidada(409, "Outro conflito."), false);
  assert.equal(puro.previaInvalidada(500, "A prévia expirou."), false);
  assert.equal(puro.previaInvalidada(409, undefined), false);
});

test("ponte: publica as 9 ações de sempre e repassa as 7 do React ao painel historico-comparacoes", async () => {
  const chamadas = [];
  const recebido = [];
  const context = {
    app: {},
    ponteReact(painel, nomes) {
      recebido.push([painel, nomes]);
      return Object.fromEntries(nomes.map(nome => [nome, async (...args) => { chamadas.push([nome, args]); return nome; }]));
    },
  };
  const feature = createComparisonHistory(context);

  assert.equal(recebido.length, 1);
  assert.equal(recebido[0][0], "historico-comparacoes");
  assert.deepEqual(recebido[0][1], [
    "carregarContagemHistoricoComparacoes", "abrirModalHistoricoComparacoes", "fecharModalHistoricoComparacoes",
    "carregarHistoricoComparacoes", "exportarHistoricoComparacoesExcel", "restaurarHistoricoComparacao",
    "consultarHistoricoComparacao",
  ]);
  assert.deepEqual(Object.keys(feature).sort(), [
    "abrirModalHistoricoComparacoes", "abrirResultadoHistoricoComparacao", "baixarHistoricoComparacoesExcel",
    "carregarContagemHistoricoComparacoes", "carregarHistoricoComparacoes", "exportarHistoricoComparacoesExcel",
    "exportarResultadoComparacaoPlanilhas", "fecharModalHistoricoComparacoes", "restaurarHistoricoComparacao",
  ]);
  assert.equal(chamadas.length, 0, "criar o módulo não chama o React");

  await feature.carregarHistoricoComparacoes();
  const evento = { id: "x1" };
  await feature.restaurarHistoricoComparacao(evento);
  await feature.abrirResultadoHistoricoComparacao("x1", "tabela", null);
  assert.deepEqual(chamadas, [
    ["carregarHistoricoComparacoes", []],
    ["restaurarHistoricoComparacao", [evento]],
    ["consultarHistoricoComparacao", ["x1", null, { section: "tabela" }]],
  ]);
});

test("ponte: se o React não carregou, as ações do histórico registram o erro e não rejeitam", async () => {
  const erros = [];
  const original = console.error;
  console.error = erro => erros.push(erro);
  try {
    const feature = createComparisonHistory({
      app: {},
      ponteReact: (painel, nomes) => Object.fromEntries(nomes.map(nome => [nome, () => Promise.reject(new Error(`sem ${painel}`))])),
    });
    assert.equal(await feature.abrirModalHistoricoComparacoes(), undefined);
    assert.equal(await feature.abrirResultadoHistoricoComparacao("x1", "tabela", null), undefined);
  } finally {
    console.error = original;
  }
  assert.deepEqual(erros, ["abrirModalHistoricoComparacoes: sem historico-comparacoes", "abrirResultadoHistoricoComparacao: sem historico-comparacoes"]);
});

test("registro: o painel tem montar.tsx e o modal marca o contêiner React no HTML montado", () => {
  assert.ok(fs.existsSync(path.join(root, "frontend/src/paineis/historico-comparacoes/montar.tsx")));
  const modais = fs.readFileSync(path.join(root, "frontend/partials/modais.html"), "utf8");
  assert.match(modais, /data-react-painel="historico-comparacoes"/);
  assert.match(modais, /id="lista-historico-comparacoes"/);
  assert.match(modais, /id="total-historico-comparacoes"/);
});
